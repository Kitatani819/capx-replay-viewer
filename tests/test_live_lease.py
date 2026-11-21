"""Conditional Live renewals cannot acquire another tab's follower."""
from __future__ import annotations

import asyncio
import json
import time
from dataclasses import replace

import pytest

from capx_trace_viewer import gmo, gmo_api
from capx_trace_viewer.gmo_api import GmoService, create_gmo_router
from test_gmo_live import _request


@pytest.fixture
def service(tmp_path, monkeypatch):
    service = GmoService(tmp_path / "traces", tmp_path / "config.json")
    settings = gmo.GmoSettings(host="example", mine=("/records",), team=(), shared_root="")
    monkeypatch.setattr(service, "load_settings", lambda: settings)
    monkeypatch.setattr(service, "_live_loop", lambda: None)
    monkeypatch.setattr(service, "_episode_row", lambda run, episode: (
        {"run_id": run, "episode_id": episode}, settings, service._generation))
    yield service
    service.close()


@pytest.mark.parametrize("prefix", ["/api/gmo", "/api/sites/rtx/gmo"])
def test_conditional_live_renewal_conflicts_with_current_status_after_takeover(service, monkeypatch, prefix):
    async def immediate(function, *args):
        return function(*args)

    monkeypatch.setattr(gmo_api, "run_in_threadpool", immediate)
    router = create_gmo_router(service, prefix=prefix)
    acquire = next(route for route in router.routes if route.path == prefix + "/live" and "POST" in route.methods)
    first = json.loads(asyncio.run(acquire.endpoint(_request("POST", {
        "run_id": "run", "episode_id": "first"}))).body)
    assert isinstance(first.get("lease_token"), str) and first["lease_token"]
    second = service.follow("run", "second")
    follower = service._live
    deadline = follower["lease_until"]
    renew = next(route for route in router.routes if route.path == prefix + "/live/renew")
    response = asyncio.run(renew.endpoint(_request("POST", {
        "run_id": "run", "episode_id": "first", "lease_token": first["lease_token"]})))
    assert response.status_code == 409
    assert json.loads(response.body) == {"error": "lease_replaced", "status": second}
    assert service._live is follower and follower["lease_until"] == deadline


def test_conditional_live_renewal_recovers_only_its_own_expired_lease(service, monkeypatch):
    first = service.follow("run", "trial")
    assert first.get("lease_token"), "acquisition must identify the lease"
    token = first["lease_token"]
    follower = service._live
    monkeypatch.setattr(service, "_episode_row", lambda *_: pytest.fail("renewal must not acquire/list"))
    follower["lease_until"] = time.monotonic() - 1
    assert service.renew("run", "trial", token)["following"]
    assert service._live is follower and follower["lease_until"] > time.monotonic()
    with service._lock:
        stopped = service._stop_live_locked("lease_expired")
    # Resume before the monitor closes the old runner outside its lock.
    resumed = service.renew("run", "trial", token)
    stopped.close()
    service._run_live_cycle(follower)  # A queued stale copy cannot update the resumed lease.
    assert resumed["following"] and resumed["lease_token"] == token
    assert service._live is not follower and service._live["runner"] is not stopped
    assert not service._live["runner"]._closed
    with service._lock:
        stopped = service._stop_live_locked("episode_ended")
    stopped.close()
    assert service.renew("run", "trial", token)["stopped_reason"] == "episode_ended"
    assert service._live is None


@pytest.mark.parametrize("change", ["same_trial", "trial", "token", "generation", "settings", "settings_aba"])
def test_conditional_live_renewal_checks_token_trial_and_settings_under_lock(service, monkeypatch, change):
    first = service.follow("run", "trial")
    assert first.get("lease_token"), "acquisition must identify the lease"
    token, run, episode = first["lease_token"], "run", "trial"
    if change == "same_trial":
        assert service.follow(run, episode)["lease_token"] != token
    elif change == "trial":
        episode = "other"
    elif change == "token":
        token = "not-the-owner"
    elif change == "generation":
        service.invalidate()
    elif change == "settings":
        settings = replace(service.load_settings(), host="other")
        monkeypatch.setattr(service, "load_settings", lambda: settings)
    else:
        original = service.load_settings()
        service.update_settings(replace(original, host="other"))
        service.update_settings(original)
    follower = service._live
    status = service.live_status()
    deadline = follower["lease_until"] if follower else None
    with pytest.raises(gmo_api.LiveLeaseConflict) as error:
        service.renew(run, episode, token)
    assert error.value.status == status
    assert service._live is follower
    assert follower is None or follower["lease_until"] == deadline
