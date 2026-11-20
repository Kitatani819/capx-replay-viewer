"""Multiple sites preserve the primary API and isolate remote/local records."""
from __future__ import annotations

import argparse
from dataclasses import replace
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from capx_trace_viewer import gmo, server
from capx_trace_viewer.server import Site, create_app, parse_site
from test_eval_api import record, write_record
from test_gmo_sites import _episode, _settings
from trace_viewer_testlib import raw_get

BASE = "http://127.0.0.1:8290"
READ = {"X-CapX-Request": "gmo"}
WRITE = {**READ, "Origin": BASE}


@pytest.fixture
def two_sites(tmp_path, monkeypatch):
    transport = tmp_path / "fake_ssh"
    transport.write_text('#!/bin/sh\nshift\nexec sh -c "$*"\n')
    transport.chmod(0o700)
    monkeypatch.setenv("CAPX_GMO_SSH_COMMAND", str(transport))
    configs = [tmp_path / "config" / name for name in ("gmo.json", "rtx.json")]
    roots = [tmp_path / name / "traces" for name in ("b300", "rtx")]
    for i, (config, root) in enumerate(zip(configs, roots)):
        remote = tmp_path / f"remote-{i}"
        _episode(remote, f"remote-{i}")
        write_record(remote, record(f"ev-remote-{i}"))
        _settings(config, remote, f"fake-{i}")
        _episode(root, f"local-{i}")
        write_record(root, record(f"ev-local-{i}"))
    monkeypatch.setenv("CAPX_GMO_CONFIG", str(configs[0]))
    app = create_app(trace_root=roots[0], gmo=True, frontend_dist=tmp_path / "no-dist",
                     sites=[Site("rtx", "RTX", configs[1], roots[1])])
    try:
        yield app, configs, roots
    finally:
        for service in app.state.gmo_services.values():
            service.close()


def test_site_discovery_and_local_remote_routes_are_isolated(two_sites):
    app, configs, roots = two_sites
    client = TestClient(app, client=("127.0.0.1", 41000), base_url=BASE, headers=READ)
    assert client.get("/api/sites").json() == [
        {"name": "b300", "label": "B300", "primary": True},
        {"name": "rtx", "label": "RTX", "primary": False},
    ]
    for i, (name, prefix) in enumerate((("b300", "/api"), ("rtx", "/api/sites/rtx"))):
        service = app.state.gmo_services[name]
        assert service.dest == roots[i]
        assert service.config_path == configs[i]
        service.remote_eval_listing(wait=True)
        assert [row["run_id"] for row in service.remote_rows()] == [f"remote-{i}"]
        runs = client.get(f"{prefix}/traces/runs").json()["runs"]
        assert f"local-{i}" in [run["run_id"] for run in runs]
        assert f"local-{1-i}" not in [run["run_id"] for run in runs]
        assert client.get(f"{prefix}/traces/runs/local-{1-i}").status_code == 404
        assert client.get(f"{prefix}/traces/runs/local-{i}/episodes/trial/file/events.jsonl").text == '{"seq":1}\n'
        listing = client.get(f"{prefix}/evals").json()["evals"]
        assert {entry["eval_id"] for entry in listing} == {f"ev-local-{i}", f"ev-remote-{i}"}
        assert client.get(f"{prefix}/evals/ev-local-{i}").status_code == 200
        assert client.get(f"{prefix}/evals/ev-local-{1-i}").status_code == 404


def test_site_b_config_writes_leave_primary_and_cache_untouched(two_sites):
    app, configs, _roots = two_sites
    client = TestClient(app, client=("127.0.0.1", 41000), base_url=BASE, headers=READ)
    original = configs[0].read_bytes()
    a, b = app.state.gmo_services.values()
    a.remote_rows()
    b.remote_rows()
    assert a._listings.cache_dir != b._listings.cache_dir
    primary_cache = {p: p.read_bytes() for p in a._listings.cache_dir.glob("*.json")}
    updated = replace(b.load_settings(), host="updated-site")
    response = client.put("/api/sites/rtx/gmo/config", json=updated.as_dict(), headers=WRITE)
    assert response.status_code == 200
    assert configs[0].read_bytes() == original
    assert gmo.load_settings(configs[1]) == updated
    assert primary_cache and all(p.read_bytes() == value for p, value in primary_cache.items())


