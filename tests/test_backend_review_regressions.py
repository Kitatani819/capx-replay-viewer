"""Regression coverage for interactive discovery and legacy trial metadata."""
from __future__ import annotations

import json
import threading

from fastapi.testclient import TestClient

from capx_trace_viewer import gmo, reader, trace_api
from capx_trace_viewer.gmo_api import GmoService
from capx_trace_viewer.server import create_app
from test_eval_remote_cache import episode_row


def test_run_discovery_does_not_wait_for_team_listing(tmp_path, monkeypatch):
    settings = gmo.GmoSettings(host="test-transport", mine=("/traces",), shared_root="", interval_s=0)
    monkeypatch.setattr(gmo, "load_settings", lambda *args: settings)
    entered, release, discovered = threading.Event(), threading.Event(), threading.Event()

    def remote(runner, settings, **kwargs):
        if not kwargs.get("run_ids"):
            entered.set()
            assert release.wait(5)
        return {"episodes": [episode_row("evaluation")], "evals": []}

    monkeypatch.setattr(gmo, "list_remote_episodes", remote)
    service = GmoService(tmp_path / "traces", config_path=tmp_path / "config" / "gmo.json")
    result, errors = [], []

    def request():
        try:
            result.append(service.episode("evaluation", "trial"))
        except Exception as exc:
            errors.append(exc)
        finally:
            discovered.set()

    caller = threading.Thread(target=request, daemon=True)
    try:
        service.remote_listing(wait=False)
        assert entered.wait(1)
        caller.start()
        assert discovered.wait(1), "Per-run discovery queued behind the team scan"
        assert not errors
        assert result[0]["episode_id"] == "trial"
        assert service.listing_status()["refreshing"] is True
    finally:
        release.set()
        if caller.ident is not None:
            caller.join(2)
        service.close()


def test_legacy_fixed_metadata_survives_asset_listing_limit(tmp_path):
    runner = tmp_path / "runner"
    trial = runner / "run" / "task" / "condition" / "trial_01"
    trial.mkdir(parents=True)
    (runner / "run" / "run.json").write_text("{}")
    for index in range(trace_api.MAX_LEGACY_FILES):
        (trial / f"asset_{index:04d}.txt").write_text("asset")
    (trial / "code.py").write_text("print('trial')")
    (trial / "summary.txt").write_text(
        "Environment response:\n  Stdout: done\n  Stderr: \n  Reward: 1.0\n  Task Completed: True\n")
    (trial / "trial_record.json").write_text(json.dumps({"sandbox_rc": 0}))
    app = create_app(viewer_only=True, trace_root=tmp_path / "traces", runner_roots=[runner],
                     frontend_dist=tmp_path / "no-dist")
    with TestClient(app, client=("127.0.0.1", 40001), base_url="http://127.0.0.1:8290") as client:
        response = client.get("/api/traces/legacy/trials/run/task/condition/trial_01")
    assert response.status_code == 200
    body = response.json()
    assert body["code"]["text"] == "print('trial')"
    assert body["summary"]["task_completed"] is True
    assert body["trial_record"]["sandbox_rc"] == 0
    assert body["files_truncated"] is True
    assert len(body["other_files"]) == trace_api.MAX_LEGACY_FILES


def test_oversized_event_line_returns_explicit_http_error(tmp_path, monkeypatch):
    root = tmp_path / "traces"
    episode = root / "run" / "episode"
    episode.mkdir(parents=True)
    (episode / "episode.json").write_text('{"status":"ended","trace_complete":true}')
    (episode / "events.jsonl").write_bytes(b'{"pad":"' + b"x" * 30_000)
    monkeypatch.setattr(reader, "MAX_LINE_BYTES", 1000)
    monkeypatch.setattr(reader, "MAX_LINE_SCAN_BYTES", 4096)
    monkeypatch.setattr(reader, "GENERATION_LINE_BYTES", 1000)
    monkeypatch.setattr(reader, "_SCAN_CHUNK", 256)
    app = create_app(viewer_only=True, trace_root=root, frontend_dist=tmp_path / "no-dist")
    with TestClient(app, client=("127.0.0.1", 40001), base_url="http://127.0.0.1:8290") as client:
        response = client.get("/api/traces/runs/run/episodes/episode/events", params={"max_bytes": 100})
    assert response.status_code == 413
    assert "line" in response.json()["detail"]
