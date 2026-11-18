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

from capx_trace_viewer import gmo

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "fetch_gmo.py"
spec = importlib.util.spec_from_file_location("fetch_gmo", SCRIPT)
fetch_gmo = importlib.util.module_from_spec(spec)
sys.modules["fetch_gmo"] = fetch_gmo
spec.loader.exec_module(fetch_gmo)


def _rsync_works(tmp: Path, fake_ssh: Path) -> bool:
    if shutil.which("rsync") is None:
        pytest.skip("rsync is not installed")
    (tmp / "probe_src").mkdir()
    (tmp / "probe_src" / "f").write_text("x")
    proc = subprocess.run(["rsync", "-rt", "--inplace", "--partial", "-e", str(fake_ssh),
                           f"fakehost:{tmp / 'probe_src'}/", f"{tmp / 'probe_dst'}/"], capture_output=True)
    if proc.returncode != 0 or not (tmp / "probe_dst" / "f").is_file():
        version = subprocess.run(["rsync", "--version"], capture_output=True, text=True)
        pytest.skip(f"rsync local ssh probe failed; version: {version.stdout.strip() or version.stderr.strip()}; "
                    f"stderr: {proc.stderr.decode(errors='replace').strip()}")
    return True


@pytest.fixture
def remote(tmp_path):
    """A trace root with one run, a fake ssh that runs commands locally, and a local destination."""
    fake_ssh = tmp_path / "fake_ssh"
    fake_ssh.write_text('#!/bin/sh\n# ssh HOST COMMAND...: run COMMAND here\nshift\nexec sh -c "$*"\n')
    fake_ssh.chmod(fake_ssh.stat().st_mode | stat.S_IXUSR)
    _rsync_works(tmp_path, fake_ssh)
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


@pytest.fixture
def episode_import(remote, monkeypatch):
    monkeypatch.setenv("CAPX_GMO_SSH_COMMAND", remote["ssh"])
    settings = gmo.GmoSettings(host="fakehost", mine=(str(remote["root"]),))
    runner = gmo.ProcessRunner()
    row, = gmo.list_remote_episodes(runner, settings)["episodes"]
    try:
        yield remote, runner, settings, row
    finally:
        runner.close()


def test_episode_fetch_uses_only_preflight_manifest(episode_import, monkeypatch):
    remote, runner, settings, row = episode_import
    original = gmo._remote_python
    added = remote["root"] / "run_a" / "ep_1" / "added_later.mp4"

    def add_after_listing(*args, **kwargs):
        data = original(*args, **kwargs)
        # A sparse file demonstrates that an unlisted file larger than the whole
        # budget is never pulled into an otherwise tiny episode import.
        with added.open("wb") as stream:
            stream.truncate(gmo.MAX_FETCH_BYTES + 1)
        return data

    monkeypatch.setattr(gmo, "_remote_python", add_after_listing)
    assert gmo.fetch_episode(runner, settings, row, remote["dest"]) > 0
    local = remote["dest"] / "run_a" / "ep_1"
    assert (local / "events.jsonl").is_file()
    assert not (local / added.name).exists()
    assert not (local / "outside").exists()


def test_episode_fetch_includes_eval_metadata(episode_import):
    remote, runner, settings, row = episode_import
    source = remote["root"] / "run_a" / "eval.json"
    source.write_text('{"schema":"capx-eval/1","eval_id":"run_a"}')
    assert gmo.fetch_episode(runner, settings, row, remote["dest"]) > 0
    assert (remote["dest"] / "run_a" / "eval.json").read_bytes() == source.read_bytes()
    assert gmo.fetch_episode(runner, settings, row, remote["dest"]) == 0


