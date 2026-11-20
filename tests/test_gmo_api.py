"""GMO API with a local directory and a fake ssh transport; no network access."""
from __future__ import annotations

import os
import pwd
import shutil
import stat
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest
from fastapi import HTTPException, Request
from fastapi.testclient import TestClient

from capx_trace_viewer import gmo, reader
from capx_trace_viewer.gmo_api import GmoService, create_gmo_router
from capx_trace_viewer.server import create_app

LOCAL = ("127.0.0.1", 40001)
BASE = "http://127.0.0.1:8290"
WRITE = {"Origin": BASE, "X-CapX-Request": "gmo"}
READ = {"X-CapX-Request": "gmo"}


def _episode(root: Path, run: str, episode: str, *, seed: int = 1) -> Path:
    path = root / run / episode
    path.mkdir(parents=True)
    (path.parent / "run.json").write_text('{"name":"test"}\n')
    (path / "episode.json").write_text(
        '{"status":"ended","trace_complete":true,"task":"task_a","seed":%d,"result":"ok"}\n' % seed
    )
    (path / "events.jsonl").write_text('{"seq":1}\n')
    (path / "heartbeat").write_text("")
    return path


def _wait_job(client: TestClient, job_id: str) -> dict:
    for _ in range(200):
        job = next(j for j in client.get("/api/gmo/jobs").json() if j["job_id"] == job_id)
        if job["state"] in ("done", "failed"):
            return job
        time.sleep(0.02)
    pytest.fail("GMO job did not finish")


@pytest.fixture
def remote(tmp_path: Path, monkeypatch):
    fake_ssh = tmp_path / "fake_ssh"
    fake_ssh.write_text('#!/bin/sh\nshift\nexec sh -c "$*"\n')
    fake_ssh.chmod(fake_ssh.stat().st_mode | stat.S_IXUSR)
    if shutil.which("rsync") is None:
        pytest.skip("rsync is not installed")
    probe = tmp_path / "probe"
    probe.mkdir()
    (probe / "file").write_text("x")
    command = ["rsync", "-rt", "--inplace", "--partial", "-e", str(fake_ssh),
               f"fakehost:{probe}/", f"{tmp_path / 'probe_dest'}/"]
    probe_result = subprocess.run(command, capture_output=True, text=True)
    if probe_result.returncode != 0:
        version = subprocess.run(["rsync", "--version"], capture_output=True, text=True)
        pytest.skip(f"rsync local fake ssh failed; version: {version.stdout.strip() or version.stderr.strip()}; "
                    f"stderr: {probe_result.stderr.strip()}")
    mine = tmp_path / "gmo" / "mine" / "traces"
    team = tmp_path / "gmo" / "team" / "traces"
    ep = _episode(mine, "run_a", "ep_1")
    (ep / "video.mp4").write_bytes(b"x" * 256)
    (ep / "link").symlink_to(tmp_path / "missing")
    _episode(team, "run_b", "ep_2", seed=2)
    monkeypatch.setenv("CAPX_GMO_CONFIG", str(tmp_path / "config" / "gmo.json"))
    monkeypatch.setenv("CAPX_GMO_SSH_COMMAND", str(fake_ssh))
    monkeypatch.delenv("CAPX_GMO_HOST", raising=False)
    monkeypatch.delenv("CAPX_GMO_TRACES", raising=False)
    return {"mine": mine, "team": team, "dest": tmp_path / "dest", "config": gmo.config_path(),
            "ssh": fake_ssh}


@pytest.fixture
def client(remote):
    app = create_app(gmo=True, trace_root=remote["dest"], frontend_dist=remote["dest"] / "no-dist")
    value = TestClient(app, client=LOCAL, base_url=BASE, headers=READ)
    try:
        yield value
    finally:
        app.state.gmo_service.close()


def _configure(client: TestClient, remote: dict, **overrides):
    payload = {"host": "fakehost", "mine": [str(remote["mine"])],
               "team": [str(remote["team"])], "interval_s": 120, "shared_root": ""}
    payload.update(overrides)
    return client.put("/api/gmo/config", json=payload, headers=WRITE)


