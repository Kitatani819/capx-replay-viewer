"""Build a portable evaluation list with a standard-library-only fallback.

The optional viewer reader corrects legacy summaries when episodes are present.
The recorder is also vendored into evaluation jobs without the viewer installed.
All record paths are opened relative to pinned directories,
without following symlinks. The output lock covers the scan as well as writing.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import fcntl
import html
import json
import os
import re
import stat
import sys
from pathlib import Path
from typing import Any, Sequence
from urllib.parse import urlsplit, urlunsplit

from capx_trace_recorder.evaluation_failure import (
    evaluation_failure, failure_description, preserve_evaluation_failure,
)

MAX_EVAL_BYTES = 256 * 1024
HEARTBEAT_STALE_S = 300
JST = dt.timezone(dt.timedelta(hours=9), name="JST")
_ID = re.compile(r"ev-[A-Za-z0-9._-]{1,197}")


def _escape(value: Any) -> str:
    # Directory names may contain undecodable bytes represented by surrogateescape.
    text = str(value).encode("utf-8", errors="replace").decode("utf-8")
    return html.escape(text, quote=True)


def _time(value: Any) -> dt.datetime | None:
    if not isinstance(value, str) or len(value) > 40:
        return None
    try:
        stamp = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        return stamp.astimezone(dt.timezone.utc) if stamp.tzinfo is not None else None
    except (ValueError, OverflowError):
        return None


def _require(condition: bool, field: str) -> None:
    if not condition:
        raise ValueError(f"invalid {field}")


def _counts(value: Any, field: str) -> None:
    _require(isinstance(value, dict), field)
    for key in ("success", "trials"):
        _require(type(value.get(key)) is int and 0 <= value[key] <= 1_000_000_000, f"{field}.{key}")
    _require(value["success"] <= value["trials"], field)
    if "attempts" in value:
        _require(type(value["attempts"]) is int
                 and value["trials"] <= value["attempts"] <= 1_000_000_000, f"{field}.attempts")


def _validate(value: Any, eval_id: str) -> dict[str, Any]:
    """Check the fields used here; tolerate absent optional display metadata.

    The viewer validates the entire schema, including job/segment metadata. This
    reader deliberately projects only list fields so it can stay standalone and
    display older or partial records without depending on viewer releases.
    """
    # JSON's escaped lone surrogates cannot be encoded into the output page.
    json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
    _require(isinstance(value, dict) and value.get("schema") == "capx-eval/1", "schema")
    identity = value.get("eval_id")
    _require(isinstance(identity, str) and _ID.fullmatch(identity) is not None
             and identity == eval_id, "eval_id")
    _require(value.get("status") in ("running", "completed", "interrupted"), "status")
    started = _time(value.get("started_at"))
    _require(started is not None, "started_at")
    try:
        started.astimezone(JST)
    except OverflowError:
        raise ValueError("invalid started_at (outside JST date range)") from None
    for key in ("heartbeat_at", "ended_at"):
        _require(value.get(key) is None or _time(value[key]) is not None, key)
    for key in ("by", "changed", "eval_set"):
        _require(value.get(key) is None or isinstance(value[key], str), key)
    baseline = value.get("baseline_eval_id")
    _require(baseline is None or isinstance(baseline, str) and _ID.fullmatch(baseline) is not None,
             "baseline_eval_id")
    git = value.get("git")
    if git is not None:
        _require(isinstance(git, dict) and isinstance(git.get("commit"), str)
                 and re.fullmatch(r"[0-9a-f]{40,64}", git["commit"]) is not None, "git.commit")
        _require(git.get("dirty") is None or type(git["dirty"]) is bool, "git.dirty")
    summary = value.get("summary")
    if summary is not None:
        _counts(summary, "summary")
        tasks = summary.get("by_task", {})
        _require(isinstance(tasks, dict), "summary.by_task")
        for task, counts in tasks.items():
            _require(isinstance(task, str), "summary.by_task key")
            _counts(counts, "summary.by_task")
    return value


@contextlib.contextmanager
def _directory(path: Path):
    """Pin a directory, rejecting symlinks in every component of its path.

    Callers resolve the operator's root first (``~/shared-storage`` is itself
    a symlink on GMO). Parents such as ``/home`` may be search-only (``--x``),
    so intermediate components use ``O_PATH`` where the platform has it; only
    the final directory needs read permission.
    """
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    search = getattr(os, "O_PATH", 0)
    walk = (search | os.O_DIRECTORY | os.O_NOFOLLOW) if search else flags
    parts = path.parts[1:]
    fd = os.open(path.anchor, walk if parts else flags)
    try:
        for index, part in enumerate(parts):
            child = os.open(part, flags if index == len(parts) - 1 else walk, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def _logical_summary(directory: int, eval_id: str) -> dict[str, Any] | None:
    """Use readable local episodes, retaining the scan's pinned no-symlink root."""
    try:
        from capx_trace_viewer import evals, reader

        with reader.Dir(os.dup(directory)) as run:
            details = reader.run_detail_at(eval_id, run)
        episodes = details["episodes"] if details else []
        if not episodes or any(episode.get("episode_json_error") for episode in episodes):
            return None
        summary = evals.aggregate_episodes(episodes, details["runner_records"], logical=True)
        # Keep the same display bounds as stored summaries, including Unicode.
        json.dumps(summary, ensure_ascii=False, allow_nan=False).encode("utf-8")
        _counts(summary, "summary")
        for counts in summary["by_task"].values():
            _counts(counts, "summary.by_task")
        return summary
    except (ImportError, OSError, ValueError, UnicodeError, RecursionError):  # timeout-ok: optional supervisor/CLI summary
        return None


