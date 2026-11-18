"""Automatic mine imports with local fake SSH and real rsync; no network."""
from __future__ import annotations

import json
import os
import pwd
import shutil
import sys
import threading
import time
from dataclasses import replace
from datetime import datetime
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from capx_trace_viewer import gmo
from capx_trace_viewer.gmo_api import GmoService
from capx_trace_viewer.server import create_app

BASE = "http://127.0.0.1:8290"
READ = {"X-CapX-Request": "gmo"}
WRITE = {**READ, "Origin": BASE}


def _episode(root: Path, name: str, *, run: str = "run_a", running: bool = False) -> Path:
    path = root / run / name
    path.mkdir(parents=True)
    (path.parent / "run.json").write_text("{}")
    (path / "episode.json").write_text(json.dumps({
        "status": "started" if running else "ended", "trace_complete": not running,
    }))
    (path / "events.jsonl").write_text('{"seq":1}\n')
    (path / "heartbeat").touch()
    return path


def _until(predicate, timeout: float = 5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if result := predicate():
            return result
        time.sleep(0.01)
    pytest.fail("GMO background operation did not complete")


def _done(service: GmoService):
    _until(lambda: all(j["finished_at"] is not None for j in service.jobs()))
    assert all(j["state"] == "done" for j in service.jobs()), service.jobs()


def _delay(status: dict) -> float:
    return (datetime.fromisoformat(status["next_run_at"])
            - datetime.fromisoformat(status["last_run_at"])).total_seconds()


@pytest.fixture
def auto_source(tmp_path, monkeypatch):
    mine, team = tmp_path / "mine", tmp_path / "team"
    mine.mkdir()
    team.mkdir()
    log = tmp_path / "ssh.log"
    ssh = tmp_path / "fake_ssh"
    ssh.write_text(
        '#!/bin/sh\n'
        'if [ "$1" = "-l" ]; then shift 2; fi\n'
        'shift\n'
        'case "$*" in\n'
        '  python3*) kind=list ;;\n'
        '  rsync*) kind=rsync ;;\n'
        '  *) kind=unexpected ;;\n'
        'esac\n'
        'printf "%s\\n" "$kind" >> "$CAPX_GMO_TEST_SSH_LOG"\n'
        'exec sh -c "$*"\n'
    )
    ssh.chmod(0o700)
    monkeypatch.setenv("CAPX_GMO_CONFIG", str(tmp_path / "config" / "gmo.json"))
    monkeypatch.setenv("CAPX_GMO_SSH_COMMAND", str(ssh))
    monkeypatch.setenv("CAPX_GMO_TEST_SSH_LOG", str(log))
    settings = gmo.GmoSettings(host="fakehost", mine=(str(mine),), team=(str(team),))
    gmo.save_settings(settings)
    service = GmoService(tmp_path / "dest")
    try:
        yield service, mine, team, log, ssh, settings
    finally:
        service.close()


def test_auto_only_remote_and_stale_mine_one_listing(auto_source):
    if shutil.which("rsync") is None:
        pytest.skip("rsync is not installed")
    service, mine, team, log, _, _ = auto_source
    _episode(mine, "remote")
    stale = _episode(mine, "stale")
    local = _episode(mine, "local")
    _episode(team, "team", run="team_run")
    shutil.copytree(local, service.dest / "run_a" / "local")
    shutil.copytree(stale, service.dest / "run_a" / "stale")
    shutil.copy2(local.parent / "run.json", service.dest / "run_a" / "run.json")
    (service.dest / "run_a" / "stale" / "events.jsonl").write_text("partial")
    state = service.run_auto_once()
    assert state["queued_in_last_run"] == 2 and state["skipped_large"] == []
    _done(service)
    assert {j["episode_id"] for j in service.jobs()} == {"remote", "stale"}
    assert not (service.dest / "team_run").exists()
    assert log.read_text().splitlines().count("list") == 1
    assert log.read_text().splitlines().count("rsync") == 2
    assert service.run_auto_once()["queued_in_last_run"] == 0


@pytest.mark.parametrize("username, teammate", [("trace_user", "team_user"), ("alice@domain", "alice")])
def test_shared_root_auto_only_mine_and_manual_team(auto_source, username, teammate):
    if shutil.which("rsync") is None:
        pytest.skip("rsync is not installed")
    service, mine, _, log, _, _ = auto_source
    shared = mine.parent / "shared"
    own = _episode(shared / username, "ep_own")
    theirs = _episode(shared / teammate, "ep_team", run="team_run")
    service.update_settings(gmo.GmoSettings(host=username + "@fakehost", shared_root=str(shared)))
    state = service.run_auto_once()
    assert state["enabled"] is True and state["queued_in_last_run"] == 1
    _done(service)
    assert (service.dest / "run_a" / "ep_own" / "events.jsonl").read_bytes() == (own / "events.jsonl").read_bytes()
    assert not (service.dest / "team_run").exists()
    assert log.read_text().splitlines() == ["list", "rsync"]
    rows = {row["run_id"]: row for row in service.episodes("all")}
    assert rows["run_a"]["owner"] == username and rows["run_a"]["mine"] is True
    assert rows["team_run"]["owner"] == teammate and rows["team_run"]["mine"] is False
    service.enqueue("team_run", "ep_team")
    _done(service)
    assert (service.dest / "team_run" / "ep_team" / "events.jsonl").read_bytes() == (theirs / "events.jsonl").read_bytes()


@pytest.mark.parametrize("mine_only", [False, True])
def test_shared_root_username_with_at_uses_last_separator(auto_source, mine_only):
    service, mine, _, _, _, _ = auto_source
    shared = mine.parent / "shared"
    _episode(shared / "alice@domain", "ep_own")
    _episode(shared / "alice", "ep_other", run="other_run")
    settings = gmo.GmoSettings.from_dict({"host": "alice@domain@fakehost", "shared_root": str(shared)})
    rows = gmo.list_remote_episodes(service.runner, settings, mine_only=mine_only)
    expected = [("run_a", True, "alice@domain")]
    if not mine_only:
        expected.append(("other_run", False, "alice"))
    assert [(row["run_id"], row["mine"], row["owner"]) for row in rows] == expected


def test_shared_root_alias_resolves_remote_username_in_one_ssh(auto_source, monkeypatch):
    service, mine, _, log, _, _ = auto_source
    shared = mine.parent / "shared"
    _episode(shared / "remote_account", "ep_own")
    _episode(shared / pwd.getpwuid(os.geteuid()).pw_name, "ep_other", run="other_run")
    # The fake ssh runs a remote Python whose account database differs from ours.
    # Neither local account names nor USER/LOGNAME can identify the remote user.
    remote_bin = mine.parent / "remote_bin"
    remote_bin.mkdir()
    python = remote_bin / "python3"
    python.write_text(
        f"#!{sys.executable}\n"
        "import pwd, sys, types\n"
        "pwd.getpwuid = lambda uid: types.SimpleNamespace(pw_name='remote_account')\n"
        "code = sys.argv[2]\n"
        "sys.argv = ['-c', *sys.argv[3:]]\n"
        "exec(code)\n"
    )
    python.chmod(0o700)
    monkeypatch.setenv("PATH", str(remote_bin) + os.pathsep + os.environ["PATH"])
    monkeypatch.setenv("USER", "wrong_account")
    monkeypatch.setenv("LOGNAME", "wrong_account")
    service.update_settings(gmo.GmoSettings(host="ssh-alias", shared_root=str(shared)))
    rows = service.episodes("all")
    assert [(row["run_id"], row["mine"], row["owner"]) for row in rows] == [
        ("run_a", True, "remote_account"), ("other_run", False, pwd.getpwuid(os.geteuid()).pw_name)]
    assert log.read_text().splitlines() == ["list"]


def test_shared_root_auto_detects_team_collision_in_one_listing(auto_source, monkeypatch):
    service, mine, _, log, _, _ = auto_source
    shared = mine.parent / "shared"
    _episode(shared / "trace_user", "ep_own")
    _episode(shared / "team_user", "different_episode")
    service.update_settings(gmo.GmoSettings(host="trace_user@fakehost", shared_root=str(shared)))
    monkeypatch.setattr(gmo, "_transfer_episode", lambda *a, **kw: pytest.fail("conflicting run copied"))
    state = service.run_auto_once()
    assert state["queued_in_last_run"] == 0 and state["last_error"] is None
    assert log.read_text().splitlines() == ["list"]
    assert service.jobs() == [] and not service.dest.exists()
    rows = service.episodes("all")
    assert len(rows) == 2 and all(row["conflict"] for row in rows)
    with pytest.raises(HTTPException) as error:
        service.enqueue("run_a", "ep_own")
    assert error.value.status_code == 409


def test_shared_root_adds_explicit_patterns_deduplicates_and_keeps_folder_owner(auto_source):
    service, mine, team, log, _, settings = auto_source
    shared = mine.parent / "shared"
    _episode(mine, "ep_explicit")
    _episode(team, "ep_explicit_team", run="explicit_team")
    _episode(shared / "trace_user", "ep_own", run="shared_own")
    _episode(shared / "team_user", "ep_team", run="shared_team")
    sibling = mine.parent / "shared-other" / "outside_user"
    _episode(sibling, "ep_outside", run="outside_run")
    service.update_settings(replace(
        settings, host="trace_user@fakehost", shared_root=str(shared) + "/",
        mine=(*settings.mine, str(shared / "team_user")),
        team=(*settings.team, str(shared / "*"), str(sibling)),
    ))
    rows = service.episodes("all")
    assert len(rows) == 5 and not any(row["conflict"] for row in rows)
    runs = {row["run_id"]: row for row in rows}
    assert runs["run_a"]["mine"] is True
    assert runs["explicit_team"]["mine"] is False
    assert runs["shared_own"]["mine"] is True and runs["shared_own"]["owner"] == "trace_user"
    assert runs["shared_team"]["mine"] is True and runs["shared_team"]["owner"] == "team_user"
    assert runs["outside_run"]["mine"] is False
    assert runs["outside_run"]["owner"] == pwd.getpwuid(os.getuid()).pw_name
    assert log.read_text().splitlines() == ["list"]


@pytest.mark.parametrize("username", [".", ".."])
def test_shared_root_refuses_username_path_components(auto_source, username):
    service, mine, _, log, _, _ = auto_source
    settings = gmo.GmoSettings(host=username + "@fakehost", shared_root=str(mine.parent / "shared"))
    with pytest.raises(gmo.FetchError, match="Unsupported remote username"):
        gmo.list_remote_episodes(service.runner, settings)
    assert log.read_text().splitlines() == ["list"]


@pytest.mark.parametrize("username, teammate", [("trace_user", "team_user"), ("alice@domain", "alice")])
def test_shared_root_prefetch_only_mine_and_refuses_collisions(auto_source, capsys, username, teammate):
    if shutil.which("rsync") is None:
        pytest.skip("rsync is not installed")
    service, mine, _, _, _, _ = auto_source
    shared = mine.parent / "shared"
    _episode(shared / username, "ep_own")
    _episode(shared / teammate, "ep_team", run="team_run")
    service.update_settings(gmo.GmoSettings(host=username + "@fakehost", shared_root=str(shared)))
    assert gmo.prefetch_mine(service.dest) == 0
    assert (service.dest / "run_a" / "ep_own" / "events.jsonl").is_file()
    assert not (service.dest / "team_run").exists()
    _episode(shared / teammate, "different_episode")
    assert gmo.prefetch_mine(service.dest) == 1
    assert "more than one GMO location" in capsys.readouterr().err


@pytest.mark.parametrize("team_episode", ["ep_1", "different_episode"])
def test_auto_skips_run_collision_with_team_without_overwriting(auto_source, monkeypatch, team_episode):
    service, mine, team, log, _, _ = auto_source
    theirs = _episode(team, team_episode)
    (theirs / "events.jsonl").write_text('{"team":"previously imported"}\n')
    shutil.copytree(theirs.parent, service.dest / "run_a")
    before = {p.relative_to(service.dest): p.read_bytes() for p in service.dest.rglob("*") if p.is_file()}
    _episode(mine, "ep_1")
    monkeypatch.setattr(gmo, "_transfer_episode", lambda *a, **kw: pytest.fail("conflicting run was copied"))
    state = service.run_auto_once()
    assert state["queued_in_last_run"] == 0 and state["last_error"] is None
    assert service.jobs() == []
    assert {p.relative_to(service.dest): p.read_bytes() for p in service.dest.rglob("*") if p.is_file()} == before
    assert log.read_text().splitlines() == ["list"]


@pytest.mark.parametrize("metadata", [None, b'{"partial":'])
@pytest.mark.parametrize("name", ["run.json", "eval.json"])
def test_auto_repairs_run_metadata_without_episode_changes(auto_source, monkeypatch, metadata, name):
    service, mine, _, log, _, _ = auto_source
    first = _episode(mine, "ep_1")
    _episode(mine, "ep_2")
    if name == "eval.json":
        (first.parent / name).write_text('{"schema":"capx-eval/1"}')
    shutil.copytree(first.parent, service.dest / "run_a")
    local_metadata = service.dest / "run_a" / name
    if metadata is None:
        local_metadata.unlink()
    else:
        local_metadata.write_bytes(metadata)
    copied = []

    def transfer(runner, settings, run, episode_id, dest, **kwargs):
        copied.extend(run.files)
        for rel, _, _ in run.files:
            shutil.copy2(Path(run.path) / rel, dest / run.run_id / rel)
        return sum(size for _, size, _ in run.files)

    monkeypatch.setattr(gmo, "_transfer_episode", transfer)
    assert service.run_auto_once()["queued_in_last_run"] == 1
    _done(service)
    assert [rel for rel, _, _ in copied] == [name]
    assert local_metadata.read_bytes() == (first.parent / name).read_bytes()
    assert service.run_auto_once()["queued_in_last_run"] == 0
    assert log.read_text().splitlines() == ["list", "list"]


def test_auto_budget_newest_fit_shared_run_metadata_and_skipped(auto_source, monkeypatch):
    service, mine, _, log, _, _ = auto_source
    sizes = {"new": 600 * 1024**2, "middle": 500 * 1024**2, "old": 200 * 1024**2}
    for index, name in enumerate(("old", "middle", "new")):
        episode = _episode(mine, name)
        with (episode / "video").open("wb") as stream:
            stream.truncate(sizes[name])
        for path in episode.iterdir():
            os.utime(path, (100 + index, 100 + index))
    copied = []

    def transfer(runner, settings, run, episode_id, dest, **kwargs):
        copied.append((episode_id, run.files))
        return sum(size for _, size, _ in run.files)

    monkeypatch.setattr(gmo, "_transfer_episode", transfer)
    state = service.run_auto_once()
    _done(service)
    assert [name for name, _ in copied] == ["new", "old"]
    total = sum(size for _, files in copied for _, size, _ in files)
    assert 800 * 1024**2 < total < gmo.MAX_FETCH_BYTES
    assert sum(rel == "run.json" for _, files in copied for rel, _, _ in files) == 1
    assert state["queued_in_last_run"] == 2
    assert [(row["run_id"], row["episode_id"]) for row in state["skipped_large"]] == [("run_a", "middle")]
    assert state["skipped_large"][0]["size_bytes"] >= sizes["middle"]
    assert log.read_text().splitlines() == ["list"]


def test_auto_exactly_one_gib_is_manual(auto_source):
    service, mine, _, _, _, _ = auto_source
    ep = _episode(mine, "exact")
    (ep / "episode.json").unlink()
    (ep.parent / "run.json").write_bytes(b"")
    with (ep / "events.jsonl").open("wb") as stream:
        stream.truncate(gmo.MAX_FETCH_BYTES)
    state = service.run_auto_once()
    assert state["queued_in_last_run"] == 0
    assert state["skipped_large"] == [{"run_id": "run_a", "episode_id": "exact", "size_bytes": gmo.MAX_FETCH_BYTES}]
    assert service.jobs() == [] and not service.dest.exists()


def test_auto_budget_counts_changed_files_of_large_stale_episode(auto_source, monkeypatch):
    service, mine, _, _, _, _ = auto_source
    ep = _episode(mine, "stale")
    local = service.dest / "run_a" / "stale"
    shutil.copytree(ep, local)
    for path in (ep / "video", local / "video"):
        with path.open("wb") as stream:
            stream.truncate(gmo.MAX_FETCH_BYTES + 100)
        os.utime(path, (100, 100))
    with (ep / "events.jsonl").open("a") as stream:
        stream.write('{"seq":2}\n')
    manifests = []

    def transfer(runner, settings, run, episode_id, dest, **kwargs):
        manifests.append(run)
        return sum(size for _, size, _ in run.files)

    monkeypatch.setattr(gmo, "_transfer_episode", transfer)
    state = service.run_auto_once()
    _done(service)
    assert state["queued_in_last_run"] == 1 and state["skipped_large"] == []
    assert all(rel != "stale/video" for run in manifests for rel, _, _ in run.files)
    assert sum(size for run in manifests for _, size, _ in run.files) < 100


def test_auto_backoff_doubles_caps_and_recovers(auto_source, monkeypatch):
    service, _, _, _, _, settings = auto_source
    original = service.runner.run

    def fail(*args, **kwargs):
        raise gmo.FetchError("fake ssh is unavailable")

    monkeypatch.setattr(service.runner, "run", fail)
    for interval in (240, 480, 960, 1800, 1800):
        state = service.run_auto_once()
        assert state["last_error"] == "fake ssh is unavailable"
        assert interval <= _delay(state) < interval + 1
        assert state["running"] is False and state["queued_in_last_run"] == 0
    monkeypatch.setattr(service.runner, "run", original)
    state = service.run_auto_once()
    assert state["last_error"] is None
    assert settings.interval_s <= _delay(state) < settings.interval_s + 1


def test_auto_transfer_failures_back_off_until_a_successful_batch(auto_source, monkeypatch):
    service, mine, _, _, _, settings = auto_source
    _episode(mine, "ep")

    def fail(*args, **kwargs):
        raise gmo.FetchError("fake rsync failed")

    monkeypatch.setattr(gmo, "_transfer_episode", fail)
    for expected_delay in (240, 480, 960):
        assert service.run_auto_once()["queued_in_last_run"] == 1
        _until(lambda: all(j["finished_at"] is not None for j in service.jobs()))
        state = service.auto_status()
        assert state["last_error"] == "fake rsync failed"
        assert expected_delay <= _delay(state) < expected_delay + 1
    monkeypatch.setattr(gmo, "_transfer_episode", lambda *args, **kwargs: 0)
    service.run_auto_once()
    _until(lambda: all(j["finished_at"] is not None for j in service.jobs()))
    state = service.auto_status()
    assert state["last_error"] is None
    assert settings.interval_s <= _delay(state) < settings.interval_s + 1


def test_auto_pause_zero_interval_and_settings_reload(auto_source):
    if shutil.which("rsync") is None:
        pytest.skip("rsync is not installed")
    service, mine, team, log, _, settings = auto_source
    _episode(mine, "mine")
    _episode(team, "new_mine", run="other_run")
    service.set_auto_paused(True)
    assert service.run_auto_once()["paused"] is True
    assert not log.exists()
    service.set_auto_paused(False)
    gmo.save_settings(replace(settings, interval_s=0))
    state = service.run_auto_once()
    assert state["enabled"] is False and state["next_run_at"] is None
    assert not log.exists()
    gmo.save_settings(replace(settings, mine=(str(team),), team=(str(mine),), interval_s=30))
    state = service.run_auto_once()
    _done(service)
    assert state["enabled"] is True and state["interval_s"] == 30
    assert {j["episode_id"] for j in service.jobs()} == {"new_mine"}
    assert not (service.dest / "run_a").exists()


def test_auto_uses_existing_worker_and_deduplicates_manual_job(auto_source, monkeypatch):
    service, mine, _, _, _, _ = auto_source
    _episode(mine, "ep")
    entered, release = threading.Event(), threading.Event()

    def transfer(*args, **kwargs):
        entered.set()
        assert release.wait(3)
        return 0

    monkeypatch.setattr(gmo, "_transfer_episode", transfer)
    try:
        assert service.run_auto_once()["queued_in_last_run"] == 1
        assert entered.wait(2)
        with pytest.raises(HTTPException) as error:
            service.enqueue("run_a", "ep")
        assert error.value.status_code == 409
        assert service.run_auto_once()["queued_in_last_run"] == 0
        assert len(service.jobs()) == 1
    finally:
        release.set()
    _done(service)


def test_running_episode_next_cycle_catches_up_in_place(auto_source):
    if shutil.which("rsync") is None:
        pytest.skip("rsync is not installed")
    service, mine, _, log, _, _ = auto_source
    ep = _episode(mine, "recording", running=True)
    assert service.run_auto_once()["queued_in_last_run"] == 1
    _done(service)
    local = service.dest / "run_a" / "recording" / "events.jsonl"
    inode = local.stat().st_ino
    with (ep / "events.jsonl").open("a") as stream:
        stream.write('{"seq":2}\n')
    assert service.episodes("mine", refresh=True)[0]["local_state"] == "stale"
    assert service.run_auto_once()["queued_in_last_run"] == 1
    _done(service)
    assert local.read_bytes() == (ep / "events.jsonl").read_bytes()
    assert local.stat().st_ino == inode
    assert service.episodes("mine", refresh=True)[0]["local_state"] == "local"
    # Two cycles plus the two explicit list refreshes above; no per-job preflight SSH.
    assert log.read_text().splitlines().count("list") == 4


@pytest.mark.parametrize("change_settings", [False, True], ids=["pause", "settings"])
def test_auto_discards_inflight_scan_after_pause_or_settings_change(auto_source, monkeypatch, change_settings):
    service, mine, team, _, _, settings = auto_source
    _episode(mine, "old")
    _episode(team, "new", run="new_run")
    entered, release = threading.Event(), threading.Event()
    original = gmo.list_remote_episodes

    def blocked(*args, **kwargs):
        entered.set()
        assert release.wait(3)
        return original(*args, **kwargs)

    monkeypatch.setattr(gmo, "list_remote_episodes", blocked)
    monkeypatch.setattr(gmo, "_transfer_episode", lambda *args, **kwargs: 0)
    thread = threading.Thread(target=service.run_auto_once)
    thread.start()
    try:
        assert entered.wait(2)
        if change_settings:
            service.update_settings(replace(settings, mine=(str(team),), team=()))
        else:
            service.set_auto_paused(True)
        release.set()
        thread.join(3)
        assert not thread.is_alive()
        assert service.jobs() == []
        assert service.auto_status()["running"] is False
        assert service.auto_status()["last_error"] is None
        if not change_settings:
            service.set_auto_paused(False)
        assert service.run_auto_once()["queued_in_last_run"] == 1
        _done(service)
        assert service.jobs()[0]["episode_id"] == ("new" if change_settings else "old")
    finally:
        release.set()
        thread.join(3)


def test_scheduler_observes_zero_pause_resume_and_changed_interval(auto_source):
    service, _, _, log, _, settings = auto_source
    service.update_settings(replace(settings, interval_s=0))
    service.start_auto()
    time.sleep(0.05)
    assert not log.exists() and service.auto_status()["next_run_at"] is None
    service.update_settings(replace(settings, interval_s=1))
    _until(lambda: service.auto_status()["last_run_at"])
    _until(lambda: not service.auto_status()["running"])
    service.set_auto_paused(True)
    previous = service.auto_status()["last_run_at"]
    time.sleep(1.1)
    assert service.auto_status()["last_run_at"] == previous
    assert service.auto_status()["next_run_at"] is None
    service.set_auto_paused(False)
    _until(lambda: service.auto_status()["last_run_at"] != previous)
    _until(lambda: not service.auto_status()["running"])
    service.update_settings(replace(settings, interval_s=0))
    previous = service.auto_status()["last_run_at"]
    time.sleep(1.1)
    assert service.auto_status()["last_run_at"] == previous
    assert log.read_text().splitlines() == ["list", "list"]


@pytest.mark.parametrize("interval", [10**12, 10**1000])
def test_scheduler_recovers_after_invalid_interval_file(auto_source, interval):
    service, _, _, log, _, settings = auto_source
    # An old or externally written config must not kill the scheduler at startup.
    gmo.config_path().write_text(json.dumps({**settings.as_dict(), "interval_s": interval}))
    service.start_auto()
    assert "interval_s" in _until(lambda: service._auto_last_error)
    assert service._auto_thread.is_alive()
    assert not log.exists()
    gmo.save_settings(replace(settings, interval_s=1))
    _until(lambda: log.exists())
    _until(lambda: not service.auto_status()["running"])
    assert service._auto_thread.is_alive()
    assert service.auto_status()["last_error"] is None


def test_auto_config_rejects_out_of_range_intervals(auto_source):
    service, _, _, _, _, settings = auto_source
    app = create_app(gmo=True, trace_root=service.dest, frontend_dist=service.dest / "no-dist")
    client = TestClient(app, client=("127.0.0.1", 40001), base_url=BASE)
    try:
        for interval in (-1, 10**12, 10**1000, True, 1.5):
            response = client.put("/api/gmo/config", json={**settings.as_dict(), "interval_s": interval}, headers=WRITE)
            assert response.status_code == 400
            assert "interval_s" in response.json()["detail"]
        response = client.put("/api/gmo/config", json={**settings.as_dict(), "interval_s": gmo.MAX_INTERVAL_S}, headers=WRITE)
        assert response.status_code == 200
        state = client.get("/api/gmo/auto", headers=READ).json()
        assert state["enabled"] is True and state["next_run_at"] is not None
        assert gmo.load_settings().interval_s == gmo.MAX_INTERVAL_S
    finally:
        app.state.gmo_service.close()


def test_auto_interval_validation_and_maximum_schedule(auto_source):
    service, _, _, _, _, settings = auto_source
    for interval in (-1, gmo.MAX_INTERVAL_S + 1, 10**12, True, 1.5):
        with pytest.raises(gmo.FetchError, match="interval_s"):
            gmo.GmoSettings.from_dict({**settings.as_dict(), "interval_s": interval})
    for interval in (0, gmo.MAX_INTERVAL_S):
        valid = gmo.GmoSettings.from_dict({**settings.as_dict(), "interval_s": interval})
        service.update_settings(valid)
        state = service.auto_status()
        assert state["enabled"] is (interval > 0)
        if interval:
            next_at = datetime.fromisoformat(state["next_run_at"])
            assert interval - 1 < next_at.timestamp() - time.time() <= interval
        else:
            assert state["next_run_at"] is None


def test_auto_shutdown_interrupts_listing_child(auto_source):
    service, _, _, log, ssh, settings = auto_source
    pid = log.parent / "listing.pid"
    ssh.write_text(f'#!/bin/sh\nexec {sys.executable} -c \'import os,time; open("{pid}","w").write(str(os.getpid())); time.sleep(60)\'\n')
    service.update_settings(replace(settings, interval_s=1))
    service.start_auto()
    _until(pid.exists)
    assert service.auto_status()["running"] is True
    child = int(pid.read_text())
    started = time.monotonic()
    service.close()
    assert time.monotonic() - started < 3
    assert not service.runner._children
    assert service.auto_status()["running"] is False
    with pytest.raises(ProcessLookupError):
        os.kill(child, 0)
    assert service.run_auto_once()["queued_in_last_run"] == 0


def test_auto_api_gate_validation_and_disabled_routes(auto_source):
    service, _, _, _, _, _ = auto_source
    app = create_app(gmo=True, trace_root=service.dest, frontend_dist=service.dest / "no-dist")
    client = TestClient(app, client=("127.0.0.1", 40001), base_url=BASE)
    try:
        assert client.get("/api/gmo/auto").status_code == 403
        state = client.get("/api/gmo/auto", headers=READ).json()
        assert set(state) == {"enabled", "paused", "interval_s", "running", "last_run_at", "next_run_at",
                              "last_error", "queued_in_last_run", "skipped_large"}
        assert state["enabled"] is True and state["paused"] is False
        assert client.put("/api/gmo/auto", json={"paused": True}, headers=READ).status_code == 403
        assert client.put("/api/gmo/auto", content='{"paused":true}', headers=WRITE).status_code == 415
        for bad in ({}, {"paused": 1}, {"paused": "false"}, {"paused": True, "extra": 1}, []):
            assert client.put("/api/gmo/auto", json=bad, headers=WRITE).status_code == 400
        assert client.put("/api/gmo/auto", json={"paused": True}, headers=WRITE).json()["paused"] is True
        assert client.put("/api/gmo/auto", json={"paused": False}, headers=WRITE).json()["paused"] is False
    finally:
        app.state.gmo_service.close()
    disabled = TestClient(create_app(trace_root=service.dest), client=("127.0.0.1", 40001), base_url=BASE)
    assert disabled.get("/api/gmo/auto", headers=READ).status_code == 404
    assert disabled.put("/api/gmo/auto", json={"paused": True}, headers=WRITE).status_code == 404
