"""Local-copy deletion and import suppression, using only temporary local records."""
from __future__ import annotations

import json
import shutil
import stat
import threading
import time
from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from capx_trace_viewer import evals, gmo
from capx_trace_viewer.eval_api import EvalService
from capx_trace_viewer.gmo_api import GmoService, create_gmo_router
from capx_trace_viewer.server import create_app

BASE = "http://127.0.0.1:8290"
READ = {"X-CapX-Request": "gmo"}
WRITE = {**READ, "Origin": BASE}
PREFIX = "/api/gmo/local-copies"


def _episode(root: Path, run: str = "run_a", episode: str = "trial", *, running: bool = False) -> Path:
    path = root / run / episode
    path.mkdir(parents=True)
    (path.parent / "run.json").write_text("{}\n")
    (path / "episode.json").write_text(json.dumps({
        "status": "started" if running else "ended", "trace_complete": not running,
    }))
    (path / "events.jsonl").write_text('{"seq":1}\n')
    (path / "heartbeat").touch()
    return path


def _evaluation(root: Path, run: str) -> dict:
    stamp = "2026-01-01T01:02:03+00:00"
    value = {"schema": "capx-eval/1", "eval_id": run, "status": "completed",
             "end": {"exit_code": 0, "signal": None}, "by": "", "changed": "",
             "baseline_eval_id": None, "eval_set": None, "git": None,
             "started_at": stamp, "heartbeat_at": stamp, "ended_at": stamp,
             "summary": evals.aggregate_episodes([])}
    (root / run / "eval.json").write_text(json.dumps(value))
    return value


def _size(path: Path) -> int:
    """Count each non-directory inode, including links but never their targets."""
    result = 0
    for entry in path.iterdir():
        info = entry.lstat()
        result += _size(entry) if stat.S_ISDIR(info.st_mode) else info.st_size
    return result


def _done(service: GmoService) -> None:
    deadline = time.monotonic() + 5
    while any(job["finished_at"] is None for job in service.jobs()):
        assert time.monotonic() < deadline, "Local fake transfer did not finish"
        time.sleep(0.005)
    assert all(job["state"] == "done" for job in service.jobs()), service.jobs()


@pytest.fixture
def local_copies(tmp_path, monkeypatch):
    source = tmp_path / "source"
    source.mkdir()
    config = tmp_path / "config" / "gmo.json"
    settings = gmo.GmoSettings(host="test-transport", mine=(str(source),), shared_root="",
                               submission_root="", interval_s=120)
    gmo.save_settings(settings, config)
    transport = tmp_path / "transport"
    transport.write_text('#!/bin/sh\nshift\nexec sh -c "$*"\n')
    transport.chmod(0o700)
    monkeypatch.setenv("CAPX_GMO_SSH_COMMAND", str(transport))
    monkeypatch.setenv("CAPX_GMO_CONFIG", str(config))

    # Retain the real manifest planning and safety checks, replacing only rsync.
    def copy_manifest(runner, ssh, host, run, local_run, files, **kwargs):
        for relative, _size_bytes, _mtime in files:
            target = local_run / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(Path(run.path) / relative, target)

    monkeypatch.setattr(gmo, "_rsync_manifest", copy_manifest)
    service = GmoService(tmp_path / "dest", config)
    app = FastAPI()
    app.include_router(create_gmo_router(service))
    client = TestClient(app, base_url=BASE, client=("127.0.0.1", 40001))
    try:
        yield service, source, client
    finally:
        client.close()
        service.close()


def _copy_run(service: GmoService, source: Path, run: str = "run_a") -> Path:
    target = service.dest / run
    shutil.copytree(source / run, target)
    return target


def _delete(client: TestClient, run_id="run_a"):
    return client.post(PREFIX + "/delete", json={"run_id": run_id}, headers=WRITE)


def test_local_listing_orders_sizes_counts_evaluations_and_uses_cached_remote(local_copies, tmp_path, monkeypatch):
    service, source, client = local_copies
    _episode(source, "small")
    _episode(source, "ev-large", "trial-1")
    _episode(source, "ev-large", "trial-2")
    evaluation = _evaluation(source, "ev-large")
    small = _copy_run(service, source, "small")
    large = _copy_run(service, source, "ev-large")
    (large / "trial-1" / "video.mp4").write_bytes(b"x" * 4096)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "large-file").write_bytes(b"x" * 16384)
    (large / "external").symlink_to(outside, target_is_directory=True)
    service.remote_rows(refresh=True)

    def unexpected(*args, **kwargs):
        raise AssertionError("Drawing local copies must not list the remote")

    monkeypatch.setattr(gmo, "list_remote_episodes", unexpected)
    response = client.get(PREFIX, headers=READ)
    assert response.status_code == 200
    result = response.json()
    assert result["total_bytes"] == _size(small) + _size(large)
    assert [row["run_id"] for row in result["runs"]] == ["ev-large", "small"]
    large_row, small_row = result["runs"]
    assert large_row["size_bytes"] == _size(large)
    assert large_row["episode_count"] == 2
    assert large_row["is_eval"] is True
    assert large_row["started_at"] == evaluation["started_at"]
    assert small_row["episode_count"] == 1 and small_row["is_eval"] is False
    assert all(row["deletable"] for row in result["runs"])


