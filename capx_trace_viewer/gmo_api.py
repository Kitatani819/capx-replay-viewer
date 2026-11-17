"""Loopback-only GMO configuration, discovery and queued import API."""
from __future__ import annotations

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
from capx_trace_viewer.trace_api import (
    client_is_loopback, host_is_loopback, json_response, origin_is_loopback,
)

CACHE_SECONDS = 30


def _timestamp(value: float | None = None) -> str:
    return datetime.fromtimestamp(time.time() if value is None else value, timezone.utc).isoformat()


class GmoService:
    def __init__(self, dest: Path) -> None:
        self.dest = dest
        self.runner = gmo.ProcessRunner()
        self.max_fetch_bytes = gmo.MAX_FETCH_BYTES
        self._lock = threading.Lock()
        self._refresh_lock = threading.Lock()
        self._cache: list[dict[str, Any]] | None = None
        self._cache_settings: gmo.GmoSettings | None = None
        self._cache_until = 0.0
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

    def invalidate(self) -> None:
        with self._lock:
            self._invalidate_locked()

    def _invalidate_locked(self) -> None:
        self._generation += 1
        self._cache = None
        self._cache_settings = None
        self._cache_until = 0

    def update_settings(self, settings: gmo.GmoSettings) -> None:
        # Publication of settings and invalidation must be atomic with respect to
        # both a completing listing and enqueue's final snapshot check.
        with self._lock:
            gmo.save_settings(settings)
            self._invalidate_locked()
            self._sync_auto_settings_locked(settings)
        self._auto_wake.set()

    @staticmethod
    def _auto_enabled(settings: gmo.GmoSettings) -> bool:
        return bool(settings.host and settings.mine and settings.interval_s > 0)

    def _schedule_auto_locked(self, settings: gmo.GmoSettings) -> None:
        if self._closed or self._auto_paused or not self._auto_enabled(settings):
            self._auto_next = self._auto_next_at = None
            return
        delay = settings.interval_s if not self._auto_failures else min(
            1800, settings.interval_s * 2 ** min(self._auto_failures, 30))
        self._auto_next = time.monotonic() + delay
        self._auto_next_at = _timestamp(time.time() + delay)

    def _sync_auto_settings_locked(self, settings: gmo.GmoSettings) -> None:
        if settings != self._auto_settings:
            self._auto_settings = settings
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
            settings = gmo.load_settings()
            self._sync_auto_settings_locked(settings)
            return self._auto_status_locked(settings)

    def set_auto_paused(self, paused: bool) -> dict[str, Any]:
        with self._lock:
            settings = gmo.load_settings()
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
                    settings = gmo.load_settings()
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
            settings = gmo.load_settings()
            self._sync_auto_settings_locked(settings)
            if self._closed or self._auto_paused or self._auto_running or not self._auto_enabled(settings):
                return self._auto_status_locked(settings)
            self._auto_running = True
            self._auto_run_id += 1
            batch = {"run_id": self._auto_run_id, "generation": self._generation,
                     "failed": False, "remaining": 0}
            generation = self._generation
            self._auto_last_run_at = _timestamp()
            self._auto_next = self._auto_next_at = None
            self._auto_queued = 0
            self._auto_skipped = []
        try:
            with self._refresh_lock:
                rows = gmo.list_remote_episodes(self.runner, settings, include_files=True, mine_only=True)
                plans = []
                for row in sorted(rows, key=lambda r: (r["max_mtime"] or 0, r["run_id"], r["episode_id"]),
                                  reverse=True):
                    if not row["mine"] or row["conflict"]:
                        continue
                    run = gmo.episode_manifest(row, row)
                    files = gmo._episode_changes(run, row["episode_id"], self.dest)
                    if files:
                        plans.append((row, run, files))
                with self._lock:
                    if self._closed or self._auto_paused:
                        raise gmo.FetchError("GMO automatic import was stopped")
                    if generation != self._generation or settings != gmo.load_settings():
                        raise gmo.FetchError("GMO settings changed during listing; please retry")
                    # A mine-only scan must not pretend to be a complete team listing.
                    self._cache = None
                    self._cache_settings = None
                    self._cache_until = 0
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

    def remote_rows(self, *, refresh: bool = False) -> list[dict[str, Any]]:
        return self._remote_snapshot(refresh=refresh)[0]

    def _remote_snapshot(self, *, refresh: bool = False) -> tuple[list[dict[str, Any]], gmo.GmoSettings, int]:
        with self._refresh_lock:
            with self._lock:
                settings = gmo.load_settings()
                generation = self._generation
                if (not refresh and self._cache is not None and self._cache_settings == settings
                        and time.monotonic() < self._cache_until):
                    return self._cache, settings, generation
            rows = gmo.list_remote_episodes(self.runner, settings)
            with self._lock:
                if generation != self._generation or settings != gmo.load_settings():
                    raise gmo.FetchError("GMO settings changed during listing; please retry")
                self._cache = rows
                self._cache_settings = settings
                self._cache_until = time.monotonic() + CACHE_SECONDS
            return rows, settings, generation

    def episodes(self, scope: str, *, refresh: bool = False) -> list[dict[str, Any]]:
        rows = self.remote_rows(refresh=refresh)
        with self._lock:
            pending = set(self._pending)
        result = []
        for row in rows:
            if scope != "all" and row["mine"] != (scope == "mine"):
                continue
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
                "local_state": "fetching" if (row["run_id"], row["episode_id"]) in pending
                else gmo.local_state(row, self.dest),
                "conflict": row["conflict"],
            })
            result.append(summary)
        return result

    def enqueue(self, run_id: str, episode_id: str) -> str:
        key = (run_id, episode_id)
        with self._lock:
            if self._closed:
                raise gmo.FetchError("GMO service is shutting down")
            if key in self._pending:
                raise HTTPException(409, "This episode is already queued or running")
        rows, settings, generation = self._remote_snapshot()
        matches = [row for row in rows if (row["run_id"], row["episode_id"]) == key]
        if not matches:
            raise HTTPException(404, "Episode not found on GMO")
        if any(row["conflict"] for row in matches):
            raise HTTPException(409, "Run ID exists in more than one GMO location")
        with self._lock:
            if self._closed:
                raise gmo.FetchError("GMO service is shutting down")
            if generation != self._generation or settings != gmo.load_settings():
                raise gmo.FetchError("GMO settings changed during listing; please retry")
            if key in self._pending:
                raise HTTPException(409, "This episode is already queued or running")
            return self._enqueue_locked(matches[0], settings)

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
        self._auto_wake.set()
        self.runner.close()
        if self._auto_thread is not None:
            self._auto_thread.join(timeout=5)
        if self._worker is not None:
            self._queue.put(None)
            self._worker.join(timeout=5)


def create_gmo_router(service: GmoService) -> APIRouter:
    def gate(request: Request) -> None:
        if not client_is_loopback(request) or not host_is_loopback(request.headers.get("host")):
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

    router = APIRouter(prefix="/api/gmo", dependencies=[Depends(gate)])

    @router.get("/config")
    def get_config():
        try:
            settings = gmo.load_settings()
        except gmo.FetchError as exc:
            raise HTTPException(500, str(exc)) from exc
        return json_response({
            "enabled": True, "configured": settings.configured,
            "settings": settings.as_dict(), "dest": str(service.dest),
            "config_path": str(gmo.config_path()),
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
            "config_path": str(gmo.config_path()),
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
            return json_response(service.episodes(scope, refresh=bool(refresh)))
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

    return router
