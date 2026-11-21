"""Shared HTML index updates must not affect the evaluated command."""

import json
import sys
import types
import threading
import time

import pytest

from capx_trace_recorder import code_changes
from capx_trace_recorder import eval as wrapper


@pytest.fixture
def index_calls(monkeypatch):
    calls = []

    def build_index(root, **kwargs):
        paths = list(root.glob("*/*/eval.json"))
        assert len(paths) == 1
        calls.append((root, json.loads(paths[0].read_text(encoding="utf-8"))))
        return root / "index.html"

    monkeypatch.delenv("CAPX_EVAL_INDEX", raising=False)
    monkeypatch.setattr(wrapper, "git_revision", lambda *args, **kwargs: {"commit": "a" * 40, "dirty": False})
    monkeypatch.setattr(code_changes, "capture_code_changes", lambda *args, **kwargs: {
        "status": "no_baseline", "baseline_commit": None, "current_commit": "a" * 40,
        "artifact": None, "sha256": None, "size_bytes": None, "files": 0,
        "excluded_files": 0, "untracked_files": 0, "redacted": False,
    })
    monkeypatch.setitem(sys.modules, "capx_trace_recorder.eval_index", types.SimpleNamespace(build_index=build_index))
    return calls


@pytest.mark.parametrize("exit_code", [0, 7])
def test_index_rebuilt_at_start_and_end(tmp_path, index_calls, exit_code):
    trace_root = tmp_path / "shared" / "test-user"
    result = wrapper.run_eval([sys.executable, "-c", f"raise SystemExit({exit_code})"], trace_root=trace_root)

    assert result == exit_code
    assert [root for root, _ in index_calls] == [trace_root.parent, trace_root.parent]
    assert [record["status"] for _, record in index_calls] == ["running", "completed" if exit_code == 0 else "interrupted"]
    assert index_calls[0][1]["ended_at"] is None
    assert index_calls[1][1]["end"]["exit_code"] == exit_code
    assert index_calls[1][1]["summary"]["trials"] == 0


def test_index_rebuilt_after_child_cannot_start(tmp_path, index_calls):
    result = wrapper.run_eval([str(tmp_path / "missing-command")], trace_root=tmp_path / "shared" / "test-user")

    assert result == 127
    assert [record["status"] for _, record in index_calls] == ["running", "interrupted"]
    assert index_calls[-1][1]["end"]["exit_code"] == 127


def test_stalled_index_scan_has_deadline_and_coalesces_rebuilds(tmp_path, monkeypatch):
    from capx_trace_recorder import eval_index

    calls = []
    release = threading.Event()
    finished = threading.Event()

    def stalled(root, **kwargs):
        calls.append(root)
        try:
            release.wait(0.5)
        finally:
            finished.set()

    monkeypatch.delenv("CAPX_EVAL_INDEX", raising=False)
    monkeypatch.setattr(wrapper, "INDEX_REBUILD_TIMEOUT_S", 0.02, raising=False)
    monkeypatch.setattr(eval_index, "build_index", stalled)
    started = time.monotonic()
    try:
        wrapper._rebuild_index(tmp_path / "test-user", enabled=True)
        wrapper._rebuild_index(tmp_path / "test-user", enabled=True)
        assert time.monotonic() - started < 0.2
        assert len(calls) == 1
    finally:
        release.set()
        assert finished.wait(1)
        guard = getattr(wrapper, "_INDEX_REBUILD_LOCK", None)
        if guard is not None:
            assert guard.acquire(timeout=1)
            guard.release()


@pytest.mark.parametrize("exit_code", [0, 9])
@pytest.mark.parametrize("failure", [OSError, RuntimeError])
def test_index_failure_only_warns_and_preserves_exit(tmp_path, index_calls, monkeypatch, capsys, exit_code, failure):
    attempts = []

    def fail(root, **kwargs):
        attempts.append(root)
        raise failure("index unavailable")

    monkeypatch.setattr(sys.modules["capx_trace_recorder.eval_index"], "build_index", fail)
    result = wrapper.run_eval([sys.executable, "-c", f"raise SystemExit({exit_code})"], trace_root=tmp_path / "shared" / "test-user")

    assert result == exit_code
    assert len(attempts) == 2
    assert capsys.readouterr().err.count(f"warning: index rebuild failed ({failure.__name__})") == 2


@pytest.mark.parametrize("disabled_by", ["environment", "option"])
def test_index_can_be_disabled(tmp_path, index_calls, monkeypatch, disabled_by):
    if disabled_by == "environment":
        monkeypatch.setenv("CAPX_EVAL_INDEX", "0")
    result = wrapper.run_eval([sys.executable, "-c", "pass"], trace_root=tmp_path / "shared" / "test-user",
                              index_enabled=disabled_by != "option")

    assert result == 0
    assert index_calls == []


def test_cli_no_index_option(tmp_path, monkeypatch):
    monkeypatch.setenv("CAPX_TRACE_DIR", str(tmp_path / "shared" / "test-user"))
    monkeypatch.delenv("CAPX_TRACE_RUN_ID", raising=False)
    calls = []

    def run(command, **kwargs):
        calls.append((command, kwargs))
        return 7

    monkeypatch.setattr(wrapper, "run_eval", run)
    assert wrapper.main(["--no-index", "--", "test-command"]) == 7
    assert calls[0][0] == ["test-command"]
    assert calls[0][1]["index_enabled"] is False


def test_resumed_segment_rebuilds_index_at_start_and_end(tmp_path, index_calls):
    trace_root = tmp_path / "shared" / "test-user"
    command = [sys.executable, "-c", "pass"]
    assert wrapper.run_eval(command, trace_root=trace_root) == 0
    eval_id = index_calls[-1][1]["eval_id"]
    assert wrapper.run_eval(command, trace_root=trace_root, resume=eval_id) == 0

    assert [record["status"] for _, record in index_calls] == ["running", "completed", "running", "completed"]
    assert [len(record["segments"]) for _, record in index_calls] == [1, 1, 2, 2]
    assert all(record["eval_id"] == eval_id for _, record in index_calls)
