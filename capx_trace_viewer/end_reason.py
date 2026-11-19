"""Infer trial endings from recorded facts, without treating code success as task success.

The recorder's parser defaults to finish even for an empty answer. Only its literal
``model_said_finish`` flag supports finish_unmet. Earlier, recovered call errors do
not explain why a trial stopped. These categories are deliberately conservative.
"""
from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Any

from capx_trace_viewer import evals


# Canonical long labels and compact table words; failureReasons.ts mirrors these.
END_REASON_WORDS = {
    "success": ("成功", "成功"),
    "error": ("エラーで停止", "エラー"),
    "timeout": ("時間切れ・打ち切り", "時間切れ"),
    "finish_unmet": ("「終わった」と答えたが未達成", "未達成"),
    "regen_limit": ("書き直しの上限", "上限"),
    "unknown": ("終わり方が不明", "不明"),
}
END_LABELS = {reason: words[0] for reason, words in END_REASON_WORDS.items()}
END_CELL_WORDS = {reason: words[1] for reason, words in END_REASON_WORDS.items()}


def classify_trial_end(episode: dict[str, Any], events: Iterable[dict[str, Any]] = (),
                       runner_records: Sequence[Any] = ()) -> dict[str, Any]:
    """Return ``{reason, label, evidence}``; this is the sole end-reason classifier.

    ``episode`` is a reader episode summary. A matched runner attempt takes priority
    for the task verdict, exactly as in evaluations. Explicit terminal signals may
    explain an exception/cutoff even when no task verdict could be written.
    """
    raw = episode.get("episode")
    raw = raw if isinstance(raw, dict) else {}
    end: dict[str, Any] | None = None
    decision: dict[str, Any] | None = None
    block: dict[str, Any] | None = None
    first_error: dict[str, Any] | None = None
    alarm: dict[str, Any] | None = None
    evaluator: dict[str, Any] | None = None
    decision_order = block_order = -1
    # Stream the trace once. None of its potentially large text/assets are retained.
    for order, event in enumerate(events):
        data = event.get("data")
        data = data if isinstance(data, dict) else {}
        kind = event.get("event_type")
        if kind == "episode_end":
            end = event
        elif kind == "model_output_parsed" and data.get("decision") in ("finish", "regenerate"):
            decision = event
            decision_order = order
        elif kind == "code_block_end":
            block = event
            block_order = order
        elif kind == "evaluator_result" and data.get("scope") == "episode":
            evaluator = event
        if data.get("alarm_timeout") is True or (kind == "episode_end" and data.get("alarm_seen") is True):
            alarm = alarm or event
        if first_error is None and kind in ("api_call_end", "api_call_error", "code_block_end", "service_call",
                                            "service_call_error", "model_error") and (
            event.get("status") == "error" or data.get("exception") or data.get("error_type")
        ):
            first_error = event

    end_data = end.get("data", {}) if end else {}
    end_data = end_data if isinstance(end_data, dict) else {}
    # episode.json intentionally retains fewer harness fields than episode_end.
    raw_harness, end_harness = raw.get("harness_summary"), end_data.get("harness_summary")
    harness = {**(raw_harness if isinstance(raw_harness, dict) else {}),
               **(end_harness if isinstance(end_harness, dict) else {})}
    enriched = {**episode, "episode": {**raw, "harness_summary": harness}}
    end_reason = episode.get("end_reason") or end_data.get("end_reason")
    enriched["end_reason"] = end_reason
    verdict, verdict_source = evals._verdict_and_source(enriched, runner_records)
    record, attempt, final = evals._runner_attempt(enriched, runner_records)
    outcome = record.get("outcome") if record and final else None
    outcome = outcome if isinstance(outcome, dict) else {}
    attempt = attempt or {}
    runner_timeout = (attempt.get("status") in ("timeout", "timed_out")
                      or attempt.get("timed_out_in_sandbox") is True or outcome.get("timeout") is True)
    runner_error = attempt.get("status") == "error" or outcome.get("infrastructure_error") is True

    def result(reason: str, source: str, event: dict[str, Any] | None = None, **facts: Any) -> dict[str, Any]:
        evidence: dict[str, Any] = {"source": source, "event_id": event.get("event_id") if event else None}
        if event:
            data = event.get("data") or {}
            refs = event.get("refs") or {}
            data = data if isinstance(data, dict) else {}
            refs = refs if isinstance(refs, dict) else {}
            turn = data.get("turn_index", refs.get("turn_index"))
            if type(turn) is int:
                evidence["turn_index"] = turn
        evidence.update(facts)
        return {"reason": reason, "label": END_LABELS[reason], "evidence": evidence}

    if verdict == "success":
        return result("success", verdict_source, evaluator or end, task_success=True)
    block_data = block.get("data", {}) if block else {}
    block_data = block_data if isinstance(block_data, dict) else {}
    block_after_decision = block_order > decision_order
    if (end_reason in ("timeout_alarm", "stopped_by_user", "cancelled_replaced")
            or raw.get("alarm_seen") is True or alarm
            or harness.get("truncated") is True
            or block_after_decision and block_data.get("truncated") is True
            or runner_timeout):
        return result("timeout", "runner_record" if runner_timeout else "trace",
                      alarm or (block if block_data.get("truncated") is True else end),
                      end_reason=end_reason)
    end_note = end_data.get("end_note") or raw.get("end_note")
    if (end_reason == "error" and end_note and not raw.get("exception")
            and not end_data.get("exception") and not runner_error):
        # The recorder closes abandoned episodes with an error and an end_note,
        # even though the trial's own ending was never recorded. An earlier
        # recovered API error does not establish what finally stopped this run.
        return result("unknown", "recorder_closed_without_trial_end", end)
    if (end_reason in ("exception", "error") or raw.get("exception") or end_data.get("exception")
            or runner_error):
        return result("error", "runner_record" if runner_error else "trace", end or first_error, end_reason=end_reason,
                      first_error_event_id=first_error.get("event_id") if first_error else None)
    # A still-running or incomplete record cannot establish a normal stopping reason.
    if episode.get("status") not in ("ended", "ended_with_gaps") or verdict != "failure":
        return result("unknown", "missing_terminal_evidence")
    if end_reason != "completed":
        return result("unknown", "missing_terminal_evidence")
    last_decision = decision.get("data", {}) if decision else {}
    # A failed final execution can stop a normally returned harness too. A later
    # FINISH/REGENERATE supersedes the error as the reason the run finally ended.
    failed_block = (block_data.get("exception") or block and block.get("status") == "error"
                    or type(harness.get("sandbox_rc")) is int and harness["sandbox_rc"] != 0)
    if failed_block and (block_after_decision or decision is None):
        return result("error", "final_code_execution", block or end,
                      sandbox_rc=harness.get("sandbox_rc"),
                      first_error_event_id=first_error.get("event_id") if first_error else None)
    if last_decision.get("decision") == "finish" and last_decision.get("model_said_finish") is True:
        return result("finish_unmet", "model_output_parsed", decision, task_success=False)
    # The harness returns normally with no finish after consuming its regeneration
    # budget. Require its counters and the final REGENERATE; a lone decision in a
    # cut-off trace or a later failed execution is insufficient.
    regenerations = harness.get("num_regenerations")
    if (last_decision.get("decision") == "regenerate" and type(regenerations) is int and regenerations > 0
            and type(harness.get("num_finishes")) is int and harness["num_finishes"] == 0
            and not (failed_block and block_after_decision)):
        return result("regen_limit", "harness_summary_and_last_decision", decision,
                      num_regenerations=regenerations, num_finishes=0, inferred=True)
    return result("unknown", "missing_terminal_evidence", end)
