#!/usr/bin/env python3
"""GMO settings, remote discovery, and trace copying shared by the API and CLI.

The legacy CLI copies whole runs; the server lists episodes and copies only the
selected episode and its run metadata. Both use ssh and rsync without GMO-side writes.
The CLI retains CAPX_GMO_HOST, CAPX_GMO_TRACES and CAPX_GMO_SSH compatibility.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shlex
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

PROJECT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_DEST = PROJECT_DIR / "outputs" / "gmo" / "traces"
DEFAULT_MAX_GB = 1.0
RUN_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,199}")
# Remote paths are passed to rsync and the remote shell; keep them to plain characters.
SAFE_REMOTE_PATH = re.compile(r"/[A-Za-z0-9._/+@-]*")
SAFE_PATTERN = re.compile(r"[A-Za-z0-9._/+@*?~-]+")
SAFE_HOST = re.compile(r"[A-Za-z0-9._@-]+")
MAX_METADATA_BYTES = 256 * 1024
MAX_FETCH_BYTES = 1024**3
MAX_INTERVAL_S = 24 * 60 * 60
LISTING_TIMEOUT_S = 60
# The background import lists every file of every own trial, which takes over a
# minute once a few large evaluations have run; it runs off the request path.
FILE_LISTING_TIMEOUT_S = 600
CONNECTION_ERROR = (
    "GMOに接続できません。公式GENIACチュートリアルの Host gmo をSSH設定に追加するか、"
    "接続設定で接続先を指定してください。"
)

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
    return sum(size for _, size, _ in changed_files(run, local_run))


def changed_files(run: RemoteRun, local_run: Path) -> list[tuple[str, int, int]]:
    """Include metadata-only changes and missing empty files as well as data."""
    changed = []
    for rel, size, mtime in run.files:
        try:
            st = (local_run / rel).stat()
        except OSError:
            changed.append((rel, size, mtime))
            continue
        if st.st_size != size or int(st.st_mtime) != mtime:
            changed.append((rel, size, mtime))
    return changed


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


# The API accepts only these fields. The CLI's legacy --ssh option above stays available
# for scripts, but a browser cannot supply arbitrary ssh options to the server.
@dataclass(frozen=True)
class GmoSettings:
    host: str = "gmo"
    port: int | None = None
    identity_file: str | None = None
    mine: tuple[str, ...] = ()
    team: tuple[str, ...] = ()
    interval_s: int = 120
    shared_root: str = "~/shared-storage/traces"

    @property
    def configured(self) -> bool:
        return bool(self.host and (self.shared_root or self.mine or self.team))

    def as_dict(self) -> dict[str, Any]:
        return {
            "host": self.host, "port": self.port, "identity_file": self.identity_file,
            "mine": list(self.mine), "team": list(self.team), "interval_s": self.interval_s,
            "shared_root": self.shared_root,
        }

    @classmethod
    def from_dict(cls, value: Any) -> GmoSettings:
        if not isinstance(value, dict):
            raise FetchError("Settings must be a JSON object")
        allowed = {"host", "port", "identity_file", "mine", "team", "interval_s", "shared_root"}
        unknown = set(value) - allowed
        if unknown:
            raise FetchError(f"Unknown setting: {sorted(unknown)[0]}")
        host = value.get("host", cls.host)
        if not isinstance(host, str) or (host and (host.startswith("-") or not SAFE_HOST.fullmatch(host))):
            raise FetchError("Invalid host: use a plain ssh alias or user@host")
        port = value.get("port")
        if port is not None and (type(port) is not int or not 1 <= port <= 65535):
            raise FetchError("port must be an integer from 1 to 65535")
        identity = value.get("identity_file")
        if identity is not None and (not isinstance(identity, str) or not identity or "\x00" in identity):
            raise FetchError("identity_file must be a nonempty path")
        shared_root = value.get("shared_root", cls.shared_root)
        # Only ~/ is allowed: ~other would select another account's home, and
        # expansion must happen on GMO rather than on the viewer's computer.
        shared_path = shared_root
        if isinstance(shared_root, str) and shared_root.startswith("~/"):
            shared_path = shared_root[1:]
        if not isinstance(shared_root, str) or (shared_root and (
            not SAFE_REMOTE_PATH.fullmatch(shared_path) or ".." in shared_root.split("/")
        )):
            raise FetchError("shared_root must be an absolute or ~/ plain path without '..' or glob characters")
        patterns = {}
        for key in ("mine", "team"):
            items = value.get(key, [])
            if not isinstance(items, (list, tuple)) or any(
                not isinstance(item, str) or not SAFE_PATTERN.fullmatch(item) for item in items
            ):
                raise FetchError(f"Invalid {key} pattern: use plain paths and glob characters")
            patterns[key] = tuple(items)
        interval = value.get("interval_s", 120)
        if type(interval) is not int or not 0 <= interval <= MAX_INTERVAL_S:
            raise FetchError(f"interval_s must be an integer from 0 to {MAX_INTERVAL_S}")
        return cls(host, port, identity, patterns["mine"], patterns["team"], interval, shared_root)


def config_path() -> Path:
    override = os.environ.get("CAPX_GMO_CONFIG")
    if override:
        return Path(override).expanduser().absolute()
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config").expanduser()
    return base / "capx-geniac-replay" / "gmo.json"


def load_settings(path: Path | None = None) -> GmoSettings:
    """File values > built-ins; only without a file, legacy env values > built-ins."""
    path = config_path() if path is None else path
    try:
        content = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        fallback: dict[str, Any] = {}
        if "CAPX_GMO_HOST" in os.environ:
            fallback["host"] = os.environ["CAPX_GMO_HOST"]
        if "CAPX_GMO_TRACES" in os.environ:
            fallback["mine"] = [p for p in os.environ["CAPX_GMO_TRACES"].split(":") if p]
        return GmoSettings.from_dict(fallback)
    except OSError as exc:
        raise FetchError(f"Cannot read GMO settings: {exc.strerror or exc}") from exc
    try:
        return GmoSettings.from_dict(json.loads(content))
    except ValueError as exc:
        raise FetchError("Invalid JSON in GMO settings") from exc


def save_settings(settings: GmoSettings, path: Path | None = None) -> None:
    path = config_path() if path is None else path
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    fd, temp_name = tempfile.mkstemp(prefix=".gmo-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(settings.as_dict(), stream, ensure_ascii=True, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temp_name, 0o600)
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def api_ssh_argv(settings: GmoSettings) -> list[str]:
    # A test can replace the transport with a local fake ssh. No settings file or API
    # field can change this command. In production the fixed ssh argv below is used.
    test_command = os.environ.get("CAPX_GMO_SSH_COMMAND") if "PYTEST_CURRENT_TEST" in os.environ else None
    if test_command:
        command = shlex.split(test_command)
        if not command:
            raise FetchError("Test ssh command is empty")
        return command
    command = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15"]
    if os.name != "nt" and sys.platform != "win32":
        # A private, short local path also fits macOS's Unix-socket path limit.
        # Multiplexing avoids a fresh login for every live manifest and rsync.
        control_dir = Path("/tmp") / f"capx-gmo-ssh-{os.getuid()}"
        control_dir.mkdir(mode=0o700, exist_ok=True)
        st = control_dir.lstat()
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) & 0o077:
            raise FetchError("SSH control directory must be private and owned by the current user")
        command += ["-o", "ControlMaster=auto", "-o", "ControlPersist=30",
                    "-o", f"ControlPath={control_dir}/%C"]
    if settings.port is not None:
        command += ["-p", str(settings.port)]
    if settings.identity_file is not None:
        command += ["-i", os.path.expanduser(settings.identity_file), "-o", "IdentitiesOnly=yes"]
    return command


class ProcessRunner:
    """Run bounded ssh/rsync children and reap them, including at server shutdown."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._children: set[subprocess.Popen[str]] = set()
        self._closed = False

    @staticmethod
    def _kill(proc: subprocess.Popen[str]) -> None:
        # A completed ssh may leave ProxyCommand descendants holding its pipes.
        # The process group can still exist after its original leader has exited.
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            # macOS may report EPERM for a group whose leader has exited.
            # Signal failures must not skip bounded pipe cleanup and reaping.
            pass

    @staticmethod
    def _reap(proc: subprocess.Popen[str]) -> None:
        try:
            proc.communicate(timeout=1)
        except subprocess.TimeoutExpired:
            # A descendant that created a separate session may retain the pipes
            # even after killpg. Do not let cleanup block the next queued job.
            for stream in (proc.stdout, proc.stderr):
                if stream is not None:
                    stream.close()
            try:
                proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass

    def run(self, command: list[str], *, timeout: float) -> subprocess.CompletedProcess[str]:
        if timeout <= 0:
            raise FetchError("GMO operation timed out")
        with self._lock:
            if self._closed:
                raise FetchError("GMO service is shutting down")
            proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    text=True, start_new_session=True)
            self._children.add(proc)
        try:
            try:
                stdout, stderr = proc.communicate(timeout=timeout)
            except subprocess.TimeoutExpired as exc:
                self._kill(proc)
                self._reap(proc)
                raise FetchError("GMO operation timed out") from exc
            return subprocess.CompletedProcess(command, proc.returncode, stdout, stderr)
        finally:
            with self._lock:
                self._children.discard(proc)
            if proc.poll() is None:
                self._kill(proc)
                self._reap(proc)

    def close(self) -> None:
        with self._lock:
            self._closed = True
            children = list(self._children)
        for proc in children:
            self._kill(proc)
        for proc in children:
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._kill(proc)


