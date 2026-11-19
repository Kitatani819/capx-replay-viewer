"""One conservative classifier is shared by trial and evaluation API responses."""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

import pytest

from capx_trace_viewer import evals, reader
from capx_trace_viewer.end_reason import END_CELL_WORDS, END_LABELS, END_REASON_WORDS, classify_trial_end
from capx_trace_viewer.eval_api import create_eval_router
from capx_trace_viewer.trace_api import create_trace_router
from trace_viewer_testlib import EPISODE_ENDED, RUN_ID


def test_canonical_label_table():
    assert END_REASON_WORDS == {
        "success": ("成功", "成功"),
        "error": ("エラーで停止", "エラー"),
        "timeout": ("時間切れ・打ち切り", "時間切れ"),
        "finish_unmet": ("「終わった」と答えたが未達成", "未達成"),
        "regen_limit": ("書き直しの上限", "上限"),
        "unknown": ("終わり方が不明", "不明"),
    }


@pytest.mark.parametrize("name,expected", [("END_LABELS", END_LABELS), ("END_CELL_WORDS", END_CELL_WORDS)])
def test_typescript_label_table_matches_python(name, expected):
    source = Path(__file__).resolve().parents[1] / "web-ui/src/evals/failureReasons.ts"
    content = source.read_text(encoding="utf-8")
    table = re.search(rf"export const {name}(?:\s*:[^=]+)?\s*=\s*\{{([^}}]*)\}}", content)
    assert table is not None, f"Missing literal TypeScript table {name}"
    labels = dict(re.findall(r"(\w+)\s*:\s*['\"]([^'\"]*)['\"]", table[1]))
    assert labels == expected


def event(kind, seq, *, status="ok", **data):
    return {"event_id": f"e{seq}", "seq": seq, "event_type": kind, "status": status,
            "refs": {"turn_index": 0}, "data": data}


def metadata(**changes):
    return {"status": "ended", "trace_complete": True, "task": "cube", "condition": "M1", "seed": 7,
            "attempt_index": 1, "end_reason": "completed",
            "harness_summary": {"task_completed": False, "sandbox_rc": 0,
                                "num_regenerations": 0, "num_finishes": 0}, **changes}


def summary(raw=None):
    return reader.episode_summary_from_metadata("run", "trial", metadata() if raw is None else raw)


@pytest.mark.parametrize(("raw", "events", "reason", "evidence"), [
    (metadata(harness_summary={"task_completed": True}),
     [event("episode_end", 3, end_reason="completed")], "success", "e3"),
    (metadata(end_reason="exception", exception={"type": "ValueError"}),
     [event("api_call_error", 2, status="error", error_type="ValueError", message="bad target"),
      event("episode_end", 3, end_reason="exception")], "error", "e3"),
    (metadata(end_reason="timeout_alarm", alarm_seen=True),
     [event("api_call_end", 2, status="error", alarm_timeout=True),
      event("episode_end", 3, end_reason="timeout_alarm", alarm_seen=True)], "timeout", "e2"),
    (metadata(), [event("model_output_parsed", 2, decision="finish", model_said_finish=True)],
     "finish_unmet", "e2"),
    (metadata(harness_summary={"task_completed": False, "sandbox_rc": 0,
                              "num_regenerations": 2, "num_finishes": 0}),
     [event("model_output_parsed", 2, decision="regenerate", model_said_finish=False)], "regen_limit", "e2"),
    ({}, [], "unknown", None),
    (metadata(status="open"), [event("model_output_parsed", 2, decision="regenerate")], "unknown", None),
    (metadata(harness_summary={"success": True}), [], "unknown", None),
])
def test_categories_and_event_evidence(raw, events, reason, evidence):
    result = classify_trial_end(summary(raw), events)
    assert result["reason"] == reason
    assert result["label"] == END_LABELS[reason]
    assert result["evidence"]["source"]
    assert result["evidence"]["event_id"] == evidence


def test_default_finish_is_not_a_model_claim():
    parsed = event("model_output_parsed", 2, decision="finish", model_said_finish=False, content_empty=True)
    assert classify_trial_end(summary(), [parsed])["reason"] == "unknown"


def test_malformed_optional_data_is_tolerated():
    events = [{"event_id": "bad-block", "event_type": "code_block_end", "data": []},
              {"event_id": "bad-end", "event_type": "episode_end", "data": []}]
    assert classify_trial_end(summary(metadata(harness_summary=[])), events)["reason"] == "unknown"
    events = [event("model_output_parsed", 1, decision="finish", model_said_finish=True)]
    events[0]["refs"] = []
    assert classify_trial_end(summary(), events)["reason"] == "finish_unmet"


