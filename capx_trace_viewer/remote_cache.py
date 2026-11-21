"""Private, persistent stale-while-revalidate cache for remote discovery.

Background scans are serialized; scoped interactive discovery has a separate
worker so it cannot queue behind a team scan. Reading stale or empty snapshots
only schedules work; pages never wait for a remote filesystem scan.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import queue
import stat
import tempfile
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

Listing = dict[str, list[dict[str, Any]]]
MAX_CACHE_BYTES = 64 * 1024 * 1024


class RemoteCacheError(Exception):
    """An explicitly awaited refresh failed or timed out."""


@dataclass
class _Entry:
    data: Listing | None = None
    fetched_at: float | None = None
    expires: float = 0
    error: str | None = None
    fetch_error: str | None = None
    pending: bool = False


class RemoteListingCache:
    def __init__(self, cache_dir: Path, ttl: float = 30, *,
                 validate: Callable[[Listing], Listing | None] | None = None) -> None:
        self.cache_dir = cache_dir
        self.ttl = ttl
        self.validate = validate
        self._condition = threading.Condition()
        self._entries: dict[str, _Entry] = {}
        self._queue: queue.Queue[tuple[str, _Entry, Callable] | None] = queue.Queue()
        self._worker: threading.Thread | None = None
        self._interactive_queue: queue.Queue[tuple[str, _Entry, Callable] | None] = queue.Queue()
        self._interactive_worker: threading.Thread | None = None
        self._closed = False

    def _path(self, key: str) -> Path:
        return self.cache_dir / (hashlib.sha256(key.encode("utf-8")).hexdigest() + ".json")

    def _check_listing(self, value: Any, *, persisted: bool = False) -> Listing:
        if (not isinstance(value, dict) or set(value) != {"episodes", "evals"}
                or any(not isinstance(value[name], list)
                       or any(not isinstance(row, dict) for row in value[name])
                       for name in ("episodes", "evals"))):
            raise ValueError("Invalid cached remote listing")
        if persisted and self.validate is not None:
            try:
                normalized = self.validate(value)
                if normalized is not None:
                    value = self._check_listing(normalized)
            except Exception as exc:
                raise ValueError("Invalid cached remote listing") from exc
        return value

    def _load(self, key: str) -> _Entry:
        try:
            # A cache is optional. Refuse symlinks, special files and public files
            # rather than trusting a listing supplied through another account.
            directory = self.cache_dir.lstat()
            if (not stat.S_ISDIR(directory.st_mode) or stat.S_IMODE(directory.st_mode) & 0o077
                    or (hasattr(os, "getuid") and directory.st_uid != os.getuid())):
                return _Entry()
            fd = os.open(self._path(key), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
                         | getattr(os, "O_NONBLOCK", 0))
            try:
                info = os.fstat(fd)
                if (not stat.S_ISREG(info.st_mode) or info.st_size > MAX_CACHE_BYTES
                        or stat.S_IMODE(info.st_mode) & 0o077
                        or (hasattr(os, "getuid") and info.st_uid != os.getuid())):
                    return _Entry()
                with os.fdopen(fd, "rb", closefd=False) as stream:
                    raw = stream.read(MAX_CACHE_BYTES + 1)
            finally:
                os.close(fd)
            if len(raw) > MAX_CACHE_BYTES:
                return _Entry()
            value = json.loads(raw)
            stamp = value["fetched_at"]
            if (value.get("version") != 1 or not isinstance(stamp, (float, int))
                    or isinstance(stamp, bool) or not math.isfinite(stamp)
                    or not 0 < stamp <= time.time() + 24 * 60 * 60):
                return _Entry()
            data = self._check_listing(value["listing"], persisted=True)
            remaining = max(0, self.ttl - max(0, time.time() - stamp))
            return _Entry(data=data, fetched_at=stamp, expires=time.monotonic() + remaining)
        except (OSError, ValueError, KeyError, TypeError, RecursionError, OverflowError):
            return _Entry()

    def _save(self, key: str, listing: Listing, fetched_at: float) -> None:
        self.cache_dir.mkdir(parents=True, mode=0o700, exist_ok=True)
        info = self.cache_dir.lstat()
        if (not stat.S_ISDIR(info.st_mode)
                or (hasattr(os, "getuid") and info.st_uid != os.getuid())):
            raise OSError("Remote cache directory must be owned by the current user")
        os.chmod(self.cache_dir, 0o700)
        fd, name = tempfile.mkstemp(prefix=".listing-", suffix=".tmp", dir=self.cache_dir)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump({"version": 1, "fetched_at": fetched_at, "listing": listing}, stream,
                          ensure_ascii=True, allow_nan=False, separators=(",", ":"))
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(name, 0o600)
            os.replace(name, self._path(key))
        finally:
            if os.path.exists(name):
                os.unlink(name)

    def _entry(self, key: str) -> _Entry:
        if key not in self._entries:
            self._entries[key] = self._load(key)
        return self._entries[key]

    def snapshot(self, key: str, fetch: Callable[[Listing | None], Listing], *,
                 refresh: bool = False, wait: bool = False, interactive: bool = False) -> Listing:
        """Return last good data, scheduling at most one refresh for this key.

        ``wait`` is reserved for explicit checks/import operations. Even with
        ``wait=True``, a normal stale cache hit returns immediately.
        """
        with self._condition:
            entry = self._entry(key)
            cold = entry.data is None
            if not self._closed and not entry.pending and (refresh or time.monotonic() >= entry.expires):
                entry.pending = True
                work_queue = self._interactive_queue if interactive else self._queue
                work_queue.put((key, entry, fetch))
                worker_attr = "_interactive_worker" if interactive else "_worker"
                if getattr(self, worker_attr) is None:
                    worker = threading.Thread(target=self._run, args=(work_queue,),
                                              name="capx-gmo-runs" if interactive else "capx-gmo-listings",
                                              daemon=True)
                    setattr(self, worker_attr, worker)
                    worker.start()
            if wait and (cold or refresh):
                finished = self._condition.wait_for(lambda: not entry.pending or self._closed, timeout=65)
                if not finished:
                    raise RemoteCacheError("GMO listing refresh timed out")
                if entry.fetch_error is not None:
                    raise RemoteCacheError(entry.fetch_error)
                if entry.data is None:
                    raise RemoteCacheError("GMO listing is unavailable")
            return entry.data if entry.data is not None else {"episodes": [], "evals": []}

    def status(self, key: str) -> dict[str, Any]:
        with self._condition:
            entry = self._entry(key)
            return {
                "fetched_at": (datetime.fromtimestamp(entry.fetched_at, timezone.utc).isoformat()
                               if entry.fetched_at is not None else None),
                "refreshing": entry.pending,
                "error": entry.error,
            }

    def snapshot_with_status(self, key: str, fetch: Callable[[Listing | None], Listing], *,
                             refresh: bool = False, wait: bool = False,
                             interactive: bool = False) -> tuple[Listing, dict[str, Any]]:
        """Read rows and their refresh status as one consistent observation.

        In particular, a cold response must remain marked as refreshing even if
        its worker completes between the page's row and status reads.
        """
        with self._condition:
            data = self.snapshot(key, fetch, refresh=refresh, wait=wait, interactive=interactive)
            return data, self.status(key)

    def invalidate(self, key: str | None = None) -> None:
        """Mark snapshots stale without discarding the last successful listing."""
        with self._condition:
            entries = self._entries.values() if key is None else [self._entry(key)]
            for entry in entries:
                entry.expires = 0

    def _run(self, work_queue: queue.Queue) -> None:
        while True:
            item = work_queue.get()
            if item is None:
                work_queue.task_done()
                return
            key, entry, fetch = item
            try:
                with self._condition:
                    if self._closed:
                        continue
                    previous = entry.data
                data = self._check_listing(fetch(previous))
                fetched_at = time.time()
                error = None
                try:
                    self._save(key, data, fetched_at)
                except (OSError, ValueError) as exc:
                    # Disk failures must not hide a successful remote response.
                    error = f"Cannot persist GMO listing: {exc}"[-300:]
                with self._condition:
                    if not self._closed:
                        entry.data = data
                        entry.fetched_at = fetched_at
                        entry.error = error
                        entry.fetch_error = None
            except Exception as exc:
                with self._condition:
                    entry.error = str(exc)[-300:] or type(exc).__name__
                    entry.fetch_error = entry.error
            finally:
                with self._condition:
                    entry.expires = time.monotonic() + self.ttl
                    entry.pending = False
                    self._condition.notify_all()
                work_queue.task_done()

    def close(self) -> None:
        with self._condition:
            if self._closed:
                return
            self._closed = True
            self._condition.notify_all()
            self._queue.put(None)
            self._interactive_queue.put(None)
            workers = (self._worker, self._interactive_worker)
        for worker in workers:
            if worker is not None:
                worker.join(timeout=1)