def _episodes(client, scope="all"):
    """Pages poll the nonblocking endpoint until its first refresh completes."""
    rows = client.get("/api/gmo/episodes", params={"scope": scope}).json()
    for _ in range(200):
        if not client.get("/api/gmo/listing-status").json()["refreshing"]:
            return client.get("/api/gmo/episodes", params={"scope": scope}).json()
        time.sleep(0.01)
    pytest.fail("GMO listing did not finish")


def test_config_validation_permissions_and_defaults(client, remote):
    initial = client.get("/api/gmo/config").json()
    assert initial["enabled"] is True and initial["configured"] is True
    assert initial["settings"] == gmo.GmoSettings().as_dict()
    assert initial["dest"] == str(remote["dest"])
    assert initial["config_path"] == str(remote["config"])
    for host in ("-oProxyCommand=evil", "some host", "host;cmd", "host\nother", "a:b", "user@host:22"):
        assert _configure(client, remote, host=host).status_code == 400
    for bad in ("/data;cmd", "/with space", ""):
        assert _configure(client, remote, mine=[bad]).status_code == 400
    for port in (0, 65536, "22", True):
        assert _configure(client, remote, port=port).status_code == 400
    assert _configure(client, remote, ssh="ssh -o ProxyCommand=evil").status_code == 400
    saved = _configure(client, remote, port=8822, identity_file="~/.ssh/KEY", interval_s=0)
    assert saved.status_code == 200
    assert saved.json()["settings"]["port"] == 8822
    assert stat.S_IMODE(remote["config"].stat().st_mode) == 0o600
    assert stat.S_IMODE(remote["config"].parent.stat().st_mode) == 0o700
    assert gmo.load_settings().interval_s == 0


def test_environment_fallback_and_ssh_argv(tmp_path, monkeypatch):
    monkeypatch.setenv("CAPX_GMO_CONFIG", str(tmp_path / "missing.json"))
    monkeypatch.setenv("CAPX_GMO_HOST", "alias")
    monkeypatch.setenv("CAPX_GMO_TRACES", "/a/traces:/b/traces")
    settings = gmo.load_settings()
    assert settings.mine == ("/a/traces", "/b/traces")
    monkeypatch.delenv("CAPX_GMO_SSH_COMMAND", raising=False)
    settings = gmo.GmoSettings.from_dict({"host": "user@host", "port": 8822,
                                           "identity_file": "~/.ssh/KEY", "mine": ["/a/traces"]})
    multiplex = [] if sys.platform == "win32" else [
        "-o", "ControlMaster=auto", "-o", "ControlPersist=30", "-o", f"ControlPath=/tmp/capx-gmo-ssh-{os.getuid()}/%C"]
    assert gmo.api_ssh_argv(settings) == ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", *multiplex,
                                           "-p", "8822", "-i", str(Path.home() / ".ssh/KEY"),
                                           "-o", "IdentitiesOnly=yes"]


def test_config_paths_and_process_timeout(tmp_path, monkeypatch):
    monkeypatch.delenv("CAPX_GMO_CONFIG", raising=False)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
    if sys.platform == "darwin":
        monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
        base = tmp_path / "Library" / "Application Support"
    else:
        base = tmp_path / "xdg"
    assert gmo.config_path() == base / "capx-geniac-replay" / "gmo.json"
    runner = gmo.ProcessRunner()
    start = time.monotonic()
    with pytest.raises(gmo.FetchError, match="timed out"):
        runner.run([sys.executable, "-c", "import time; time.sleep(5)"], timeout=0.05)
    assert time.monotonic() - start < 2
    assert not runner._children
    runner.close()


