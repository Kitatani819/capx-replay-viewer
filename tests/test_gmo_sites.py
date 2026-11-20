"""Independent GMO settings, discovery caches and prefetched sites."""
from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from capx_trace_viewer import gmo
from capx_trace_viewer.gmo_api import GmoService, create_gmo_router

BASE = "http://127.0.0.1:8290"
READ = {"X-CapX-Request": "gmo"}
WRITE = {**READ, "Origin": BASE}


def _settings(path: Path, remote: Path, host: str) -> gmo.GmoSettings:
    settings = gmo.GmoSettings(host=host, mine=(str(remote),), shared_root="", interval_s=0)
    gmo.save_settings(settings, path)
    return settings


def _episode(root: Path, run: str) -> None:
    episode = root / run / "trial"
    episode.mkdir(parents=True)
    (episode.parent / "run.json").write_text('{}\n')
    (episode / "episode.json").write_text('{"status":"ended","trace_complete":true}\n')
    (episode / "events.jsonl").write_text('{"seq":1}\n')


def test_explicit_services_discover_and_save_only_their_config(tmp_path, monkeypatch):
    fake_ssh = tmp_path / "fake_ssh"
    fake_ssh.write_text('#!/bin/sh\nshift\nexec sh -c "$*"\n')
    fake_ssh.chmod(0o700)
    monkeypatch.setenv("CAPX_GMO_SSH_COMMAND", str(fake_ssh))
    # A global settings lookup would fail, rather than accidentally passing.
    global_config = tmp_path / "global.json"
    global_config.write_text("invalid JSON")
    monkeypatch.setenv("CAPX_GMO_CONFIG", str(global_config))
    configs = [tmp_path / "config" / name for name in ("gmo.json", "rtx.json")]
    roots = [tmp_path / "remote-a", tmp_path / "remote-b"]
    for root, run in zip(roots, ("run-a", "run-b")):
        _episode(root, run)
    settings = [_settings(config, root, host) for config, root, host in
                zip(configs, roots, ("fake-a", "fake-b"))]
    services = [GmoService(tmp_path / f"dest-{i}", config) for i, config in enumerate(configs)]
    app = FastAPI()
    for service, prefix in zip(services, ("/api/gmo", "/api/sites/rtx/gmo")):
        app.include_router(create_gmo_router(service, prefix=prefix))
    try:
        assert [service.load_settings() for service in services] == settings
        assert [service.auto_status()["enabled"] for service in services] == [False, False]
        assert [[row["run_id"] for row in service.remote_rows(refresh=True)]
                for service in services] == [["run-a"], ["run-b"]]
        client = TestClient(app, client=("127.0.0.1", 41000), base_url=BASE, headers=READ)
        assert client.get("/api/sites/rtx/gmo/config").json()["config_path"] == str(configs[1])
        updated = replace(settings[1], host="updated-b")
        response = client.put("/api/sites/rtx/gmo/config", json=updated.as_dict(), headers=WRITE)
        assert response.status_code == 200
        assert services[0].load_settings() == settings[0]
        assert services[1].load_settings() == updated
        assert json.loads(configs[0].read_text()) == settings[0].as_dict()
        assert global_config.read_text() == "invalid JSON"
    finally:
        for service in services:
            service.close()


def test_configs_in_same_directory_have_separate_persistent_cache(tmp_path):
    configs = [tmp_path / "config" / name for name in ("gmo.json", "rtx.json")]
    same_settings = gmo.GmoSettings(host="fake", mine=("/remote",), shared_root="", interval_s=0)
    for config in configs:
        gmo.save_settings(same_settings, config)
    services = [GmoService(tmp_path / f"dest-{i}", config) for i, config in enumerate(configs)]
    restarted = None
    try:
        cache_a, cache_b = [service._listings for service in services]
        assert cache_a.cache_dir != cache_b.cache_dir
        assert cache_a.cache_dir.parent == cache_b.cache_dir.parent
        key = services[0]._listing_key(same_settings, "episodes")
        cache_a.snapshot(key, lambda _: {"episodes": [], "evals": []}, wait=True)
        assert cache_a.status(key)["fetched_at"] is not None
        assert cache_b.status(key)["fetched_at"] is None
        assert not cache_b.cache_dir.exists()
        restarted = GmoService(tmp_path / "dest-restarted", configs[0])
        assert restarted._listings.status(key)["fetched_at"] is not None
    finally:
        for service in services:
            service.close()
        if restarted is not None:
            restarted.close()


def test_prefetch_mine_uses_explicit_config(tmp_path, monkeypatch):
    config = tmp_path / "rtx.json"
    expected = _settings(config, tmp_path / "remote", "fake-rtx")
    global_config = tmp_path / "global.json"
    global_config.write_text("invalid JSON")
    monkeypatch.setenv("CAPX_GMO_CONFIG", str(global_config))
    seen = []

    def list_episodes(runner, settings, **kwargs):
        seen.append(settings)
        return {"episodes": []}

    monkeypatch.setattr(gmo, "list_remote_episodes", list_episodes)
    assert gmo.prefetch_mine(tmp_path / "dest", config_path=config) == 0
    assert seen == [expected]
