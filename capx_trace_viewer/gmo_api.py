"""Loopback-only GMO configuration, discovery and queued import API."""
from __future__ import annotations

import contextlib
import hashlib
import json
import queue
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from capx_trace_viewer import gmo, reader
from capx_trace_viewer.remote_cache import RemoteCacheError, RemoteListingCache
from capx_trace_viewer.trace_api import (
    client_is_local, host_is_loopback, json_response, origin_is_loopback,
)

CACHE_SECONDS = 30
LIVE_INTERVAL_S = 2.0
LIVE_LEASE_S = 30.0
LIVE_MAX_BACKOFF_S = 30.0
AUTO_FULL_CHECK_S = 30 * 60


def _timestamp(value: float | None = None) -> str:
    return datetime.fromtimestamp(time.time() if value is None else value, timezone.utc).isoformat()


class GmoService:
    def __init__(self, dest: Path, config_path: str | Path | None = None) -> None:
        self.dest = dest
        self._config_path = Path(config_path).expanduser().absolute() if config_path is not None else None
        self.runner = gmo.ProcessRunner()
        self.max_fetch_bytes = gmo.MAX_FETCH_BYTES
        self._lock = threading.Lock()
        self._refresh_lock = threading.Lock()
        self._transfer_lock = threading.Lock()
        self._cache: dict[str, list[dict[str, Any]]] | None = None
        self._cache_settings: gmo.GmoSettings | None = None
        self._cache_until = 0.0
        # Config files normally live side by side. Namespace by the full path,
        # not only the parent, so identical settings never share persisted data.
        cache_namespace = hashlib.sha256(str(self.config_path).encode("utf-8")).hexdigest()[:16]
        self._listings = RemoteListingCache(
            self.config_path.parent / "cache" / "remote-listings" / cache_namespace, ttl=CACHE_SECONDS,
            validate=lambda value: gmo.validate_remote_listing(value),
        )
        self._generation = 0
        self._jobs: list[dict[str, Any]] = []
        self._pending: set[tuple[str, str]] = set()
        self._queue: queue.Queue[tuple[dict[str, Any], gmo.GmoSettings, dict[str, Any],
                                      gmo.RemoteRun | None, dict[str, Any] | None] | None] = queue.Queue()
        self._worker: threading.Thread | None = None
        self._closed = False
        self._auto_thread: threading.Thread | None = None
        self._auto_wake = threading.Event()
        self._auto_settings: gmo.GmoSettings | None = None
        self._auto_paused = False
        self._auto_running = False
        self._auto_failures = 0
        self._auto_run_id = 0
        self._auto_last_run_at: str | None = None
        self._auto_next_at: str | None = None
        self._auto_next: float | None = None
        self._auto_last_error: str | None = None
        self._auto_queued = 0
        self._auto_jobs_pending = 0
        self._auto_skipped: list[dict[str, Any]] = []
        self._auto_listing: dict[str, list[dict[str, Any]]] | None = None
        self._auto_listing_generation = self._generation
        self._auto_confirmed: set[tuple[str, str]] = set()
        self._auto_last_full_check: float | None = None
        self._live: dict[str, Any] | None = None
        self._live_settings: gmo.GmoSettings | None = None
        self._live_thread: threading.Thread | None = None
        self._live_cycle_thread: threading.Thread | None = None
        self._live_wake = threading.Event()
        self._live_status: dict[str, Any] = {
            "following": False, "run_id": None, "episode_id": None,
            "last_ok_at": None, "last_error": None, "interval_s": LIVE_INTERVAL_S,
            "copied_bytes": 0, "stopped_reason": None,
        }

    @property
    def config_path(self) -> Path:
        return self._config_path if self._config_path is not None else gmo.config_path()

    def load_settings(self) -> gmo.GmoSettings:
        # Keep the legacy environment/default behavior when no path was supplied.
        return gmo.load_settings() if self._config_path is None else gmo.load_settings(self._config_path)

    def invalidate(self) -> None:
        with self._lock:
            self._invalidate_locked()

    def _invalidate_locked(self) -> None:
        self._generation += 1
        self._cache = None
        self._cache_settings = None
        self._cache_until = 0
        self._listings.invalidate()
        self._reset_auto_listing_locked()

    def update_settings(self, settings: gmo.GmoSettings) -> None:
        # Publication of settings and invalidation must be atomic with respect to
        # both a completing listing and enqueue's final snapshot check.
        with self._lock:
            gmo.save_settings(settings, self.config_path)
            self._invalidate_locked()
            self._sync_auto_settings_locked(settings)
            stopped = self._stop_live_locked("settings_changed") if self._live and settings != self._live["settings"] else None
        if stopped is not None:
            stopped.close()
        self._live_wake.set()
        self._auto_wake.set()

    def _stop_live_locked(self, reason: str) -> gmo.ProcessRunner | None:
        if self._live is None:
            return None
        runner = self._live["runner"]
        self._live = None
        self._live_status.update(following=False, stopped_reason=reason)
        return runner

    def live_status(self) -> dict[str, Any]:
        with self._lock:
            return dict(self._live_status)

    def follow(self, run_id: str, episode_id: str) -> dict[str, Any]:
        """Start one remote follower, or renew its lease without another listing."""
        key = (run_id, episode_id)
        with self._lock:
            if self._closed:
                raise gmo.FetchError("GMO service is shutting down")
            settings = self.load_settings()
            if self._live and self._live["key"] == key and self._live["settings"] == settings:
                self._live["lease_until"] = time.monotonic() + LIVE_LEASE_S
                self._live_wake.set()
                return dict(self._live_status)
            if (self._live_status["stopped_reason"] == "episode_ended"
                    and (self._live_status["run_id"], self._live_status["episode_id"]) == key
                    and self._live_settings == settings):
                return dict(self._live_status)
        row, settings, generation = self._episode_row(run_id, episode_id)
        with self._lock:
            if self._closed:
                raise gmo.FetchError("GMO service is shutting down")
            if generation != self._generation or settings != self.load_settings():
                raise gmo.FetchError("GMO settings changed during listing; please retry")
            if self._live and self._live["key"] == key and self._live["settings"] == settings:
                self._live["lease_until"] = time.monotonic() + LIVE_LEASE_S
                return dict(self._live_status)
            stopped = self._stop_live_locked("replaced")
            self._live_settings = settings
            self._live = {
                "key": key, "row": row, "settings": settings, "runner": gmo.ProcessRunner(),
                "lease_until": time.monotonic() + LIVE_LEASE_S, "next": time.monotonic(),
                "failures": 0, "end_seen": False, "offset": 0, "generation": None,
            }
            self._live_status = {
                "following": True, "run_id": run_id, "episode_id": episode_id,
                "last_ok_at": None, "last_error": None, "interval_s": LIVE_INTERVAL_S,
                "copied_bytes": 0, "stopped_reason": None,
            }
            if self._live_thread is None:
                self._live_thread = threading.Thread(target=self._live_loop, name="capx-gmo-live", daemon=True)
                self._live_thread.start()
            status = dict(self._live_status)
        if stopped is not None:
            stopped.close()
        self._live_wake.set()
        return status

    def _live_loop(self) -> None:
        # This monitor stays responsive while a manifest/rsync is in flight. A
        # closed page must also stop a slow transfer when its lease expires.
        while True:
            self._live_wake.clear()
            stopped = None
            with self._lock:
                if self._closed:
                    return
                live = self._live
                if live is not None:
                    try:
                        changed = live["settings"] != self.load_settings()
                    except (gmo.FetchError, OSError) as exc:
                        changed = True
                        self._live_status["last_error"] = str(exc)[-300:]
                    if changed:
                        stopped = self._stop_live_locked("settings_changed")
                    elif time.monotonic() >= live["lease_until"]:
                        stopped = self._stop_live_locked("lease_expired")
                    elif (time.monotonic() >= live["next"]
                          and (self._live_cycle_thread is None or not self._live_cycle_thread.is_alive())):
                        self._live_cycle_thread = threading.Thread(
                            target=self._run_live_cycle, args=(live,), name="capx-gmo-live-copy", daemon=True)
                        self._live_cycle_thread.start()
            if stopped is not None:
                stopped.close()
            self._live_wake.wait(timeout=0.25)

    def _live_episode_ended(self, live: dict[str, Any]) -> bool:
        """Read only the newly copied event tail, through the reader's safe opens."""
        with reader.Dir.open_below(self.dest, live["key"]) as directory:
            metadata, _error, _st = reader.read_json_at(directory, "episode.json")
            try:
                fd, st = directory.open_file("events.jsonl")
            except FileNotFoundError:
                return False
            try:
                generation = reader.events_generation(fd, st)
                if generation != live["generation"] or live["offset"] > st.st_size:
                    live.update(generation=generation, offset=0, end_seen=False)
                while True:
                    page = reader.read_events_page(fd, live["offset"])
                    if any(event.get("event_type") == "episode_end" for event in page.events()):
                        live["end_seen"] = True
                    previous = live["offset"]
                    live["offset"] = page.next_offset
                    if page.eof or page.next_offset == previous:
                        break
            finally:
                reader.close_quietly(fd)
        return live["end_seen"] and not (isinstance(metadata, dict) and metadata.get("video_copy_pending") is True)

    def _run_live_cycle(self, live: dict[str, Any]) -> None:
        started = time.monotonic()
        stopped = None
        try:
            with self._transfer_lock:
                with self._lock:
                    if self._closed or self._live is not live:
                        return
                changes: list[str] = []
                end_seen = live["end_seen"]
                size = gmo.fetch_episode(live["runner"], live["settings"], live["row"], self.dest,
                                         max_bytes=self.max_fetch_bytes, changes=changes)
                ended = self._live_episode_ended(live)
            with self._lock:
                if self._live is not live:
                    return
                live["failures"] = 0
                live["next"] = started + LIVE_INTERVAL_S
                self._live_status.update(last_ok_at=_timestamp(), last_error=None, interval_s=LIVE_INTERVAL_S,
                                         copied_bytes=self._live_status["copied_bytes"] + size)
                if end_seen and ended and not changes:
                    stopped = self._stop_live_locked("episode_ended")
        except Exception as exc:
            with self._lock:
                if self._live is live:
                    live["failures"] += 1
                    delay = min(LIVE_MAX_BACKOFF_S, LIVE_INTERVAL_S * 2 ** min(live["failures"], 30))
                    live["next"] = time.monotonic() + delay
                    self._live_status.update(last_error=str(exc)[-300:], interval_s=delay)
        finally:
            if stopped is not None:
                stopped.close()
            self._live_wake.set()

    @staticmethod
    def _auto_enabled(settings: gmo.GmoSettings) -> bool:
        return bool(settings.configured and (settings.shared_root or settings.submission_root or settings.mine)
                    and settings.interval_s > 0)

    def _schedule_auto_locked(self, settings: gmo.GmoSettings) -> None:
        if self._closed or self._auto_paused or not self._auto_enabled(settings):
            self._auto_next = self._auto_next_at = None
            return
        delay = settings.interval_s if not self._auto_failures else min(
            1800, settings.interval_s * 2 ** min(self._auto_failures, 30))
        self._auto_next = time.monotonic() + delay
        self._auto_next_at = _timestamp(time.time() + delay)

    def _reset_auto_listing_locked(self) -> None:
        self._auto_listing = None
        self._auto_listing_generation = self._generation
        self._auto_confirmed.clear()
        self._auto_last_full_check = None

    def _sync_auto_settings_locked(self, settings: gmo.GmoSettings) -> None:
        if settings != self._auto_settings:
            self._auto_settings = settings
            self._reset_auto_listing_locked()
            self._auto_failures = 0
            self._auto_last_error = None
            self._schedule_auto_locked(settings)

    def _auto_status_locked(self, settings: gmo.GmoSettings) -> dict[str, Any]:
        return {
            "enabled": self._auto_enabled(settings), "paused": self._auto_paused,
            "interval_s": settings.interval_s, "running": self._auto_running,
            "last_run_at": self._auto_last_run_at, "next_run_at": self._auto_next_at,
            "last_error": self._auto_last_error, "queued_in_last_run": self._auto_queued,
            "skipped_large": [dict(row) for row in self._auto_skipped],
        }

    def auto_status(self) -> dict[str, Any]:
        with self._lock:
            settings = self.load_settings()
            self._sync_auto_settings_locked(settings)
            return self._auto_status_locked(settings)

    def set_auto_paused(self, paused: bool) -> dict[str, Any]:
        with self._lock:
            settings = self.load_settings()
            self._sync_auto_settings_locked(settings)
            if paused != self._auto_paused:
                self._auto_paused = paused
                self._schedule_auto_locked(settings)
            status = self._auto_status_locked(settings)
        self._auto_wake.set()
        return status

    def start_auto(self) -> None:
        with self._lock:
            if self._closed or self._auto_thread is not None:
                return
            self._auto_thread = threading.Thread(target=self._auto_loop, name="capx-gmo-auto", daemon=True)
            self._auto_thread.start()

    def _auto_loop(self) -> None:
        while True:
            self._auto_wake.clear()
            try:
                with self._lock:
                    if self._closed:
                        return
                    settings = self.load_settings()
                    self._sync_auto_settings_locked(settings)
                    due = None if self._auto_running else self._auto_next
                if due is not None and due <= time.monotonic():
                    self.run_auto_once()
                    continue
            except (gmo.FetchError, OSError) as exc:
                with self._lock:
                    self._auto_last_error = str(exc)[-300:]
                due = None
            # Also observe config-file changes made outside the API.
            self._auto_wake.wait(timeout=min(1, max(0, due - time.monotonic())) if due is not None else 1)

    def run_auto_once(self) -> dict[str, Any]:
        """Discover mine once and enqueue a bounded batch on the manual worker."""
        with self._lock:
            settings = self.load_settings()
            self._sync_auto_settings_locked(settings)
            if self._closed or self._auto_paused or self._auto_running or not self._auto_enabled(settings):
                return self._auto_status_locked(settings)
            self._auto_running = True
            self._auto_run_id += 1
            batch = {"run_id": self._auto_run_id, "generation": self._generation,
                     "failed": False, "remaining": 0}
            generation = self._generation
            if self._auto_listing_generation != generation:
                self._reset_auto_listing_locked()
            previous = self._auto_listing
            confirmed = set(self._auto_confirmed)
            started = time.monotonic()
            full_check = (self._auto_last_full_check is None
                          or started - self._auto_last_full_check >= AUTO_FULL_CHECK_S)
            self._auto_last_run_at = _timestamp()
            self._auto_next = self._auto_next_at = None
            self._auto_queued = 0
            self._auto_skipped = []
        try:
            with self._refresh_lock:
                listing = gmo.list_remote_episodes(self.runner, settings, mine_only=True, previous=previous,
                                                  timeout=gmo.FILE_LISTING_TIMEOUT_S)
            prior = {(row["path"], row["episode_id"]): row
                     for row in (previous or {}).get("episodes", [])}
            # Recheck if a confirmed directory was removed or replaced with a
            # symlink, so the exact preflight still enforces safe destinations.
            local_episodes = (self.dest / prior[key]["run_id"] / key[1]
                              for key in confirmed if key in prior)
            if any(local.parent.is_symlink() or local.is_symlink() or not local.is_dir()
                   for local in local_episodes):
                full_check = True
            unchanged = {
                (row["path"], row["episode_id"]) for row in listing["episodes"]
                if row.get("fingerprint") is not None
                and row["fingerprint"] == prior.get((row["path"], row["episode_id"]), {}).get("fingerprint")
                and row["mine"] and not row["conflict"]
            }
            confirmed.intersection_update(unchanged)
            run_ids = tuple(sorted({row["run_id"] for row in listing["episodes"]
                                    if row["mine"] and not row["conflict"]
                                    and (row["path"], row["episode_id"]) not in confirmed}))
            rows = []
            if full_check or run_ids:
                with self._lock:
                    if self._closed or self._auto_paused:
                        raise gmo.FetchError("GMO automatic import was stopped")
                    if generation != self._generation or settings != self.load_settings():
                        raise gmo.FetchError("GMO settings changed during listing; please retry")
                with self._refresh_lock:
                    rows = gmo.list_remote_episodes(
                        self.runner, settings, include_files=True, mine_only=True,
                        **({} if full_check else {"run_ids": run_ids}),
                        timeout=gmo.FILE_LISTING_TIMEOUT_S,
                    )["episodes"]
                confirmed.difference_update((row["path"], row["episode_id"]) for row in listing["episodes"]
                                            if full_check or row["run_id"] in run_ids)
            plans = []
            for row in sorted(rows, key=lambda r: (r["max_mtime"] or 0, r["run_id"], r["episode_id"]),
                              reverse=True):
                if not row["mine"] or row["conflict"]:
                    continue
                run = gmo.episode_manifest(row, row)
                files = gmo._episode_changes(run, row["episode_id"], self.dest)
                if files:
                    plans.append((row, run, files))
                else:
                    confirmed.add((row["path"], row["episode_id"]))
            with self._lock:
                if self._closed or self._auto_paused:
                    raise gmo.FetchError("GMO automatic import was stopped")
                if generation != self._generation or settings != self.load_settings():
                    raise gmo.FetchError("GMO settings changed during listing; please retry")
                self._auto_listing = listing
                self._auto_confirmed = confirmed
                if full_check:
                    self._auto_last_full_check = started
                reserved: set[tuple[str, str]] = set()
                budget = 0
                for row, run, files in plans:
                    key = (row["run_id"], row["episode_id"])
                    if key in self._pending:
                        continue
                    files = [f for f in files if (run.path, f[0]) not in reserved]
                    if not files:
                        continue
                    size = sum(f[1] for f in files)
                    if budget + size >= self.max_fetch_bytes:
                        self._auto_skipped.append({"run_id": key[0], "episode_id": key[1], "size_bytes": size})
                        continue
                    budget += size
                    reserved.update((run.path, rel) for rel, _, _ in files)
                    self._enqueue_locked(row, settings, gmo.RemoteRun(run.run_id, run.path, files), batch)
                    self._auto_queued += 1
                # A mine-only scan must not replace a complete team snapshot.
                if self._auto_queued:
                    self._listings.invalidate()
                if self._auto_jobs_pending == 0:
                    self._auto_last_error = None
                    self._auto_failures = 0
        except Exception as exc:
            with self._lock:
                if (not self._closed and not self._auto_paused and generation == self._generation
                        and settings == self._auto_settings):
                    self._auto_last_error = str(exc)[-300:]
                    self._auto_failures += 1
        finally:
            with self._lock:
                self._auto_running = False
                self._schedule_auto_locked(self._auto_settings or settings)
            self._auto_wake.set()
        return self.auto_status()

    @staticmethod
    def _listing_key(settings: gmo.GmoSettings, kind: str, run_ids: tuple[str, ...] = ()) -> str:
        return json.dumps({"version": 2, "settings": settings.as_dict(), "kind": kind,
                           "run_ids": run_ids}, sort_keys=True, separators=(",", ":"))

    def remote_rows(self, *, refresh: bool = False, wait: bool = True) -> list[dict[str, Any]]:
        return self.remote_listing(refresh=refresh, wait=wait)["episodes"]

    def remote_evals(self, *, refresh: bool = False) -> list[dict[str, Any]]:
        return self.remote_eval_listing(refresh=refresh, wait=True)["evals"]

    def remote_listing(self, *, refresh: bool = False, wait: bool = True) -> dict[str, list[dict[str, Any]]]:
        return self._remote_snapshot(refresh=refresh, wait=wait)[0]

    def remote_eval_listing(self, *, refresh: bool = False, wait: bool = False) -> dict[str, list[dict[str, Any]]]:
        return self._remote_snapshot(kind="evals", refresh=refresh, wait=wait)[0]

    def remote_eval_snapshot(self, *, refresh: bool = False):
        status: dict[str, Any] = {}
        listing = self._remote_snapshot(kind="evals", refresh=refresh, wait=False, status_out=status)[0]
        return listing, status

    def eval_episode_listing(self, run_id: str, *, refresh: bool = False) -> dict[str, list[dict[str, Any]]]:
        if not reader.is_valid_id(run_id):
            raise gmo.FetchError("Invalid run ID")
        return self._remote_snapshot(kind="run", run_ids=(run_id,), refresh=refresh, wait=False)[0]

    def eval_episode_snapshot(self, run_id: str, *, refresh: bool = False):
        if not reader.is_valid_id(run_id):
            raise gmo.FetchError("Invalid run ID")
        status: dict[str, Any] = {}
        listing = self._remote_snapshot(kind="run", run_ids=(run_id,), refresh=refresh,
                                        wait=False, status_out=status)[0]
        return listing, status

    def listing_status(self, kind: str = "episodes", run_ids: tuple[str, ...] = ()) -> dict[str, Any]:
        settings = self.load_settings()
        return self._listings.status(self._listing_key(settings, kind, run_ids))

    def read_code_changes(self, eval_id: str) -> bytes:
        listing, settings, generation = self._remote_snapshot(kind="evals")
        rows = [row for row in listing["evals"] if row["run_id"] == eval_id]
        if len(rows) != 1 or rows[0].get("conflict"):
            raise gmo.FetchError("Evaluation is missing or ambiguous")
        data = gmo.read_remote_code_changes(self.runner, settings, rows[0])
        with self._lock:
            if generation != self._generation or settings != self.load_settings():
                raise gmo.FetchError("GMO settings changed; please retry")
        return data

    def _remote_snapshot(self, *, refresh: bool = False, wait: bool = True,
                         kind: str = "episodes", run_ids: tuple[str, ...] = (),
                         status_out: dict[str, Any] | None = None
                         ) -> tuple[dict[str, list[dict[str, Any]]], gmo.GmoSettings, int]:
        with self._lock:
            if self._closed:
                raise gmo.FetchError("GMO service is shutting down")
            settings = self.load_settings()
            generation = self._generation
        key = self._listing_key(settings, kind, run_ids)
        # Fetch/live actions may follow a picker lookup immediately. Reuse that
        # complete snapshot instead of making another remote trip for the run.
        if kind == "run" and wait:
            with self._lock:
                if (not refresh and self._cache is not None and self._cache_settings == settings
                        and time.monotonic() < self._cache_until):
                    rows = {"episodes": [row for row in self._cache["episodes"] if row["run_id"] in run_ids],
                            "evals": [row for row in self._cache["evals"] if row["run_id"] in run_ids]}
                    if rows["episodes"]:
                        return rows, settings, generation

        def fetch(previous):
            # A single run's metadata is small and is what an open trial waits on
            # (Live, fetch). It must not queue behind a team listing or the
            # background import, which can each hold the lock for over a minute.
            with self._refresh_lock if kind != "run" else contextlib.nullcontext():
                if kind == "evals":
                    rows = gmo.list_remote_evals(self.runner, settings)
                else:
                    kwargs = {"previous": previous} if previous is not None else {}
                    if run_ids:
                        kwargs["run_ids"] = run_ids
                        kwargs["metadata_only"] = True
                    else:
                        kwargs["timeout"] = gmo.TEAM_LISTING_TIMEOUT_S
                    rows = gmo.list_remote_episodes(self.runner, settings, **kwargs)
                with self._lock:
                    if self._closed:
                        raise gmo.FetchError("GMO service is shutting down")
                    if generation != self._generation or settings != self.load_settings():
                        raise gmo.FetchError("GMO settings changed during listing; please retry")
                return rows

        try:
            rows, status = self._listings.snapshot_with_status(
                key, fetch, refresh=refresh, wait=wait, interactive=kind == "run")
            if status_out is not None:
                status_out.update(status)
        except RemoteCacheError as exc:
            raise gmo.FetchError(str(exc)) from exc
        with self._lock:
            if generation != self._generation or settings != self.load_settings():
                raise gmo.FetchError("GMO settings changed during listing; please retry")
            if kind == "episodes" and status["fetched_at"] is not None:
                self._cache, self._cache_settings = rows, settings
                fetched = datetime.fromisoformat(status["fetched_at"]).timestamp()
                self._cache_until = time.monotonic() + max(0, CACHE_SECONDS - (time.time() - fetched))
        return rows, settings, generation

    def episodes(self, scope: str, *, refresh: bool = False, wait: bool = True) -> list[dict[str, Any]]:
        rows = self.remote_rows(refresh=refresh, wait=wait)
        with self._lock:
            pending = set(self._pending)
        return [self._episode_view(row, pending) for row in rows
                if scope == "all" or row["mine"] == (scope == "mine")]

    def episode(self, run_id: str, episode_id: str, *, refresh: bool = False) -> dict[str, Any]:
        """One trial's GMO state from a listing of its own run only.

        The team listing walks every run and can take minutes on a busy shared
        folder; an open trial must not wait for it to decide whether to go Live.
        """
        row, _, _ = self._episode_row(run_id, episode_id, refresh=refresh)
        with self._lock:
            pending = set(self._pending)
        return self._episode_view(row, pending)

    def _episode_view(self, row: dict[str, Any], pending: set[tuple[str, str]]) -> dict[str, Any]:
        summary = reader.episode_summary_from_metadata(
            row["run_id"], row["episode_id"], row["episode_json"],
            episode_json_error=row["episode_json_error"],
            episode_mtime=row["episode_mtime"],
            heartbeat_mtime=row["heartbeat_mtime"],
            events_mtime=row["events_mtime"],
            events_bytes=row["events_bytes"], now=row["remote_now"],
            first_event=row["first_event"],
        )
        summary.update({
            "owner": row["owner"], "mine": row["mine"],
            "size_bytes": row["size_bytes"],
            **({"size_approximate": True} if row.get("size_approximate") else {}),
            "local_state": "fetching" if (row["run_id"], row["episode_id"]) in pending
            else gmo.local_state(row, self.dest),
            "conflict": row["conflict"],
        })
        return summary

    def enqueue(self, run_id: str, episode_id: str) -> str:
        key = (run_id, episode_id)
        with self._lock:
            if self._closed:
                raise gmo.FetchError("GMO service is shutting down")
            if key in self._pending:
                raise HTTPException(409, "This episode is already queued or running")
        row, settings, generation = self._episode_row(run_id, episode_id)
        with self._lock:
            if self._closed:
                raise gmo.FetchError("GMO service is shutting down")
            if generation != self._generation or settings != self.load_settings():
                raise gmo.FetchError("GMO settings changed during listing; please retry")
            if key in self._pending:
                raise HTTPException(409, "This episode is already queued or running")
            return self._enqueue_locked(row, settings)

    def _episode_row(self, run_id: str, episode_id: str, *, refresh: bool = False
                     ) -> tuple[dict[str, Any], gmo.GmoSettings, int]:
        """One shared lookup for manual fetches and live followers."""
        key = (run_id, episode_id)
        listing, settings, generation = self._remote_snapshot(kind="run", run_ids=(run_id,), refresh=refresh)
        matches = [row for row in listing["episodes"] if (row["run_id"], row["episode_id"]) == key]
        if not matches:
            raise HTTPException(404, "Episode not found on GMO")
        if any(row["conflict"] for row in matches):
            raise HTTPException(409, "Run ID exists in more than one GMO location")
        with self._lock:
            if self._closed:
                raise gmo.FetchError("GMO service is shutting down")
            if generation != self._generation or settings != self.load_settings():
                raise gmo.FetchError("GMO settings changed during listing; please retry")
            return matches[0], settings, generation

    def _enqueue_locked(self, row: dict[str, Any], settings: gmo.GmoSettings,
                        manifest: gmo.RemoteRun | None = None,
                        batch: dict[str, Any] | None = None) -> str:
        run_id, episode_id = row["run_id"], row["episode_id"]
        job = {
            "job_id": uuid.uuid4().hex, "run_id": run_id, "episode_id": episode_id,
            "state": "queued", "bytes": 0, "error": None, "note": None,
            "started_at": None, "finished_at": None,
        }
        self._jobs.append(job)
        self._jobs = self._jobs[-50:]
        self._pending.add((run_id, episode_id))
        if batch is not None:
            batch["remaining"] += 1
            self._auto_jobs_pending += 1
        if self._worker is None:
            self._worker = threading.Thread(target=self._work, name="capx-gmo-fetch", daemon=True)
            self._worker.start()
        self._queue.put((job, settings, row, manifest, batch))
        return job["job_id"]

    def jobs(self) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(job) for job in reversed(self._jobs)]

    def _work(self) -> None:
        while True:
            item = self._queue.get()
            if item is None:
                self._queue.task_done()
                return
            job, settings, row, manifest, batch = item
            key = (job["run_id"], job["episode_id"])
            with self._lock:
                job["state"] = "running"
                job["started_at"] = _timestamp()
            try:
                notes: list[str] = []
                with self._transfer_lock:
                    with self._lock:
                        if self._closed:
                            raise gmo.FetchError("GMO service is shutting down")
                    if manifest is None:
                        size = gmo.fetch_episode(self.runner, settings, row, self.dest,
                                                 max_bytes=self.max_fetch_bytes, notes=notes)
                    else:
                        size = gmo._transfer_episode(self.runner, settings, manifest, row["episode_id"], self.dest,
                                                     max_bytes=self.max_fetch_bytes,
                                                     deadline=time.monotonic() + 30 * 60, notes=notes)
            except Exception as exc:
                with self._lock:
                    job["state"] = "failed"
                    job["error"] = str(exc)[-300:]
                    if (batch is not None and not self._closed and not batch["failed"]
                            and batch["generation"] == self._generation and settings == self._auto_settings):
                        batch["failed"] = True
                        self._auto_last_error = job["error"]
                        self._auto_failures += 1
                        self._schedule_auto_locked(self._auto_settings or settings)
                        self._auto_wake.set()
            else:
                with self._lock:
                    job["state"] = "done"
                    job["bytes"] = size
                    job["note"] = "; ".join(notes) or None
            finally:
                with self._lock:
                    job["finished_at"] = _timestamp()
                    self._pending.discard(key)
                    if batch is not None:
                        self._auto_jobs_pending -= 1
                        batch["remaining"] -= 1
                        if (not self._closed and batch["remaining"] == 0 and not batch["failed"]
                                and batch["run_id"] == self._auto_run_id and batch["generation"] == self._generation
                                and settings == self._auto_settings):
                            self._auto_last_error = None
                            self._auto_failures = 0
                            self._schedule_auto_locked(self._auto_settings or settings)
                            self._auto_wake.set()
                self._queue.task_done()

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._auto_next = self._auto_next_at = None
            stopped = self._stop_live_locked("shutdown")
        self._auto_wake.set()
        self._live_wake.set()
        if stopped is not None:
            stopped.close()
        self.runner.close()
        self._listings.close()
        if self._live_thread is not None:
            self._live_thread.join(timeout=5)
        if self._live_cycle_thread is not None:
            self._live_cycle_thread.join(timeout=5)
        if self._auto_thread is not None:
            self._auto_thread.join(timeout=5)
        if self._worker is not None:
            self._queue.put(None)
            self._worker.join(timeout=5)


