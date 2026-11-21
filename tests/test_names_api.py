"""Private display names reach each site's pages through existing listing caches."""
from __future__ import annotations

import json
import threading

import pytest
from fastapi.testclient import TestClient

from capx_trace_viewer import gmo
from capx_trace_viewer.server import Site, create_app
from test_eval_api import record, write_record
from test_eval_remote_cache import eval_row
from trace_viewer_testlib import raw_get

BASE = "http://127.0.0.1:8290"
READ = {"X-CapX-Request": "gmo"}
ACCOUNT = "user_00099_test"


@pytest.mark.parametrize("kind", ["valid", "missing", "invalid", "oversize", "symlink"])
def test_local_evaluation_names_are_optional_and_read_on_each_response(tmp_path, kind):
    value = record("ev-names")
    value["by"] = ACCOUNT
    write_record(tmp_path, value)
    names = tmp_path / "names.json"
    payload = json.dumps({f" {ACCOUNT} ": " 山田太郎 "}, ensure_ascii=False)
    expected = {ACCOUNT: "山田太郎"} if kind == "valid" else {}
    if kind == "symlink":
        target = tmp_path / "private.json"
        target.write_text(payload, encoding="utf-8")
        names.symlink_to(target)
    elif kind != "missing":
        names.write_text(payload if kind == "valid" else "{" if kind == "invalid"
                         else " " * (64 * 1024 + 1), encoding="utf-8")
    app = create_app(trace_root=tmp_path, frontend_dist=tmp_path / "missing-dist")
    client = TestClient(app, client=("127.0.0.1", 41000), base_url=BASE)
    for path in ("/api/evals", "/api/evals/ev-names"):
        response = client.get(path)
        assert response.status_code == 200
        assert response.json()["names"] == expected
    if kind == "valid":
        names.write_text(json.dumps({ACCOUNT: "架空花子"}), encoding="utf-8")
        assert client.get("/api/evals").json()["names"] == {ACCOUNT: "架空花子"}
        assert client.get("/api/evals/ev-names").json()["eval"]["by"] == ACCOUNT


def test_remote_names_follow_site_caches_and_keep_existing_episode_shape(tmp_path, monkeypatch):
    roots = [tmp_path / "b300", tmp_path / "rtx"]
    configs = [tmp_path / "config" / f"site-{i}.json" for i in range(2)]
    values = []
    calls = []
    for i, (root, config) in enumerate(zip(roots, configs)):
        value = record(f"ev-names-{i}")
        value["by"] = ACCOUNT
        values.append(value)
        write_record(root, value)
        (root / "names.json").write_text(json.dumps({"local_test": "架空花子", ACCOUNT: "手元の仮名"}))
        gmo.save_settings(gmo.GmoSettings(host=f"fake-site-{i}", shared_root=f"/fake/{i}",
                                        submission_root="", interval_s=0), config)

    def listing(runner, settings, **kwargs):
        calls.append(settings.host)
        i = int(settings.host[-1])
        return {"episodes": [], "evals": [eval_row(values[i])],
                "names": {f" {ACCOUNT} ": ["山田太郎", "架空花子"][i], "invalid_test": 123}}

    monkeypatch.setenv("CAPX_GMO_CONFIG", str(configs[0]))
    monkeypatch.setattr(gmo, "list_remote_evals", listing)
    monkeypatch.setattr(gmo, "list_remote_episodes", listing)
    app = create_app(trace_root=roots[0], gmo=True, frontend_dist=tmp_path / "missing-dist",
                     sites=[Site("rtx", "RTX", configs[1], roots[1])])
    client = TestClient(app, client=("127.0.0.1", 41000), base_url=BASE, headers=READ)
    try:
        for i, (site, prefix) in enumerate((("b300", "/api"), ("rtx", "/api/sites/rtx"))):
            service = app.state.gmo_services[site]
            service.remote_listing(wait=True)
            service.remote_eval_listing(wait=True)
            service._remote_snapshot(kind="run", run_ids=(values[i]["eval_id"],), wait=True)
            before = list(calls)
            expected = {"local_test": "架空花子", ACCOUNT: ["山田太郎", "架空花子"][i]}
            for path in (f"{prefix}/evals", f"{prefix}/evals/ev-names-{i}"):
                assert client.get(path).json()["names"] == expected
            assert client.get(f"{prefix}/gmo/episodes").json() == []
            for _ in range(2):
                response = client.get(f"{prefix}/gmo/names")
                assert response.status_code == 200
                assert response.json() == expected
                assert response.headers["cache-control"] == "no-store"
            assert calls == before, "Names must reuse the cached discovery without an extra remote call"
            assert client.get(f"{prefix}/gmo/names", headers={"X-CapX-Request": ""}).status_code == 403
            for headers in ([('host', 'attacker.example'), ('x-capx-request', 'gmo')],
                            [('host', '127.0.0.1:8290'), ('x-capx-request', 'gmo'),
                             ('origin', 'https://attacker.example')]):
                assert raw_get(app, f"{prefix}/gmo/names",
                               headers=[(key.encode(), item.encode()) for key, item in headers])[0] == 403
    finally:
        for service in app.state.gmo_services.values():
            service.close()


def test_cold_names_request_does_not_wait_for_remote_scan(tmp_path, monkeypatch):
    config = tmp_path / "config" / "gmo.json"
    gmo.save_settings(gmo.GmoSettings(host="fake-site", shared_root="/fake", interval_s=0), config)
    monkeypatch.setenv("CAPX_GMO_CONFIG", str(config))
    entered, release = threading.Event(), threading.Event()

    def blocked(*args, **kwargs):
        entered.set()
        assert release.wait(3)
        return {"episodes": [], "evals": [], "names": {ACCOUNT: "山田太郎"}}

    monkeypatch.setattr(gmo, "list_remote_episodes", blocked)
    app = create_app(trace_root=tmp_path / "traces", gmo=True, frontend_dist=tmp_path / "missing-dist")
    client = TestClient(app, client=("127.0.0.1", 41000), base_url=BASE, headers=READ)
    try:
        response = client.get("/api/gmo/names")
        assert response.status_code == 200
        assert response.json() == {}
        assert entered.wait(1)
    finally:
        release.set()
        app.state.gmo_service.close()
