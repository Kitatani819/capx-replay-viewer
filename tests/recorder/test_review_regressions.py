"""Regression probes for the recorder review's hook and provenance findings."""
from __future__ import annotations

import functools
import gzip
import json
import subprocess
import threading
from pathlib import Path

import pytest

from capx_trace_recorder import code_changes
from capx_trace_recorder import eval as evaluation
from capx_trace_recorder import eval_resume
from capx_trace_recorder.hooks import trial
from capx_trace_recorder.hooks.http import _build_response
from capx_trace_recorder.ids import new_event_id
from capx_trace_recorder.payload import mask_secrets, normalize_request
from capx_trace_recorder.segments import SegmentRegistry, compute_input_summary
from inprocess import Recorder


@pytest.mark.parametrize("long_content", [False, True])
def test_http_response_summary_uses_masked_payload(tmp_path, monkeypatch, long_content):
    rec = Recorder(tmp_path / "traces", monkeypatch)
    try:
        ep = rec.open()
        content = [{"token": "synthetic-content-secret", "text": "x" * (5000 if long_content else 8)}]
        body = json.dumps({"choices": [{"message": {"content": content}}],
                           "usage": {"api_key": "synthetic-usage-secret"}}).encode()
        event_id = new_event_id()
        ep.emit("model_response", data={}, event_id=event_id,
                builder=functools.partial(_build_response, content=body, event_id=event_id))
        event = next(event for event in rec.events(ep) if event["event_id"] == event_id)
        if long_content:
            assert event["data"]["content"]["truncated"] is True
            assert list(ep.base_dir.rglob("*.gz"))
        stored = json.dumps(event)
        for path in ep.base_dir.rglob("*.gz"):
            stored += gzip.decompress(path.read_bytes()).decode()
        stored += (ep.base_dir / event["data"]["payload_path"]).read_text()
        assert "synthetic-content-secret" not in stored
        assert "synthetic-usage-secret" not in stored
        assert event["data"]["usage"] == {"api_key": "***masked***"}
    finally:
        rec.close()


@pytest.mark.parametrize("url", [
    "https://user:synthetic-url-secret@example.test:bad/image?x=y#fragment",
    "https://user:synthetic-url-secret@[broken/image?x=y#fragment",
])
def test_malformed_external_image_url_removes_credentials(url):
    body = {"messages": [{"content": [{"type": "image_url", "image_url": {"url": url}}]}]}
    normalized, _media, external = normalize_request(body)
    masked, _paths = mask_secrets(normalized, external)
    assert "synthetic-url-secret" not in json.dumps(masked)
    assert "x=y" not in json.dumps(masked)
    assert "#fragment" not in json.dumps(masked)


def test_segment_history_deduplicates_text_and_preserves_sources():
    registry = SegmentRegistry()
    registry.register("stdout", "the same output", ("ev_first",))
    registry.register("stdout", "the same output", ("ev_second",))
    registry.register("stdout", "the same output", ("ev_first",))
    segments = registry.dynamic()
    assert len(segments) == 1
    assert segments[0].source_event_ids == ("ev_first", "ev_second")


def test_segment_history_budget_reports_incomplete_attribution():
    registry = SegmentRegistry(max_bytes=128)
    registry.register("stdout", "small output", ("ev_kept",))
    for index in range(20):
        registry.register("stdout", str(index) + "界" * 80, (f"ev_{index}",))
    snapshot = registry.snapshot()
    assert sum(len(segment.text.encode()) for segment in snapshot) <= 128
    summary = compute_input_summary(snapshot, [("messages[0].content", "small output")], [], 0)
    assert summary["attribution_truncated"]["omitted_segments"] == 20
    assert summary["attribution_truncated"]["byte_limit"] == 128
    assert summary["categories"]["stdout_stderr"][0]["source_event_ids"] == ["ev_kept"]


