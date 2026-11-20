"""Bounded display metadata for failed evaluations, shared with the HTML index.

This module is standalone so recorder-only installations can show the same
failure reason as the viewer without importing its optional dependencies.
"""

from __future__ import annotations

from typing import Any


def _text(value: Any, limit: int) -> bool:
    return (isinstance(value, str) and bool(value.strip()) and len(value) <= limit
            and not any(ord(char) < 32 or ord(char) == 127 for char in value))


def evaluation_failure(record: Any) -> dict[str, Any] | None:
    """Project the optional recorder diagnostic; legacy/unknown values are absent."""
    summary = record.get("summary") if isinstance(record, dict) else None
    flags = summary.get("config_flags") if isinstance(summary, dict) else None
    value = flags.get("evaluation_failure") if isinstance(flags, dict) else None
    if (not isinstance(value, dict) or value.get("kind") not in ("infrastructure", "incomplete")
            or not _text(value.get("reason"), 512)):
        return None
    entries = value.get("infrastructure_failures", [])
    failures = []
    if isinstance(entries, list):
        for item in entries[:100]:
            if not isinstance(item, dict):
                continue
            task, seed, reason = (item.get(field) for field in ("task", "seed", "reason"))
            if ((task is None or _text(task, 200))
                    and (seed is None or type(seed) is int and abs(seed) <= 2 ** 53 - 1)
                    and _text(reason, 512)):
                failures.append({"task": task, "seed": seed, "reason": reason})
    count = value.get("count")
    count = count if type(count) is int and len(failures) <= count <= 1_000_000_000 else len(failures)
    return {"kind": value["kind"], "reason": value["reason"],
            "infrastructure_failures": failures, "count": count}


def preserve_evaluation_failure(summary: dict[str, Any], record: dict[str, Any]) -> dict[str, Any]:
    """Retain evaluation-level evidence when trial counts are rebuilt locally."""
    failure = evaluation_failure(record)
    if failure is None:
        return summary
    return {**summary, "config_flags": {**summary.get("config_flags", {}), "evaluation_failure": failure}}


def failure_description(failure: dict[str, Any]) -> str:
    """Plain text for status tooltips, including every recorded task and seed."""
    descriptions = []
    for item in failure["infrastructure_failures"]:
        context = [item["task"]] if item["task"] else []
        if item["seed"] is not None:
            context.append(f"seed {item['seed']}")
        descriptions.append("・".join([*context, item["reason"]]))
    text = " / ".join(descriptions) if descriptions else failure["reason"]
    omitted = failure["count"] - len(failure["infrastructure_failures"])
    return text + (f" / ほか {omitted} 件" if omitted > 0 else "")