REMOTE_EPISODE_LISTER = r"""
import errno, glob, hashlib, json, os, pwd, re, stat, sys, time

def read_json(path, strict=False):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, 'O_CLOEXEC', 0)
                     | getattr(os, 'O_NONBLOCK', 0))
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode):
                return None, 'not_a_regular_file', None
            if st.st_size > 256 * 1024:
                return None, 'too_large', st.st_mtime
            with os.fdopen(fd, 'rb', closefd=False) as stream:
                data = stream.read(256 * 1024 + 1)
        finally:
            os.close(fd)
        if len(data) > 256 * 1024:
            return None, 'too_large', st.st_mtime
        try:
            replacements = {'NaN': 'nan', 'Infinity': 'inf', '-Infinity': '-inf'}
            def constant(value):
                if strict:
                    raise ValueError('nonfinite JSON number')
                return replacements.get(value, value)
            return json.loads(data, parse_constant=constant), None, st.st_mtime
        except (UnicodeError, ValueError, RecursionError):
            return None, 'invalid_json', st.st_mtime
    except FileNotFoundError:
        return None, 'missing', None
    except OSError as exc:
        return None, 'not_a_regular_file' if exc.errno == errno.ELOOP else 'unreadable', None

def regular(path):
    try:
        st = os.lstat(path)
        return st if stat.S_ISREG(st.st_mode) else None
    except OSError:
        return None

def first_event(path):
    if regular(path) is None:
        return None
    try:
        with open(path, 'rb') as stream:
            line = stream.readline(64 * 1024)
        if not line.endswith(b'\n'):
            return None
        replacements = {'NaN': 'nan', 'Infinity': 'inf', '-Infinity': '-inf'}
        data = json.loads(line.decode('utf-8'), parse_constant=lambda value: replacements.get(value, value))
        return data if isinstance(data, dict) else None
    except (OSError, UnicodeError, ValueError, RecursionError):
        return None

def stats(directory):
    count = size = 0
    newest = None
    files = []
    for base, dirs, names in os.walk(directory):
        dirs[:] = sorted(d for d in dirs if not os.path.islink(os.path.join(base, d)))
        for name in names:
            path = os.path.join(base, name)
            st = regular(path)
            if st is not None:
                count += 1
                size += st.st_size
                mtime = int(st.st_mtime)
                newest = mtime if newest is None else max(newest, mtime)
                files.append((os.path.relpath(path, directory), st.st_size, mtime))
    # Keep the representation identical to local_episode_stats. Whole-second
    # mtimes match rsync's quick check and its default timestamp preservation.
    digest = hashlib.sha256(json.dumps(sorted(files), ensure_ascii=True, separators=(',', ':')).encode('ascii')).hexdigest()
    return count, size, newest, digest, files


def digest(value):
    return hashlib.sha256(json.dumps(sorted(value), ensure_ascii=True, separators=(',', ':')).encode('ascii')).hexdigest()

def directory_stat(path):
    try:
        st = os.lstat(path)
        return st if stat.S_ISDIR(st.st_mode) else None
    except OSError:
        return None

def cheap_stats(directory, run, previous=None):
    # Only immediate files and a bounded nested sample are stat-ed. Type checks use
    # directory entries' d_type, avoiding an RPC per frame on network storage.
    top = []
    child_dirs = []
    with os.scandir(directory) as entries:
        for entry in entries:
            if entry.is_file(follow_symlinks=False):
                st = entry.stat(follow_symlinks=False)
                top.append((entry.name, st.st_size, int(st.st_mtime), st.st_mtime_ns))
            elif entry.is_dir(follow_symlinks=False):
                child_dirs.append(entry.name)
    metadata = []
    for name in ('run.json', 'eval.json', 'runner_records.jsonl'):
        st = regular(os.path.join(run, name))
        if st is not None:
            metadata.append(('run/' + name, st.st_size, st.st_mtime_ns))
    def fingerprint(directories):
        signature = [('file/' + name, size, ns) for name, size, mtime, ns in top] + metadata
        for rel in directories:
            st = directory_stat(os.path.join(directory, rel))
            if st is None:
                return None
            signature.append(('dir/' + rel, st.st_size, st.st_mtime_ns))
        return digest(signature)
    if previous is not None:
        previous_fingerprint, directories = previous
        # A parent directory mtime changes when a nested directory is added or
        # removed. Reusing the old directory paths therefore also detects new
        # subtrees, without enumerating unchanged frame directories.
        if set(child_dirs) == {rel for rel in directories if '/' not in rel}:
            current = fingerprint(directories)
            if current == previous_fingerprint:
                return None, current, directories
    directories = []
    nested = []
    pending = list(child_dirs)
    nested_size = 0
    while pending:
        rel = pending.pop()
        directories.append(rel)
        st = directory_stat(os.path.join(directory, rel))
        if st is None:
            continue
        directory_files = 0
        samples = []
        with os.scandir(os.path.join(directory, rel)) as entries:
            for entry in entries:
                name = rel + '/' + entry.name
                if entry.is_dir(follow_symlinks=False):
                    pending.append(name)
                elif entry.is_file(follow_symlinks=False):
                    nested.append(name)
                    directory_files += 1
                    if len(samples) < 4:
                        samples.append(entry.stat(follow_symlinks=False).st_size)
        if samples:
            nested_size += (sum(samples) * directory_files + len(samples) - 1) // len(samples)
    # Estimate nested bytes from at most four regular files per directory. This
    # bounds network metadata RPCs independently of the number of frame files.
    size = sum(item[1] for item in top) + nested_size
    newest = max((item[2] for item in top), default=None)
    content = [(name, size, mtime) for name, size, mtime, ns in top]
    content.extend((name, None, None) for name in nested)
    result = (len(top) + len(nested), size, newest, digest(content), bool(nested))
    return result, fingerprint(directories), directories

config = json.loads(sys.argv[1])
mine, team = config['mine'], config['team']
eval_only = config.get('eval_only', False)
metadata_only = config.get('metadata_only', False)
run_ids = config.get('run_ids')
previous = {(path, episode): (fingerprint, directories) for path, episode, fingerprint, directories in config.get('previous', [])}
shared_root = os.path.realpath(os.path.expanduser(config['shared_root'])) if config['shared_root'] else None
shared_real = shared_root
if shared_root:
    # Resolve ssh aliases' User on the remote host during this same listing.
    username = config['username'] or pwd.getpwuid(os.geteuid()).pw_name
    if not re.fullmatch(r'[A-Za-z0-9._+@-]+', username) or username in ('.', '..'):
        raise ValueError('Unsupported remote username for shared_root')
    mine = [os.path.join(shared_root, username)] + mine
    team = [os.path.join(shared_root, '*')] + team
include_files = len(sys.argv) > 2 and sys.argv[2] == 'files'
mine_only = len(sys.argv) > 3 and sys.argv[3] == 'mine'
out = []
evals = []
seen = {}
run_paths = {}
for scope, patterns in (('mine', mine), ('team', team)):
    for pattern in patterns:
        roots = sorted(p for p in glob.glob(os.path.expanduser(pattern))
                       if os.path.isdir(p) and not os.path.islink(p))
        for root in roots:
            try:
                run_names = sorted(os.listdir(root))
            except OSError:
                continue
            for name in run_names:
                run = os.path.join(root, name)
                if os.path.islink(run) or not os.path.isdir(run):
                    continue
                real = os.path.realpath(run)
                key = (name, real)
                if key in seen:
                    continue
                seen[key] = True
                run_paths.setdefault(name, set()).add(real)
                # Automatic imports only need team run names to detect a
                # destination collision; never walk their episode contents.
                if mine_only and scope == 'team':
                    continue
                if run_ids is not None and name not in run_ids:
                    continue
                try:
                    trace_root = os.path.dirname(real)
                    if shared_real is not None and os.path.dirname(trace_root) == shared_real:
                        owner = os.path.basename(trace_root)
                    else:
                        owner_id = os.stat(run).st_uid
                        try:
                            owner = pwd.getpwuid(owner_id).pw_name
                        except (KeyError, OSError):
                            owner = str(owner_id)
                    names = [] if eval_only else sorted(os.listdir(run))
                except OSError:
                    continue
                rows = []
                if not eval_only:
                    run_json, run_error, run_mtime = read_json(os.path.join(run, 'run.json'))
                eval_json, eval_error, eval_mtime = read_json(os.path.join(run, 'eval.json'), strict=True)
                if eval_error != 'missing':
                    evals.append(dict(run_id=name, path=real, owner=owner, mine=scope == 'mine',
                                      eval_json=eval_json, eval_json_error=eval_error,
                                      eval_mtime=eval_mtime))
                for episode_id in names:
                    episode = os.path.join(run, episode_id)
                    if os.path.islink(episode) or not os.path.isdir(episode):
                        continue
                    events_st = regular(os.path.join(episode, 'events.jsonl'))
                    episode_st = regular(os.path.join(episode, 'episode.json'))
                    if events_st is None and episode_st is None:
                        continue
                    if include_files:
                        count, size, newest, files_digest, files = stats(episode)
                        cheap = (count, size, newest, files_digest, False)
                        fingerprint, directories = None, []
                    elif metadata_only:
                        # Detail pages need only the bounded metadata below, not
                        # frame counts or size estimates. Fetch still takes its
                        # own exact manifest before copying any episode.
                        cheap = (0, 0, None, hashlib.sha256(b'').hexdigest(), False)
                        fingerprint, directories = None, []
                    else:
                        cheap, fingerprint, directories = cheap_stats(episode, run, previous.get((real, episode_id)))
                    if cheap is None:
                        rows.append(dict(run_id=name, episode_id=episode_id, path=real, owner=owner,
                                         mine=scope == 'mine', _unchanged=True))
                        continue
                    episode_json, episode_error, episode_mtime = read_json(os.path.join(episode, 'episode.json'))
                    heartbeat_st = regular(os.path.join(episode, 'heartbeat'))
                    count, size, newest, files_digest, approximate = cheap
                    rows.append(dict(run_id=name, episode_id=episode_id, path=real, owner=owner,
                                     mine=scope == 'mine', episode_json=episode_json,
                                     episode_json_error=episode_error, episode_mtime=episode_mtime,
                                     run_json=run_json, run_json_error=run_error, run_mtime=run_mtime,
                                     heartbeat_mtime=heartbeat_st.st_mtime if heartbeat_st else None,
                                     events_bytes=events_st.st_size if events_st else None,
                                     events_mtime=events_st.st_mtime if events_st else None,
                                     first_event=first_event(os.path.join(episode, 'events.jsonl')),
                                     file_count=count, size_bytes=size, max_mtime=newest,
                                     files_digest=files_digest, fingerprint=fingerprint,
                                     fingerprint_directories=directories, size_approximate=approximate,
                                     listing_digest=None if include_files or metadata_only else files_digest))
                    if metadata_only:
                        rows[-1]['metadata_only'] = True
                    if include_files:
                        manifest = [[episode_id + '/' + rel, size, mtime] for rel, size, mtime in files]
                        for metadata in ('run.json', 'eval.json', 'runner_records.jsonl', 'code_changes.json'):
                            st = regular(os.path.join(run, metadata))
                            if st and (metadata != 'code_changes.json' or st.st_size <= 131072):
                                manifest.append([metadata, st.st_size, int(st.st_mtime)])
                        rows[-1]['files'] = manifest
                out.extend(rows)
remote_now = time.time()
for row in out + evals:
    row['conflict'] = len(run_paths[row['run_id']]) > 1
    row['remote_now'] = remote_now
print(json.dumps({'episodes': out, 'evals': evals}, ensure_ascii=True))
"""