def test_segment_history_budget_also_bounds_deduplicated_source_ids():
    registry = SegmentRegistry(max_bytes=160)
    for index in range(100):
        registry.register("stdout", "repeated output", (f"ev_{index}",))
    snapshot = registry.snapshot()
    assert len(snapshot) == 1
    assert 0 < len(snapshot[0].source_event_ids) < 10
    summary = compute_input_summary(snapshot, [("messages[0].content", "repeated output")], [], 0)
    assert summary["attribution_truncated"]["omitted_segments"] > 0


@pytest.mark.parametrize("raise_error", [False, True])
def test_worker_stalled_writer_has_deadline_and_preserves_result(tmp_path, monkeypatch, capsys, raise_error):
    rec = Recorder(tmp_path / "traces", monkeypatch)
    monkeypatch.setattr(trial, "WORKER_DRAIN_TIMEOUT_S", 0.03, raising=False)
    blocked = threading.Event()
    release = threading.Event()
    result = object()
    error = ValueError("synthetic worker failure")
    observed = []

    def worker():
        ep = rec.open()
        ep.internal(lambda _ctx: (blocked.set(), release.wait(3)))
        rec.end(ep)
        if raise_error:
            raise error
        return result

    def call():
        try:
            observed.append(trial.make_trial_worker_wrapper(worker)())
        except BaseException as exc:
            observed.append(exc)

    thread = threading.Thread(target=call, daemon=True)
    try:
        thread.start()
        assert blocked.wait(1)
        thread.join(0.5)
        assert not thread.is_alive(), "completed worker blocked on recorder I/O"
        assert observed == [error if raise_error else result]
        assert "recording incomplete" in capsys.readouterr().err
    finally:
        release.set()
        thread.join(4)
        rec.close()


def _git(repo, *args):
    return subprocess.check_output(["git", "-C", str(repo), *args], stderr=subprocess.DEVNULL)


def _commit(repo):
    _git(repo, "add", ".")
    _git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture", "commit", "-qm", "fixture")


@pytest.mark.parametrize("change", ["checkout", "tracked"])
def test_revision_rejects_changed_submodule_even_when_config_ignores_it(tmp_path, change):
    child = tmp_path / "child"
    child.mkdir()
    _git(child, "init", "-q")
    (child / "implementation.py").write_text("value = 1\n")
    _commit(child)
    original = _git(child, "rev-parse", "HEAD").decode().strip()
    (child / "implementation.py").write_text("value = 2\n")
    _commit(child)
    parent = tmp_path / "parent"
    parent.mkdir()
    _git(parent, "init", "-q")
    _git(parent, "-c", "protocol.file.allow=always", "submodule", "add", "-q", str(child), "module")
    _commit(parent)
    _git(parent, "config", "submodule.module.ignore", "all")
    before = evaluation.git_revision(parent)
    assert before["dirty"] is False
    if change == "checkout":
        _git(parent / "module", "checkout", "-q", original)
    else:
        (parent / "module" / "implementation.py").write_text("value = 3\n")
    after = evaluation.git_revision(parent)
    assert after["dirty"] is True
    assert not eval_resume.same_revision(before, after)


@pytest.mark.parametrize("failed", [False, True])
def test_code_capture_uses_temporary_global_trust_config(tmp_path, monkeypatch, failed):
    commit = "a" * 40
    monkeypatch.setattr(code_changes, "_baseline", lambda *_args: ({"git": {"commit": commit, "dirty": False}}, None))
    configs = []

    def git(repo, args, limit, env):
        config = env.get("GIT_CONFIG_GLOBAL")
        if config is None:
            raise OSError("command-scope trust is unavailable")
        config = Path(config)
        assert config.is_file()
        configs.append(config)
        assert subprocess.check_output(["git", "config", "--file", str(config), "--get", "safe.directory"]).decode().strip() == str(tmp_path.resolve())
        if failed:
            raise OSError("synthetic Git failure")
        return b""

    monkeypatch.setattr(code_changes, "_git", git)
    metadata = code_changes.capture_code_changes(tmp_path, tmp_path, "ev-base",
                                                {"commit": commit, "dirty": False}, tmp_path, trust_repo=True)
    assert configs, "code capture did not use the revision capture trust mechanism"
    assert all(not config.exists() for config in configs)
    assert metadata["status"] == ("git_unavailable" if failed else "recorded")
