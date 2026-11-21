"""The listing avoids per-frame stats; transfer preflight remains exact."""
from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from capx_trace_viewer import gmo
from capx_trace_viewer.gmo_api import GmoService


class LocalRunner:
    def __init__(self, preamble=""):
        self.preamble = preamble

    def run(self, command, *, timeout, input=None):
        argv = shlex.split(command[-1])
        return subprocess.run([sys.executable, "-c", self.preamble + argv[2], *argv[3:]],
                              capture_output=True, text=True, timeout=timeout, input=input)


@pytest.fixture
def tree(tmp_path):
    root = tmp_path / "remote"
    episode = root / "evaluation" / "trial"
    frames = episode / "frames"
    frames.mkdir(parents=True)
    (episode / "episode.json").write_text('{"status":"ended"}')
    (episode / "events.jsonl").write_text('{"seq":1}\n')
    (episode.parent / "run.json").write_text("{}")
    (episode.parent / "eval.json").write_text("{}")
    for index in range(20):
        (frames / f"{index}.png").write_bytes(b"x" * (index + 1))
    settings = gmo.GmoSettings(host="test", mine=(str(root),), shared_root="")
    return episode, settings


def test_listing_bounds_frame_stats_and_manifest_stays_exact(tree):
    episode, settings = tree
    preamble = """
import os
old_stat, old_lstat = os.stat, os.lstat
def guarded(fn):
    def call(path, *args, **kwargs):
        if '/frames/' in str(path):
            raise AssertionError('per-frame stat')
        return fn(path, *args, **kwargs)
    return call
os.stat, os.lstat = guarded(old_stat), guarded(old_lstat)
old_scandir = os.scandir
sample_counts = {}
class Entry:
    def __init__(self, entry):
        self.entry = entry
    def __getattr__(self, key):
        return getattr(self.entry, key)
    def stat(self, *args, **kwargs):
        if '/frames/' in self.entry.path:
            parent = os.path.dirname(self.entry.path)
            sample_counts[parent] = sample_counts.get(parent, 0) + 1
            if sample_counts[parent] > 4:
                raise AssertionError('unbounded frame samples')
        return self.entry.stat(*args, **kwargs)
class Entries:
    def __init__(self, entries):
        self.entries = entries
    def __enter__(self):
        self.entries.__enter__()
        return self
    def __exit__(self, *args):
        return self.entries.__exit__(*args)
    def __iter__(self):
        return self
    def __next__(self):
        return Entry(next(self.entries))
os.scandir = lambda path: Entries(old_scandir(path))
"""
    row, = gmo.list_remote_episodes(LocalRunner(preamble), settings)["episodes"]
    assert row["file_count"] == 22
    assert row["size_approximate"] is True
    manifest = gmo._episode_files(LocalRunner(), settings, row)
    assert len(manifest.files) == 24
    assert sum(size for rel, size, _ in manifest.files if "/frames/" in rel) == sum(range(1, 21))
    assert gmo.local_state(row, episode.parent.parent) == "local"
    (episode / "frames" / "0.png").rename(episode / "frames" / "renamed.png")
    assert gmo.local_state(row, episode.parent.parent) == "stale"


def test_unchanged_fingerprint_skips_frame_enumeration(tree):
    episode, settings = tree
    listing = gmo.list_remote_episodes(LocalRunner(), settings)
    preamble = """
import os
old_scandir = os.scandir
def guarded(path):
    if str(path).endswith('/frames'):
        raise AssertionError('unchanged frame directory was enumerated')
    return old_scandir(path)
os.scandir = guarded
"""
    updated = gmo.list_remote_episodes(LocalRunner(preamble), settings, previous=listing)
    assert updated["episodes"][0]["fingerprint"] == listing["episodes"][0]["fingerprint"]
    assert updated["episodes"][0]["file_count"] == 22
    assert updated["episodes"][0]["remote_now"] >= listing["episodes"][0]["remote_now"]


