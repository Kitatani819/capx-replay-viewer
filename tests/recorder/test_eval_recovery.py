"""Recorder recovery must preserve persisted outcomes and evaluation history."""
from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

import pytest

from capx_trace_recorder import eval as wrapper, eval_resume
from capx_trace_viewer import evals, reader


@pytest.fixture
def evaluation(tmp_path, monkeypatch):
    monkeypatch.setattr(wrapper, "git_revision", lambda *_args, **_kwargs: {"commit": "a" * 40, "dirty": False})
    root = tmp_path / "traces"
    assert wrapper.run_eval([sys.executable, "-c", "pass"], trace_root=root, index_enabled=False) == 0
    path = next(root.glob("*/eval.json"))
    return root, path


def job_end(root, run_id, job_id="101"):
    return wrapper.job_end_main(["--trace-root", str(root), "--run-id", run_id, "--job-id", job_id,
                                 "--state", "TIMEOUT", "--ended-at", "2026-11-20T01:02:03Z"])


@pytest.mark.skipif(os.name != "posix", reason="flock uses POSIX descriptors")
def test_job_end_cannot_overwrite_an_active_evaluation(evaluation):
    root, path = evaluation
    before = path.read_bytes()
    with reader.Dir.open_root(path.parent) as directory, eval_resume.lock(directory):
        with pytest.raises(SystemExit) as error:
            job_end(root, path.parent.name)
    assert error.value.code == 2
    assert path.read_bytes() == before


def test_job_end_writes_through_the_locked_directory(evaluation, monkeypatch, tmp_path):
    root, path = evaluation
    displaced = tmp_path / "displaced"
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "eval.json").write_bytes(path.read_bytes())
    read = reader.read_json_at
    swapped = False

    def swap_after_read(directory, name, *args, **kwargs):
        nonlocal swapped
        result = read(directory, name, *args, **kwargs)
        if name == "eval.json" and not swapped:
            swapped = True
            path.parent.rename(displaced)
            path.parent.symlink_to(outside, target_is_directory=True)
        return result

    monkeypatch.setattr(reader, "read_json_at", swap_after_read)
    assert job_end(root, path.parent.name) == 0
    assert json.loads((displaced / "eval.json").read_text())["job"]["state"] == "TIMEOUT"
    assert "job" not in json.loads((outside / "eval.json").read_text())


def test_job_end_is_preserved_in_segment_history_after_resume(evaluation, monkeypatch):
    root, path = evaluation
    record = json.loads(path.read_text())
    job = {"scheduler": "slurm", "job_id": "101"}
    record["job"] = record["segments"][0]["job"] = job
    path.write_text(json.dumps(record))
    assert job_end(root, path.parent.name) == 0
    monkeypatch.setenv("SLURM_JOB_ID", "202")
    assert wrapper.run_eval([sys.executable, "-c", "pass"], trace_root=root,
                            resume=path.parent.name, index_enabled=False) == 0
    resumed = json.loads(path.read_text())
    assert resumed["segments"][0]["job"]["state"] == "TIMEOUT"
    assert resumed["segments"][0]["job"]["ended_at"] == "2026-11-20T01:02:03Z"
    assert resumed["job"]["job_id"] == "202"


def test_job_end_can_import_delayed_accounting_for_an_older_segment(evaluation, monkeypatch):
    root, path = evaluation
    record = json.loads(path.read_text())
    job = {"scheduler": "slurm", "job_id": "101"}
    record["job"] = record["segments"][0]["job"] = job
    path.write_text(json.dumps(record))
    monkeypatch.setenv("SLURM_JOB_ID", "202")
    assert wrapper.run_eval([sys.executable, "-c", "pass"], trace_root=root,
                            resume=path.parent.name, index_enabled=False) == 0
    current = json.loads(path.read_text())["job"]
    assert job_end(root, path.parent.name) == 0
    resumed = json.loads(path.read_text())
    assert resumed["segments"][0]["job"]["state"] == "TIMEOUT"
    assert resumed["segments"][1]["job"] == resumed["job"] == current


def test_finalizer_and_completion_inventory_use_persisted_runner_verdict(tmp_path):
    run = tmp_path / "ev-runner"
    episode = run / "trial"
    episode.mkdir(parents=True)
    raw = {"episode_id": "trial", "run_id": run.name, "task": "cube", "condition": None, "seed": 7,
           "attempt_index": 1, "episode_end_written": False, "status": "ended", "trace_complete": False}
    (episode / "episode.json").write_text(json.dumps(raw))
    record = {"task": "cube", "condition": None, "seed": 7,
              "attempts": [{"attempt_id": 1, "task_success": True}]}
    (run / "runner_records.jsonl").write_text(json.dumps(record) + "\n")
    assert wrapper.finalize_trial_outcomes(tmp_path, run.name) == 1
    outcome = json.loads((episode / "episode.json").read_text())["trial_outcome"]
    assert outcome["task_success"] is True and outcome["resumable"] is False
    details = reader.run_detail(tmp_path, run.name)
    assert eval_resume.completed_trials(details["episodes"]) == [{"task": "cube", "condition": None, "seed": 7}]
    assert evals.summarize_run(tmp_path, run.name)["success"] == 1


@pytest.mark.parametrize("temporary_left", [False, True])
def test_unobserved_finalization_repairs_interrupted_placeholder(tmp_path, temporary_left):
    run = tmp_path / "ev-unrun"
    run.mkdir()
    key = ("cube", None, 7)
    (run / "planned-trials.json").write_text(json.dumps([dict(zip(("task", "condition", "seed"), key))]))
    digest = hashlib.sha256(json.dumps(key, ensure_ascii=True).encode()).hexdigest()[:24]
    placeholder = run / ("unrun-" + digest)
    placeholder.mkdir()
    if temporary_left:
        (placeholder / ".resume-0123456789abcdef.tmp").write_text('{"episode_id":')
    assert eval_resume.finalize_unobserved(tmp_path, run.name) == 1
    assert evals.summarize_run(tmp_path, run.name)["failure"] == 1
    assert eval_resume.finalize_unobserved(tmp_path, run.name) == 0