def test_local_listing_without_remote_snapshot_is_unknown_and_does_not_fetch(local_copies, monkeypatch):
    service, source, client = local_copies
    _episode(source)
    _copy_run(service, source)

    def unexpected(*args, **kwargs):
        raise AssertionError("The local-copies list must not start a remote refresh")

    monkeypatch.setattr(gmo, "list_remote_episodes", unexpected)
    row, = client.get(PREFIX, headers=READ).json()["runs"]
    assert row["deletable"] is False and row["reason"] == "unknown"


@pytest.mark.parametrize("run_id", ["../run_a", "a/b", "", ".", "..", None, 3])
def test_delete_refuses_invalid_ids(local_copies, run_id):
    service, source, client = local_copies
    _episode(source)
    target = _copy_run(service, source)
    response = _delete(client, run_id)
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "invalid_id"
    assert target.is_dir()


def test_delete_refuses_missing_run(local_copies):
    service, source, client = local_copies
    _episode(source)
    service.dest.mkdir()
    response = _delete(client)
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "missing"
    assert (source / "run_a").is_dir()


@pytest.mark.parametrize("link", ["run", "dest"])
def test_delete_refuses_symlinked_run_or_destination(local_copies, tmp_path, link):
    service, source, client = local_copies
    _episode(source)
    untouched = tmp_path / "untouched"
    shutil.copytree(source, untouched)
    if link == "run":
        service.dest.mkdir()
        (service.dest / "run_a").symlink_to(untouched / "run_a", target_is_directory=True)
    else:
        service.dest.symlink_to(untouched, target_is_directory=True)
    response = _delete(client)
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "unsafe_path"
    assert (untouched / "run_a" / "trial" / "events.jsonl").is_file()


@pytest.mark.parametrize("replacement", ["run", "dest"])
def test_delete_refuses_a_symlink_swap_during_remote_listing(local_copies, tmp_path, monkeypatch, replacement):
    service, source, client = local_copies
    _episode(source)
    local = _copy_run(service, source)
    outside = tmp_path / "untouched"
    _episode(outside)
    (outside / "keep").write_text("keep")
    moved = tmp_path / "moved"
    original = gmo.list_remote_episodes

    def listing(*args, **kwargs):
        result = original(*args, **kwargs)
        replaced = local if replacement == "run" else service.dest
        replaced.rename(moved)
        replaced.symlink_to(outside / "run_a" if replacement == "run" else outside,
                            target_is_directory=True)
        return result

    monkeypatch.setattr(gmo, "list_remote_episodes", listing)
    response = _delete(client)
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "unsafe_path"
    original_run = moved if replacement == "run" else moved / "run_a"
    assert (original_run / "trial" / "events.jsonl").is_file()
    assert (outside / "run_a" / "trial" / "events.jsonl").is_file()
    assert (outside / "keep").read_text() == "keep"
    assert gmo.load_skip_list(service.config_path) == set()


@pytest.mark.parametrize("busy", ["pending", "live", "remote_recording", "local_recording"])
def test_delete_refuses_busy_runs(local_copies, monkeypatch, busy):
    service, source, client = local_copies
    _episode(source, running=busy == "remote_recording")
    local = _copy_run(service, source)
    if busy == "local_recording":
        (local / "trial" / "episode.json").write_text('{"status":"started"}')
    if busy == "pending":
        with service._lock:
            service._pending.add(("run_a", "trial"))
    elif busy == "live":
        monkeypatch.setattr(service, "_live_loop", lambda: None)
        assert service.follow("run_a", "trial")["following"] is True
    service.remote_rows(refresh=True)
    row, = client.get(PREFIX, headers=READ).json()["runs"]
    assert row["deletable"] is False and row["reason"] == "busy"
    response = _delete(client)
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "busy"
    assert local.is_dir()