def test_hundreds_of_fingerprints_reach_remote_stdin(tree):
    episode, settings = tree
    for root in ("assets", "frames"):
        for index in range(19):
            (episode / root / f"camera_{index:02d}").mkdir(parents=True)
    listing = gmo.list_remote_episodes(LocalRunner(), settings)
    row, = listing["episodes"]
    assert len(row["fingerprint_directories"]) == 40
    # Pad the real listing with realistic, validated rows, keeping one live
    # fingerprint that must still skip frame enumeration on the remote side.
    listing["episodes"].extend({
        **row, "run_id": f"evaluation_{index:03d}",
        "path": f"/shared-storage/traces/user/evaluation_{index:03d}",
        "episode_id": f"trial_{index:03d}",
    } for index in range(399))
    captured = []

    class RecordingRunner(LocalRunner):
        def run(self, command, *, timeout, input=None):
            captured.append((command, input))
            return super().run(command, timeout=timeout, input=input)

    preamble = """
import os
old_scandir = os.scandir
def guarded(path):
    if str(path).endswith('/frames'):
        raise AssertionError('large previous listing was dropped')
    return old_scandir(path)
os.scandir = guarded
"""
    updated = gmo.list_remote_episodes(RecordingRunner(preamble), settings, previous=listing)
    command, payload = captured[0]
    previous = json.loads(payload)["previous"]
    assert len(previous) == 400
    assert all(len(item[3]) == 40 for item in previous)
    assert 48 * 1024 < len(json.dumps(previous).encode("utf-8")) < gmo.MAX_LISTING_PREVIOUS_BYTES
    assert payload not in command[-1]
    assert shlex.split(command[-1])[3:] == ["-", "summary", "all"]
    assert updated["episodes"][0]["fingerprint"] == row["fingerprint"]


def test_previous_above_stdin_cap_falls_back_to_full_scan(tree):
    _episode, settings = tree
    listing = gmo.list_remote_episodes(LocalRunner(), settings)
    listing["episodes"][0]["fingerprint_directories"] = ["x" * gmo.MAX_LISTING_PREVIOUS_BYTES]
    captured = []

    class RecordingRunner(LocalRunner):
        def run(self, command, *, timeout, input=None):
            captured.append(json.loads(input))
            return super().run(command, timeout=timeout, input=input)

    updated = gmo.list_remote_episodes(RecordingRunner(), settings, previous=listing)
    assert captured[0]["previous"] == []
    assert updated["episodes"][0]["file_count"] == 22


def test_remote_lister_still_accepts_argv_config_without_stdin(tree):
    _episode, settings = tree
    config = {
        "mine": settings.mine, "team": settings.team, "shared_root": settings.shared_root,
        "submission_root": settings.submission_root, "username": "",
    }
    proc = subprocess.run([sys.executable, "-c", gmo.REMOTE_EPISODE_LISTER,
                           json.dumps(config), "summary", "all"],
                          capture_output=True, text=True, input="", timeout=10)
    assert proc.returncode == 0, proc.stderr
    listing = gmo.validate_remote_listing(json.loads(proc.stdout))
    assert listing["episodes"][0]["file_count"] == 22


@pytest.mark.parametrize("change", ["metadata", "frame_added", "nested_directory", "run_metadata"])
def test_fingerprint_changes_when_inputs_change(tree, change):
    episode, settings = tree
    listing = gmo.list_remote_episodes(LocalRunner(), settings)
    if change == "metadata":
        target = episode / "episode.json"
        target.write_text('{"status":"alive"}')
        info = target.stat()
        os.utime(target, ns=(info.st_atime_ns, info.st_mtime_ns + 1_000_000))
    elif change == "frame_added":
        (episode / "frames" / "added.png").write_bytes(b"new")
    elif change == "nested_directory":
        child = episode / "frames" / "camera"
        child.mkdir()
        (child / "0.png").write_bytes(b"new")
    else:
        (episode.parent / "eval.json").write_text('{"updated":true}')
    updated = gmo.list_remote_episodes(LocalRunner(), settings, previous=listing)
    assert updated["episodes"][0]["fingerprint"] != listing["episodes"][0]["fingerprint"]


