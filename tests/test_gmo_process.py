"""GMO settings and subprocess regressions that need no sockets or rsync."""
from __future__ import annotations

import errno
import json
import os
import shlex
import signal
import sys
import time

import pytest

from capx_trace_viewer import gmo


@pytest.mark.parametrize("shared_root", [
    None, 1, [], "relative/traces", "~user/traces", "/path/../traces", "/..", "/path/*",
    "/path/?", "/path/[users]", "/path/{users}", "/with space", "/path\ntraces",
    "/path\x00traces", "/path\ttraces", "/path;command",
])
def test_shared_root_validation(shared_root):
    with pytest.raises(gmo.FetchError, match="shared_root"):
        gmo.GmoSettings.from_dict({"host": "alias", "shared_root": shared_root})


@pytest.mark.parametrize("shared_root", ["", "/", "~/traces", "/path/to/shared/traces", "/path/traces/", "/path/v..2"])
def test_shared_root_round_trip_and_configuration(shared_root):
    settings = gmo.GmoSettings.from_dict({"host": "alias", "shared_root": shared_root})
    assert settings.shared_root == shared_root
    assert settings.configured is bool(shared_root)
    assert gmo.GmoSettings.from_dict(settings.as_dict()) == settings


def test_old_settings_file_without_shared_root_still_loads(tmp_path):
    path = tmp_path / "gmo.json"
    original = {"host": "alias", "port": 2222, "identity_file": "~/.ssh/KEY",
                "mine": ["/path/to/mine"], "team": ["/path/to/team/*"], "interval_s": 300}
    path.write_text(json.dumps(original))
    settings = gmo.load_settings(path)
    assert settings.shared_root == "~/shared-storage/traces" and settings.configured
    assert settings == gmo.GmoSettings("alias", 2222, "~/.ssh/KEY",
                                       ("/path/to/mine",), ("/path/to/team/*",), 300)
    gmo.save_settings(settings, path)
    assert gmo.load_settings(path) == settings
    assert json.loads(path.read_text()) == {**original, "shared_root": "~/shared-storage/traces"}


@pytest.mark.parametrize("host", ["a:b", "user@a:b", "::1"])
def test_colons_are_refused_in_ssh_destinations(host):
    with pytest.raises(gmo.FetchError, match="Invalid host"):
        gmo.GmoSettings.from_dict({"host": host})
    runner = gmo.ProcessRunner()
    try:
        with pytest.raises(gmo.FetchError, match="not configured"):
            gmo._remote_python(runner, gmo.GmoSettings(host=host), "", [], timeout=1)
        assert not runner._children
    finally:
        runner.close()


@pytest.mark.parametrize("host", ["gmo", "user@host.example", "gmo-login_1"])
def test_plain_ssh_destinations_are_accepted(host):
    assert gmo.GmoSettings.from_dict({"host": host}).host == host


@pytest.mark.parametrize("mine_only", [False, True], ids=["all", "mine-only"])
def test_shared_root_skips_unreadable_user_directory(tmp_path, monkeypatch, mine_only):
    shared = tmp_path / "shared"
    for owner in ("alice", "bob", "carol"):
        episode = shared / owner / (owner + "_run") / "ep_1"
        episode.mkdir(parents=True)
        (episode / "events.jsonl").write_text('{"seq":1}\n')
    denied = shared / "bob"
    attempted = tmp_path / "denied-listing"
    # Raise the remote filesystem error explicitly so this also works when the
    # tests run as root, which can read directories regardless of their mode.
    guard = f"""
original_listdir = os.listdir
def guarded_listdir(path):
    if os.fspath(path) == {str(denied)!r}:
        with open({str(attempted)!r}, 'w') as stream:
            stream.write('attempted')
        raise PermissionError(13, 'Permission denied', path)
    return original_listdir(path)
os.listdir = guarded_listdir
"""
    runner = gmo.ProcessRunner()
    original_run = runner.run

    def local_remote(argv, **kwargs):
        command = shlex.split(argv[-1])
        assert command[:2] == ["python3", "-c"]
        code = "import os\n" + guard + command[2]
        return original_run([sys.executable, "-c", code, *command[3:]], **kwargs)

    monkeypatch.setattr(runner, "run", local_remote)
    settings = gmo.GmoSettings(host="alice@example.com", shared_root=str(shared))
    try:
        rows = gmo.list_remote_episodes(runner, settings, mine_only=mine_only, include_files=mine_only)["episodes"]
    finally:
        runner.close()
    assert attempted.is_file()
    expected = [("alice_run", "alice", True)]
    if not mine_only:
        expected.append(("carol_run", "carol", False))
    assert [(row["run_id"], row["owner"], row["mine"]) for row in rows] == expected
    assert not any(row["conflict"] for row in rows)


