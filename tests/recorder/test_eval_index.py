"""The shared evaluation list is portable HTML and safe under concurrent writers."""

from __future__ import annotations

import datetime as dt
import fcntl
from html import unescape
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import select
import shutil
import stat
import subprocess
import sys

import pytest

from capx_trace_recorder import eval_index


class Markup(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.links = []
        self.link_attrs = []
        self.details = []
        self.headers = []
        self.cells = []
        self.titles = []
        self._capture = None
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "title" in attrs:
            self.titles.append(attrs["title"])
        if tag == "a":
            self.links.append(attrs.get("href", ""))
            self.link_attrs.append(attrs)
        if tag == "details":
            self.details.append(attrs)
        if tag in ("td", "th"):
            self._capture = [tag, []]

    def handle_data(self, data):
        if self._capture is not None:
            self._capture[1].append(data)

    def handle_endtag(self, tag):
        if self._capture is not None and self._capture[0] == tag:
            target = self.headers if tag == "th" else self.cells
            target.append(" ".join("".join(self._capture[1]).split()))
            self._capture = None


def record(eval_id="ev-older", **updates):
    value = {
        "schema": "capx-eval/1", "eval_id": eval_id, "status": "completed",
        "end": {"exit_code": 0, "signal": None}, "by": "member-a",
        "changed": "計画器", "baseline_eval_id": None, "eval_set": "suite-small",
        "git": {"commit": "abcdef0123456789" * 2 + "abcdef01", "dirty": False},
        "started_at": "2026-10-01T00:00:00Z", "heartbeat_at": "2026-10-01T00:10:00Z",
        "ended_at": "2026-10-01T00:10:00Z",
        "summary": {"trials": 4, "success": 2, "failure": 2, "unknown": 0,
                    "incomplete": 0, "by_task": {"task-a": {"trials": 4, "success": 2}},
                    "tasks": ["task-a"], "seeds": [1, 2, 3, 4], "models": {},
                    "config_flags": {}, "mixed": [], "verdict_sources": {}},
    }
    value.update(updates)
    return value


def save(root, value, user="member-a", directory=None):
    path = root / user if user else root
    path = path / (directory or value["eval_id"]) / "eval.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    return path


def page(root, **kwargs):
    out = eval_index.build_index(root, **kwargs)
    assert isinstance(out, Path)
    return out.read_text(encoding="utf-8")


def retried_record(root, *, stored="attempts", user=None):
    value = record("ev-retried")
    logical = stored != "attempts"
    value["summary"].update(
        trials=2 if logical else 3, success=1, failure=1 if logical else 2,
        by_task={"task-a": {"trials": 1 if logical else 2, "success": 1},
                 "task-b": {"trials": 1, "success": 0}},
        tasks=["task-a", "task-b"], seeds=[1, 2],
    )
    if stored == "logical_with_attempts":
        value["summary"]["attempts"] = 3
        value["summary"]["by_task"]["task-a"]["attempts"] = 2
        value["summary"]["by_task"]["task-b"]["attempts"] = 1
    path = save(root, value, user=user)
    for identity, task, seed, attempt, success, started in (
        ("a-first", "task-a", 1, 1, False, 1),
        ("a-retry", "task-a", 1, 2, True, 2),
        ("b-first", "task-b", 2, 1, False, 3),
    ):
        directory = path.parent / identity
        directory.mkdir()
        (directory / "episode.json").write_text(json.dumps({
            "status": "ended", "trace_complete": True, "task": task,
            "condition": "M1", "seed": seed, "attempt_index": attempt,
            "start_wall_time": started, "end_reason": "completed",
            "harness_summary": {"task_completed": success},
        }), encoding="utf-8")
    return path, value


@pytest.mark.parametrize("stored", ["attempts", "logical", "logical_with_attempts"])
@pytest.mark.parametrize("user", [None, "member-a"])
def test_local_logical_scores_match_header_and_include_retry_counts(tmp_path, stored, user):
    from capx_trace_viewer.eval_api import EvalService

    path, value = retried_record(tmp_path, stored=stored, user=user)
    html = page(tmp_path)
    header = EvalService(path.parent.parent).detail(value["eval_id"])
    summary = header["summary"]
    assert (summary["success"], summary["trials"], summary["attempts"]) == (1, 2, 3)
    assert eval_index._score(summary) in html
    assert "1 / 2（やり直しを含めると 3 回）" in html
    assert "task-a: 1 / 1（やり直しを含めると 2 回）" in html
    assert "task-b: 0 / 1<span" in html
    for task, counts in summary["by_task"].items():
        assert f"{task}: {eval_index._score(counts)}" in html
    assert json.loads(path.read_text(encoding="utf-8")) == value


@pytest.mark.parametrize("problem", ["missing", "corrupt", "unreadable"])
@pytest.mark.parametrize("stored", ["attempts", "logical", "logical_with_attempts"])
def test_unavailable_episodes_keep_stored_summary(tmp_path, monkeypatch, problem, stored):
    path, value = retried_record(tmp_path, stored=stored)
    if problem == "missing":
        for directory in path.parent.iterdir():
            if directory.is_dir():
                shutil.rmtree(directory)
    elif problem == "corrupt":
        (path.parent / "a-first" / "episode.json").write_text("{broken", encoding="utf-8")
    else:
        from capx_trace_viewer import reader

        original = reader.Dir.open_file

        def unreadable(directory, name):
            if name == "episode.json":
                raise PermissionError("synthetic unreadable episode")
            return original(directory, name)

        monkeypatch.setattr(reader.Dir, "open_file", unreadable)
    html = page(tmp_path)
    assert eval_index._score(value["summary"]) in html
    if stored == "logical_with_attempts":
        assert "1 / 2（やり直しを含めると 3 回）" in html
    else:
        assert "やり直しを含めると" not in html


@pytest.mark.parametrize("target", ["episode_directory", "episode_file", "runner_records"])
def test_optional_episode_reads_never_follow_symlinks(tmp_path, target):
    root, outside = tmp_path / "traces", tmp_path / "outside"
    path, _value = retried_record(root)
    external, _ = retried_record(outside)
    if target == "episode_directory":
        shutil.rmtree(path.parent / "a-retry")
        (path.parent / "a-retry").symlink_to(external.parent / "a-retry", target_is_directory=True)
    elif target == "episode_file":
        episode_file = path.parent / "a-retry" / "episode.json"
        episode_file.unlink()
        episode_file.symlink_to(external.parent / "a-retry" / "episode.json")
    else:
        runner = external.parent / "runner_records.jsonl"
        runner.write_text('{"task":"task-a","condition":"M1","seed":1,'
                          '"attempts":[{"attempt_id":2,"task_success":false,'
                          '"started_at":"1970-01-01T00:00:02Z",'
                          '"ended_at":"1970-01-01T00:00:03Z"}]}\n', encoding="utf-8")
        (path.parent / "runner_records.jsonl").symlink_to(runner)
    html = page(root)
    if target == "runner_records":
        assert "1 / 2（やり直しを含めると 3 回）" in html
    else:
        assert "1 / 2（やり直しを含めると 3 回）" not in html
    assert any(link.endswith("/ev-retried") for link in Markup(html).links)


def test_columns_sorting_jst_baseline_tasks_and_both_layouts(tmp_path):
    baseline = record()
    save(tmp_path, baseline)
    newest = record("ev-newer", started_at="2026-10-02T22:00:00Z",
                    heartbeat_at="2026-10-02T22:10:00Z", ended_at="2026-10-02T22:10:00Z",
                    by="member-b", changed="認識器", baseline_eval_id="ev-older",
                    git={"commit": "1234567890abcdef" * 2 + "12345678", "dirty": True,
                         "diff_sha256": "a" * 64})
    newest["summary"]["success"] = 3
    newest["summary"]["failure"] = 1
    newest["summary"]["by_task"] = {"task-b": {"success": 3, "trials": 4}}
    save(tmp_path, newest, user=None)
    html = page(tmp_path, viewer_url="http://127.0.0.1:9000")
    markup = Markup(html)
    for header in ("日付", "誰", "変えた部品", "組", "時間", "commit", "基準", "開く"):
        assert any(header in text for text in markup.headers), markup.headers
    assert any("成功数" in text and "試行数" in text for text in markup.headers)
    newer_link = "http://127.0.0.1:9000/evals/ev-newer"
    older_link = "http://127.0.0.1:9000/evals/ev-older"
    assert newer_link in markup.links and older_link in markup.links
    assert html.index(newer_link) < html.index(older_link)
    text = unescape(html)
    for expected in ("2026-10-03", "07:00", "member-b", "認識器", "suite-small",
                     "75", "50", "1234567", "dirty", "ev-older", "+1", "task-a", "task-b"):
        assert expected in text
    assert any("3 / 4" in cell or "3/4" in cell for cell in markup.cells)
    assert any("10分" in cell or "10:00" in cell or "10m" in cell for cell in markup.cells)
    assert "2 件" in text or "2件" in text
    assert "生成" in text and "JST" in text
    assert "失敗した試行の中身は Viewer（bash Start-Replay.sh --from-gmo）で開けます" in text
    assert len(markup.details) >= 2
    assert all("open" not in attrs for attrs in markup.details)
    assert 'name="viewport"' in html and "prefers-color-scheme" in html
    assert "overflow-x" in html
    assert "<script src=" not in html and "<link " not in html


def test_empty_and_missing_display_fields(tmp_path):
    save(tmp_path, record(changed="", by="", eval_set=None, git=None, baseline_eval_id=None))
    minimal = record("ev-minimal")
    for key in ("changed", "by", "eval_set", "git", "baseline_eval_id", "summary"):
        minimal.pop(key)
    save(tmp_path, minimal)
    html = page(tmp_path)
    assert "/evals/ev-older" in html and "/evals/ev-minimal" in html
    assert "記録なし" in html
    assert Markup(html).cells.count("—") >= 5


def test_running_stale_and_interrupted_status(tmp_path):
    fresh = dt.datetime.now(dt.timezone.utc).isoformat()
    save(tmp_path, record("ev-running", status="running", started_at=fresh,
                          heartbeat_at=fresh, ended_at=None, end=None, summary=None))
    save(tmp_path, record("ev-stale", status="running", ended_at=None, end=None, summary=None))
    save(tmp_path, record("ev-interrupted", status="interrupted", end={"exit_code": 7, "signal": None}))
    html = page(tmp_path)
    markup = Markup(html)
    assert "実行中" in markup.cells
    assert sum("途中で終了" in cell for cell in markup.cells) == 2


@pytest.mark.parametrize("kind,word", [("infrastructure", "評価失敗"), ("incomplete", "未完了")])
@pytest.mark.parametrize("local_episodes", [False, True])
def test_failed_evaluation_status_keeps_reason_when_scores_are_rebuilt(tmp_path, kind, word, local_episodes):
    if local_episodes:
        path, value = retried_record(tmp_path)
    else:
        value = record()
        path = save(tmp_path, value)
    value["status"] = "interrupted"
    reason = 'setup <failed> & "reason"'
    value["summary"]["config_flags"]["evaluation_failure"] = {
        "kind": kind, "reason": "task setup or worker failed", "count": 2,
        "infrastructure_failures": [{"task": "task-a", "seed": 401, "reason": reason}],
    }
    path.write_text(json.dumps(value), encoding="utf-8")
    html = page(tmp_path)
    markup = Markup(html)
    assert "状態" in markup.headers
    assert word in markup.cells
    assert f'task-a・seed 401・{reason} / ほか 1 件' in markup.titles
    assert 'setup <failed>' not in html
    assert "&lt;failed&gt;" in html and "&quot;reason&quot;" in html
    assert json.loads(path.read_text()) == value


def test_failed_evaluation_with_global_reason_and_legacy_diagnostic(tmp_path):
    value = record(status="interrupted")
    value["summary"]["config_flags"]["evaluation_failure"] = {
        "kind": "infrastructure", "reason": "command could not start",
        "infrastructure_failures": [{"task": None, "seed": None, "reason": "invalid configuration"}],
    }
    save(tmp_path, value)
    old = record("ev-old", status="interrupted")
    old["summary"]["config_flags"]["evaluation_failure"] = {"kind": "unknown", "reason": "old marker"}
    save(tmp_path, old)
    markup = Markup(page(tmp_path))
    assert "評価失敗" in markup.cells
    assert "invalid configuration" in markup.titles
    assert "中断" in markup.cells


def test_missing_baseline_has_id_without_invented_delta(tmp_path):
    save(tmp_path, record(baseline_eval_id="ev-missing"))
    markup = Markup(page(tmp_path))
    baseline_cells = [cell for cell in markup.cells if "ev-missing" in cell]
    assert len(baseline_cells) == 1
    assert "+" not in baseline_cells[0]


def test_baseline_can_show_a_regression(tmp_path):
    save(tmp_path, record("ev-baseline"))
    regression = record("ev-regression", baseline_eval_id="ev-baseline")
    regression["summary"]["success"] = 1
    regression["summary"]["failure"] = 3
    save(tmp_path, regression, user="member-b")
    markup = Markup(page(tmp_path))
    assert any("ev-baseline" in cell and ("-1" in cell or "−1" in cell) for cell in markup.cells)


def test_empty_root_still_produces_a_standalone_list(tmp_path):
    html = page(tmp_path)
    assert "0 件" in html or "0件" in html
    assert not any("/evals/" in link for link in Markup(html).links)


def test_escapes_free_text_and_every_display_value(tmp_path):
    malicious = '<img src=x onerror="alert(1)">&\'日本語'
    value = record(changed=malicious, by=malicious, eval_set=malicious)
    value["summary"]["by_task"] = {malicious: {"success": 2, "trials": 4}}
    save(tmp_path, value)
    html = page(tmp_path)
    assert malicious not in html and "<img" not in html
    assert "&lt;img" in html and "&amp;" in html and "&quot;" in html
    assert malicious in " ".join(Markup(html).cells)


def test_invalid_and_unreadable_records_are_reported(tmp_path, monkeypatch):
    save(tmp_path, record())
    corrupt = tmp_path / "member-a" / "ev-corrupt" / "eval.json"
    corrupt.parent.mkdir()
    corrupt.write_text("{broken", encoding="utf-8")
    save(tmp_path, record("ev-schema", schema="wrong"))
    save(tmp_path, record("ev-counts", summary={"success": "bad", "trials": 4}))
    unreadable = save(tmp_path, record("ev-unreadable"))
    original_open = os.open

    def deny_record(path, flags, *args, **kwargs):
        # Descriptor-relative opens are matched by the directory's device and inode,
        # which works on Linux and macOS alike (no /proc).
        directory = kwargs.get("dir_fd")
        if directory is not None:
            st, target = os.fstat(directory), unreadable.parent.stat()
            same_dir = (st.st_dev, st.st_ino) == (target.st_dev, target.st_ino)
            hit = same_dir and os.fsdecode(path) == unreadable.name
        else:
            hit = Path(path) == unreadable
        if hit:
            raise PermissionError("synthetic unreadable record")
        return original_open(path, flags, *args, **kwargs)

    monkeypatch.setattr(eval_index.os, "open", deny_record)
    html = page(tmp_path)
    assert "読めなかった記録" in html
    markup = Markup(html)
    assert "/evals/ev-older" in " ".join(markup.links)
    for eval_id in ("ev-corrupt", "ev-schema", "ev-counts", "ev-unreadable"):
        assert eval_id in html
        assert not any(link.endswith("/" + eval_id) for link in markup.links)


@pytest.mark.parametrize("attempts", [True, "93", -1, 3, 1_000_000_001])
@pytest.mark.parametrize("task", [False, True])
def test_invalid_optional_attempt_counts_are_skipped(tmp_path, attempts, task):
    value = record()
    counts = value["summary"]["by_task"]["task-a"] if task else value["summary"]
    counts["attempts"] = attempts
    save(tmp_path, value)
    html = page(tmp_path)
    assert "読めなかった記録" in html
    assert not any(link.endswith("/ev-older") for link in Markup(html).links)


@pytest.mark.parametrize("bad_id", ["../escape", "ev-x?next=evil", 'ev-\" onclick=\"bad', "ev-x#fragment", "ev-" + "a" * 200])
def test_invalid_eval_ids_never_enter_links(tmp_path, bad_id):
    save(tmp_path, record(eval_id=bad_id), directory="ev-invalid")
    html = page(tmp_path)
    assert not any("/evals/" in link for link in Markup(html).links)
    assert "読めなかった記録" in html


def test_eval_id_must_match_its_directory(tmp_path):
    save(tmp_path, record("ev-other"), directory="ev-mismatch")
    html = page(tmp_path)
    assert not any("/evals/" in link for link in Markup(html).links)
    assert "読めなかった記録" in html


def test_symlinks_at_each_scan_level_do_not_escape_root(tmp_path):
    root = tmp_path / "traces"
    root.mkdir()
    outside = tmp_path / "outside"
    external = save(outside, record("ev-external"))
    (root / "linked-user").symlink_to(outside / "member-a", target_is_directory=True)
    (root / "ev-linked").symlink_to(external.parent, target_is_directory=True)
    local_user = root / "member-b"
    local_user.mkdir()
    (local_user / "ev-nested").symlink_to(external.parent, target_is_directory=True)
    file_link = local_user / "ev-file"
    file_link.mkdir()
    (file_link / "eval.json").symlink_to(external)
    save(root, record("ev-local"))
    html = page(root)
    assert any(link.endswith("/ev-local") for link in Markup(html).links)
    assert not any(link.endswith("/ev-external") for link in Markup(html).links)
    assert "計画器" in html  # The regular local record still appears.


def test_explicit_root_may_be_a_shared_storage_alias(tmp_path):
    root = tmp_path / "team-storage" / "traces"
    save(root, record())
    alias = tmp_path / "shared-storage"
    alias.symlink_to(root.parent, target_is_directory=True)
    html = page(alias / "traces")
    assert any(link.endswith("/ev-older") for link in Markup(html).links)
    assert (root / "index.html").is_file()


@pytest.mark.parametrize("where", ["lock", "output_parent"])
def test_output_symlinks_cannot_modify_files_outside_root(tmp_path, where):
    root = tmp_path / "traces"
    save(root, record())
    outside = tmp_path / "outside"
    outside.mkdir()
    untouched = outside / "index.html"
    untouched.write_text("keep this file", encoding="utf-8")
    if where == "lock":
        (root / "index.html.lock").symlink_to(untouched)
        output = root / "index.html"
    else:
        (root / "redirect").symlink_to(outside, target_is_directory=True)
        output = root / "redirect" / "index.html"
    with pytest.raises((OSError, ValueError)):
        eval_index.build_index(root, output)
    assert untouched.read_text(encoding="utf-8") == "keep this file"
    assert not list(outside.glob("*.lock"))


@pytest.mark.parametrize("viewer_url", ["javascript:alert(1)", "data:text/html,unsafe", "file:///tmp/viewer"])
def test_viewer_link_rejects_unsafe_schemes(tmp_path, viewer_url):
    save(tmp_path, record())
    with pytest.raises(ValueError):
        eval_index.build_index(tmp_path, viewer_url=viewer_url)
    assert not (tmp_path / "index.html").exists()


def test_viewer_url_is_escaped_in_link_attributes(tmp_path):
    save(tmp_path, record())
    viewer_url = 'http://127.0.0.1:8390/path&more" onclick="alert(1)'
    html = page(tmp_path, viewer_url=viewer_url)
    markup = Markup(html)
    assert viewer_url + "/evals/ev-older" in markup.links
    assert all("onclick" not in attrs for attrs in markup.link_attrs)
    assert "&amp;" in html and "&quot;" in html


@pytest.mark.parametrize("content", [
    json.dumps(record()).replace('"by": "member-a"', '"by": NaN'),
    json.dumps(record(changed="\ud800"), ensure_ascii=True),
    '{"schema":"capx-eval/1", "changed":"bad\xff"}',
])
def test_invalid_json_values_and_unicode_are_skipped(tmp_path, content):
    path = tmp_path / "member-a" / "ev-older" / "eval.json"
    path.parent.mkdir(parents=True)
    path.write_bytes(content.encode("latin-1"))
    html = page(tmp_path)
    assert "読めなかった記録" in html
    assert not any("/evals/" in link for link in Markup(html).links)


def test_timestamp_outside_jst_range_does_not_hide_other_records(tmp_path):
    save(tmp_path, record())
    save(tmp_path, record("ev-overflow", started_at="9999-12-31T23:59:59Z"))
    html = page(tmp_path)
    assert "読めなかった記録" in html
    links = Markup(html).links
    assert any(link.endswith("/ev-older") for link in links)
    assert not any(link.endswith("/ev-overflow") for link in links)


def test_undecodable_record_filename_does_not_break_error_section(tmp_path):
    save(tmp_path, record())
    malformed = tmp_path / os.fsdecode(b"ev-\xff")
    try:
        malformed.mkdir()
    except OSError:
        pytest.skip("this file system rejects non-UTF-8 names (for example APFS on macOS)")
    (malformed / "eval.json").write_text("{broken", encoding="utf-8")
    html = page(tmp_path)
    assert "読めなかった記録" in html
    assert any(link.endswith("/ev-older") for link in Markup(html).links)


def test_atomic_replacement_runs_under_exclusive_lock(tmp_path, monkeypatch):
    save(tmp_path, record())
    out = tmp_path / "index.html"
    out.write_text("previous complete list", encoding="utf-8")
    original_replace = os.replace
    original_flock = eval_index.fcntl.flock
    locked = set()
    replacements = []

    def flock(fd, operation):
        if operation & eval_index.fcntl.LOCK_EX:
            locked.add(fd)
        result = original_flock(fd, operation)
        if operation == eval_index.fcntl.LOCK_UN:
            locked.discard(fd)
        return result

    def replace(source, target, *args, **kwargs):
        assert locked
        source_parent = Path(source).parent
        target_parent = Path(target).parent
        if "src_dir_fd" not in kwargs:
            assert source_parent == out.parent
        if "dst_dir_fd" not in kwargs:
            assert target_parent == out.parent
        assert out.read_text(encoding="utf-8") == "previous complete list"
        replacements.append((source, target))
        return original_replace(source, target, *args, **kwargs)

    monkeypatch.setattr(eval_index.fcntl, "flock", flock)
    monkeypatch.setattr(eval_index.os, "replace", replace)
    eval_index.build_index(tmp_path)
    assert len(replacements) == 1
    assert out.read_text(encoding="utf-8").startswith("<!doctype html>") or out.read_text(encoding="utf-8").startswith("<!DOCTYPE html>")


def test_failed_atomic_replacement_preserves_previous_list_and_cleans_temp(tmp_path, monkeypatch):
    save(tmp_path, record())
    out = tmp_path / "index.html"
    out.write_text("previous complete list", encoding="utf-8")
    before = set(tmp_path.iterdir())

    def fail_replace(*args, **kwargs):
        raise OSError("synthetic rename failure")

    monkeypatch.setattr(eval_index.os, "replace", fail_replace)
    with pytest.raises(OSError, match="synthetic rename failure"):
        eval_index.build_index(tmp_path)
    assert out.read_text(encoding="utf-8") == "previous complete list"
    additions = set(tmp_path.iterdir()) - before
    assert all(path.name.endswith(".lock") for path in additions)


def test_shared_mode_group_and_directory_permissions(tmp_path):
    save(tmp_path, record())
    tmp_path.chmod(0o2770)
    directory_before = tmp_path.stat()
    original_umask = os.umask(0o077)
    try:
        out = eval_index.build_index(tmp_path)
    finally:
        os.umask(original_umask)
    assert stat.S_IMODE(out.stat().st_mode) == 0o664
    assert out.stat().st_gid == directory_before.st_gid
    assert stat.S_IMODE(tmp_path.stat().st_mode) == stat.S_IMODE(directory_before.st_mode)
    locks = list(tmp_path.glob("*.lock"))
    assert len(locks) == 1
    assert stat.S_IMODE(locks[0].stat().st_mode) == 0o664
    assert locks[0].stat().st_gid == directory_before.st_gid
    # A second build also works when the shared lock already exists.
    eval_index.build_index(tmp_path)
    assert stat.S_IMODE(out.stat().st_mode) == 0o664


def test_existing_shared_lock_needs_no_owner_only_permission_changes(tmp_path, monkeypatch):
    save(tmp_path, record())
    eval_index.build_index(tmp_path)
    lock = (tmp_path / "index.html.lock").stat()
    original_chmod, original_chown = os.fchmod, os.fchown

    def guard(function):
        def checked(fd, *args, **kwargs):
            info = os.fstat(fd)
            assert (info.st_dev, info.st_ino) != (lock.st_dev, lock.st_ino), "another user's shared lock needs no chmod/chown"
            return function(fd, *args, **kwargs)
        return checked

    monkeypatch.setattr(eval_index.os, "fchmod", guard(original_chmod))
    monkeypatch.setattr(eval_index.os, "fchown", guard(original_chown))
    eval_index.build_index(tmp_path)


def test_concurrent_process_waits_for_shared_lock(tmp_path):
    save(tmp_path, record())
    script = """
import fcntl
from pathlib import Path
import sys
from capx_trace_recorder import eval_index
original = fcntl.flock
def flock(fd, operation):
    if operation & fcntl.LOCK_EX:
        print('waiting', flush=True)
    result = original(fd, operation)
    if operation & fcntl.LOCK_EX:
        print('acquired', flush=True)
    return result
eval_index.fcntl.flock = flock
eval_index.build_index(Path(sys.argv[1]))
print('finished', flush=True)
"""
    lock = os.open(tmp_path / "index.html.lock", os.O_WRONLY | os.O_CREAT, 0o664)
    fcntl.flock(lock, fcntl.LOCK_EX)
    process = subprocess.Popen([sys.executable, "-c", script, str(tmp_path)], text=True,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        ready, _, _ = select.select([process.stdout], [], [], 10)
        assert ready, "index builder did not reach the shared lock"
        assert process.stdout.readline().strip() == "waiting"
        with pytest.raises(subprocess.TimeoutExpired):
            process.communicate(timeout=0.1)
        save(tmp_path, record("ev-created-while-waiting"), user="member-b")
        fcntl.flock(lock, fcntl.LOCK_UN)
        stdout, stderr = process.communicate(timeout=10)
        assert process.returncode == 0, stderr
        assert "acquired" in stdout and "finished" in stdout
        assert (tmp_path / "index.html").is_file()
        assert any(link.endswith("/ev-created-while-waiting")
                   for link in Markup((tmp_path / "index.html").read_text()).links)
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
        os.close(lock)
        if process.poll() is None:
            process.kill()
        process.communicate(timeout=10)


@pytest.mark.parametrize("stored", ["attempts", "logical", "logical_with_attempts"])
@pytest.mark.parametrize("failure", [False, True])
def test_cli_is_usable_without_viewer_or_site_packages(tmp_path, stored, failure):
    package_root = Path(__file__).resolve().parents[2]
    isolated = tmp_path / "isolated"
    isolated.mkdir()
    shutil.copytree(package_root / "capx_trace_recorder", isolated / "capx_trace_recorder")
    root = tmp_path / "records"
    path, value = retried_record(root, stored=stored)
    if failure:
        value["status"] = "interrupted"
        value["summary"]["config_flags"]["evaluation_failure"] = {
            "kind": "incomplete", "reason": "planned trials are incomplete"}
        path.write_text(json.dumps(value), encoding="utf-8")
    out = tmp_path / "portable.html"
    env = {**os.environ, "PYTHONPATH": str(isolated)}
    result = subprocess.run([sys.executable, "-S", "-m", "capx_trace_recorder", "index",
                             "--root", str(root), "--out", str(out),
                             "--viewer-url", "http://127.0.0.1:9001"],
                            cwd=isolated, env=env, text=True, capture_output=True, timeout=15)
    assert result.returncode == 0, result.stderr
    html = out.read_text(encoding="utf-8")
    assert "http://127.0.0.1:9001/evals/ev-retried" in html
    assert eval_index._score(value["summary"]) in html
    if failure:
        assert "未完了" in Markup(html).cells
        assert "planned trials are incomplete" in Markup(html).titles


@pytest.mark.skipif(not hasattr(os, "O_PATH") or os.geteuid() == 0,
                    reason="needs O_PATH (Linux) and a non-root user for permission checks")
def test_search_only_parent_directories_are_allowed(tmp_path):
    # GMO's /home is drwx--x--x: it can be passed through but not listed.
    parent = tmp_path / "home"
    root = parent / "group" / "traces"
    save(root, record())
    parent.chmod(0o111)
    try:
        html = page(root)
        assert any(link.endswith("/ev-older") for link in Markup(html).links)
        assert (root / "index.html").is_file()
    finally:
        parent.chmod(0o755)
