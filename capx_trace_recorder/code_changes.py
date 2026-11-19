"""A bounded, redacted snapshot of tracked code changes at evaluation start."""
from __future__ import annotations

import hashlib
import itertools
import json
import os
import re
import stat
import subprocess
import threading
from pathlib import Path
from typing import Any

from capx_trace_recorder import payload
from capx_trace_recorder.payload import redact
from capx_trace_recorder.timeout import is_trial_alarm
from capx_trace_viewer import evals, reader

_SUFFIXES = {".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".yaml", ".yml", ".toml",
             ".md", ".rst", ".txt", ".sh", ".css", ".html", ".patch", ".ini", ".cfg"}
_SENSITIVE = re.compile(r"(?:^|[./_\-])(?:secrets?|credentials?|passwords?|tokens?|private[._\-]?key|api[._\-]?key|access[._\-]?key|id_rsa|id_ed25519)(?:[./_\-]|$)", re.I)


def without_git_filters(env: dict[str, str], config_names: bytes) -> dict[str, str]:
    """Disable every configured content filter in this command's environment only.

    --no-ext-diff/--no-textconv do not disable clean/process filters. Query names
    with Git's builtin config command before any worktree status/diff operation.
    No config values (which could themselves contain secrets) are retained.
    """
    if len(config_names) > 64 * 1024:
        raise OSError("too many Git config names")
    drivers = {name.decode("utf-8").rsplit(".", 1)[0] for name in config_names.split(b"\0")
               if name.lower().startswith(b"filter.") and name.count(b".") >= 2}
    if len(drivers) > 128:
        raise OSError("too many Git filter drivers")
    result = env.copy()
    count = int(result.get("GIT_CONFIG_COUNT", "0"))
    for driver in sorted(drivers):
        for option, value in (("clean", ""), ("smudge", ""), ("process", ""), ("required", "false")):
            result[f"GIT_CONFIG_KEY_{count}"] = f"{driver}.{option}"
            result[f"GIT_CONFIG_VALUE_{count}"] = value
            count += 1
    result["GIT_CONFIG_COUNT"] = str(count)
    return result


def _git(repo: Path, args: list[str], limit: int, env: dict[str, str]) -> bytes:
    """Drain no more than limit+1 bytes, kill on excess, and never invoke diff helpers."""
    if not 0 <= limit <= evals.MAX_CODE_CHANGES_BYTES:
        raise OSError("invalid output limit")
    command = ["git", "--no-pager", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-C", str(repo), *args]
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env) as process:
        output: list[bytes] = []

        def read() -> None:
            assert process.stdout is not None
            output.append(process.stdout.read(limit + 1))
            if len(output[0]) > limit:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass

        thread = threading.Thread(target=read, daemon=True)
        thread.start()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:  # timeout-ok: Git's startup subprocess deadline, never a trial alarm
            process.kill()
            process.wait()
            raise OSError("git timeout") from None
        finally:
            thread.join(timeout=2)
        if thread.is_alive() or process.returncode or not output or len(output[0]) > limit:
            raise OSError("git unavailable or output limit exceeded")
        return output[0]


def _baseline(trace_root: Path, baseline: str) -> tuple[dict[str, Any] | None, str | None]:
    candidates = [trace_root]
    try:
        siblings = list(itertools.islice(trace_root.parent.iterdir(), 512))
        candidates += [path for path in siblings if path.name != trace_root.name and not path.is_symlink()]
    except OSError as exc:
        if is_trial_alarm(exc):
            raise
        pass
    found = []
    for root in candidates:
        try:
            with reader.Dir.open_below(root, [baseline]) as directory:
                value, error, _ = reader.read_json_at(directory, "eval.json", evals.MAX_EVAL_BYTES)
            if not error:
                found.append(evals.validate_eval_record(value, eval_id=baseline))
        except (OSError, ValueError) as exc:
            if is_trial_alarm(exc):
                raise
            continue
    return (found[0], None) if len(found) == 1 else (None, "baseline_ambiguous" if found else "baseline_missing")


def _allowed_path(repo: Path, path: str) -> bool:
    if not evals.valid_code_path(path) or _SENSITIVE.search(path) or Path(path).suffix.lower() not in _SUFFIXES:
        return False
    if payload.redact(path, None).text != path:
        return False
    # Never read a working-tree symlink or cross a symlinked directory.
    current = repo
    for part in Path(path).parts:
        if part.startswith(".") and part != ".github":
            return False
        current /= part
        try:
            mode = current.lstat().st_mode
        except FileNotFoundError:  # A deleted tracked file can still have a text diff.
            break
        if stat.S_ISLNK(mode):
            return False
    return True


