"""Same-code reruns require positive recorded evidence of equivalent conditions."""
from copy import deepcopy

import pytest

from capx_trace_viewer import repeat_reference
from capx_trace_viewer.eval_api import EvalService
from test_eval_api import record, write_record


def metadata():
    return {"status": "ended", "trace_complete": True, "task": "cube", "condition": "C", "seed": 401,
            "stop_context": {"step_limit": 1500, "success_policy": "per_cycle_sticky", "evaluation_budget_s": 600,
                             "trial_time_limit_s": 0, "trial_attempt_limit": 1, "steps_used": 100,
                             "evaluation_elapsed_s": 50},
            "env": {"class": "synthetic.Env", "low_level_class": "synthetic.Low", "viser_port": 9999},
            "models": {"code_generator": {"model": "synthetic-model", "endpoint": "http://127.0.0.1:9"}},
            "config_flags": {"multi_turn": True},
            "harness_summary": {"task_completed": True}, "end_reason": "completed"}


def summary(raw):
    return {**raw, "episode": raw}


def valid_record(eval_id):
    value = record(eval_id)
    value["git"] = {"commit": "a" * 40, "dirty": False, "diff_sha256": None}
    value["summary"].update(trials=1, success=1, failure=0, models={"code_generator": "synthetic-model"},
                            config_flags={"multi_turn": True})
    return value


def test_usage_and_transport_facts_do_not_change_effective_conditions():
    first = metadata()
    second = deepcopy(first)
    second["stop_context"].update(steps_used=1499, evaluation_elapsed_s=550, job={"job_id": "1234"})
    second["env"]["viser_port"] = 9998
    second["models"]["code_generator"]["endpoint"] = "http://127.0.0.1:8"
    assert repeat_reference.episode_settings([summary(first)]) == repeat_reference.episode_settings([summary(second)])


@pytest.mark.parametrize("field,value", [("step_limit", 8000), ("success_policy", "block_end"),
                                         ("evaluation_budget_s", 300), ("trial_attempt_limit", 3)])
def test_changed_effective_limit_is_not_a_repeat(field, value):
    first = metadata()
    second = deepcopy(first)
    second["stop_context"][field] = value
    assert repeat_reference.episode_settings([summary(first)]) != repeat_reference.episode_settings([summary(second)])


@pytest.mark.parametrize("damage", ["policy", "budget", "env", "condition", "seed", "incomplete", "models", "duplicate"])
def test_missing_or_ambiguous_trial_settings_refuse_repeat_identity(damage):
    raw = metadata()
    if damage in ("policy", "budget"):
        raw["stop_context"].pop("success_policy" if damage == "policy" else "evaluation_budget_s")
    elif damage == "env":
        raw.pop("env")
    elif damage in ("condition", "seed"):
        raw[damage] = [] if damage == "condition" else None
    elif damage == "incomplete":
        raw["trace_complete"] = False
    elif damage == "models":
        raw["models"] = {}
    episodes = [summary(raw)] * (2 if damage == "duplicate" else 1)
    assert repeat_reference.episode_settings(episodes) is None


@pytest.mark.parametrize("damage", ["git", "dirty", "dirty_hashed", "diff", "mixed", "incomplete", "unknown", "running", "model", "flags"])
def test_record_identity_requires_known_code_and_unmixed_settings(damage):
    value = valid_record("ev-one")
    if damage == "git":
        value["git"] = None
    elif damage == "dirty":
        value["git"]["dirty"] = None
    elif damage == "dirty_hashed":
        value["git"].update(dirty=True, diff_sha256="b" * 64)
    elif damage == "diff":
        value["git"]["dirty"] = True
    elif damage in ("mixed", "incomplete", "unknown"):
        value["summary"][damage] = ["config_flags"] if damage == "mixed" else 1
    elif damage == "running":
        value["status"] = "running"
    else:
        value["summary"]["models" if damage == "model" else "config_flags"] = {}
    assert repeat_reference.record_key(value) is None


def test_api_discovers_latest_matching_repeat_and_excludes_incomplete_imports(tmp_path):
    import json
    for index, eval_id in enumerate(("ev-original", "ev-repeat", "ev-wrong-budget", "ev-missing-episode")):
        value = valid_record(eval_id)
        value["started_at"] = f"2026-11-18T09:0{index}:00Z"
        run = write_record(tmp_path, value)
        if eval_id == "ev-missing-episode":
            continue
        raw = metadata()
        if eval_id == "ev-wrong-budget":
            raw["stop_context"]["evaluation_budget_s"] = 300
        directory = run / "trial"
        directory.mkdir()
        (directory / "episode.json").write_text(json.dumps(raw), encoding="utf-8")
    references = EvalService(tmp_path).detail("ev-original")["repeat_references"]
    assert len(references) == 1
    assert references[0]["side"] == "current"
    assert references[0]["eval"]["eval_id"] == "ev-repeat"
    assert references[0]["trials"][0]["verdict"] == "success"


def test_selected_same_code_baseline_itself_is_a_repeat_reference(tmp_path):
    import json
    for eval_id in ("ev-base", "ev-current"):
        value = valid_record(eval_id)
        if eval_id == "ev-current":
            value["baseline_eval_id"] = "ev-base"
        run = write_record(tmp_path, value)
        directory = run / "trial"
        directory.mkdir()
        (directory / "episode.json").write_text(json.dumps(metadata()), encoding="utf-8")
    references = EvalService(tmp_path).detail("ev-current")["repeat_references"]
    assert [(item["side"], item["eval"]["eval_id"]) for item in references] == [("current", "ev-base")]


def test_default_null_condition_can_identify_a_repeat():
    raw = metadata()
    raw["condition"] = None
    assert repeat_reference.episode_settings([summary(raw)]) is not None
