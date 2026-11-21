"""Read-only evaluation listing and comparisons, behind the trace API's gate."""
from __future__ import annotations

import os
import time
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from capx_trace_recorder.evaluation_failure import evaluation_failure, preserve_evaluation_failure
from capx_trace_viewer import evals, reader, repeat_reference
from capx_trace_viewer.trace_api import (
    client_is_local, host_is_loopback, json_response, origin_is_loopback,
)


# How far a trial's recording has got; a local copy behind GMO is not shown.
_STATUS_PROGRESS = {"incomplete": 0, "running": 1, "ended_with_gaps": 2, "ended": 2}


class EvalService:
    def __init__(self, trace_root: Path, gmo_service: Any = None) -> None:
        self.trace_root = trace_root
        self.gmo_service = gmo_service

    @staticmethod
    def _remote_error() -> str:
        return "GMOの一覧を取得できません。接続設定を確認してください。手元の記録を表示しています。"

    def _merge_status(self, statuses: list[dict[str, Any]]) -> dict[str, Any] | None:
        if not statuses:
            return None
        stamps = [status["fetched_at"] for status in statuses if status["fetched_at"]]
        return {"fetched_at": min(stamps) if stamps else None,
                "refreshing": any(status["refreshing"] for status in statuses),
                "error": self._remote_error() if any(status["error"] for status in statuses) else None}

    def _status(self, run_ids: tuple[str, ...] = ()) -> dict[str, Any] | None:
        if self.gmo_service is None or not hasattr(self.gmo_service, "listing_status"):
            return None
        statuses = [self.gmo_service.listing_status("evals")]
        statuses.extend(self.gmo_service.listing_status("run", (run_id,)) for run_id in run_ids)
        return self._merge_status(statuses)

    def _remote(self, *, refresh: bool = False) -> tuple[dict[str, list[dict[str, Any]]], str | None, dict[str, Any] | None]:
        empty: dict[str, list[dict[str, Any]]] = {"episodes": [], "evals": []}
        if self.gmo_service is None:
            return empty, None, None
        from capx_trace_viewer import gmo

        try:
            settings = (self.gmo_service.load_settings() if hasattr(self.gmo_service, "load_settings")
                        else gmo.load_settings())
            if not settings.configured:
                return empty, None, None
            if hasattr(self.gmo_service, "remote_eval_snapshot"):
                listing, status = self.gmo_service.remote_eval_snapshot(refresh=refresh)
                status = self._merge_status([status])
            elif hasattr(self.gmo_service, "remote_eval_listing"):
                listing = self.gmo_service.remote_eval_listing(refresh=refresh)
                status = self._status()
            else:
                listing = self.gmo_service.remote_listing()
                status = self._status()
            remote = {"evals": list(listing["evals"]), "episodes": list(listing["episodes"]),
                      "_statuses": [status] if status else []}
            return remote, status["error"] if status else None, status
        except (gmo.FetchError, OSError):
            return empty, self._remote_error(), None

    def _snapshot(self, *, refresh: bool = False):
        remote, error, status = self._remote(refresh=refresh)
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
                # The remote scanner applies the same owner-folder / mine-pattern
                # rule as trial listing. An imported team copy stays a team eval.
                "mine": (any(row.get("mine") is True for location, row in sources if location == "gmo")
                         if "gmo" in locations else True),
                "display_status": evals.display_status(record) if record is not None else None,
                "evaluation_failure": evaluation_failure(record),
                "summary": record["summary"] if record else None,
                "baseline_summary": None,
                "_mtime": sources[0][1].get("eval_mtime") or 0,
                "_conflict": conflict,
            }
        return entries, remote, error, status

    def _load_episodes(self, remote: dict[str, Any], run_ids: tuple[str, ...], *, refresh: bool = False) -> None:
        """Only the comparisons being opened need remote episode metadata."""
        if self.gmo_service is None or not hasattr(self.gmo_service, "eval_episode_listing"):
            return
        from capx_trace_viewer import gmo
        for run_id in dict.fromkeys(run_ids):
            requested = remote.setdefault("_requested_runs", set())
            if run_id in requested:
                continue
            requested.add(run_id)
            try:
                if hasattr(self.gmo_service, "eval_episode_snapshot"):
                    listing, status = self.gmo_service.eval_episode_snapshot(run_id, refresh=refresh)
                    remote.setdefault("_statuses", []).append(status)
                else:
                    listing = self.gmo_service.eval_episode_listing(run_id, refresh=refresh)
            except (gmo.FetchError, OSError):
                remote.setdefault("_statuses", []).append(
                    {"fetched_at": None, "refreshing": False, "error": self._remote_error()})
                continue
            remote["episodes"].extend(listing["episodes"])

    def _episodes(self, run_id: str, remote: dict[str, list[dict[str, Any]]], *, conflict: bool = False
                  ) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
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
                remote_episode = episodes.get(episode["episode_id"])
                # A copy fetched while the trial was still running stops there and
                # later reads as interrupted; GMO's newer state wins until it is refetched.
                if remote_episode:
                    remote_progress = _STATUS_PROGRESS.get(remote_episode.get("status"), 0)
                    local_progress = _STATUS_PROGRESS.get(episode.get("status"), 0)
                    remote_mtime = remote_episode.get("episode_mtime")
                    local_mtime = episode.get("episode_mtime")
                    if (remote_progress > local_progress or
                            (type(remote_mtime) in (int, float) and type(local_mtime) in (int, float)
                             and remote_mtime > local_mtime and not remote_episode.get("episode_json_error"))):
                        continue
                episodes[episode["episode_id"]] = {**episode, "local_state": "local"}
        return (list(episodes.values()), detail["runner_records"] if detail else [],
                detail.get("runner_records_info", {}) if detail else {})

    def _classification(self, episode: dict[str, Any], records: list[dict[str, Any]],
                        evaluation: dict[str, Any] | None = None) -> dict[str, Any]:
        if episode["local_state"] == "local":
            try:
                directory = reader.Dir.open_below(self.trace_root, [episode["run_id"], episode["episode_id"]])
            except OSError:
                pass
            else:
                with directory:
                    return reader.trial_end_classification_at(directory, episode, records, evaluation=evaluation)
        return reader.trial_end_classification_at(None, episode, records, evaluation=evaluation)

    def _summary(self, entry: dict[str, Any], remote: dict[str, list[dict[str, Any]]]) -> Any:
        record = entry["eval"]
        if record is None:
            return None
        episodes, records, records_info = self._episodes(entry["eval_id"], remote, conflict=entry["_conflict"])
        local = [episode for episode in episodes if episode["local_state"] == "local"]
        saved = record["summary"]
        saved_logical = saved is not None and "attempts" in saved
        population = evals.latest_logical_episodes(episodes) if saved_logical else episodes
        complete = (saved is None or (
            len(episodes) >= saved.get("attempts", saved["trials"])
            and len(population) >= saved["trials"]
            and set(saved["tasks"]).issubset(episode.get("task") for episode in episodes
                                            if isinstance(episode.get("task"), str))
            and set(saved["seeds"]).issubset(episode.get("seed") for episode in episodes
                                            if type(episode.get("seed")) is int)
            and all(sum(episode.get("task") == task for episode in episodes) >= counts.get("attempts", counts["trials"])
                    and sum(episode.get("task") == task for episode in population) >= counts["trials"]
                    for task, counts in saved["by_task"].items())))
        intact = not any(records_info.get(key) for key in ("error", "corrupt_lines", "torn_tail", "truncated"))
        runner_complete = (saved is None or
                           sum(evals._verdict_and_source(episode, records)[1] == "runner_record" for episode in population)
                           >= saved["verdict_sources"].get("runner_record", 0))
        # Older records count retries as trials. Rebuild from the same episodes
        # shown in the table only when the saved population and evidence are available.
        if local and complete and intact and runner_complete and all(not episode.get("episode_json_error") for episode in episodes):
            summary = evals.aggregate_episodes(episodes, records, logical=True,
                                             classify=lambda episode: self._classification(episode, records, record))
            return preserve_evaluation_failure(summary, record)
        if saved is not None:
            return saved
        return evals.aggregate_episodes(episodes, records, logical=bool(record.get("segments")),
                                        classify=lambda episode: self._classification(episode, records, record))

    @staticmethod
    def _public(entry: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in entry.items() if not key.startswith("_")}

    def listing(self, *, refresh: bool = False) -> dict[str, Any]:
        entries, remote, error, status = self._snapshot(refresh=refresh)
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
        return {"evals": [self._public(entry) for entry in ordered], "error": error,
                "remote_status": status}

    def _trials(self, run_id: str, remote: dict[str, list[dict[str, Any]]], *, conflict: bool = False,
                evaluation: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        episodes, records, _records_info = self._episodes(run_id, remote, conflict=conflict)
        trials = []
        for episode in episodes:
            classification = self._classification(episode, records, evaluation)
            trials.append({
                "episode_id": episode["episode_id"],
                "task": episode.get("task") if isinstance(episode.get("task"), str) else None,
                "condition": episode.get("condition") if isinstance(episode.get("condition"), str) else None,
                "seed": episode.get("seed") if type(episode.get("seed")) is int else None,
                "attempt": episode.get("attempt_index") if type(episode.get("attempt_index")) is int else None,
                "runner_invocation": episode.get("runner_invocation") if type(episode.get("runner_invocation")) is int else None,
                "start_wall_time": episode.get("start_wall_time") if type(episode.get("start_wall_time")) in (int, float) else None,
                "verdict": classification["verdict"],
                "end_classification": classification,
                "status": episode["status"],
                "trace_complete": episode.get("trace_complete") if type(episode.get("trace_complete")) is bool else None,
                "local_state": episode["local_state"],
                **({"eval_segment": episode["eval_segment"]} if type(episode.get("eval_segment")) is int else {}),
            })
        return trials

    def _repeat_references(self, entries: dict[str, dict[str, Any]], remote: dict[str, Any],
                           current: dict[str, Any], baseline: dict[str, Any] | None) -> list[dict[str, Any]]:
        references = []
        seen_pairs: set[frozenset[str]] = set()
        candidates = sorted(entries.values(), key=lambda item: (
            datetime.fromisoformat(item["eval"]["started_at"].replace("Z", "+00:00")).timestamp()
            if item["eval"] else item["_mtime"], item["eval_id"]), reverse=True)
        for side, entry in (("current", current), ("baseline", baseline)):
            if not entry or entry["error"] or entry["_conflict"]:
                continue
            key = repeat_reference.record_key(entry["eval"])
            if key is None:
                continue
            matching = [candidate for candidate in candidates if candidate["eval_id"] != entry["eval_id"]
                        and frozenset((candidate["eval_id"], entry["eval_id"])) not in seen_pairs
                        and not candidate["error"] and not candidate["_conflict"]
                        and repeat_reference.record_key(candidate["eval"]) == key]
            if not matching:
                continue
            episodes, _records, _info = self._episodes(entry["eval_id"], remote)
            settings = repeat_reference.episode_settings(episodes)
            if settings is None or len(episodes) != entry["eval"]["summary"]["trials"]:
                continue
            for candidate in matching:
                self._load_episodes(remote, (candidate["eval_id"],))
                other, _records, _info = self._episodes(candidate["eval_id"], remote)
                if len(other) != candidate["eval"]["summary"]["trials"] or repeat_reference.episode_settings(other) != settings:
                    continue
                seen_pairs.add(frozenset((candidate["eval_id"], entry["eval_id"])))
                references.append({"side": side, "eval": candidate["eval"],
                                   "trials": self._trials(candidate["eval_id"], remote, evaluation=candidate["eval"])})
                break
        return references

    def detail(self, eval_id: str, *, refresh: bool = False) -> dict[str, Any] | None:
        entries, remote, error, status = self._snapshot(refresh=refresh)
        entry = entries.get(eval_id)
        if entry is None:
            if status and status["refreshing"]:
                return {"eval_id": eval_id, "eval": None, "error": None, "location": "gmo",
                        "display_status": None, "summary": None, "baseline_summary": None,
                        "baseline": None, "baseline_error": None, "trials": [], "baseline_trials": [],
                        "differences": [], "repeat_references": [], "remote_error": error,
                        "remote_status": status, "loading_remote": True}
            return None
        record = entry["eval"]
        baseline_id = record["baseline_eval_id"] if record else None
        baseline = entries.get(baseline_id) if baseline_id else None
        run_ids = tuple(row["eval_id"] for row in (entry, baseline) if row and not row["_conflict"])
        self._load_episodes(remote, run_ids, refresh=refresh)
        entry["summary"] = self._summary(entry, remote)
        baseline_record = baseline["eval"] if baseline else None
        baseline_error = None
        if baseline_id and baseline_record is None:
            baseline_error = "基準の評価が見つかりません。" if baseline is None else "基準の評価の記録が不正です。"
        elif baseline and baseline["error"]:
            baseline_error = baseline["error"]
        entry["baseline_summary"] = self._summary(baseline, remote) if baseline else None
        references = self._repeat_references(entries, remote, entry, baseline)
        status = self._merge_status(remote.get("_statuses", []))
        return {
            **self._public(entry), "baseline": baseline_record, "baseline_error": baseline_error,
            "baseline_evaluation_failure": evaluation_failure(baseline_record),
            "trials": self._trials(eval_id, remote, conflict=entry["_conflict"], evaluation=record),
            "baseline_trials": self._trials(baseline_id, remote, conflict=baseline["_conflict"], evaluation=baseline_record) if baseline else [],
            "differences": evals.condition_differences(
                {**record, "summary": entry["summary"]},
                {**baseline_record, "summary": entry["baseline_summary"]},
            ) if record and baseline_record else [],
            "remote_error": (status["error"] if status else None) or error,
            "remote_status": status,
            "repeat_references": references,
        }

    def code_changes(self, eval_id: str) -> dict[str, Any] | None:
        entries, _remote, _error, _status = self._snapshot()
        entry = entries.get(eval_id)
        if entry is None:
            return None
        metadata = (entry["eval"] or {}).get("code_changes")
        result = {"metadata": metadata, "artifact": None, "error": None, "location": None}
        if metadata is None or metadata["status"] != "recorded":
            return result
        try:
            with reader.Dir.open_below(self.trace_root, [eval_id]) as directory:
                fd, info = directory.open_file(evals.CODE_CHANGES_FILE)
                try:
                    if info.st_size > evals.MAX_CODE_CHANGES_BYTES:
                        raise ValueError("size")
                    data = os.pread(fd, evals.MAX_CODE_CHANGES_BYTES + 1, 0)
                finally:
                    os.close(fd)
            result.update(artifact=evals.decode_code_changes(data, metadata), location="local")
            return result
        except (OSError, ValueError):
            pass
        if entry["location"] in ("gmo", "both") and not entry["_conflict"] and self.gmo_service is not None:
            from capx_trace_viewer import gmo
            try:
                data = self.gmo_service.read_code_changes(eval_id)
                result.update(artifact=evals.decode_code_changes(data, metadata), location="gmo")
                return result
            except (gmo.FetchError, OSError, ValueError):
                pass
        result["error"] = "差分ファイルを安全に読み取れません。未取得・欠損・更新による不一致の可能性があります。"
        return result


def create_eval_router(trace_root: Path, *, expose: bool = False, gmo_service: Any = None,
                       unix_socket: bool = False, prefix: str = "/api/evals") -> APIRouter:
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

    router = APIRouter(prefix=prefix, dependencies=[Depends(gate)])

    @router.get("")
    def listing(refresh: int = 0):
        if refresh not in (0, 1):
            raise HTTPException(status_code=400, detail="refresh must be 0 or 1")
        return json_response(service.listing(refresh=bool(refresh)))

    @router.get("/{eval_id}")
    def detail(eval_id: str, refresh: int = 0):
        if not reader.is_valid_id(eval_id):
            raise HTTPException(status_code=400, detail="invalid eval ID")
        if refresh not in (0, 1):
            raise HTTPException(status_code=400, detail="refresh must be 0 or 1")
        record = service.detail(eval_id, refresh=bool(refresh))
        if record is None:
            raise HTTPException(status_code=404, detail="eval not found")
        return json_response(record, status_code=202 if record.get("loading_remote") else 200)

    @router.get("/{eval_id}/code-changes")
    def code_changes(eval_id: str):
        if not reader.is_valid_id(eval_id):
            raise HTTPException(status_code=400, detail="invalid eval ID")
        value = service.code_changes(eval_id)
        if value is None:
            raise HTTPException(status_code=404, detail="eval not found")
        return json_response(value)

    return router
