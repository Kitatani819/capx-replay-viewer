"""Live imports over the same local fake SSH and real rsync as manual imports."""
from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
import time
from dataclasses import replace

import pytest
from fastapi import HTTPException, Request

from capx_trace_viewer import gmo, gmo_api
from capx_trace_viewer.gmo_api import GmoService, create_gmo_router
from test_gmo_api import BASE, LOCAL, _episode, remote  # noqa: F401 (shared fake transport fixture)


def _until(predicate, timeout=4):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.01)
    pytest.fail("live follower did not reach expected state")


@pytest.fixture
def source(remote):
    episode = remote["mine"] / "run_a" / "ep_1"
    (episode / "episode.json").write_text('{"status":"running"}\n')
    (episode / "events.jsonl").write_text('{"seq":1,"event_type":"episode_start"}\n')
    service = GmoService(remote["dest"])
    service.update_settings(gmo.GmoSettings(host="fakehost", mine=(str(remote["mine"]),),
                                           team=(str(remote["team"]),), shared_root="", interval_s=0))
    try:
        yield service, episode, remote
    finally:
        service.close()


@pytest.fixture
def manual(source, monkeypatch):
    service, episode, remote = source
    # Exercise each complete cycle deterministically without waiting two seconds.
    monkeypatch.setattr(service, "_live_loop", lambda: None)
    service.follow("run_a", "ep_1")
    return service, episode, remote


def _cycle(service):
    service._run_live_cycle(service._live)
    return service.live_status()


def test_start_renew_replace_and_changed_files(manual, monkeypatch):
    service, episode, remote = manual
    assert set(service.live_status()) == {
        "following", "run_id", "episode_id", "last_ok_at", "last_error", "interval_s", "copied_bytes", "stopped_reason", "lease_token"}
    live = service._live
    first = _cycle(service)
    local_events = service.dest / "run_a" / "ep_1" / "events.jsonl"
    inode = local_events.stat().st_ino
    assert first["following"] and first["copied_bytes"] > 0 and first["last_ok_at"]
    assert _cycle(service)["copied_bytes"] == first["copied_bytes"]
    with (episode / "events.jsonl").open("a") as stream:
        stream.write('{"seq":2,"event_type":"stdout","data":{"text":"new output"}}\n')
    (episode / "frames" / "front").mkdir(parents=True)
    (episode / "frames" / "front" / "e0_1.jpg").write_bytes(b"new frame")
    assert _cycle(service)["copied_bytes"] > first["copied_bytes"]
    assert local_events.stat().st_ino == inode
    assert local_events.read_bytes() == (episode / "events.jsonl").read_bytes()
    assert (local_events.parent / "frames" / "front" / "e0_1.jpg").read_bytes() == b"new frame"
    before = live["lease_until"]
    original = service._episode_row
    monkeypatch.setattr(service, "_episode_row", lambda *_: pytest.fail("renewal must not list all episodes"))
    renewed = service.follow("run_a", "ep_1")
    assert renewed["copied_bytes"] == service.live_status()["copied_bytes"]
    assert live["lease_until"] >= before and service._live is live
    monkeypatch.setattr(service, "_episode_row", original)
    _episode(remote["mine"], "other", "next")
    service.invalidate()
    replaced = service.follow("other", "next")
    assert replaced["run_id"] == "other" and replaced["episode_id"] == "next"
    assert replaced["copied_bytes"] == 0 and live["runner"]._closed
    assert not (service.dest / "other").exists()


def test_episode_end_requires_copied_event_and_final_quiet_cycle(manual):
    service, episode, _ = manual
    _cycle(service)
    (episode / "episode.json").write_text('{"status":"ended","trace_complete":true}\n')
    _cycle(service)
    assert _cycle(service)["following"]  # metadata alone is not episode_end
    with (episode / "events.jsonl").open("a") as stream:
        stream.write('{"seq":2,"event_type":"episode_end"}\n')
    assert _cycle(service)["following"]
    with (episode / "events.jsonl").open("a") as stream:
        stream.write('{"seq":3,"event_type":"stdout","data":{"text":"late"}}\n')
    assert _cycle(service)["following"]
    state = _cycle(service)
    assert not state["following"] and state["stopped_reason"] == "episode_ended"
    # An in-flight renewal from a page still showing its previous summary does
    # not resurrect a follower that already completed its final quiet cycle.
    assert service.follow("run_a", "ep_1") == state


