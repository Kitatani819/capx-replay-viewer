"""Small, read-only snapshots of stopping conditions; never call a simulator API.

Only named numeric fields and scheduler provenance are retained. Absence means
unrecorded, rather than a guessed default. This module does not import CaP-X.
"""
from __future__ import annotations

import math
import datetime as dt
import os
import re
import sys
import time
from typing import Any, Mapping


def _fields(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    fields = getattr(value, "__dict__", None)
    return fields if isinstance(fields, dict) else {}


def _number(value: Any) -> int | float | None:
    if type(value) not in (int, float) or not 0 <= value <= 10 ** 18 or not math.isfinite(value):
        return None
    return value


def _duration(value: str | None) -> int | None:
    """SLURM_TIMELIMIT accepts minutes or [days-]hours:minutes:seconds."""
    if not value or len(value) > 40:
        return None
    if value.isdecimal():
        return int(value) * 60
    match = re.fullmatch(r"(?:(\d+)-)?(\d+):(\d{1,2})(?::(\d{1,2}))?", value)
    if not match:
        return None
    days, first, second, third = match.groups()
    if int(second) >= 60 or third is not None and int(third) >= 60:
        return None
    if third is None:
        return int(days or 0) * 86400 + int(first) * 60 + int(second)
    return int(days or 0) * 86400 + int(first) * 3600 + int(second) * 60 + int(third)


def job_context(environ: Mapping[str, str] | None = None) -> dict[str, Any]:
    """Read allowlisted job facts. A signal alone never establishes Slurm TIMEOUT.

    The CAPX_TRACE_JOB_* fields are explicit metadata from a scheduler integration
    (for example a post-run export); no scheduler commands or network calls run.
    """
    env = os.environ if environ is None else environ
    job: dict[str, Any] = {}
    job_id = env.get("SLURM_JOB_ID") or env.get("SLURM_JOBID")
    if job_id and re.fullmatch(r"[0-9][0-9_+.\-]{0,79}", job_id):
        job.update(scheduler="slurm", job_id=job_id)
    seconds = env.get("CAPX_TRACE_JOB_TIME_LIMIT_S")
    if seconds and seconds.isdecimal() and len(seconds) <= 12 and int(seconds) <= 1_000_000_000:
        job["time_limit_s"] = int(seconds)
    elif (duration := _duration(env.get("SLURM_TIMELIMIT"))) is not None and duration <= 1_000_000_000:
        job["time_limit_s"] = duration
    state = env.get("CAPX_TRACE_JOB_STATE")
    if state in {"TIMEOUT", "CANCELLED", "COMPLETED", "FAILED", "OUT_OF_MEMORY", "PREEMPTED", "NODE_FAIL"}:
        job["state"] = state
    ended = env.get("CAPX_TRACE_JOB_ENDED_AT")
    if ended and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})", ended):
        try:
            dt.datetime.fromisoformat(ended.replace("Z", "+00:00"))
        except ValueError:
            pass
        else:
            job["ended_at"] = ended
    # Keep reasons categorical, so this explicit provenance cannot leak log text.
    reason = env.get("CAPX_TRACE_JOB_REASON")
    if reason in {"time_limit", "user_cancelled", "replaced", "preempted", "infrastructure_error"}:
        job["reason"] = reason
    return job


def trial_context(env: Any, *, turns_used: int | None = None, include_usage: bool = True,
                  session: Any = None, model_turn_index: int | None = None) -> dict[str, Any]:
    """Snapshot actual loaded fields, including runtime overrides of public limits."""
    context: dict[str, Any] = {}
    sources: dict[str, str] = {}

    def add(name: str, value: Any, source: str) -> None:
        if (number := _number(value)) is not None:
            context[name] = number
            sources[name] = source

    low = _fields(env).get("low_level_env")
    fields = _fields(low)
    add("step_limit", fields.get("max_steps"), "low_level_env.max_steps")
    add("step_limit", fields.get("_capx_trial_steplimit"), "low_level_env._capx_trial_steplimit")
    if include_usage:
        add("steps_used", fields.get("_sim_step_count"), "low_level_env._sim_step_count")
        add("steps_used", fields.get("_capx_steps_used"), "low_level_env._capx_steps_used")
        if type(fields.get("_capx_success")) is bool:
            context["sticky_success"] = fields["_capx_success"]
    policy = fields.get("_capx_success_policy")
    if policy in ("per_cycle_sticky", "block_end"):
        context["success_policy"] = policy
    simulator = _fields(fields.get("robosuite_env"))
    add("env_horizon", simulator.get("horizon"), "low_level_env.robosuite_env.horizon")
    if include_usage:
        add("horizon_steps_used", simulator.get("timestep"), "low_level_env.robosuite_env.timestep")
    for module_name, constant, field in (
        ("capx.envs.runner", "TRIAL_TIMEOUT_SECONDS", "trial_time_limit_s"),
        ("capx.envs.runner", "MAX_TRIAL_RETRIES", "trial_attempt_limit"),
        ("capx.envs.trial", "MULTITURN_LIMIT", "multiturn_limit"),
    ):
        module = sys.modules.get(module_name)
        add(field, _fields(module).get(constant), f"{module_name}.{constant}")
    runner = _fields(sys.modules.get("capx.envs.runner"))
    add("evaluation_budget_s", runner.get("EVAL_BUDGET_SECONDS"), "capx.envs.runner.EVAL_BUDGET_SECONDS")
    started = _number(runner.get("EVAL_BUDGET_STARTED_AT"))
    if include_usage and started is not None and started > 0:
        before = _number(fields.get("_capx_evaluation_used_before_s"))
        if before is None:
            try:
                before = float(os.environ.get("CAPX_EVAL_USED_BUDGET_S", "0"))
            except ValueError:
                before = 0
            if _number(before) is None:
                before = 0
        mono = _number(fields.get("_capx_evaluation_started_monotonic"))
        elapsed = time.monotonic() - mono if mono is not None and mono > 0 else time.time() - started
        if elapsed >= 0:
            add("evaluation_elapsed_s", before + elapsed, "capx.envs.runner.EVAL_BUDGET_STARTED_AT")

    if session is not None:
        # Web trials have a different loop bound and a per-code-block timeout.
        context.pop("trial_time_limit_s", None)
        sources.pop("trial_time_limit_s", None)
        context.pop("trial_attempt_limit", None)
        sources.pop("trial_attempt_limit", None)
        add("code_time_limit_s", _fields(session).get("execution_timeout"), "session.execution_timeout")
        module = sys.modules.get("capx.web.async_trial_runner")
        context.pop("multiturn_limit", None)
        sources.pop("multiturn_limit", None)
        add("multiturn_limit", _fields(module).get("MULTITURN_LIMIT"), "capx.web.async_trial_runner.MULTITURN_LIMIT")
    if turns_used is not None:
        add("turns_used", turns_used, "recorder.n_code_blocks")
    if model_turn_index is not None:
        add("model_turn_index", model_turn_index, "recorder.turn_index")
    if (job := job_context()):
        context["job"] = job
    if sources:
        context["sources"] = sources
    return context