REMOTE_EPISODE_FILES = r"""
import json, os, stat, sys
run, episode_id = sys.argv[1:3]
episode = os.path.join(run, episode_id)
def regular(path):
    try:
        st = os.lstat(path)
        return st if stat.S_ISREG(st.st_mode) else None
    except OSError:
        return None
if os.path.islink(run) or not os.path.isdir(run) or os.path.islink(episode) or not os.path.isdir(episode):
    print(json.dumps({'error': 'Episode is no longer available'}))
    sys.exit(0)
if regular(os.path.join(episode, 'events.jsonl')) is None and regular(os.path.join(episode, 'episode.json')) is None:
    print(json.dumps({'error': 'Episode is no longer available'}))
    sys.exit(0)
files = []
for metadata in ('run.json', 'eval.json', 'runner_records.jsonl', 'code_changes.json'):
    st = regular(os.path.join(run, metadata))
    if st and (metadata != 'code_changes.json' or st.st_size <= 131072):
        files.append([metadata, st.st_size, int(st.st_mtime)])
for base, dirs, names in os.walk(episode):
    dirs[:] = sorted(d for d in dirs if not os.path.islink(os.path.join(base, d)))
    for name in sorted(names):
        path = os.path.join(base, name)
        st = regular(path)
        if st:
            files.append([os.path.relpath(path, run), st.st_size, int(st.st_mtime)])
print(json.dumps({'files': files}, ensure_ascii=True))
"""


