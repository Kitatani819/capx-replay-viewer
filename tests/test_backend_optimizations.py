"""Behavioral parity for response indexes, decoded scans and bounded discovery."""
from __future__ import annotations

import json
import math
import threading
from pathlib import Path

import pytest

from capx_trace_viewer import evals, gmo, reader
from capx_trace_viewer.eval_api import EvalService
from capx_trace_viewer.remote_cache import RemoteListingCache
from test_eval_api import episode, record, write_record
from test_gmo_listing_fast import LocalRunner


CASES = json.loads((Path(__file__).parent / "fixtures" / "eval_verdicts.json").read_text())


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_indexed_runner_records_preserve_shared_verdict_contract(case):
    records = evals.index_runner_records(case["runner_records"])
    assert evals.trial_verdict(case["episode"], records) == case["expected"]
    assert evals._runner_attempt(case["episode"], records) == evals._runner_attempt(
        case["episode"], case["runner_records"])


def test_runner_index_preserves_types_missing_keys_ambiguity_and_input_order():
    shared = {"identity": "shared"}
    records = [
        {"task": task, "condition": condition, "seed": seed, "trial": seed,
         "attempts": [{"attempt_id": 1, "task_success": True}]}
        for task, condition, seed in [
            ("task", None, 1), ("task", None, True), ("task", None, "1"),
            ("task", None, None), ("task", None, math.nan),
            ("task", shared, 1), ("task", {"identity": "shared"}, 1),
        ]
    ]
    records.extend([{"task": "task", "seed": 1}, {"task": "task", "condition": None}])
    records.append(records[0])  # Identical repeated rows must remain ambiguous.
    index = evals.index_runner_records(records)
    for task in ("task", None):
        for condition in (None, shared, {"identity": "shared"}):
            for seed in (1, 1.0, True, "1", None, math.nan):
                value = {"task": task, "condition": condition, "seed": seed, "attempt_index": 1}
                plain = evals._runner_attempt(value, records)
                indexed = evals._runner_attempt(value, index)
                assert indexed[0] is plain[0] and indexed[1] is plain[1]
                assert indexed[2] == plain[2]


def test_eval_response_reuses_run_snapshot_and_refreshes_next_response(tmp_path, monkeypatch):
    run = write_record(tmp_path, record("ev-snapshot-cache"))
    metadata = episode(run, success=True)
    calls = []
    original = reader.run_detail

    def read(*args, **kwargs):
        calls.append(args[1])
        return original(*args, **kwargs)

    monkeypatch.setattr(reader, "run_detail", read)
    service = EvalService(tmp_path)
    assert service.detail(run.name)["trials"][0]["verdict"] == "success"
    assert calls == [run.name]
    metadata["harness_summary"]["task_completed"] = False
    (run / "trial" / "episode.json").write_text(json.dumps(metadata))
    assert service.detail(run.name)["trials"][0]["verdict"] == "failure"
    assert calls == [run.name, run.name]


@pytest.mark.parametrize("max_bytes", [1, 100, 1000])
def test_decoded_pages_match_byte_pages_without_retaining_raw_lines(tmp_path, max_bytes):
    path = tmp_path / "events.jsonl"
    path.write_bytes(b'{"seq":1,"text":"\\u65e5","value":NaN}\n'
                     b'not-json\n[1,2]\n'
                     b'{"seq":2,"value":1e400,"nested":[-Infinity]}\n'
                     b'{"seq":3,"text":"' + b'x' * 200 + b'"}\n'
                     b'{"torn":')
    offset = 0
    while True:
        raw = reader.read_events_page(path, offset, max_bytes=max_bytes, max_events=2)
        decoded = reader.read_events_page(path, offset, max_bytes=max_bytes, max_events=2, decode=True)
        assert decoded.event_lines == ()
        assert decoded.events() == raw.events()
        assert json.loads(decoded.to_json_bytes()) == json.loads(raw.to_json_bytes())
        if raw.eof or raw.next_offset == offset:
            break
        offset = raw.next_offset


