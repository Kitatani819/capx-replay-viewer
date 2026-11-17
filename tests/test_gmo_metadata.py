"""GMO metadata parity without network sockets or a real SSH transport."""
from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

from capx_trace_viewer import gmo, reader
from capx_trace_viewer.gmo_api import GmoService


class LocalPythonRunner:
    """Execute only the remote Python payload on this machine for these tests."""

    def __init__(self, *, now: float | None = None):
        self.now = now

    def run(self, command: list[str], *, timeout: float):
        argv = shlex.split(command[-1])
        assert argv[:2] == ["python3", "-c"]
        argv[0] = sys.executable
        if self.now is not None:
            argv[2] = f"import time; time.time = lambda: {self.now!r}\n" + argv[2]
        return subprocess.run(argv, capture_output=True, text=True, timeout=timeout)

    def close(self):
        pass


@pytest.fixture
def metadata_source(tmp_path, monkeypatch):
    root = tmp_path / "remote"
    episode = root / "run_a" / "ep_1"
    episode.mkdir(parents=True)
    (episode.parent / "run.json").write_text("{}\n")
    (episode / "heartbeat").touch()
    settings = gmo.GmoSettings(host="alias", mine=(str(root),))
    monkeypatch.setattr(gmo, "load_settings", lambda: settings)
    service = GmoService(tmp_path / "dest")
    service.runner = LocalPythonRunner()
    try:
        yield episode, service, settings
    finally:
        service.close()


def _start_event():
    return {
        "event_type": "episode_start", "seq": 1, "run_id": "run_a", "episode_id": "ep_1",
        "wall_time": 123.0, "pid": 42,
        "data": {
            "source": "runner", "task": "from_event", "seed": 17, "condition": "condition_a",
            "condition_label": "Condition A", "attempt_index": 3, "runner_invocation": "inv_1",
            "host": "gmo_node", "env": {"viser_port": 8081},
            "tracer": {"hooks_failed": [
                {"hook": "H4", "target": "module.fn", "reason": "unavailable", "extra": "ignored"}
            ]},
        },
    }


@pytest.mark.parametrize("metadata", [
    None,
    {"task": "from_metadata"},
    {"status": "ended_with_gaps", "trace_complete": False,
     "gaps": [{"code": "hook_install_failed"}]},
])
def test_remote_summary_values_match_reader_with_first_event(metadata_source, metadata):
    episode, service, _settings = metadata_source
    event = _start_event()
    (episode / "events.jsonl").write_text(json.dumps(event) + "\n")
    if metadata is not None:
        (episode / "episode.json").write_text(json.dumps(metadata))
    row, = service.remote_rows()
    assert row["first_event"] == event
    remote, = service.episodes("all")
    expected = reader.episode_summary("run_a", episode, now=row["remote_now"])
    assert {key: value for key, value in remote.items()
            if key not in {"owner", "mine", "size_bytes", "local_state", "conflict"}} == expected
    assert remote["task"] == (metadata or {}).get("task", "from_event")
    assert remote["seed"] == 17
    assert remote["pid"] == 42
    assert remote["viser_port"] == 8081
    assert remote["start_wall_time"] == 123.0
    if metadata and metadata.get("status") == "ended_with_gaps":
        assert remote["startup_hook_failures"] == {
            "seq": 1, "failures": [{"hook": "H4", "target": "module.fn", "reason": "unavailable"}]
        }


@pytest.mark.parametrize("needs_hook_evidence", [False, True])
def test_remote_complete_start_metadata_matches_reader_explicit_nulls(metadata_source, needs_hook_evidence):
    episode, service, _settings = metadata_source
    metadata = {key: None for key in reader._FIRST_EVENT_FIELDS}
    if needs_hook_evidence:
        metadata.update(status="ended_with_gaps", gaps=[{"code": "hook_install_failed"}])
    (episode / "episode.json").write_text(json.dumps(metadata))
    (episode / "events.jsonl").write_text(json.dumps(_start_event()) + "\n")
    row, = service.remote_rows()
    remote, = service.episodes("all")
    expected = reader.episode_summary("run_a", episode, now=row["remote_now"])
    assert {key: value for key, value in remote.items()
            if key not in {"owner", "mine", "size_bytes", "local_state", "conflict"}} == expected
    assert remote["task"] == ("from_event" if needs_hook_evidence else None)
    assert ("startup_hook_failures" in remote) is needs_hook_evidence


@pytest.mark.parametrize("clock_offset", [-600, 600])
def test_remote_clock_controls_heartbeat_age(metadata_source, monkeypatch, clock_offset):
    episode, service, _settings = metadata_source
    remote_now = time.time()
    service.runner = LocalPythonRunner(now=remote_now)
    (episode / "episode.json").write_text('{"status":"started"}')
    os.utime(episode / "heartbeat", (remote_now - 2, remote_now - 2))
    monkeypatch.setattr(time, "time", lambda: remote_now + clock_offset)
    remote, = service.episodes("all")
    assert remote["status"] == "running"
    assert remote["heartbeat_age_s"] == 2.0


def test_local_state_detects_renamed_file_with_identical_aggregate_stats(metadata_source):
    episode, service, _settings = metadata_source
    (episode / "events.jsonl").write_text(json.dumps(_start_event()) + "\n")
    nested = episode / "nested"
    nested.mkdir()
    (nested / "unicode_名前.txt").write_text("content")
    row, = service.remote_rows()
    assert "files" not in row
    local = service.dest / "run_a" / "ep_1"
    shutil.copytree(episode, local)
    assert gmo.local_state(row, service.dest) == "local"
    before = gmo.local_episode_stats(local)
    (local / "events.jsonl").rename(local / "renamed.jsonl")
    after = gmo.local_episode_stats(local)
    assert before[:3] == after[:3]
    assert before[3] != after[3]
    assert gmo.local_state(row, service.dest) == "stale"


@pytest.mark.parametrize("line", [
    b'{"event_type":"episode_start"}',  # incomplete line
    b'[]\n',
    b'\xff\n',
    b'{invalid}\n',
    b'{"padding":"' + b'x' * (64 * 1024) + b'"}\n',
])
def test_remote_first_event_is_bounded_and_requires_valid_complete_object(metadata_source, line):
    episode, service, _settings = metadata_source
    (episode / "events.jsonl").write_bytes(line)
    row, = service.remote_rows()
    assert row["first_event"] is None


def test_remote_first_event_normalizes_nonfinite_values_like_reader(metadata_source):
    episode, service, _settings = metadata_source
    (episode / "events.jsonl").write_bytes(b'{"event_type":"episode_start","data":{"seed":NaN}}\n')
    row, = service.remote_rows()
    assert row["first_event"] == reader.read_first_event(episode / "events.jsonl")
    assert row["first_event"]["data"]["seed"] == "nan"


def test_remote_first_event_accepts_64_kib_complete_line(metadata_source):
    episode, service, _settings = metadata_source
    event = _start_event()
    encoded = json.dumps(event).encode("utf-8")
    first = encoded + b" " * (64 * 1024 - len(encoded) - 1) + b"\n"
    (episode / "events.jsonl").write_bytes(first + b"x" * (128 * 1024))
    row, = service.remote_rows()
    assert row["first_event"] == event
