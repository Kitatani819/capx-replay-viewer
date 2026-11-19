"""Evaluation records, verdicts and summaries (docs/eval-records-design.md).

This module also runs in the CaP-X environment: keep it standard-library only.
The attempt/time matching below mirrors web-ui/src/trace/runner.ts and outcome.ts.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
import re
import time
from pathlib import Path
from typing import Any, Sequence

from capx_trace_viewer import reader

SCHEMA = "capx-eval/1"
MAX_EVAL_BYTES = 256 * 1024
MAX_CODE_CHANGES_BYTES = 128 * 1024
MAX_CODE_DIFF_BYTES = 64 * 1024
CODE_CHANGES_FILE = "code_changes.json"
CODE_CHANGE_STATUSES = {"recorded", "no_baseline", "baseline_missing", "baseline_ambiguous", "baseline_git_missing",
                        "baseline_dirty", "current_git_missing", "git_unavailable", "write_failed"}
HEARTBEAT_STALE_S = 300
_MAX_ITEMS = 10_000
_COUNT_LIMIT = 1_000_000_000


class EvalValidationError(ValueError):
    """A malformed or oversized eval.json, safe to report alongside its run id."""


def _require(condition: bool, field: str) -> None:
    if not condition:
        raise EvalValidationError(f"invalid {field}")


def _text(value: Any, field: str, limit: int = 200, *, empty: bool = True) -> str:
    _require(isinstance(value, str) and len(value) <= limit and (empty or bool(value))
             and not any(ord(c) < 32 for c in value), field)
    return value


def _count(value: Any, field: str) -> None:
    _require(type(value) is int and 0 <= value <= _COUNT_LIMIT, field)


def _time(value: Any) -> float | None:
    if not isinstance(value, str) or not value or len(value) > 40:
        return None
    try:
        stamp = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        return stamp.timestamp() if stamp.tzinfo is not None else None
    except (ValueError, OverflowError, OSError):
        return None


def _json_value(value: Any, field: str, depth: int = 0) -> None:
    """Bound config flags, including the recorder's small oracle-code metadata."""
    _require(depth <= 4, field)
    if value is None or type(value) is bool:
        return
    if type(value) in (int, float):
        _require(abs(value) <= 10 ** 18 and (type(value) is int or math.isfinite(value)), field)
    elif isinstance(value, str):
        _text(value, field, 512)
    elif isinstance(value, list):
        _require(len(value) <= 128, field)
        for item in value:
            _json_value(item, field, depth + 1)
    elif isinstance(value, dict):
        _require(len(value) <= 128, field)
        for key, item in value.items():
            _text(key, field, empty=False)
            _json_value(item, field, depth + 1)
    else:
        _require(False, field)