def test_timeout_kills_descendants_after_direct_child_exits(tmp_path, monkeypatch):
    pid_file = tmp_path / "descendant.pid"
    code = """
import os, sys, time
child = os.fork()
if child == 0:
    time.sleep(5)
    os._exit(0)
with open(sys.argv[1], 'w') as stream:
    stream.write(str(child))
os._exit(0)
"""
    killed_after_exit = []
    original_kill = gmo.ProcessRunner._kill

    def record_kill(proc):
        killed_after_exit.append(proc.poll() == 0)
        original_kill(proc)

    monkeypatch.setattr(gmo.ProcessRunner, "_kill", staticmethod(record_kill))
    runner = gmo.ProcessRunner()
    started = time.monotonic()
    try:
        with pytest.raises(gmo.FetchError, match="timed out"):
            runner.run([sys.executable, "-c", code, str(pid_file)], timeout=0.2)
        assert time.monotonic() - started < 2
        assert killed_after_exit == [True]
        assert not runner._children
        # Cleanup did not strand the runner; another queued operation can run.
        assert runner.run([sys.executable, "-c", "print('next')"], timeout=1).stdout == "next\n"
    finally:
        runner.close()
        if pid_file.exists():
            try:
                os.kill(int(pid_file.read_text()), signal.SIGKILL)
            except ProcessLookupError:
                pass


@pytest.mark.parametrize("killpg_errno", [None, errno.EPERM, errno.EIO],
                         ids=["real-killpg", "eperm", "other-oserror"])
def test_timeout_cleanup_is_bounded_when_descendant_escapes_group(tmp_path, monkeypatch, killpg_errno):
    pid_file = tmp_path / "escaped.pid"
    code = """
import os, sys, time
child = os.fork()
if child == 0:
    os.setsid()
    with open(sys.argv[1], 'w') as stream:
        stream.write(str(os.getpid()))
    time.sleep(5)
    os._exit(0)
os._exit(0)
"""
    killpg_calls = []
    original_killpg = os.killpg

    def killpg(pgid, sig):
        killpg_calls.append((pgid, sig))
        if killpg_errno is not None:
            # Reproduce macOS EPERM for an exited group, and other signal errors.
            raise OSError(killpg_errno, os.strerror(killpg_errno))
        original_killpg(pgid, sig)

    monkeypatch.setattr(os, "killpg", killpg)
    reaped = []
    original_reap = gmo.ProcessRunner._reap

    def record_reap(proc):
        original_reap(proc)
        reaped.append(proc)

    monkeypatch.setattr(gmo.ProcessRunner, "_reap", staticmethod(record_reap))
    runner = gmo.ProcessRunner()
    started = time.monotonic()
    try:
        with pytest.raises(gmo.FetchError, match="timed out"):
            runner.run([sys.executable, "-c", code, str(pid_file)], timeout=0.2)
        assert time.monotonic() - started < 2.5
        assert pid_file.exists()
        proc, = reaped
        assert killpg_calls == [(proc.pid, signal.SIGKILL)]
        assert proc.returncode == 0
        assert proc.stdout.closed and proc.stderr.closed
        assert not runner._children
        assert runner.run([sys.executable, "-c", "pass"], timeout=1).returncode == 0
    finally:
        runner.close()
        if pid_file.exists():
            try:
                os.kill(int(pid_file.read_text()), signal.SIGKILL)
            except ProcessLookupError:
                pass