REMOTE_CODE_CHANGES = r"""
import base64, json, os, stat, sys
path = sys.argv[1]
fd = None
try:
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    for part in path.split('/')[1:]:
        if not part or part in ('.', '..'):
            raise ValueError('path')
        child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        os.close(fd)
        fd = child
    source = os.open('code_changes.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    try:
        info = os.fstat(source)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 131072:
            raise ValueError('file')
        with os.fdopen(source, 'rb', closefd=False) as stream:
            data = stream.read(131073)
        if len(data) > 131072:
            raise ValueError('size')
    finally:
        os.close(source)
    print(json.dumps({'data': base64.b64encode(data).decode('ascii')}))
except (OSError, ValueError):
    print(json.dumps({'error': 'Code changes are not available'}))
finally:
    if fd is not None:
        os.close(fd)
"""


def read_remote_code_changes(runner: ProcessRunner, settings: GmoSettings, row: dict[str, Any]) -> bytes:
    """Read only the fixed, bounded artifact from a validated, unambiguous evaluation."""
    import base64
    _validate_run_path(row["run_id"], row["path"])
    if row.get("conflict"):
        raise FetchError("Conflicting evaluation locations")
    value = _remote_python(runner, settings, REMOTE_CODE_CHANGES, [row["path"]], timeout=20)
    if (not isinstance(value, dict) or set(value) != {"data"} or not isinstance(value["data"], str)
            or len(value["data"]) > 174764):
        raise FetchError("Code changes are not available")
    try:
        return base64.b64decode(value["data"], validate=True)
    except ValueError:
        raise FetchError("Invalid code changes reply") from None


