"""Import regressions using local transports and files only."""
from __future__ import annotations

import json
import os
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import time

import pytest

from capx_trace_viewer import gmo


@pytest.fixture
def transfer(tmp_path):
    if shutil.which("rsync") is None:
        pytest.skip("rsync is not installed")
    transport = tmp_path / "transport"
    transport.write_text('#!/bin/sh\nshift\nexec sh -c "$*"\n')
    transport.chmod(0o700)
    root = tmp_path / "source"
    episode = root / "run_a" / "trial"
    episode.mkdir(parents=True)
    (episode.parent / "run.json").write_text("{}\n")
    (episode / "events.jsonl").write_text('{"seq":1}\n')
    runs, _ = gmo.list_remote(str(transport), "alias", [str(root)])
    return transport, root, runs[0], tmp_path / "dest" / "run_a"


@pytest.mark.parametrize("link", ["hardlink", "symlink"])
def test_legacy_transfer_rejects_destination_links(transfer, tmp_path, link):
    transport, _root, run, dest = transfer
    target = dest / "trial" / "events.jsonl"
    target.parent.mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.write_text("keep this record")
    if link == "hardlink":
        os.link(outside, target)
    else:
        target.symlink_to(outside)
    with pytest.raises(gmo.FetchError, match=link):
        gmo.rsync_run(str(transport), "alias", run, dest)
    assert outside.read_text() == "keep this record"


def test_legacy_transfer_only_copies_approved_manifest(transfer):
    transport, root, run, dest = transfer
    unlisted = root / run.run_id / "trial" / "added_later.mp4"
    unlisted.write_bytes(b"new video outside the approved transfer")
    gmo.rsync_run(str(transport), "alias", run, dest)
    assert (dest / "trial" / "events.jsonl").read_text() == '{"seq":1}\n'
    assert not (dest / "trial" / unlisted.name).exists()


def test_whole_second_copies_stay_imported(transfer, monkeypatch):
    # macOS's default rsync (and some filesystems) keep only whole-second mtimes.
    # A copy like that must still count as imported, or automatic imports would
    # copy the same files again on every cycle.
    transport, root, _run, dest = transfer
    monkeypatch.setenv("CAPX_GMO_SSH_COMMAND", str(transport))
    source = root / "run_a" / "trial" / "events.jsonl"
    settings = gmo.GmoSettings(host="alias", mine=(str(root),), shared_root="", submission_root="")
    row = {"run_id": "run_a", "episode_id": "trial", "path": str(source.parent.parent)}
    os.utime(source, ns=(1_700_000_000_625_000_000, 1_700_000_000_625_000_000))
    runner = gmo.ProcessRunner()
    try:
        gmo.fetch_episode(runner, settings, row, dest.parent)
        for path in (dest / "trial").rglob("*"):
            if path.is_file():
                whole = int(path.stat().st_mtime) * 1_000_000_000
                os.utime(path, ns=(whole, whole))
        listing = gmo.list_remote_episodes(runner, settings, include_files=True)
        assert gmo.local_state(listing["episodes"][0], dest.parent) == "local"
        run, = gmo.list_remote(str(transport), "alias", [str(root)])[0]
        assert gmo.changed_files(run, dest) == []
    finally:
        runner.close()


def test_saving_settings_preserves_existing_parent_mode(tmp_path):
    shared = tmp_path / "shared"
    shared.mkdir(mode=0o750)
    gmo.save_settings(gmo.GmoSettings(host="alias"), shared / "settings.json")
    assert stat.S_IMODE(shared.stat().st_mode) == 0o750
    assert stat.S_IMODE((shared / "settings.json").stat().st_mode) == 0o600


def test_legacy_listing_has_execution_deadline(tmp_path, monkeypatch):
    monkeypatch.setattr(gmo, "LISTING_TIMEOUT_S", 0.05)
    modes = []
    original = subprocess.Popen

    def spawn(*args, **kwargs):
        if args[0][0] != "ps":
            modes.append(kwargs.get("start_new_session"))
        return original(*args, **kwargs)

    monkeypatch.setattr(subprocess, "Popen", spawn)
    reply = json.dumps({"runs": [], "unmatched": []})
    command = shlex.join([sys.executable, "-c", "import time; time.sleep(.2); print(" + repr(reply) + ")"])
    with pytest.raises(gmo.FetchError, match="timed out"):
        gmo.list_remote(command, "alias", ["/traces"])
    assert modes == [False]  # Keep the terminal available for SSH authentication.