def test_real_shaped_episode_end_stops_following_and_cannot_be_renewed(manual, monkeypatch):
    service, episode, _ = manual
    live = service._live
    # Match the recorder's EventSink.emit envelope, including event_type rather
    # than the unrelated ASGI request field named type.
    events = [
        {
            "schema_version": "capx-trace/1", "run_id": "run_a", "episode_id": "ep_1",
            "event_id": f"ev_{seq:020d}", "parent_event_id": None, "seq": seq,
            "wall_time": 1_700_000_000.0 + seq, "monotonic_time": float(seq),
            "pid": 1234, "thread": "MainThread", "sim_step": seq - 1,
            "sim_time": (seq - 1) * 0.02, "sim_epoch": 0, "event_type": event_type,
            "status": "ok", "late": False, "refs": {}, "artifacts": [], "data": data,
        }
        for seq, event_type, data in (
            (1, "episode_start", {}),
            (2, "episode_end", {"end_reason": "completed", "trace_complete": True}),
        )
    ]
    (episode / "events.jsonl").write_text("".join(json.dumps(event) + "\n" for event in events))
    (episode / "episode.json").write_text(
        '{"status":"ended","trace_complete":true,"video_copy_pending":false}\n')

    assert _cycle(service)["following"]  # Copy the final event before the quiet cycle.
    local_events = service.dest / "run_a" / "ep_1" / "events.jsonl"
    assert [json.loads(line) for line in local_events.read_text().splitlines()] == events
    state = _cycle(service)
    assert state["following"] is False
    assert state["stopped_reason"] == "episode_ended"
    assert state["last_error"] is None
    assert service._live is None and live["runner"]._closed

    # Stale page renewals and an already queued cycle cannot restart SSH copies.
    monkeypatch.setattr(service, "_episode_row", lambda *_: pytest.fail("ended trial was listed again"))
    monkeypatch.setattr(gmo, "fetch_episode", lambda *_args, **_kwargs: pytest.fail("ended trial was copied again"))
    for _ in range(3):
        assert service.follow("run_a", "ep_1") == state
        service._run_live_cycle(live)
        assert service.live_status() == state and service._live is None


def test_pending_mp4_keeps_following_until_video_is_copied(manual):
    service, episode, _ = manual
    with (episode / "events.jsonl").open("a") as stream:
        stream.write('{"seq":2,"event_type":"episode_end"}\n')
    (episode / "episode.json").write_text('{"status":"ended","video_copy_pending":true}\n')
    assert _cycle(service)["following"] and _cycle(service)["following"]
    (episode / "videos").mkdir()
    (episode / "videos" / "front.mp4").write_bytes(b"video")
    (episode / "episode.json").write_text('{"status":"ended","video_copy_pending":false}\n')
    assert _cycle(service)["following"]
    assert (service.dest / "run_a" / "ep_1" / "videos" / "front.mp4").read_bytes() == b"video"
    assert _cycle(service)["stopped_reason"] == "episode_ended"


def test_empty_changed_heartbeat_is_not_a_quiet_final_cycle(manual):
    service, episode, _ = manual
    with (episode / "events.jsonl").open("a") as stream:
        stream.write('{"seq":2,"event_type":"episode_end"}\n')
    _cycle(service)
    heartbeat = episode / "heartbeat"
    mtime = int(heartbeat.stat().st_mtime) + 5
    os.utime(heartbeat, (mtime, mtime))
    assert _cycle(service)["following"]
    assert _cycle(service)["stopped_reason"] == "episode_ended"


def test_backoff_caps_and_recovers(manual, monkeypatch):
    service, _, _ = manual
    original = gmo.fetch_episode

    def fail(*args, **kwargs):
        raise gmo.FetchError("fake ssh unavailable")

    monkeypatch.setattr(gmo, "fetch_episode", fail)
    for interval in (4, 8, 16, 30, 30):
        state = _cycle(service)
        assert state["following"] and state["last_error"] == "fake ssh unavailable"
        assert state["interval_s"] == interval and state["last_ok_at"] is None
        assert interval - 0.1 < service._live["next"] - time.monotonic() <= interval
    monkeypatch.setattr(gmo, "fetch_episode", original)
    state = _cycle(service)
    assert state["interval_s"] == 2 and state["last_error"] is None and state["last_ok_at"]