@pytest.mark.parametrize("path", ["/api/sites", "/api/sites/rtx/traces/runs", "/api/sites/rtx/evals", "/api/sites/rtx/gmo/config"])
def test_every_site_prefix_keeps_loopback_host_origin_gates(two_sites, path):
    app, _configs, _roots = two_sites
    headers = [(b"host", b"127.0.0.1:8290"), (b"x-capx-request", b"gmo")]
    assert raw_get(app, path, client=("192.0.2.1", 41000), headers=headers)[0] == 403
    assert raw_get(app, path, headers=[(b"host", b"attacker.example"), (b"x-capx-request", b"gmo")])[0] == 403
    assert raw_get(app, path, headers=[*headers, (b"origin", b"https://attacker.example")])[0] == 403


def test_prefixed_gmo_requires_marker_and_write_origin(two_sites):
    app, configs, _roots = two_sites
    client = TestClient(app, client=("127.0.0.1", 41000), base_url=BASE)
    url = "/api/sites/rtx/gmo/config"
    assert client.get(url).status_code == 403
    payload = gmo.load_settings(configs[1]).as_dict()
    assert client.put(url, json=payload, headers=READ).status_code == 403
    assert client.put(url, json=payload, headers={**READ, "Origin": "null"}).status_code == 403
    assert client.put(url, json=payload, headers=WRITE).status_code == 200
    for prefix in ("/api/gmo", "/api/sites/rtx/gmo"):
        assert client.get(f"{prefix}/unknown").status_code == 404
        assert client.get(f"{prefix}/unknown").headers["content-type"].startswith("application/json")


def test_single_site_and_disabled_gmo_keep_existing_paths(tmp_path):
    app = create_app(trace_root=tmp_path, frontend_dist=tmp_path / "missing")
    client = TestClient(app, client=("127.0.0.1", 41000), base_url=BASE)
    assert client.get("/api/sites").json() == [{"name": "b300", "label": "B300", "primary": True}]
    assert client.get("/api/traces/config").status_code == 200
    for path in ("/api/gmo", "/api/gmo/config", "/api/sites/unknown/gmo/config"):
        assert client.get(path).status_code == 404
        assert client.get(path).headers["content-type"].startswith("application/json")


def test_site_parsing_and_repeated_cli_prefetch(tmp_path, monkeypatch):
    spec = f"rtx=RTX,{tmp_path}/rtx.json,{tmp_path}/rtx/traces"
    assert parse_site(spec) == Site("rtx", "RTX", tmp_path / "rtx.json", tmp_path / "rtx/traces")
    seen, served = [], []
    monkeypatch.setenv("CAPX_GMO_CONFIG", str(tmp_path / "gmo.json"))
    monkeypatch.setattr(gmo, "prefetch_mine", lambda dest, config_path=None: seen.append((dest, config_path)))
    monkeypatch.setattr(server.uvicorn, "run", lambda app, **kwargs: served.append(app))
    server.main(["--gmo", "--trace-root", str(tmp_path / "primary"), "--site", spec,
                 "--site", f"other=Other,{tmp_path}/other.json,{tmp_path}/other"])
    assert seen == [(tmp_path / "primary", tmp_path / "gmo.json"),
                    (tmp_path / "rtx/traces", tmp_path / "rtx.json"),
                    (tmp_path / "other", tmp_path / "other.json")]
    assert len(served) == 1
    for service in served[0].state.gmo_services.values():
        service.close()


def test_additional_site_without_gmo_does_not_prefetch(tmp_path, monkeypatch):
    seen, served = [], []
    monkeypatch.setattr(gmo, "prefetch_mine", lambda *args, **kwargs: seen.append(args))
    monkeypatch.setattr(server.uvicorn, "run", lambda app, **kwargs: served.append(app))
    server.main(["--site", f"rtx=RTX,{tmp_path}/rtx.json,{tmp_path}/traces"])
    assert seen == []
    assert set(served[0].state.gmo_services) == {"rtx"}
    served[0].state.gmo_services["rtx"].close()


@pytest.mark.parametrize("spec", ["rtx", "RTX=RTX,/c,/t", "a/b=RTX,/c,/t", "a" * 33 + "=RTX,/c,/t",
                                  "rtx=,/c,/t", "rtx=RTX,,/t", "rtx=RTX,/c,"])
def test_invalid_site_spec_is_rejected(spec):
    with pytest.raises(argparse.ArgumentTypeError):
        parse_site(spec)


@pytest.mark.parametrize("names", [("b300",), ("rtx", "rtx")])
def test_cli_rejects_duplicate_sites_before_starting(names):
    args = [part for name in names for part in ("--site", f"{name}=Label,/config,/traces")]
    with pytest.raises(SystemExit) as error:
        server.main(args)
    assert error.value.code == 2