def validate_eval_record(value: Any, *, eval_id: str | None = None) -> dict[str, Any]:
    """Return a checked record, or raise EvalValidationError with a bounded reason.

    Unknown fields are refused rather than passed through to the API. The on-disk
    schema is intentionally small; command lines, endpoints and paths do not belong
    in evaluation records.
    """
    try:
        encoded = json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (ValueError, TypeError, RecursionError, UnicodeError):
        raise EvalValidationError("invalid JSON value") from None
    _require(len(encoded) <= MAX_EVAL_BYTES, "file size (maximum 256 KiB)")
    fields = {"schema", "eval_id", "status", "end", "by", "changed", "baseline_eval_id",
              "eval_set", "git", "started_at", "heartbeat_at", "ended_at", "summary"}
    _require(isinstance(value, dict) and fields.issubset(value)
             and set(value).issubset(fields | {"job", "code_changes"}), "record fields")
    if "job" in value:
        validate_job_context(value["job"])
    if "code_changes" in value:
        validate_code_change_metadata(value["code_changes"])
    _require(value["schema"] == SCHEMA, "schema")
    _require(reader.is_valid_id(value["eval_id"]), "eval_id")
    _require(eval_id is None or value["eval_id"] == eval_id, "eval_id (run mismatch)")
    _require(value["status"] in ("running", "completed", "interrupted"), "status")
    _text(value["by"], "by")
    _text(value["changed"], "changed")
    baseline = value["baseline_eval_id"]
    _require(baseline is None or reader.is_valid_id(baseline), "baseline_eval_id")
    if value["eval_set"] is not None:
        _text(value["eval_set"], "eval_set")
    for field in ("started_at", "heartbeat_at"):
        _require(_time(value[field]) is not None, field)
    if value["ended_at"] is not None:
        _require(_time(value["ended_at"]) is not None, "ended_at")
    end = value["end"]
    if end is not None:
        _require(isinstance(end, dict) and {"exit_code", "signal"}.issubset(end)
                 and set(end).issubset({"exit_code", "signal", "workers_left_running"}), "end")
        _require(type(end["exit_code"]) is int and -255 <= end["exit_code"] <= 255, "end.exit_code")
        _require(end["signal"] is None or (type(end["signal"]) is int and 1 <= end["signal"] <= 255), "end.signal")
        if "workers_left_running" in end:
            _require(type(end["workers_left_running"]) is bool, "end.workers_left_running")
    if value["status"] == "running":
        _require(end is None and value["ended_at"] is None and value["summary"] is None, "running record")
    else:
        _require(end is not None and value["ended_at"] is not None and value["summary"] is not None, "finished record")
    git = value["git"]
    if git is not None:
        _require(isinstance(git, dict) and set(git).issubset({"commit", "dirty", "diff_sha256"})
                 and {"commit", "dirty"}.issubset(git), "git")
        _require(isinstance(git["commit"], str) and re.fullmatch(r"[0-9a-f]{40,64}", git["commit"]) is not None, "git.commit")
        _require(type(git["dirty"]) is bool or git["dirty"] is None, "git.dirty")
        diff = git.get("diff_sha256")
        _require((git["dirty"] and isinstance(diff, str) and re.fullmatch(r"[0-9a-f]{64}", diff) is not None)
                 or (not git["dirty"] and diff is None), "git.diff_sha256")
    changes = value.get("code_changes")
    if changes and changes["status"] == "recorded":
        _require(baseline is not None and git is not None and changes["current_commit"] == git["commit"],
                 "code_changes evaluation relation")
    summary = value["summary"]
    if summary is not None:
        _validate_summary(summary)
    return value


def validate_code_change_metadata(value: Any) -> dict[str, Any]:
    fields = {"status", "baseline_commit", "current_commit", "artifact", "sha256", "size_bytes",
              "files", "excluded_files", "untracked_files", "redacted"}
    _require(isinstance(value, dict) and set(value) == fields, "code_changes fields")
    _require(isinstance(value["status"], str) and value["status"] in CODE_CHANGE_STATUSES, "code_changes.status")
    for field in ("baseline_commit", "current_commit"):
        _require(value[field] is None or (isinstance(value[field], str)
                 and re.fullmatch(r"[0-9a-f]{40,64}", value[field]) is not None), f"code_changes.{field}")
    for field in ("files", "excluded_files", "untracked_files"):
        _count(value[field], f"code_changes.{field}")
    _require(value["files"] <= 100 and type(value["redacted"]) is bool, "code_changes bounds")
    if value["status"] == "recorded":
        _require(value["baseline_commit"] is not None and value["current_commit"] is not None
                 and value["artifact"] == CODE_CHANGES_FILE
                 and isinstance(value["sha256"], str) and re.fullmatch(r"[0-9a-f]{64}", value["sha256"]) is not None
                 and type(value["size_bytes"]) is int and 0 < value["size_bytes"] <= MAX_CODE_CHANGES_BYTES,
                 "code_changes artifact")
    else:
        _require(value["artifact"] is None and value["sha256"] is None and value["size_bytes"] is None
                 and value["files"] == 0, "code_changes unavailable")
    return value