def test_episode_fetch_uses_one_listing_and_one_rsync_ssh(episode_import, monkeypatch, tmp_path):
    remote, runner, settings, row = episode_import
    source = remote["root"] / "run_a"
    for index in range(270):
        (source / "ep_1" / f"frame_{index:03d}").write_bytes(b"x" * (index + 1))
    expected = {path.relative_to(source): path.read_bytes()
                for path in source.rglob("*") if path.is_file() and not path.is_symlink()}
    calls = tmp_path / "ssh_calls"
    monkeypatch.setenv("CAPX_GMO_TEST_SSH_LOG", str(calls))
    # The fixture's rsync probe and episode discovery have already finished.
    Path(remote["ssh"]).write_text(
        '#!/bin/sh\nshift\n'
        'case "$*" in\n'
        '  python3*) kind=list ;;\n'
        '  rsync*) kind=rsync ;;\n'
        '  *) kind=unexpected ;;\n'
        'esac\n'
        'printf "%s\\n" "$kind" >> "$CAPX_GMO_TEST_SSH_LOG"\n'
        'exec sh -c "$*"\n'
    )
    notes = []
    assert gmo.fetch_episode(runner, settings, row, remote["dest"], notes=notes) == sum(map(len, expected.values()))
    assert calls.read_text().splitlines() == ["list", "rsync"]
    assert notes == []
    local = remote["dest"] / "run_a"
    assert (local / "run.json").read_bytes() == expected[Path("run.json")]
    assert {path.relative_to(local): path.read_bytes()
            for path in local.rglob("*") if path.is_file()} == expected

    calls.write_text("")
    assert gmo.fetch_episode(runner, settings, row, remote["dest"], notes=notes) == 0
    assert calls.read_text().splitlines() == ["list"]


@pytest.mark.parametrize("relative", ["run.json", "ep_1/events.jsonl", "ep_1/videos/video_combined.mp4",
                                     "ep_1/heartbeat"])
def test_episode_fetch_allows_files_to_grow_after_preflight(episode_import, monkeypatch, relative):
    remote, runner, settings, row = episode_import
    run = remote["root"] / "run_a"
    source = run / relative
    if relative == "ep_1/heartbeat":
        source.touch()
    before = source.read_bytes()
    preflight_bytes = sum(path.stat().st_size for path in run.rglob("*")
                          if path.is_file() and not path.is_symlink())
    appended = b"recording continues\n"
    original = gmo._remote_python

    def grow_after_listing(*args, **kwargs):
        data = original(*args, **kwargs)
        with source.open("ab") as stream:
            stream.write(appended)
        return data

    monkeypatch.setattr(gmo, "_remote_python", grow_after_listing)
    notes = []
    copied = gmo.fetch_episode(runner, settings, row, remote["dest"],
                               max_bytes=preflight_bytes + 1, notes=notes)
    assert copied == preflight_bytes + len(appended)
    assert (remote["dest"] / "run_a" / relative).read_bytes() == before + appended
    assert notes == ["remote changed during transfer"]


def test_episode_fetch_does_not_recurse_into_replaced_file(episode_import, monkeypatch):
    remote, runner, settings, row = episode_import
    source = remote["root"] / "run_a" / "ep_1" / "events.jsonl"
    original = gmo._remote_python

    def replace_after_listing(*args, **kwargs):
        data = original(*args, **kwargs)
        source.unlink()
        source.mkdir()
        (source / "unlisted").write_text("outside manifest")
        return data

    monkeypatch.setattr(gmo, "_remote_python", replace_after_listing)
    notes = []
    assert gmo.fetch_episode(runner, settings, row, remote["dest"], notes=notes) > 0
    assert notes == ["remote changed during transfer"]
    assert not (remote["dest"] / "run_a" / "ep_1" / "events.jsonl" / "unlisted").exists()


def test_episode_fetch_updates_empty_heartbeat_and_adds_empty_file(episode_import):
    remote, runner, settings, row = episode_import
    source = remote["root"] / "run_a" / "ep_1"
    heartbeat = source / "heartbeat"
    heartbeat.touch()
    assert gmo.fetch_episode(runner, settings, row, remote["dest"]) > 0
    new_mtime = int(heartbeat.stat().st_mtime) + 60
    os.utime(heartbeat, (new_mtime, new_mtime))
    (source / "new_empty").touch()
    assert gmo.fetch_episode(runner, settings, row, remote["dest"]) == 0
    local = remote["dest"] / "run_a" / "ep_1"
    assert int((local / "heartbeat").stat().st_mtime) == new_mtime
    assert (local / "new_empty").is_file()
    refreshed, = gmo.list_remote_episodes(runner, settings)["episodes"]
    assert gmo.local_state(refreshed, remote["dest"]) == "local"


def test_episode_fetch_rejects_exactly_one_gib_before_copy(tmp_path, monkeypatch):
    monkeypatch.setattr(gmo, "_remote_python", lambda *a, **kw: {
        "files": [["ep_1/events.jsonl", gmo.MAX_FETCH_BYTES, 1]]
    })
    runner = gmo.ProcessRunner()
    try:
        with pytest.raises(gmo.FetchError, match="exceeds"):
            gmo.fetch_episode(runner, gmo.GmoSettings(host="fakehost"),
                              {"run_id": "run_a", "episode_id": "ep_1", "path": "/remote/run_a"},
                              tmp_path / "dest")
        assert not runner._children
        assert not (tmp_path / "dest").exists()
    finally:
        runner.close()