def test_listing_scope_owner_metadata_and_cache(client, remote):
    assert _configure(client, remote).status_code == 200
    checked = client.post("/api/gmo/check", json={}, headers=WRITE).json()
    assert checked == {"ok": True, "mine_episodes": 1, "team_episodes": 1, "error": None}
    assert not remote["dest"].exists()
    rows = _episodes(client)
    assert [(r["run_id"], r["mine"], r["local_state"]) for r in rows] == [
        ("run_a", True, "remote"), ("run_b", False, "remote")]
    row = rows[0]
    assert row["owner"] == pwd.getpwuid(os.getuid()).pw_name
    assert row["status"] == "ended" and row["trace_complete"] is True
    assert row["task"] == "task_a" and row["seed"] == 1
    assert row["episode"]["result"] == "ok"
    assert row["size_bytes"] == sum(p.stat().st_size for p in (remote["mine"] / "run_a" / "ep_1").iterdir()
                                    if p.is_file() and not p.is_symlink())
    assert [r["run_id"] for r in _episodes(client, "team")] == ["run_b"]
    assert [r["run_id"] for r in _episodes(client, "mine")] == ["run_a"]
    _episode(remote["mine"], "run_c", "ep_3")
    assert len(_episodes(client)) == 2
    assert len(client.get("/api/gmo/episodes?refresh=1").json()) in (2, 3)
    assert len(_episodes(client)) == 3


def test_overlapping_scopes_choose_mine_once(client, remote):
    assert _configure(client, remote, team=[str(remote["mine"]), str(remote["team"])]).status_code == 200
    rows = _episodes(client)
    assert [(r["run_id"], r["mine"], r["conflict"]) for r in rows] == [
        ("run_a", True, False), ("run_b", False, False)]


def test_shared_root_config_listing_adds_patterns_and_uses_directory_owner(client, remote):
    shared = remote["config"].parent.parent / "shared"
    _episode(shared / "trace_user", "shared_own", "ep_own")
    _episode(shared / "team_user", "shared_team", "ep_team")
    response = _configure(client, remote, host="trace_user@fakehost", shared_root=str(shared),
                          mine=[str(remote["mine"]), str(shared / "team_user")],
                          team=[str(remote["team"]), str(shared / "*")])
    assert response.status_code == 200 and response.json()["configured"] is True
    assert response.json()["settings"]["shared_root"] == str(shared)
    assert client.get("/api/gmo/config").json()["settings"]["shared_root"] == str(shared)
    checked = client.post("/api/gmo/check", json={}, headers=WRITE).json()
    assert checked == {"ok": True, "mine_episodes": 3, "team_episodes": 1, "error": None}
    rows = {row["run_id"]: row for row in _episodes(client)}
    assert len(rows) == 4
    assert rows["shared_own"]["mine"] is True and rows["shared_own"]["owner"] == "trace_user"
    # An explicit mine pattern wins the shared team scope, retaining folder ownership.
    assert rows["shared_team"]["mine"] is True and rows["shared_team"]["owner"] == "team_user"
    assert rows["run_a"]["mine"] is True and rows["run_b"]["mine"] is False
    assert rows["run_a"]["owner"] == pwd.getpwuid(os.getuid()).pw_name
    assert not any(row["conflict"] for row in rows.values())


@pytest.mark.parametrize("shared_root", [
    None, "relative", "/path/../traces", "/path/*", "/path\ntraces",
    "~", "~other/traces", "~/../traces", "~/path/*", "~/with space", "~/path\x00traces",
])
def test_shared_root_api_rejects_invalid_input(client, remote, shared_root):
    response = _configure(client, remote, shared_root=shared_root)
    assert response.status_code == 400 and "shared_root" in response.json()["detail"]


def test_check_connection_failure_reports_actionable_error(client, monkeypatch):
    def failed(command, *, timeout):
        return subprocess.CompletedProcess(command, 255, "", "unresolvable alias")
    monkeypatch.setattr(client.app.state.gmo_service.runner, "run", failed)
    response = client.post("/api/gmo/check", json={}, headers=WRITE)
    assert response.status_code == 200
    assert response.json()["ok"] is False
    assert "Host gmo" in response.json()["error"] and "接続設定" in response.json()["error"]


