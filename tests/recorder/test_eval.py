"""Evaluation CLI subprocess lifecycle, heartbeat and optional destination hooks."""

import hashlib
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

from capx_trace_recorder import eval as wrapper
from capx_trace_viewer import evals


def environment(trace_root):
    env = os.environ.copy()
    env.pop("CAPX_TRACE_RUN_ID", None)
    env["CAPX_TRACE_DIR"] = str(trace_root)
    return env


def run_cli(trace_root, code, *options, env=None):
    return subprocess.run([sys.executable, "-m", "capx_trace_recorder", "eval", *options,
                           "--", sys.executable, "-c", code], env=environment(trace_root) if env is None else env,
                          text=True, capture_output=True, timeout=15)


def read_record(trace_root):
    paths = list(trace_root.glob("*/eval.json"))
    assert len(paths) == 1
    data = json.loads(paths[0].read_text())
    evals.validate_eval_record(data, eval_id=paths[0].parent.name)
    return data


@pytest.mark.parametrize("exit_code", [0, 7])
def test_cli_preserves_exit_and_records_empty_eval(tmp_path, exit_code):
    trace_root = tmp_path / "traces"
    code = f"import os,sys; print(os.environ['CAPX_TRACE_RUN_ID']); sys.exit({exit_code})"
    result = run_cli(trace_root, code)
    assert result.returncode == exit_code, result.stderr
    data = read_record(trace_root)
    assert data["status"] == ("completed" if exit_code == 0 else "interrupted")
    assert data["end"] == {"exit_code": exit_code, "signal": None}
    assert data["summary"]["trials"] == 0
    assert data["summary"]["success"] == 0
    assert data["eval_id"] in result.stdout
    assert f"http://127.0.0.1:8390/evals/{data['eval_id']}" in result.stdout
    assert "command" not in data and str(tmp_path) not in json.dumps(data)


@pytest.mark.parametrize("case", ["unset_dir", "set_run_id", "empty_run_id"])
def test_cli_refuses_conflicting_environment(tmp_path, case):
    trace_root = tmp_path / "trace"
    env = environment(trace_root)
    if case == "unset_dir":
        env.pop("CAPX_TRACE_DIR")
    else:
        env["CAPX_TRACE_RUN_ID"] = "existing" if case == "set_run_id" else ""
    result = run_cli(trace_root, "raise AssertionError('must not run')", env=env)
    assert result.returncode == 2
    assert ("CAPX_TRACE_DIR" if case == "unset_dir" else "CAPX_TRACE_RUN_ID") in result.stderr
    assert not trace_root.exists()


@pytest.mark.parametrize("options", [[], ["--baseline", "baseline"],
                                     ["--changed", "x" * 201], ["--baseline", "../escape", "--changed", "x"]])
def test_cli_rejects_invalid_arguments(tmp_path, options):
    argv = [sys.executable, "-m", "capx_trace_recorder", "eval", *options]
    if options:
        argv += ["--", sys.executable, "-c", "raise AssertionError('must not run')"]
    result = subprocess.run(argv, env=environment(tmp_path / "trace"), capture_output=True, text=True, timeout=10)
    assert result.returncode == 2
    assert not (tmp_path / "trace").exists()