def _scan(root_fd: int) -> tuple[list[dict[str, Any]], list[tuple[str, str]]]:
    records: list[dict[str, Any]] = []
    errors: list[tuple[str, str]] = []

    def children(directory: int, prefix: str):
        try:
            names = sorted(os.listdir(directory))
        except OSError as exc:  # timeout-ok: index runs in the supervisor/CLI, never on a trial thread
            errors.append((prefix, type(exc).__name__))
            return
        for name in names:
            relative = f"{prefix}/{name}" if prefix else name
            try:
                info = os.stat(name, dir_fd=directory, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    yield name, relative
            except OSError as exc:  # timeout-ok: supervisor/CLI file scan, outside trial threads
                errors.append((relative, type(exc).__name__))

    def read_record(directory: int, relative: str, eval_id: str) -> None:
        filename = relative + "/eval.json"
        try:
            fd = os.open("eval.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                         dir_fd=directory)
            with os.fdopen(fd, "rb") as stream:
                info = os.fstat(stream.fileno())
                _require(stat.S_ISREG(info.st_mode), "regular file")
                _require(info.st_size <= MAX_EVAL_BYTES, "file size (maximum 256 KiB)")
                data = stream.read(MAX_EVAL_BYTES + 1)
            _require(len(data) <= MAX_EVAL_BYTES, "file size (maximum 256 KiB)")
            value = json.loads(data, parse_constant=_invalid_constant)
            value = _validate(value, eval_id)
            summary = _logical_summary(directory, eval_id)
            if summary is not None:
                value = {**value, "summary": preserve_evaluation_failure(summary, value)}
            records.append(value)
        except FileNotFoundError:
            pass  # A newly created evaluation directory may not have its record yet.
        except (OSError, ValueError, UnicodeError, RecursionError) as exc:  # timeout-ok: supervisor/CLI record read
            reason = str(exc) if isinstance(exc, ValueError) and str(exc).startswith("invalid ") else type(exc).__name__
            errors.append((filename, reason))

    for name, relative in children(root_fd, ""):
        try:
            user_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
        except OSError as exc:  # timeout-ok: supervisor/CLI directory scan
            errors.append((relative, type(exc).__name__))
            continue
        try:
            if name.startswith("ev-"):
                read_record(user_fd, relative, name)
            # Also allow a user's directory to happen to start with ev-.
            for eval_id, eval_relative in children(user_fd, relative):
                if not eval_id.startswith("ev-"):
                    continue
                try:
                    eval_fd = os.open(eval_id, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=user_fd)
                except OSError as exc:  # timeout-ok: supervisor/CLI directory scan
                    errors.append((eval_relative, type(exc).__name__))
                    continue
                try:
                    read_record(eval_fd, eval_relative, eval_id)
                finally:
                    os.close(eval_fd)
        finally:
            os.close(user_fd)
    records.sort(key=lambda item: (_time(item["started_at"]), item["eval_id"]), reverse=True)
    return records, errors


def _invalid_constant(_value: str) -> None:
    raise ValueError("invalid JSON constant")


_CSS = """
:root { color-scheme: light dark; --bg:#f4f6f2; --surface:#fff; --text:#24332b;
  --muted:#55675a; --line:#dce3da; --head:#eef2eb; --link:#356b4e; --note:#f7f0df; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text);
  font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans JP",sans-serif; }
main { max-width:1440px; min-width:0; padding:36px 24px; margin:0 auto; }
header { border-bottom:1px solid var(--line); padding-bottom:20px; margin-bottom:24px; }
h1 { margin:0 0 8px; font-size:25px; font-weight:600; }
p { margin:8px 0; overflow-wrap:anywhere; }
a { color:var(--link); text-underline-offset:3px; }
a:focus-visible, summary:focus-visible, .table-scroll:focus-visible { outline:2px solid var(--link); outline-offset:3px; }
.meta, .rate, .empty { color:var(--muted); }
.table-scroll { max-width:100%; overflow-x:auto; border:1px solid var(--line);
  background:var(--surface); border-radius:8px; }
table { width:100%; border-collapse:collapse; font-size:14px; }
caption { text-align:left; padding:14px 16px; font-weight:600; }
th, td { text-align:left; vertical-align:top; padding:14px 16px; }
th { font-weight:500; white-space:nowrap; background:var(--head); color:var(--muted); }
tbody + tbody { border-top:1px solid var(--line); }
td { overflow-wrap:anywhere; max-width:320px; min-width:100px; }
.date, .score, .duration, .commit, .open { white-space:nowrap; }
.changed { min-width:190px; }
.score { font-size:17px; font-variant-numeric:tabular-nums; }
.rate { display:block; font-size:12px; }
.eval-id { display:block; font-size:11px; color:var(--muted); margin-top:4px; }
code { font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace; }
.breakdown > td { padding-top:0; }
details summary { cursor:pointer; color:var(--link); }
.task-list { display:flex; flex-wrap:wrap; gap:8px 28px; margin:10px 0; padding-left:22px; }
.task-list li { overflow-wrap:anywhere; }
.warnings { margin-top:24px; padding:12px 18px; border-left:3px solid #a17a35; background:var(--note); font-size:13px; }
.warnings h2 { margin:0; font-size:15px; }
.warnings ul { padding-left:20px; overflow-wrap:anywhere; }
@media (prefers-color-scheme:dark) {
  :root { --bg:#18221d; --surface:#202d25; --text:#e3ebe1; --muted:#afc0b1;
    --line:#3b4c40; --head:#29392e; --link:#a6d3ac; --note:#383325; }
}
@media (max-width:600px) { main { padding:22px 12px; } h1 { font-size:22px; } th,td { padding:12px; } }
"""


def _score(summary: dict[str, Any] | None) -> str:
    if summary is None:
        return "—"
    trials, success = summary["trials"], summary["success"]
    rate = f"{success / trials * 100:.1f}%" if trials else "—"
    attempts = summary.get("attempts", trials)
    note = f'（やり直しを含めると {_escape(attempts)} 回）' if attempts > trials else ""
    return f'{_escape(success)} / {_escape(trials)}{note}<span class="rate">{_escape(rate)}</span>'


def _duration(record: dict[str, Any], now: dt.datetime) -> str:
    if record["status"] == "running":
        heartbeat = _time(record.get("heartbeat_at"))
        return "実行中" if heartbeat is not None and (now - heartbeat).total_seconds() < HEARTBEAT_STALE_S else "途中で終了"
    start, end = _time(record["started_at"]), _time(record.get("ended_at"))
    if end is None or end < start:
        return "途中で終了"
    seconds = int((end - start).total_seconds())
    hours, seconds = divmod(seconds, 3600)
    minutes, seconds = divmod(seconds, 60)
    duration = f"{hours}時間 {minutes}分 {seconds}秒" if hours else f"{minutes}分 {seconds}秒"
    return f"途中で終了（{duration}）" if record["status"] == "interrupted" else duration


def _status(record: dict[str, Any], now: dt.datetime) -> str:
    failure = evaluation_failure(record)
    if record["status"] != "running" and failure is not None:
        word = "評価失敗" if failure["kind"] == "infrastructure" else "未完了"
        return f'<span title="{_escape(failure_description(failure))}">{word}</span>'
    if record["status"] == "running":
        word = "実行中" if _duration(record, now) == "実行中" else "中断"
    elif record["status"] == "interrupted":
        word = "中断"
    else:
        word = "欠損あり" if (record.get("summary") or {}).get("incomplete", 0) else "完了"
    return word


def _render(records: list[dict[str, Any]], errors: list[tuple[str, str]], viewer_url: str,
            now: dt.datetime) -> str:
    # Ambiguous IDs must not produce a misleading baseline comparison.
    by_id: dict[str, list[dict[str, Any]]] = {}
    for record in records:
        by_id.setdefault(record["eval_id"], []).append(record)
    rows = []
    for record in records:
        identity = record["eval_id"]  # Validated before it becomes part of a URL.
        viewer = urlsplit(viewer_url)
        link = _escape(urlunsplit(viewer._replace(path=f"{viewer.path.rstrip('/')}/evals/{identity}")))
        git = record.get("git")
        commit = git["commit"][:8] + (" (dirty)" if git.get("dirty") else "") if git else "記録なし"
        baseline = record.get("baseline_eval_id")
        baseline_html = _escape(baseline or "—")
        matches = by_id.get(baseline, [])
        summary = record.get("summary")
        if len(matches) == 1 and summary is not None and matches[0].get("summary") is not None:
            delta = summary["success"] - matches[0]["summary"]["success"]
            baseline_html += f'<span class="rate">成功数 {_escape(f"{delta:+d}")}</span>'
        cells = [
            f'<time datetime="{_escape(record["started_at"])}">{_escape(_time(record["started_at"]).astimezone(JST).strftime("%Y-%m-%d %H:%M:%S"))}</time>'
            f'<small class="eval-id">{_escape(identity)}</small>',
            _escape(record.get("by") or "—"), _escape(record.get("changed") or "—"),
            _escape(record.get("eval_set") or "—"), _status(record, now), _score(summary),
            _escape(_duration(record, now)), _escape(commit), baseline_html,
            f'<a href="{link}">Viewerで開く</a>',
        ]
        classes = ("date", "by", "changed", "eval-set", "status", "score", "duration", "commit", "baseline", "open")
        row = "".join(f'<td class="{cls}">{cell}</td>' for cls, cell in zip(classes, cells))
        tasks = (summary or {}).get("by_task", {})
        items = "".join(f'<li>{_escape(task)}: {_score(counts)}</li>' for task, counts in sorted(tasks.items()))
        breakdown = f'<ul class="task-list">{items}</ul>' if items else '<p class="empty">タスク別の記録なし</p>'
        rows.append(f'<tbody><tr>{row}</tr><tr class="breakdown"><td colspan="10"><details>'
                    f'<summary>タスク別の内訳</summary>{breakdown}</details></td></tr></tbody>')
    warnings = ""
    if errors:
        items = "".join(f"<li>{_escape(path)}: {_escape(reason)}</li>" for path, reason in errors)
        warnings = f'<section class="warnings"><h2>読めなかった記録</h2><ul>{items}</ul></section>'
    headings = ("日付（JST）", "誰", "変えた部品", "組", "状態", "成功数 / 試行数", "時間", "commit", "基準", "開く")
    table = '<div class="table-scroll" tabindex="0" role="region" aria-label="評価一覧（横にスクロールできます）"><table>'
    table += '<caption>評価一覧 · 新しい順</caption><thead><tr>' + "".join(f'<th scope="col">{_escape(h)}</th>' for h in headings) + '</tr></thead>'
    table += "".join(rows) + '</table></div>'
    return ('<!doctype html>\n<html lang="ja"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1">'
            f'<title>CaP-X 評価一覧</title><style>{_CSS}</style></head><body><main><header>'
            '<h1>CaP-X 評価一覧</h1>'
            f'<p class="meta">生成日時: {_escape(now.astimezone(JST).strftime("%Y-%m-%d %H:%M:%S JST"))} · 評価数: {_escape(len(records))}件</p>'
            '<p>失敗した試行の中身は Viewer（bash Start-Replay.sh --from-gmo）で開けます</p>'
            f'<p class="meta">Viewer URL: <a href="{_escape(viewer_url)}">{_escape(viewer_url)}</a></p>'
            '<p class="meta">実行状況は生成時点の記録です。heartbeat が5分以上更新されていない評価は「途中で終了」と表示します。</p>'
            '</header>' + (table if records else '<p class="empty">評価の記録はありません。</p>')
            + warnings + '</main></body></html>\n')


def _shared_mode(fd: int, group: int) -> None:
    info = os.fstat(fd)
    _require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, "output/lock regular file")
    if info.st_gid != group:
        os.fchown(fd, -1, group)
    if stat.S_IMODE(os.fstat(fd).st_mode) != 0o664:
        os.fchmod(fd, 0o664)


def build_index(root: Path, out: Path | None = None,
                viewer_url: str = "http://127.0.0.1:8390") -> Path:
    """Scan both user/ev-* and flat ev-* layouts and atomically publish one page.

    Callers must create the output directory first. Neither its permissions nor
    ownership are changed. The persistent lock is shared by all writers.
    """
    # The explicitly supplied root is the trust boundary (shared-storage may
    # itself be an alias). Every descendant is still opened with O_NOFOLLOW.
    root = Path(root).expanduser().resolve(strict=True)
    out = Path(os.path.abspath(Path(out).expanduser())) if out is not None else root / "index.html"
    parsed = urlsplit(viewer_url)
    _require(parsed.scheme in ("http", "https") and bool(parsed.hostname)
             and not parsed.fragment and not parsed.username and not parsed.password
             and not any(ord(c) < 32 or ord(c) == 127 for c in viewer_url), "viewer URL (use http:// or https://)")
    viewer_url = urlunsplit(parsed._replace(path=parsed.path.rstrip("/")))
    with _directory(out.parent) as output_fd:
        group = os.fstat(output_fd).st_gid
        lock_fd = os.open(out.name + ".lock", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                          0o664, dir_fd=output_fd)
        try:
            _shared_mode(lock_fd, group)
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            try:
                with _directory(root) as root_fd:
                    records, errors = _scan(root_fd)
                page = _render(records, errors, viewer_url, dt.datetime.now(dt.timezone.utc))
                temporary = f".{out.name}.{os.urandom(12).hex()}.tmp"
                created = False
                try:
                    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                 0o664, dir_fd=output_fd)
                    created = True
                    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
                        _shared_mode(stream.fileno(), group)
                        stream.write(page)
                        stream.flush()
                        os.fsync(stream.fileno())
                    os.replace(temporary, out.name, src_dir_fd=output_fd, dst_dir_fd=output_fd)
                finally:
                    if created:
                        with contextlib.suppress(FileNotFoundError):
                            os.unlink(temporary, dir_fd=output_fd)
            finally:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
        finally:
            os.close(lock_fd)
    return out


def main(words: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="capx-trace-recorder index", description=__doc__)
    parser.add_argument("--root", required=True, type=Path, help="shared traces root")
    parser.add_argument("--out", type=Path, help="output HTML (default: <root>/index.html)")
    parser.add_argument("--viewer-url", default="http://127.0.0.1:8390")
    args = parser.parse_args(words)
    try:
        path = build_index(args.root, args.out, args.viewer_url)
    except (OSError, ValueError) as exc:  # timeout-ok: CLI only, never on a trial thread
        print(f"index: {exc}", file=sys.stderr)
        return 1
    print(f"index: {path}")
    return 0
