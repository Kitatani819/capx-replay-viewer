"""Sequential evaluation sessions: safe locks, explicit completion and restart evidence."""
from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import socket
import stat
from pathlib import Path
from typing import Any, Iterator, Sequence

from capx_trace_viewer import reader
from capx_trace_recorder.timeout import is_trial_alarm

LOCK_FILE = ".evaluation.lock"
CONTROL_FILE = "evaluation-control.json"
COMPLETED_FILE = "completed-trials.json"
CONTROL_SCHEMA = "capx-eval-control/1"


def trial_key(episode: dict[str, Any]) -> tuple[str, str | None, int] | None:
    task, condition, seed = (episode.get(name) for name in ("task", "condition", "seed"))
    if (not isinstance(task, str) or not task or len(task) > 200 or any(ord(char) < 32 for char in task)
            or type(seed) is not int or abs(seed) > 2 ** 53 - 1):
        return None
    if condition is not None and (not isinstance(condition, str) or len(condition) > 200
                                  or any(ord(char) < 32 for char in condition)):
        return None
    return task, condition, seed


def completed_trials(episodes: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    completed = set()
    for episode in episodes:
        key = trial_key(episode)
        raw = episode.get("episode") or {}
        if key is None or not isinstance(raw, dict):
            continue
        outcome = raw.get("trial_outcome")
        harness = raw.get("harness_summary") or {}
        if isinstance(outcome, dict) and outcome.get("source") in ("recorder_terminal", "evaluation_finalizer"):
            if type(outcome.get("task_success")) is bool and outcome.get("resumable") is False:
                completed.add(key)
        elif episode.get("status") in ("ended", "ended_with_gaps") and isinstance(harness, dict) and type(harness.get("task_completed")) is bool:
            if harness["task_completed"] is True or harness.get("budget_exhausted") is not True:
                completed.add(key)
    return [{"task": task, "condition": condition, "seed": seed}
            for task, condition, seed in sorted(completed, key=lambda key: (key[0], key[1] or "", key[2]))]


@contextlib.contextmanager
def lock(directory: reader.Dir) -> Iterator[None]:
    flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    fd = os.open(LOCK_FILE, flags, 0o660, dir_fd=directory.fd)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("evaluation lock is not a regular file")
        try:
            if os.name == "posix":
                import fcntl
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            else:
                import msvcrt
                if os.fstat(fd).st_size == 0:
                    os.write(fd, b"0")
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        except OSError as exc:
            if is_trial_alarm(exc):
                raise
            raise ValueError("this evaluation is already being written; run jobs sequentially") from None
        yield
    finally:
        os.close(fd)


def write_json(directory: reader.Dir, name: str, value: Any, *, mode: int = 0o660, preserve_mode: bool = False) -> None:
    # Keep every mutation relative to the directory whose lock is held. A symlink
    # swapped into the configured path cannot redirect a write outside that run.
    temporary = ".resume-" + os.urandom(8).hex() + ".tmp"
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode, dir_fd=directory.fd)
    try:
        if preserve_mode:
            os.fchmod(fd, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
            stream.write("\n")
        existing = directory.lstat(name)
        if existing is not None and not stat.S_ISREG(existing.st_mode):
            raise ValueError(f"{name} is not a regular file")
        os.replace(temporary, name, src_dir_fd=directory.fd, dst_dir_fd=directory.fd)
    finally:
        try:
            os.unlink(temporary, dir_fd=directory.fd)
        except FileNotFoundError:
            pass


def machine_id() -> str:
    try:
        boot = Path("/proc/sys/kernel/random/boot_id").read_bytes()
    except OSError as exc:
        if is_trial_alarm(exc):
            raise
        # The boot time is stable on macOS and changes after restart. If unavailable,
        # refuse positive verification rather than trust a PID on another boot.
        import subprocess
        try:
            boot = subprocess.check_output(["sysctl", "-n", "kern.boottime"], timeout=2, stderr=subprocess.DEVNULL)
        except (OSError, subprocess.SubprocessError) as exc:  # timeout-ok: evaluation supervisor only, never a trial thread
            if is_trial_alarm(exc):
                raise
            return ""
    return hashlib.sha256(socket.gethostname().encode() + b"\0" + boot).hexdigest()


def control(segment: int, child_pgid: int | None = None) -> dict[str, Any]:
    return {"schema": CONTROL_SCHEMA, "machine_id": machine_id(), "supervisor_pid": os.getpid(),
            "child_pgid": child_pgid, "segment": segment}


def stopped_process_group(directory: reader.Dir) -> bool:
    """A stale heartbeat alone never proves a GPU job has stopped."""
    value, error, _st = reader.read_json_at(directory, CONTROL_FILE, 4096)
    if error or not isinstance(value, dict) or value.get("schema") != CONTROL_SCHEMA or os.name != "posix":
        return False
    if not value.get("machine_id") or value["machine_id"] != machine_id():
        return False
    supervisor, group = value.get("supervisor_pid"), value.get("child_pgid")
    if type(supervisor) is not int or supervisor <= 1 or type(group) is not int or group <= 1:
        return False
    for pid, group_check in ((supervisor, False), (group, True)):
        try:
            (os.killpg if group_check else os.kill)(pid, 0)
        except ProcessLookupError:
            continue
        except (OSError, PermissionError) as exc:
            if is_trial_alarm(exc):
                raise
            return False
        return False
    return True


def same_revision(previous: Any, current: Any) -> bool:
    # The existing diff hash excludes untracked contents. Only committed, clean
    # checkouts can establish safe resume identity without a broader source bundle.
    return (isinstance(previous, dict) and isinstance(current, dict)
            and previous.get("dirty") is False and current.get("dirty") is False
            and previous.get("commit") == current.get("commit"))


def finalize_unobserved(trace_root: Path, run_id: str, *, details: dict[str, Any] | None = None) -> int:
    """Persist planned, unrun tuples as explicit failures without an episode_end."""
    if details is None:
        details = reader.run_detail(trace_root, run_id) or {}
    observed = {trial_key(episode) for episode in details.get("episodes", [])}
    count = 0
    with reader.Dir.open_below(trace_root, [run_id]) as run:
        planned, error, _st = reader.read_json_at(run, "planned-trials.json", 4 * 1024 * 1024)
        if error == "missing":
            return 0
        if error or not isinstance(planned, list) or len(planned) > 100_000:
            raise ValueError("cannot read the planned trial list")
        for item in planned:
            key = trial_key(item) if isinstance(item, dict) else None
            if key is None:
                raise ValueError("invalid planned trial tuple")
            if key in observed:
                continue
            digest = hashlib.sha256(json.dumps(key, ensure_ascii=True).encode()).hexdigest()[:24]
            episode_id = "unrun-" + digest
            try:
                os.mkdir(episode_id, 0o770, dir_fd=run.fd)
            except FileExistsError:
                pass
            with run.subdir(episode_id) as episode:
                existing, error, _st = reader.read_json_at(episode, "episode.json", 2 * 1024 * 1024)
                if error != "missing":
                    if (error or not isinstance(existing, dict) or existing.get("episode_id") != episode_id
                            or existing.get("run_id") != run_id or existing.get("source") != "evaluation_plan"
                            or trial_key(existing) != key):
                        raise ValueError("existing planned trial placeholder has a different identity")
                    observed.add(key)
                    continue
                # A killed atomic writer may leave its private temporary file.
                # Keep those remnants, but never claim an unrelated directory.
                for name in episode.names():
                    if (not re.fullmatch(r"\.resume-[0-9a-f]{16}\.tmp", name)
                            or not stat.S_ISREG(os.stat(name, dir_fd=episode.fd, follow_symlinks=False).st_mode)):
                        raise ValueError("existing planned trial placeholder has unrelated files")
                raw = {"episode_id": episode_id, "run_id": run_id, "task": key[0], "condition": key[1], "seed": key[2],
                       "source": "evaluation_plan", "status": "ended", "trace_complete": False,
                       "episode_end_written": False, "started_wall_time": 0, "attempt_index": 0, "eval_segment": 0,
                       "trial_outcome": {"task_success": False, "source": "evaluation_finalizer",
                                         "reason": "planned_unrun", "resumable": True}}
                write_json(episode, "episode.json", raw)
            observed.add(key)
            count += 1
    return count


def budget_usage(directory: reader.Dir, segment: int, ended_epoch: float | None,
                 ended_monotonic: float | None = None, *, used_before_s: float | None = None) -> dict[str, float] | None:
    """Charge active job time after the first simulator start, excluding queued gaps.

    On a lost supervisor, the exact active end is unknown. Conservatively consume
    its remaining budget instead of inventing extra time for the resumed job.
    """
    import math
    manifest, error, _st = reader.read_json_at(directory, "evaluation-budget.json", 4096)
    if error == "missing":
        return None
    if error or not isinstance(manifest, dict) or manifest.get("schema") != "capx-eval-budget/1":
        raise ValueError("invalid evaluation budget metadata")
    limit = manifest.get("limit_s")
    if type(limit) not in (int, float) or not math.isfinite(limit) or not 0 < limit <= 10 ** 9:
        raise ValueError("invalid evaluation budget limit")
    clock, error, _st = reader.read_json_at(directory, f"evaluation-clock-{segment}.json", 4096)
    if error == "missing":
        before = 0 if used_before_s is None else used_before_s
        if not 0 <= before <= limit:
            raise ValueError("invalid cumulative segment time")
        return {"limit_s": limit, "used_before_s": before, "used_s": limit - before if ended_epoch is None else 0}
    if error or not isinstance(clock, dict):
        raise ValueError("invalid segment budget clock")
    started, before, budget = clock.get("started_at"), clock.get("used_before_s", 0), clock.get("budget_s")
    if any(type(value) not in (int, float) or not math.isfinite(value) for value in (started, before, budget)):
        raise ValueError("invalid segment budget clock values")
    if started <= 0 or before < 0 or before > limit or budget != limit:
        raise ValueError("segment budget differs from the original budget")
    if used_before_s is not None and abs(before - used_before_s) > 1e-6:
        raise ValueError("segment clock does not match cumulative history")
    remaining = max(0, limit - before)
    elapsed = None if ended_epoch is None else ended_epoch - started
    mono = clock.get("started_monotonic")
    if (ended_monotonic is not None and type(mono) in (int, float) and math.isfinite(mono)
            and clock.get("machine_id") == machine_id() and machine_id()):
        elapsed = ended_monotonic - mono
    # A rolled-back wall clock cannot refund time to another segment.
    used = remaining if elapsed is None or elapsed < 0 else min(remaining, elapsed)
    return {"limit_s": limit, "used_before_s": before, "used_s": used}