def create_gmo_router(service: GmoService, *, unix_socket: bool = False,
                      prefix: str = "/api/gmo") -> APIRouter:
    """``unix_socket``: the server listens on a ``--uds`` socket, whose requests carry no
    client address (see ``trace_api.client_is_local``)."""
    def gate(request: Request) -> None:
        if (not client_is_local(request, unix_socket=unix_socket)
                or not host_is_loopback(request.headers.get("host"))):
            raise HTTPException(403, "The GMO API accepts loopback requests only")
        origin = request.headers.get("origin")
        if origin is not None and not origin_is_loopback(origin):
            raise HTTPException(403, "The GMO API accepts loopback pages only")
        if request.headers.get("x-capx-request") != "gmo":
            raise HTTPException(403, "X-CapX-Request: gmo is required")
        if request.method in ("PUT", "POST"):
            if origin is None or origin.strip().lower() == "null" or not origin_is_loopback(origin):
                raise HTTPException(403, "A loopback Origin is required")
            if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
                raise HTTPException(415, "Content-Type: application/json is required")

    router = APIRouter(prefix=prefix, dependencies=[Depends(gate)])

    @router.get("/config")
    def get_config():
        try:
            settings = service.load_settings()
        except gmo.FetchError as exc:
            raise HTTPException(500, str(exc)) from exc
        return json_response({
            "enabled": True, "configured": settings.configured,
            "settings": settings.as_dict(), "dest": str(service.dest),
            "config_path": str(service.config_path),
        })

    @router.get("/auto")
    def get_auto():
        try:
            return json_response(service.auto_status())
        except (gmo.FetchError, OSError) as exc:
            raise HTTPException(500, str(exc)[-300:]) from exc

    @router.put("/auto")
    async def put_auto(request: Request):
        try:
            data = await request.json()
        except ValueError as exc:
            raise HTTPException(400, "Invalid JSON body") from exc
        if not isinstance(data, dict) or set(data) != {"paused"} or type(data["paused"]) is not bool:
            raise HTTPException(400, "paused must be a boolean")
        try:
            return json_response(await run_in_threadpool(service.set_auto_paused, data["paused"]))
        except (gmo.FetchError, OSError) as exc:
            raise HTTPException(500, str(exc)[-300:]) from exc

    @router.put("/config")
    async def put_config(request: Request):
        try:
            data = await request.json()
            settings = gmo.GmoSettings.from_dict(data)
            await run_in_threadpool(service.update_settings, settings)
        except (ValueError, gmo.FetchError) as exc:
            raise HTTPException(400, str(exc)) from exc
        except OSError as exc:
            raise HTTPException(500, f"Cannot save GMO settings: {exc.strerror or exc}") from exc
        return json_response({
            "enabled": True, "configured": settings.configured,
            "settings": settings.as_dict(), "dest": str(service.dest),
            "config_path": str(service.config_path),
        })

    @router.post("/check")
    def check():
        try:
            rows = service.remote_rows(refresh=True)
        except (gmo.FetchError, OSError) as exc:
            return json_response({"ok": False, "mine_episodes": 0, "team_episodes": 0,
                                  "error": str(exc)[-300:]})
        return json_response({
            "ok": True, "mine_episodes": sum(row["mine"] for row in rows),
            "team_episodes": sum(not row["mine"] for row in rows), "error": None,
        })

    @router.get("/episodes")
    def episodes(scope: str = "all", refresh: int = 0):
        if scope not in ("all", "mine", "team") or refresh not in (0, 1):
            raise HTTPException(400, "scope must be all, mine or team; refresh must be 0 or 1")
        try:
            return json_response(service.episodes(scope, refresh=bool(refresh), wait=False))
        except (gmo.FetchError, OSError) as exc:
            raise HTTPException(502, str(exc)[-300:]) from exc

    @router.get("/episode")
    def episode(run_id: str, episode_id: str, refresh: int = 0):
        if not reader.is_valid_id(run_id) or not reader.is_valid_id(episode_id) or refresh not in (0, 1):
            raise HTTPException(400, "Valid run_id and episode_id are required; refresh must be 0 or 1")
        try:
            return json_response(service.episode(run_id, episode_id, refresh=bool(refresh)))
        except (gmo.FetchError, OSError) as exc:
            raise HTTPException(502, str(exc)[-300:]) from exc

    @router.get("/listing-status")
    def listing_status():
        try:
            return json_response(service.listing_status())
        except (gmo.FetchError, OSError) as exc:
            raise HTTPException(502, str(exc)[-300:]) from exc

    @router.post("/fetch")
    async def fetch(request: Request):
        try:
            data = await request.json()
        except ValueError as exc:
            raise HTTPException(400, "Invalid JSON body") from exc
        if not isinstance(data, dict) or not reader.is_valid_id(data.get("run_id")) or not reader.is_valid_id(data.get("episode_id")):
            raise HTTPException(400, "Valid run_id and episode_id are required")
        try:
            job_id = await run_in_threadpool(service.enqueue, data["run_id"], data["episode_id"])
        except (gmo.FetchError, OSError) as exc:
            raise HTTPException(502, str(exc)[-300:]) from exc
        return json_response({"job_id": job_id})

    @router.get("/jobs")
    def jobs():
        return json_response(service.jobs())

    @router.get("/live")
    def live_status():
        return json_response(service.live_status())

    @router.post("/live")
    async def live(request: Request):
        try:
            data = await request.json()
        except ValueError as exc:
            raise HTTPException(400, "Invalid JSON body") from exc
        if (not isinstance(data, dict) or set(data) != {"run_id", "episode_id"}
                or not reader.is_valid_id(data.get("run_id")) or not reader.is_valid_id(data.get("episode_id"))):
            raise HTTPException(400, "Valid run_id and episode_id are required")
        try:
            return json_response(await run_in_threadpool(service.follow, data["run_id"], data["episode_id"]))
        except (gmo.FetchError, OSError) as exc:
            raise HTTPException(502, str(exc)[-300:]) from exc

    return router