def test_local_state_and_symlinks(client, remote):
    assert _configure(client, remote).status_code == 200
    remote_ep = remote["mine"] / "run_a" / "ep_1"
    local_ep = remote["dest"] / "run_a" / "ep_1"
    local_ep.mkdir(parents=True)
    (local_ep / "events.jsonl").write_text("partial")
    assert next(r for r in _episodes(client) if r["run_id"] == "run_a")["local_state"] == "stale"
    shutil.rmtree(local_ep)
    shutil.copytree(remote_ep, local_ep, symlinks=True)
    assert next(r for r in _episodes(client) if r["run_id"] == "run_a")["local_state"] == "local"
    assert (local_ep / "link").is_symlink()


def test_large_episode_json_and_conflict(client, remote):
    assert _configure(client, remote).status_code == 200
    big = _episode(remote["mine"], "run_big", "ep_big")
    (big / "episode.json").write_bytes(b"{" + b" " * (gmo.MAX_METADATA_BYTES + 1) + b"}")
    (big.parent / "run.json").write_bytes(b"{" + b" " * (gmo.MAX_METADATA_BYTES + 1) + b"}")
    duplicate = _episode(remote["team"], "run_a", "ep_other")
    client.get("/api/gmo/episodes?refresh=1")
    rows = _episodes(client)
    huge = next(r for r in rows if r["run_id"] == "run_big")
    assert huge["episode"] is None and huge["episode_json_error"] == "too_large"
    raw = gmo.list_remote_episodes(client.app.state.gmo_service.runner, gmo.load_settings())["episodes"]
    assert next(r for r in raw if r["run_id"] == "run_big")["run_json_error"] == "too_large"
    assert sum(r["conflict"] for r in rows if r["run_id"] == "run_a") == 2
    assert client.post("/api/gmo/fetch", json={"run_id": "run_a", "episode_id": "ep_1"}, headers=WRITE).status_code == 409
    assert duplicate.is_dir()


def test_fetch_done_second_time_zero_and_only_episode(client, remote):
    assert _configure(client, remote).status_code == 200
    _episode(remote["mine"], "run_a", "ep_other")
    assert client.get("/api/gmo/episodes?refresh=1").status_code == 200
    request = {"run_id": "run_a", "episode_id": "ep_1"}
    first = client.post("/api/gmo/fetch", json=request, headers=WRITE)
    assert first.status_code == 200
    job = _wait_job(client, first.json()["job_id"])
    assert job["state"] == "done" and job["bytes"] > 0 and job["error"] is None
    assert job["started_at"] and job["finished_at"]
    local = remote["dest"] / "run_a"
    assert (local / "run.json").is_file() and (local / "ep_1" / "video.mp4").stat().st_size == 256
    assert not (local / "ep_1" / "link").exists()
    assert not (local / "ep_other").exists()
    second = client.post("/api/gmo/fetch", json=request, headers=WRITE)
    assert _wait_job(client, second.json()["job_id"])["bytes"] == 0
    state = next(r for r in _episodes(client) if r["episode_id"] == "ep_1")
    assert state["local_state"] == "local"
    raw = next(row for row in client.app.state.gmo_service.remote_rows() if row["episode_id"] == "ep_1")
    expected = reader.episode_summary("run_a", remote["mine"] / "run_a" / "ep_1", now=raw["remote_now"])
    actual = {key: value for key, value in state.items()
              if key not in {"owner", "mine", "size_bytes", "local_state", "conflict"}}
    assert actual == expected


def test_fetch_limit_fails_before_copy(client, remote):
    assert _configure(client, remote).status_code == 200
    client.app.state.gmo_service.max_fetch_bytes = 1
    response = client.post("/api/gmo/fetch", json={"run_id": "run_a", "episode_id": "ep_1"}, headers=WRITE)
    job = _wait_job(client, response.json()["job_id"])
    assert job["state"] == "failed" and "exceeds" in job["error"]
    assert not (remote["dest"] / "run_a").exists()