@pytest.mark.parametrize("relative", ["run.json", "eval.json", "ep_1/events.jsonl", "ep_1/nested/other"])
def test_episode_fetch_rejects_existing_hardlinks(tmp_path, monkeypatch, relative):
    dest = tmp_path / "dest"
    target = dest / "run_a" / relative
    target.parent.mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.write_text("shared original")
    os.link(outside, target)
    st = outside.stat()
    monkeypatch.setattr(gmo, "_remote_python", lambda *a, **kw: {
        "files": [[relative, st.st_size, int(st.st_mtime)]]
    })
    runner = gmo.ProcessRunner()
    try:
        with pytest.raises(gmo.FetchError, match="hardlink"):
            gmo.fetch_episode(runner, gmo.GmoSettings(host="fakehost"),
                              {"run_id": "run_a", "episode_id": "ep_1", "path": "/remote/run_a"}, dest)
        assert outside.read_text() == "shared original"
        assert not runner._children
    finally:
        runner.close()


def test_prefetch_plans_all_episodes_then_fits_newest_under_total_limit(tmp_path, monkeypatch, capsys):
    settings = gmo.GmoSettings(host="fakehost", mine=("/remote",))
    rows = [{"run_id": "run_a", "episode_id": name, "path": "/remote/run_a",
             "conflict": False, "max_mtime": mtime}
            for name, mtime in (("old", 1), ("new", 3), ("middle", 2))]
    sizes = {"new": 600 * 1024**2, "middle": 500 * 1024**2, "old": 200 * 1024**2}
    planned = []
    copied = []
    monkeypatch.setattr(gmo, "load_settings", lambda: settings)
    monkeypatch.setattr(gmo, "list_remote_episodes", lambda *a: {"episodes": rows, "evals": []})

    def manifest(runner, config, row):
        assert not copied  # Every remote manifest must precede the first copy.
        planned.append(row["episode_id"])
        return gmo.RemoteRun(row["run_id"], row["path"], [
            ("run.json", 2, 1), (row["episode_id"] + "/events.jsonl", sizes[row["episode_id"]], 1)
        ])

    def transfer(runner, config, run, episode_id, dest, **kwargs):
        assert len(planned) == len(rows)
        assert config == settings
        copied.append((episode_id, run.files))
        return sum(size for _, size, _ in run.files)

    monkeypatch.setattr(gmo, "_episode_files", manifest)
    monkeypatch.setattr(gmo, "_transfer_episode", transfer)
    assert gmo.prefetch_mine(tmp_path / "dest") == 0
    assert planned == ["new", "middle", "old"]
    assert [name for name, _ in copied] == ["new", "old"]
    assert sum(size for _, files in copied for _, size, _ in files) == 800 * 1024**2 + 2
    assert sum(rel == "run.json" for _, files in copied for rel, _, _ in files) == 1
    output = capsys.readouterr()
    assert output.err.count("\n") == 1
    assert "Skipped 1 mine episode(s); 500.0 MB" in output.err
    assert "Fetched 2 mine episode(s)" in output.out


def test_prefetch_skips_exact_one_gib_and_starts(tmp_path, monkeypatch, capsys):
    row = {"run_id": "run_a", "episode_id": "ep_1", "path": "/remote/run_a",
           "conflict": False, "max_mtime": 1}
    monkeypatch.setattr(gmo, "load_settings", lambda: gmo.GmoSettings(host="alias", mine=("/remote",)))
    monkeypatch.setattr(gmo, "list_remote_episodes", lambda *a: {"episodes": [row], "evals": []})
    monkeypatch.setattr(gmo, "_episode_files", lambda *a: gmo.RemoteRun(
        "run_a", "/remote/run_a", [("ep_1/events.jsonl", gmo.MAX_FETCH_BYTES, 1)]))
    monkeypatch.setattr(gmo, "_transfer_episode", lambda *a, **kw: pytest.fail("over-budget transfer"))
    assert gmo.prefetch_mine(tmp_path / "dest") == 0
    assert "Skipped 1 mine episode(s); 1.0 GB" in capsys.readouterr().err
    assert not (tmp_path / "dest").exists()
