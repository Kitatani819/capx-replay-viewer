"""Private runner names survive standalone discovery and its cached transport."""
from __future__ import annotations

import json
import os

import pytest

from capx_trace_viewer import gmo
from capx_trace_viewer.remote_cache import RemoteListingCache
from test_gmo_listing_fast import LocalRunner


@pytest.mark.parametrize("kind", ["episodes", "evals", "scoped"])
def test_remote_names_merge_existing_shared_roots_first_wins(tmp_path, kind):
    shared, submission = tmp_path / "traces", tmp_path / "submission"
    shared.mkdir()
    submission.mkdir()
    (shared / "names.json").write_text(json.dumps({
        " user_00099_test ": " 山田太郎 ", "invalid": 42, "": "discard", "long": "x" * 201,
    }))
    (submission / "names.json").write_text(json.dumps({
        "user_00099_test": "架空の別名", "user_00098_test": "架空の実行者",
    }))
    settings = gmo.GmoSettings(host="alias", shared_root=str(shared), submission_root=str(submission))
    runner = LocalRunner()
    result = (gmo.list_remote_evals(runner, settings) if kind == "evals" else
              gmo.list_remote_episodes(runner, settings,
                                       **({"run_ids": ("ev-test",), "metadata_only": True}
                                          if kind == "scoped" else {})))
    assert result["names"] == {"user_00099_test": "山田太郎", "user_00098_test": "架空の実行者"}


@pytest.mark.parametrize("state", ["missing", "invalid", "non_object", "oversize", "symlink", "directory", "fifo", "unreadable"])
def test_remote_names_unusable_file_does_not_break_listing(tmp_path, state):
    root = tmp_path / "traces"
    root.mkdir()
    path = root / "names.json"
    if state == "invalid":
        path.write_text("{")
    elif state == "non_object":
        path.write_text('["user_00099_test", "山田太郎"]')
    elif state == "oversize":
        path.write_bytes(b" " * (64 * 1024) + b"{}")
    elif state == "symlink":
        target = tmp_path / "private.json"
        target.write_text('{"user_00099_test": "山田太郎"}')
        path.symlink_to(target)
    elif state == "directory":
        path.mkdir()
    elif state == "fifo":
        os.mkfifo(path)
    elif state == "unreadable":
        path.write_text('{"user_00099_test": "山田太郎"}')
    preamble = ""
    if state == "unreadable":
        preamble = f"""import os
_original_open = os.open
def guarded_open(path, *args, **kwargs):
    if os.fspath(path) == {str(path)!r}:
        raise PermissionError('test unreadable names')
    return _original_open(path, *args, **kwargs)
os.open = guarded_open
"""
    settings = gmo.GmoSettings(host="alias", shared_root=str(root), submission_root="")
    listing = gmo.list_remote_evals(LocalRunner(preamble), settings)
    assert listing["episodes"] == listing["evals"] == []
    assert listing["names"] == {}


@pytest.mark.parametrize("value,expected", [
    (None, {}), ([], {}), ("invalid", {}),
    ({" user_00099_test ": " 山田太郎 ", "": "bad", "empty": "  ", "n": 1,
      "x" * 201: "bad", "long": "x" * 201, "ok": "x" * 200},
     {"user_00099_test": "山田太郎", "ok": "x" * 200}),
])
def test_remote_names_receiving_validation(value, expected):
    assert gmo.validate_remote_listing({"episodes": [], "evals": [], "names": value})["names"] == expected


def test_remote_names_cache_persists_and_reuses_private_names_without_rescan(tmp_path):
    directory = tmp_path / "cache"
    result = {"episodes": [], "evals": [], "names": {"user_00099_test": "山田太郎"}}
    cache = RemoteListingCache(directory, validate=gmo.validate_remote_listing)
    try:
        assert cache.snapshot("site", lambda _: result, wait=True) == result
        cache_path = cache._path("site")
        assert cache_path.stat().st_mode & 0o077 == 0
    finally:
        cache.close()
    cache = RemoteListingCache(directory, validate=gmo.validate_remote_listing)
    try:
        def unexpected_scan(_):
            pytest.fail("Fresh cached names must not need another remote listing")
        assert cache.snapshot("site", unexpected_scan) == result
    finally:
        cache.close()


def test_remote_names_cache_revalidates_names_without_discarding_listing(tmp_path):
    cache = RemoteListingCache(tmp_path / "cache", validate=gmo.validate_remote_listing)
    try:
        cache.snapshot("site", lambda _: {"episodes": [], "evals": []}, wait=True)
        path = cache._path("site")
        saved = json.loads(path.read_text())
        saved["listing"]["names"] = {" user_00099_test ": " 山田太郎 ", "bad": ["discard"]}
        path.write_text(json.dumps(saved))
    finally:
        cache.close()
    cache = RemoteListingCache(tmp_path / "cache", validate=gmo.validate_remote_listing)
    try:
        assert cache.snapshot("site", lambda _: pytest.fail("Must reuse fresh cache"))["names"] == {
            "user_00099_test": "山田太郎"}
    finally:
        cache.close()