def test_fetch_running_episode_finishes_when_events_and_heartbeat_change(remote, monkeypatch):
    episode = remote["mine"] / "run_a" / "ep_1"
    (episode / "episode.json").write_text('{"status":"started"}\n')
    events = episode / "events.jsonl"
    before = events.read_bytes()
    appended = b'{"seq":2}\n'
    heartbeat_mtime = int((episode / "heartbeat").stat().st_mtime) + 10
    service = GmoService(remote["dest"])
    service.update_settings(gmo.GmoSettings(host="fakehost", mine=(str(remote["mine"]),)))
    original = service.runner.run

    def recording_during_transfer(command, *, timeout):
        if command[0] == "rsync":
            # The file manifest is already captured; the recorder keeps running
            # while rsync is about to start its single SSH connection.
            with events.open("ab") as stream:
                stream.write(appended)
            os.utime(episode / "heartbeat", (heartbeat_mtime, heartbeat_mtime))
        return original(command, timeout=timeout)

    monkeypatch.setattr(service.runner, "run", recording_during_transfer)
    try:
        row, = service.episodes("mine")
        assert row["status"] == "running"
        job_id = service.enqueue("run_a", "ep_1")
        for _ in range(200):
            job = next(job for job in service.jobs() if job["job_id"] == job_id)
            if job["state"] in ("done", "failed") and job["finished_at"] is not None:
                break
            time.sleep(0.02)
        else:
            pytest.fail("GMO job did not finish")
        assert job["state"] == "done" and job["error"] is None
        assert job["note"] == "remote changed during transfer"
        local = remote["dest"] / "run_a" / "ep_1"
        assert (local / "events.jsonl").read_bytes() == before + appended
        assert int((local / "heartbeat").stat().st_mtime) == heartbeat_mtime
        assert job["bytes"] == sum(path.stat().st_size for path in local.parent.rglob("*")
                                   if path.is_file())
        assert service.episodes("mine")[0]["local_state"] == "stale"
        assert service.episodes("mine", refresh=True)[0]["local_state"] == "local"
    finally:
        service.close()


def test_duplicate_active_job_and_fetching_state(client, remote, monkeypatch):
    assert _configure(client, remote).status_code == 200
    entered = threading.Event()
    release = threading.Event()

    def blocked(*args, **kwargs):
        entered.set()
        release.wait(timeout=3)
        return 0

    monkeypatch.setattr(gmo, "fetch_episode", blocked)
    req = {"run_id": "run_a", "episode_id": "ep_1"}
    first = client.post("/api/gmo/fetch", json=req, headers=WRITE)
    try:
        assert entered.wait(timeout=2)
        assert client.post("/api/gmo/fetch", json=req, headers=WRITE).status_code == 409
        row = next(r for r in _episodes(client) if r["run_id"] == "run_a")
        assert row["local_state"] == "fetching"
    finally:
        release.set()
    assert _wait_job(client, first.json()["job_id"])["state"] == "done"


def test_loopback_csrf_and_disabled_routes(remote):
    app = create_app(gmo=True, trace_root=remote["dest"], frontend_dist=remote["dest"] / "no-dist")
    client = TestClient(app, client=LOCAL, base_url=BASE)
    assert client.get("/api/gmo/config", headers={**READ, "Host": "external.example"}).status_code == 403
    assert client.get("/api/gmo/config", headers={**READ, "Origin": "https://external.example"}).status_code == 403
    for path in ("/api/gmo/config", "/api/gmo/episodes?refresh=1", "/api/gmo/jobs"):
        assert client.get(path).status_code == 403
        assert client.get(path, headers={"X-CapX-Request": "wrong"}).status_code == 403
    assert client.put("/api/gmo/config", json={}, headers={"Origin": BASE}).status_code == 403
    assert client.put("/api/gmo/config", json={}, headers={"X-CapX-Request": "gmo"}).status_code == 403
    assert client.put("/api/gmo/config", content="{}", headers=WRITE).status_code == 415
    assert client.post("/api/gmo/check", content="{}", headers=WRITE).status_code == 415
    assert client.post("/api/gmo/check", json={}, headers={**WRITE, "Origin": "null"}).status_code == 403
    assert client.post("/api/gmo/fetch", json={}, headers={**WRITE, "Origin": "https://external.example"}).status_code == 403
    client = TestClient(app, client=("192.0.2.1", 40000), base_url=BASE)
    assert client.get("/api/gmo/config").status_code == 403
    app.state.gmo_service.close()
    disabled = create_app(trace_root=remote["dest"], frontend_dist=remote["dest"] / "no-dist")
    client = TestClient(disabled, client=LOCAL, base_url=BASE)
    for path in ("/api/gmo/config", "/api/gmo/episodes", "/api/gmo/jobs", "/api/gmo/fetch"):
        assert client.get(path).status_code == 404


