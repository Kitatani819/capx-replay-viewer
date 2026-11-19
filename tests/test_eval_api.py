"""Evaluation API: untrusted records, local/remote merge and loopback access."""
from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from capx_trace_viewer import evals, gmo
from capx_trace_viewer.eval_api import EvalService
from capx_trace_viewer.server import create_app
from trace_viewer_testlib import LOOPBACK_BASE_URL, raw_get


def record(eval_id, *, baseline=None, status="completed", success=1):
    stamp = datetime.now(timezone.utc).isoformat()
    summary = evals.aggregate_episodes([])
    summary.update(trials=2, success=success, failure=2-success, by_task={"cube": {"trials": 2, "success": success}},
                   tasks=["cube"], seeds=[401, 402])
    return {
        "schema": "capx-eval/1", "eval_id": eval_id, "status": status,
        "end": None if status == "running" else {"exit_code": 0, "signal": None},
        "by": "実行者", "changed": "把持位置" if baseline else "", "baseline_eval_id": baseline,
        "eval_set": "demo-2", "git": None, "started_at": stamp, "heartbeat_at": stamp,
        "ended_at": None if status == "running" else stamp,
        "summary": None if status == "running" else summary,
    }


def write_record(root, value):
    run = root / value["eval_id"]
    run.mkdir(parents=True, exist_ok=True)
    (run / "eval.json").write_text(json.dumps(value), encoding="utf-8")
    return run


def episode(run, episode_id="trial", *, success=True, attempt=1):
    directory = run / episode_id
    directory.mkdir()
    metadata = {"status": "ended", "trace_complete": True, "task": "cube", "condition": "M1", "seed": 401,
                "attempt_index": attempt, "end_reason": "completed", "harness_summary": {"task_completed": success}}
    (directory / "episode.json").write_text(json.dumps(metadata), encoding="utf-8")
    return metadata


def remote_eval(value, **changes):
    return {"run_id": value["eval_id"], "path": "/team/" + value["eval_id"], "owner": "team", "mine": False,
            "eval_json": value, "eval_json_error": None, "eval_mtime": time.time(), **changes}


def remote_episode(run_id, metadata, episode_id="trial"):
    return {"run_id": run_id, "episode_id": episode_id, "episode_json": metadata, "remote_now": time.time()}


def test_local_listing_and_comparison(tmp_path):
    base = record("ev-base")
    current = record("ev-current", baseline=base["eval_id"], success=2)
    current["summary"]["seeds"] = [401, 403]
    write_record(tmp_path, base)
    episode(write_record(tmp_path, current), success=False)
    service = EvalService(tmp_path)
    listing = service.listing()
    assert [row["eval_id"] for row in listing["evals"]] == ["ev-current", "ev-base"]
    assert listing["evals"][0]["baseline_summary"]["success"] == 1
    detail = service.detail("ev-current")
    assert detail["baseline"] == base
    assert detail["trials"][0] == {"episode_id": "trial", "task": "cube", "condition": "M1", "seed": 401,
                                    "attempt": 1, "verdict": "failure", "status": "ended",
                                    "runner_invocation": None, "start_wall_time": None,
                                    "end_classification": {"reason": "unknown", "label": "終わり方が不明",
                                                           "evidence": {"source": "missing_terminal_evidence", "event_id": None}},
                                    "trace_complete": True, "local_state": "local"}
    assert detail["differences"] == [{"field": "seeds", "baseline": [401, 402], "current": [401, 403]}]


@pytest.mark.parametrize("damage", ["json", "size", "schema", "id", "length", "type", "nan", "symlink", "directory"])
def test_invalid_file_is_listed_with_reason_without_breaking_other_evals(tmp_path, damage):
    write_record(tmp_path, record("ev-valid"))
    bad = record("ev-bad")
    run = write_record(tmp_path, bad)
    target = run / "eval.json"
    if damage == "json":
        target.write_text("{")
    elif damage == "size":
        target.write_bytes(b" " * (evals.MAX_EVAL_BYTES + 1))
    elif damage == "symlink":
        target.unlink()
        target.symlink_to(tmp_path / "ev-valid" / "eval.json")
    elif damage == "directory":
        target.unlink()
        target.mkdir()
    else:
        if damage == "schema":
            bad["schema"] = "unknown/1"
        elif damage == "id":
            bad["baseline_eval_id"] = "../escape"
        elif damage == "length":
            bad["changed"] = "字" * 201
        elif damage == "type":
            bad["summary"]["trials"] = True
        elif damage == "nan":
            bad["summary"]["config_flags"] = {"bad": float("nan")}
        target.write_text(json.dumps(bad))
    service = EvalService(tmp_path)
    rows = {row["eval_id"]: row for row in service.listing()["evals"]}
    assert rows["ev-valid"]["eval"] is not None
    assert rows["ev-bad"]["eval"] is None
    assert rows["ev-bad"]["error"]
    assert service.detail("ev-bad")["error"]