def _validate_run_path(run_id: str, path: str) -> None:
    check_runs([RemoteRun(run_id, path)])


def _remote_python(runner: ProcessRunner, settings: GmoSettings, code: str,
                   args: list[str], *, timeout: float) -> Any:
    if not settings.host or settings.host.startswith("-") or not SAFE_HOST.fullmatch(settings.host):
        raise FetchError("GMO host is not configured")
    remote = "python3 -c " + shlex.quote(code) + " " + " ".join(shlex.quote(arg) for arg in args)
    try:
        proc = runner.run([*api_ssh_argv(settings), settings.host, remote], timeout=timeout)
    except OSError as exc:
        raise FetchError(CONNECTION_ERROR) from exc
    except FetchError as exc:
        if "timed out" in str(exc):
            raise FetchError(f"{CONNECTION_ERROR}（{timeout:g} 秒以内に応答がありませんでした）") from exc
        raise
    if proc.returncode != 0:
        if proc.returncode == 255:
            raise FetchError(CONNECTION_ERROR)
        raise FetchError(f"GMO listing failed (exit {proc.returncode}): {proc.stderr.strip()[-300:]}")
    try:
        return json.loads(proc.stdout.strip().splitlines()[-1])
    except (IndexError, ValueError) as exc:
        raise FetchError("Unexpected reply from GMO") from exc


def list_remote_episodes(runner: ProcessRunner, settings: GmoSettings, *,
                         include_files: bool = False, mine_only: bool = False,
                         run_ids: tuple[str, ...] | None = None,
                         previous: dict[str, Any] | None = None,
                         metadata_only: bool = False,
                         timeout: float = LISTING_TIMEOUT_S) -> dict[str, list[dict[str, Any]]]:
    return _list_remote_records(runner, settings, include_files=include_files, mine_only=mine_only,
                                run_ids=run_ids, previous=previous, metadata_only=metadata_only,
                                timeout=timeout)


def list_remote_evals(runner: ProcessRunner, settings: GmoSettings) -> dict[str, list[dict[str, Any]]]:
    """Read only bounded eval.json records; never enumerate episode directories."""
    return _list_remote_records(runner, settings, eval_only=True)