def test_shutdown_closes_process_runner(remote):
    app = create_app(gmo=True, trace_root=remote["dest"], frontend_dist=remote["dest"] / "no-dist")
    with TestClient(app, client=LOCAL, base_url=BASE) as client:
        assert client.get("/api/gmo/config", headers=READ).status_code == 200
    assert app.state.gmo_service.runner._closed


def test_prefetch_only_mine_and_explicitly_disabled_config(remote, capsys):
    gmo.save_settings(gmo.GmoSettings(shared_root=""))
    assert gmo.prefetch_mine(remote["dest"]) == 0
    assert "missing" in capsys.readouterr().err
    assert not remote["dest"].exists()
    gmo.save_settings(gmo.GmoSettings.from_dict({"host": "fakehost", "mine": [str(remote["mine"])],
                                                "team": [str(remote["team"])]}))
    assert gmo.prefetch_mine(remote["dest"]) == 0
    assert (remote["dest"] / "run_a" / "ep_1" / "events.jsonl").is_file()
    assert not (remote["dest"] / "run_b").exists()


@pytest.mark.parametrize("method", ["GET", "PUT", "POST", "PATCH", "DELETE", "OPTIONS"])
def test_gate_requires_custom_header_for_every_method(tmp_path, method):
    service = GmoService(tmp_path)
    gate = create_gmo_router(service).dependencies[0].dependency
    scope = {"type": "http", "method": method, "path": "/api/gmo/episodes",
             "query_string": b"refresh=1", "client": LOCAL,
             "headers": [(b"host", b"127.0.0.1:8290"), (b"origin", BASE.encode()),
                         (b"content-type", b"application/json")]}
    try:
        with pytest.raises(HTTPException) as error:
            gate(Request(scope))
        assert error.value.status_code == 403
        assert "X-CapX-Request" in error.value.detail
        scope["headers"].append((b"x-capx-request", b"gmo"))
        gate(Request(scope))
    finally:
        service.close()


def test_settings_change_discards_inflight_listing(tmp_path, monkeypatch):
    monkeypatch.setenv("CAPX_GMO_CONFIG", str(tmp_path / "config" / "gmo.json"))
    old = gmo.GmoSettings(host="old", mine=("/old/traces",))
    new = gmo.GmoSettings(host="new", mine=("/new/traces",))
    service = GmoService(tmp_path / "dest")
    service.update_settings(old)
    entered, release = threading.Event(), threading.Event()
    calls, errors = [], []

    def listing(runner, settings):
        calls.append(settings)
        if settings == old:
            entered.set()
            assert release.wait(timeout=3)
        return {"episodes": [{"path": "/" + settings.host}], "evals": []}

    def refresh():
        try:
            service.remote_rows(refresh=True)
        except gmo.FetchError as exc:
            errors.append(str(exc))

    monkeypatch.setattr(gmo, "list_remote_episodes", listing)
    thread = threading.Thread(target=refresh)
    thread.start()
    try:
        assert entered.wait(timeout=2)
        service.update_settings(new)
        release.set()
        thread.join(timeout=3)
        assert not thread.is_alive()
        assert errors and "settings changed" in errors[0]
        assert service._cache is None
        assert service.remote_rows() == [{"path": "/new"}]
        assert calls == [old, new]
    finally:
        release.set()
        thread.join(timeout=3)
        service.close()


