"""Built-in GMO settings and startup failures without network access."""
from __future__ import annotations

import json
import stat
import subprocess

import pytest

from capx_trace_viewer import gmo, server


@pytest.fixture
def config(tmp_path, monkeypatch):
    path = tmp_path / "settings" / "gmo.json"
    monkeypatch.setenv("CAPX_GMO_CONFIG", str(path))
    monkeypatch.delenv("CAPX_GMO_HOST", raising=False)
    monkeypatch.delenv("CAPX_GMO_TRACES", raising=False)
    monkeypatch.delenv("CAPX_GMO_SSH_COMMAND", raising=False)
    return path


def test_defaults_without_file(config):
    assert not config.exists()
    settings = gmo.load_settings()
    assert settings.as_dict() == {
        "host": "gmo", "port": None, "identity_file": None,
        "shared_root": "~/shared-storage/traces", "mine": [], "team": [], "interval_s": 120,
    }
    assert settings.configured
    command = gmo.api_ssh_argv(settings)
    assert command[:5] == ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15"]
    assert "ControlMaster=auto" in command


@pytest.mark.parametrize("overrides", [
    {}, {"mine": ["/data/traces"]}, {"host": "alias", "interval_s": 0}, {"shared_root": ""},
])
def test_existing_file_uses_defaults_only_for_absent_keys(config, overrides):
    config.parent.mkdir()
    config.write_text(json.dumps(overrides))
    assert gmo.load_settings().as_dict() == {**gmo.GmoSettings().as_dict(), **overrides}


def test_explicit_empty_shared_root_disables_shared_listing(config):
    gmo.save_settings(gmo.GmoSettings.from_dict({"shared_root": "", "mine": ["/data/traces"]}))
    settings = gmo.load_settings()
    assert settings.shared_root == "" and settings.mine == ("/data/traces",)
    assert settings.configured
    assert not gmo.GmoSettings.from_dict({"shared_root": ""}).configured


def test_saving_effective_defaults_writes_private_file(config):
    gmo.save_settings(gmo.load_settings())
    assert json.loads(config.read_text()) == gmo.GmoSettings().as_dict()
    assert stat.S_IMODE(config.parent.stat().st_mode) == 0o700
    assert stat.S_IMODE(config.stat().st_mode) == 0o600


@pytest.mark.parametrize("env", [
    {"CAPX_GMO_HOST": "alias"},
    {"CAPX_GMO_TRACES": "/one/traces:/two/traces"},
    {"CAPX_GMO_HOST": "alias", "CAPX_GMO_TRACES": "/one/traces:/two/traces"},
    {"CAPX_GMO_HOST": "", "CAPX_GMO_TRACES": ""},
])
def test_environment_precedes_defaults_only_without_file(config, monkeypatch, env):
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    settings = gmo.load_settings()
    assert settings.host == env.get("CAPX_GMO_HOST", "gmo")
    expected_mine = tuple(p for p in env.get("CAPX_GMO_TRACES", "").split(":") if p)
    assert settings.mine == expected_mine
    assert settings.shared_root == "~/shared-storage/traces"
    config.parent.mkdir()
    config.write_text("{}")
    assert gmo.load_settings() == gmo.GmoSettings()
    config.write_text('{"host":"file-alias","mine":["/file/traces"],"shared_root":""}')
    assert gmo.load_settings() == gmo.GmoSettings(host="file-alias", mine=("/file/traces",), shared_root="")


@pytest.mark.parametrize("path", ["~/shared-storage/traces", "~/", "/data/traces", ""])
def test_shared_root_accepts_home_relative_and_absolute_paths(path):
    assert gmo.GmoSettings.from_dict({"shared_root": path}).shared_root == path


@pytest.mark.parametrize("failure", ["ssh", "timeout", "missing"])
def test_gmo_server_starts_and_serves_local_records_on_connection_failure(config, tmp_path, monkeypatch, capsys, failure):
    episode = tmp_path / "local" / "local_run" / "ep_1"
    episode.mkdir(parents=True)
    (episode.parent / "run.json").write_text("{}")
    (episode / "episode.json").write_text('{"status":"ended","trace_complete":true}')
    calls = []

    def failed(command, *, timeout):
        calls.append(command)
        assert command[-2] == "gmo"
        if failure == "timeout":
            raise gmo.FetchError("GMO operation timed out")
        if failure == "missing":
            raise FileNotFoundError("ssh")
        return subprocess.CompletedProcess(command, 255, "", "connection failed")

    def serve(app, **kwargs):
        def endpoints(routes):
            for route in routes:
                if getattr(route, "path", None) == "/api/traces/runs":
                    yield route.endpoint
                nested = getattr(route, "original_router", None)
                if nested is not None:
                    yield from endpoints(nested.routes)

        service = app.state.gmo_service
        try:
            service.start_auto()
            runs = next(endpoints(app.routes))
            response = runs()
            assert response.status_code == 200
            assert json.loads(response.body)["runs"][0]["run_id"] == "local_run"
            assert service.auto_status()["enabled"] is True
        finally:
            service.close()

    monkeypatch.setattr(gmo.ProcessRunner, "run", staticmethod(failed))
    monkeypatch.setattr(server.uvicorn, "run", serve)
    monkeypatch.delenv("SLURM_JOB_ID", raising=False)
    server.main(["--gmo", "--trace-root", str(tmp_path / "local")])
    assert len(calls) == 1
    err = capsys.readouterr().err
    assert "Host gmo" in err and "接続設定" in err and "Traceback" not in err
