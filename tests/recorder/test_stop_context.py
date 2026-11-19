"""Recorded stopping conditions are actual numeric facts, with no simulator calls."""
from dataclasses import dataclass
from types import ModuleType, SimpleNamespace
import sys

import pytest

from capx_trace_recorder import context as C
from capx_trace_recorder.hooks import trial as TRIAL
from capx_trace_recorder.stop_context import job_context, trial_context
from inprocess import Recorder, by_type


def test_snapshot_retains_runtime_overrides_without_import_or_properties(monkeypatch):
    runner = ModuleType("capx.envs.runner")
    runner.TRIAL_TIMEOUT_SECONDS = 2400
    runner.MAX_TRIAL_RETRIES = 3
    trial = ModuleType("capx.envs.trial")
    trial.MULTITURN_LIMIT = 5
    monkeypatch.setitem(sys.modules, runner.__name__, runner)
    monkeypatch.setitem(sys.modules, trial.__name__, trial)
    low = SimpleNamespace(max_steps=1234, _sim_step_count=1200, robosuite_env=SimpleNamespace(horizon=1234, timestep=1200))
    env = SimpleNamespace(low_level_env=low)
    facts = trial_context(env, turns_used=5)
    assert {key: facts[key] for key in ("step_limit", "steps_used", "env_horizon", "trial_time_limit_s",
                                      "trial_attempt_limit", "multiturn_limit", "turns_used")} == {
        "step_limit": 1234, "steps_used": 1200, "env_horizon": 1234, "trial_time_limit_s": 2400,
        "trial_attempt_limit": 3, "multiturn_limit": 5, "turns_used": 5,
    }
    assert facts["horizon_steps_used"] == 1200
    assert facts["sources"]["step_limit"] == "low_level_env.max_steps"
    assert "steps_used" not in trial_context(env, include_usage=False)

    class PropertyEnv:
        @property
        def low_level_env(self):
            raise AssertionError("observing must not execute simulator properties")

    assert "step_limit" not in trial_context(PropertyEnv())


@pytest.mark.parametrize("value", [None, True, -1, float("inf"), float("nan"), 10 ** 1000, "1000"])
def test_missing_or_invalid_numbers_are_not_guessed(value):
    facts = trial_context(SimpleNamespace(low_level_env=SimpleNamespace(max_steps=value)))
    assert "step_limit" not in facts
    assert "code_time_limit_s" not in facts


@pytest.mark.parametrize("value,seconds", [("30", 1800), ("01:02:03", 3723), ("1-02:03:04", 93784),
                                           ("UNLIMITED", None), ("bad", None)])
def test_scheduler_metadata_is_allowlisted(value, seconds):
    env = {"SLURM_JOB_ID": "12345_2", "SLURM_TIMELIMIT": value, "SECRET": "must not be recorded",
           "CAPX_TRACE_JOB_STATE": "TIMEOUT", "CAPX_TRACE_JOB_ENDED_AT": "2026-11-20T01:02:03Z",
           "CAPX_TRACE_JOB_REASON": "time_limit"}
    facts = job_context(env)
    assert facts["job_id"] == "12345_2" and facts["state"] == "TIMEOUT"
    assert facts.get("time_limit_s") == seconds
    assert "SECRET" not in facts
    assert facts["ended_at"] == "2026-11-20T01:02:03Z"
    assert job_context({"SLURM_JOB_ID": "12345"}) == {"scheduler": "slurm", "job_id": "12345"}
    assert job_context({"SLURM_JOB_ID": "bad/private/host", "CAPX_TRACE_JOB_REASON": "arbitrary log"}) == {}
    assert job_context({"CAPX_TRACE_JOB_ENDED_AT": "2026-99-99T99:99:99Z",
                        "CAPX_TRACE_JOB_TIME_LIMIT_S": "999999999999", "SLURM_TIMELIMIT": "99999999999999999999999999999999999999"}) == {}


@dataclass
class Summary:
    task_completed: bool = False
    terminated: bool = False
    truncated: bool = True
    sandbox_rc: int = 0


def test_trial_start_and_end_persist_limits_final_usage_and_truncation(tmp_path, monkeypatch):
    monkeypatch.setenv("CAPX_TRACE_RUN_ID", "limits")
    rec = Recorder(tmp_path / "traces", monkeypatch)
    monkeypatch.setattr(TRIAL, "attach_frames", lambda *args: {"installed": False})
    low = SimpleNamespace(max_steps=1000, _sim_step_count=999, robosuite_env=SimpleNamespace(horizon=1000))
    env = SimpleNamespace(low_level_env=low)

    def original(env, trial, args, config, multi_turn_prompt=None):
        ep, _ = C.resolve_episode(env)
        rec.episodes.append(ep)
        low._sim_step_count = 1000
        ep.turn_index = 2
        ep.n_code_blocks = 3
        return Summary()

    try:
        result = TRIAL.make_run_single_trial_wrapper(original)(env, 401, SimpleNamespace(), {})
        assert isinstance(result, Summary)
        ep = rec.episodes[0]
        events = rec.events(ep)
        start = by_type(events, "episode_start")[0]["data"]["stop_context"]
        end = by_type(events, "episode_end")[0]["data"]["stop_context"]
        assert start["step_limit"] == 1000 and "steps_used" not in start
        assert end["steps_used"] == 1000 and end["turns_used"] == 3
        assert end["model_turn_index"] == 2
        doc = rec.summary(ep)
        assert doc["stop_context"] == end
        assert doc["harness_summary"]["truncated"] is True
        assert doc["harness_summary"]["terminated"] is False
    finally:
        rec.close()


def test_recorder_abandonment_note_is_retained_in_summary(tmp_path, monkeypatch):
    rec = Recorder(tmp_path / "traces", monkeypatch)
    try:
        ep = rec.open()
        TRIAL.end_episode(ep, end_reason="error", extra={"end_note": "trial end was not recorded"})
        assert rec.summary(ep)["end_note"] == "trial end was not recorded"
    finally:
        rec.close()


def test_web_timeout_is_recorded_without_ending_trial(tmp_path, monkeypatch):
    import asyncio
    from capx_trace_recorder.hooks import web as WEB

    rec = Recorder(tmp_path / "traces", monkeypatch)
    web_module = ModuleType("capx.web.async_trial_runner")
    web_module.MULTITURN_LIMIT = 30
    monkeypatch.setitem(sys.modules, web_module.__name__, web_module)
    env = SimpleNamespace(low_level_env=SimpleNamespace())
    session = SimpleNamespace(env=env, execution_timeout=180)
    event_type = type("CodeExecutionResultEvent", (), {})
    event = event_type()
    event.success = False
    event.block_index = 2
    event.stderr = "Execution timed out after 180 seconds. The code may be stuck in a loop."
    ep = rec.open(source="web_ui")
    C.REGISTRY.bind_env(env, ep)
    seen = []

    async def original(self, value):
        seen.append(value)
        return "unchanged"

    try:
        assert asyncio.run(WEB.make_session_emit_wrapper(original)(session, event)) == "unchanged"
        assert seen == [event] and not ep.ended
        recorded = by_type(rec.events(ep), "code_execution_timeout")
        assert len(recorded) == 1
        assert recorded[0]["data"]["code_time_limit_s"] == 180
        assert recorded[0]["data"]["block_index"] == 2
        context = trial_context(env, session=session)
        assert context["multiturn_limit"] == 30
        assert "trial_time_limit_s" not in context
    finally:
        rec.close()