def test_terminal_error_evidence_is_separate_from_a_recovered_first_error():
    events = [event("api_call_error", 1, status="error", error_type="ValueError"),
              event("code_block_end", 2), event("episode_end", 3, end_reason="exception",
                                             exception={"type": "RuntimeError"})]
    result = classify_trial_end(summary(metadata(end_reason="exception")), events)
    assert result["evidence"]["event_id"] == "e3"
    assert result["evidence"]["first_error_event_id"] == "e1"


def test_recorder_closed_an_abandoned_episode_without_its_own_end():
    note = "left open on the trial thread; ended when the next episode started (the trial's own end was not recorded)"
    raw = metadata(end_reason="error", harness_summary={})
    events = [event("api_call_error", 1, status="error", error_type="ValueError"),
              event("episode_end", 2, end_reason="error", end_note=note)]
    result = classify_trial_end(summary(raw), events)
    assert result["reason"] == "unknown"
    assert result["evidence"]["source"] == "recorder_closed_without_trial_end"
    events[-1]["data"]["exception"] = {"type": "RuntimeError"}
    assert classify_trial_end(summary(raw), events)["reason"] == "error"


@pytest.mark.parametrize("value,reason", [(True, "timeout"), (False, "unknown"), (None, "unknown"), (1, "unknown")])
def test_runner_sandbox_timeout_flag(value, reason):
    records = [{"task": "cube", "condition": "M1", "seed": 7,
                "attempts": [{"attempt_id": 1, "status": "completed", "timed_out_in_sandbox": value}]}]
    result = classify_trial_end(summary(metadata(harness_summary={})), [], records)
    assert result["reason"] == reason
    if reason == "timeout":
        assert result["evidence"]["source"] == "runner_record"


def test_recovered_errors_do_not_explain_terminal_finish_or_success():
    events = [event("api_call_end", 1, status="error", error_type="ValueError"),
              event("code_block_end", 2, status="error", exception={"type": "ValueError"}),
              event("code_block_end", 3, sandbox_rc=0),
              event("model_output_parsed", 4, decision="finish", model_said_finish=True)]
    assert classify_trial_end(summary(), events)["reason"] == "finish_unmet"
    assert classify_trial_end(summary(metadata(harness_summary={"task_completed": True})), events)["reason"] == "success"


def test_last_failed_execution_after_regenerate_is_error():
    raw = metadata(harness_summary={"task_completed": False, "sandbox_rc": 1,
                                   "num_regenerations": 1, "num_finishes": 0})
    events = [event("model_output_parsed", 1, decision="regenerate"),
              event("code_block_end", 2, status="error", exception={"type": "ValueError"})]
    assert classify_trial_end(summary(raw), events)["reason"] == "error"
    # If the harness asked to regenerate after that error and then returned
    # normally with no finishes, the consumed budget explains the stop.
    events = [event("code_block_end", 1, status="error", exception={"type": "ValueError"}),
              event("model_output_parsed", 2, decision="regenerate")]
    assert classify_trial_end(summary(raw), events)["reason"] == "regen_limit"


@pytest.mark.parametrize("end_reason", ["stopped_by_user", "cancelled_replaced"])
def test_explicit_cutoffs_are_timeout(end_reason):
    assert classify_trial_end(summary(metadata(end_reason=end_reason)))["reason"] == "timeout"


def test_truncated_execution_and_non_alarm_os_error_are_distinct():
    assert classify_trial_end(summary(), [event("code_block_end", 1, truncated=True)])["reason"] == "timeout"
    os_error = metadata(end_reason="exception", exception={"type": "TimeoutError", "message": "OS timeout"})
    assert classify_trial_end(summary(os_error))["reason"] == "error"


def test_runner_verdict_and_attempt_precedence():
    raw = metadata(harness_summary={"task_completed": True, "success": True})
    records = [{"task": "cube", "condition": "M1", "seed": 7,
                "attempts": [{"attempt_id": 1, "task_success": False}]}]
    parsed = event("model_output_parsed", 2, decision="finish", model_said_finish=True)
    assert classify_trial_end(summary(raw), [parsed], records)["reason"] == "finish_unmet"
    records[0]["attempts"][0]["task_success"] = True
    result = classify_trial_end(summary(), [parsed], records)
    assert result["reason"] == "success" and result["evidence"]["source"] == "runner_record"
    # A final trial outcome cannot overwrite an earlier attempt's own timeout.
    records[0]["attempts"] = [{"attempt_id": 1, "status": "timeout"}, {"attempt_id": 2, "status": "completed"}]
    records[0]["outcome"] = {"task_success": True, "timeout": False}
    assert classify_trial_end(summary(), [], records)["reason"] == "timeout"