def valid_code_path(path: Any) -> bool:
    """A bounded relative display path; never interpreted as a server filesystem path."""
    return (isinstance(path, str) and 0 < len(path) <= 240 and not path.startswith(("/", "-"))
            and "\\" not in path and not any(ord(c) < 32 or ord(c) == 127 for c in path)
            and all(part not in ("", ".", "..") for part in path.split("/")))


def validate_code_change_artifact(value: Any, metadata: dict[str, Any]) -> dict[str, Any]:
    _require(isinstance(value, dict) and set(value) == {"schema", "baseline_commit", "current_commit", "files"},
             "code changes artifact fields")
    _require(value["schema"] == "capx-code-changes/1"
             and value["baseline_commit"] == metadata["baseline_commit"]
             and value["current_commit"] == metadata["current_commit"], "code changes commits")
    _require(isinstance(value["files"], list) and len(value["files"]) == metadata["files"] <= 100,
             "code changes files")
    paths, size = set(), 0
    for item in value["files"]:
        _require(isinstance(item, dict) and set(item) == {"path", "diff"} and valid_code_path(item["path"])
                 and isinstance(item["diff"], str), "code changes file")
        _require(item["path"] not in paths, "code changes duplicate path")
        paths.add(item["path"])
        size += len(item["diff"].encode("utf-8"))
    _require(size <= MAX_CODE_DIFF_BYTES, "code changes diff size")
    return value


def decode_code_changes(data: bytes, metadata: dict[str, Any]) -> dict[str, Any]:
    validate_code_change_metadata(metadata)
    _require(len(data) == metadata["size_bytes"] and len(data) <= MAX_CODE_CHANGES_BYTES
             and hashlib.sha256(data).hexdigest() == metadata["sha256"], "code changes integrity")
    try:
        value = json.loads(data)
    except (ValueError, UnicodeError, RecursionError):
        raise EvalValidationError("invalid code changes JSON") from None
    return validate_code_change_artifact(value, metadata)


def validate_job_context(job: Any) -> None:
    """Allowlisted scheduler facts, including explicit post-run accounting imports."""
    _require(isinstance(job, dict) and set(job).issubset(
        {"scheduler", "job_id", "time_limit_s", "state", "ended_at", "reason"}), "job")
    if "scheduler" in job:
        _require(job["scheduler"] == "slurm", "job.scheduler")
    if "job_id" in job:
        _require(isinstance(job["job_id"], str)
                 and re.fullmatch(r"[0-9][0-9_+.\-]{0,79}", job["job_id"]) is not None, "job.job_id")
    if "time_limit_s" in job:
        _count(job["time_limit_s"], "job.time_limit_s")
    if "state" in job:
        _require(isinstance(job["state"], str) and job["state"] in {"TIMEOUT", "CANCELLED", "COMPLETED", "FAILED", "OUT_OF_MEMORY",
                                  "PREEMPTED", "NODE_FAIL"}, "job.state")
    if "ended_at" in job:
        _require(_time(job["ended_at"]) is not None, "job.ended_at")
    if "reason" in job:
        _require(isinstance(job["reason"], str) and job["reason"] in {"time_limit", "user_cancelled", "replaced", "preempted",
                                   "infrastructure_error"}, "job.reason")


