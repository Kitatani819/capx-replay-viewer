"""A completed refresh must not change the status paired with an older snapshot."""
from __future__ import annotations

import threading
import time

import pytest

from capx_trace_viewer import gmo
from capx_trace_viewer.eval_api import EvalService
from capx_trace_viewer.gmo_api import GmoService
from test_eval_remote_cache import episode_row, listing, record


def finish(service, kind, run_ids=()):
    deadline = time.monotonic() + 3
    while service.listing_status(kind, run_ids)["refreshing"]:
        assert time.monotonic() < deadline
        time.sleep(0.002)


@pytest.mark.parametrize("phase", ["evals", "run"])
def test_cold_snapshot_retains_refresh_status_when_worker_finishes_before_response(
    tmp_path, monkeypatch, phase,
):
    monkeypatch.setenv("CAPX_GMO_CONFIG", str(tmp_path / "state" / "gmo.json"))
    settings = gmo.GmoSettings(host="test", mine=("/traces",), shared_root="", interval_s=0)
    monkeypatch.setattr(gmo, "load_settings", lambda: settings)
    value = record("ev-snapshot")
    release = threading.Event()

    def light(runner, settings):
        if phase == "evals":
            assert release.wait(3)
        return listing(value)

    def scoped(runner, settings, *, run_ids, **kwargs):
        if phase == "run":
            assert release.wait(3)
        return {"evals": [], "episodes": [episode_row(run_ids[0])]}

    monkeypatch.setattr(gmo, "list_remote_evals", light)
    monkeypatch.setattr(gmo, "list_remote_episodes", scoped)
    service = GmoService(tmp_path / "dest")
    try:
        if phase == "run":
            service.remote_eval_listing(wait=True)
        methods = (("remote_eval_listing", "remote_eval_snapshot") if phase == "evals"
                   else ("eval_episode_listing", "eval_episode_snapshot"))

        def complete_before_return(original):
            def wrapped(*args, **kwargs):
                result = original(*args, **kwargs)
                # Capture the cold rows first, then finish remote work before
                # EvalService can perform any subsequent status lookup.
                release.set()
                finish(service, phase, (value["eval_id"],) if phase == "run" else ())
                return result
            return wrapped

        for name in methods:
            if hasattr(service, name):
                monkeypatch.setattr(service, name, complete_before_return(getattr(service, name)))
        evaluation = EvalService(service.dest, service)
        first = evaluation.detail(value["eval_id"])
        assert first is not None, "The cold record is pending, not a definitive 404"
        assert first["remote_status"]["refreshing"] is True, "Empty trials must keep the page polling"
        if phase == "evals":
            assert first["loading_remote"] is True
        else:
            assert first["trials"] == []
        second = evaluation.detail(value["eval_id"])
        assert second["eval"]["eval_id"] == value["eval_id"]
        if phase == "run":
            assert [trial["episode_id"] for trial in second["trials"]] == ["trial"]
            assert second["remote_status"]["refreshing"] is False
    finally:
        release.set()
        service.close()


def test_run_shortcut_never_pairs_old_full_rows_with_completed_refresh_status(tmp_path, monkeypatch):
    monkeypatch.setenv("CAPX_GMO_CONFIG", str(tmp_path / "state" / "gmo.json"))
    settings = gmo.GmoSettings(host="test", mine=("/traces",), shared_root="", interval_s=0)
    monkeypatch.setattr(gmo, "load_settings", lambda: settings)
    value = record("ev-snapshot")
    release = threading.Event()
    changed = False

    def episodes(runner, settings, **kwargs):
        if changed:
            assert release.wait(3)
        row = episode_row(value["eval_id"])
        row["episode_json"]["task"] = "new" if changed else "old"
        return {"episodes": [row], "evals": []}

    monkeypatch.setattr(gmo, "list_remote_evals", lambda runner, settings: listing(value))
    monkeypatch.setattr(gmo, "list_remote_episodes", episodes)
    service = GmoService(tmp_path / "dest")
    try:
        service.remote_listing(wait=True)
        service.remote_eval_listing(wait=True)
        original = service._listings.snapshot_with_status
        full_key = service._listing_key(settings, "episodes")

        def complete_before_publication(key, *args, **kwargs):
            result = original(key, *args, **kwargs)
            if key == full_key:
                release.set()
                finish(service, "episodes")
            return result

        monkeypatch.setattr(service._listings, "snapshot_with_status", complete_before_publication)
        changed = True
        old_rows = service.remote_listing(refresh=True, wait=False)
        assert old_rows["episodes"][0]["episode_json"]["task"] == "old"
        detail = EvalService(service.dest, service).detail(value["eval_id"])
        assert detail["remote_status"]["refreshing"] or (
            detail["trials"] and detail["trials"][0]["task"] == "new"
        ), "A completed evaluation must see refreshed trials or keep polling"
    finally:
        release.set()
        service.close()
