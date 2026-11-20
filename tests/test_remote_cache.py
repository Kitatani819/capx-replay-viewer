"""Remote listing snapshots are immediate, durable and retain the last good data."""
from __future__ import annotations

import json
import stat
import threading
import time

import pytest

from capx_trace_viewer.remote_cache import RemoteCacheError, RemoteListingCache


def listing(value):
    return {"episodes": [{"episode_id": value}], "evals": []}


def finished(cache, key="settings"):
    deadline = time.monotonic() + 3
    while cache.status(key)["refreshing"]:
        assert time.monotonic() < deadline, "Background refresh did not finish"
        time.sleep(0.002)


def test_cache_hit_does_not_call_remote_again(tmp_path):
    calls = []
    cache = RemoteListingCache(tmp_path / "cache")
    try:
        def fetch(previous):
            calls.append(previous)
            return listing("one")

        assert cache.snapshot("settings", fetch, wait=True) == listing("one")
        assert cache.snapshot("settings", fetch) == listing("one")
        assert calls == [None]
        assert cache.status("settings")["fetched_at"] is not None
        assert cache.status("settings")["error"] is None
    finally:
        cache.close()


def test_stale_data_is_immediate_while_one_background_refresh_runs(tmp_path):
    cache = RemoteListingCache(tmp_path / "cache")
    entered, release = threading.Event(), threading.Event()
    calls = []
    try:
        cache.snapshot("settings", lambda previous: listing("old"), wait=True)
        old_stamp = cache.status("settings")["fetched_at"]
        cache.invalidate()

        def fetch(previous):
            calls.append(previous)
            entered.set()
            assert release.wait(3)
            return listing("new")

        start = time.monotonic()
        assert cache.snapshot("settings", fetch) == listing("old")
        assert entered.wait(1)
        for _ in range(10):
            assert cache.snapshot("settings", fetch, refresh=True) == listing("old")
        assert time.monotonic() - start < 0.5
        assert cache.status("settings") == {"fetched_at": old_stamp, "refreshing": True, "error": None}
        assert calls == [listing("old")]
        release.set()
        finished(cache)
        assert cache.snapshot("settings", fetch) == listing("new")
    finally:
        release.set()
        cache.close()


def test_cold_cache_returns_empty_immediately_and_later_fills(tmp_path):
    cache = RemoteListingCache(tmp_path / "cache")
    entered, release = threading.Event(), threading.Event()
    try:
        def fetch(previous):
            entered.set()
            assert release.wait(3)
            return listing("first")

        start = time.monotonic()
        assert cache.snapshot("settings", fetch) == {"episodes": [], "evals": []}
        assert time.monotonic() - start < 0.5
        assert entered.wait(1)
        assert cache.status("settings") == {"fetched_at": None, "refreshing": True, "error": None}
        release.set()
        finished(cache)
        assert cache.snapshot("settings", fetch) == listing("first")
    finally:
        release.set()
        cache.close()


def test_snapshot_and_status_are_atomic_when_cold_refresh_finishes_immediately(tmp_path, monkeypatch):
    cache = RemoteListingCache(tmp_path / "cache")
    snapshot_read, finish_read, fetched = threading.Event(), threading.Event(), threading.Event()
    original_snapshot = cache.snapshot
    pairs = []

    def fetch(previous):
        fetched.set()
        return listing("ready")

    def pause_between_rows_and_status(*args, **kwargs):
        data = original_snapshot(*args, **kwargs)
        snapshot_read.set()
        assert finish_read.wait(3)
        return data

    monkeypatch.setattr(cache, "snapshot", pause_between_rows_and_status)
    reader = threading.Thread(target=lambda: pairs.append(cache.snapshot_with_status("settings", fetch)))
    try:
        reader.start()
        assert snapshot_read.wait(1)
        # Pause exactly between the row and status reads. The worker must not
        # publish its immediately available result during that interval.
        acquired = cache._condition.acquire(timeout=0.02)
        if acquired:
            cache._condition.release()
        assert not acquired
        assert not fetched.is_set()
        finish_read.set()
        reader.join(timeout=1)
        assert not reader.is_alive()
        assert pairs == [({"episodes": [], "evals": []},
                          {"fetched_at": None, "refreshing": True, "error": None})]
        finished(cache)
        data, status = cache.snapshot_with_status("settings", fetch)
        assert data == listing("ready")
        assert status["fetched_at"] is not None and status["refreshing"] is False
    finally:
        finish_read.set()
        reader.join(timeout=1)
        cache.close()


def test_atomic_snapshot_wait_can_release_the_recursive_lock(tmp_path):
    cache = RemoteListingCache(tmp_path / "cache")
    try:
        data, status = cache.snapshot_with_status("settings", lambda previous: listing("ready"), wait=True)
        assert data == listing("ready")
        assert status["fetched_at"] is not None and status["refreshing"] is False
    finally:
        cache.close()


def test_refresh_failure_keeps_old_data_and_throttles_retry(tmp_path):
    cache = RemoteListingCache(tmp_path / "cache")
    calls = []
    try:
        cache.snapshot("settings", lambda previous: listing("good"), wait=True)
        stamp = cache.status("settings")["fetched_at"]

        def fail(previous):
            calls.append(previous)
            raise ValueError("remote unavailable")

        assert cache.snapshot("settings", fail, refresh=True) == listing("good")
        finished(cache)
        assert cache.snapshot("settings", fail) == listing("good")
        assert cache.status("settings") == {"fetched_at": stamp, "refreshing": False, "error": "remote unavailable"}
        assert calls == [listing("good")]
        with pytest.raises(RemoteCacheError, match="remote unavailable"):
            cache.snapshot("settings", fail, refresh=True, wait=True)
    finally:
        cache.close()


