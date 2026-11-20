"""Evaluation pages use persistent light listings without waiting for GMO scans."""
from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from capx_trace_viewer import evals, gmo
from capx_trace_viewer.eval_api import EvalService, create_eval_router
from capx_trace_viewer.gmo_api import GmoService


def record(eval_id, *, baseline=None):
    stamp = datetime.now(timezone.utc).isoformat()
    return {"schema": "capx-eval/1", "eval_id": eval_id, "status": "completed",
            "end": {"exit_code": 0, "signal": None}, "by": "demo", "changed": "",
            "baseline_eval_id": baseline, "eval_set": "demo", "git": None,
            "started_at": stamp, "heartbeat_at": stamp, "ended_at": stamp,
            "summary": evals.aggregate_episodes([])}


def eval_row(value):
    return {"run_id": value["eval_id"], "path": "/traces/" + value["eval_id"],
            "owner": "demo", "mine": True, "eval_json": value, "eval_json_error": None,
            "eval_mtime": time.time(), "remote_now": time.time(), "conflict": False}


def episode_row(run_id):
    return {"run_id": run_id, "episode_id": "trial", "path": "/traces/" + run_id,
            "owner": "demo", "mine": True, "conflict": False, "remote_now": time.time(),
            "episode_json": {"status": "ended", "trace_complete": True, "task": "cube",
                             "condition": "M1", "seed": 401, "attempt_index": 1,
                             "end_reason": "completed", "harness_summary": {"task_completed": True}},
            "episode_json_error": None, "episode_mtime": time.time(), "run_json": {},
            "run_json_error": None, "run_mtime": time.time(), "heartbeat_mtime": None,
            "events_mtime": None, "events_bytes": 0, "first_event": None,
            "file_count": 1, "size_bytes": 100, "max_mtime": int(time.time()),
            "files_digest": "0" * 64}


def listing(*values):
    return {"episodes": [], "evals": [eval_row(value) for value in values]}


def wait_refresh(service, kind="evals", run_id=None):
    deadline = time.monotonic() + 3
    while service.listing_status(kind, (run_id,) if run_id else ())["refreshing"]:
        assert time.monotonic() < deadline, "Remote refresh did not finish"
        time.sleep(0.002)


@pytest.fixture
def configured(tmp_path, monkeypatch):
    monkeypatch.setenv("CAPX_GMO_CONFIG", str(tmp_path / "state" / "gmo.json"))
    settings = gmo.GmoSettings(host="test-transport", mine=("/traces",), shared_root="", interval_s=0)
    monkeypatch.setattr(gmo, "load_settings", lambda: settings)
    return settings


def test_eval_list_returns_local_first_then_remote_without_full_episode_scan(tmp_path, monkeypatch, configured):
    local, remote = record("ev-local"), record("ev-remote")
    root = tmp_path / "dest"
    run = root / local["eval_id"]
    run.mkdir(parents=True)
    (run / "eval.json").write_text(json.dumps(local))
    entered, release = threading.Event(), threading.Event()
    calls = []

    def light(runner, settings):
        calls.append("evals")
        entered.set()
        assert release.wait(3)
        return listing(remote)

    def full(*args, **kwargs):
        calls.append("full")
        raise AssertionError("Evaluation listing must not scan episode directories")

    monkeypatch.setattr(gmo, "list_remote_evals", light)
    monkeypatch.setattr(gmo, "list_remote_episodes", full)
    service = GmoService(root)
    evaluation = EvalService(root, service)
    try:
        started = time.monotonic()
        result = evaluation.listing()
        assert time.monotonic() - started < 0.5
        assert [row["eval_id"] for row in result["evals"]] == ["ev-local"]
        assert result["remote_status"] == {"fetched_at": None, "refreshing": True, "error": None}
        assert entered.wait(1)
        release.set()
        wait_refresh(service)
        assert {row["eval_id"] for row in evaluation.listing()["evals"]} == {"ev-local", "ev-remote"}
        assert evaluation.listing()["remote_status"]["fetched_at"] is not None
        assert calls == ["evals"]
    finally:
        release.set()
        service.close()


def test_cold_detail_answers_202_then_fills_record_and_scoped_trials(tmp_path, monkeypatch, configured):
    value = record("ev-remote")
    eval_release, run_release, run_entered = threading.Event(), threading.Event(), threading.Event()

    def light(runner, settings):
        assert eval_release.wait(3)
        return listing(value)

    def scoped(runner, settings, *, run_ids, **kwargs):
        assert run_ids == ("ev-remote",)
        run_entered.set()
        assert run_release.wait(3)
        return {"evals": [], "episodes": [episode_row(run_ids[0])]}

    monkeypatch.setattr(gmo, "list_remote_evals", light)
    monkeypatch.setattr(gmo, "list_remote_episodes", scoped)
    service = GmoService(tmp_path / "dest")
    app = FastAPI()
    app.include_router(create_eval_router(service.dest, gmo_service=service))
    try:
        with TestClient(app, base_url="http://127.0.0.1:8390", client=("127.0.0.1", 40000)) as client:
            response = client.get("/api/evals/ev-remote")
            assert response.status_code == 202
            assert response.json()["loading_remote"] is True
            assert response.json()["remote_status"]["refreshing"] is True
            eval_release.set()
            wait_refresh(service)
            response = client.get("/api/evals/ev-remote")
            assert response.status_code == 200
            assert response.json()["eval"]["eval_id"] == "ev-remote"
            assert response.json()["trials"] == []
            assert response.json()["remote_status"]["refreshing"] is True
            assert run_entered.wait(1)
            run_release.set()
            wait_refresh(service, "run", "ev-remote")
            response = client.get("/api/evals/ev-remote")
            assert [row["episode_id"] for row in response.json()["trials"]] == ["trial"]
            assert response.json()["remote_status"]["refreshing"] is False
            assert client.get("/api/evals/ev-missing").status_code == 404
    finally:
        eval_release.set()
        run_release.set()
        service.close()