def write_trial(tmp_path, raw=None, events=None):
    directory = tmp_path / "run" / "trial"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "episode.json").write_text(json.dumps(metadata() if raw is None else raw))
    events = [event("model_output_parsed", 2, decision="finish", model_said_finish=True)] if events is None else events
    (directory / "events.jsonl").write_text("".join(json.dumps(row) + "\n" for row in events))
    return directory


def test_trial_and_eval_api_expose_the_same_field(tmp_path):
    write_trial(tmp_path)
    stamp = datetime.now(timezone.utc).isoformat()
    record = {"schema": "capx-eval/1", "eval_id": "run", "status": "completed",
              "by": "demo", "changed": "", "baseline_eval_id": "base", "eval_set": None,
              "git": None, "started_at": stamp, "heartbeat_at": stamp, "ended_at": stamp,
              "end": {"exit_code": 0, "signal": None}, "summary": evals.aggregate_episodes([])}
    (tmp_path / "run" / "eval.json").write_text(json.dumps(record))
    base = tmp_path / "base"
    (base / "baseline-trial").mkdir(parents=True)
    (base / "eval.json").write_text(json.dumps({**record, "eval_id": "base", "baseline_eval_id": None}))
    (base / "baseline-trial" / "episode.json").write_text(json.dumps(metadata(harness_summary={"task_completed": True})))
    # Call the registered synchronous endpoints: these checks need no server socket.
    trial_router = create_trace_router(tmp_path, viewer_only=True, expose=False, runner_roots=[])
    eval_router = create_eval_router(tmp_path)
    trial_route = next(route for route in trial_router.routes if route.path == "/api/traces/runs/{run_id}/episodes/{episode_id}")
    eval_route = next(route for route in eval_router.routes if route.path == "/api/evals/{eval_id}")
    trial_response = trial_route.endpoint(run_id="run", episode_id="trial")
    eval_response = eval_route.endpoint(eval_id="run")
    assert trial_response.status_code == eval_response.status_code == 200
    trial, comparison = json.loads(trial_response.body), json.loads(eval_response.body)
    assert trial["end_classification"] == comparison["trials"][0]["end_classification"]
    assert trial["end_classification"]["reason"] == "finish_unmet"
    assert trial["end_classification"]["evidence"]["event_id"] == "e2"
    assert comparison["baseline_trials"][0]["end_classification"]["reason"] == "success"


def test_generated_demo_uses_the_same_verdict_and_classifier(demo_root):
    detail = reader.run_detail(demo_root, RUN_ID)
    trial = next(row for row in detail["episodes"] if row["episode_id"] == EPISODE_ENDED)
    with reader.Dir.open_below(demo_root, [RUN_ID, EPISODE_ENDED]) as opened:
        result = reader.trial_end_classification_at(opened, trial, detail["runner_records"])
    assert result["reason"] == "success"
    assert result["evidence"]["source"] == "runner_record"
    assert result["evidence"]["event_id"]


def test_cache_invalidates_on_append_metadata_and_runner_changes(tmp_path, monkeypatch):
    directory = write_trial(tmp_path)
    calls = []
    original = reader.read_events_page

    def read(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)

    monkeypatch.setattr(reader, "read_events_page", read)
    with reader.Dir.open_root(directory) as opened:
        trial = reader.episode_summary("run", directory)
        assert reader.trial_end_classification_at(opened, trial)["reason"] == "finish_unmet"
        assert reader.trial_end_classification_at(opened, trial)["reason"] == "finish_unmet"
        assert len(calls) == 1
        with (directory / "events.jsonl").open("a") as output:
            output.write(json.dumps(event("model_output_parsed", 3, decision="regenerate")) + "\n")
        assert reader.trial_end_classification_at(opened, trial)["reason"] == "unknown"
        assert len(calls) == 2
        (directory / "episode.json").write_text(json.dumps(metadata(harness_summary={"task_completed": True})))
        trial = reader.episode_summary("run", directory)
        assert reader.trial_end_classification_at(opened, trial)["reason"] == "success"
        records = [{"task": "cube", "condition": "M1", "seed": 7,
                    "attempts": [{"attempt_id": 1, "task_success": False}]}]
        assert reader.trial_end_classification_at(opened, trial, records)["reason"] == "unknown"
        assert len(calls) == 4


def test_torn_tail_and_events_symlink_are_not_evidence(tmp_path):
    directory = write_trial(tmp_path, events=[])
    (directory / "events.jsonl").write_text(json.dumps(event("model_output_parsed", 2, decision="finish", model_said_finish=True)))
    with reader.Dir.open_root(directory) as opened:
        assert reader.trial_end_classification_at(opened, reader.episode_summary("run", directory))["reason"] == "unknown"
    outside = tmp_path / "other-events.jsonl"
    outside.write_text(json.dumps(event("model_output_parsed", 2, decision="finish", model_said_finish=True)) + "\n")
    (directory / "events.jsonl").unlink()
    (directory / "events.jsonl").symlink_to(outside)
    with reader.Dir.open_root(directory) as opened:
        assert reader.trial_end_classification_at(opened, reader.episode_summary("run", directory))["reason"] == "unknown"