def _list_remote_records(runner: ProcessRunner, settings: GmoSettings, *, include_files: bool = False,
                         mine_only: bool = False, eval_only: bool = False,
                         run_ids: tuple[str, ...] | None = None,
                         previous: dict[str, Any] | None = None,
                         metadata_only: bool = False,
                         timeout: float = LISTING_TIMEOUT_S) -> dict[str, list[dict[str, Any]]]:
    if include_files and metadata_only:
        raise FetchError("An exact manifest cannot be metadata-only")
    if not settings.configured:
        raise FetchError("GMO host and a shared_root or at least one trace pattern are required")
    if run_ids is not None and any(not isinstance(value, str) or not RUN_ID.fullmatch(value) for value in run_ids):
        raise FetchError("Refusing an unexpected run name")
    if previous is not None:
        previous = validate_remote_listing(previous)
    previous_rows = {(row["path"], row["episode_id"]): row
                     for row in (previous or {}).get("episodes", []) if row.get("fingerprint")}
    compact = [[path, episode, row["fingerprint"], row.get("fingerprint_directories", [])]
               for (path, episode), row in previous_rows.items()]
    # SSH passes the program and config as one shell argument. Stay below the
    # per-argument limit even for very large listings; a full cheap scan is safe.
    if len(json.dumps(compact)) > 48 * 1024:
        compact = []
    payload = json.dumps({
        "mine": settings.mine, "team": settings.team, "shared_root": settings.shared_root,
        "username": settings.host.rsplit("@", 1)[0] if "@" in settings.host else "",
        "eval_only": eval_only, "run_ids": run_ids, "previous": compact, "metadata_only": metadata_only,
    })
    args = [payload, 'files' if include_files else 'summary', 'mine' if mine_only else 'all']
    listing = _remote_python(runner, settings, REMOTE_EPISODE_LISTER, args, timeout=timeout)
    if isinstance(listing, dict) and isinstance(listing.get("episodes"), list):
        merged = []
        for row in listing["episodes"]:
            if isinstance(row, dict) and row.get("_unchanged"):
                prior = previous_rows.get((row.get("path"), row.get("episode_id")))
                if prior is None or prior.get("run_id") != row.get("run_id"):
                    raise FetchError("Unexpected unchanged episode from GMO")
                row = {**prior, **{key: value for key, value in row.items() if key != "_unchanged"}}
            merged.append(row)
        listing["episodes"] = merged
    return validate_remote_listing(listing, include_files=include_files)


def validate_remote_listing(listing: Any, *, include_files: bool = False) -> dict[str, list[dict[str, Any]]]:
    """Apply the same validation to transport replies and private disk caches."""
    if (not isinstance(listing, dict) or not isinstance(listing.get("episodes"), list)
            or not isinstance(listing.get("evals"), list)):
        raise FetchError("Unexpected episode list from GMO")
    rows, evals = listing["episodes"], listing["evals"]
    locations: dict[str, set[str]] = {}
    valid: list[dict[str, Any]] = []
    for row in rows:
        try:
            run_id, episode_id, path = row["run_id"], row["episode_id"], row["path"]
            _validate_run_path(run_id, path)
            if not RUN_ID.fullmatch(episode_id):
                raise FetchError(f"Refusing an unexpected episode name: {episode_id!r}")
            if not all(type(row[key]) is int and row[key] >= 0 for key in ("file_count", "size_bytes")):
                raise FetchError("Unexpected episode size from GMO")
            if type(row["remote_now"]) not in (int, float) or not math.isfinite(row["remote_now"]):
                raise FetchError("Unexpected clock value from GMO")
            if not isinstance(row["files_digest"], str) or not re.fullmatch(r"[0-9a-f]{64}", row["files_digest"]):
                raise FetchError("Unexpected episode fingerprint from GMO")
            if row["first_event"] is not None and not isinstance(row["first_event"], dict):
                raise FetchError("Unexpected first event from GMO")
            if row.get("fingerprint") is not None:
                if not isinstance(row["fingerprint"], str) or not re.fullmatch(r"[0-9a-f]{64}", row["fingerprint"]):
                    raise FetchError("Unexpected episode fingerprint from GMO")
                directories = row.get("fingerprint_directories")
                if not isinstance(directories, list) or any(
                    not isinstance(rel, str) or "\x00" in rel or rel.startswith("/")
                    or any(part in ("", ".", "..") for part in rel.split("/")) for rel in directories
                ):
                    raise FetchError("Unexpected episode directory from GMO")
            if row.get("listing_digest") is not None and row["listing_digest"] != row["files_digest"]:
                raise FetchError("Unexpected episode content digest from GMO")
            if include_files:
                episode_manifest(row, row)
        except (KeyError, TypeError, AttributeError) as exc:
            raise FetchError("Unexpected episode list from GMO") from exc
        locations.setdefault(run_id, set()).add(path)
        valid.append(row)
    valid_evals: list[dict[str, Any]] = []
    for row in evals:
        try:
            run_id, path = row["run_id"], row["path"]
            _validate_run_path(run_id, path)
            if (type(row["mine"]) is not bool or not isinstance(row["owner"], str)
                    or len(row["owner"]) > 200):
                raise FetchError("Unexpected evaluation owner from GMO")
            if (row["eval_json_error"] is not None
                    and row["eval_json_error"] not in {"missing", "not_a_regular_file", "too_large",
                                                       "invalid_json", "unreadable"}):
                raise FetchError("Unexpected evaluation metadata error from GMO")
            for key in ("eval_mtime", "remote_now"):
                value = row[key]
                if value is None and key == "eval_mtime":
                    continue
                if type(value) not in (int, float) or not math.isfinite(value):
                    raise FetchError("Unexpected evaluation clock value from GMO")
        except (FetchError, KeyError, TypeError, AttributeError):
            continue
        locations.setdefault(run_id, set()).add(path)
        valid_evals.append(row)
    for row in valid + valid_evals:
        row["conflict"] = bool(row.get("conflict")) or len(locations[row["run_id"]]) > 1
    return {"episodes": valid, "evals": valid_evals}


