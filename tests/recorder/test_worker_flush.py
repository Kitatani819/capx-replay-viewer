"""A parallel worker persists recordings before the collector sees its result."""

from __future__ import annotations

import json
import subprocess
import sys
import threading
import types

import pytest

from capx_trace_recorder import bootstrap, context as C
from capx_trace_recorder.hooks import trial as TRIAL
from inprocess import Recorder
from trace_reader import by_type, read_events
from tracing_testlib import REPO, clean_env


_WORKER_SCRIPT = r"""
import os, signal, sys, threading
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType, SimpleNamespace
from capx_trace_recorder import bootstrap
from capx_trace_recorder.hooks import trial as hooks
from capx_trace_recorder.store import get_store

bootstrap._start_public()
assert bootstrap._H11_OK
root = Path(sys.argv[1])
source = root / 'source'
source.mkdir(parents=True)
code = source / 'code.py'
code.write_text('# trial output')
(source / 'video_combined.mp4').write_bytes(b'video payload')

store = get_store()
copy_allowed = threading.Event()
queue = store._queue
class DrainQueue:
    def put(self, item):
        queue.put(item)
        if item.kind == 'barrier':
            copy_allowed.set()

    def get(self, *args, **kwargs):
        return queue.get(*args, **kwargs)
store._queue = DrainQueue()
copy = hooks._copy_trial_videos
def blocked_copy(ctx, *args):
    # Keep the video in flight until the worker reaches its drain boundary.
    assert copy_allowed.wait(5), 'worker returned without draining its recording'
    copy(ctx, *args)
    # The writer enqueues this *behind* the first flush barrier. It must be
    # persisted too, rather than only the work queued by the trial thread.
    ctx.wep.sink.emit('trace_warning', data={'code': 'copy_finished', 'counts_as_gap': False},
                      writer_generated=True)
hooks._copy_trial_videos = blocked_copy

flush = store.flush
drains = []
def drain(timeout=10.0):
    assert timeout == hooks.WORKER_DRAIN_TIMEOUT_S, 'worker drain is not bounded'
    assert signal.getitimer(signal.ITIMER_REAL)[0] == 0, 'draining inside the trial alarm'
    drains.append(timeout)
    return flush(timeout)
store.flush = drain

@dataclass
class Summary:
    code_path: str
    success: bool = True

answer = Summary(str(code))
calls = []
def trial(env, trial, args, config):
    calls.append(trial)
    return answer
wrapped_trial = hooks.make_run_single_trial_wrapper(trial)
runner = ModuleType('capx.envs.runner')
def worker(state, trial, *, config):
    # CaP-X runner disables the alarm in its timeout wrapper, inside this
    # boundary, before parallel_eval sends the returned result to the collector.
    previous = signal.signal(signal.SIGALRM, lambda *_: None)
    signal.setitimer(signal.ITIMER_REAL, 30)
    try:
        return runner._run_single_trial(state, trial, SimpleNamespace(), config)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)
runner._run_single_trial = trial  # Also exercise rebinding the runner's alias.
runner._run_single_trial_worker = worker
bootstrap.run_patch(runner.__name__, runner)
assert runner._run_single_trial is wrapped_trial
assert runner._run_single_trial_worker(SimpleNamespace(), 1, config={'record_video': True}) is answer
assert calls == [1]
assert drains == [hooks.WORKER_DRAIN_TIMEOUT_S]
# Simulate the collector terminating the process immediately after its result:
# atexit cannot rescue an undrained video or the final event.
os._exit(0)
"""


@pytest.mark.skipif(sys.platform != "linux", reason="trial alarm and video copying require Linux")
def test_worker_persists_video_and_writer_tail_before_returning(tmp_path):
    root = tmp_path / "traces"
    proc = subprocess.run([sys.executable, "-c", _WORKER_SCRIPT, str(root)],
                          cwd=REPO, env=clean_env(CAPX_TRACE_DIR=str(root), CAPX_TRACE_RUN_ID="run"),
                          capture_output=True, text=True, timeout=20)
    assert proc.returncode == 0, proc.stderr
    video, = root.glob("run/*/videos/video_combined.mp4")
    assert video.read_bytes() == b"video payload"
    events, corrupt, torn = read_events(video.parent.parent / "events.jsonl")
    assert corrupt == 0 and not torn
    assert by_type(events, "episode_end")[0]["data"]["end_reason"] == "completed"
    assert by_type(events, "trial_videos")[0]["artifacts"][0]["written"] is True
    assert events[-1]["data"]["code"] == "copy_finished"
    assert json.loads((video.parent.parent / "episode.json").read_text())["trace_complete"] is True
    assert not list(root.rglob("*.tmp.*"))


@pytest.mark.parametrize("error_type", [ValueError, KeyboardInterrupt])
def test_worker_drains_before_propagating_the_same_error(tmp_path, monkeypatch, error_type):
    rec = Recorder(tmp_path / "traces", monkeypatch)
    saved = []
    error = error_type("trial failed")
    calls = []
    save_allowed = threading.Event()
    flush = rec.store.flush

    def drain(timeout=10.0):
        save_allowed.set()
        return flush(timeout)

    monkeypatch.setattr(rec.store, "flush", drain)

    def worker(state, trial):
        calls.append((state, trial))
        ep = rec.open()

        def save(ctx):
            assert save_allowed.wait(5)
            saved.append("persisted")

        ep.internal(save)
        rec.end(ep)
        raise error

    runner = types.ModuleType("capx.envs.runner")
    runner._run_single_trial_worker = worker
    try:
        assert TRIAL.install_runner_aliases(runner) == []
        with pytest.raises(error_type) as caught:
            runner._run_single_trial_worker("state", 7)
        assert caught.value is error
        assert calls == [("state", 7)]
        assert saved == ["persisted"]
    finally:
        save_allowed.set()
        rec.close()


def test_worker_wrapper_requires_traceback_protection(monkeypatch):
    monkeypatch.setattr(bootstrap, "_H11_OK", False)
    monkeypatch.setattr(C.REGISTRY, "hooks_failed", [])
    runner = types.ModuleType("capx.envs.runner")

    def worker():
        return "trial ran"

    runner._run_single_trial_worker = worker
    bootstrap.run_patch(runner.__name__, runner)
    assert runner._run_single_trial_worker is worker
    assert runner._run_single_trial_worker() == "trial ran"
    assert any(failure["hook"] == "worker_flush" and "H11" in failure["reason"]
               for failure in C.REGISTRY.hooks_failed)