@pytest.mark.parametrize("damage", ["symlink", "foreign"])
def test_unobserved_finalization_rejects_foreign_placeholders(tmp_path, damage):
    run = tmp_path / "ev-unrun"
    run.mkdir()
    key = ("cube", None, 7)
    (run / "planned-trials.json").write_text(json.dumps([dict(zip(("task", "condition", "seed"), key))]))
    digest = hashlib.sha256(json.dumps(key, ensure_ascii=True).encode()).hexdigest()[:24]
    placeholder = run / ("unrun-" + digest)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "episode.json").write_text('{"keep":true}')
    if damage == "symlink":
        placeholder.symlink_to(outside, target_is_directory=True)
    else:
        placeholder.mkdir()
        (placeholder / "episode.json").write_text('{"episode_id":"foreign","task":"other","seed":1}')
    with pytest.raises((ValueError, OSError)):
        eval_resume.finalize_unobserved(tmp_path, run.name)
    assert (outside / "episode.json").read_text() == '{"keep":true}'
    if damage == "foreign":
        assert json.loads((placeholder / "episode.json").read_text())["episode_id"] == "foreign"


@pytest.mark.parametrize("exit_code", [0, 7])
def test_inventory_write_failure_preserves_child_exit_and_final_record(tmp_path, monkeypatch, capsys, exit_code):
    writes = 0
    original = eval_resume.write_json

    def fail_final_inventory(directory, name, value, **kwargs):
        nonlocal writes
        if name == eval_resume.COMPLETED_FILE:
            writes += 1
            if writes == 2:
                raise OSError("no space")
        return original(directory, name, value, **kwargs)

    monkeypatch.setattr(eval_resume, "write_json", fail_final_inventory)
    assert wrapper.run_eval([sys.executable, "-c", f"raise SystemExit({exit_code})"],
                            trace_root=tmp_path, index_enabled=False) == exit_code
    record = json.loads(next(tmp_path.glob("*/eval.json")).read_text())
    assert record["status"] == ("completed" if exit_code == 0 else "interrupted")
    assert record["end"]["exit_code"] == exit_code
    assert record["summary"]["config_flags"]["resume_inventory_incomplete"] is True
    assert "completed trial inventory" in capsys.readouterr().err


def test_failed_resume_preserves_previously_completed_failure(evaluation):
    root, path = evaluation
    episode = path.parent / "historical-failure"
    episode.mkdir()
    raw = {"episode_id": episode.name, "run_id": path.parent.name, "task": "cube", "condition": None, "seed": 7,
           "eval_segment": 1, "status": "ended", "episode_end_written": False,
           "trial_outcome": {"source": "evaluation_finalizer", "task_success": False, "resumable": False}}
    (episode / "episode.json").write_text(json.dumps(raw))
    assert wrapper.run_eval([sys.executable, "-c", "raise SystemExit(2)"], trace_root=root,
                            resume=path.parent.name, index_enabled=False) == 2
    assert json.loads((episode / "episode.json").read_text())["trial_outcome"] == raw["trial_outcome"]
    assert json.loads((path.parent / eval_resume.COMPLETED_FILE).read_text()) == [
        {"task": "cube", "condition": None, "seed": 7}]


def test_resume_preserves_legacy_top_level_scheduler_accounting(evaluation, monkeypatch):
    root, path = evaluation
    record = json.loads(path.read_text())
    record["segments"][0]["job"] = {"scheduler": "slurm", "job_id": "101"}
    record["job"] = {"scheduler": "slurm", "job_id": "101", "state": "TIMEOUT",
                     "ended_at": "2026-11-20T01:02:03Z"}
    path.write_text(json.dumps(record))
    monkeypatch.setenv("SLURM_JOB_ID", "202")
    assert wrapper.run_eval([sys.executable, "-c", "pass"], trace_root=root,
                            resume=path.parent.name, index_enabled=False) == 0
    updated = json.loads(path.read_text())
    assert updated["segments"][0]["job"] == record["job"]
    assert updated["job"]["job_id"] == "202"


def test_resume_refuses_stale_inventory_after_failed_final_inventory_write(evaluation, monkeypatch):
    root, path = evaluation
    original = eval_resume.write_json
    writes = 0

    def fail_final_inventory(directory, name, value, **kwargs):
        nonlocal writes
        if name == eval_resume.COMPLETED_FILE:
            writes += 1
            if writes == 2:
                raise OSError("no space")
        return original(directory, name, value, **kwargs)

    code = '''
import json, os
from pathlib import Path
run = Path(os.environ['CAPX_TRACE_DIR']) / os.environ['CAPX_TRACE_RUN_ID']
episode = run / 'trial'
episode.mkdir()
(episode / 'episode.json').write_text(json.dumps({
    'episode_id': 'trial', 'task': 'cube', 'condition': None, 'seed': 7, 'status': 'ended',
    'episode_end_written': True, 'harness_summary': {'task_completed': True}}))
'''
    monkeypatch.setattr(eval_resume, "write_json", fail_final_inventory)
    assert wrapper.run_eval([sys.executable, "-c", code], trace_root=root,
                            resume=path.parent.name, index_enabled=False) == 0
    with pytest.raises(ValueError, match="completed trial inventory is incomplete"):
        wrapper.run_eval([sys.executable, "-c", "pass"], trace_root=root,
                         resume=path.parent.name, index_enabled=False)
