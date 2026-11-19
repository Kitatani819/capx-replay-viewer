"""The sole trial-end classifier: preserve coarse reasons, explain recorded causes.

Public pack values are comparisons, never substitutes for an unrecorded local
limit. A recovered call error and a scheduler signal alone are not terminal proof.
"""
from __future__ import annotations

from collections.abc import Iterable, Sequence
from functools import lru_cache
import json
import math
from pathlib import Path
import re
from typing import Any

from capx_trace_viewer import evals


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
# Literal TS mirrors in evals/failureReasons.ts; parity is tested.
END_CAUSE_LABELS = {
    "success": "成功", "step_limit": "ステップ上限に到達",
    "trial_time_limit": "1試行の時間制限を超過", "code_time_limit": "コード実行の時間切れ",
    "turn_limit": "ターンの上限に到達", "regeneration_limit": "書き直しの上限に到達",
    "finish_unmet": "「終わった」と答えたが未達成", "execution_error": "エラーで停止",
    "simulator_crash": "シミュレーターの異常終了", "slurm_time_limit": "評価ジョブが時間制限で打ち切られた",
    "manual_stop": "手動で停止", "replaced": "別の試行に置き換え",
    "recording_incomplete": "記録が途中で終わった", "unknown": "終了原因を特定できない",
    "parser_finish": "終了と解釈されたが未達成",
    "env_horizon": "環境のステップ期限に到達",
}
# One vocabulary for cell words and their explanations, mirrored in TypeScript.
END_CAUSE_WORDS = {
    "success": ("成功", "課題を達成"),
    "step_limit": ("ステップ上限", "ロボットを動かすステップ数の上限に到達"),
    "trial_time_limit": ("試行時間", "1試行の時間制限を超過"),
    "code_time_limit": ("実行時間", "1回のコード実行の時間制限を超過"),
    "turn_limit": ("ターン上限", "コードを実行する回数の上限に到達"),
    "regeneration_limit": ("書き直し上限", "コードを書き直す回数の上限に到達"),
    "finish_unmet": ("未達成", "モデルが「終わった」と答えたが課題は未達成"),
    "execution_error": ("エラー", "エラーで停止"),
    "simulator_crash": ("環境異常", "シミュレーターの異常終了"),
    "slurm_time_limit": ("ジョブ時間", "評価ジョブ全体の時間制限に到達"),
    "manual_stop": ("手動停止", "手動で停止"),
    "replaced": ("置き換え", "別の試行に置き換えて終了"),
    "recording_incomplete": ("記録中断", "試行の終了または成否を記録できなかった"),
    "unknown": ("不明", "終了原因を特定する記録が足りない"),
    "parser_finish": ("終了扱い", "続行の指示がなく終了と扱われたが課題は未達成"),
    "env_horizon": ("環境期限", "シミュレーター自身のステップ数の期限に到達"),
}
END_CAUSE_CELL_WORDS = {code: words[0] for code, words in END_CAUSE_WORDS.items()}
# Include compatibility words used when an older server has no detailed cause.
END_CELL_LEGEND = {
    **{word: label for label, word in END_REASON_WORDS.values()},
    **{word: explanation for word, explanation in END_CAUSE_WORDS.values()},
    "未判定": "成否が記録から分からない",
    "実行中": "試行を実行中",
}


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _number(value: Any) -> bool:
    return type(value) in (int, float) and 0 <= value <= 10 ** 18 and math.isfinite(value)


@lru_cache(maxsize=1)
def _official_rules() -> dict[str, Any]:
    return _dict(json.loads(Path(__file__).with_name("official_rules.json").read_text(encoding="utf-8")))


def _public_source(path: str) -> str:
    rules = _official_rules()
    return f"https://github.com/{rules['repository']}/blob/{rules['commit']}/{path.replace(':', '#L')}"


def _official_task(task: Any) -> dict[str, Any]:
    return _dict(_dict(_official_rules().get("tasks")).get(task)) if isinstance(task, str) else {}


def _fmt(value: Any) -> str:
    return str(int(value)) if _number(value) and value == int(value) else str(value) if _number(value) else "未記録"


