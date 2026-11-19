"""The shared Python/TypeScript verdict contract and untrusted evaluation records."""

import copy
import json
import subprocess
import sys
from pathlib import Path

import pytest

from capx_trace_viewer import evals

CASES = json.loads((Path(__file__).parent / "fixtures" / "eval_verdicts.json").read_text())


def record():
    return {"schema": evals.SCHEMA, "eval_id": "ev-test", "status": "completed",
            "end": {"exit_code": 0, "signal": None}, "by": "実行者", "changed": "変更",
            "baseline_eval_id": None, "eval_set": None, "git": None,
            "started_at": "2026-11-18T09:00:00Z", "heartbeat_at": "2026-11-18T09:00:01Z",
            "ended_at": "2026-11-18T09:00:01Z", "summary": evals.aggregate_episodes([])}


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_shared_verdict_cases(case):
    assert evals.trial_verdict(case["episode"], case["runner_records"]) == case["expected"]


def test_stdlib_only_imports():
    code = ("import capx_trace_viewer.evals, capx_trace_recorder.eval, sys\n"
            "assert 'fastapi' not in sys.modules\n"
            "assert not any(k.startswith(('numpy', 'PIL')) for k in sys.modules)\n")
    result = subprocess.run([sys.executable, "-S", "-c", code], capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr


@pytest.mark.parametrize("path,value", [
    (("schema",), "capx-eval/2"), (("eval_id",), "../escape"),
    (("eval_id",), "id\n"), (("baseline_eval_id",), "../escape"),
    (("status",), "done"), (("by",), ["name"]), (("changed",), "x" * 201),
    (("eval_set",), "x" * 201), (("started_at",), "invalid"),
    (("heartbeat_at",), "2026-11-18T09:00:00"),
    (("summary", "trials"), True), (("summary", "incomplete"), -1),
    (("summary", "models"), {"code_generator": {"endpoint": "secret"}}),
    (("summary", "models"), {"m": "x" * 513}),
    (("summary", "seeds"), [True]), (("summary", "config_flags"), {"x": float("nan")}),
    (("summary", "config_flags"), {"x": float("inf")}),
    (("summary", "config_flags"), {"x": 10 ** 400}),
    (("summary", "config_flags"), {"x": {"x": {"x": {"x": {"x": True}}}}}),
    (("git",), {"commit": "a" * 40, "dirty": "yes"}),
    (("git",), {"commit": "a" * 40, "dirty": 0, "diff_sha256": None}),
    (("git",), {"commit": "a" * 40, "dirty": True, "diff_sha256": "invalid"}),
    (("git",), {"commit": "a" * 40, "dirty": True, "diff_sha256": None}),
    (("git",), {"commit": "a" * 40, "dirty": False, "diff_sha256": "b" * 64}),
    (("git",), {"commit": "a" * 40, "dirty": None, "diff_sha256": "b" * 64}),
    (("end", "exit_code"), True), (("end", "signal"), "TERM"),
    (("end", "workers_left_running"), 1), (("end", "workers_left_running"), None),
    (("end", "unknown"), True),
])
def test_invalid_records_are_bounded_and_rejected(path, value):
    data = record()
    cursor = data
    for field in path[:-1]:
        cursor = cursor[field]
    cursor[path[-1]] = value
    with pytest.raises(evals.EvalValidationError):
        evals.validate_eval_record(data)


def test_valid_record_and_run_id_match():
    data = record()
    assert evals.validate_eval_record(data, eval_id="ev-test") == data
    with pytest.raises(evals.EvalValidationError, match="mismatch"):
        evals.validate_eval_record(data, eval_id="other")
    data["command"] = "secret"
    with pytest.raises(evals.EvalValidationError):
        evals.validate_eval_record(data)


@pytest.mark.parametrize("dirty,diff", [(False, None), (True, "b" * 64), (None, None)])
def test_valid_git_metadata_states(dirty, diff):
    data = record()
    data["git"] = {"commit": "a" * 40, "dirty": dirty, "diff_sha256": diff}
    assert evals.validate_eval_record(data) == data


@pytest.mark.parametrize("workers_left_running", [False, True])
def test_worker_wait_result_is_an_optional_boolean(workers_left_running):
    data = record()
    data["end"]["workers_left_running"] = workers_left_running
    assert evals.validate_eval_record(data) == data


def test_aggregate_keeps_task_results_and_only_model_names():
    case = copy.deepcopy(CASES[0])
    episode = case["episode"]
    episode.update({"trace_complete": True, "episode": {
        "models": {"code_generator": {"model": "model/name", "endpoint": "http://secret"}},
        "config_flags": {"multi_turn": True, "use_parallel_ensemble": False}}})
    second = copy.deepcopy(episode)
    second.update({"status": "running", "trace_complete": False, "seed": 2})
    second["episode"]["config_flags"]["multi_turn"] = False
    summary = evals.aggregate_episodes([episode, second], case["runner_records"])
    assert (summary["trials"], summary["success"], summary["failure"], summary["unknown"], summary["incomplete"]) == (2, 0, 1, 1, 1)
    assert summary["models"] == {"code_generator": "model/name"}
    assert summary["config_flags"] == {"use_parallel_ensemble": False}
    assert summary["mixed"] == ["multi_turn"]
    assert summary["tasks"] == ["cube"] and summary["seeds"] == [1, 2]
    assert summary["by_task"] == {"cube": {"trials": 2, "success": 0}}
    assert summary["verdict_sources"] == {"runner_record": 1, "unknown": 1}
    assert "secret" not in json.dumps(summary)
    _data = record()
    _data["summary"] = summary
    evals.validate_eval_record(_data)


def test_local_evals_report_bad_files_and_do_not_follow_symlinks(tmp_path):
    for run_id, contents in (("ev-test", json.dumps(record())), ("broken", "bad json"),
                             ("oversized", " " * (evals.MAX_EVAL_BYTES + 1))):
        run = tmp_path / run_id
        run.mkdir()
        (run / "eval.json").write_text(contents)
    symlink = tmp_path / "symlink"
    symlink.mkdir()
    (symlink / "eval.json").symlink_to(tmp_path / "ev-test" / "eval.json")
    (tmp_path / "linked-run").symlink_to(tmp_path / "ev-test", target_is_directory=True)
    rows = {row["run_id"]: row for row in evals.read_local_evals(tmp_path)}
    assert rows["ev-test"]["eval_json"]["eval_id"] == "ev-test"
    assert rows["broken"]["eval_json_error"] == "invalid_json"
    assert rows["oversized"]["eval_json_error"].startswith("too_large")
    assert rows["symlink"]["eval_json_error"] == "symlink_not_followed"
    assert "linked-run" not in rows


@pytest.mark.parametrize("number", ["NaN", "Infinity", "-Infinity"])
def test_local_eval_json_rejects_nonfinite_literals(tmp_path, number):
    data = record()
    data["summary"]["config_flags"]["bad"] = float("nan")
    run = tmp_path / "ev-test"
    run.mkdir()
    (run / "eval.json").write_text(json.dumps(data).replace("NaN", number))
    assert evals.read_local_evals(tmp_path)[0]["eval_json_error"] == "invalid_json"


def test_display_status_and_condition_differences():
    data = record()
    assert evals.display_status(data) is None
    data["summary"]["incomplete"] = 1
    assert evals.display_status(data) == "incomplete"
    data.update(status="running", heartbeat_at="1970-01-01T00:00:00Z")
    assert evals.display_status(data, now=299) == "running"
    assert evals.display_status(data, now=300) == "interrupted"
    baseline = record()
    current = copy.deepcopy(baseline)
    current["summary"]["seeds"] = [2]
    current["eval_set"] = "new"
    assert evals.condition_differences(current, baseline) == [
        {"field": "seeds", "baseline": [], "current": [2]},
        {"field": "eval_set", "baseline": None, "current": "new"}]


def test_condition_sets_ignore_order_and_flags_keep_json_types():
    baseline, current = record(), record()
    baseline["summary"].update(tasks=["cube", "lift"], seeds=[1, 2], config_flags={"multi_turn": True})
    current["summary"].update(tasks=["lift", "cube"], seeds=[2, 1], config_flags={"multi_turn": 1})
    assert evals.condition_differences(current, baseline) == [
        {"field": "config_flags", "baseline": {"multi_turn": True}, "current": {"multi_turn": 1}}]
    summary = evals.aggregate_episodes([
        {"episode": {"config_flags": {"multi_turn": value}}} for value in (True, 1)])
    assert summary["mixed"] == ["multi_turn"] and summary["config_flags"] == {}


def test_explicit_interruption_verdict_is_not_inferred_for_legacy_records():
    old = {'status': 'interrupted', 'episode': {}}
    assert evals.trial_verdict(old) == 'unknown'
    new = {'status': 'running', 'episode': {'trial_outcome': {
        'task_success': False, 'source': 'evaluation_finalizer'}}}
    assert evals.trial_verdict(new) == 'failure'
    new['episode']['trial_outcome']['task_success'] = True
    assert evals.trial_verdict(new) == 'success'