@pytest.mark.parametrize("remote_problem", ["missing_episode", "conflict"])
def test_delete_refuses_local_episodes_without_an_unambiguous_remote_copy(local_copies, monkeypatch, remote_problem):
    service, source, client = local_copies
    _episode(source)
    target = _copy_run(service, source)
    if remote_problem == "missing_episode":
        _episode(service.dest, episode="local-only")
    else:
        original = gmo.list_remote_episodes

        def conflicting(*args, **kwargs):
            listing = original(*args, **kwargs)
            for row in listing["episodes"]:
                row["conflict"] = True
            return listing

        monkeypatch.setattr(gmo, "list_remote_episodes", conflicting)
    service.remote_rows(refresh=True)
    row, = client.get(PREFIX, headers=READ).json()["runs"]
    assert row["deletable"] is False and row["reason"] == "not_on_remote"
    response = _delete(client)
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "not_on_remote"
    assert target.is_dir()


def test_delete_rechecks_remote_even_if_cached_copy_is_deletable(local_copies):
    service, source, client = local_copies
    _episode(source)
    target = _copy_run(service, source)
    service.remote_rows(refresh=True)
    assert client.get(PREFIX, headers=READ).json()["runs"][0]["deletable"] is True
    shutil.rmtree(source / "run_a")
    response = _delete(client)
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "not_on_remote"
    assert target.is_dir()


@pytest.mark.parametrize("new_episode", ["local_only", "recording"])
def test_delete_rescans_local_episodes_after_the_remote_listing(local_copies, monkeypatch, new_episode):
    service, source, client = local_copies
    _episode(source)
    target = _copy_run(service, source)
    if new_episode == "recording":
        _episode(source, episode="added")
    original = gmo.list_remote_episodes

    def listing(*args, **kwargs):
        result = original(*args, **kwargs)
        _episode(service.dest, episode="added", running=new_episode == "recording")
        return result

    monkeypatch.setattr(gmo, "list_remote_episodes", listing)
    response = _delete(client)
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == ("busy" if new_episode == "recording" else "not_on_remote")
    assert (target / "added" / "episode.json").is_file()
    assert gmo.load_skip_list(service.config_path) == set()


def test_delete_refuses_unreachable_remote_and_listing_becomes_unknown(local_copies, monkeypatch):
    service, source, client = local_copies
    _episode(source)
    target = _copy_run(service, source)
    service.remote_rows(refresh=True)

    def unreachable(*args, **kwargs):
        raise gmo.FetchError("Test transport is unavailable")

    monkeypatch.setattr(gmo, "list_remote_episodes", unreachable)
    response = _delete(client)
    assert response.status_code == 502
    assert response.json()["detail"]["reason"] == "unknown"
    row, = client.get(PREFIX, headers=READ).json()["runs"]
    assert row["deletable"] is False and row["reason"] == "unknown"
    assert target.is_dir()


def test_delete_blocks_new_fetches_and_live_followers_during_fresh_listing(local_copies, monkeypatch):
    service, source, _client = local_copies
    _episode(source)
    _copy_run(service, source)
    entered, release = threading.Event(), threading.Event()
    original = gmo.list_remote_episodes

    def listing(*args, **kwargs):
        entered.set()
        assert release.wait(5), "Delete test did not release the remote listing"
        return original(*args, **kwargs)

    monkeypatch.setattr(gmo, "list_remote_episodes", listing)
    result = {}

    def remove():
        try:
            result["value"] = service.delete_local_copy("run_a")
        except Exception as exc:
            result["error"] = exc

    thread = threading.Thread(target=remove)
    thread.start()
    try:
        assert entered.wait(3)
        for action in (service.enqueue, service.follow):
            with pytest.raises(HTTPException) as caught:
                action("run_a", "trial")
            assert caught.value.status_code == 409
            assert caught.value.detail["reason"] == "busy"
    finally:
        release.set()
        thread.join(5)
    assert not thread.is_alive()
    assert "error" not in result, result
    assert result["value"]["run_id"] == "run_a"
    assert not (service.dest / "run_a").exists()


def test_delete_aborts_before_removing_files_if_skip_list_cannot_be_saved(local_copies, monkeypatch):
    service, source, client = local_copies
    _episode(source)
    target = _copy_run(service, source)

    def cannot_save(*args, **kwargs):
        raise OSError("Simulated full local state filesystem")

    monkeypatch.setattr(gmo, "save_skip_list", cannot_save)
    response = _delete(client)
    assert response.status_code == 409
    assert response.json()["detail"]["reason"] == "io_error"
    assert (target / "trial" / "events.jsonl").is_file()


