"""Run one evaluation outside CaP-X and maintain its small eval.json record."""

from __future__ import annotations

import argparse
import contextlib
import copy
import datetime as dt
import getpass
import hashlib
import json
import os
import re
import signal
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Sequence

from capx_trace_viewer import evals, reader
from capx_trace_recorder.stop_context import job_context
from capx_trace_recorder import eval_resume

HEARTBEAT_INTERVAL_S = 60.0
WORKER_WAIT_TIMEOUT_S = 60.0
# Unused extension point for objects with publish(eval_record).
SINKS: list[Any] = []


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _publish(record: dict[str, Any], sinks: Sequence[Any]) -> None:
    for sink in sinks:
        try:
            sink.publish(copy.deepcopy(record))
        except Exception as exc:  # A destination must never change the command result.
            print(f"eval: sink failed ({type(exc).__name__})", file=sys.stderr)


def _git_commit(repo: Path) -> str | None:
    """Read Git files directly; importing store would register its fork handler."""
    try:
        git = repo / ".git"
        if git.is_file():
            text = git.read_text().strip()
            if not text.startswith("gitdir:"):
                return None
            git = repo / text.split(":", 1)[1].strip()
        head = (git / "HEAD").read_text().strip()
        if head.startswith("ref:"):
            ref = head.split(":", 1)[1].strip()
            common = git
            commondir = git / "commondir"
            if commondir.is_file():
                common = git / commondir.read_text().strip()
            for directory in (git, common):
                ref_path = directory / ref
                if ref_path.is_file():
                    head = ref_path.read_text().strip()
                    break
            else:
                for line in (common / "packed-refs").read_text().splitlines():
                    parts = line.split()
                    if len(parts) == 2 and parts[1] == ref:
                        head = parts[0]
                        break
        return head if re.fullmatch(r"[0-9a-f]{40,64}", head) else None
    except (OSError, UnicodeError, ValueError):
        return None