def test_cache_does_not_assign_a_stale_summary_to_new_metadata(tmp_path):
    directory = write_trial(tmp_path)
    old_summary = reader.episode_summary("run", directory)
    (directory / "episode.json").write_text(json.dumps(metadata(harness_summary={"task_completed": True})))
    with reader.Dir.open_root(directory) as opened:
        assert reader.trial_end_classification_at(opened, old_summary)["reason"] == "finish_unmet"
        new_summary = reader.episode_summary("run", directory)
        assert reader.trial_end_classification_at(opened, new_summary)["reason"] == "success"


@pytest.mark.parametrize("name,expected", [("END_CAUSE_LABELS", "END_CAUSE_LABELS")])
def test_typescript_cause_labels_match_python(name, expected):
    from capx_trace_viewer import end_reason
    source = Path(__file__).resolve().parents[1] / "web-ui/src/evals/failureReasons.ts"
    table = re.search(rf"export const {name}(?:\s*:[^=]+)?\s*=\s*\{{([^}}]*)\}}", source.read_text())
    assert table is not None
    assert dict(re.findall(r"(\w+)\s*:\s*['\"]([^'\"]*)['\"]", table[1])) == getattr(end_reason, expected)


@pytest.mark.parametrize("raw,events,code,limit,used", [
    (metadata(stop_context={"step_limit": 1000, "steps_used": 1000},
              harness_summary={"task_completed": False, "truncated": True}), [], "step_limit", 1000, 1000),
    (metadata(end_reason="timeout_alarm", stop_context={"trial_time_limit_s": 2400}, duration_s=2401),
     [], "trial_time_limit", 2400, 2401),
    (metadata(end_reason="code_timeout", stop_context={"code_time_limit_s": 180}),
     [event("code_block_end", 1, code_timeout=True, exec_duration_s=180.1)], "code_time_limit", 180, 180.1),
    (metadata(stop_context={"multiturn_limit": 10, "turns_used": 11}), [], "turn_limit", 10, 11),
    (metadata(stop_context={"regeneration_limit": 20},
              harness_summary={"task_completed": False, "num_regenerations": 20, "num_finishes": 0}),
     [event("model_output_parsed", 1, decision="regenerate")], "regeneration_limit", 20, 20),
    (metadata(), [event("model_output_parsed", 1, decision="finish", model_said_finish=True)],
     "finish_unmet", None, None),
    (metadata(end_reason="exception", exception={"type": "ValueError"}),
     [event("api_call_error", 1, status="error", name="move_to_joints", error_type="ValueError")],
     "execution_error", None, None),
    (metadata(end_reason="simulator_crash", exception={"type": "PhysicsError"}),
     [], "simulator_crash", None, None),
    (metadata(end_reason="stopped_by_user"), [], "manual_stop", None, None),
    (metadata(end_reason="cancelled_replaced"), [], "replaced", None, None),
    (metadata(end_reason="error", end_note="trial's own end was not recorded", harness_summary={}),
     [], "recording_incomplete", None, None),
    (metadata(), [], "unknown", None, None),
])
def test_each_concrete_cause(raw, events, code, limit, used):
    cause = classify_trial_end(summary(raw), events)["cause"]
    assert cause["code"] == code
    assert cause["limit"] == limit
    assert cause["used"] == used
    assert cause["explanation"]
    assert "evidence" in cause and "missing_evidence" in cause
    if code == "execution_error":
        assert cause["evidence"]["api_call_error.name"] == "move_to_joints"
        assert cause["evidence"]["exception.type"] == "ValueError"
        assert "ValueError" not in cause["explanation"]


def test_legacy_robosuite_truncation_has_observed_steps_but_no_invented_limit():
    raw = metadata(env={"low_level_class": "capx.envs.simulators.robosuite_nut_assembly.FrankaRobosuiteNutAssemblyVisual"})
    result = classify_trial_end(summary(raw), [event("code_block_end", 1, truncated=True, sim_step_range=[789, 1000])])
    assert result["cause"]["code"] == "step_limit"
    assert result["cause"]["used"] == 1000
    assert result["cause"]["limit"] is None  # Official pack is not proof of local configuration.
    assert result["cause"]["missing_evidence"]
    # A generic truncation outside the known simulator path doesn't identify the rule.
    assert classify_trial_end(summary(), [event("code_block_end", 1, truncated=True)])["cause"]["code"] == "unknown"


