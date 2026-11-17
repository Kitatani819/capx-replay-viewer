#!/usr/bin/env python3
"""Copy recorded runs from GMO into a local trace root for the viewer.

The viewer itself never connects anywhere; this script brings the trace runs
written by capx_trace_recorder on GMO to this machine with ssh and rsync.
Each run is a directory ``<trace root>/<run_id>/`` on GMO. Only files that are
missing locally or differ in size or modification time are copied, so running
it again picks up new runs and runs that are still being recorded.

GMO's rules forbid transfers of 1 GB or more through the login node, so the
transfer size is computed first and the copy stops above ``--max-gb``.

Only the Python standard library is used. Settings may come from the
environment instead of options: CAPX_GMO_HOST, CAPX_GMO_TRACES (one or more
remote patterns separated by ``:``), CAPX_GMO_SSH.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_DEST = PROJECT_DIR / "outputs" / "gmo" / "traces"
DEFAULT_MAX_GB = 1.0
RUN_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}")
# Remote paths are passed to rsync and the remote shell; keep them to plain characters.
SAFE_REMOTE_PATH = re.compile(r"/[A-Za-z0-9._/+@-]*")
SAFE_PATTERN = re.compile(r"[A-Za-z0-9._/+@*?~-]+")

# Runs on GMO with its python3: lists the runs under each trace root matching the
# patterns, with the size and modification time of every regular file.
REMOTE_LISTER = r"""
import glob, json, os, sys
out = {"runs": [], "unmatched": []}
for pattern in sys.argv[1:]:
    roots = sorted(p for p in glob.glob(os.path.expanduser(pattern)) if os.path.isdir(p) and not os.path.islink(p))
    if not roots:
        out["unmatched"].append(pattern)
    for root in roots:
        for name in sorted(os.listdir(root)):
            run = os.path.join(root, name)
            if os.path.islink(run) or not os.path.isdir(run):
                continue
            files = []
            for base, dirs, names in os.walk(run):
                dirs[:] = sorted(d for d in dirs if not os.path.islink(os.path.join(base, d)))
                for n in sorted(names):
                    p = os.path.join(base, n)
                    if os.path.islink(p) or not os.path.isfile(p):
                        continue
                    st = os.stat(p)
                    files.append([os.path.relpath(p, run), st.st_size, int(st.st_mtime)])
            if any(f[0] == "run.json" or f[0].endswith("/events.jsonl") for f in files):
                out["runs"].append({"run_id": name, "path": os.path.realpath(run), "files": files})