def _rule_differences(task: Any, context: dict[str, Any], *,
                      local_block_checks: bool = False, observed_retry: bool = False) -> list[dict[str, Any]]:
    official = _official_task(task)
    differences = []
    step = context.get("step_limit")
    if official and _number(step) and step != official["trial_steplimit"]:
        differences.append({"field": "step_limit", "recorded": step,
                            "official": official["trial_steplimit"], "source": _public_source(official["source"]),
                            "explanation": f"{task} のステップ上限はこの評価では {_fmt(step)}、公式では {_fmt(official['trial_steplimit'])} です。"})
    # The pack's 300 seconds is a contribution to the job budget, not a per-trial alarm.
    trial = context.get("trial_time_limit_s")
    if _number(trial) and trial > 0:
        differences.append({"field": "trial_time_limit_s", "recorded": trial,
                            "official": None, "source": _public_source("docs/taskpacks.md:13"),
                            "explanation": f"この評価は1試行を {_fmt(trial)} 秒で打ち切りますが、公式には1試行ごとの時間制限はありません（評価全体の時間制限があります）。"})
    if local_block_checks:
        differences.append({"field": "success_timing", "recorded": None, "official": None,
                            "source": _public_source("capx/gateway/gateway.py:234"),
                            "explanation": "公式はロボットを動かす途中で一度でも成功すれば達成としますが、この評価はコードの実行が終わった時点でのみ判定するため、途中の成功が取り消されると失敗になります。"})
    attempts = context.get("trial_attempt_limit")
    if (_number(attempts) and attempts > 1) or observed_retry:
        sentence = (f"この評価は時間切れの試行を合計 {_fmt(attempts)} 回まで実行します" if _number(attempts) and attempts > 1 else
                    "この評価には再実行の記録があり（実際の上限設定は記録なし）、公開ランナーの既定は時間切れ時に合計3回までの実行です")
        differences.append({"field": "trial_attempt_limit", "recorded": attempts if _number(attempts) else None,
                            "official": None, "source": _public_source("capx/envs/runner.py:210"),
                            "explanation": f"{sentence}が、公式には1試行の時間制限も、それによる再実行もありません。"})
    return differences


def _cause_copy(code: str, reason: str, limit: Any, used: Any, task: Any,
                explanation: str | None, fields: dict[str, Any]) -> tuple[str, str]:
    """Team-facing copy stays separate from technical evidence and provenance."""
    headline = END_CAUSE_LABELS[code]
    if code == "step_limit":
        amount = (f"{_fmt(used)}/{_fmt(limit)} ステップ" if _number(used) and _number(limit) else
                  f"{_fmt(used)} ステップ" if _number(used) else f"上限 {_fmt(limit)} ステップ" if _number(limit) else "ステップ数は記録なし")
        headline += f"（{amount}）"
        sentence = (f"ロボットを {_fmt(used)} ステップ動かした時点で打ち切られました。" if _number(used) else
                    "ロボットを動かすステップ数の上限で打ち切られました。")
        official = _official_task(task).get("trial_steplimit")
        if not _number(limit):
            sentence += "この記録には実際の上限値が残っていません" + (f"（公式の上限は {_fmt(official)}）。" if _number(official) else "。")
        elif _number(official):
            sentence += f"{task} の公式の上限{'も' if official == limit else 'は'} {_fmt(official)} です。"
        return headline, sentence
    if code == "trial_time_limit":
        headline = f"1試行の時間制限（{_fmt(limit)} 秒）を超過" if _number(limit) else "1試行の時間制限を超過（上限は記録なし）"
        return headline, (f"1試行に使える {_fmt(limit)} 秒を超えたため、途中で打ち切られました。" if _number(limit) else
                          "1試行の時間制限を超えたため打ち切られました。この記録には制限秒数が残っていません。")
    if code in ("code_time_limit", "slurm_time_limit"):
        headline += f"（上限 {_fmt(limit)} 秒）" if _number(limit) else "（上限は記録なし）"
        return headline, ("1回のコード実行に使える時間を超えたため、途中で打ち切られました。" if code == "code_time_limit" else
                          "評価ジョブ全体に使える時間を超えたため、この試行も途中で打ち切られました。")
    if code == "env_horizon":
        headline += f"（{_fmt(used)}/{_fmt(limit)} ステップ）" if _number(used) and _number(limit) else ""
        return headline, "シミュレーター自身が定めたステップ数の期限に達したため、途中で打ち切られました。"
    if code == "turn_limit":
        headline += f"（初回を含め {_fmt(used)} 回のコード実行）" if _number(used) else ""
        return headline, f"コードの実行回数が、初回に加えて {_fmt(limit)} 回までという上限に達したため終了しました。"
    if code == "regeneration_limit" or code == "unknown" and reason == "regen_limit" and _number(used):
        headline = (f"書き直し {_fmt(used)} 回で終了（上限 {_fmt(limit)} 回）" if _number(limit) else
                    f"書き直し {_fmt(used)} 回で終了（上限の設定は記録なし）")
        return headline, (f"コードを {_fmt(used)} 回書き直して終了しました。" +
                          ("書き直し回数の上限に達しました。" if _number(limit) else "この記録には実際の上限設定と、次の実行に進まなかった理由が残っていません。"))
    sentences = {
        "success": "課題の達成が記録されています。",
        "finish_unmet": "モデルは「終わった」と答えましたが、課題の達成条件を満たしていませんでした。",
        "parser_finish": "モデルの回答に続行の指示がなかったため、終了として扱われました。課題は未達成です。",
        "execution_error": "プログラムの実行中にエラーが起き、試行が終了しました。",
        "simulator_crash": "シミュレーターで異常が起き、試行が終了しました。" + ("公式の評価ではこの試行は無効になりました。" if fields.get("episode_voided") is True else ""),
        "manual_stop": "手動の停止操作により、試行が終了しました。",
        "replaced": "別の試行を始めたため、この試行は終了しました。",
    }
    # Uncertainty and recorded process signals are already expressed in plain words.
    return headline, sentences.get(code, explanation or "終了原因を特定する記録が足りません。")


