"""Regressions for partial imports, canonical verdicts and finalized metadata."""
from __future__ import annotations

import json
import os
from types import SimpleNamespace

import pytest

from capx_trace_viewer import evals, gmo, reader
from capx_trace_viewer.end_reason import classify_trial_end
from capx_trace_viewer.eval_api import EvalService
from test_eval_api import episode, record, remote_episode, remote_eval, write_record


@pytest.mark.parametrize("trials,success,imported", [(2, 1, 1), (4, 0, 2)])
@pytest.mark.parametrize("logical", [False, True])
def test_partial_import_keeps_saved_evaluation_population(tmp_path, monkeypatch, trials, success, imported, logical):
    value = record("ev-partial", success=success)
    value["summary"].update(trials=trials, success=success, failure=trials-success,
                            seeds=list(range(401, 401+trials)),
                            by_task={"cube": {"trials": trials, "success": success}})
    if logical:
        value["summary"]["attempts"] = trials
        value["summary"]["by_task"]["cube"]["attempts"] = trials
    run = write_record(tmp_path, value)
    rows = []
    for index in range(trials):
        metadata = {"status": "ended", "trace_complete": True, "task": "cube", "condition": "M1",
                    "seed": 401+index, "attempt_index": 1, "end_reason": "completed",
                    "harness_summary": {"task_completed": index < success}}
        rows.append(remote_episode(value["eval_id"], metadata, f"trial-{index}"))
        if index < imported:
            episode(run, f"trial-{index}", success=index < success, seed=401+index)
    monkeypatch.setattr(gmo, "load_settings", lambda: SimpleNamespace(configured=True))
    service = EvalService(tmp_path, SimpleNamespace(
        remote_eval_listing=lambda **_kwargs: {"evals": [remote_eval(value)], "episodes": []},
        eval_episode_listing=lambda *_args, **_kwargs: {"evals": [], "episodes": rows}))
    assert service.listing()["evals"][0]["summary"] == value["summary"]
    detail = service.detail(value["eval_id"])
    assert (detail["summary"]["success"], detail["summary"]["trials"]) == (success, trials)
    assert len(detail["trials"]) == trials


def test_missing_retry_attempt_keeps_saved_summary(tmp_path):
    value = record("ev-partial-attempts")
    value["summary"]["attempts"] = 3
    value["summary"]["by_task"]["cube"]["attempts"] = 3
    run = write_record(tmp_path, value)
    episode(run, "first", seed=401)
    episode(run, "second", seed=402)
    assert EvalService(tmp_path).listing()["evals"][0]["summary"] == value["summary"]


def test_surplus_retries_do_not_replace_missing_logical_population(tmp_path):
    value = record("ev-missing-logical", success=2)
    value["summary"].update(trials=3, attempts=4, failure=1,
                            by_task={"cube": {"trials": 3, "success": 2, "attempts": 4}})
    run = write_record(tmp_path, value)
    for seed in (401, 402):
        for attempt in (1, 2):
            episode(run, f"trial-{seed}-{attempt}", seed=seed, attempt=attempt)
    service = EvalService(tmp_path)
    assert service.listing()["evals"][0]["summary"] == value["summary"]
    assert service.detail(value["eval_id"])["summary"] == value["summary"]


def test_historical_runner_matches_do_not_replace_missing_logical_verdict(tmp_path):
    value = record("ev-missing-logical-runner")
    value["summary"].update(attempts=3, verdict_sources={"runner_record": 2},
                            by_task={"cube": {"trials": 2, "success": 1, "attempts": 3}})
    run = write_record(tmp_path, value)
    episode(run, "first-attempt", seed=401)
    episode(run, "retry", seed=401, attempt=2)
    episode(run, "other-seed", seed=402)
    (run / "runner_records.jsonl").write_text(json.dumps({
        "task": "cube", "condition": "M1", "seed": 401,
        "attempts": [{"attempt_id": 1, "task_success": True},
                     {"attempt_id": 2, "task_success": True}]}) + "\n")
    service = EvalService(tmp_path)
    assert service.listing()["evals"][0]["summary"] == value["summary"]
    assert service.detail(value["eval_id"])["summary"] == value["summary"]


