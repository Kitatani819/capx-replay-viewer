"""Resume preserves identity, excludes finished tuples, and serializes split jobs."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from capx_trace_recorder import eval as wrapper, eval_resume
from capx_trace_viewer import evals, reader


@pytest.fixture
def clean_repo(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    (repo / "tracked").write_text("committed\n")
    subprocess.run(["git", "-C", str(repo), "add", "tracked"], check=True)
    subprocess.run(["git", "-C", str(repo), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                    "commit", "-qm", "fixture"], check=True)
    return repo


def load(root):
    paths = list(root.glob("*/eval.json"))
    assert len(paths) == 1
    value = json.loads(paths[0].read_text())
    evals.validate_eval_record(value)
    return value


def writer_code(seeds, *, expected_done=(), budget_seed=None, plan=range(1, 5)):
    return f'''
import json, os, time
from pathlib import Path
root = Path(os.environ['CAPX_TRACE_DIR']) / os.environ['CAPX_TRACE_RUN_ID']
done = json.loads(Path(os.environ['CAPX_EVAL_COMPLETED_TRIALS_FILE']).read_text())
assert [item['seed'] for item in done] == {list(expected_done)!r}, done
(root / 'planned-trials.json').write_text(json.dumps([{{'task': 'cube', 'condition': None, 'seed': seed}} for seed in {list(plan)!r}]))
segment = int(os.environ['CAPX_EVAL_SEGMENT'])
for seed in {list(seeds)!r}:
    directory = root / f'trial-{{segment}}-{{seed}}'
    directory.mkdir()
    success = seed % 2 == 1
    raw = {{'episode_id': directory.name, 'run_id': root.name, 'task': 'cube', 'condition': None, 'seed': seed,
            'status': 'ended', 'trace_complete': True, 'episode_end_written': True,
            'start_wall_time': time.time(), 'end_reason': 'completed',
            'harness_summary': {{'task_completed': success}}}}
    if seed == {budget_seed!r}:
        raw['harness_summary'] = {{'task_completed': False, 'budget_exhausted': True}}
        raw['trial_outcome'] = {{'source': 'recorder_terminal', 'task_success': False, 'resumable': True}}
    (directory / 'episode.json').write_text(json.dumps(raw))
'''


def test_resume_reuses_id_and_counts_only_last_logical_trials(tmp_path, clean_repo):
    root = tmp_path / "traces"
    assert wrapper.run_eval([sys.executable, "-c", writer_code([1, 2, 3], budget_seed=3)],
                            trace_root=root, repo=clean_repo, changed="original", eval_set="split-4", by="fixture") == 0
    first = load(root)
    assert first["summary"]["trials"] == 4
    assert first["summary"]["success"] == 1
    assert first["segments"][0]["completed_after"] == 2
    assert list((root / first["eval_id"]).glob("unrun-*"))
    assert wrapper.run_eval([sys.executable, "-c", writer_code([3, 4], expected_done=[1, 2])],
                            trace_root=root, repo=clean_repo, resume=first["eval_id"]) == 0
    second = load(root)
    assert (second["eval_id"], second["by"], second["changed"], second["eval_set"], second["started_at"]) == (
        first["eval_id"], "fixture", "original", "split-4", first["started_at"])
    assert (second["summary"]["trials"], second["summary"]["success"], second["summary"]["failure"]) == (4, 2, 2)
    assert len(second["segments"]) == 2
    assert second["segments"][1]["completed_before"] == 2
    assert second["segments"][1]["completed_after"] == 4
    assert wrapper.run_eval([sys.executable, "-c", writer_code([], expected_done=[1, 2, 3, 4])],
                            trace_root=root, repo=clean_repo, resume=first["eval_id"]) == 0
    third = load(root)
    assert third["summary"] == second["summary"]
    assert len(third["segments"]) == 3


@pytest.mark.parametrize("damage", ["dirty", "commit", "unknown", "missing_git", "changed", "eval_set", "by", "baseline"])
def test_resume_rejects_changed_identity_before_child_runs(tmp_path, clean_repo, damage):
    root = tmp_path / "traces"
    wrapper.run_eval([sys.executable, "-c", "pass"], trace_root=root, repo=clean_repo)
    first = load(root)
    kwargs = {}
    if damage == "dirty":
        (clean_repo / "tracked").write_text("changed\n")
    elif damage == "commit":
        subprocess.run(["git", "-C", str(clean_repo), "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                        "commit", "--allow-empty", "-qm", "next"], check=True)
    elif damage in ("unknown", "missing_git"):
        first["git"] = None if damage == "missing_git" else {**first["git"], "dirty": None}
        (root / first["eval_id"] / "eval.json").write_text(json.dumps(first))
    else:
        kwargs[damage] = "changed"
    marker = tmp_path / "must-not-start"
    with pytest.raises(ValueError):
        wrapper.run_eval([sys.executable, "-c", f"from pathlib import Path;Path({str(marker)!r}).touch()"],
                         trace_root=root, repo=clean_repo, resume=first["eval_id"], **kwargs)
    assert not marker.exists()
    assert len(load(root)["segments"]) == 1


def test_completed_contract_excludes_cut_trials_and_never_guesses_missing_verdicts():
    def ep(seed, raw, status="ended"):
        return {"task": "cube", "condition": None, "seed": seed, "status": status, "episode": raw}
    episodes = [ep(1, {"harness_summary": {"task_completed": True, "budget_exhausted": True}}),
                ep(2, {"harness_summary": {"task_completed": False}}),
                ep(3, {"harness_summary": {"task_completed": False, "budget_exhausted": True}}),
                ep(4, {"end_reason": "error"}),
                ep(5, {"trial_outcome": {"source": "evaluation_finalizer", "task_success": False, "resumable": True}}),
                ep(6, {"trial_outcome": {"source": "recorder_terminal", "task_success": False, "resumable": False}}),
                ep(7, {"harness_summary": {"task_completed": False}}, "running")]
    assert [item["seed"] for item in eval_resume.completed_trials(episodes)] == [1, 2, 6]


@pytest.mark.skipif(os.name != "posix", reason="flock uses POSIX descriptors")
def test_lock_serializes_jobs_and_releases_after_exit(tmp_path):
    with reader.Dir.open_root(tmp_path) as directory:
        with eval_resume.lock(directory):
            with pytest.raises(ValueError, match="already being written"):
                with eval_resume.lock(directory):
                    pytest.fail("second writer obtained the lock")
        with eval_resume.lock(directory):
            pass


@pytest.mark.parametrize("damage", ["run_symlink", "record_symlink", "lock_symlink"])
def test_resume_never_follows_run_record_or_lock_symlinks(tmp_path, clean_repo, damage):
    root = tmp_path / "traces"
    wrapper.run_eval([sys.executable, "-c", "pass"], trace_root=root, repo=clean_repo)
    first = load(root)
    run = root / first["eval_id"]
    if damage == "run_symlink":
        run.rename(tmp_path / "outside-run")
        run.symlink_to(tmp_path / "outside-run", target_is_directory=True)
    else:
        target = run / ("eval.json" if damage == "record_symlink" else eval_resume.LOCK_FILE)
        outside = tmp_path / "outside-file"
        target.rename(outside)
        target.symlink_to(outside)
    with pytest.raises((OSError, ValueError)):
        wrapper.run_eval([sys.executable, "-c", "raise AssertionError('must not run')"],
                         trace_root=root, repo=clean_repo, resume=first["eval_id"])


def test_running_or_unfinished_workers_require_positive_stop_evidence(tmp_path, clean_repo, monkeypatch):
    root = tmp_path / "traces"
    wrapper.run_eval([sys.executable, "-c", "pass"], trace_root=root, repo=clean_repo)
    value = load(root)
    value.update(status="running", end=None, summary=None, ended_at=None)
    value["segments"][-1].update(status="running", end=None, ended_at=None, completed_after=None)
    (root / value["eval_id"] / "eval.json").write_text(json.dumps(value))
    monkeypatch.setattr(eval_resume, "stopped_process_group", lambda _directory: False)
    with pytest.raises(ValueError, match="stale heartbeat"):
        wrapper.run_eval([sys.executable, "-c", "pass"], trace_root=root, repo=clean_repo, resume=value["eval_id"])
    monkeypatch.setattr(eval_resume, "stopped_process_group", lambda _directory: True)
    assert wrapper.run_eval([sys.executable, "-c", "pass"], trace_root=root, repo=clean_repo, resume=value["eval_id"]) == 0
    updated = load(root)
    assert updated["segments"][0]["stop_verified"] is True
    assert updated["segments"][0]["ended_at"] is None
    assert updated["segments"][0]["end"] is None


def test_process_evidence_is_host_boot_and_group_specific(tmp_path, monkeypatch):
    with reader.Dir.open_root(tmp_path) as directory:
        monkeypatch.setattr(eval_resume, "machine_id", lambda: "same-machine-and-boot")
        data = {"schema": eval_resume.CONTROL_SCHEMA, "machine_id": "other-machine", "supervisor_pid": 2222, "child_pgid": 3333}
        eval_resume.write_json(directory, eval_resume.CONTROL_FILE, data)
        assert eval_resume.stopped_process_group(directory) is False
        data["machine_id"] = "same-machine-and-boot"
        eval_resume.write_json(directory, eval_resume.CONTROL_FILE, data)
        def gone(*_args):
            raise ProcessLookupError
        monkeypatch.setattr(eval_resume.os, "kill", gone)
        monkeypatch.setattr(eval_resume.os, "killpg", lambda *_args: None)
        assert eval_resume.stopped_process_group(directory) is False
        monkeypatch.setattr(eval_resume.os, "killpg", gone)
        assert eval_resume.stopped_process_group(directory) is True


def test_invalid_resume_id_never_creates_trace_root(tmp_path, clean_repo):
    with pytest.raises(ValueError, match="valid evaluation ID"):
        wrapper.run_eval([sys.executable, "-c", "pass"], trace_root=tmp_path / "missing", repo=clean_repo, resume="../escape")
    assert not (tmp_path / "missing").exists()


def test_budget_is_cumulative_and_excludes_time_queued_between_jobs(tmp_path):
    with reader.Dir.open_root(tmp_path) as directory:
        eval_resume.write_json(directory, "evaluation-budget.json", {"schema": "capx-eval-budget/1", "limit_s": 600})
        eval_resume.write_json(directory, "evaluation-clock-1.json", {"budget_s": 600, "started_at": 1000, "used_before_s": 0})
        first = eval_resume.budget_usage(directory, 1, 1200)
        assert first == {"limit_s": 600, "used_before_s": 0, "used_s": 200}
        eval_resume.write_json(directory, "evaluation-clock-2.json", {"budget_s": 600, "started_at": 10000, "used_before_s": 200})
        second = eval_resume.budget_usage(directory, 2, 10300)
        assert second == {"limit_s": 600, "used_before_s": 200, "used_s": 300}
        assert eval_resume.budget_usage(directory, 2, None)["used_s"] == 400
        assert eval_resume.budget_usage(directory, 2, 20000)["used_s"] == 400


def test_startup_failure_before_budget_clock_costs_no_simulator_budget(tmp_path):
    with reader.Dir.open_root(tmp_path) as directory:
        eval_resume.write_json(directory, "evaluation-budget.json", {"schema": "capx-eval-budget/1", "limit_s": 600})
        assert eval_resume.budget_usage(directory, 1, 1000)["used_s"] == 0


def test_wall_clock_rollback_does_not_refund_budget_and_monotonic_is_preferred(tmp_path, monkeypatch):
    with reader.Dir.open_root(tmp_path) as directory:
        monkeypatch.setattr(eval_resume, "machine_id", lambda: "same-boot")
        eval_resume.write_json(directory, "evaluation-budget.json", {"schema": "capx-eval-budget/1", "limit_s": 600})
        eval_resume.write_json(directory, "evaluation-clock-1.json", {"budget_s": 600, "started_at": 1000, "used_before_s": 200,
                               "started_monotonic": 100, "machine_id": "same-boot"})
        assert eval_resume.budget_usage(directory, 1, 900)["used_s"] == 400
        assert eval_resume.budget_usage(directory, 1, 900, 150)["used_s"] == 50


def test_lost_writer_with_missing_clock_consumes_known_remaining_budget(tmp_path):
    with reader.Dir.open_root(tmp_path) as directory:
        eval_resume.write_json(directory, "evaluation-budget.json", {"schema": "capx-eval-budget/1", "limit_s": 600})
        assert eval_resume.budget_usage(directory, 2, None, used_before_s=200) == {
            "limit_s": 600, "used_before_s": 200, "used_s": 400}


def test_segment_order_wins_over_rolled_back_wall_time():
    old = {"task": "cube", "condition": None, "seed": 401, "eval_segment": 1, "start_wall_time": 1000}
    new = {"task": "cube", "condition": None, "seed": 401, "eval_segment": 2, "start_wall_time": 900}
    assert evals.latest_logical_episodes([new, old]) == [new]


def test_missing_completed_episode_cannot_be_rerun_as_if_unfinished(tmp_path, clean_repo):
    import shutil
    root = tmp_path / "traces"
    wrapper.run_eval([sys.executable, "-c", writer_code([1, 2], plan=[1, 2])], trace_root=root, repo=clean_repo)
    value = load(root)
    shutil.rmtree(root / value["eval_id"] / "trial-1-1")
    with pytest.raises(ValueError, match="completed trial records are missing"):
        wrapper.run_eval([sys.executable, "-c", "pass"], trace_root=root, repo=clean_repo, resume=value["eval_id"])