def test_disk_failure_does_not_hide_a_successful_remote_listing(tmp_path, monkeypatch):
    cache = RemoteListingCache(tmp_path / "cache")

    def unavailable(*args):
        raise OSError("disk unavailable")

    monkeypatch.setattr(cache, "_save", unavailable)
    try:
        assert cache.snapshot("settings", lambda previous: listing("good"), wait=True) == listing("good")
        assert "Cannot persist GMO listing" in cache.status("settings")["error"]
        assert cache.snapshot("settings", lambda previous: listing("new"), refresh=True, wait=True) == listing("new")
    finally:
        cache.close()


def test_persistence_survives_restart_with_private_permissions_and_settings_key(tmp_path):
    directory = tmp_path / "cache"
    first = RemoteListingCache(directory)
    try:
        first.snapshot("settings", lambda previous: listing("persisted"), wait=True)
        fetched_at = first.status("settings")["fetched_at"]
    finally:
        first.close()
    paths = list(directory.glob("*.json"))
    assert len(paths) == 1
    assert "settings" not in paths[0].name
    assert stat.S_IMODE(directory.stat().st_mode) == 0o700
    assert stat.S_IMODE(paths[0].stat().st_mode) == 0o600
    cache = RemoteListingCache(directory)
    release = threading.Event()
    try:
        def unexpected(previous):
            pytest.fail("Fresh persisted data must not invoke the remote transport")

        assert cache.snapshot("settings", unexpected) == listing("persisted")
        assert cache.status("settings")["fetched_at"] == fetched_at
        assert cache.status("other-settings")["fetched_at"] is None
        def other(previous):
            release.wait(3)
            return listing("other")

        assert cache.snapshot("other-settings", other) == {
            "episodes": [], "evals": []}
    finally:
        release.set()
        cache.close()


def test_refreshes_for_different_keys_are_serialized_without_blocking_pages(tmp_path):
    cache = RemoteListingCache(tmp_path / "cache")
    entered, release, second = threading.Event(), threading.Event(), threading.Event()
    try:
        def slow(previous):
            entered.set()
            assert release.wait(3)
            return listing("first")

        def fast(previous):
            second.set()
            return listing("second")

        cache.snapshot("one", slow)
        assert entered.wait(1)
        assert cache.snapshot("two", fast) == {"episodes": [], "evals": []}
        assert cache.status("two")["refreshing"]
        assert not second.is_set()
        release.set()
        assert second.wait(1)
        finished(cache, "two")
        assert cache.snapshot("two", fast) == listing("second")
    finally:
        release.set()
        cache.close()


@pytest.mark.parametrize("damage", ["bad_json", "invalid_rows", "invalid_timestamp", "huge_timestamp",
                                    "overflow_timestamp", "public", "symlink"])
def test_invalid_or_unsafe_disk_cache_is_ignored(tmp_path, damage):
    cache = RemoteListingCache(tmp_path / "cache")
    try:
        cache.snapshot("settings", lambda previous: listing("old"), wait=True)
    finally:
        cache.close()
    path, = list((tmp_path / "cache").glob("*.json"))
    if damage == "bad_json":
        path.write_text("{")
    elif damage == "invalid_rows":
        value = json.loads(path.read_text())
        value["listing"]["episodes"] = ["untrusted"]
        path.write_text(json.dumps(value))
    elif damage in ("invalid_timestamp", "huge_timestamp", "overflow_timestamp"):
        value = json.loads(path.read_text())
        value["fetched_at"] = {"invalid_timestamp": float("nan"), "huge_timestamp": 1e300,
                               "overflow_timestamp": 10**1000}[damage]
        path.write_text(json.dumps(value))
    elif damage == "public":
        path.chmod(0o644)
    else:
        outside = tmp_path / "outside"
        path.rename(outside)
        path.symlink_to(outside)
    cache = RemoteListingCache(tmp_path / "cache")
    try:
        assert cache.status("settings")["fetched_at"] is None
    finally:
        cache.close()


def test_persisted_listing_runs_validation_callback(tmp_path):
    directory = tmp_path / "cache"
    cache = RemoteListingCache(directory)
    try:
        cache.snapshot("settings", lambda previous: listing("old"), wait=True)
    finally:
        cache.close()
    validated = []

    def validate(value):
        validated.append(json.loads(json.dumps(value)))
        raise ValueError("unsafe remote row")

    cache = RemoteListingCache(directory, validate=validate)
    try:
        assert cache.status("settings")["fetched_at"] is None
        assert validated == [listing("old")]
    finally:
        cache.close()


def test_persisted_listing_applies_validator_normalization(tmp_path):
    directory = tmp_path / "cache"
    cache = RemoteListingCache(directory)
    try:
        cache.snapshot("settings", lambda previous: listing("untrusted"), wait=True)
    finally:
        cache.close()
    cache = RemoteListingCache(directory, validate=lambda value: {"episodes": [], "evals": []})
    try:
        assert cache.snapshot("settings", lambda previous: pytest.fail("unexpected refresh")) == {
            "episodes": [], "evals": []}
    finally:
        cache.close()