print(json.dumps(out))
"""


class FetchError(Exception):
    """A problem the user has to fix; reported without a traceback."""


@dataclass
class RemoteRun:
    run_id: str
    path: str
    files: list[tuple[str, int, int]] = field(default_factory=list)

    @property
    def size(self) -> int:
        return sum(size for _, size, _ in self.files)

    @property
    def n_episodes(self) -> int:
        return len({rel.split("/", 1)[0] for rel, _, _ in self.files if rel.endswith("/events.jsonl")})


def ssh_command(ssh: str) -> list[str]:
    command = shlex.split(ssh)
    if not command:
        raise FetchError("--ssh is empty")
    return command


def list_remote(ssh: str, host: str, patterns: list[str]) -> tuple[list[RemoteRun], list[str]]:
    for pattern in patterns:
        if not SAFE_PATTERN.fullmatch(pattern):
            raise FetchError(f"Unsupported characters in the remote pattern: {pattern}")
    remote = "python3 -c " + shlex.quote(REMOTE_LISTER) + " " + " ".join(shlex.quote(p) for p in patterns)
    proc = subprocess.run([*ssh_command(ssh), host, remote], capture_output=True, text=True)
    if proc.returncode != 0:
        raise FetchError(f"Listing runs on {host} failed (exit {proc.returncode}): {proc.stderr.strip()[-500:]}")
    try:
        data = json.loads(proc.stdout.strip().splitlines()[-1])
    except (IndexError, ValueError) as exc:
        raise FetchError(f"Unexpected reply from {host}: {proc.stdout[-300:]!r}") from exc
    runs = [RemoteRun(r["run_id"], r["path"], [tuple(f) for f in r["files"]]) for r in data["runs"]]
    return runs, list(data.get("unmatched", []))


def check_runs(runs: list[RemoteRun]) -> None:
    seen: dict[str, str] = {}
    for run in runs:
        if not RUN_ID.fullmatch(run.run_id):
            raise FetchError(f"Refusing an unexpected run name: {run.run_id!r}")
        if not SAFE_REMOTE_PATH.fullmatch(run.path) or "/../" in run.path + "/":
            raise FetchError(f"Refusing an unexpected remote path: {run.path!r}")
        for rel, _, _ in run.files:
            if rel.startswith("/") or ".." in rel.split("/"):
                raise FetchError(f"Refusing an unexpected file path in {run.run_id}: {rel!r}")
        if run.run_id in seen:
            raise FetchError(f"Run {run.run_id} exists in two places on GMO ({seen[run.run_id]} and {run.path}); "
                             "choose one with a narrower pattern")
        seen[run.run_id] = run.path


def pending_bytes(run: RemoteRun, local_run: Path) -> int:
    """Bytes rsync will copy: files missing locally or with another size or mtime."""
    total = 0
    for rel, size, mtime in run.files:
        try:
            st = (local_run / rel).stat()
        except OSError:
            total += size
            continue
        if st.st_size != size or int(st.st_mtime) != mtime:
            total += size
    return total


def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"


def rsync_run(ssh: str, host: str, run: RemoteRun, local_run: Path, rsync: str = "rsync") -> None:
    local_run.mkdir(parents=True, exist_ok=True)
    # -r -t: regular files and directories with their times; symlinks and devices are skipped.
    # --inplace keeps an appended events.jsonl the same file for a viewer that is reading it.
    command = [rsync, "-rt", "--inplace", "--partial", "-e", ssh, f"{host}:{run.path}/", f"{local_run}/"]
    proc = subprocess.run(command)
    if proc.returncode != 0:
        raise FetchError(f"rsync of {run.run_id} failed (exit {proc.returncode})")


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    env = os.environ
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default=env.get("CAPX_GMO_HOST", "gmo"),
                        help="ssh destination, e.g. an alias from ~/.ssh/config (default: $CAPX_GMO_HOST or gmo)")
    parser.add_argument("--traces", action="append", default=None, metavar="PATTERN",
                        help="trace root on GMO; glob patterns allowed, repeatable "
                             "(default: $CAPX_GMO_TRACES, ':'-separated)")
    parser.add_argument("--ssh", default=env.get("CAPX_GMO_SSH", "ssh"),
                        help='ssh command with options, e.g. "ssh -p 8822 -i ~/.ssh/key" (default: $CAPX_GMO_SSH or ssh)')
    parser.add_argument("--dest", type=Path, default=DEFAULT_DEST,
                        help="local trace root the runs are copied into (default: outputs/gmo/traces)")
    parser.add_argument("--run", action="append", default=[], metavar="RUN_ID", help="only these runs (repeatable)")
    parser.add_argument("--max-gb", type=float, default=DEFAULT_MAX_GB,
                        help="stop if more than this would be copied (default: 1, GMO's login-node limit)")
    parser.add_argument("--list", action="store_true", help="show the runs on GMO and what would be copied, then stop")
    args = parser.parse_args(argv)
    if args.traces is None:
        args.traces = [p for p in env.get("CAPX_GMO_TRACES", "").split(":") if p]
    if not args.traces:
        parser.error("give the trace root on GMO with --traces or CAPX_GMO_TRACES")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        runs, unmatched = list_remote(args.ssh, args.host, args.traces)
        for pattern in unmatched:
            print(f"No directory on {args.host} matches {pattern}", file=sys.stderr)
        if args.run:
            wanted = set(args.run)
            missing = wanted - {r.run_id for r in runs}
            if missing:
                raise FetchError(f"Not found on {args.host}: {', '.join(sorted(missing))}")
            runs = [r for r in runs if r.run_id in wanted]
        check_runs(runs)
        traces = args.dest.resolve()
        plan = [(run, pending_bytes(run, traces / run.run_id)) for run in runs]
        total = sum(n for _, n in plan)
        print(f"{len(runs)} run(s) on {args.host}; {human(total)} to copy into {traces}")
        for run, n in plan:
            state = "up to date" if n == 0 else f"copy {human(n)}"
            print(f"  {run.run_id}  episodes={run.n_episodes}  size={human(run.size)}  {state}")
        if args.list:
            return 0
        if total > args.max_gb * 1024**3:
            raise FetchError(f"{human(total)} exceeds --max-gb {args.max_gb:g}; choose runs with --run "
                             "(GMO forbids transfers of 1 GB or more through the login node)")
        for run, n in plan:
            if n:
                rsync_run(args.ssh, args.host, run, traces / run.run_id)
        print(f"Done. Open with: bash Start-Replay.sh --trace-root {traces}")
        return 0
    except FetchError as exc:
        print(f"fetch_gmo: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
