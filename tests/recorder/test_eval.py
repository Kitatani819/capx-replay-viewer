"""Evaluation CLI subprocess lifecycle, heartbeat and optional destination hooks."""

import hashlib
import json
import os
import shutil
import signal
import stat
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


def test_child_inherits_the_same_absolute_trace_root_after_chdir(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    child_dir = tmp_path / "child"
    child_dir.mkdir()
    code = (
        "import os; from pathlib import Path; "
        f"os.chdir({str(child_dir)!r}); "
        "root = Path(os.environ['CAPX_TRACE_DIR']); "
        "assert root.is_absolute(); "
        "assert (root / os.environ['CAPX_TRACE_RUN_ID'] / 'eval.json').is_file()"
    )
    assert wrapper.run_eval([sys.executable, "-c", code], trace_root=Path("traces")) == 0
    assert read_record(tmp_path / "traces")["status"] == "completed"


@pytest.mark.parametrize("case", ["unset_dir", "set_run_id", "empty_run_id"])
def test_cli_refuses_conflicting_environment(tmp_path, case):
    trace_root = tmp_path / "trace"
    env = environment(trace_root)
    if case == "unset_dir":
        env.pop("CAPX_TRACE_DIR")
        env.pop("HYPE_TRACE_ROOT", None)
        env["HOME"] = str(tmp_path)
    else:
        env["CAPX_TRACE_RUN_ID"] = "existing" if case == "set_run_id" else ""
    result = run_cli(trace_root, "raise AssertionError('must not run')", env=env)
    assert result.returncode == 2
    assert ("CAPX_TRACE_DIR" if case == "unset_dir" else "CAPX_TRACE_RUN_ID") in result.stderr
    assert not trace_root.exists()


@pytest.mark.parametrize("trace_dir", [None, ""])
def test_cli_defaults_to_hype_root_before_shared_storage(tmp_path, trace_dir):
    home = tmp_path / "home"
    (home / "shared-storage").mkdir(parents=True)
    trace_root = home / "custom-traces" / "test-user"
    env = environment(trace_root)
    env["HOME"] = str(home)
    env["USER"] = "test-user"
    env["HYPE_TRACE_ROOT"] = "~/custom-traces"
    if trace_dir is None:
        env.pop("CAPX_TRACE_DIR")
    else:
        env["CAPX_TRACE_DIR"] = trace_dir
    code = (
        "import os; from pathlib import Path; "
        f"assert os.environ['CAPX_TRACE_DIR'] == {str(trace_root)!r}; "
        "assert (Path(os.environ['CAPX_TRACE_DIR']) / os.environ['CAPX_TRACE_RUN_ID'] / 'eval.json').is_file()"
    )
    result = run_cli(trace_root, code, env=env)
    assert result.returncode == 0, result.stderr
    assert read_record(trace_root)["status"] == "completed"
    assert result.stdout.count(f"eval: records will be saved to {trace_root}\n") == 1
    assert not (home / "shared-storage" / "traces").exists()


@pytest.mark.parametrize("hype_root", [None, ""])
def test_cli_defaults_to_shared_storage_directory_or_symlink(tmp_path, hype_root):
    home = tmp_path / "home"
    home.mkdir()
    storage = tmp_path / "team-storage"
    storage.mkdir()
    (home / "shared-storage").symlink_to(storage, target_is_directory=True)
    trace_root = home / "shared-storage" / "traces" / "test-user"
    env = environment(trace_root)
    env.pop("CAPX_TRACE_DIR")
    env["HOME"] = str(home)
    env["USER"] = "test-user"
    if hype_root is None:
        env.pop("HYPE_TRACE_ROOT", None)
    else:
        env["HYPE_TRACE_ROOT"] = hype_root
    result = run_cli(trace_root, "pass", env=env)
    assert result.returncode == 0, result.stderr
    assert read_record(trace_root)["status"] == "completed"
    assert f"eval: records will be saved to {trace_root}\n" in result.stdout


def test_cli_explicit_trace_dir_takes_precedence_over_automatic_destinations(tmp_path):
    trace_root = tmp_path / "explicit"
    env = environment(trace_root)
    env["HYPE_TRACE_ROOT"] = str(tmp_path / "automatic")
    env["HOME"] = str(tmp_path)
    result = run_cli(trace_root, "pass", env=env)
    assert result.returncode == 0, result.stderr
    assert read_record(trace_root)["status"] == "completed"
    assert not (tmp_path / "automatic").exists()
    assert f"eval: records will be saved to {trace_root}\n" in result.stdout


@pytest.mark.parametrize("run_id", ["existing", ""])
def test_cli_refuses_existing_run_id_before_creating_automatic_destination(tmp_path, run_id):
    shared_root = tmp_path / "traces"
    env = environment(tmp_path / "unused")
    env.pop("CAPX_TRACE_DIR")
    env["CAPX_TRACE_RUN_ID"] = run_id
    env["HYPE_TRACE_ROOT"] = str(shared_root)
    result = run_cli(tmp_path / "unused", "raise AssertionError('must not run')", env=env)
    assert result.returncode == 2
    assert "CAPX_TRACE_RUN_ID is already set" in result.stderr
    assert not shared_root.exists()


def test_cli_automatic_destination_finds_baseline_in_sibling_user_folder(tmp_path):
    shared_root = tmp_path / "traces"
    baseline = shared_root / "other-user" / "baseline" / "eval.json"
    baseline.parent.mkdir(parents=True)
    baseline.write_text("{}")
    trace_root = shared_root / "test-user"
    env = environment(trace_root)
    env.pop("CAPX_TRACE_DIR")
    env["HYPE_TRACE_ROOT"] = str(shared_root)
    env["USER"] = "test-user"
    result = run_cli(trace_root, "pass", "--baseline", "baseline", "--changed", "修正", env=env)
    assert result.returncode == 0, result.stderr
    assert "was not found" not in result.stderr
    assert read_record(trace_root)["baseline_eval_id"] == "baseline"


@pytest.mark.parametrize("user", [None, ""])
def test_cli_default_destination_falls_back_to_getpass(tmp_path, monkeypatch, capsys, user):
    monkeypatch.delenv("CAPX_TRACE_DIR", raising=False)
    monkeypatch.delenv("CAPX_TRACE_RUN_ID", raising=False)
    monkeypatch.setenv("HYPE_TRACE_ROOT", str(tmp_path / "traces"))
    if user is None:
        monkeypatch.delenv("USER", raising=False)
    else:
        monkeypatch.setenv("USER", user)
    monkeypatch.setattr(wrapper.getpass, "getuser", lambda: "fallback-user")
    calls = []
    monkeypatch.setattr(wrapper, "run_eval", lambda command, **kwargs: calls.append(kwargs) or 0)
    assert wrapper.main(["--", "evaluation"]) == 0
    assert calls[0]["trace_root"] == tmp_path / "traces" / "fallback-user"
    assert calls[0]["shared_root"] == tmp_path / "traces"
    assert str(calls[0]["trace_root"]) in capsys.readouterr().out


@pytest.mark.parametrize("trace_dir", [None, ""])
@pytest.mark.parametrize("storage_file", [False, True])
def test_cli_without_destination_names_both_configuration_options(tmp_path, trace_dir, storage_file):
    if storage_file:
        (tmp_path / "shared-storage").write_text("not a directory")
    env = environment(tmp_path / "unused")
    env["HOME"] = str(tmp_path)
    env.pop("HYPE_TRACE_ROOT", None)
    if trace_dir is None:
        env.pop("CAPX_TRACE_DIR")
    else:
        env["CAPX_TRACE_DIR"] = trace_dir
    result = run_cli(tmp_path / "unused", "raise AssertionError('must not run')", env=env)
    assert result.returncode == 2
    assert "CAPX_TRACE_DIR" in result.stderr and "HYPE_TRACE_ROOT" in result.stderr
    assert "~/shared-storage" in result.stderr
    assert not (tmp_path / "unused").exists()


@pytest.mark.skipif(os.name != "posix", reason="file permissions require POSIX")
@pytest.mark.parametrize("umask", [0o027, 0o077, 0o777])
def test_new_shared_root_has_setgid_and_group_write_independent_of_umask(tmp_path, umask):
    shared_root = tmp_path / "traces"
    previous_umask = os.umask(umask)
    try:
        wrapper._create_shared_root(shared_root)
    finally:
        os.umask(previous_umask)
    assert stat.S_IMODE(shared_root.stat().st_mode) == 0o2770


@pytest.mark.skipif(os.name != "posix", reason="file permissions require POSIX")
def test_existing_shared_root_is_never_chmodded(tmp_path, monkeypatch):
    shared_root = tmp_path / "traces"
    shared_root.mkdir(mode=0o750)
    mode = stat.S_IMODE(shared_root.stat().st_mode)

    def refuse_chmod(*_args, **_kwargs):
        raise AssertionError("an existing shared root must never be chmodded")

    monkeypatch.setattr(Path, "chmod", refuse_chmod)
    wrapper._create_shared_root(shared_root)
    assert stat.S_IMODE(shared_root.stat().st_mode) == mode


@pytest.mark.skipif(os.name != "posix", reason="file permissions require POSIX")
def test_automatic_destination_keeps_user_permissions_and_group_warning(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("CAPX_TRACE_DIR", raising=False)
    monkeypatch.delenv("CAPX_TRACE_RUN_ID", raising=False)
    monkeypatch.setenv("HYPE_TRACE_ROOT", str(tmp_path / "traces"))
    monkeypatch.setenv("USER", "test-user")
    previous_umask = os.umask(0o077)
    try:
        assert wrapper.main(["--", sys.executable, "-c", "pass"]) == 0
    finally:
        os.umask(previous_umask)
    shared_root = tmp_path / "traces"
    user_root = shared_root / "test-user"
    assert stat.S_IMODE(shared_root.stat().st_mode) == 0o2770
    # Linux copies the parent's setgid bit to new subdirectories; macOS does not.
    assert stat.S_IMODE(user_root.stat().st_mode) & 0o777 == 0o700
    assert "teammates will not see this evaluation" in capsys.readouterr().err
    assert read_record(user_root)["status"] == "completed"


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


@pytest.mark.skipif(os.name != "posix", reason="file permissions require POSIX")
@pytest.mark.parametrize("existing_mode", [None, 0o664])
def test_record_permissions_survive_heartbeat_and_final_writes(tmp_path, monkeypatch, existing_mode):
    modes = []
    original = wrapper._write_record

    def observe(path, data, **kwargs):
        original(path, data, **kwargs)
        if kwargs.get("initial"):
            assert stat.S_IMODE(path.stat().st_mode) == 0o640
            if existing_mode is not None:
                path.chmod(existing_mode)
        modes.append((data["status"], stat.S_IMODE(path.stat().st_mode)))

    monkeypatch.setattr(wrapper, "_write_record", observe)
    previous_umask = os.umask(0o027)
    try:
        assert wrapper.run_eval([sys.executable, "-c", "import time; time.sleep(.1)"], trace_root=tmp_path,
                                heartbeat_interval=.01) == 0
    finally:
        os.umask(previous_umask)
    assert len([status for status, _mode in modes if status == "running"]) >= 2
    assert modes[-1][0] == "completed"
    assert {mode for _status, mode in modes} == {0o640 if existing_mode is None else existing_mode}


@pytest.mark.skipif(os.name != "posix", reason="file permissions require POSIX")
@pytest.mark.parametrize("umask, warn", [(0o027, False), (0o077, True), (0o047, True), (0o037, True)])
def test_group_access_warning_preserves_permissions_and_exit(tmp_path, capsys, umask, warn):
    previous_umask = os.umask(umask)
    try:
        assert wrapper.run_eval([sys.executable, "-c", "raise SystemExit(9)"], trace_root=tmp_path) == 9
    finally:
        os.umask(previous_umask)
    path = next(tmp_path.glob("*/eval.json"))
    assert stat.S_IMODE(path.stat().st_mode) == 0o666 & ~umask
    assert stat.S_IMODE(path.parent.stat().st_mode) == 0o777 & ~umask
    assert read_record(tmp_path)["end"]["exit_code"] == 9
    error = capsys.readouterr().err
    if warn:
        assert error.splitlines() == [
            "eval: teammates will not see this evaluation in their viewer; use a group-readable "
            "umask such as 027 or a group-owned trace root with group read/search permissions"]
    else:
        assert error == ""


@pytest.mark.skipif(os.name != "posix", reason="process-group waiting requires POSIX")
def test_summary_waits_for_workers_after_leader_exits(tmp_path, monkeypatch):
    checks = []

    class Child:
        pid = 12345

        def wait(self, timeout):
            checks.append("leader exited")
            return -signal.SIGTERM

    def killpg(pgid, signum):
        assert (pgid, signum) == (Child.pid, 0)
        assert checks[0] == "leader exited"
        checks.append("workers checked")
        if len(checks) == 3:
            run = next(tmp_path.iterdir())
            episode = run / "trial"
            episode.mkdir()
            (episode / "episode.json").write_text(json.dumps({
                "status": "ended", "episode_end_written": True, "trace_complete": True,
                "task": "cube", "seed": 1, "end_reason": "completed",
                "harness_summary": {"task_completed": True}}))
            raise ProcessLookupError

    monkeypatch.setattr(wrapper, "git_revision", lambda _repo, **_kwargs: None)
    monkeypatch.setattr(wrapper.eval_resume, "machine_id", lambda: "synthetic-supervisor-test")
    monkeypatch.setattr(wrapper.subprocess, "Popen", lambda *_args, **_kwargs: Child())
    monkeypatch.setattr(wrapper.os, "killpg", killpg)
    assert wrapper.run_eval(["evaluation"], trace_root=tmp_path, worker_wait_timeout=1) == -signal.SIGTERM
    assert checks == ["leader exited", "workers checked", "workers checked"]
    data = read_record(tmp_path)
    assert data["summary"]["trials"] == data["summary"]["success"] == 1
    assert "workers_left_running" not in data["end"]


@pytest.mark.skipif(os.name != "posix", reason="process-group waiting requires POSIX")
def test_worker_wait_timeout_is_bounded_and_recorded(tmp_path, monkeypatch):
    class Child:
        pid = 12345

        def wait(self, timeout):
            return 0

    checks = []
    sleeps = []
    clock = [0.0]

    def sleep(duration):
        sleeps.append(duration)
        clock[0] += duration

    monkeypatch.setattr(wrapper, "git_revision", lambda _repo, **_kwargs: None)
    monkeypatch.setattr(wrapper.eval_resume, "machine_id", lambda: "synthetic-supervisor-test")
    monkeypatch.setattr(wrapper.subprocess, "Popen", lambda *_args, **_kwargs: Child())
    monkeypatch.setattr(wrapper.os, "killpg", lambda *args: checks.append(args))
    monkeypatch.setattr(wrapper.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(wrapper.time, "sleep", sleep)
    assert wrapper.run_eval(["evaluation"], trace_root=tmp_path, worker_wait_timeout=.25) == 0
    assert checks == [(Child.pid, 0)] * 4
    assert sum(sleeps) == pytest.approx(.25)
    data = read_record(tmp_path)
    assert data["status"] == "completed"
    assert data["end"] == {"exit_code": 0, "signal": None, "workers_left_running": True}
    assert data["summary"]["trials"] == 0


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


def test_unavailable_git_revision_warns_and_keeps_eval_result(tmp_path):
    repo = tmp_path / "non-git"
    repo.mkdir()
    trace_root = tmp_path / "trace"
    result = run_cli(trace_root, "pass", "--repo", str(repo))
    assert result.returncode == 0, result.stderr
    assert result.stderr.count("Git metadata unavailable") == 1
    assert str(repo) not in result.stderr
    assert read_record(trace_root)["git"] is None


@pytest.mark.parametrize("layout", ["detached", "loose", "packed", "gitfile", "worktree_loose", "worktree_packed"])
def test_git_failure_reads_commit_from_checkout_files(tmp_path, monkeypatch, layout):
    repo = tmp_path / "repo"
    repo.mkdir()
    git = repo / ".git"
    if layout in {"gitfile", "worktree_loose", "worktree_packed"}:
        git = tmp_path / "gitdir"
        (repo / ".git").write_text("gitdir: ../gitdir\n")
    git.mkdir()
    commit = "a1" * 20
    if layout in {"detached", "gitfile"}:
        (git / "HEAD").write_text(commit + "\n")
    else:
        (git / "HEAD").write_text("ref: refs/heads/main\n")
        common = git
        if layout.startswith("worktree_"):
            common = tmp_path / "common"
            common.mkdir()
            (git / "commondir").write_text("../common\n")
        if layout.endswith("packed"):
            (common / "packed-refs").write_text(
                "# pack-refs with: peeled fully-peeled sorted\n"
                + "b2" * 20 + " refs/heads/other\n^" + "c3" * 20 + "\n"
                + commit + " refs/heads/main\n")
        else:
            ref = common / "refs" / "heads" / "main"
            ref.parent.mkdir(parents=True)
            ref.write_text(commit + "\n")

    calls = []

    def fail(args, **kwargs):
        calls.append(args)
        return subprocess.CompletedProcess(args, 128, b"", b"fatal: dubious ownership")

    monkeypatch.setattr(wrapper.subprocess, "run", fail)
    assert wrapper.git_revision(repo) == {"commit": commit, "dirty": None, "diff_sha256": None}
    assert len(calls) == 1


@pytest.mark.parametrize("failure", [FileNotFoundError("git"), subprocess.TimeoutExpired("git", 10)])
def test_missing_or_timed_out_git_records_commit_and_warns_once(tmp_path, monkeypatch, capsys, failure):
    repo = tmp_path / "repo"
    git = repo / ".git"
    git.mkdir(parents=True)
    commit = "d4" * 20
    (git / "HEAD").write_text(commit + "\n")

    def fail(*args, **kwargs):
        raise failure

    monkeypatch.setattr(wrapper.subprocess, "run", fail)
    trace_root = tmp_path / "trace"
    monkeypatch.setattr(wrapper, "_warn_group_access", lambda _path: None)
    assert wrapper.run_eval([sys.executable, "-c", "raise SystemExit(7)"], trace_root=trace_root, repo=repo) == 7
    assert read_record(trace_root)["git"] == {"commit": commit, "dirty": None, "diff_sha256": None}
    warning = capsys.readouterr().err
    assert len(warning.splitlines()) == 1
    assert "commit recorded" in warning.lower()
    assert "uncommitted changes" in warning.lower() and "unknown" in warning.lower()
    assert "--trust-repo" in warning
    assert "Git metadata unavailable" not in warning


@pytest.mark.parametrize("head", ["", "not-a-commit", "ref: refs/heads/missing\n", "\xff"])
def test_invalid_fallback_commit_keeps_git_metadata_unavailable(tmp_path, monkeypatch, head):
    git = tmp_path / ".git"
    git.mkdir()
    (git / "HEAD").write_bytes(head.encode("latin-1"))
    monkeypatch.setattr(wrapper.subprocess, "run",
                        lambda args, **kwargs: subprocess.CompletedProcess(args, 128, b"", b""))
    assert wrapper.git_revision(tmp_path) is None


@pytest.mark.skipif(os.name != "posix", reason="executable Git stub requires POSIX")
@pytest.mark.parametrize("existing_global", [False, True])
def test_cli_trust_repo_scopes_global_config_and_removes_it_before_child(tmp_path, existing_global):
    repo = tmp_path / 'チーム "repo"\\checkout'
    repo.mkdir()
    stub_dir = tmp_path / "bin"
    stub_dir.mkdir()
    observed = tmp_path / "git-config-path"
    commit = "e5" * 20
    stub = stub_dir / "git"
    stub.write_text("\n".join([
        f"#!{sys.executable}",
        "import os, subprocess, sys", "from pathlib import Path",
        "config = Path(os.environ['GIT_CONFIG_GLOBAL'])",
        f"value = subprocess.run([{shutil.which('git')!r}, 'config', '--file', str(config), "
        "'--get-all', 'safe.directory'], capture_output=True, text=True, check=True).stdout",
        f"assert value == {str(repo.resolve()) + chr(10)!r}",
        f"Path({str(observed)!r}).write_text(str(config))",
        f"if sys.argv[-2:] == ['rev-parse', 'HEAD']: print({commit!r})",
        "elif sys.argv[-4:] == ['config', '--null', '--name-only', '--list']: pass",
        "elif sys.argv[-3:] != ['status', '--porcelain', '--ignore-submodules=all']: raise AssertionError(sys.argv)",
    ]) + "\n")
    stub.chmod(0o755)
    trace_root = tmp_path / "trace"
    env = environment(trace_root)
    env["PATH"] = str(stub_dir) + os.pathsep + env.get("PATH", "")
    env.pop("GIT_CONFIG_GLOBAL", None)
    original = None
    if existing_global:
        original = str(tmp_path / "original-global")
        Path(original).write_text("[user]\n\tname = Original\n")
        env["GIT_CONFIG_GLOBAL"] = original
    code = "\n".join([
        "import os", "from pathlib import Path",
        f"assert os.environ.get('GIT_CONFIG_GLOBAL') == {original!r}",
        f"assert not Path(Path({str(observed)!r}).read_text()).exists()",
    ])
    result = run_cli(trace_root, code, "--repo", str(repo), "--trust-repo", env=env)
    assert result.returncode == 0, result.stderr
    assert read_record(trace_root)["git"] == {"commit": commit, "dirty": False}
    assert not Path(observed.read_text()).exists()
    if original is not None:
        assert Path(original).read_text() == "[user]\n\tname = Original\n"


@pytest.mark.parametrize("failure", ["failed", "missing", "timeout"])
def test_trust_repo_removes_temporary_global_config_when_git_fails(tmp_path, monkeypatch, failure):
    monkeypatch.delenv("GIT_CONFIG_GLOBAL", raising=False)
    configs = []

    def fail(args, **kwargs):
        config = Path(kwargs["env"]["GIT_CONFIG_GLOBAL"])
        assert config.is_file()
        configs.append(config)
        if failure == "missing":
            raise FileNotFoundError("git")
        if failure == "timeout":
            raise subprocess.TimeoutExpired(args, 10)
        return subprocess.CompletedProcess(args, 128, b"", b"")

    monkeypatch.setattr(wrapper.subprocess, "run", fail)
    assert wrapper.git_revision(tmp_path, trust_repo=True) is None
    assert len(configs) == 1 and not configs[0].exists()
    assert "GIT_CONFIG_GLOBAL" not in os.environ


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
        "import os,signal,subprocess,sys,time", "from pathlib import Path",
        f"worker=subprocess.Popen([sys.executable,'-c',{grandchild!r}])",
        "def terminate(signum, _frame):",
        "    worker.wait()",
        "    signal.signal(signum, signal.SIG_DFL)",
        "    os.kill(os.getpid(), signum)",
        "signal.signal(signal.SIGTERM, terminate)",
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


def test_eval_records_job_id_without_guessing_timeout_from_signal(tmp_path, monkeypatch):
    monkeypatch.setenv("SLURM_JOB_ID", "98765")
    monkeypatch.setenv("SLURM_TIMELIMIT", "01:00:00")
    assert wrapper.run_eval([sys.executable, "-c", "pass"], trace_root=tmp_path / "traces") == 0
    data = read_record(tmp_path / "traces")
    assert data["job"] == {"scheduler": "slurm", "job_id": "98765", "time_limit_s": 3600}
    assert "state" not in data["job"]


def test_job_end_imports_explicit_accounting_facts(tmp_path):
    root = tmp_path / "traces"
    assert wrapper.run_eval([sys.executable, "-c", "pass"], trace_root=root) == 0
    data = read_record(root)
    assert wrapper.job_end_main(["--trace-root", str(root), "--run-id", data["eval_id"], "--job-id", "98765",
                                 "--state", "TIMEOUT", "--ended-at", "2026-11-20T01:02:03Z",
                                 "--time-limit-s", "3600", "--reason", "time_limit"]) == 0
    updated = read_record(root)
    assert updated["job"] == {"scheduler": "slurm", "job_id": "98765", "state": "TIMEOUT",
                              "ended_at": "2026-11-20T01:02:03Z", "time_limit_s": 3600, "reason": "time_limit"}
    assert updated["end"] == data["end"]
    with pytest.raises(SystemExit):
        wrapper.job_end_main(["--trace-root", str(root), "--run-id", data["eval_id"], "--job-id", "other",
                              "--state", "TIMEOUT", "--ended-at", "2026-11-20T01:02:03Z"])


def test_finalizer_scores_only_explicit_new_closures_and_refuses_symlinks(tmp_path):
    run = tmp_path / 'ev-finalize'
    run.mkdir()
    for name, extras in [('interrupted', {}), ('success', {'harness_summary': {'task_completed': True}}),
                         ('ended', {'episode_end_written': True, 'harness_summary': {'task_completed': False}})]:
        directory = run / name
        directory.mkdir()
        (directory / 'episode.json').write_text(json.dumps({'episode_id': name, **extras}))
    outside = tmp_path / 'outside.json'
    outside.write_text('{"episode_id":"linked"}')
    linked = run / 'linked'
    linked.mkdir()
    (linked / 'episode.json').symlink_to(outside)
    assert wrapper.finalize_trial_outcomes(tmp_path, 'ev-finalize') == 2
    assert json.loads((run / 'interrupted/episode.json').read_text())['trial_outcome']['task_success'] is False
    assert json.loads((run / 'success/episode.json').read_text())['trial_outcome']['task_success'] is True
    assert 'trial_outcome' not in json.loads((run / 'ended/episode.json').read_text())
    assert outside.read_text() == '{"episode_id":"linked"}'
    assert wrapper.finalize_trial_outcomes(tmp_path, 'ev-finalize') == 0


def test_finalizer_preserves_success_from_a_flushed_terminal_event(tmp_path):
    directory = tmp_path / 'ev-event' / 'episode'
    directory.mkdir(parents=True)
    (directory / 'episode.json').write_text(json.dumps({'episode_id': 'episode', 'episode_end_written': False}))
    event = {'event_id': 'end', 'seq': 1, 'event_type': 'episode_end', 'data': {
        'end_reason': 'completed', 'harness_summary': {'task_completed': True, 'sandbox_rc': 0}}}
    (directory / 'events.jsonl').write_text(json.dumps(event) + '\n')
    assert wrapper.finalize_trial_outcomes(tmp_path, 'ev-event') == 1
    outcome = json.loads((directory / 'episode.json').read_text())['trial_outcome']
    assert outcome['task_success'] is True and outcome['resumable'] is False
    assert outcome['reason'] == 'terminal_event_recovered'
