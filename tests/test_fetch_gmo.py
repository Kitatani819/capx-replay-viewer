"""scripts/fetch_gmo.py against a local directory standing in for GMO."""
from __future__ import annotations

import importlib.util
import os
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "fetch_gmo.py"
spec = importlib.util.spec_from_file_location("fetch_gmo", SCRIPT)
fetch_gmo = importlib.util.module_from_spec(spec)
sys.modules["fetch_gmo"] = fetch_gmo
spec.loader.exec_module(fetch_gmo)


def _rsync_works(tmp: Path, fake_ssh: Path) -> bool:
    if shutil.which("rsync") is None or shutil.which("python3") is None:
        return False
    (tmp / "probe_src").mkdir()
    (tmp / "probe_src" / "f").write_text("x")
    proc = subprocess.run(["rsync", "-rt", "--inplace", "--partial", "-e", str(fake_ssh),
                           f"fakehost:{tmp / 'probe_src'}/", f"{tmp / 'probe_dst'}/"], capture_output=True)
    return proc.returncode == 0 and (tmp / "probe_dst" / "f").is_file()


@pytest.fixture
def remote(tmp_path):
    """A trace root with one run, a fake ssh that runs commands locally, and a local destination."""
    fake_ssh = tmp_path / "fake_ssh"
    fake_ssh.write_text('#!/bin/sh\n# ssh HOST COMMAND...: run COMMAND here\nshift\nexec sh -c "$*"\n')
    fake_ssh.chmod(fake_ssh.stat().st_mode | stat.S_IXUSR)
    if not _rsync_works(tmp_path, fake_ssh):
        pytest.skip("rsync with a local transport is not available")
    root = tmp_path / "gmo" / "job.1" / "traces"
    episode = root / "run_a" / "ep_1"
    (episode / "videos").mkdir(parents=True)
    (root / "run_a" / "run.json").write_text("{}\n")
    (episode / "events.jsonl").write_text('{"seq": 1}\n')
    (episode / "videos" / "video_combined.mp4").write_bytes(b"\0" * 4096)
    (episode / "outside").symlink_to("/etc/hostname")
    (root / "not_a_run").mkdir()  # no run.json and no events.jsonl
    return {"root": root, "ssh": str(fake_ssh), "dest": tmp_path / "local" / "traces"}


def _main(remote, *extra):
    return fetch_gmo.main(["--host", "fakehost", "--ssh", remote["ssh"], "--traces", str(remote["root"]),
                           "--dest", str(remote["dest"]), *extra])


def test_fetch_copies_runs_then_only_changes(remote, capsys):
    assert _main(remote) == 0
    local = remote["dest"] / "run_a"
    assert (local / "ep_1" / "videos" / "video_combined.mp4").stat().st_size == 4096
    assert not (local / "ep_1" / "outside").exists()  # symlinks are never copied
    assert not (remote["dest"] / "not_a_run").exists()
    first = capsys.readouterr().out
    assert "1 run(s) on fakehost" in first and "episodes=1" in first

    assert _main(remote) == 0
    assert "up to date" in capsys.readouterr().out

    events = remote["root"] / "run_a" / "ep_1" / "events.jsonl"
    inode = (local / "ep_1" / "events.jsonl").stat().st_ino
    with events.open("a") as stream:
        stream.write('{"seq": 2}\n')
    os.utime(events, (events.stat().st_atime, events.stat().st_mtime + 5))
    assert _main(remote) == 0
    assert "copy 22 B" in capsys.readouterr().out
    assert (local / "ep_1" / "events.jsonl").read_text().count("seq") == 2
    assert (local / "ep_1" / "events.jsonl").stat().st_ino == inode  # updated in place for a reading viewer


def test_list_copies_nothing(remote, capsys):
    assert _main(remote, "--list") == 0
    assert "copy 4.0 KB" in capsys.readouterr().out
    assert not remote["dest"].exists()


def test_size_limit_stops_before_copying(remote, capsys):
    assert _main(remote, "--max-gb", "0.000001") == 1
    assert "exceeds --max-gb" in capsys.readouterr().err
    assert not (remote["dest"] / "run_a").exists()


def test_run_filter(remote, capsys):
    assert _main(remote, "--run", "missing_run") == 1
    assert "Not found on fakehost: missing_run" in capsys.readouterr().err
    assert _main(remote, "--run", "run_a") == 0


def test_unsafe_patterns_and_names_are_refused():
    with pytest.raises(fetch_gmo.FetchError, match="Unsupported characters"):
        fetch_gmo.list_remote("ssh", "gmo", ["/data; rm -rf ~"])
    run = fetch_gmo.RemoteRun
    for bad in (run("../up", "/data/x", []), run("ok", "/data/with space", []),
                run("ok", "/data/x", [("../escape", 1, 0)])):
        with pytest.raises(fetch_gmo.FetchError, match="Refusing"):
            fetch_gmo.check_runs([bad])
    with pytest.raises(fetch_gmo.FetchError, match="two places"):
        fetch_gmo.check_runs([run("same", "/a/same", []), run("same", "/b/same", [])])


def test_settings_from_environment(monkeypatch):
    monkeypatch.setenv("CAPX_GMO_HOST", "mygmo")
    monkeypatch.setenv("CAPX_GMO_TRACES", "/w/a/traces:/w/b/traces")
    monkeypatch.setenv("CAPX_GMO_SSH", "ssh -p 8822")
    args = fetch_gmo.parse_args([])
    assert (args.host, args.traces, args.ssh) == ("mygmo", ["/w/a/traces", "/w/b/traces"], "ssh -p 8822")
    monkeypatch.delenv("CAPX_GMO_TRACES")
    with pytest.raises(SystemExit):
        fetch_gmo.parse_args([])
