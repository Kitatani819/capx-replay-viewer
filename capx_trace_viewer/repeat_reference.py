"""Conservative discovery of repeat runs from recorded code and effective settings.

Missing provenance is not equality. Usage counters, job IDs and service addresses
are not experimental settings; they are never returned in this reference.
"""
from __future__ import annotations

import json
from typing import Any

SETTING_KEYS = ("step_limit", "env_horizon", "trial_time_limit_s", "trial_attempt_limit",
                "code_time_limit_s", "multiturn_limit", "regeneration_limit",
                "success_policy", "evaluation_budget_s")


def record_key(record: dict[str, Any] | None) -> str | None:
    if not record or record.get("status") != "completed":
        return None
    git, summary = record.get("git"), record.get("summary")
    if not isinstance(git, dict) or type(git.get("dirty")) is not bool:
        return None
    if git["dirty"] and not git.get("diff_sha256"):
        return None
    if not isinstance(summary, dict) or summary.get("mixed") or summary.get("incomplete") or summary.get("unknown"):
        return None
    if not summary.get("models") or not summary.get("config_flags"):
        return None
    return json.dumps({"git": {key: git.get(key) for key in ("commit", "dirty", "diff_sha256")},
                       "eval_set": record.get("eval_set"),
                       **{key: summary.get(key) for key in ("models", "config_flags")}}, sort_keys=True)


def episode_settings(episodes: list[dict[str, Any]]) -> str | None:
    """Require unambiguous task/condition/seed and explicit effective limits.

    New recordings expose success_policy and the whole-evaluation budget. Older
    recordings without those facts cannot establish an equivalent rerun.
    """
    conditions = {}
    if not episodes:
        return None
    for episode in episodes:
        raw = episode.get("episode")
        if not isinstance(raw, dict) or episode.get("status") not in ("ended", "ended_with_gaps"):
            return None
        if episode.get("trace_complete") is not True:
            return None
        task, condition, seed = (episode.get(key) for key in ("task", "condition", "seed"))
        if not isinstance(task, str) or not task or (condition is not None and not isinstance(condition, str)) or type(seed) is not int:
            return None
        key = json.dumps([task, condition, seed])
        # Retries can have different stopping/selection semantics. Do not guess.
        if key in conditions:
            return None
        context = raw.get("stop_context")
        if not isinstance(context, dict) or not all(key in context for key in
                ("step_limit", "success_policy", "evaluation_budget_s", "trial_time_limit_s", "trial_attempt_limit")):
            return None
        if context["success_policy"] not in ("per_cycle_sticky", "block_end"):
            return None
        env = raw.get("env")
        if not isinstance(env, dict) or not env.get("class") or not env.get("low_level_class"):
            return None
        if not raw.get("config_flags") or not isinstance(raw.get("models"), dict) or not raw["models"]:
            return None
        models = {key: {name: value for name, value in model.items() if name in ("model", "oracle_code")}
                  if isinstance(model, dict) else model for key, model in raw["models"].items()}
        conditions[key] = {"context": {key: context[key] for key in SETTING_KEYS if key in context},
                           "env": {key: env.get(key) for key in ("class", "low_level_class", "apis", "privileged")},
                           "config_flags": raw["config_flags"], "models": models}
    return json.dumps(conditions, sort_keys=True)