def local_episode_stats(episode: Path) -> tuple[int, int, int | None, str] | None:
    if episode.is_symlink() or not episode.is_dir():
        return None
    count = size = 0
    newest: int | None = None
    files = []
    for base, dirs, names in os.walk(episode):
        dirs[:] = [d for d in dirs if not (Path(base) / d).is_symlink()]
        for name in names:
            try:
                st = (Path(base) / name).lstat()
            except OSError:
                continue
            if stat.S_ISREG(st.st_mode):
                count += 1
                size += st.st_size
                mtime = int(st.st_mtime)
                newest = mtime if newest is None else max(newest, mtime)
                files.append(((Path(base) / name).relative_to(episode).as_posix(), st.st_size, mtime))
    # Identical to the exact transfer-manifest stats in REMOTE_EPISODE_LISTER.
    digest = hashlib.sha256(json.dumps(sorted(files), ensure_ascii=True, separators=(",", ":")).encode("ascii")).hexdigest()
    return count, size, newest, digest


def _local_listing_digest(episode: Path) -> str | None:
    if episode.is_symlink() or not episode.is_dir():
        return None
    files: list[tuple[str, int | None, int | None]] = []
    pending = [(episode, "")]
    while pending:
        directory, prefix = pending.pop()
        with os.scandir(directory) as entries:
            for entry in entries:
                rel = prefix + entry.name
                if entry.is_dir(follow_symlinks=False):
                    pending.append((Path(entry.path), rel + "/"))
                elif entry.is_file(follow_symlinks=False):
                    info = entry.stat(follow_symlinks=False) if not prefix else None
                    files.append((rel, info.st_size if info else None, int(info.st_mtime) if info else None))
    return hashlib.sha256(json.dumps(sorted(files), ensure_ascii=True, separators=(",", ":")).encode("ascii")).hexdigest()


def local_state(row: dict[str, Any], dest: Path) -> str:
    if (dest / row["run_id"]).is_symlink():
        return "stale"
    if row.get("listing_digest") is not None:
        digest = _local_listing_digest(dest / row["run_id"] / row["episode_id"])
        return "remote" if digest is None else "local" if digest == row["listing_digest"] else "stale"
    stats = local_episode_stats(dest / row["run_id"] / row["episode_id"])
    if stats is None:
        return "remote"
    return "local" if stats[3] == row["files_digest"] else "stale"


def _safe_local_directory(path: Path) -> None:
    if path.is_symlink() or (path.exists() and not path.is_dir()):
        raise FetchError("Local destination is not a directory")
    path.mkdir(parents=True, exist_ok=True)


def _check_local_links(path: Path) -> None:
    def check(entry: Path) -> None:
        try:
            st = entry.lstat()
        except FileNotFoundError:
            return
        if stat.S_ISLNK(st.st_mode):
            raise FetchError("Local destination contains a symlink")
        if stat.S_ISREG(st.st_mode) and st.st_nlink > 1:
            raise FetchError("Local destination contains a hardlink")

    check(path)
    if not path.is_dir():
        return
    for base, dirs, names in os.walk(path):
        for name in dirs + names:
            check(Path(base) / name)


def _episode_files(runner: ProcessRunner, settings: GmoSettings, row: dict[str, Any],
                   *, timeout: float = 60) -> RemoteRun:
    """Capture the exact transfer manifest before creating any local files."""
    run_id, episode_id, remote_path = row["run_id"], row["episode_id"], row["path"]
    _validate_run_path(run_id, remote_path)
    if not RUN_ID.fullmatch(episode_id):
        raise FetchError("Refusing an unexpected episode name")
    data = _remote_python(runner, settings, REMOTE_EPISODE_FILES, [remote_path, episode_id],
                          timeout=timeout)
    if not isinstance(data, dict) or "error" in data:
        raise FetchError(data.get("error", "Unexpected episode files from GMO") if isinstance(data, dict)
                         else "Unexpected episode files from GMO")
    return episode_manifest(row, data)


def episode_manifest(row: dict[str, Any], data: dict[str, Any]) -> RemoteRun:
    """Validate a manifest from either discovery or the manual fetch preflight."""
    run_id, episode_id, remote_path = row["run_id"], row["episode_id"], row["path"]
    _validate_run_path(run_id, remote_path)
    if not RUN_ID.fullmatch(episode_id):
        raise FetchError("Refusing an unexpected episode name")
    try:
        run = RemoteRun(run_id, remote_path, [tuple(f) for f in data["files"]])
        if any(not isinstance(rel, str) or "\x00" in rel
               or any(part in ("", ".", "..") for part in rel.split("/"))
               or type(size) is not int or size < 0 or type(mtime) is not int
               for rel, size, mtime in run.files):
            raise FetchError("Unexpected episode files from GMO")
        check_runs([run])
        if len({rel for rel, _, _ in run.files}) != len(run.files):
            raise FetchError("Duplicate episode file from GMO")
        if any(rel not in ("run.json", "eval.json", "runner_records.jsonl", "code_changes.json")
               and not rel.startswith(episode_id + "/")
               for rel, _, _ in run.files):
            raise FetchError("Unexpected file path from GMO")
        if any(rel == "code_changes.json" and size > 128 * 1024 for rel, size, _mtime in run.files):
            raise FetchError("Code changes artifact exceeds its size limit")
    except (KeyError, TypeError, ValueError) as exc:
        raise FetchError("Unexpected episode files from GMO") from exc
    return run


def _episode_changes(run: RemoteRun, episode_id: str, dest: Path) -> list[tuple[str, int, int]]:
    local_run = dest / run.run_id
    if local_run.is_symlink():
        raise FetchError("Local destination contains a symlink")
    _check_local_links(local_run / episode_id)
    for metadata in ("run.json", "eval.json", "runner_records.jsonl", "code_changes.json"):
        _check_local_links(local_run / metadata)
    return changed_files(run, local_run)


