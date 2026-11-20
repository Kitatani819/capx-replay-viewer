"""Launcher argument forwarding with no real viewer or SSH connection."""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def launcher(tmp_path):
    project = tmp_path / "viewer"
    (project / "scripts").mkdir(parents=True)
    shutil.copyfile(REPO_ROOT / "Start-Replay.sh", project / "Start-Replay.sh")
    (project / "scripts" / "serve_replay.sh").write_text(
        '#!/usr/bin/env bash\nprintf "%s\\0" "$@"\n', encoding="utf-8")
    commands = tmp_path / "bin"
    commands.mkdir()
    uname = commands / "uname"
    uname.write_text('#!/usr/bin/env bash\nprintf "%s\\n" "$TEST_OS"\n', encoding="utf-8")
    uname.chmod(0o755)
    env = {"HOME": str(tmp_path / "home"), "XDG_CONFIG_HOME": str(tmp_path / "config"),
           "CAPX_GMO_CONFIG": str(tmp_path / "other" / "gmo.json"),
           "PATH": f"{commands}:{os.environ['PATH']}", "TEST_OS": "Linux"}
    return project, env


def run_launcher(project, env, *args):
    return subprocess.run(["bash", str(project / "Start-Replay.sh"), *args],
                          env=env, capture_output=True, text=True, timeout=30)


def forwarded(result):
    assert result.returncode == 0, result.stderr
    return result.stdout.split("\0")[:-1]


def test_help_describes_rtx():
    result = subprocess.run(["bash", str(REPO_ROOT / "Start-Replay.sh"), "--help"],
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 0
    assert "--rtx [CONFIG]" in result.stdout and "--from-gmo" in result.stdout


@pytest.mark.parametrize("system", ["Linux", "Darwin"])
def test_rtx_default_settings_are_platform_specific_and_ignore_primary_override(launcher, system):
    project, env = launcher
    env["TEST_OS"] = system
    base = (Path(env["HOME"]) / "Library" / "Application Support" if system == "Darwin"
            else Path(env["XDG_CONFIG_HOME"]))
    config = base / "capx-geniac-replay" / "rtx.json"
    config.parent.mkdir(parents=True)
    config.write_text("{}", encoding="utf-8")
    args = forwarded(run_launcher(project, env, "--from-gmo", "--rtx", "--port", "8392"))
    assert args == ["8392", str(project / "outputs/gmo/traces"), str(project / "outputs/gmo/runner"),
                    "", "1", "", str(config)]


def test_rtx_default_uses_home_when_xdg_is_empty(launcher):
    project, env = launcher
    env["XDG_CONFIG_HOME"] = ""
    config = Path(env["HOME"]) / ".config" / "capx-geniac-replay" / "rtx.json"
    config.parent.mkdir(parents=True)
    config.write_text("{}", encoding="utf-8")
    assert forwarded(run_launcher(project, env, "--rtx"))[-1] == str(config)


def test_rtx_explicit_relative_config_preserves_existing_options(launcher):
    project, env = launcher
    config = project / "settings" / "rtx config.json"
    config.parent.mkdir()
    config.write_text("{}", encoding="utf-8")
    args = forwarded(run_launcher(project, env, "--rtx", "settings/rtx config.json", "--from-gmo",
                                  "--trace-root", "custom/traces", "--runner-root", "custom/runner",
                                  "--python", "env/bin/python", "--uds", "private/viewer.sock"))
    assert args == ["8390", "custom/traces", "custom/runner", "env/bin/python", "1",
                    "private/viewer.sock", str(config)]


def test_missing_rtx_config_warns_and_keeps_primary(launcher):
    project, env = launcher
    result = run_launcher(project, env, "--from-gmo", "--rtx", "missing.json")
    assert forwarded(result)[4:] == ["1", "", ""]
    assert "RTX config not found:" in result.stderr
    assert "Starting without the RTX site" in result.stderr


def test_rtx_expands_quoted_home_path(launcher):
    project, env = launcher
    config = Path(env["HOME"]) / "settings" / "rtx.json"
    config.parent.mkdir(parents=True)
    config.write_text("{}", encoding="utf-8")
    assert forwarded(run_launcher(project, env, "--rtx", "~/settings/rtx.json"))[-1] == str(config)


def test_serve_passes_rtx_site_to_server(tmp_path):
    project = tmp_path / "viewer"
    (project / "scripts").mkdir(parents=True)
    (project / "web-ui" / "dist").mkdir(parents=True)
    (project / "web-ui" / "dist" / "index.html").write_text("viewer", encoding="utf-8")
    shutil.copyfile(REPO_ROOT / "scripts" / "serve_replay.sh", project / "scripts" / "serve_replay.sh")
    fake_python = tmp_path / "python"
    # No dependency installation, filesystem probing or server runs in this test.
    fake_python.write_text(
        '#!/usr/bin/env bash\n'
        'if [[ "$1" == "-m" ]]; then printf "%s\\0" "$@"; fi\n', encoding="utf-8")
    fake_python.chmod(0o755)
    config = tmp_path / "settings" / "rtx.json"
    result = subprocess.run(["bash", str(project / "scripts" / "serve_replay.sh"), "8393",
                             "outputs/gmo/traces", "outputs/gmo/runner", str(fake_python),
                             "1", "", str(config)], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    args = result.stdout.split("\n", 1)[1].rstrip("\0").split("\0")
    assert args[:2] == ["-m", "capx_trace_viewer.server"]
    assert "--gmo" in args
    assert args[-2:] == ["--site", f"rtx=RTX,{config},{project}/outputs/rtx/traces"]
