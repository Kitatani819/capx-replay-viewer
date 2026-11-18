"""Run one evaluation outside CaP-X and maintain its small eval.json record."""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import hashlib
import json
import os
import signal
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Sequence

from capx_trace_viewer import evals, reader

HEARTBEAT_INTERVAL_S = 60.0
WORKER_WAIT_TIMEOUT_S = 60.0
# Phase 2 can provide objects with publish(eval_record). Nothing is sent in phase 1.
SINKS: list[Any] = []


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _publish(record: dict[str, Any], sinks: Sequence[Any]) -> None:
    for sink in sinks:
        try:
            sink.publish(copy.deepcopy(record))
        except Exception as exc:  # A destination must never change the command result.
            print(f"eval: sink failed ({type(exc).__name__})", file=sys.stderr)


def git_revision(repo: Path) -> dict[str, Any] | None:
    """Fingerprint the checkout, without saving its path, diff or command line."""
    def git(*args: str) -> bytes:
        result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, timeout=10)
        if result.returncode:
            raise OSError("git failed")
        return result.stdout

    try:
        commit = git("rev-parse", "HEAD").decode("ascii").strip()
        dirty = bool(git("status", "--porcelain"))
        revision: dict[str, Any] = {"commit": commit, "dirty": dirty}
        if dirty:
            revision["diff_sha256"] = hashlib.sha256(git("diff", "HEAD")).hexdigest()
        return revision
    except (OSError, UnicodeError, subprocess.TimeoutExpired):
        return None


def _write_record(path: Path, record: dict[str, Any], *, initial: bool = False) -> None:
    evals.validate_eval_record(record, eval_id=path.parent.name)
    data = (json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    if len(data) > evals.MAX_EVAL_BYTES:
        raise ValueError("eval.json exceeds 256 KiB")
    if initial:
        with path.open("xb") as stream:
            stream.write(data)
        return
    mode = stat.S_IMODE(path.stat().st_mode)
    fd, temporary = tempfile.mkstemp(prefix=".eval-", suffix=".json.tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            os.chmod(temporary, mode)
            stream.write(data)
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


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


def run_eval(command: Sequence[str], *, trace_root: Path, changed: str = "",
             baseline: str | None = None, eval_set: str | None = None, by: str = "",
             repo: Path | None = None, heartbeat_interval: float = HEARTBEAT_INTERVAL_S,
             worker_wait_timeout: float = WORKER_WAIT_TIMEOUT_S,
             sinks: Sequence[Any] | None = None) -> int:
    """Return the child's returncode; heartbeat and worker waits are injectable."""
    if heartbeat_interval <= 0:
        raise ValueError("heartbeat interval must be positive")
    if worker_wait_timeout < 0:
        raise ValueError("worker wait timeout must be nonnegative")
    trace_root = Path(os.path.abspath(os.path.expanduser(trace_root)))
    sinks = SINKS if sinks is None else sinks
    moment = dt.datetime.now(dt.timezone.utc)
    eval_id = f"ev-{moment.strftime('%Y%m%dT%H%M%SZ')}-{os.urandom(2).hex()}"
    started = _now()
    record = {
        "schema": evals.SCHEMA, "eval_id": eval_id, "status": "running", "end": None,
        "by": by, "changed": changed, "baseline_eval_id": baseline, "eval_set": eval_set,
        "git": git_revision(Path.cwd() if repo is None else repo), "started_at": started,
        "heartbeat_at": started, "ended_at": None, "summary": None,
    }
    # Validate options before creating a directory or starting a command.
    evals.validate_eval_record(record, eval_id=eval_id)
    trace_root.mkdir(parents=True, exist_ok=True)
    run = trace_root / eval_id
    run.mkdir()  # Do not reuse an evaluation ID if another writer won the race.
    path = run / "eval.json"
    _write_record(path, record, initial=True)
    _publish(record, sinks)
    if baseline is not None:
        try:
            found = any(trace_root.parent.glob(f"*/{baseline}/eval.json"))
        except OSError:
            found = False
        if not found:
            print(f"eval: baseline {baseline} was not found; continuing", file=sys.stderr)

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
        env["CAPX_TRACE_RUN_ID"] = eval_id
        try:
            options = {"start_new_session": True} if os.name == "posix" else {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
            child = subprocess.Popen(list(command), env=env, **options)
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
                        _write_record(path, record)
                    except (OSError, ValueError) as exc:
                        print(f"eval: heartbeat write failed ({type(exc).__name__})", file=sys.stderr)
        end = {"exit_code": returncode, "signal": -returncode if returncode < 0 else None}
        if child is not None and os.name == "posix" and not _wait_for_workers(child.pid, worker_wait_timeout):
            end["workers_left_running"] = True
        record.update({"status": "completed" if returncode == 0 else "interrupted",
                       "end": end,
                       "ended_at": _now(), "heartbeat_at": _now(),
                       "summary": evals.summarize_run(trace_root, eval_id)})
        try:
            _write_record(path, record)
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
    parser.add_argument("--eval-set")
    parser.add_argument("--by", default=os.environ.get("CAPX_EVAL_BY") or os.environ.get("USER", ""))
    parser.add_argument("--repo", type=Path, default=Path.cwd())
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
    if not trace_dir:
        parser.error("CAPX_TRACE_DIR must be set")
    if "CAPX_TRACE_RUN_ID" in os.environ:
        parser.error("CAPX_TRACE_RUN_ID is already set")
    if args.baseline is not None and not reader.is_valid_id(args.baseline):
        parser.error("--baseline must be a valid trace ID")
    if args.baseline is not None and not args.changed.strip():
        parser.error("--changed is required with --baseline")
    try:
        result = run_eval(command, trace_root=Path(trace_dir), changed=args.changed,
                          baseline=args.baseline, eval_set=args.eval_set, by=args.by, repo=args.repo)
    except (OSError, ValueError) as exc:
        parser.error(f"cannot start evaluation: {exc}")
    return 128 - result if result < 0 else result