def test_options_and_child_arguments_after_separator(tmp_path):
    trace_root = tmp_path / "trace"
    env = environment(trace_root)
    env["CAPX_EVAL_BY"] = "既定の実行者"
    result = subprocess.run([sys.executable, "-m", "capx_trace_recorder", "eval", "--eval-set", "set-1",
                             "--baseline", "missing", "--changed", "修正", "--", sys.executable, "-c",
                             "import sys; assert sys.argv[1:] == ['--changed','child']", "--changed", "child"],
                            env=env, capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    assert result.stderr.count("baseline missing was not found") == 1
    data = read_record(trace_root)
    assert (data["by"], data["changed"], data["baseline_eval_id"], data["eval_set"]) == ("既定の実行者", "修正", "missing", "set-1")


def test_heartbeat_is_atomic_and_interval_injectable(tmp_path, monkeypatch):
    writes = []
    original = wrapper._write_record

    def observe(path, data, **kwargs):
        original(path, data, **kwargs)
        persisted = json.loads(path.read_text())
        writes.append((persisted["status"], persisted["heartbeat_at"], path.stat().st_ino))

    monkeypatch.setattr(wrapper, "_write_record", observe)
    assert wrapper.run_eval([sys.executable, "-c", "import time; time.sleep(.25)"], trace_root=tmp_path,
                            heartbeat_interval=.025) == 0
    live = [row for row in writes if row[0] == "running"]
    assert len(live) >= 3 and len({row[1] for row in live}) >= 3
    assert len({row[2] for row in live}) >= 2
    assert writes[-1][0] == "completed"
    assert not list(tmp_path.glob("*/.eval-*"))


def test_dirty_git_checkout(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()

    def git(*args):
        return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True).stdout

    git("init", "--quiet")
    tracked = repo / "tracked.txt"
    tracked.write_text("before\n")
    git("add", "tracked.txt")
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture")
    tracked.write_text("after\n")
    trace_root = tmp_path / "trace"
    result = run_cli(trace_root, "pass", "--repo", str(repo))
    assert result.returncode == 0, result.stderr
    assert read_record(trace_root)["git"] == {
        "commit": git("rev-parse", "HEAD").decode().strip(), "dirty": True,
        "diff_sha256": hashlib.sha256(git("diff", "HEAD")).hexdigest()}
    assert wrapper.git_revision(tmp_path) is None


def test_sink_failures_at_start_and_end_preserve_exit(tmp_path, capsys):
    seen = []

    class Broken:
        def publish(self, data):
            seen.append(data["status"])
            data["status"] = "mutated"
            raise RuntimeError("secret\nsecond line")

    assert wrapper.run_eval([sys.executable, "-c", "raise SystemExit(9)"], trace_root=tmp_path,
                            sinks=[Broken()]) == 9
    assert seen == ["running", "interrupted"]
    error = capsys.readouterr().err
    assert error.splitlines() == ["eval: sink failed (RuntimeError)"] * 2
    assert read_record(tmp_path)["status"] == "interrupted"


def test_wrapper_summarizes_child_episodes(tmp_path):
    code = "\n".join([
        "import json, os", "from pathlib import Path",
        "run = Path(os.environ['CAPX_TRACE_DIR']) / os.environ['CAPX_TRACE_RUN_ID']",
        "episode = run / 'trial'; episode.mkdir()",
        "(episode / 'episode.json').write_text(json.dumps({'status':'ended','episode_end_written':True,'trace_complete':True,'task':'cube','seed':1,'end_reason':'completed','harness_summary':{'task_completed':True}}))",
    ])
    result = run_cli(tmp_path, code)
    assert result.returncode == 0, result.stderr
    data = read_record(tmp_path)
    assert data["summary"]["trials"] == data["summary"]["success"] == 1
    assert data["summary"]["verdict_sources"] == {"harness_summary": 1}


@pytest.mark.skipif(os.name != "posix", reason="process-group forwarding requires POSIX")
def test_sigterm_is_forwarded_to_child_process_group(tmp_path):
    child_ready, grandchild_ready, terminated = (tmp_path / name for name in ("child", "grandchild", "terminated"))
    grandchild = ("import signal,time; from pathlib import Path; "
                  f"signal.signal(signal.SIGTERM, lambda *_: (Path({str(terminated)!r}).write_text('terminated'), exit(0))); "
                  f"Path({str(grandchild_ready)!r}).write_text('ready'); time.sleep(20)")
    code = "\n".join([
        "import os,subprocess,sys,time", "from pathlib import Path",
        f"subprocess.Popen([sys.executable,'-c',{grandchild!r}])",
        f"ready=Path({str(grandchild_ready)!r})", "while not ready.exists(): time.sleep(.01)",
        f"Path({str(child_ready)!r}).write_text(str(os.getpid()))", "time.sleep(20)",
    ])
    trace_root = tmp_path / "trace"
    proc = subprocess.Popen([sys.executable, "-m", "capx_trace_recorder", "eval", "--", sys.executable, "-c", code],
                            env=environment(trace_root), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        deadline = time.monotonic() + 8
        while not child_ready.exists() and time.monotonic() < deadline and proc.poll() is None:
            time.sleep(.01)
        assert child_ready.exists()
        proc.send_signal(signal.SIGTERM)
        stdout, stderr = proc.communicate(timeout=8)
        assert proc.returncode == 128 + signal.SIGTERM, (stdout, stderr)
        deadline = time.monotonic() + 2
        while not terminated.exists() and time.monotonic() < deadline:
            time.sleep(.01)
        assert terminated.read_text() == "terminated"
        data = read_record(trace_root)
        assert data["status"] == "interrupted"
        assert data["end"] == {"exit_code": -signal.SIGTERM, "signal": signal.SIGTERM}
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=5)
        if child_ready.exists():
            try:
                os.killpg(int(child_ready.read_text()), signal.SIGKILL)
            except ProcessLookupError:
                pass