def test_remote_cache_evicts_least_recent_idle_entry_and_reloads_persisted_data(tmp_path):
    cache = RemoteListingCache(tmp_path / "cache", max_entries=2)
    calls = []

    def fetch(key):
        def run(previous):
            calls.append(key)
            return {"episodes": [{"episode_id": key}], "evals": []}
        return run

    try:
        for key in ("one", "two"):
            cache.snapshot(key, fetch(key), wait=True)
        cache.status("one")
        cache.snapshot("three", fetch("three"), wait=True)
        assert list(cache._entries) == ["one", "three"]
        assert cache.snapshot("two", fetch("two"))["episodes"][0]["episode_id"] == "two"
        assert calls == ["one", "two", "three"]
        assert len(cache._entries) == 2
    finally:
        cache.close()


def test_remote_cache_keeps_active_refresh_identity_during_lru_pressure(tmp_path):
    cache = RemoteListingCache(tmp_path / "cache", max_entries=1)
    entered, release = threading.Event(), threading.Event()
    calls = []

    def slow(previous):
        calls.append("slow")
        entered.set()
        assert release.wait(3)
        return {"episodes": [{"episode_id": "slow"}], "evals": []}

    try:
        cache.snapshot("slow", slow)
        assert entered.wait(1)
        cache.snapshot("fast", lambda previous: {"episodes": [], "evals": []}, wait=True, interactive=True)
        assert cache.status("slow")["refreshing"] is True
        cache.snapshot("slow", slow)
        assert calls == ["slow"]
        release.set()
        assert cache.snapshot("slow", slow, wait=True)["episodes"][0]["episode_id"] == "slow"
        assert len(cache._entries) <= 1
    finally:
        release.set()
        cache.close()


def test_scoped_remote_listing_skips_run_enumeration_but_keeps_cross_root_conflicts(tmp_path):
    roots = [tmp_path / "mine", tmp_path / "team"]
    for root in roots:
        episode_dir = root / "wanted" / "trial"
        episode_dir.mkdir(parents=True)
        (episode_dir / "episode.json").write_text('{"status":"ended"}')
        (root / "unrelated").mkdir()
    preamble = f"""
import os
original_listdir = os.listdir
def listdir(path):
    if path in {list(map(str, roots))!r}:
        raise AssertionError('scoped lookup enumerated all runs')
    return original_listdir(path)
os.listdir = listdir
"""
    settings = gmo.GmoSettings(host="test", mine=(str(roots[0]),), team=(str(roots[1]),), shared_root="")
    result = gmo.list_remote_episodes(LocalRunner(preamble), settings, run_ids=("wanted",), metadata_only=True)
    assert len(result["episodes"]) == 2
    assert all(row["run_id"] == "wanted" and row["conflict"] is True for row in result["episodes"])


def test_awaited_snapshot_keeps_exact_status_after_eviction_and_persistence_failure(tmp_path, monkeypatch):
    cache = RemoteListingCache(tmp_path / "cache", max_entries=1)
    entered, release, finish_other = threading.Event(), threading.Event(), threading.Event()
    result = []

    def unavailable(*args):
        raise OSError("storage unavailable")

    monkeypatch.setattr(cache, "_save", unavailable)

    def slow(previous):
        entered.set()
        assert release.wait(3)
        return {"episodes": [{"episode_id": "ready"}], "evals": []}

    def other(previous):
        assert finish_other.wait(3)
        return {"episodes": [], "evals": []}

    waiter = threading.Thread(target=lambda: result.append(cache.snapshot_with_status("awaited", slow, wait=True)))
    try:
        waiter.start()
        assert entered.wait(1)
        cache.snapshot("other", other)
        release.set()
        waiter.join(timeout=1)
        assert not waiter.is_alive()
        rows, status = result[0]
        assert rows["episodes"] == [{"episode_id": "ready"}]
        assert status["fetched_at"] is not None
        assert status["refreshing"] is False
        assert "storage unavailable" in status["error"]
    finally:
        release.set()
        finish_other.set()
        waiter.join(timeout=1)
        cache.close()
