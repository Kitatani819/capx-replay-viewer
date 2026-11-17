"""GMO settings and subprocess regressions that need no sockets or rsync."""
from __future__ import annotations

import os
import signal
import sys
import time

import pytest

from capx_trace_viewer import gmo


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


def test_timeout_cleanup_is_bounded_when_descendant_escapes_group(tmp_path):
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
    runner = gmo.ProcessRunner()
    started = time.monotonic()
    try:
        with pytest.raises(gmo.FetchError, match="timed out"):
            runner.run([sys.executable, "-c", code, str(pid_file)], timeout=0.2)
        assert time.monotonic() - started < 2.5
        assert pid_file.exists()
        assert not runner._children
        assert runner.run([sys.executable, "-c", "pass"], timeout=1).returncode == 0
    finally:
        runner.close()
        if pid_file.exists():
            try:
                os.kill(int(pid_file.read_text()), signal.SIGKILL)
            except ProcessLookupError:
                pass