def _validate_summary(summary: Any) -> None:
    counts = {"trials", "success", "failure", "unknown", "incomplete"}
    fields = counts | {"by_task", "tasks", "seeds", "models", "config_flags", "mixed", "verdict_sources"}
    _require(isinstance(summary, dict) and set(summary) == fields, "summary fields")
    for field in counts:
        _count(summary[field], f"summary.{field}")
    _require(summary["success"] + summary["failure"] + summary["unknown"] == summary["trials"]
             and summary["incomplete"] <= summary["trials"], "summary counts")
    for field in ("tasks", "seeds", "mixed"):
        _require(isinstance(summary[field], list) and len(summary[field]) <= _MAX_ITEMS, f"summary.{field}")
    for task in summary["tasks"]:
        _text(task, "summary.tasks", empty=False)
    for item in summary["mixed"]:
        _text(item, "summary.mixed", 256, empty=False)
    for seed in summary["seeds"]:
        _require(type(seed) is int and abs(seed) <= 2 ** 53 - 1, "summary.seeds")
    for field in ("by_task", "models", "config_flags", "verdict_sources"):
        _require(isinstance(summary[field], dict) and len(summary[field]) <= _MAX_ITEMS, f"summary.{field}")
        for key in summary[field]:
            _text(key, f"summary.{field} key", empty=False)
    for counts in summary["by_task"].values():
        _require(isinstance(counts, dict) and set(counts) == {"trials", "success"}, "summary.by_task")
        for key in counts:
            _count(counts[key], "summary.by_task")
        _require(counts["success"] <= counts["trials"], "summary.by_task")
    for model in summary["models"].values():
        _text(model, "summary.models", 512, empty=False)
    _json_value(summary["config_flags"], "summary.config_flags")
    for count in summary["verdict_sources"].values():
        _count(count, "summary.verdict_sources")


def read_local_evals(trace_root: Path) -> list[dict[str, Any]]:
    """Read run-level eval.json files, retaining errors and refusing symlinks."""
    try:
        root = reader.Dir.open_root(trace_root)
    except OSError:
        return []
    rows = []
    with root:
        for run_id in root.names():
            if not reader.is_valid_id(run_id):
                continue
            try:
                run = root.subdir(run_id)
            except OSError:
                continue
            with run:
                if run.lstat("eval.json") is None:
                    continue
                value, error, st = _read_eval_at(run)
                if error is None:
                    try:
                        validate_eval_record(value, eval_id=run_id)
                    except EvalValidationError as exc:
                        value, error = None, str(exc)
                rows.append({"run_id": run_id, "eval_json": value, "eval_json_error": error,
                             "eval_mtime": st.st_mtime if st is not None else None})
    return rows


def _read_eval_at(directory: reader.Dir) -> tuple[Any, str | None, Any]:
    """Unlike historical trace JSON, eval.json never accepts NaN or Infinity."""
    try:
        fd, st = directory.open_file("eval.json")
    except OSError as exc:
        return None, reader.open_failure_reason(exc), None
    try:
        if st.st_size > MAX_EVAL_BYTES:
            return None, f"too_large ({st.st_size} bytes)", st
        data = reader.pread_upto(fd, MAX_EVAL_BYTES + 1, 0)
        if len(data) > MAX_EVAL_BYTES:
            return None, f"too_large ({len(data)} bytes)", st

        def reject_constant(_name: str) -> Any:
            raise ValueError("non-finite JSON number")

        try:
            return json.loads(data.decode("utf-8"), parse_constant=reject_constant), None, st
        except (ValueError, UnicodeError, RecursionError):
            return None, "invalid_json", st
    except OSError as exc:
        return None, reader.open_failure_reason(exc), st
    finally:
        reader.close_quietly(fd)


def _number(value: Any) -> bool:
    return type(value) is int or (type(value) is float and math.isfinite(value))


def _js_truthy(value: Any) -> bool:
    if value is None or value is False:
        return False
    if type(value) in (int, float):
        return value != 0 and not (type(value) is float and math.isnan(value))
    if isinstance(value, str):
        return bool(value)
    return True  # Empty arrays/objects are truthy in JavaScript.


def _strict_equal(left: Any, right: Any) -> bool:
    # JavaScript ===: bool is not the integer 0/1, and objects compare by identity.
    if isinstance(left, (dict, list)) or isinstance(right, (dict, list)):
        return left is right
    if _number(left) and _number(right):
        return left == right
    return type(left) is type(right) and left == right