def test_official_condition_checks_use_recorded_settings_even_on_success():
    raw = metadata(task="nut_assembly", stop_context={"step_limit": 1500, "trial_time_limit_s": 2400},
                   harness_summary={"task_completed": True})
    result = classify_trial_end(summary(raw))
    assert result["reason"] == "success"
    assert [(d["field"], d["recorded"], d["official"]) for d in result["rule_differences"]] == [
        ("step_limit", 1500, 1000), ("trial_time_limit_s", 2400, None)]
    assert all(d["source"].startswith("https://github.com/matsuolab/") for d in result["rule_differences"])
    assert classify_trial_end(summary(metadata(task="nut_assembly")))["rule_differences"] == []
    assert classify_trial_end(summary(metadata(task="unknown_task", stop_context={"step_limit": 1})))["rule_differences"] == []


def test_job_timeout_requires_explicit_scheduler_evidence_and_unfinished_episode():
    evaluation = {"job": {"scheduler": "slurm", "job_id": "1234", "state": "TIMEOUT",
                          "ended_at": "2026-11-20T00:00:00Z", "time_limit_s": 3600}}
    result = classify_trial_end(summary({"status": "running"}), evaluation=evaluation)
    assert result["cause"]["code"] == "slurm_time_limit"
    assert result["cause"]["evidence"]["job.job_id"] == "1234"
    assert result["cause"]["evidence"]["job.ended_at"] == "2026-11-20T00:00:00Z"
    assert result["cause"]["limit"] == 3600
    # Earlier completed failures and abandoned episodes aren't blamed on a later job end.
    assert classify_trial_end(summary(), evaluation=evaluation)["cause"]["code"] != "slurm_time_limit"
    old = metadata(end_reason="error", end_note="left open", ended_wall_time=1, harness_summary={})
    assert classify_trial_end(summary(old), evaluation=evaluation)["cause"]["code"] == "recording_incomplete"
    signal_only = {"status": "interrupted", "end": {"exit_code": -15, "signal": 15},
                   "job": {"scheduler": "slurm", "job_id": "1234"}}
    assert classify_trial_end(summary({}), evaluation=signal_only)["cause"]["code"] == "recording_incomplete"


def test_unrelated_timeout_error_is_not_a_code_execution_deadline():
    result = classify_trial_end(summary(metadata(end_reason="exception", exception={"type": "TimeoutError"})))
    assert result["cause"]["code"] == "execution_error"


def test_final_recovered_api_error_does_not_replace_later_execution():
    events = [event("code_block_start", 1), event("api_call_error", 2, status="error", name="old_call", error_type="ValueError"),
              event("code_block_end", 3), event("code_block_start", 4),
              event("code_block_end", 5, status="error", exception={"type": "RuntimeError"})]
    cause = classify_trial_end(summary(), events)["cause"]
    assert cause["code"] == "execution_error"
    assert "old_call" not in cause["explanation"]
    assert cause["evidence"]["exception.type"] == "RuntimeError"


def test_open_failed_execution_may_recover_and_is_not_terminal():
    result = classify_trial_end(summary(metadata(status="open", end_reason=None)),
                                [event("code_block_end", 1, status="error", exception={"type": "ValueError"})])
    assert result["cause"]["code"] == "recording_incomplete"
    assert result["cause"]["missing_evidence"]


def test_truncated_with_counter_below_recorded_limit_is_not_reported_as_reached():
    raw = metadata(stop_context={"step_limit": 1000, "steps_used": 12},
                   harness_summary={"task_completed": False, "truncated": True})
    assert classify_trial_end(summary(raw))["cause"]["code"] == "unknown"
    raw["env"] = {"low_level_class": "capx.envs.simulators.robosuite_base.RobosuiteBaseEnv"}
    cause = classify_trial_end(summary(raw))["cause"]
    assert "12/1000" not in cause["explanation"]
    assert cause["missing_evidence"]


def test_regeneration_does_not_claim_an_unconsumed_recorded_budget():
    raw = metadata(stop_context={"regeneration_limit": 8},
                   harness_summary={"task_completed": False, "num_regenerations": 2, "num_finishes": 0})
    assert classify_trial_end(summary(raw), [event("model_output_parsed", 1, decision="regenerate")])["cause"]["code"] == "unknown"


def test_parser_fallback_finish_is_explained_without_a_literal_model_claim():
    parsed = event("model_output_parsed", 1, decision="finish", model_said_finish=False,
                   harness_reading="no REGENERATE -> finish", content_empty=False)
    result = classify_trial_end(summary(), [parsed])
    assert result["reason"] == "unknown"
    assert result["cause"]["code"] == "parser_finish"