@pytest.mark.parametrize("safe_rmtree", [True, False])
def test_delete_frees_folder_preserves_link_targets_and_invalidates_caches(local_copies, monkeypatch, tmp_path, safe_rmtree):
    service, source, client = local_copies
    _episode(source, "ev-delete")
    _evaluation(source, "ev-delete")
    local = _copy_run(service, source, "ev-delete")
    outside = tmp_path / "untouched"
    outside.mkdir()
    (outside / "keep").write_text("keep")
    (local / "external").symlink_to(outside, target_is_directory=True)
    service.remote_rows(refresh=True)
    service.remote_eval_listing(wait=True)
    service._remote_snapshot(kind="run", run_ids=("ev-delete",))
    evaluation = EvalService(service.dest, service)
    assert evaluation.listing()["evals"][0]["location"] == "both"
    size = client.get(PREFIX, headers=READ).json()["total_bytes"]
    assert service._cache is not None
    generation = service._generation
    monkeypatch.setattr(shutil.rmtree, "avoids_symlink_attacks", safe_rmtree)
    response = _delete(client, "ev-delete")
    assert response.status_code == 200, response.text
    assert response.json() == {"run_id": "ev-delete", "freed_bytes": size}
    assert not local.exists()
    assert (outside / "keep").read_text() == "keep"
    assert (source / "ev-delete" / "trial").is_dir()
    assert service._cache is None and service._generation > generation
    assert client.get(PREFIX, headers=READ).json() == {"runs": [], "total_bytes": 0}
    assert evaluation.listing()["evals"][0]["location"] == "gmo"
    assert service.episode("ev-delete", "trial")["local_state"] == "remote"


@pytest.mark.parametrize("importer", ["auto", "prefetch"])
def test_skip_list_survives_restart_and_skips_old_trials_but_imports_new_ones(local_copies, importer):
    service, source, client = local_copies
    _episode(source, episode="old-1")
    _episode(source, episode="old-2")
    _copy_run(service, source)
    assert _delete(client).status_code == 200
    skip_path = gmo.skip_list_path(service.config_path)
    assert stat.S_IMODE(skip_path.stat().st_mode) == 0o600
    assert service.config_path.parent / "cache" in skip_path.parents
    assert gmo.load_skip_list(service.config_path) == {("run_a", "old-1"), ("run_a", "old-2")}
    _episode(source, episode="new")
    restarted = GmoService(service.dest, service.config_path)
    try:
        if importer == "auto":
            assert restarted.run_auto_once()["queued_in_last_run"] == 1
            _done(restarted)
            assert {job["episode_id"] for job in restarted.jobs()} == {"new"}
        else:
            assert gmo.prefetch_mine(service.dest, service.config_path) == 0
        assert (service.dest / "run_a" / "new" / "events.jsonl").is_file()
        assert not (service.dest / "run_a" / "old-1").exists()
        assert not (service.dest / "run_a" / "old-2").exists()
    finally:
        restarted.close()


@pytest.mark.parametrize("manual", ["fetch", "follow"])
def test_manual_import_clears_only_the_selected_skip_key(local_copies, monkeypatch, manual):
    service, source, client = local_copies
    _episode(source, episode="first")
    _episode(source, episode="second")
    _copy_run(service, source)
    assert _delete(client).status_code == 200
    if manual == "fetch":
        response = client.post("/api/gmo/fetch", json={"run_id": "run_a", "episode_id": "first"}, headers=WRITE)
        assert response.status_code == 200, response.text
        _done(service)
    else:
        monkeypatch.setattr(service, "_live_loop", lambda: None)
        assert service.follow("run_a", "first")["following"] is True
    assert gmo.load_skip_list(service.config_path) == {("run_a", "second")}


def test_completed_live_follow_can_import_again_after_local_deletion(local_copies, monkeypatch):
    service, source, client = local_copies
    episode = _episode(source)
    (episode / "events.jsonl").write_text('{"seq":1,"event_type":"episode_end"}\n')
    _copy_run(service, source)
    monkeypatch.setattr(service, "_live_loop", lambda: None)
    service.follow("run_a", "trial")
    service._run_live_cycle(service._live)
    service._run_live_cycle(service._live)
    assert service.live_status()["stopped_reason"] == "episode_ended"
    assert _delete(client).status_code == 200
    assert gmo.load_skip_list(service.config_path) == {("run_a", "trial")}
    status = service.follow("run_a", "trial")
    assert status["following"] is True
    assert gmo.load_skip_list(service.config_path) == set()
    service._run_live_cycle(service._live)
    assert (service.dest / "run_a" / "trial" / "events.jsonl").is_file()


