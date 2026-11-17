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


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


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
        self._queue: queue.Queue[tuple[dict[str, Any], gmo.GmoSettings, dict[str, Any]] | None] = queue.Queue()
        self._worker: threading.Thread | None = None

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
            if key in self._pending:
                raise HTTPException(409, "This episode is already queued or running")
        rows, settings, generation = self._remote_snapshot()
        matches = [row for row in rows if (row["run_id"], row["episode_id"]) == key]
        if not matches:
            raise HTTPException(404, "Episode not found on GMO")
        if any(row["conflict"] for row in matches):
            raise HTTPException(409, "Run ID exists in more than one GMO location")
        with self._lock:
            if generation != self._generation or settings != gmo.load_settings():
                raise gmo.FetchError("GMO settings changed during listing; please retry")
            if key in self._pending:
                raise HTTPException(409, "This episode is already queued or running")
            job = {
                "job_id": uuid.uuid4().hex, "run_id": run_id, "episode_id": episode_id,
                "state": "queued", "bytes": 0, "error": None, "note": None,
                "started_at": None, "finished_at": None,
            }
            self._jobs.append(job)
            self._jobs = self._jobs[-50:]
            self._pending.add(key)
            if self._worker is None:
                self._worker = threading.Thread(target=self._work, name="capx-gmo-fetch", daemon=True)
                self._worker.start()
            self._queue.put((job, settings, matches[0]))
            return job["job_id"]

    def jobs(self) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(job) for job in reversed(self._jobs)]

    def _work(self) -> None:
        while True:
            item = self._queue.get()
            if item is None:
                return
            job, settings, row = item
            key = (job["run_id"], job["episode_id"])
            with self._lock:
                job["state"] = "running"
                job["started_at"] = _timestamp()
            try:
                notes: list[str] = []
                size = gmo.fetch_episode(self.runner, settings, row, self.dest,
                                         max_bytes=self.max_fetch_bytes, notes=notes)
            except Exception as exc:
                with self._lock:
                    job["state"] = "failed"
                    job["error"] = str(exc)[-300:]
            else:
                with self._lock:
                    job["state"] = "done"
                    job["bytes"] = size
                    job["note"] = "; ".join(notes) or None
            finally:
                with self._lock:
                    job["finished_at"] = _timestamp()
                    self._pending.discard(key)
                self._queue.task_done()

    def close(self) -> None:
        self.runner.close()
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