def test_web_execution_timer_terminal_vs_recovered():
    timeout = event("code_execution_timeout", 2, code_timeout=True, code_time_limit_s=180)
    assert classify_trial_end(summary(), [timeout])["cause"]["code"] == "code_time_limit"
    finish = event("model_output_parsed", 3, decision="finish", model_said_finish=True)
    assert classify_trial_end(summary(), [timeout, finish])["cause"]["code"] == "finish_unmet"
    assert classify_trial_end(summary(metadata(status="open", end_reason=None)), [timeout])["cause"]["code"] == "recording_incomplete"


def test_old_trial_timeout_exception_recovers_effective_limit_and_official_difference():
    raw = metadata(task="two_arm_handover", end_reason="timeout_alarm", alarm_seen=True, duration_s=2402,
                   harness_summary=None, exception={"type": "TrialTimeout", "message": "Trial 402 exceeded 2400 seconds"})
    result = classify_trial_end(summary(raw))
    assert result["cause"]["code"] == "trial_time_limit"
    assert result["cause"]["limit"] == 2400
    assert result["cause"]["used"] == 2402
    assert result["cause"]["evidence"]["episode_end.exception.message"] == "Trial 402 exceeded 2400 seconds"
    assert result["cause"]["missing_evidence"] == []
    assert result["rule_differences"][0]["official"] is None
    raw["exception"]["type"] = "ValueError"
    assert classify_trial_end(summary(raw))["cause"]["limit"] is None


def test_incomplete_trace_can_report_evaluation_signal_without_guessing_its_origin():
    result = classify_trial_end(summary({"status": "running"}),
                                evaluation={"end": {"signal": 15}, "ended_at": "2026-11-20T00:00:00Z"})
    assert result["cause"]["code"] == "recording_incomplete"
    assert result["cause"]["evidence"]["eval.end.signal"] == 15
    assert "シグナル 15" in result["cause"]["explanation"]
    assert result["cause"]["missing_evidence"]


def test_api_scheduler_context_is_shared_and_cache_invalidates_after_annotation(tmp_path):
    from capx_trace_viewer.eval_api import EvalService
    write_trial(tmp_path, raw=metadata(status="running", end_reason=None, harness_summary=None), events=[])
    stamp = datetime.now(timezone.utc).isoformat()
    evaluation = {"schema": "capx-eval/1", "eval_id": "run", "status": "interrupted",
                  "by": "test", "changed": "", "baseline_eval_id": None, "eval_set": None,
                  "git": None, "started_at": stamp, "heartbeat_at": stamp, "ended_at": stamp,
                  "end": {"exit_code": -15, "signal": 15}, "summary": evals.aggregate_episodes([])}
    path = tmp_path / "run" / "eval.json"
    path.write_text(json.dumps(evaluation))
    service = EvalService(tmp_path)
    assert service.detail("run")["trials"][0]["end_classification"]["cause"]["code"] == "recording_incomplete"
    evaluation["job"] = {"scheduler": "slurm", "job_id": "1234", "state": "TIMEOUT", "ended_at": stamp}
    path.write_text(json.dumps(evaluation))
    expected = service.detail("run")["trials"][0]["end_classification"]
    assert expected["cause"]["code"] == "slurm_time_limit"
    router = create_trace_router(tmp_path, viewer_only=True, expose=False, runner_roots=[])
    route = next(r for r in router.routes if r.path == "/api/traces/runs/{run_id}/episodes/{episode_id}")
    actual = json.loads(route.endpoint(run_id="run", episode_id="trial").body)["end_classification"]
    assert actual == expected


def test_gateway_crash_fixed_message_identifies_voided_environment():
    raw = metadata(end_reason="exception", exception={"type": "GatewayError", "message": "environment crashed; episode voided"})
    result = classify_trial_end(summary(raw))
    assert result["cause"]["code"] == "simulator_crash"


@pytest.mark.parametrize("message", ["env_crash: environment crashed; episode voided",
                                    "gateway error [env_crash]: environment crashed; episode voided"])
def test_actual_public_crash_messages_override_truncation_and_void_success(message):
    raw = metadata(stop_context={"step_limit": 1000, "steps_used": 1000},
                   end_reason="exception", exception={"type": "GatewayError", "message": message},
                   harness_summary={"task_completed": True, "truncated": True})
    result = classify_trial_end(summary(raw))
    assert result["cause"]["code"] == "simulator_crash"
    assert result["cause"]["evidence"]["episode_voided"] is True
    assert result["verdict"] == "unknown"


