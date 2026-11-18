"""The optional synthetic evaluations include an inspectable regression and retry."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

from capx_trace_viewer.eval_api import EvalService
from trace_viewer_testlib import load_demo_module


def test_optional_evals_preserve_default_demo_and_add_comparison(tmp_path):
    load_demo_module()
    script = Path(__file__).resolve().parents[1] / "scripts" / "make_replay_demo.py"
    spec = importlib.util.spec_from_file_location("make_replay_demo", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    root = tmp_path / "demo"
    manifest = module.build(root)
    assert set(manifest) == {"run", "episode", "events", "video_frames", "legacy"}
    assert not list((root / "traces").glob("*/eval.json"))
    original = (root / "manifest.json").read_bytes()
    created = module.build_evals(root, manifest, 1_795_000_000)
    assert (root / "manifest.json").read_bytes() == original
    service = EvalService(root / "traces")
    comparison = service.detail(created["improved"])
    assert comparison["baseline"]["eval_id"] == created["baseline"]
    regressions = []
    for trial in comparison["trials"]:
        previous = next(t for t in comparison["baseline_trials"] if t["task"] == trial["task"] and t["seed"] == trial["seed"])
        if trial["verdict"] == "failure" and previous["verdict"] == "success":
            regressions.append(trial)
    assert [t["episode_id"] for t in regressions] == [created["regression_episode"]]
    retries = [t for t in comparison["trials"] if t["task"] == "cube_lifting" and t["seed"] == 402]
    assert [(t["attempt"], t["verdict"]) for t in retries] == [(1, "failure"), (2, "success")]
    assert comparison["summary"]["success"] > comparison["baseline_summary"]["success"]
    assert comparison["differences"] == [{"field": "config_flags",
        "baseline": {"multi_turn": True, "use_parallel_ensemble": False},
        "current": {"multi_turn": True, "use_parallel_ensemble": True}}]
    for row in service.listing()["evals"]:
        assert row["error"] is None
        assert row["eval"]["summary"]["models"] == {"code_generator": "synthetic-same-model"}
        assert "endpoint" not in json.dumps(row["eval"])