def test_enqueue_rejects_settings_changed_after_snapshot(tmp_path, monkeypatch):
    monkeypatch.setenv("CAPX_GMO_CONFIG", str(tmp_path / "config" / "gmo.json"))
    old = gmo.GmoSettings(host="old", mine=("/old/traces",))
    new = gmo.GmoSettings(host="new", mine=("/new/traces",))
    service = GmoService(tmp_path / "dest")
    service.update_settings(old)
    row = {"run_id": "run", "episode_id": "ep", "path": "/old/run", "conflict": False}
    monkeypatch.setattr(gmo, "list_remote_episodes", lambda *_, **kwargs: {"episodes": [row], "evals": []})
    snapshot = service._remote_snapshot

    def changed_snapshot(**kwargs):
        result = snapshot(**kwargs)
        service.update_settings(new)
        return result

    monkeypatch.setattr(service, "_remote_snapshot", changed_snapshot)
    try:
        with pytest.raises(gmo.FetchError, match="settings changed"):
            service.enqueue("run", "ep")
        assert service.jobs() == [] and service._queue.empty()
    finally:
        service.close()


def test_cached_listing_retains_its_settings_for_queued_fetch(tmp_path, monkeypatch):
    monkeypatch.setenv("CAPX_GMO_CONFIG", str(tmp_path / "config" / "gmo.json"))
    old = gmo.GmoSettings(host="old", mine=("/old/traces",))
    new = gmo.GmoSettings(host="new", mine=("/new/traces",))
    row = {"run_id": "run", "episode_id": "ep", "path": "/old/run", "conflict": False}
    service = GmoService(tmp_path / "dest")
    service.update_settings(old)
    monkeypatch.setattr(gmo, "list_remote_episodes", lambda *_, **kwargs: {"episodes": [row], "evals": []})
    captured = []
    entered, release = threading.Event(), threading.Event()

    def fetch(runner, settings, selected, dest, **kwargs):
        entered.set()
        assert release.wait(timeout=3)
        captured.append((settings, selected))
        return 0

    monkeypatch.setattr(gmo, "fetch_episode", fetch)
    try:
        assert service.remote_rows() == [row]
        service.enqueue("run", "ep")
        assert entered.wait(timeout=2)
        service.update_settings(new)
        release.set()
        service._queue.join()
        assert captured == [(old, row)]
    finally:
        release.set()
        service.close()


@pytest.mark.parametrize("path,payload,method_name", [
    ("/api/gmo/fetch", {"run_id": "run", "episode_id": "ep"}, "enqueue"),
    ("/api/gmo/check", {}, "remote_rows"),
])
def test_slow_gmo_request_keeps_viewing_event_loop_available(tmp_path, monkeypatch, path, payload, method_name):
    app = create_app(gmo=True, trace_root=tmp_path, frontend_dist=tmp_path / "no-dist")
    service = app.state.gmo_service
    entered, release = threading.Event(), threading.Event()

    def slow(*args, **kwargs):
        entered.set()
        assert release.wait(timeout=3)
        return "job" if method_name == "enqueue" else []

    monkeypatch.setattr(service, method_name, slow)
    result = []
    try:
        with TestClient(app, client=LOCAL, base_url=BASE) as value:
            thread = threading.Thread(target=lambda: result.append(value.post(path, json=payload, headers=WRITE)))
            thread.start()
            try:
                assert entered.wait(timeout=2)
                start = time.monotonic()
                response = value.get("/api/traces/config", headers={"Host": "127.0.0.1:8290", "Origin": BASE})
                assert response.status_code == 200
                assert response.json()["trace_root"] == str(tmp_path.resolve())
                assert time.monotonic() - start < 1
            finally:
                release.set()
                thread.join(timeout=4)
            assert result and result[0].status_code == 200
    finally:
        release.set()
        service.close()