def _transfer_episode(runner: ProcessRunner, settings: GmoSettings, run: RemoteRun,
                      episode_id: str, dest: Path, *, max_bytes: int, deadline: float,
                      notes: list[str] | None = None, changes: list[str] | None = None) -> int:
    files = _episode_changes(run, episode_id, dest)
    pending = sum(size for _, size, _ in files)
    # Apply the login-node limit to the preflight manifest. Active recorders append
    # events and update heartbeat between listing and rsync; allow that brief
    # growth so running episodes can be followed, with later imports catching up.
    if pending >= max_bytes:
        raise FetchError(f"{human(pending)} exceeds the 1 GiB transfer limit")
    if changes is not None:
        changes.extend(rel for rel, _, _ in files)
    if not files:
        return 0
    local_run = dest / run.run_id
    _safe_local_directory(dest)
    _safe_local_directory(local_run)
    _safe_local_directory(local_run / episode_id)
    ssh = shlex.join(api_ssh_argv(settings))
    # macOS openrsync supports --files-from and --from0. Never fall back to a
    # recursive directory copy if an older implementation rejects these options:
    # propagate its stderr and let the user install a compatible rsync instead.
    # Omit -r so a listed file replaced by a directory cannot add unlisted files.
    # One manifest and one rsync keep the number of SSH connections independent
    # of the file count. Only changed files (including run.json) are listed.
    with tempfile.TemporaryDirectory(prefix="capx-gmo-files-") as temp:
        manifest = Path(temp) / "files"
        manifest.write_bytes(b"".join(os.fsencode(rel) + b"\x00" for rel, _, _ in files))
        proc = runner.run(["rsync", "-t", "--inplace", "--partial", "--from0",
                           f"--files-from={manifest}", "-e", ssh,
                           f"{settings.host}:{run.path}/", f"{local_run}/"],
                          timeout=deadline - time.monotonic())
        if proc.returncode != 0:
            raise FetchError(f"rsync failed (exit {proc.returncode}): {proc.stderr.strip()[-300:]}")
    # Compare locally with preflight rather than opening a third SSH connection.
    # A successful copy of a changing episode is useful; the next import can
    # reconcile its remaining differences, and local_state may report stale.
    if changed_files(RemoteRun(run.run_id, run.path, files), local_run) and notes is not None:
        notes.append("remote changed during transfer")
    copied = 0
    for rel, _, _ in files:
        try:
            st = (local_run / rel).lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISREG(st.st_mode):
            copied += st.st_size
    return copied


def fetch_episode(runner: ProcessRunner, settings: GmoSettings, row: dict[str, Any],
                  dest: Path, *, max_bytes: int = MAX_FETCH_BYTES,
                  notes: list[str] | None = None, changes: list[str] | None = None) -> int:
    deadline = time.monotonic() + 30 * 60
    run = _episode_files(runner, settings, row, timeout=min(60, deadline - time.monotonic()))
    return _transfer_episode(runner, settings, run, row["episode_id"], dest,
                             max_bytes=max_bytes, deadline=deadline, notes=notes, changes=changes)


def prefetch_mine(dest: Path) -> int:
    """Launcher prefetch: copy only episodes matched by the configured mine patterns."""
    try:
        settings = load_settings()
        if not settings.host or not (settings.shared_root or settings.mine):
            print("GMO settings for mine are missing; starting without prefetch.", file=sys.stderr)
            return 0
        runner = ProcessRunner()
        try:
            rows = list_remote_episodes(runner, settings, mine_only=True)["episodes"]
            if any(row["conflict"] for row in rows):
                raise FetchError("A run ID exists in more than one GMO location")
            # Plan every episode first. Reuse these manifests so only the files
            # included in the startup budget are copied; active files may grow.
            plans = []
            needed: dict[tuple[str, str], int] = {}
            for row in sorted(rows, key=lambda r: (r["max_mtime"] or 0, r["run_id"], r["episode_id"]),
                              reverse=True):
                run = _episode_files(runner, settings, row)
                files = _episode_changes(run, row["episode_id"], dest)
                plans.append((row, run, files))
                needed.update({(run.path, rel): size for rel, size, _ in files})
            selected = []
            reserved: set[tuple[str, str]] = set()
            budget = skipped = 0
            for row, run, files in plans:
                files = [f for f in files if (run.path, f[0]) not in reserved]
                size = sum(f[1] for f in files)
                if budget + size >= MAX_FETCH_BYTES:
                    skipped += 1
                    continue
                reserved.update((run.path, rel) for rel, _, _ in files)
                budget += size
                selected.append((row, RemoteRun(run.run_id, run.path, files)))
            if skipped:
                remaining = sum(size for key, size in needed.items() if key not in reserved)
                print(f"Skipped {skipped} mine episode(s); {human(remaining)} exceeds the remaining "
                      "1 GiB startup transfer budget; starting without them.", file=sys.stderr)
            total = 0
            for row, run in selected:
                total += _transfer_episode(runner, settings, run, row["episode_id"], dest,
                                            max_bytes=MAX_FETCH_BYTES,
                                            deadline=time.monotonic() + 30 * 60)
            print(f"Fetched {len(selected)} mine episode(s); {human(total)} copied into {dest}")
            return 0
        finally:
            runner.close()
    except (FetchError, OSError) as exc:
        print(f"fetch_gmo: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
