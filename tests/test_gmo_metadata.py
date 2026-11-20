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

    def __init__(self, *, now: float | None = None, preamble: str = ""):
        self.now = now
        self.preamble = preamble

    def run(self, command: list[str], *, timeout: float):
        argv = shlex.split(command[-1])
        assert argv[:2] == ["python3", "-c"]
        argv[0] = sys.executable
        if self.now is not None:
            argv[2] = f"import time; time.time = lambda: {self.now!r}\n" + argv[2]
        argv[2] = self.preamble + argv[2]
        return subprocess.run(argv, capture_output=True, text=True, timeout=timeout)

    def close(self):
        pass


@pytest.fixture
def metadata_source(tmp_path, monkeypatch):
    monkeypatch.setenv("CAPX_GMO_CONFIG", str(tmp_path / "config" / "gmo.json"))
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


def test_remote_evals_include_empty_runs_with_independent_light_cache(metadata_source, monkeypatch):
    episode, service, settings = metadata_source
    (episode / "events.jsonl").write_text(json.dumps(_start_event()) + "\n")
    record = {"schema": "capx-eval/1", "eval_id": "run_a"}
    (episode.parent / "eval.json").write_text(json.dumps(record))
    empty = episode.parent.parent / "empty"
    empty.mkdir()
    (empty / "eval.json").write_text("{}")
    calls = []
    original = service.runner.run

    def counted(*args, **kwargs):
        calls.append(args)
        return original(*args, **kwargs)

    monkeypatch.setattr(service.runner, "run", counted)
    listing = service.remote_listing()
    assert len(listing["episodes"]) == 1
    assert [row["run_id"] for row in listing["evals"]] == ["empty", "run_a"]
    row = next(row for row in listing["evals"] if row["run_id"] == "run_a")
    assert row["eval_json"] == record and row["eval_json_error"] is None
    assert row["path"] == str(episode.parent) and row["mine"] is True
    assert isinstance(row["owner"], str) and row["eval_mtime"] > 0
    assert row["conflict"] is False
    light_rows = service.remote_evals()
    assert [{key: value for key, value in row.items() if key != "remote_now"} for row in light_rows] == [
        {key: value for key, value in row.items() if key != "remote_now"} for row in listing["evals"]]
    assert service.remote_rows() == listing["episodes"]
    assert len(calls) == 2
    assert service.remote_evals() == light_rows
    assert len(calls) == 2
    service.invalidate()
    assert [row["eval_json"] for row in service.remote_evals(refresh=True)] == [{}, record]
    assert len(calls) == 3


@pytest.mark.parametrize("damage,error", [
    ("invalid_json", "invalid_json"), ("nan", "invalid_json"), ("infinity", "invalid_json"),
    ("too_large", "too_large"), ("not_a_regular_file", "not_a_regular_file"),
])
def test_remote_evals_preserve_metadata_errors_without_breaking_discovery(metadata_source, damage, error):
    episode, service, _settings = metadata_source
    target = episode.parent / "eval.json"
    if damage == "invalid_json":
        target.write_bytes(b"{broken")
    elif damage in ("nan", "infinity"):
        target.write_text('{"summary":{"config_flags":{"value":%s}}}'
                          % ("NaN" if damage == "nan" else "Infinity"))
    elif damage == "too_large":
        target.write_bytes(b" " * (gmo.MAX_METADATA_BYTES + 1))
    else:
        target.symlink_to(episode.parent / "run.json")
    row, = service.remote_evals()
    assert row["eval_json"] is None and row["eval_json_error"] == error


@pytest.mark.parametrize("name,field", [("run.json", "run_json"), ("episode.json", "episode_json"),
                                       ("eval.json", "eval_json")])
@pytest.mark.parametrize("replacement,error", [("symlink", "not_a_regular_file"),
                                               ("directory", "not_a_regular_file"),
                                               ("too_large", "too_large")])