def test_same_manifest_size_limit_and_local_link_protection(manual):
    service, episode, _ = manual
    service.max_fetch_bytes = 1
    state = _cycle(service)
    assert "transfer limit" in state["last_error"] and not service.dest.exists()
    service.max_fetch_bytes = gmo.MAX_FETCH_BYTES
    _cycle(service)
    local_events = service.dest / "run_a" / "ep_1" / "events.jsonl"
    local_events.unlink()
    local_events.symlink_to(episode / "events.jsonl")
    assert "symlink" in _cycle(service)["last_error"]


def test_lease_renewal_and_expiry(source, monkeypatch):
    service, _, _ = source
    monkeypatch.setattr(gmo_api, "LIVE_LEASE_S", 0.4)
    service.follow("run_a", "ep_1")
    _until(lambda: service.live_status()["last_ok_at"])
    live = service._live
    with service._lock:
        live["lease_until"] = time.monotonic() - 1
    service.follow("run_a", "ep_1")
    assert service._live is live and live["lease_until"] > time.monotonic()
    _until(lambda: not service.live_status()["following"])
    assert service.live_status()["stopped_reason"] == "lease_expired"
    assert live["runner"]._closed


@pytest.mark.parametrize("external", [False, True], ids=["api", "config-file"])
def test_settings_change_stops_follower(source, external):
    service, _, _ = source
    service.follow("run_a", "ep_1")
    live = service._live
    new = replace(gmo.load_settings(), host="other")
    if external:
        gmo.save_settings(new)
    else:
        service.update_settings(new)
    _until(lambda: not service.live_status()["following"])
    assert service.live_status()["stopped_reason"] == "settings_changed"
    _until(lambda: live["runner"]._closed)


@pytest.mark.parametrize("reason", ["lease_expired", "settings_changed", "shutdown", "replaced"])
def test_stop_interrupts_inflight_ssh_child(source, monkeypatch, reason):
    service, _, remote = source
    monkeypatch.setattr(gmo_api, "LIVE_LEASE_S", 0.4 if reason == "lease_expired" else 30)
    service.remote_rows()  # cache the shared row lookup before blocking SSH
    child_pid = remote["ssh"].parent / "live.pid"
    remote["ssh"].write_text(
        f'#!/bin/sh\nexec {sys.executable} -c \'import os,time; open("{child_pid}","w").write(str(os.getpid())); time.sleep(60)\'\n')
    service.follow("run_a", "ep_1")
    _until(child_pid.exists)
    live = service._live
    pid = int(child_pid.read_text())
    if reason == "settings_changed":
        service.update_settings(replace(gmo.load_settings(), host="other"))
    elif reason == "shutdown":
        service.close()
    elif reason == "replaced":
        row = {"run_id": "run_b", "episode_id": "ep_2", "path": str(remote["team"] / "run_b"), "conflict": False}
        monkeypatch.setattr(service, "_episode_row", lambda *_: (row, gmo.load_settings(), service._generation))
        service.follow("run_b", "ep_2")
    _until(lambda: live["runner"]._closed and not live["runner"]._children)
    with pytest.raises(ProcessLookupError):
        os.kill(pid, 0)
    if reason != "replaced":
        assert service.live_status()["stopped_reason"] == reason


def test_slow_cycles_never_overlap_and_resume_immediately(source, monkeypatch):
    service, _, _ = source
    monkeypatch.setattr(gmo_api, "LIVE_INTERVAL_S", 0.05)
    entered, release = threading.Event(), threading.Event()
    starts = []
    in_flight = 0

    def fetch(*args, **kwargs):
        nonlocal in_flight
        in_flight += 1
        assert in_flight == 1
        starts.append(time.monotonic())
        entered.set()
        assert release.wait(timeout=3)
        in_flight -= 1
        return 0

    monkeypatch.setattr(gmo, "fetch_episode", fetch)
    monkeypatch.setattr(service, "_live_episode_ended", lambda _: False)
    try:
        service.follow("run_a", "ep_1")
        assert entered.wait(timeout=2)
        time.sleep(0.3)
        assert len(starts) == 1
        released = time.monotonic()
        release.set()
        _until(lambda: len(starts) >= 2)
        assert starts[1] - released < 0.35
    finally:
        release.set()