def _runner_attempt(episode: dict[str, Any], records: Sequence[Any]) -> tuple[dict[str, Any] | None, dict[str, Any] | None, bool]:
    missing = object()  # A runner's absent key is JS undefined, not episodeKeyOf's null.
    candidates = [record for record in records if isinstance(record, dict)
                  and _strict_equal(record.get("task", missing), episode.get("task"))
                  and _strict_equal(record.get("condition", missing), episode.get("condition"))
                  and (_strict_equal(record.get("seed", missing), episode.get("seed"))
                       or _strict_equal(record.get("trial", missing), episode.get("seed")))]
    index = episode.get("attempt_index")
    index = index if _number(index) else None
    start = episode.get("start_wall_time")

    def attempts(record: dict[str, Any]) -> list[dict[str, Any]]:
        values = record.get("attempts")
        return [a for a in values if isinstance(a, dict)] if isinstance(values, list) else []

    def matched(record: dict[str, Any], attempt: dict[str, Any] | None):
        all_attempts = attempts(record)
        final = all_attempts[-1] if all_attempts else None
        is_final = attempt is not None and final is not None and (
            attempt is final or (_number(attempt.get("attempt_id"))
                                 and _strict_equal(attempt.get("attempt_id"), final.get("attempt_id"))))
        return record, attempt, is_final

    if not _number(start):
        if len(candidates) != 1:
            return None, None, False
        all_attempts = attempts(candidates[0])
        attempt = (next((a for a in all_attempts if _strict_equal(a.get("attempt_id"), index)), None)
                   if index is not None else all_attempts[0] if len(all_attempts) == 1 else None)
        return matched(candidates[0], attempt)
    hits = []
    for record in candidates:
        for attempt in attempts(record):
            if index is not None and not _strict_equal(attempt.get("attempt_id"), index):
                continue
            started, ended = _time(attempt.get("started_at")), _time(attempt.get("ended_at"))
            if started is not None and ended is not None and started - 2 <= start <= ended + 2:
                hits.append((record, attempt))
                break
    return matched(*hits[0]) if len(hits) == 1 else (None, None, False)


def _verdict_and_source(episode: dict[str, Any], records: Sequence[Any]) -> tuple[str, str]:
    raw = episode.get("episode")
    explicit = raw.get("trial_outcome") if isinstance(raw, dict) else None
    terminal = (isinstance(explicit, dict) and explicit.get("source") in ("recorder_terminal", "evaluation_finalizer")
                and type(explicit.get("task_success")) is bool)
    if episode.get("status") == "running" and not terminal:
        return "running", "unknown"
    record, attempt, final = _runner_attempt(episode, records)

    def verdict(value: Any) -> str:
        return "success" if value is True else "failure" if value is False else "unknown"

    if attempt is not None and "task_success" in attempt:
        return verdict(attempt["task_success"]), "runner_record"
    outcome = record.get("outcome") if record is not None else None
    if final and _js_truthy(outcome):
        return verdict(outcome.get("task_success") if isinstance(outcome, dict) else None), "runner_record"
    if terminal:
        return verdict(explicit["task_success"]), explicit["source"]
    raw = episode.get("episode")
    summary = raw.get("harness_summary") if isinstance(raw, dict) else None
    if isinstance(summary, dict) and (episode.get("end_reason") == "completed"
                                     or (_number(summary.get("sandbox_rc")) and summary["sandbox_rc"] >= 0)):
        return verdict(summary.get("task_completed")), "harness_summary"
    return "unknown", "unknown"


def trial_verdict(episode_summary: dict[str, Any], runner_records: Sequence[Any] = ()) -> str:
    """Task outcome of this episode, with the same rules as TS episodeVerdict."""
    return _verdict_and_source(episode_summary, runner_records)[0]