def test_a_recovered_gateway_crash_is_not_an_unrelated_later_exception():
    events = [event("api_call_error", 1, status="error", message="gateway error [env_crash]: environment crashed; episode voided"),
              event("code_block_end", 2), event("model_output_parsed", 3, decision="regenerate")]
    result = classify_trial_end(summary(metadata(end_reason="exception", exception={"type": "ValueError", "message": "later"})), events)
    assert result["cause"]["code"] == "execution_error"


def test_final_sandbox_gateway_crash_is_identified_even_if_harness_truncates():
    raw = metadata(harness_summary={"task_completed": False, "truncated": True, "sandbox_rc": 1})
    events = [event("code_block_start", 1),
              event("api_call_error", 2, status="error", message="gateway error [env_crash]: environment crashed; episode voided"),
              event("code_block_end", 3, status="error", truncated=True)]
    assert classify_trial_end(summary(raw), events)["cause"]["code"] == "simulator_crash"


def test_horizon_counter_distinguishes_early_simulator_end_from_wrapper_limit():
    raw = metadata(stop_context={"step_limit": 1500, "steps_used": 900, "env_horizon": 1000, "horizon_steps_used": 1000},
                   harness_summary={"task_completed": False, "truncated": True})
    result = classify_trial_end(summary(raw))
    assert result["cause"]["code"] == "env_horizon"
    assert result["cause"]["limit"] == result["cause"]["used"] == 1000


def test_turn_budget_is_the_stop_rule_after_a_caught_final_sandbox_error():
    raw = metadata(stop_context={"multiturn_limit": 10, "turns_used": 11},
                   harness_summary={"task_completed": False, "sandbox_rc": 1})
    result = classify_trial_end(summary(raw), [event("code_block_end", 1, status="error", exception={"type": "ValueError"})])
    assert result["cause"]["code"] == "turn_limit"
    # An uncaught exception is still its own terminal cause.
    raw.update(end_reason="exception", exception={"type": "RuntimeError"})
    assert classify_trial_end(summary(raw))["cause"]["code"] == "execution_error"


def test_web_turn_bound_cites_the_web_runner():
    raw = metadata(stop_context={"multiturn_limit": 30, "turns_used": 31,
                                 "sources": {"multiturn_limit": "capx.web.async_trial_runner.MULTITURN_LIMIT"}})
    assert classify_trial_end(summary(raw))["cause"]["source"] == "capx/web/async_trial_runner.py:MULTITURN_LIMIT"


def test_scheduler_terminal_state_does_not_keep_a_stale_running_verdict():
    result = classify_trial_end(summary({"status": "running"}),
                                evaluation={"job": {"scheduler": "slurm", "state": "TIMEOUT"}})
    assert result["verdict"] == "unknown"


def test_terminal_event_corrects_stale_running_metadata_before_classifying_finish():
    raw = metadata(status="running", end_reason=None, harness_summary=None)
    events = [event("model_output_parsed", 1, decision="finish", model_said_finish=True),
              event("episode_end", 2, end_reason="completed", harness_summary={"task_completed": False})]
    result = classify_trial_end(summary(raw), events)
    assert result["cause"]["code"] == "finish_unmet"
    assert result["verdict"] == "failure"


@pytest.mark.parametrize("job", [{"state": []}, {"reason": {}}, {"unknown": True}, {"time_limit_s": True},
                                 {"scheduler": "other"}, {"ended_at": "no date"}])
def test_malformed_job_metadata_is_a_validation_error(job):
    with pytest.raises(evals.EvalValidationError):
        evals.validate_job_context(job)


def test_web_wait_timeout_is_not_erased_by_the_still_running_thread_finishing():
    events = [event("code_block_start", 1),
              event("code_execution_timeout", 2, code_timeout=True, code_time_limit_s=180),
              event("code_block_end", 3, exec_duration_s=190, truncated=True)]
    raw = metadata(harness_summary={"task_completed": False, "truncated": True})
    assert classify_trial_end(summary(raw), events)["cause"]["code"] == "code_time_limit"
    # A genuinely new execution or model decision can supersede a recovered timer.
    events.extend([event("code_block_start", 4), event("code_block_end", 5)])
    assert classify_trial_end(summary(), events)["cause"]["code"] != "code_time_limit"


def test_typescript_canonical_cell_vocabulary_matches_python():
    from capx_trace_viewer.end_reason import END_CAUSE_WORDS, END_CELL_LEGEND
    source = Path(__file__).resolve().parents[1] / "web-ui/src/evals/failureReasons.ts"
    content = source.read_text(encoding="utf-8")
    table = re.search(r"export const END_CAUSE_WORDS[^=]*=\s*\{(.*?)\n\}", content, re.S)
    assert table is not None
    entries = re.findall(r"[\"']?(\w+)[\"']?\s*:\s*\[\s*['\"]([^'\"]*)['\"],\s*['\"]([^'\"]*)['\"]\s*\]", table[1])
    assert {key: (word, explanation) for key, word, explanation in entries} == END_CAUSE_WORDS
    assert "Object.entries(END_CAUSE_WORDS)" in content
    assert "Object.values(END_CAUSE_WORDS)" in content
    assert set(END_CELL_LEGEND) == set(END_CELL_WORDS.values()) | {word for word, _ in END_CAUSE_WORDS.values()} | {"未判定", "実行中"}


