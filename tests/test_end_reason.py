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