@pytest.mark.parametrize("damage", ["missing", "symlink", "corrupt", "torn"])
def test_incomplete_runner_evidence_keeps_saved_summary(tmp_path, damage):
    value = record("ev-incomplete-runner", success=0)
    value["summary"]["verdict_sources"] = {"runner_record": 2}
    run = write_record(tmp_path, value)
    episode(run, "first", seed=401)
    episode(run, "second", seed=402)
    target = run / "runner_records.jsonl"
    if damage == "symlink":
        outside = tmp_path / "runner.jsonl"
        outside.write_text("{}\n")
        target.symlink_to(outside)
    elif damage != "missing":
        target.write_text("{\n" if damage == "corrupt" else "{")
    assert EvalService(tmp_path).listing()["evals"][0]["summary"] == value["summary"]


def test_aggregate_uses_canonical_void_verdict():
    metadata = {"status": "ended", "trace_complete": True, "task": "cube", "seed": 401,
                "end_reason": "error", "exception": {"message": "environment crashed; episode voided"},
                "trial_outcome": {"source": "recorder_terminal", "task_success": True}}
    summary = reader.episode_summary_from_metadata("ev-void", "trial", metadata)
    assert classify_trial_end(summary)["verdict"] == "unknown"
    counts = evals.aggregate_episodes([summary])
    assert (counts["success"], counts["failure"], counts["unknown"]) == (0, 0, 1)
    assert counts["by_task"]["cube"]["success"] == 0


@pytest.mark.parametrize("exception_in_metadata", [False, True])
@pytest.mark.parametrize("runner", [False, True])
def test_evaluation_totals_match_void_trial_table(tmp_path, exception_in_metadata, runner):
    value = record("ev-void")
    value["summary"].update(trials=1, failure=0, seeds=[401], by_task={"cube": {"trials": 1, "success": 1}})
    run = write_record(tmp_path, value)
    metadata = episode(run)
    if runner:
        value["summary"]["verdict_sources"] = {"runner_record": 1}
        write_record(tmp_path, value)
        (run / "runner_records.jsonl").write_text(json.dumps({
            "task": "cube", "condition": "M1", "seed": 401,
            "attempts": [{"attempt_id": 1, "task_success": True}]}) + "\n")
    exception = {"type": "RuntimeError", "message": "environment crashed; episode voided"}
    if exception_in_metadata:
        metadata["exception"] = exception
        (run / "trial" / "episode.json").write_text(json.dumps(metadata))
    event = {"event_type": "episode_end", "seq": 1, "event_id": "end", "data": {"exception": exception}}
    (run / "trial" / "events.jsonl").write_text(json.dumps(event) + "\n")
    service = EvalService(tmp_path)
    detail = service.detail(value["eval_id"])
    assert detail["trials"][0]["verdict"] == "unknown"
    for counts in (detail["summary"], service.listing()["evals"][0]["summary"]):
        assert (counts["success"], counts["failure"], counts["unknown"]) == (0, 0, 1)


@pytest.mark.parametrize("remote_newer", [False, True])
@pytest.mark.parametrize("local_live", [False, True])
def test_finalized_outcome_uses_metadata_freshness_at_equal_status(tmp_path, monkeypatch, remote_newer, local_live):
    value = record("ev-finalized", status="interrupted", success=0)
    run = write_record(tmp_path, value)
    metadata = episode(run)
    metadata.update(status="running", trace_complete=False, end_reason=None, harness_summary=None)
    path = run / "trial" / "episode.json"
    path.write_text(json.dumps(metadata))
    os.utime(path, (100, 100))
    if local_live:
        (run / "trial" / "heartbeat").write_text("")
    finished = {**metadata, "trial_outcome": {"source": "evaluation_finalizer", "task_success": False}}
    row = remote_episode(value["eval_id"], finished)
    row["episode_mtime"] = 101 if remote_newer else 99
    monkeypatch.setattr(gmo, "load_settings", lambda: SimpleNamespace(configured=True))
    service = EvalService(tmp_path, SimpleNamespace(remote_listing=lambda: {
        "evals": [remote_eval(value)], "episodes": [row]}))
    trial, = service.detail(value["eval_id"])["trials"]
    assert trial["status"] == ("running" if local_live and not remote_newer else "incomplete")
    assert (trial["local_state"], trial["verdict"]) == (
        ("remote", "failure") if remote_newer else ("local", "running" if local_live else "unknown"))