def test_eval_only_does_not_enumerate_run_or_episodes(tree):
    episode, settings = tree
    preamble = f"""
import os
old_listdir, old_scandir = os.listdir, os.scandir
def guarded(fn):
    def call(path, *args, **kwargs):
        if str(path).startswith({str(episode.parent)!r}):
            raise AssertionError('eval list scanned episodes')
        return fn(path, *args, **kwargs)
    return call
os.listdir, os.scandir = guarded(old_listdir), guarded(old_scandir)
"""
    listing = gmo.list_remote_evals(LocalRunner(preamble), settings)
    assert listing["episodes"] == []
    assert [row["run_id"] for row in listing["evals"]] == ["evaluation"]


def test_run_filter_does_not_scan_other_runs_and_preserves_conflicts(tree, tmp_path):
    episode, settings = tree
    team = tmp_path / "team"
    collision = team / "evaluation"
    collision.mkdir(parents=True)
    (collision / "eval.json").write_text("{}")
    other = episode.parent.parent / "other"
    other.mkdir()
    (other / "eval.json").write_text("{}")
    settings = gmo.GmoSettings(host=settings.host, mine=settings.mine, team=(str(team),), shared_root="")
    preamble = f"""
import os
old_listdir = os.listdir
def guarded(path):
    if str(path) == {str(other)!r}:
        raise AssertionError('unselected run enumerated')
    return old_listdir(path)
os.listdir = guarded
"""
    listing = gmo.list_remote_episodes(LocalRunner(preamble), settings, run_ids=("evaluation",))
    assert listing["episodes"][0]["conflict"] is True
    assert {row["run_id"] for row in listing["evals"]} == {"evaluation"}
    with pytest.raises(gmo.FetchError, match="run name"):
        gmo.list_remote_episodes(LocalRunner(), settings, run_ids=("../escape",))


def test_persisted_fingerprint_directories_are_validated(tree):
    _episode, settings = tree
    listing = gmo.list_remote_episodes(LocalRunner(), settings)
    listing["episodes"][0]["fingerprint_directories"] = ["../outside"]
    with pytest.raises(gmo.FetchError, match="directory"):
        gmo.validate_remote_listing(listing)


def test_metadata_only_never_enumerates_frames(tree):
    episode, settings = tree
    preamble = """
import os
old_scandir = os.scandir
def guarded(path):
    if str(path).endswith('/frames'):
        raise AssertionError('detail enumerated frame directory')
    return old_scandir(path)
os.scandir = guarded
"""
    listing = gmo.list_remote_episodes(LocalRunner(preamble), settings,
                                        run_ids=("evaluation",), metadata_only=True)
    row, = listing["episodes"]
    assert row["metadata_only"] is True
    assert row["episode_json"] == {"status": "ended"}
    assert row["events_bytes"] == (episode / "events.jsonl").stat().st_size
    # The same metadata row remains suitable for the exact fetch preflight.
    assert len(gmo._episode_files(LocalRunner(), settings, row).files) == 24


def test_metadata_only_episode_has_unknown_size_and_does_not_compare_dummy_digest(tree, tmp_path):
    episode, settings = tree
    listing = gmo.list_remote_episodes(LocalRunner(), settings,
                                      run_ids=("evaluation",), metadata_only=True)
    row, = listing["episodes"]
    service = GmoService(tmp_path / "dest", config_path=tmp_path / "config.json")
    try:
        remote = service._episode_view(row, set())
        assert remote["local_state"] == "remote"
        shutil.copytree(episode, service.dest / "evaluation" / "trial")
        local = service._episode_view(row, set())
        assert local["local_state"] == "local"
        assert remote["size_bytes"] is None
        assert remote["metadata_only"] is True
        assert local["size_bytes"] is None
        assert service._episode_view(row, {("evaluation", "trial")})["local_state"] == "fetching"
    finally:
        service.close()