def git_revision(repo: Path, *, trust_repo: bool = False) -> dict[str, Any] | None:
    """Fingerprint the checkout, without saving its path, diff or command line."""
    git_env = {**os.environ, "GIT_OPTIONAL_LOCKS": "0"}

    def git(*args: str) -> bytes:
        result = subprocess.run(["git", "-c", "core.fsmonitor=false", "-C", str(repo), *args], capture_output=True, timeout=10, env=git_env)
        if result.returncode:
            raise OSError("git failed")
        return result.stdout

    try:
        with contextlib.ExitStack() as stack:
            if trust_repo:
                temporary = Path(stack.enter_context(tempfile.TemporaryDirectory(prefix="capx-eval-git-")))
                config = temporary / "config"
                value = (str(repo.resolve()).replace("\\", "\\\\").replace('"', '\\"')
                         .replace("\n", "\\n").replace("\t", "\\t").replace("\b", "\\b"))
                config.write_text(f'[safe]\n\tdirectory = "{value}"\n', encoding="utf-8")
                git_env["GIT_CONFIG_GLOBAL"] = str(config)
            commit = git("rev-parse", "HEAD").decode("ascii").strip()
            from capx_trace_recorder.code_changes import without_git_filters
            git_env.update(without_git_filters(git_env, git("config", "--null", "--name-only", "--list")))
            dirty = bool(git("status", "--porcelain", "--ignore-submodules=all"))
            revision: dict[str, Any] = {"commit": commit, "dirty": dirty}
            if dirty:
                revision["diff_sha256"] = hashlib.sha256(git("diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "HEAD")).hexdigest()
            return revision
    except (OSError, UnicodeError, ValueError, subprocess.TimeoutExpired):
        commit = _git_commit(repo)
        return {"commit": commit, "dirty": None, "diff_sha256": None} if commit else None


def _write_record(path: Path, record: dict[str, Any], *, initial: bool = False,
                  directory: reader.Dir | None = None) -> None:
    evals.validate_eval_record(record, eval_id=path.parent.name)
    data = (json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    if len(data) > evals.MAX_EVAL_BYTES:
        raise ValueError("eval.json exceeds 256 KiB")
    if directory is None:
        with reader.Dir.open_below(path.parent.parent, [path.parent.name]) as opened:
            return _write_record(path, record, initial=initial, directory=opened)
    if initial:
        fd = os.open("eval.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                     0o666, dir_fd=directory.fd)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
        return
    st = directory.file_stat("eval.json")
    if st is None:
        raise ValueError("eval.json is missing or is not a regular file")
    eval_resume.write_json(directory, "eval.json", record, mode=stat.S_IMODE(st.st_mode), preserve_mode=True)


def _warn_group_access(path: Path) -> None:
    if os.name != "posix":
        return
    try:
        readable = path.stat().st_mode & stat.S_IRGRP
        searchable = path.parent.stat().st_mode & stat.S_IXGRP
    except OSError:
        return
    if not readable or not searchable:
        print("eval: teammates will not see this evaluation in their viewer; use a group-readable "
              "umask such as 027 or a group-owned trace root with group read/search permissions",
              file=sys.stderr)


def _create_shared_root(path: Path) -> None:
    """Make a new team root writable by the group, independent of the umask."""
    try:
        path.mkdir(mode=0o2770, parents=True)
    except FileExistsError:
        if not path.is_dir():
            raise
    else:
        # mkdir's mode is filtered by the umask. Only change a root we created.
        path.chmod(0o2770)


def _wait_for_workers(pgid: int, timeout: float) -> bool:
    """Return whether the process group emptied before the deadline."""
    deadline = time.monotonic() + timeout
    while True:
        try:
            os.killpg(pgid, 0)
        except ProcessLookupError:
            return True
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        time.sleep(min(.1, remaining))


def finalize_trial_outcomes(trace_root: Path, run_id: str) -> int:
    """Score interrupted attempts only after all evaluation workers have stopped.

    The explicit marker distinguishes newly finalized attempts from historical
    missing results. Never follow a trace's symlinks or manufacture episode_end.
    """
    count = 0
    with reader.Dir.open_below(trace_root, [run_id]) as run:
        for name in run.names():
            if not reader.is_valid_id(name):
                continue
            try:
                directory = run.subdir(name)
            except OSError:
                continue
            with directory:
                raw, error, _st = reader.read_json_at(directory, "episode.json", 2 * 1024 * 1024)
                if error or not isinstance(raw, dict) or raw.get("episode_id") != name:
                    continue
                explicit = raw.get("trial_outcome")
                if isinstance(explicit, dict) and type(explicit.get("task_success")) is bool:
                    continue
                harness = raw.get("harness_summary")
                if (raw.get("episode_end_written") is True and isinstance(harness, dict)
                        and type(harness.get("task_completed")) is bool):
                    continue
                context = raw.get("stop_context") or {}
                recovered = reader.trial_end_classification_at(
                    directory, reader.episode_summary_from_metadata(run_id, name, raw))
                known = recovered.get("verdict") in ("success", "failure")
                success = (isinstance(harness, dict) and harness.get("task_completed") is True
                           or isinstance(context, dict) and context.get("success_policy") == "per_cycle_sticky"
                           and context.get("sticky_success") is True)
                if known:
                    success = recovered["verdict"] == "success"
                raw["trial_outcome"] = {"task_success": bool(success), "source": "evaluation_finalizer",
                                        "reason": "terminal_event_recovered" if known else "evaluation_interrupted",
                                        "resumable": not bool(success) and (
                                            not known or recovered.get("cause", {}).get("code") == "evaluation_budget")}
                temporary = f".outcome-{os.getpid()}-{time.time_ns()}"
                try:
                    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, stat.S_IMODE(_st.st_mode), dir_fd=directory.fd)
                    with os.fdopen(fd, "w", encoding="utf-8") as stream:
                        json.dump(raw, stream, ensure_ascii=True)
                        stream.write("\n")
                    os.replace(temporary, "episode.json", src_dir_fd=directory.fd, dst_dir_fd=directory.fd)
                    count += 1
                finally:
                    try:
                        os.unlink(temporary, dir_fd=directory.fd)
                    except FileNotFoundError:
                        pass
    return count


def job_end_main(words: Sequence[str] | None = None) -> int:
    """Import explicit scheduler facts after a killed evaluation cannot write them.

    Intended for an epilog/accounting integration. The command never guesses a
    scheduler state from the evaluation's exit signal and never reads job logs.
    """
    parser = argparse.ArgumentParser(prog="capx-trace-recorder job-end")
    parser.add_argument("--trace-root", required=True, type=Path)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--state", required=True, choices=("TIMEOUT", "CANCELLED", "COMPLETED", "FAILED",
                                                        "OUT_OF_MEMORY", "PREEMPTED", "NODE_FAIL"))
    parser.add_argument("--ended-at", required=True)
    parser.add_argument("--time-limit-s", type=int)
    parser.add_argument("--reason", choices=("time_limit", "user_cancelled", "replaced", "preempted",
                                           "infrastructure_error"))
    args = parser.parse_args(words)
    if not reader.is_valid_id(args.run_id):
        parser.error("invalid run id")
    provided = {"SLURM_JOB_ID": args.job_id, "CAPX_TRACE_JOB_STATE": args.state,
                "CAPX_TRACE_JOB_ENDED_AT": args.ended_at}
    if args.time_limit_s is not None:
        provided["CAPX_TRACE_JOB_TIME_LIMIT_S"] = str(args.time_limit_s)
    if args.reason:
        provided["CAPX_TRACE_JOB_REASON"] = args.reason
    job = job_context(provided)
    if "job_id" not in job or "ended_at" not in job or (args.time_limit_s is not None and "time_limit_s" not in job):
        parser.error("invalid job metadata")
    # Reject symlinks beneath the requested root, as the viewer does.
    try:
        with reader.Dir.open_root(args.trace_root) as root, root.subdir(args.run_id) as run:
            record, error, _stat = reader.read_json_at(run, "eval.json", evals.MAX_EVAL_BYTES)
        if error:
            raise ValueError("cannot read eval.json")
        evals.validate_eval_record(record, eval_id=args.run_id)
        previous = record.get("job") or {}
        if previous.get("job_id") not in (None, args.job_id):
            raise ValueError("job id differs from the recorded job")
        record["job"] = {**previous, **job}
        _write_record(args.trace_root / args.run_id / "eval.json", record)
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    return 0


def run_eval(command: Sequence[str], *, trace_root: Path, changed: str = "",
             baseline: str | None = None, eval_set: str | None = None, by: str = "",
             repo: Path | None = None, trust_repo: bool = False,
             shared_root: Path | None = None, resume: str | None = None,
             heartbeat_interval: float = HEARTBEAT_INTERVAL_S,
             worker_wait_timeout: float = WORKER_WAIT_TIMEOUT_S,
             sinks: Sequence[Any] | None = None) -> int:
    """Run one sequential segment; a resumed evaluation retains its original identity."""
    if heartbeat_interval <= 0:
        raise ValueError("heartbeat interval must be positive")
    if worker_wait_timeout < 0:
        raise ValueError("worker wait timeout must be nonnegative")
    if resume is not None and not reader.is_valid_id(resume):
        raise ValueError("--resume must be a valid evaluation ID")
    trace_root = Path(os.path.abspath(os.path.expanduser(trace_root)))
    sinks = SINKS if sinks is None else sinks
    moment = dt.datetime.now(dt.timezone.utc)
    eval_id = resume or f"ev-{moment.strftime('%Y%m%dT%H%M%SZ')}-{os.urandom(2).hex()}"
    started = _now()
    revision = git_revision(Path.cwd() if repo is None else repo, trust_repo=trust_repo)
    record = {"schema": evals.SCHEMA, "eval_id": eval_id, "status": "running", "end": None,
              "by": by, "changed": changed, "baseline_eval_id": baseline, "eval_set": eval_set,
              "git": revision, "started_at": started, "heartbeat_at": started, "ended_at": None, "summary": None}
    evals.validate_eval_record(record, eval_id=eval_id)
    if not resume:
        if shared_root is not None:
            _create_shared_root(Path(os.path.abspath(os.path.expanduser(shared_root))))
        trace_root.mkdir(parents=True, exist_ok=True)
        (trace_root / eval_id).mkdir()
    path = trace_root / eval_id / "eval.json"
    with reader.Dir.open_below(trace_root, [eval_id]) as directory, eval_resume.lock(directory):
        if not resume:
            from capx_trace_recorder.code_changes import capture_code_changes
            record["code_changes"] = capture_code_changes(Path.cwd() if repo is None else repo, trace_root, baseline,
                                                           record["git"], path.parent, trust_repo=trust_repo)
        completed = []
        history = []
        if resume:
            previous, error, _st = evals._read_eval_at(directory)
            if error:
                raise ValueError("cannot read the evaluation to resume")
            evals.validate_eval_record(previous, eval_id=eval_id)
            if not eval_resume.same_revision(previous.get("git"), revision):
                raise ValueError("resume requires the same known, clean Git commit; commit changes before starting an evaluation")
            for field, requested in (("by", by), ("changed", changed), ("baseline_eval_id", baseline), ("eval_set", eval_set)):
                if requested not in (None, "") and requested != previous[field]:
                    raise ValueError(f"cannot change {field} when resuming an evaluation")
            must_verify = previous["status"] == "running" or (previous.get("end") or {}).get("workers_left_running")
            if must_verify and not eval_resume.stopped_process_group(directory):
                raise ValueError("cannot verify that the previous supervisor and workers have stopped; a stale heartbeat is insufficient")
            if must_verify:
                finalize_trial_outcomes(trace_root, eval_id)
            details = reader.run_detail(trace_root, eval_id) or {}
            completed = eval_resume.completed_trials(details.get("episodes", []))
            prior_segments = previous.get("segments") or []
            prior_count = prior_segments[-1].get("completed_after") if prior_segments else None
            if type(prior_count) is int and len(completed) < prior_count:
                raise ValueError("completed trial records are missing; restore the recording before resuming")
            saved_done, saved_error, _st = reader.read_json_at(directory, eval_resume.COMPLETED_FILE, 4 * 1024 * 1024)
            if saved_error and prior_segments:
                raise ValueError("completed trial inventory is missing or unreadable")
            if saved_error is None:
                if not isinstance(saved_done, list) or any(not isinstance(item, dict) or eval_resume.trial_key(item) is None for item in saved_done):
                    raise ValueError("invalid completed trial inventory")
                if not {eval_resume.trial_key(item) for item in saved_done} <= {eval_resume.trial_key(item) for item in completed}:
                    raise ValueError("a previously completed tuple is missing from the recording")
            history = copy.deepcopy(previous.get("segments") or [{
                "index": 1, "status": previous["status"], "started_at": previous["started_at"],
                "ended_at": previous["ended_at"], "end": previous["end"], "completed_before": 0,
                "completed_after": len(completed), **({"job": previous["job"]} if "job" in previous else {}),
            }])
            cumulative_used = 0.0
            for prior_segment in history:
                if "budget" not in prior_segment:
                    stamp = evals._time(prior_segment["ended_at"])
                    usage = eval_resume.budget_usage(directory, prior_segment["index"], stamp, used_before_s=cumulative_used)
                    if usage is not None:
                        prior_segment["budget"] = usage
                cumulative_used += prior_segment.get("budget", {}).get("used_s", 0)
            if previous["status"] == "running":
                history[-1].update(status="interrupted", end=None, ended_at=None, stop_verified=True,
                                   completed_after=len(completed))
            record = {**previous, "status": "running", "end": None, "heartbeat_at": started,
                      "ended_at": None, "summary": None}
            record.pop("job", None)
        segment = {"index": len(history) + 1, "status": "running", "started_at": started,
                   "ended_at": None, "end": None, "completed_before": len(completed), "completed_after": None}
        if job := job_context():
            record["job"] = job
            segment["job"] = job
        record["segments"] = [*history, segment]
        evals.validate_eval_record(record, eval_id=eval_id)
        eval_resume.write_json(directory, eval_resume.COMPLETED_FILE, completed)
        _write_record(path, record, initial=not bool(resume), directory=directory)
        return _run_segment(command, trace_root=trace_root, eval_id=eval_id, record=record, path=path,
                            directory=directory, baseline=record["baseline_eval_id"],
                            heartbeat_interval=heartbeat_interval, worker_wait_timeout=worker_wait_timeout, sinks=sinks)


def _run_segment(command: Sequence[str], *, trace_root: Path, eval_id: str, record: dict[str, Any],
                 path: Path, directory: reader.Dir, baseline: str | None,
                 heartbeat_interval: float, worker_wait_timeout: float, sinks: Sequence[Any]) -> int:
    if record["git"] is None:
        print("eval: Git metadata unavailable; check --repo and Git access to the checkout", file=sys.stderr)
    elif record["git"]["dirty"] is None:
        print("eval: Git commit recorded, but uncommitted changes are unknown; "
              "use --trust-repo only for a checkout you trust", file=sys.stderr)
    _warn_group_access(path)
    _publish(record, sinks)
    if baseline is not None:
        try:
            found = any(trace_root.parent.glob(f"*/{baseline}/eval.json"))
        except OSError:
            found = False
        if not found:
            print(f"eval: baseline {baseline} was not found; continuing", file=sys.stderr)

    segment = record["segments"][-1]
    child: subprocess.Popen[Any] | None = None
    pending: list[int] = []

    def forward(signum: int, _frame: Any) -> None:
        if child is None:
            pending.append(signum)
            return
        try:
            if os.name == "posix":
                os.killpg(child.pid, signum)
            else:
                child.send_signal(signum)
        except ProcessLookupError:
            pass

    previous = {sig: signal.signal(sig, forward) for sig in (signal.SIGINT, signal.SIGTERM)}
    returncode = 127
    try:
        env = os.environ.copy()
        env["CAPX_TRACE_DIR"] = str(trace_root)
        env["CAPX_TRACE_RUN_ID"] = eval_id
        env["CAPX_EVAL_SEGMENT"] = str(segment["index"])
        env["CAPX_EVAL_COMPLETED_TRIALS_FILE"] = str(path.parent / eval_resume.COMPLETED_FILE)
        env["CAPX_EVAL_SETTINGS_FILE"] = str(path.parent / "resume-settings.json")
        budget_history = [item["budget"] for item in record["segments"][:-1] if "budget" in item]
        env["CAPX_EVAL_USED_BUDGET_S"] = str(sum(item["used_s"] for item in budget_history))
        if budget_history:
            env["CAPX_EVAL_BUDGET_LIMIT_S"] = str(budget_history[0]["limit_s"])
        else:
            env.pop("CAPX_EVAL_BUDGET_LIMIT_S", None)
        if segment["index"] > 1:
            env["CAPX_EVAL_RESUME"] = "1"
        else:
            env.pop("CAPX_EVAL_RESUME", None)
        eval_resume.write_json(directory, eval_resume.CONTROL_FILE, eval_resume.control(segment["index"]))
        try:
            options = {"start_new_session": True} if os.name == "posix" else {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
            child = subprocess.Popen(list(command), env=env, **options)
            eval_resume.write_json(directory, eval_resume.CONTROL_FILE,
                                   eval_resume.control(segment["index"], child.pid))
        except OSError as exc:
            print(f"eval: command could not start ({type(exc).__name__})", file=sys.stderr)
        if child is not None:
            for signum in pending:
                forward(signum, None)
            while True:
                try:
                    returncode = child.wait(timeout=heartbeat_interval)
                    break
                except subprocess.TimeoutExpired:
                    record["heartbeat_at"] = _now()
                    try:
                        _write_record(path, record, directory=directory)
                    except (OSError, ValueError) as exc:
                        print(f"eval: heartbeat write failed ({type(exc).__name__})", file=sys.stderr)
        end = {"exit_code": returncode, "signal": -returncode if returncode < 0 else None}
        if child is not None and os.name == "posix" and not _wait_for_workers(child.pid, worker_wait_timeout):
            end["workers_left_running"] = True
        if not end.get("workers_left_running"):
            try:
                finalize_trial_outcomes(trace_root, eval_id)
                eval_resume.finalize_unobserved(trace_root, eval_id)
            except (OSError, ValueError):
                print("eval: could not finalize interrupted trial outcomes", file=sys.stderr)
        record.update({"status": "completed" if returncode == 0 else "interrupted",
                       "end": end,
                       "ended_at": _now(), "heartbeat_at": _now(),
                       "summary": evals.summarize_run(trace_root, eval_id, logical=True)})
        if job := job_context():
            record["job"] = job
            segment["job"] = job
        segment.update(status=record["status"], end=end, ended_at=record["ended_at"])
        try:
            usage = eval_resume.budget_usage(directory, segment["index"], evals._time(record["ended_at"]), time.monotonic(),
                                             used_before_s=sum(item["used_s"] for item in budget_history))
            if usage is not None:
                segment["budget"] = usage
        except (OSError, ValueError):
            print("eval: could not record segment budget usage; resume will require valid budget metadata", file=sys.stderr)
        details = reader.run_detail(trace_root, eval_id) or {}
        completed_after = eval_resume.completed_trials(details.get("episodes", []))
        segment["completed_after"] = len(completed_after)
        eval_resume.write_json(directory, eval_resume.COMPLETED_FILE, completed_after)
        try:
            _write_record(path, record, directory=directory)
        except (OSError, ValueError) as exc:
            print(f"eval: final record write failed ({type(exc).__name__})", file=sys.stderr)
        _publish(record, sinks)
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    print(f"http://127.0.0.1:8390/evals/{eval_id}")
    return returncode


def main(words: Sequence[str] | None = None) -> int:
    words = list(sys.argv[1:] if words is None else words)
    parser = argparse.ArgumentParser(prog="capx-trace-recorder eval")
    parser.add_argument("--changed", default="")
    parser.add_argument("--baseline")
    parser.add_argument("--resume")
    parser.add_argument("--eval-set")
    parser.add_argument("--by")
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--trust-repo", action="store_true")
    if words in (["-h"], ["--help"]):
        parser.parse_args(words)
    if "--" not in words:
        parser.error("provide the child command after --")
    split = words.index("--")
    args = parser.parse_args(words[:split])
    command = words[split + 1:]
    if not command:
        parser.error("provide the child command after --")
    trace_dir = os.environ.get("CAPX_TRACE_DIR", "").strip()
    if "CAPX_TRACE_RUN_ID" in os.environ:
        parser.error("CAPX_TRACE_RUN_ID is already set")
    shared_root = None
    if not trace_dir:
        hype_root = os.environ.get("HYPE_TRACE_ROOT", "")
        if hype_root:
            shared_root = Path(hype_root).expanduser()
        elif (Path.home() / "shared-storage").is_dir():
            shared_root = Path.home() / "shared-storage" / "traces"
        else:
            parser.error("set CAPX_TRACE_DIR or HYPE_TRACE_ROOT, or provide ~/shared-storage")
        trace_dir = str(shared_root / (os.environ.get("USER") or getpass.getuser()))
    if args.baseline is not None and not reader.is_valid_id(args.baseline):
        parser.error("--baseline must be a valid trace ID")
    if args.baseline is not None and not args.changed.strip() and not args.resume:
        parser.error("--changed is required with --baseline")
    try:
        trace_root = Path(os.path.abspath(os.path.expanduser(trace_dir)))
        print(f"eval: records will be saved to {trace_root}", flush=True)
        result = run_eval(command, trace_root=trace_root, shared_root=shared_root, changed=args.changed,
                          baseline=args.baseline, eval_set=args.eval_set,
                          by=args.by if args.by is not None else "" if args.resume else os.environ.get("CAPX_EVAL_BY") or os.environ.get("USER", ""), repo=args.repo,
                          trust_repo=args.trust_repo, resume=args.resume)
    except (OSError, ValueError) as exc:
        parser.error(f"cannot start evaluation: {exc}")
    return 128 - result if result < 0 else result
