"""Read-only evaluation listing and comparisons, behind the trace API's gate."""
from __future__ import annotations

import time
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from capx_trace_viewer import evals, reader
from capx_trace_viewer.trace_api import (
    client_is_local, host_is_loopback, json_response, origin_is_loopback,
)


class EvalService:
    def __init__(self, trace_root: Path, gmo_service: Any = None) -> None:
        self.trace_root = trace_root
        self.gmo_service = gmo_service

    def _remote(self) -> tuple[dict[str, list[dict[str, Any]]], str | None]:
        empty: dict[str, list[dict[str, Any]]] = {"episodes": [], "evals": []}
        if self.gmo_service is None:
            return empty, None
        from capx_trace_viewer import gmo

        try:
            if not gmo.load_settings().configured:
                return empty, None
            return self.gmo_service.remote_listing(), None
        except (gmo.FetchError, OSError):
            return empty, "GMOの一覧を取得できません。接続設定を確認してください。手元の記録を表示しています。"

    def _snapshot(self) -> tuple[dict[str, dict[str, Any]], dict[str, list[dict[str, Any]]], str | None]:
        remote, error = self._remote()
        candidates: dict[str, list[tuple[str, dict[str, Any]]]] = {}
        for location, rows in (("local", evals.read_local_evals(self.trace_root)), ("gmo", remote["evals"])):
            for row in rows:
                run_id = row.get("run_id")
                if reader.is_valid_id(run_id):
                    candidates.setdefault(run_id, []).append((location, row))
        entries = {}
        for run_id, sources in candidates.items():
            # Imports may be older than the current remote heartbeat/final record.
            # On equal mtimes prefer the local copy, just as for episode metadata.
            sources.sort(key=lambda item: (item[1].get("eval_mtime") or 0, item[0] == "local"), reverse=True)
            errors = []
            record = None
            for _location, row in sources:
                problem = row.get("eval_json_error")
                if not problem:
                    try:
                        valid = evals.validate_eval_record(row.get("eval_json"), eval_id=run_id)
                    except evals.EvalValidationError as exc:
                        problem = str(exc)
                    else:
                        if record is None:
                            record = valid
                if problem:
                    errors.append(str(problem))
            conflict = any(row.get("conflict") for location, row in sources if location == "gmo")
            if conflict:
                errors.append("同じ評価IDがGMOの複数の場所にあります。")
            locations = {location for location, _row in sources}
            entries[run_id] = {
                "eval_id": run_id, "eval": record,
                "error": " / ".join(dict.fromkeys(errors)) or None,
                "location": "both" if len(locations) > 1 else next(iter(locations)),
                "display_status": evals.display_status(record) if record is not None else None,
                "summary": record["summary"] if record else None,
                "baseline_summary": None,
                "_mtime": sources[0][1].get("eval_mtime") or 0,
                "_conflict": conflict,
            }
        return entries, remote, error

    def _episodes(self, run_id: str, remote: dict[str, list[dict[str, Any]]], *, conflict: bool = False
                  ) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        episodes = {}
        if not conflict:
            for row in remote["episodes"]:
                if row["run_id"] != run_id:
                    continue
                episode_id = row["episode_id"]
                if not reader.is_valid_id(episode_id):
                    continue
                summary = reader.episode_summary_from_metadata(
                    run_id, episode_id, row.get("episode_json"),
                    episode_json_error=row.get("episode_json_error"),
                    episode_mtime=row.get("episode_mtime"), heartbeat_mtime=row.get("heartbeat_mtime"),
                    events_mtime=row.get("events_mtime"), events_bytes=row.get("events_bytes"),
                    first_event=row.get("first_event"), now=row.get("remote_now", time.time()),
                )
                summary["local_state"] = "remote"
                episodes[episode_id] = summary
        detail = reader.run_detail(self.trace_root, run_id)
        if detail:
            for episode in detail["episodes"]:
                if episode.get("kind") == "unscoped":
                    continue
                episodes[episode["episode_id"]] = {**episode, "local_state": "local"}
        return list(episodes.values()), detail["runner_records"] if detail else []

    def _summary(self, entry: dict[str, Any], remote: dict[str, list[dict[str, Any]]]) -> Any:
        record = entry["eval"]
        if record is None:
            return None
        if record["summary"] is not None:
            return record["summary"]
        episodes, records = self._episodes(entry["eval_id"], remote, conflict=entry["_conflict"])
        return evals.aggregate_episodes(episodes, records)

    @staticmethod
    def _public(entry: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in entry.items() if not key.startswith("_")}

    def listing(self) -> dict[str, Any]:
        entries, remote, error = self._snapshot()
        for entry in entries.values():
            entry["summary"] = self._summary(entry, remote)
        for entry in entries.values():
            record = entry["eval"]
            baseline = entries.get(record["baseline_eval_id"]) if record and record["baseline_eval_id"] else None
            entry["baseline_summary"] = baseline["summary"] if baseline else None
        ordered = sorted(entries.values(), key=lambda entry: (
            datetime.fromisoformat(entry["eval"]["started_at"].replace("Z", "+00:00")).timestamp()
            if entry["eval"] else entry["_mtime"], entry["eval_id"],
        ), reverse=True)
        return {"evals": [self._public(entry) for entry in ordered], "error": error}

    def _trials(self, run_id: str, remote: dict[str, list[dict[str, Any]]], *, conflict: bool = False
                ) -> list[dict[str, Any]]:
        episodes, records = self._episodes(run_id, remote, conflict=conflict)
        trials = []
        for episode in episodes:
            trials.append({
                "episode_id": episode["episode_id"],
                "task": episode.get("task") if isinstance(episode.get("task"), str) else None,
                "condition": episode.get("condition") if isinstance(episode.get("condition"), str) else None,
                "seed": episode.get("seed") if type(episode.get("seed")) is int else None,
                "attempt": episode.get("attempt_index") if type(episode.get("attempt_index")) is int else None,
                "runner_invocation": episode.get("runner_invocation") if type(episode.get("runner_invocation")) is int else None,
                "start_wall_time": episode.get("start_wall_time") if type(episode.get("start_wall_time")) in (int, float) else None,
                "verdict": evals.trial_verdict(episode, records),
                "status": episode["status"],
                "trace_complete": episode.get("trace_complete") if type(episode.get("trace_complete")) is bool else None,
                "local_state": episode["local_state"],
            })
        return trials

    def detail(self, eval_id: str) -> dict[str, Any] | None:
        entries, remote, error = self._snapshot()
        entry = entries.get(eval_id)
        if entry is None:
            return None
        entry["summary"] = self._summary(entry, remote)
        record = entry["eval"]
        baseline_id = record["baseline_eval_id"] if record else None
        baseline = entries.get(baseline_id) if baseline_id else None
        baseline_record = baseline["eval"] if baseline else None
        baseline_error = None
        if baseline_id and baseline_record is None:
            baseline_error = "基準の評価が見つかりません。" if baseline is None else "基準の評価の記録が不正です。"
        elif baseline and baseline["error"]:
            baseline_error = baseline["error"]
        entry["baseline_summary"] = self._summary(baseline, remote) if baseline else None
        return {
            **self._public(entry), "baseline": baseline_record, "baseline_error": baseline_error,
            "trials": self._trials(eval_id, remote, conflict=entry["_conflict"]),
            "baseline_trials": self._trials(baseline_id, remote, conflict=baseline["_conflict"]) if baseline else [],
            "differences": evals.condition_differences(
                {**record, "summary": entry["summary"]},
                {**baseline_record, "summary": entry["baseline_summary"]},
            ) if record and baseline_record else [],
            "remote_error": error,
        }


def create_eval_router(trace_root: Path, *, expose: bool = False, gmo_service: Any = None,
                       unix_socket: bool = False) -> APIRouter:
    """``unix_socket``: the server listens on a ``--uds`` socket, whose requests carry no
    client address; the gate then accepts requests without one, like the trace API."""
    service = EvalService(trace_root, gmo_service)

    def gate(request: Request) -> None:
        if expose:
            return
        if (not client_is_local(request, unix_socket=unix_socket)
                or not host_is_loopback(request.headers.get("host"))):
            raise HTTPException(status_code=403, detail="the eval API answers loopback requests only")
        origin = request.headers.get("origin")
        if origin is not None and not origin_is_loopback(origin):
            raise HTTPException(status_code=403, detail="the eval API answers loopback pages only")

    router = APIRouter(prefix="/api/evals", dependencies=[Depends(gate)])

    @router.get("")
    def listing():
        return json_response(service.listing())

    @router.get("/{eval_id}")
    def detail(eval_id: str):
        if not reader.is_valid_id(eval_id):
            raise HTTPException(status_code=400, detail="invalid eval ID")
        record = service.detail(eval_id)
        if record is None:
            raise HTTPException(status_code=404, detail="eval not found")
        return json_response(record)

    return router