def test_manual_and_live_transfers_are_serialized(source, monkeypatch):
    service, _, _ = source
    entered, release = threading.Event(), threading.Event()
    calls = []

    def fetch(runner, *args, **kwargs):
        calls.append(runner)
        if runner is service.runner:
            entered.set()
            assert release.wait(timeout=3)
        return 0

    monkeypatch.setattr(gmo, "fetch_episode", fetch)
    monkeypatch.setattr(service, "_live_episode_ended", lambda _: False)
    try:
        service.enqueue("run_a", "ep_1")
        assert entered.wait(timeout=2)
        service.follow("run_a", "ep_1")
        time.sleep(0.1)
        assert calls == [service.runner]
        release.set()
        _until(lambda: len(calls) == 2)
        assert calls[1] is service._live["runner"]
    finally:
        release.set()


def test_follow_reuses_manual_not_found_and_conflict_checks(source):
    service, _, remote = source
    with pytest.raises(HTTPException) as error:
        service.follow("missing", "missing")
    assert error.value.status_code == 404
    _episode(remote["team"], "run_a", "other")
    service.invalidate()
    with pytest.raises(HTTPException) as error:
        service.follow("run_a", "ep_1")
    assert error.value.status_code == 409 and service._live is None


@pytest.mark.parametrize("platform", ["linux", "darwin", "win32"])
def test_controlmaster_only_on_posix(monkeypatch, platform):
    monkeypatch.delenv("CAPX_GMO_SSH_COMMAND", raising=False)
    monkeypatch.setattr(sys, "platform", platform)
    command = gmo.api_ssh_argv(gmo.GmoSettings())
    if platform == "win32":
        assert not any("Control" in arg for arg in command)
    else:
        assert "ControlMaster=auto" in command and "ControlPersist=30" in command
        control = next(arg.removeprefix("ControlPath=") for arg in command if arg.startswith("ControlPath="))
        assert control.endswith("/%C") and len(control.replace("%C", "x" * 40)) < 104
        from pathlib import Path
        assert Path(control).parent.stat().st_mode & 0o077 == 0


def _request(method="GET", body=None, *, host="127.0.0.1:8290", origin=BASE,
             client=LOCAL, custom="gmo", content_type="application/json"):
    headers = [(b"host", host.encode()), (b"content-type", content_type.encode())]
    if origin is not None:
        headers.append((b"origin", origin.encode()))
    if custom is not None:
        headers.append((b"x-capx-request", custom.encode()))

    async def receive():
        return {"type": "http.request", "body": json.dumps(body).encode(), "more_body": False}

    return Request({"type": "http", "method": method, "path": "/api/gmo/live",
                    "query_string": b"", "client": client, "headers": headers}, receive)


@pytest.mark.parametrize("method", ["GET", "POST"])
@pytest.mark.parametrize("options", [
    {"custom": None}, {"custom": "wrong"}, {"host": "external.example"},
    {"origin": "https://external.example"}, {"client": ("192.0.2.1", 40000)},
])
def test_live_routes_have_same_loopback_guards(source, method, options):
    service, _, _ = source
    router = create_gmo_router(service)
    route = next(route for route in router.routes if route.path == "/api/gmo/live" and method in route.methods)
    gate = route.dependencies[0].dependency
    with pytest.raises(HTTPException) as error:
        gate(_request(method, **options))
    assert error.value.status_code == 403


def test_live_route_body_status_and_write_guards(manual, monkeypatch):
    service, _, _ = manual
    router = create_gmo_router(service)
    read = next(route for route in router.routes if route.path == "/api/gmo/live" and "GET" in route.methods)
    write = next(route for route in router.routes if route.path == "/api/gmo/live" and "POST" in route.methods)
    gate = write.dependencies[0].dependency
    for options, code in (({"origin": None}, 403), ({"origin": "null"}, 403), ({"content_type": "text/plain"}, 415)):
        with pytest.raises(HTTPException) as error:
            gate(_request("POST", **options))
        assert error.value.status_code == code
    assert json.loads(read.endpoint().body) == service.live_status()

    async def immediate(function, *args):
        return function(*args)

    # Invoke handlers in this thread: this sandbox blocks asyncio's threaded
    # wakeup socket used by TestClient. The production threadpool is unchanged.
    monkeypatch.setattr(gmo_api, "run_in_threadpool", immediate)
    for body in (None, [], {}, {"run_id": "../run", "episode_id": "ep"},
                 {"run_id": "run_a", "episode_id": "ep_1", "extra": True}):
        with pytest.raises(HTTPException) as error:
            asyncio.run(write.endpoint(_request("POST", body)))
        assert error.value.status_code == 400
    result = asyncio.run(write.endpoint(_request("POST", {"run_id": "run_a", "episode_id": "ep_1"})))
    assert json.loads(result.body)["following"] is True