def test_remote_json_checks_opened_file_when_path_is_replaced(metadata_source, name, field,
                                                            replacement, error):
    episode, service, settings = metadata_source
    (episode / "events.jsonl").write_text(json.dumps(_start_event()) + "\n")
    target = (episode if name == "episode.json" else episode.parent) / name
    target.write_text("{}")
    outside = episode.parent.parent / "outside.json"
    outside.write_text('{"private":true}')
    # Swap immediately before either opening API. This also reproduces the old
    # lstat/open race, rather than only testing an already-present symlink.
    service.runner = LocalPythonRunner(preamble=f"""
import builtins, os
target = {str(target)!r}
original_open, original_os_open = builtins.open, os.open
def replace(path):
    if path != target:
        return
    os.unlink(target)
    if {replacement!r} == 'symlink':
        os.symlink({str(outside)!r}, target)
    elif {replacement!r} == 'directory':
        os.mkdir(target)
    else:
        with original_open(target, 'wb') as stream:
            stream.write(b' ' * (256 * 1024 + 1))
def swapping_open(path, *args, **kwargs):
    replace(path)
    return original_open(path, *args, **kwargs)
def swapping_os_open(path, *args, **kwargs):
    replace(path)
    return original_os_open(path, *args, **kwargs)
builtins.open, os.open = swapping_open, swapping_os_open
""")
    listing = gmo.list_remote_episodes(service.runner, settings)
    row, = listing["evals" if name == "eval.json" else "episodes"]
    assert row[field] is None and row[field + "_error"] == error


def test_remote_evals_skip_invalid_run_without_discarding_valid_rows(metadata_source):
    episode, service, settings = metadata_source
    (episode / "events.jsonl").write_text(json.dumps(_start_event()) + "\n")
    (episode.parent / "eval.json").write_text("{}")
    invalid = episode.parent.parent / "bad name"
    invalid.mkdir()
    (invalid / "eval.json").write_text("{}")
    listing = gmo.list_remote_episodes(service.runner, settings)
    assert [row["run_id"] for row in listing["episodes"]] == ["run_a"]
    assert [row["run_id"] for row in listing["evals"]] == ["run_a"]
    # Invalid episode rows still reject the listing, as they did before.
    bad_episode = invalid / "ep_1"
    bad_episode.mkdir()
    (bad_episode / "episode.json").write_text("{}")
    with pytest.raises(gmo.FetchError, match="unexpected run name"):
        gmo.list_remote_episodes(service.runner, settings)


def test_remote_mine_only_evals_and_conflicts_without_team_episode_walk(metadata_source, tmp_path):
    episode, service, settings = metadata_source
    (episode / "events.jsonl").write_text(json.dumps(_start_event()) + "\n")
    (episode.parent / "eval.json").write_text("{}")
    team = tmp_path / "team"
    for name in ("run_a", "team_only"):
        run = team / name
        run.mkdir(parents=True)
        (run / "eval.json").write_text("{}")
    settings = gmo.GmoSettings(host=settings.host, mine=settings.mine, team=(str(team),))
    listing = gmo.list_remote_episodes(service.runner, settings, mine_only=True)
    assert [row["run_id"] for row in listing["evals"]] == ["run_a"]
    assert listing["evals"][0]["conflict"] is True
    assert listing["episodes"][0]["conflict"] is True
    all_rows = gmo.list_remote_episodes(service.runner, settings)
    assert [(row["run_id"], row["mine"]) for row in all_rows["evals"]] == [
        ("run_a", True), ("run_a", False), ("team_only", False),
    ]


def test_run_metadata_is_in_discovery_and_manual_episode_manifests(metadata_source):
    episode, service, settings = metadata_source
    (episode / "events.jsonl").write_text(json.dumps(_start_event()) + "\n")
    (episode.parent / "eval.json").write_text("{}")
    (episode.parent / "runner_records.jsonl").write_text('{"task_success":true}\n')
    row, = gmo.list_remote_episodes(service.runner, settings, include_files=True)["episodes"]
    discovery = gmo.episode_manifest(row, row)
    manual = gmo._episode_files(service.runner, settings, row)
    assert sorted(discovery.files) == sorted(manual.files)
    assert {rel for rel, _, _ in manual.files} >= {
        "run.json", "eval.json", "runner_records.jsonl", "ep_1/events.jsonl",
    }
    with pytest.raises(gmo.FetchError, match="Unexpected file path"):
        gmo.episode_manifest(row, {"files": [["other/eval.json", 2, 1]]})