def test_team_step_copy_distinguishes_recorded_and_official_limits(monkeypatch):
    from capx_trace_viewer import end_reason
    raw = metadata(task="nut_assembly", stop_context={"step_limit": 1000, "steps_used": 1000},
                   harness_summary={"task_completed": False, "truncated": True})
    cause = classify_trial_end(summary(raw))["cause"]
    assert cause["headline"] == "ステップ上限に到達（1000/1000 ステップ）"
    assert cause["explanation"] == "ロボットを 1000 ステップ動かした時点で打ち切られました。nut_assembly の公式の上限も 1000 です。"
    raw.pop("stop_context")
    raw["env"] = {"low_level_class": "capx.envs.simulators.robosuite_nut_assembly.FrankaRobosuiteNutAssemblyVisual"}
    cause = classify_trial_end(summary(raw), [event("code_block_end", 1, truncated=True, sim_step_range=[800, 1000])])["cause"]
    assert cause["limit"] is None
    assert cause["headline"] == "ステップ上限に到達（1000 ステップ）"
    assert "この記録には実際の上限値が残っていません（公式の上限は 1000）" in cause["explanation"]
    assert "1000/1000" not in cause["headline"]
    rules = {**end_reason._official_rules(), "tasks": {"nut_assembly": {"trial_steplimit": 1234}}}
    monkeypatch.setattr(end_reason, "_official_rules", lambda: rules)
    cause = classify_trial_end(summary(raw), [event("code_block_end", 1, truncated=True, sim_step_range=[800, 1000])])["cause"]
    assert "公式の上限は 1234" in cause["explanation"]


def test_observed_regenerations_are_known_even_when_limit_is_not():
    raw = metadata(harness_summary={"task_completed": False, "num_regenerations": 10, "num_finishes": 0})
    cause = classify_trial_end(summary(raw), [event("model_output_parsed", 1, decision="regenerate")])["cause"]
    assert cause["code"] == "unknown"
    assert cause["headline"] == "書き直し 10 回で終了（上限の設定は記録なし）"
    assert "10 回書き直して" in cause["explanation"]
    assert cause["limit"] is None


def test_condition_notes_are_gated_by_recorded_route_and_effective_settings():
    raw = metadata(task="libero_10_0", source="envs.runner", attempt_index=3,
                   stop_context={"step_limit": 4000, "trial_time_limit_s": 2400, "trial_attempt_limit": 3})
    differences = {row["field"]: row for row in classify_trial_end(summary(raw))["rule_differences"]}
    assert set(differences) == {"step_limit", "trial_time_limit_s", "success_timing", "trial_attempt_limit"}
    assert differences["step_limit"]["official"] == 8000
    assert "libero_10_0" in differences["step_limit"]["explanation"]
    assert "4000" in differences["step_limit"]["explanation"]
    assert "一度でも成功" in differences["success_timing"]["explanation"]
    assert "合計 3 回まで" in differences["trial_attempt_limit"]["explanation"]
    assert all(row["explanation"].endswith("。") and row["source"].startswith("https://github.com/matsuolab/") for row in differences.values())
    unrecorded = classify_trial_end(summary(metadata(task="libero_10_0")))["rule_differences"]
    assert not unrecorded
    # The public local success-check path can also be identified by its evaluator event.
    differences = classify_trial_end(summary(metadata()), [event("evaluator_result", 1, scope="code_block", source="CodeExecutionEnvBase.step")])["rule_differences"]
    assert [row["field"] for row in differences] == ["success_timing"]


def test_historical_retry_note_does_not_invent_effective_attempt_limit():
    raw = metadata(task="nut_assembly", source="envs.runner", attempt_index=2)
    differences = {row["field"]: row for row in classify_trial_end(summary(raw))["rule_differences"]}
    retry = differences["trial_attempt_limit"]
    assert retry["recorded"] is None
    assert "再実行の記録があり" in retry["explanation"]
    assert "既定は時間切れ時に合計3回まで" in retry["explanation"]
    assert "実際の上限設定は記録なし" in retry["explanation"]
    assert "この評価は時間切れの試行を" not in retry["explanation"]
    raw["attempt_index"] = 1
    assert "trial_attempt_limit" not in {row["field"] for row in classify_trial_end(summary(raw))["rule_differences"]}