def test_remote_evals_merge_trials_with_local_precedence_and_missing_baseline(tmp_path, monkeypatch):
    value = record("ev-mixed", baseline="ev-missing", status="running")
    local = episode(write_record(tmp_path, value), success=False)
    remote = {**local, "harness_summary": {"task_completed": True}}
    listing = {"evals": [remote_eval(value), remote_eval(record("ev-empty"))],
               "episodes": [remote_episode(value["eval_id"], remote), remote_episode(value["eval_id"], remote, "remote-only")]}
    monkeypatch.setattr(gmo, "load_settings", lambda: SimpleNamespace(configured=True))
    service = EvalService(tmp_path, SimpleNamespace(remote_listing=lambda: listing))
    row = next(row for row in service.listing()["evals"] if row["eval_id"] == value["eval_id"])
    assert row["location"] == "both"
    assert row["summary"]["trials"] == 2 and row["summary"]["success"] == 1
    detail = service.detail(value["eval_id"])
    assert detail["baseline"] is None and detail["baseline_error"]
    trials = {trial["episode_id"]: trial for trial in detail["trials"]}
    assert trials["trial"]["verdict"] == "failure" and trials["trial"]["local_state"] == "local"
    assert trials["remote-only"]["verdict"] == "success" and trials["remote-only"]["local_state"] == "remote"
    assert service.detail("ev-empty")["trials"] == []


def test_remote_invalid_conflicting_and_unavailable_are_isolated(tmp_path, monkeypatch):
    value = record("ev-conflict")
    malformed = record("ev-malformed")
    malformed["by"] = []
    listing = {"evals": [remote_eval(value, conflict=True), remote_eval(malformed)],
               "episodes": [remote_episode(value["eval_id"], {"task": "ignored"})]}
    monkeypatch.setattr(gmo, "load_settings", lambda: SimpleNamespace(configured=True))
    service = EvalService(tmp_path, SimpleNamespace(remote_listing=lambda: listing))
    rows = {row["eval_id"]: row for row in service.listing()["evals"]}
    assert rows["ev-malformed"]["error"] and rows["ev-malformed"]["eval"] is None
    assert rows["ev-conflict"]["error"] and service.detail("ev-conflict")["trials"] == []
    write_record(tmp_path, record("ev-offline"))

    def unavailable():
        raise gmo.FetchError("private connection details")

    service.gmo_service = SimpleNamespace(remote_listing=unavailable)
    result = service.listing()
    assert len(result["evals"]) == 1
    assert "GMO" in result["error"] and "private" not in result["error"]


def test_running_comparison_uses_progress_and_local_runner_records(tmp_path):
    base = record("ev-base", status="running")
    current = record("ev-current", baseline="ev-base", status="running")
    episode(write_record(tmp_path, base))
    run = write_record(tmp_path, current)
    episode(run)
    (run / "runner_records.jsonl").write_text(json.dumps({"task": "cube", "condition": "M1", "seed": 401,
        "attempts": [{"attempt_id": 1, "task_success": False}]}) + "\n")
    detail = EvalService(tmp_path).detail("ev-current")
    assert detail["summary"]["failure"] == 1
    assert detail["baseline_summary"]["success"] == 1
    assert detail["trials"][0]["verdict"] == "failure"
    assert detail["differences"] == []


def test_listing_sorts_timestamps_chronologically_and_prefers_newer_record(tmp_path, monkeypatch):
    older = record("ev-older")
    newer = record("ev-newer")
    older["started_at"] = "2026-11-18T12:30:00+09:00"
    newer["started_at"] = "2026-11-18T09:00:00Z"
    run = write_record(tmp_path, older)
    write_record(tmp_path, newer)
    remote = {**older, "by": "更新された実行者"}
    listing = {"evals": [remote_eval(remote, eval_mtime=(run / "eval.json").stat().st_mtime + 1)], "episodes": []}
    monkeypatch.setattr(gmo, "load_settings", lambda: SimpleNamespace(configured=True))
    rows = EvalService(tmp_path, SimpleNamespace(remote_listing=lambda: listing)).listing()["evals"]
    assert [row["eval_id"] for row in rows] == ["ev-newer", "ev-older"]
    assert rows[1]["eval"]["by"] == "更新された実行者"


def test_api_registration_gate_and_spa_routes(tmp_path):
    write_record(tmp_path, record("ev-api"))
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("viewer")
    app = create_app(trace_root=tmp_path, frontend_dist=dist)
    with TestClient(app, base_url=LOOPBACK_BASE_URL, client=("127.0.0.1", 50000)) as client:
        assert client.get("/api/evals").json()["evals"][0]["eval_id"] == "ev-api"
        assert client.get("/api/evals/ev-api").status_code == 200
        assert client.get("/api/evals/missing").status_code == 404
        assert client.get("/api/not-registered").status_code == 404
        for path in ("/evals", "/evals/ev-api"):
            assert client.get(path).text == "viewer"
        assert client.get("/api/evals", headers={"Host": "attacker.example"}).status_code == 403
        assert client.get("/api/evals/ev-api", headers={"Origin": "https://attacker.example"}).status_code == 403


@pytest.mark.parametrize("path", ["/api/evals", "/api/evals/ev-api"])
def test_eval_gate_rejects_non_loopback_without_touching_storage(tmp_path, path):
    status, _body, _headers = raw_get(create_app(trace_root=tmp_path), path, client=("192.0.2.2", 50000))
    assert status == 403


@pytest.mark.parametrize("path", ["/api/evals/..", "/api/evals/bad%name", "/api/evals/a\x00b"])
def test_invalid_eval_id_never_reaches_storage(tmp_path, path):
    app = create_app(trace_root=tmp_path, expose_traces=True)
    status, _body, _headers = raw_get(app, path)
    assert status == 400