def test_stale_eval_listing_keeps_rows_and_reports_refresh_failure(tmp_path, monkeypatch, configured):
    value = record("ev-remote")
    monkeypatch.setattr(gmo, "list_remote_evals", lambda runner, settings: listing(value))
    monkeypatch.setattr(gmo, "list_remote_episodes", lambda runner, settings, **kwargs: {
        "evals": [], "episodes": [episode_row("ev-remote")]})
    service = GmoService(tmp_path / "dest")
    evaluation = EvalService(service.dest, service)
    entered, release = threading.Event(), threading.Event()
    try:
        service.remote_eval_listing(wait=True)
        original = evaluation.listing()
        original_stamp = original["remote_status"]["fetched_at"]

        def failed(runner, settings):
            entered.set()
            assert release.wait(3)
            raise gmo.FetchError("private connection diagnostic")

        monkeypatch.setattr(gmo, "list_remote_evals", failed)
        service._listings.invalidate()
        started = time.monotonic()
        stale = evaluation.listing()
        assert time.monotonic() - started < 0.5
        assert stale["evals"] == original["evals"]
        assert stale["remote_status"]["refreshing"]
        assert entered.wait(1)
        release.set()
        wait_refresh(service)
        failed_result = evaluation.listing()
        assert failed_result["evals"] == original["evals"]
        assert failed_result["remote_status"]["fetched_at"] == original_stamp
        assert failed_result["remote_status"]["refreshing"] is False
        assert "GMO" in failed_result["error"] and "private" not in failed_result["error"]
        detail = evaluation.detail("ev-remote")
        assert "GMO" in detail["remote_error"] and "private" not in detail["remote_error"]
    finally:
        release.set()
        service.close()


def test_restart_serves_persisted_eval_and_scoped_metadata_without_transport(tmp_path, monkeypatch, configured):
    value = record("ev-remote")
    monkeypatch.setattr(gmo, "list_remote_evals", lambda runner, settings: listing(value))
    monkeypatch.setattr(gmo, "list_remote_episodes", lambda runner, settings, **kwargs: {
        "evals": [], "episodes": [episode_row("ev-remote")]})
    first = GmoService(tmp_path / "dest")
    try:
        first.remote_eval_listing(wait=True)
        first.eval_episode_listing("ev-remote")
        wait_refresh(first, "run", "ev-remote")
        expected = EvalService(first.dest, first).detail("ev-remote")
    finally:
        first.close()
    calls = []

    def unexpected(*args, **kwargs):
        calls.append(kwargs)
        raise AssertionError("Fresh persisted listings must not contact GMO")

    monkeypatch.setattr(gmo, "list_remote_evals", unexpected)
    monkeypatch.setattr(gmo, "list_remote_episodes", unexpected)
    restarted = GmoService(tmp_path / "dest")
    try:
        restored = EvalService(restarted.dest, restarted).detail("ev-remote")
        assert restored == expected
        assert restored["trials"][0]["episode_id"] == "trial"
        assert calls == []
    finally:
        restarted.close()


def test_detail_only_loads_open_evaluation_and_baseline_metadata(tmp_path, monkeypatch, configured):
    current, base, unrelated = record("ev-current", baseline="ev-base"), record("ev-base"), record("ev-other")
    monkeypatch.setattr(gmo, "list_remote_evals", lambda runner, settings: listing(current, base, unrelated))
    scopes = []

    def scoped(runner, settings, *, run_ids, **kwargs):
        scopes.append(run_ids)
        assert len(run_ids) == 1
        return {"evals": [], "episodes": [episode_row(run_ids[0])]}

    monkeypatch.setattr(gmo, "list_remote_episodes", scoped)
    service = GmoService(tmp_path / "dest")
    evaluation = EvalService(service.dest, service)
    try:
        service.remote_eval_listing(wait=True)
        assert len(evaluation.listing()["evals"]) == 3
        assert scopes == []
        evaluation.detail("ev-current")
        wait_refresh(service, "run", "ev-current")
        wait_refresh(service, "run", "ev-base")
        detail = evaluation.detail("ev-current")
        assert detail["trials"][0]["episode_id"] == "trial"
        assert detail["baseline_trials"][0]["episode_id"] == "trial"
        assert scopes == [("ev-current",), ("ev-base",)]
    finally:
        service.close()


def test_settings_change_rejects_inflight_old_listing_and_uses_new_cache_key(tmp_path, monkeypatch, configured):
    settings = [configured]
    monkeypatch.setattr(gmo, "load_settings", lambda: settings[0])
    entered, release = threading.Event(), threading.Event()

    def light(runner, selected):
        if selected == configured:
            entered.set()
            assert release.wait(3)
            return listing(record("ev-old-settings"))
        return listing(record("ev-new-settings"))

    monkeypatch.setattr(gmo, "list_remote_evals", light)
    service = GmoService(tmp_path / "dest")
    try:
        assert EvalService(service.dest, service).listing()["evals"] == []
        assert entered.wait(1)
        settings[0] = gmo.GmoSettings(host="other-transport", mine=("/other",), shared_root="", interval_s=0)
        service.invalidate()
        assert EvalService(service.dest, service).listing()["evals"] == []
        release.set()
        wait_refresh(service)
        assert [row["eval_id"] for row in EvalService(service.dest, service).listing()["evals"]] == ["ev-new-settings"]
        settings[0] = configured
        assert service.listing_status("evals")["fetched_at"] is None
    finally:
        release.set()
        service.close()