def test_legacy_transfer_has_execution_deadline(tmp_path, monkeypatch):
    monkeypatch.setattr(gmo, "TRANSFER_TIMEOUT_S", 0.05, raising=False)
    modes = []
    original = subprocess.Popen

    def spawn(*args, **kwargs):
        if args[0][0] != "ps":
            modes.append(kwargs.get("start_new_session"))
        return original(*args, **kwargs)

    monkeypatch.setattr(subprocess, "Popen", spawn)
    command = tmp_path / "slow_transfer"
    command.write_text('#!' + sys.executable + '\nimport time\ntime.sleep(.2)\n')
    command.chmod(0o700)
    run = gmo.RemoteRun("run_a", "/traces/run_a", [("trial/events.jsonl", 10, 1)])
    with pytest.raises(gmo.FetchError, match="timed out"):
        gmo.rsync_run("ssh", "alias", run, tmp_path / "dest", rsync=str(command))
    assert modes == [False]


def test_terminal_preserving_runner_reaps_timed_out_child(monkeypatch):
    calls = {}

    class Child:
        pid = 123
        returncode = None

        def __init__(self, command, **kwargs):
            calls["popen"] = kwargs

        def communicate(self, **kwargs):
            if self.returncode is None:
                raise subprocess.TimeoutExpired("transport", kwargs["timeout"])
            calls["reaped"] = True
            return "", ""

        def kill(self):
            calls["killed"] = True
            self.returncode = -9

        def poll(self):
            return self.returncode

    monkeypatch.setattr(subprocess, "Popen", Child)
    monkeypatch.setattr(gmo.ProcessRunner, "_descendant_pids", staticmethod(lambda _pid: []))
    monkeypatch.setattr(os, "killpg", lambda *args: pytest.fail("must not kill the caller's process group"))
    runner = gmo.ProcessRunner(preserve_terminal=True)
    try:
        with pytest.raises(gmo.FetchError, match="timed out"):
            runner.run(["transport"], timeout=0.05)
        assert calls["popen"]["stdin"] is None
        assert calls["popen"]["start_new_session"] is False
        assert calls["killed"] and calls["reaped"]
        assert not runner._children
    finally:
        runner.close()


def test_terminal_preserving_timeout_kills_child_and_grandchild(tmp_path):
    if shutil.which("ps") is None:
        pytest.skip("ps is not installed")
    pid_file = tmp_path / "descendants.json"
    child_code = """
import json, os, subprocess, sys
grandchild = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
with open(sys.argv[1], 'w') as stream:
    json.dump([os.getpid(), grandchild.pid], stream)
grandchild.wait()
"""
    parent_code = """
import subprocess, sys
child = subprocess.Popen([sys.executable, '-c', sys.argv[1], sys.argv[2]])
child.wait()
"""
    runner = gmo.ProcessRunner(preserve_terminal=True)
    descendants = []
    try:
        started = time.monotonic()
        with pytest.raises(gmo.FetchError, match="timed out"):
            runner.run([sys.executable, "-c", parent_code, child_code, str(pid_file)], timeout=0.5)
        assert time.monotonic() - started < 3
        descendants = json.loads(pid_file.read_text())
        status = subprocess.run(["ps", "-o", "pid=,stat=", "-p", ",".join(map(str, descendants))],
                                capture_output=True, text=True, timeout=0.5)
        # Orphaned zombies await the system reaper but cannot execute or retain
        # pipes. There must be no live process left in either descendant slot.
        assert all(row.split()[1].startswith("Z") for row in status.stdout.splitlines())
        assert not runner._children
    finally:
        runner.close()
        if pid_file.exists():
            descendants = json.loads(pid_file.read_text())
        for pid in reversed(descendants):
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


def test_descendant_snapshot_only_selects_owned_subtree(monkeypatch):
    def snapshot(command, **kwargs):
        assert command == ["ps", "-A", "-o", "pid=,ppid="]
        assert kwargs["timeout"] == 0.5
        return subprocess.CompletedProcess(command, 0, "100 1\n200 100\n300 200\n400 1\ninvalid\n", "")

    monkeypatch.setattr(subprocess, "run", snapshot)
    assert gmo.ProcessRunner._descendant_pids(100) == [200, 300]


@pytest.mark.parametrize("error", [OSError("unavailable"), subprocess.TimeoutExpired("ps", 0.5)])
def test_terminal_cleanup_falls_back_to_direct_child_when_snapshot_fails(monkeypatch, error):
    def unavailable(*_args, **_kwargs):
        raise error

    calls = []

    class Child:
        pid = 100
        _capx_own_group = False

        def poll(self):
            return None

        def kill(self):
            calls.append("killed")

    monkeypatch.setattr(subprocess, "run", unavailable)
    monkeypatch.setattr(os, "kill", lambda *_args: pytest.fail("snapshot failed; no descendant is established"))
    monkeypatch.setattr(os, "killpg", lambda *_args: pytest.fail("must not signal the caller's group"))
    gmo.ProcessRunner._kill(Child())
    assert calls == ["killed"]