def capture_code_changes(repo: Path, trace_root: Path, baseline: str | None,
                         revision: dict[str, Any] | None, run: Path, *, git_env: dict[str, str] | None = None,
                         trust_repo: bool = False
                         ) -> dict[str, Any]:
    """Store no command, absolute checkout path, untracked content, binary patch or secret file."""
    metadata = {"status": "no_baseline", "baseline_commit": None,
                "current_commit": revision["commit"] if revision else None,
                "artifact": None, "sha256": None, "size_bytes": None,
                "files": 0, "excluded_files": 0, "untracked_files": 0, "redacted": False}
    if baseline is None:
        return metadata
    previous, error = _baseline(trace_root, baseline)
    if error:
        metadata["status"] = error
        return metadata
    base_git = previous["git"] if previous else None
    if not base_git:
        metadata["status"] = "baseline_git_missing"
        return metadata
    metadata["baseline_commit"] = base_git["commit"]
    if base_git["dirty"] is not False:
        metadata["status"] = "baseline_dirty"
        return metadata
    if not revision:
        metadata["status"] = "current_git_missing"
        return metadata
    env = {**os.environ, "GIT_OPTIONAL_LOCKS": "0", **(git_env or {})}
    try:
        if trust_repo:
            count = int(env.get("GIT_CONFIG_COUNT", "0"))
            env.update(GIT_CONFIG_COUNT=str(count + 1), **{f"GIT_CONFIG_KEY_{count}": "safe.directory",
                                                        f"GIT_CONFIG_VALUE_{count}": str(repo.resolve())})
        env = without_git_filters(env, _git(repo, ["config", "--null", "--name-only", "--list"], 64 * 1024, env))
        untracked = _git(repo, ["ls-files", "--others", "--exclude-standard", "-z"], 64 * 1024, env)
        metadata["untracked_files"] = len([name for name in untracked.split(b"\0") if name])
        commit = base_git["commit"]
        raw = _git(repo, ["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "--no-renames", "--numstat", "-z", commit, "--"], 64 * 1024, env)
        files, total = [], 0
        for row in raw.split(b"\0"):
            if not row:
                continue
            added, removed, encoded_path = row.split(b"\t", 2)
            path = encoded_path.decode("utf-8")
            if added == b"-" or removed == b"-" or len(files) >= 100 or not _allowed_path(repo, path):
                metadata["excluded_files"] += 1
                continue
            # A deleted symlink must not be recorded as code either.
            tree = _git(repo, ["ls-tree", commit, "--", path], 2048, env)
            if tree and not tree.startswith((b"100644 ", b"100755 ")):
                metadata["excluded_files"] += 1
                continue
            try:
                patch = _git(repo, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color",
                                    "--ignore-submodules=all", "--src-prefix=a/", "--dst-prefix=b/", "--unified=3", commit, "--", path],
                             min(32 * 1024, evals.MAX_CODE_DIFF_BYTES - total), env).decode("utf-8")
            except (OSError, UnicodeError) as exc:
                if is_trial_alarm(exc):
                    raise
                metadata["excluded_files"] += 1
                continue
            sanitized = redact(patch, None)
            if sanitized.cut:
                metadata["excluded_files"] += 1
                continue
            metadata["redacted"] = metadata["redacted"] or sanitized.redacted
            size = len(sanitized.text.encode("utf-8"))
            if total + size > evals.MAX_CODE_DIFF_BYTES:
                metadata["excluded_files"] += 1
                continue
            total += size
            files.append({"path": path, "diff": sanitized.text})
        artifact = {"schema": "capx-code-changes/1", "baseline_commit": commit,
                    "current_commit": revision["commit"], "files": files}
        data = (json.dumps(artifact, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        if len(data) > evals.MAX_CODE_CHANGES_BYTES:
            raise OSError("artifact limit exceeded")
        metadata.update(status="recorded", artifact=evals.CODE_CHANGES_FILE, files=len(files),
                        sha256=hashlib.sha256(data).hexdigest(), size_bytes=len(data))
        evals.validate_code_change_metadata(metadata)
        evals.validate_code_change_artifact(artifact, metadata)
    except (OSError, UnicodeError, ValueError) as exc:
        if is_trial_alarm(exc):
            raise
        metadata.update(status="git_unavailable", artifact=None, sha256=None, size_bytes=None, files=0)
        return metadata
    try:
        with (run / evals.CODE_CHANGES_FILE).open("xb") as stream:
            stream.write(data)
    except OSError as exc:
        if is_trial_alarm(exc):
            raise
        metadata.update(status="write_failed", artifact=None, sha256=None, size_bytes=None, files=0)
    return metadata