@pytest.mark.parametrize("expired", [False, True])
def test_delete_preserves_another_runs_active_or_resumable_live_lease(local_copies, monkeypatch, expired):
    service, source, client = local_copies
    _episode(source)
    _episode(source, run="other-run")
    _copy_run(service, source)
    monkeypatch.setattr(service, "_live_loop", lambda: None)
    token = service.follow("other-run", "trial")["lease_token"]
    if expired:
        with service._lock:
            runner = service._stop_live_locked("lease_expired")
        runner.close()
    generation = service._generation
    assert _delete(client).status_code == 200
    assert service._generation > generation
    with service._lock:
        assert service._live_lease["settings_generation"] == service._generation
        if not expired:
            assert service._live is service._live_lease
            assert service._live["settings_generation"] == service._generation
    status = service.renew("other-run", "trial", token)
    assert status["following"] is True
    assert status["run_id"] == "other-run" and status["lease_token"] == token
    service._run_live_cycle(service._live)
    assert (service.dest / "other-run" / "trial" / "events.jsonl").is_file()


def test_local_listing_reuses_auto_mine_snapshot_without_claiming_unlisted_runs(local_copies, monkeypatch):
    service, source, client = local_copies
    _episode(source)
    _episode(service.dest, run="unlisted")
    assert service.run_auto_once()["queued_in_last_run"] == 1
    _done(service)

    def unexpected(*args, **kwargs):
        raise AssertionError("The mine cache already describes this local copy")

    monkeypatch.setattr(gmo, "list_remote_episodes", unexpected)
    rows = {row["run_id"]: row for row in client.get(PREFIX, headers=READ).json()["runs"]}
    assert rows["run_a"]["deletable"] is True
    assert rows["unlisted"]["deletable"] is False
    assert rows["unlisted"]["reason"] == "unknown"


def test_missing_or_corrupt_skip_list_is_empty(local_copies):
    service, source, _client = local_copies
    _episode(source)
    assert gmo.load_skip_list(service.config_path) == set()
    path = gmo.skip_list_path(service.config_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    for value in ("{", "null", "[]", '{"episodes": 3}'):
        path.write_text(value)
        path.chmod(0o600)
        assert gmo.load_skip_list(service.config_path) == set()
    assert service.run_auto_once()["queued_in_last_run"] == 1
    _done(service)


@pytest.mark.parametrize("headers,status", [
    ({"Origin": BASE}, 403),
    ({**READ, "Origin": "https://example.invalid"}, 403),
    ({**WRITE, "Content-Type": "text/plain"}, 415),
])
def test_delete_uses_existing_post_gate(local_copies, headers, status):
    _service, _source, client = local_copies
    response = client.post(PREFIX + "/delete", content='{"run_id":"run_a"}', headers=headers)
    assert response.status_code == status


def test_rtx_prefix_and_persistent_skip_lists_are_independent(local_copies, tmp_path):
    service, source, _client = local_copies
    _episode(source)
    _copy_run(service, source)
    rtx_config = service.config_path.with_name("rtx.json")
    gmo.save_settings(service.load_settings(), rtx_config)
    rtx = GmoService(tmp_path / "rtx-dest", rtx_config)
    _copy_run(rtx, source)
    app = FastAPI()
    app.include_router(create_gmo_router(service))
    app.include_router(create_gmo_router(rtx, prefix="/api/sites/rtx/gmo"))
    try:
        with TestClient(app, base_url=BASE, client=("127.0.0.1", 40001)) as client:
            response = client.post("/api/sites/rtx/gmo/local-copies/delete", json={"run_id": "run_a"}, headers=WRITE)
            assert response.status_code == 200, response.text
            assert (service.dest / "run_a").is_dir()
            assert not (rtx.dest / "run_a").exists()
            assert gmo.load_skip_list(service.config_path) == set()
            assert gmo.load_skip_list(rtx.config_path) == {("run_a", "trial")}
            assert client.get("/api/sites/rtx/gmo/local-copies", headers=READ).json()["total_bytes"] == 0
    finally:
        rtx.close()


def test_local_copy_routes_do_not_exist_without_gmo(tmp_path):
    app = create_app(gmo=False, trace_root=tmp_path / "traces", frontend_dist=tmp_path / "no-dist")
    with TestClient(app, base_url=BASE, client=("127.0.0.1", 40001)) as client:
        assert client.get(PREFIX, headers=READ).status_code == 404
        assert _delete(client).status_code == 404
