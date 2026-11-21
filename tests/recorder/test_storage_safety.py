"""Recorder destinations and identities remain safe across processes and restarts."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from capx_trace_recorder import context as C
from capx_trace_recorder import store as S
from capx_trace_recorder.config import TraceConfig
from capx_trace_recorder.hooks import trial as TRIAL
from capx_trace_viewer import reader


def make_store(tmp_path):
    return S.TraceStore(TraceConfig(trace_dir=tmp_path / "traces"))


def test_atomic_write_does_not_follow_precreated_temporary_symlink(tmp_path):
    store = make_store(tmp_path)
    parent = store.config.trace_dir / "run" / "ep"
    parent.mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.write_bytes(b"original")
    instance = f".{store.instance_id}" if hasattr(store, "instance_id") else ""
    (parent / f".payload.tmp.{os.getpid()}{instance}.1").symlink_to(outside)
    store.atomic_write(parent / "payload", b"replacement")
    assert outside.read_bytes() == b"original"


@pytest.mark.parametrize("kind", ["symlink", "hardlink"])
def test_event_append_rejects_linked_targets(tmp_path, kind):
    store = make_store(tmp_path)
    ep = S.EpisodeRecorder(store, "run", "ep", store.config.trace_dir / "run", "test")
    ep.base_dir.mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.write_bytes(b"original")
    if kind == "symlink":
        ep.events_path.symlink_to(outside)
    else:
        os.link(outside, ep.events_path)
    wep = S.WriterEpisode(ep)
    try:
        assert store._append_line(wep, b"event\n") is False
        assert outside.read_bytes() == b"original"
    finally:
        store._close_fd(wep)
        store.shutdown(5)


def test_atomic_write_rejects_symlink_directory_components(tmp_path):
    store = make_store(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    store.config.trace_dir.mkdir()
    (store.config.trace_dir / "run").symlink_to(outside, target_is_directory=True)
    ok, _ = store.atomic_write(store.config.trace_dir / "run" / "payload", b"replacement")
    assert ok is False
    assert list(outside.iterdir()) == []


def test_atomic_write_pins_parent_during_publication(tmp_path, monkeypatch):
    store = make_store(tmp_path)
    parent = store.config.trace_dir / "run"
    parent.mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    real_write = S._write_all
    swapped = []

    def replace_parent(fd, data):
        real_write(fd, data)
        parent.rename(parent.with_name("old-run"))
        parent.symlink_to(outside, target_is_directory=True)
        swapped.append(True)

    monkeypatch.setattr(S, "_write_all", replace_parent)
    ok, _ = store.atomic_write(parent / "payload", b"replacement")
    assert swapped and ok
    assert not (outside / "payload").exists()
    assert (parent.with_name("old-run") / "payload").read_bytes() == b"replacement"


def test_episode_ids_are_reserved_across_independent_registries(tmp_path, monkeypatch):
    store = make_store(tmp_path)
    monkeypatch.setattr(C, "REGISTRY", C.Registry())
    first = C.unique_episode_id(store, "run", "trial")
    monkeypatch.setattr(C, "REGISTRY", C.Registry())
    second = C.unique_episode_id(store, "run", "trial")
    assert first != second
    assert (store.config.trace_dir / "run" / first).is_dir()
    assert (store.config.trace_dir / "run" / second).is_dir()


def test_unscoped_logs_do_not_share_a_pid_only_destination(tmp_path):
    first, second = make_store(tmp_path), make_store(tmp_path)
    run = first.config.trace_dir / "run"
    one, two = S.UnscopedLog(first, "run", run), S.UnscopedLog(second, "run", run)
    assert one.events_path != two.events_path
    assert one.base_dir != two.base_dir
    for log in (one, two):
        log_id = log.events_path.stem
        assert reader.is_unscoped_log_id(log_id)
        assert reader.unscoped_log_file(log_id) == log.events_path.name
    assert reader.is_unscoped_log_id(f"unscoped.{os.getpid()}")


def test_fork_reset_preserves_hook_diagnostics_and_clears_episode(tmp_path, monkeypatch):
    store = make_store(tmp_path)
    ep = S.EpisodeRecorder(store, "run", "ep", store.config.trace_dir / "run", "test")
    registry = C.Registry()
    registry.hooks_installed = ["H1:transport"]
    registry.hooks_failed = [{"hook": "H4", "target": "trial", "reason": "unavailable"}]
    registry.hooks_skipped = [{"hook": "H5", "target": "legacy", "reason": "absent"}]
    registry.failures_logged = 1
    monkeypatch.setattr(C, "REGISTRY", registry)
    token = C.WEB_EPISODE.set(ep)
    try:
        C.reset_registry_after_fork()
        assert C.REGISTRY.hooks_failed == registry.hooks_failed
        assert C.REGISTRY.hooks_installed == registry.hooks_installed
        assert C.REGISTRY.hooks_skipped == registry.hooks_skipped
        assert C.REGISTRY.failures_logged == 0
        assert C.WEB_EPISODE.get() is None
        assert C.REGISTRY.open_episodes() == []
    finally:
        C.WEB_EPISODE.reset(token)


def test_run_metadata_is_not_visible_until_fully_written(tmp_path, monkeypatch):
    store = make_store(tmp_path)
    run = store.config.trace_dir / "run"
    seen = []
    real_write = S._write_all

    def inspect_publication(fd, data):
        seen.append((run / "run.json").exists())
        real_write(fd, data)

    monkeypatch.setattr(S, "_write_all", inspect_publication)
    store._ensure_run_json(run, "run")
    assert seen == [False]
    assert json.loads((run / "run.json").read_text())["run_id"] == "run"


@pytest.mark.parametrize("partial", ['{"schema_version":', '{"run_id":"run"}'])
def test_run_metadata_repairs_interrupted_legacy_publication(tmp_path, partial):
    store = make_store(tmp_path)
    run = store.config.trace_dir / "run"
    run.mkdir(parents=True)
    (run / "run.json").write_text(partial)
    store._ensure_run_json(run, "run")
    repaired = json.loads((run / "run.json").read_text())
    assert repaired["run_id"] == "run"
    assert repaired["schema_version"] == S.SCHEMA_VERSION
    assert isinstance(repaired["created_by"], dict)
    assert isinstance(repaired["created_at"], str)


def test_video_copy_rejects_symlink_destination(tmp_path, monkeypatch):
    from test_trial_videos import record

    trial = tmp_path / "trial"
    trial.mkdir()
    (trial / "video_combined.mp4").write_bytes(b"new video")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "video_combined.mp4").write_bytes(b"original")
    real_copy = TRIAL._copy_trial_videos

    def linked_destination(ctx, *args, **kwargs):
        (ctx.base_dir / "videos").symlink_to(outside, target_is_directory=True)
        return real_copy(ctx, *args, **kwargs)

    monkeypatch.setattr(TRIAL, "_copy_trial_videos", linked_destination)
    _, _, videos, _ = record(tmp_path, trial)
    assert (outside / "video_combined.mp4").read_bytes() == b"original"
    assert videos["artifacts"][0]["written"] is False


def test_configured_symlink_root_remains_supported(tmp_path):
    actual = tmp_path / "storage"
    actual.mkdir()
    configured = tmp_path / "shared-storage"
    configured.symlink_to(actual, target_is_directory=True)
    store = S.TraceStore(TraceConfig(trace_dir=configured / "traces"))
    ok, _ = store.atomic_write(configured / "traces" / "run" / "payload", b"recorded")
    assert ok
    assert (actual / "traces" / "run" / "payload").read_bytes() == b"recorded"


def test_destination_walking_supports_search_only_ancestors(tmp_path, monkeypatch):
    ancestor = tmp_path / "search-only"
    ancestor.mkdir()
    (ancestor / "traces").mkdir()
    store = S.TraceStore(TraceConfig(trace_dir=ancestor / "traces"))
    original = os.open

    def require_search_flags(path, flags, *args, **kwargs):
        if path == "search-only" and hasattr(os, "O_PATH"):
            assert flags & os.O_PATH
        return original(path, flags, *args, **kwargs)

    monkeypatch.setattr(os, "open", require_search_flags)
    ancestor.chmod(0o111)
    try:
        ok, _ = store.atomic_write(ancestor / "traces" / "run" / "payload", b"recorded")
        assert ok
        assert (ancestor / "traces" / "run" / "payload").read_bytes() == b"recorded"
    finally:
        ancestor.chmod(0o755)


def test_run_metadata_preserves_complete_publication_with_leftover_temp_link(tmp_path):
    first = make_store(tmp_path)
    run = first.config.trace_dir / "run"
    first._ensure_run_json(run, "run")
    path = run / "run.json"
    raw = path.read_bytes()
    os.link(path, run / ".run.json.tmp.interrupted")
    resumed = make_store(tmp_path)
    resumed._ensure_run_json(run, "run")
    assert str(run) in resumed._run_json_done
    assert path.read_bytes() == raw
    assert resumed.stats["run_write_failed"] == 0