def classify_trial_end(episode: dict[str, Any], events: Iterable[dict[str, Any]] = (),
                       runner_records: Sequence[Any] = (), *,
                       evaluation: dict[str, Any] | None = None) -> dict[str, Any]:
    """Return a compatible coarse reason and a cause with auditable facts.

    ``limit`` is null when not recorded, even if an official/default value is
    known. ``missing_evidence`` explains uncertainty. Events are streamed once.
    An evaluation's scheduler TIMEOUT applies only to an unfinished episode.
    """
    raw = _dict(episode.get("episode"))
    end = decision = block = first_error = last_error = alarm = evaluator = code_timeout_event = None
    start_context: dict[str, Any] = {}
    start_source = raw.get("source")
    local_block_checks = start_source == "envs.runner"
    decision_order = block_order = last_error_order = block_start_order = code_timeout_order = -1
    for order, event in enumerate(events):
        if event.get("late") is True:
            continue
        data = _dict(event.get("data"))
        kind = event.get("event_type")
        if kind == "episode_start":
            start_context.update(_dict(data.get("stop_context")))
            start_source = data.get("source", start_source)
            local_block_checks |= start_source == "envs.runner"
        elif kind == "episode_end":
            end = event
        elif kind == "model_output_parsed" and data.get("decision") in ("finish", "regenerate"):
            decision, decision_order = event, order
        elif kind == "code_block_start":
            block_start_order = order
        elif kind == "code_block_end":
            block, block_order = event, order
        elif kind == "evaluator_result":
            if data.get("scope") == "episode":
                evaluator = event
            if data.get("source") == "CodeExecutionEnvBase.step":
                local_block_checks = True
        elif kind == "code_execution_timeout" and data.get("code_timeout") is True:
            code_timeout_event, code_timeout_order = event, order
        if data.get("alarm_timeout") is True or (kind == "episode_end" and data.get("alarm_seen") is True):
            alarm = alarm or event
        if kind in ("api_call_end", "api_call_error", "code_block_end", "service_call",
                    "service_call_error", "model_error") and (
            event.get("status") == "error" or data.get("exception") or data.get("error_type")
        ):
            first_error = first_error or event
            # Keep the specific call when code_block_end repeats its exception.
            if kind != "code_block_end" or last_error_order < block_start_order:
                last_error, last_error_order = event, order

    end_data, block_data = _dict(_dict(end).get("data")), _dict(_dict(block).get("data"))
    harness = {**_dict(raw.get("harness_summary")), **_dict(end_data.get("harness_summary"))}
    context = {**start_context, **_dict(raw.get("stop_context")),
               **_dict(harness.get("stop_context")), **_dict(end_data.get("stop_context"))}
    terminal_exception = _dict(end_data.get("exception")) or _dict(raw.get("exception"))
    legacy_alarm_limit = False
    # Old recorder versions retained the exact public runner exception, including
    # the effective alarm value. Recover that value, never the current default.
    if not _number(context.get("trial_time_limit_s")) and terminal_exception.get("type") == "TrialTimeout":
        message = terminal_exception.get("message")
        match = re.fullmatch(r"Trial -?\d+ exceeded (\d+(?:\.\d+)?) seconds", message) if isinstance(message, str) and len(message) < 200 else None
        if match and _number(float(match[1])):
            context["trial_time_limit_s"] = float(match[1])
            legacy_alarm_limit = True
    sources = _dict(context.get("sources"))
    def rule_source(field: str, fallback: str) -> str:
        source = sources.get(field)
        if isinstance(source, str) and source.startswith("capx."):
            module, _, constant = source.rpartition(".")
            return module.replace(".", "/") + ".py:" + constant
        # Attribute names describe observation provenance, not a public rule's location.
        return source if isinstance(source, str) and ".py" in source else fallback
    enriched = {**episode, "episode": {**raw, "harness_summary": harness}}
    end_reason = episode.get("end_reason") or end_data.get("end_reason")
    enriched["end_reason"] = end_reason
    if end is not None or end_reason:
        enriched["status"] = "ended"
    verdict, verdict_source = evals._verdict_and_source(enriched, runner_records)
    record, attempt, final = evals._runner_attempt(enriched, runner_records)
    outcome = _dict(record.get("outcome")) if record and final else {}
    attempt = attempt or {}
    runner_timeout = (attempt.get("status") in ("timeout", "timed_out")
                      or attempt.get("timed_out_in_sandbox") is True or outcome.get("timeout") is True)
    runner_error = attempt.get("status") == "error" or outcome.get("infrastructure_error") is True
    block_after_decision = block_order > decision_order
    failed_block = (block_data.get("exception") or block and block.get("status") == "error"
                    or type(harness.get("sandbox_rc")) is int and harness["sandbox_rc"] != 0)
    normally_failed = (enriched.get("status") in ("ended", "ended_with_gaps")
                       and verdict == "failure" and end_reason == "completed")
    differences = _rule_differences(episode.get("task"), context, local_block_checks=local_block_checks,
                                    observed_retry=start_source == "envs.runner" and _number(raw.get("attempt_index")) and raw["attempt_index"] > 1)

    def result(reason: str, source: str, event: dict[str, Any] | None = None, *,
               code: str | None = None, explanation: str | None = None, limit: Any = None,
               used: Any = None, rule_source: str | None = None, fields: dict[str, Any] | None = None,
               missing: Sequence[str] = (), **facts: Any) -> dict[str, Any]:
        evidence: dict[str, Any] = {"source": source, "event_id": event.get("event_id") if event else None}
        if event:
            data, refs = _dict(event.get("data")), _dict(event.get("refs"))
            turn = data.get("turn_index", refs.get("turn_index"))
            if type(turn) is int:
                evidence["turn_index"] = turn
        evidence.update(facts)
        code = code or ("execution_error" if reason == "error" else reason)
        headline, sentence = _cause_copy(code, reason, limit, used, episode.get("task"), explanation, fields or {})
        cause = {"code": code, "label": END_CAUSE_LABELS[code], "headline": headline,
                 "explanation": sentence,
                 "limit": limit, "used": used, "source": rule_source,
                 "evidence": fields or {}, "missing_evidence": list(missing)}
        effective_verdict = "unknown" if verdict == "running" and source == "scheduler" else verdict
        return {"reason": reason, "label": END_LABELS[reason], "evidence": evidence, "verdict": effective_verdict,
                "cause": cause, "rule_differences": differences}

    crash_flag = (context.get("env_crashed") is True or harness.get("env_crashed") is True
                  or outcome.get("env_crashed") is True)
    error_data = _dict(_dict(last_error).get("data"))
    crash_message = terminal_exception.get("message")
    def wire_message(message: Any) -> bool:
        return isinstance(message, str) and re.fullmatch(
            r"(?:(?:env_crash: |gateway error \[env_crash\]: ))?environment crashed; episode voided", message) is not None

    wire_crash = wire_message(crash_message) or (
        not terminal_exception and normally_failed and failed_block and block_after_decision
        and last_error_order >= block_start_order and any(wire_message(message) for message in
            (error_data.get("message"), _dict(error_data.get("cause")).get("message"))))
    if end_reason == "simulator_crash" or crash_flag or wire_crash:
        # The official env_crash signal voids the episode, even if it had already
        # reached success. The local path has no automatic refund.
        if wire_crash:
            verdict = "unknown"
        return result("error", "trace", end or last_error, code="simulator_crash",
                      explanation="シミュレーターの異常終了" + ("。公式 gateway が試行を無効化しました。" if wire_crash
                                     else "。ローカル経路では公式の試行返却処理は適用されません。"),
                      rule_source="capx/gateway/gateway.py:411",
                      fields={"env_crashed": True, "episode_voided": bool(wire_crash),
                              "exception.type": terminal_exception.get("type"),
                              "exception.message": crash_message or error_data.get("message")})
    if verdict == "success":
        return result("success", verdict_source, evaluator or end, task_success=True,
                      fields={f"{verdict_source}.task_success": True})
    if end_reason in ("stopped_by_user", "cancelled_replaced"):
        return result("timeout", "trace", end,
                      code="manual_stop" if end_reason == "stopped_by_user" else "replaced",
                      fields={"episode_end.end_reason": end_reason}, end_reason=end_reason)

    end_note = end_data.get("end_note") or raw.get("end_note")
    abandoned = (end_reason == "error" and end_note and not raw.get("exception")
                 and not end_data.get("exception") and not runner_error)
    job = {**_dict(context.get("job")), **_dict(_dict(evaluation).get("job"))}
    # SIGTERM/exit 143 does not prove a Slurm time limit. Require explicit scheduler state.
    job_timeout = job.get("scheduler") == "slurm" and (
        str(job.get("state", "")).upper() == "TIMEOUT" or job.get("reason") == "time_limit")
    job_end = evals._time(job.get("ended_at"))
    started = episode.get("start_wall_time", raw.get("started_wall_time"))
    predates_episode = _number(started) and job_end is not None and job_end < started
    episode_end = raw.get("ended_wall_time")
    ended_near_job = (_number(episode_end) and job_end is not None and abs(episode_end - job_end) <= 30)
    unfinished = (not end_reason or end_reason not in ("completed", "exception", "error", "timeout_alarm")
                  or bool(abandoned and ended_near_job))
    if job_timeout and unfinished and not predates_episode:
        fields = {f"job.{key}": value for key, value in job.items() if key != "sources"}
        return result("timeout", "scheduler", end, code="slurm_time_limit",
                      explanation=f"評価ジョブ {job.get('job_id', '（ID未記録）')} が時間制限で終了"
                                  + (f"（{job['ended_at']}）" if job.get("ended_at") else ""),
                      limit=job.get("time_limit_s"), rule_source="Slurm job state", fields=fields,
                      missing=[f"job.{field}" for field in ("job_id", "ended_at", "time_limit_s") if field not in job])
    if unfinished and not predates_episode and job.get("reason") in ("user_cancelled", "replaced"):
        return result("timeout", "scheduler", end,
                      code="manual_stop" if job["reason"] == "user_cancelled" else "replaced",
                      fields={f"job.{key}": value for key, value in job.items()})

    if end_reason == "timeout_alarm" or raw.get("alarm_seen") is True or alarm or runner_timeout:
        limit = context.get("trial_time_limit_s")
        used = end_data.get("duration_s", raw.get("duration_s", attempt.get("duration_s")))
        fields = {"episode_end.end_reason": end_reason, "alarm_seen": bool(alarm or raw.get("alarm_seen"))}
        if runner_timeout:
            fields.update({f"runner_attempt.{k}": v for k, v in attempt.items()
                           if k in ("status", "timed_out_in_sandbox", "duration_s")})
        if _number(limit):
            fields["stop_context.trial_time_limit_s"] = limit
            if legacy_alarm_limit:
                fields.pop("stop_context.trial_time_limit_s")
                fields["episode_end.exception.message"] = terminal_exception["message"]
        if _number(used):
            fields["duration_s"] = used
        return result("timeout", "runner_record" if runner_timeout else "trace", alarm or end,
                      code="trial_time_limit", limit=limit, used=used,
                      rule_source=rule_source("trial_time_limit_s", "capx/envs/runner.py:TRIAL_TIMEOUT_SECONDS"),
                      explanation=f"1試行の時間制限 {limit} 秒を超過" if _number(limit) else "1試行の時間制限を超過（制限秒数は未記録）",
                      fields=fields, missing=[] if _number(limit) else ["stop_context.trial_time_limit_s"],
                      end_reason=end_reason)

    terminal_code_timeout = (code_timeout_event is not None and normally_failed
                             and code_timeout_order > decision_order and code_timeout_order > block_start_order)
    if terminal_code_timeout:
        # asyncio.wait_for does not stop the worker thread. A later end event for
        # the same execution cannot erase the timer that stopped the web runner.
        timeout_data = _dict(code_timeout_event.get("data"))
        limit = context.get("code_time_limit_s", timeout_data.get("code_time_limit_s"))
        return result("timeout", "trace", code_timeout_event, code="code_time_limit", limit=limit,
                      used=block_data.get("exec_duration_s"),
                      explanation="コード実行の時間切れ" + (f"（上限 {limit} 秒）" if _number(limit) else "（上限秒数は未記録）"),
                      rule_source=rule_source("code_time_limit_s", "capx/web/async_trial_runner.py:500"),
                      fields={f"code_execution_timeout.{key}": value for key, value in timeout_data.items()},
                      missing=[] if _number(limit) else ["stop_context.code_time_limit_s"])

    truncated = harness.get("truncated") is True or (block_after_decision and block_data.get("truncated") is True)
    step_limit, used_steps = context.get("step_limit"), context.get("steps_used")
    if not _number(used_steps) and _number(_dict(end).get("sim_step")):
        used_steps = end["sim_step"]
    if not _number(used_steps):
        step_range = block_data.get("sim_step_range")
        if isinstance(step_range, list) and len(step_range) == 2 and _number(step_range[1]):
            used_steps = step_range[1]
    env = _dict(raw.get("env"))
    robosuite = str(env.get("low_level_class", "")).startswith("capx.envs.simulators.robosuite")
    simulator_source = "capx/envs/simulators/robosuite_base.py"
    low_class = env.get("low_level_class")
    if isinstance(low_class, str) and re.fullmatch(r"capx\.envs\.simulators\.robosuite\w*\.\w+", low_class):
        simulator_source = low_class.rsplit(".", 1)[0].replace(".", "/") + ".py"
    step_reached = (_number(step_limit) and step_limit > 0 and _number(used_steps) and used_steps >= step_limit)
    contradictory_steps = _number(step_limit) and _number(used_steps) and not step_reached
    horizon, horizon_used = context.get("env_horizon"), context.get("horizon_steps_used")
    if truncated and not step_reached and _number(horizon) and horizon > 0 and _number(horizon_used) and horizon_used >= horizon:
        return result("timeout", "trace", block or end, code="env_horizon", limit=horizon, used=horizon_used,
                      explanation=f"シミュレーターの horizon {horizon} に到達（{horizon_used}/{horizon} ステップ）",
                      rule_source=rule_source("env_horizon", simulator_source),
                      fields={"stop_context.env_horizon": horizon, "stop_context.horizon_steps_used": horizon_used,
                              "stop_context.steps_used": used_steps, "truncated": True})
    if truncated and (robosuite or step_reached) and not contradictory_steps:
        fields = {"harness_summary.truncated": harness.get("truncated"),
                  "code_block_end.truncated": block_data.get("truncated"),
                  "steps_used": used_steps, "step_limit": step_limit}
        if block_data.get("sim_step_range") is not None:
            fields["code_block_end.sim_step_range"] = block_data["sim_step_range"]
        missing = []
        if not _number(step_limit):
            missing.append("stop_context.step_limit（実際に適用された max_steps / horizon）")
        if not _number(used_steps):
            missing.append("stop_context.steps_used")
        explanation = (f"ステップ上限 {step_limit} に到達（{used_steps}/{step_limit} ステップ）"
                       if _number(step_limit) and _number(used_steps) else
                       f"ステップ側の打ち切り（{used_steps} ステップ、上限値は未記録）" if _number(used_steps) else
                       "ステップ側の打ち切り（上限値・使用ステップ数は未記録）")
        return result("timeout", "trace", block if block_data.get("truncated") else end,
                      code="step_limit", explanation=explanation, limit=step_limit, used=used_steps,
                      rule_source=rule_source("step_limit", simulator_source),
                      fields=fields, missing=missing, end_reason=end_reason)
    if truncated:
        return result("timeout", "trace", block or end, code="unknown",
                      explanation="打ち切られた記録はありますが、ステップ数と時間のどちらの上限に達したかは分かりません。",
                      fields={"truncated": True}, missing=["stop_context.step_limit / steps_used", "打ち切った規則名"])

    if abandoned:
        return result("unknown", "recorder_closed_without_trial_end", end, code="recording_incomplete",
                      explanation="試行自身の終了を記録できず、次の試行が始まったときに記録を閉じました。停止の理由は未記録です。",
                      fields={"episode_end.end_note": end_note},
                      missing=["試行自身の episode_end / runner_attempt", "scheduler の終了状態（Slurm TIMEOUT 等）"])

    turns, turn_limit = context.get("turns_used"), context.get("multiturn_limit")
    turn_budget_exhausted = _number(turns) and _number(turn_limit) and turns >= turn_limit + 1
    terminal_error = (end_reason in ("exception", "error", "code_timeout", "execution_timeout", "simulator_crash")
                      or raw.get("exception") or end_data.get("exception") or runner_error
                      or crash_flag
                      or terminal_code_timeout
                      or normally_failed and failed_block and (block_after_decision or decision is None) and not turn_budget_exhausted)
    if terminal_error:
        error_event = last_error if last_error_order >= block_start_order else None
        error_data = _dict(_dict(error_event).get("data"))
        exception = (_dict(end_data.get("exception")) or _dict(raw.get("exception"))
                     or _dict(block_data.get("exception")))
        exception_type = exception.get("type") or error_data.get("error_type")
        if (exception.get("type") and error_data.get("error_type")
                and exception["type"] != error_data["error_type"]):
            error_data = {}  # An unrelated earlier call cannot explain this exception.
        fields = {"episode_end.end_reason": end_reason, "exception.type": exception_type}
        if isinstance(exception.get("message"), str):
            fields["exception.message"] = exception["message"]
        for key in ("name", "error_type", "message", "api_call_id", "service"):
            if key in error_data:
                fields[f"{error_event['event_type']}.{key}"] = error_data[key]
        code_timeout = (end_reason in ("code_timeout", "execution_timeout")
                        or block_data.get("code_timeout") is True or terminal_code_timeout)
        wire_crash = (error_data.get("code") == "env_crash" or error_data.get("error_code") == "env_crash"
                      or error_data.get("message") == "environment crashed; episode voided"
                      or exception.get("message") == "environment crashed; episode voided")
        simulator_crash = (end_reason == "simulator_crash" or crash_flag or wire_crash
                           or exception_type in ("mujoco.FatalError", "MujocoException", "PhysicsError", "EnvCrashedError"))
        if code_timeout:
            timeout_data = _dict(_dict(code_timeout_event).get("data"))
            limit = context.get("code_time_limit_s", timeout_data.get("code_time_limit_s"))
            fields.update({f"code_execution_timeout.{k}": v for k, v in timeout_data.items()})
            if _number(limit):
                fields["code_time_limit_s"] = limit
            if _number(block_data.get("exec_duration_s")):
                fields["code_block_end.exec_duration_s"] = block_data["exec_duration_s"]
            return result("timeout", "trace", code_timeout_event or block or end, code="code_time_limit", limit=limit,
                          used=block_data.get("exec_duration_s"), fields=fields,
                          rule_source=rule_source("code_time_limit_s", "capx/web/async_trial_runner.py:500"
                                                  if raw.get("source") == "web_ui" or code_timeout_event
                                                  else "recorded code_time_limit_s"),
                          missing=[] if _number(limit) else ["stop_context.code_time_limit_s"])
        return result("error", "runner_record" if runner_error else "trace" if end_reason in ("error", "exception") else "final_code_execution",
                      end or error_event or block, code="simulator_crash" if simulator_crash else "execution_error",
                      explanation=("シミュレーターの異常終了。公式 gateway では試行を無効化します。"
                                   if simulator_crash else "エラーで停止" +
                                   (f"（{error_data['name']}）" if error_data.get("name") else "") +
                                   (f"：{exception_type}" if exception_type else "（例外の種類は未記録）")),
                      rule_source="capx/gateway/gateway.py:411" if simulator_crash else None, fields=fields,
                      missing=[] if exception_type else ["終了した呼び出し / exception.type"],
                      end_reason=end_reason, sandbox_rc=harness.get("sandbox_rc"),
                      first_error_event_id=first_error.get("event_id") if first_error else None)

    if enriched.get("status") not in ("ended", "ended_with_gaps") or verdict != "failure" or end_reason != "completed":
        missing = ["試行自身の episode_end"] if not end or end_reason != "completed" else []
        if verdict not in ("success", "failure"):
            missing.append("runner_attempt.task_success / harness_summary.task_completed")
        if not missing:
            missing.append("終了を確定する記録")
        fields = {"status": episode.get("status"), "end_reason": end_reason}
        evaluation_end = _dict(_dict(evaluation).get("end"))
        signal = evaluation_end.get("signal")
        explanation = "試行の終了または成否の記録が欠けています。"
        if type(signal) is int and not end_reason:
            fields.update({"eval.end.signal": signal, "eval.ended_at": _dict(evaluation).get("ended_at")})
            explanation += f" 評価プロセスはシグナル {signal} で中断しました。"
            missing.append("中断の発生元 / scheduler の状態・job ID・終了理由")
        return result("unknown", "missing_terminal_evidence", code="recording_incomplete",
                      explanation=explanation, missing=missing, fields=fields)

    last_decision = _dict(_dict(decision).get("data"))
    if last_decision.get("decision") == "finish" and last_decision.get("model_said_finish") is True:
        return result("finish_unmet", "model_output_parsed", decision, task_success=False,
                      fields={"model_output_parsed.model_said_finish": True, "task_success": False})
    if (last_decision.get("decision") == "finish" and last_decision.get("model_said_finish") is False
            and last_decision.get("harness_reading") == "no REGENERATE -> finish"):
        return result("unknown", "model_output_parsed", decision, code="parser_finish",
                      explanation="回答に REGENERATE がなく、ハーネスが終了と解釈しました。課題は未達成です。",
                      rule_source="capx/utils/launch_utils.py:_parse_multi_turn_decision",
                      fields={"model_output_parsed.harness_reading": "no REGENERATE -> finish",
                              "model_output_parsed.model_said_finish": False, "task_success": False})
    turns, limit = context.get("turns_used"), context.get("multiturn_limit")
    # MULTITURN_LIMIT permits initial code plus N further executions (<= in trial.py).
    if _number(turns) and _number(limit) and turns >= limit + 1:
        return result("regen_limit", "stop_context", end, code="turn_limit", limit=limit, used=turns,
                      explanation=f"ターン上限 {limit}（初回を含め {turns} 回のコード実行）に到達",
                      rule_source=rule_source("multiturn_limit", "capx/envs/trial.py:51,916"),
                      fields={"stop_context.multiturn_limit": limit, "stop_context.turns_used": turns})
    regenerations = harness.get("num_regenerations")
    regeneration_limit = context.get("regeneration_limit")
    if (last_decision.get("decision") == "regenerate" and type(regenerations) is int and regenerations > 0
            and type(harness.get("num_finishes")) is int and harness["num_finishes"] == 0
            and (not _number(regeneration_limit) or regenerations >= regeneration_limit)
            and not (failed_block and block_after_decision)):
        return result("regen_limit", "harness_summary_and_last_decision", decision,
                      code="regeneration_limit" if _number(regeneration_limit) else "unknown",
                      limit=regeneration_limit, used=regenerations,
                      explanation=(f"書き直し上限 {regeneration_limit} に到達（{regenerations} 回）" if _number(regeneration_limit)
                                   else f"書き直し {regenerations} 回後に終了。適用上限と次のコードが実行されなかった理由は未記録です。"),
                      rule_source=rule_source("regeneration_limit", "capx/envs/trial.py:916"),
                      fields={"harness_summary.num_regenerations": regenerations, "harness_summary.num_finishes": 0,
                              "model_output_parsed.decision": "regenerate",
                              "stop_context.regeneration_limit": regeneration_limit},
                      missing=[] if _number(regeneration_limit) else ["stop_context.regeneration_limit / multiturn_limit"],
                      num_regenerations=regenerations, num_finishes=0, inferred=True)
    return result("unknown", "missing_terminal_evidence", end, code="unknown",
                  explanation="終了と失敗は記録されていますが、終了させた規則を特定できません。",
                  missing=["最終のモデル判断 / 適用されたターン・書き直し上限 / 終了した規則名"])