def aggregate_episodes(episodes: Sequence[dict[str, Any]], runner_records: Sequence[Any] = ()) -> dict[str, Any]:
    """Aggregate attempts without recording individual trials, paths or endpoints."""
    summary: dict[str, Any] = {"trials": len(episodes), "success": 0, "failure": 0,
                               "unknown": 0, "incomplete": 0, "by_task": {}, "tasks": [],
                               "seeds": [], "models": {}, "config_flags": {}, "mixed": [],
                               "verdict_sources": {}}
    tasks, seeds = set(), set()
    models, flags = [], []
    for episode in episodes:
        verdict, source = _verdict_and_source(episode, runner_records)
        summary[verdict if verdict in ("success", "failure") else "unknown"] += 1
        summary["verdict_sources"][source] = summary["verdict_sources"].get(source, 0) + 1
        if episode.get("trace_complete") is False or episode.get("status") not in ("ended", "ended_with_gaps"):
            summary["incomplete"] += 1
        task, seed = episode.get("task"), episode.get("seed")
        if isinstance(task, str) and 0 < len(task) <= 200:
            tasks.add(task)
            counts = summary["by_task"].setdefault(task, {"trials": 0, "success": 0})
            counts["trials"] += 1
            counts["success"] += verdict == "success"
        if type(seed) is int and abs(seed) <= 2 ** 53 - 1:
            seeds.add(seed)
        raw = episode.get("episode")
        raw = raw if isinstance(raw, dict) else {}
        model_values = raw.get("models", {})
        model_names = {}
        if isinstance(model_values, dict):
            for key, model in model_values.items():
                name = model.get("model") if isinstance(model, dict) else model
                if isinstance(key, str) and 0 < len(key) <= 200 and isinstance(name, str) and 0 < len(name) <= 512:
                    model_names[key] = name
        models.append(model_names)
        config = raw.get("config_flags", {})
        try:
            _json_value(config, "config_flags")
            flags.append(config if isinstance(config, dict) else {})
        except EvalValidationError:
            flags.append({})
    summary["tasks"], summary["seeds"] = sorted(tasks), sorted(seeds)
    for target, values in (("models", models), ("config_flags", flags)):
        keys = sorted(set().union(*(set(v) for v in values)))
        for key in keys:
            all_values = [v.get(key) for v in values]
            encoded = [json.dumps(value, sort_keys=True) for value in all_values]
            if all(value == encoded[0] for value in encoded):
                if all_values[0] is not None:
                    summary[target][key] = all_values[0]
            else:
                summary["mixed"].append(f"models.{key}" if target == "models" else key)
    return summary


def summarize_run(trace_root: Path, run_id: str, *, now: float | None = None) -> dict[str, Any]:
    details = reader.run_detail(trace_root, run_id, now=now) or {}
    return aggregate_episodes(details.get("episodes", []), details.get("runner_records", []))


def display_status(record: dict[str, Any], *, now: float | None = None) -> str | None:
    if record["status"] == "running":
        now = time.time() if now is None else now
        heartbeat = _time(record["heartbeat_at"])
        return "running" if heartbeat is not None and now - heartbeat < HEARTBEAT_STALE_S else "interrupted"
    if record["status"] == "interrupted":
        return "interrupted"
    return "incomplete" if (record.get("summary") or {}).get("incomplete", 0) else None


def condition_differences(record: dict[str, Any], baseline: dict[str, Any]) -> list[dict[str, Any]]:
    differences = []
    for field in ("tasks", "seeds", "models", "config_flags", "eval_set"):
        current = record.get(field) if field == "eval_set" else (record.get("summary") or {}).get(field)
        previous = baseline.get(field) if field == "eval_set" else (baseline.get("summary") or {}).get(field)
        comparable_current = sorted(set(current)) if field in ("tasks", "seeds") and isinstance(current, list) else current
        comparable_previous = sorted(set(previous)) if field in ("tasks", "seeds") and isinstance(previous, list) else previous
        if json.dumps(comparable_current, sort_keys=True) != json.dumps(comparable_previous, sort_keys=True):
            differences.append({"field": field, "baseline": previous, "current": current})
    return differences
