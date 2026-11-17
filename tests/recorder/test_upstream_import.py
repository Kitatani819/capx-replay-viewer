"""Compatibility checks against an explicitly chosen upstream checkout."""

import json
import os
import subprocess
import sys
from collections import Counter
from pathlib import Path
from textwrap import dedent

import pytest

import tracing_http_fakes as F
from trace_reader import by_type, read_events

ROOT = Path(__file__).resolve().parents[2]
EXPECTED = {
    "requests.sessions": ["Session.send"],
    "capx.llm.client": ["query_model", "query_model_streaming", "query_model_ensemble",
                         "query_single_model_ensemble"],
    "capx.utils.launch_utils": ["_build_multi_turn_decision_prompt",
                                 "_build_multi_turn_decision_prompt_legacy",
                                 "_parse_multi_turn_decision", "_extract_code"],
    "capx.utils.video_utils": ["_encode_video_base64"],
    "capx.envs.trial": ["_describe_initial_scene", "_get_visual_differencing_feedback",
                        "_get_video_differencing_feedback", "_query_initial_code",
                        "_handle_multi_turn_step", "_patch_libero_goal", "_run_single_trial"],
    "capx.envs.runner": [],
    "capx.envs.tasks.base": ["CodeExecutionEnvBase.step", "CodeExecutionEnvBase._exec_user_code",
                             "CodeExecutionEnvBase.render", "CodeExecutionEnvBase.render_wrist",
                             "CodeExecutionEnvBase.get_video_frames_range",
                             "CodeExecutionEnvBase.get_wrist_video_frames_range", "CodeExecutionEnvBase.reset"],
    "capx.web.async_trial_runner": ["run_trial_async", "_query_model", "_query_model_streaming"],
    "capx.web.session_manager": ["SessionManager.inject_prompt", "SessionManager.stop_session"],
    "capx.integrations.vision.molmo": ["_parse_points"],
}


def _run(code, upstream, tmp_path):
    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join((str(upstream), str(ROOT)))
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env.pop("CAPX_TRACE_DIR", None)
    return subprocess.run([os.environ.get("CAPX_PYTHON", sys.executable), "-c", code],
                          cwd=tmp_path, env=env, text=True, capture_output=True, timeout=120)


def _result(proc, prefix):
    assert proc.returncode == 0, proc.stdout[-2000:] + proc.stderr[-4000:]
    line = next((line for line in proc.stdout.splitlines() if line.startswith(prefix)), None)
    assert line is not None, proc.stdout[-2000:]
    return json.loads(line[len(prefix):])


def test_upstream_targets_import_with_recorder(tmp_path):
    raw = os.environ.get("CAPX_UPSTREAM_DIR")
    if not raw:
        pytest.skip("CAPX_UPSTREAM_DIR is unset; provide an upstream CaP-X checkout")
    upstream = Path(raw).resolve()
    assert (upstream / "capx" / "__init__.py").is_file(), upstream
    preflight = _result(_run(
        "import importlib,json\n"
        f"names={list(EXPECTED)!r}\n"
        "out={}\n"
        "for name in names:\n"
        " try: importlib.import_module(name); out[name]='ok'\n"
        " except ImportError as exc: out[name]=str(exc)\n"
        "print('PREFLIGHT='+json.dumps(out))\n", upstream, tmp_path), "PREFLIGHT=")
    missing = {name: reason for name, reason in preflight.items() if reason != "ok"}
    if missing:
        pytest.skip(f"upstream dependencies missing before recorder activation: {missing}")
    code = (
        "import importlib,json,os\n"
        "from capx_trace_recorder import bootstrap as b\n"
        "os.environ['CAPX_TRACE_DIR']=os.path.abspath('traces')\n"
        "b.activate()\n"
        f"wrappers={EXPECTED!r}\n"
        "mods={name:importlib.import_module(name) for name in wrappers}\n"
        "checks={}; expected_skips=[]\n"
        "for name,paths in wrappers.items():\n"
        " for path in paths:\n"
        "  for (hook,target),symbols in b.OPTIONAL_SYMBOLS.items():\n"
        "   if name==target and path in symbols and not hasattr(mods[name],path):\n"
        "    expected_skips.append({'hook':hook,'target':target,'reason':path+': not found'})\n"
        "    break\n"
        "  else:\n"
        "   obj=mods[name]\n"
        "   for part in path.split('.'): obj=getattr(obj,part)\n"
        "   checks[name+':'+path]=bool(getattr(obj,'__capx_trace_wrapper__',False))\n"
        "from capx_trace_recorder.context import REGISTRY\n"
        "print('SMOKE_RESULTS='+json.dumps({'checks':checks,'failed':REGISTRY.hooks_failed,"
        "'skipped':REGISTRY.hooks_skipped,'expected_skips':expected_skips,'installed':REGISTRY.hooks_installed}))\n"
    )
    result = _result(_run(code, upstream, tmp_path), "SMOKE_RESULTS=")
    assert all(result["checks"].values()), result["checks"]
    assert result["failed"] == [], result["failed"]
    assert sorted(result["skipped"], key=str) == sorted(result["expected_skips"], key=str)
    installed = {entry.partition(":")[0] for entry in result["installed"]}
    assert {"H1", "H2", "H3", "H4", "H5", "H6", "H7", "H11", "H12", "H13", "H14"} <= installed


def test_upstream_launch_utils_reports_absent_legacy_prompt_as_skipped(tmp_path):
    raw = os.environ.get("CAPX_UPSTREAM_DIR")
    if not raw:
        pytest.skip("CAPX_UPSTREAM_DIR is unset; provide an upstream CaP-X checkout")
    upstream = Path(raw).resolve()
    assert (upstream / "capx" / "utils" / "launch_utils.py").is_file(), upstream
    proc = _run(dedent("""\
        import json
        import os
        from capx_trace_recorder import bootstrap
        from capx_trace_recorder.context import REGISTRY

        os.environ['CAPX_TRACE_DIR'] = os.path.abspath('traces')
        bootstrap.activate()
        try:
            from capx.utils import launch_utils
        except ImportError as exc:
            print('LAUNCH_HOOKS=' + json.dumps({'missing_dependency': str(exc)}))
            raise SystemExit(0)
        names = ['_build_multi_turn_decision_prompt', '_parse_multi_turn_decision', '_extract_code']
        legacy = '_build_multi_turn_decision_prompt_legacy'
        has_legacy = hasattr(launch_utils, legacy)
        if has_legacy:
            names.append(legacy)
        print('LAUNCH_HOOKS=' + json.dumps({
            'module': launch_utils.__file__, 'has_legacy': has_legacy,
            'wrapped': {name: getattr(getattr(launch_utils, name), '__capx_trace_wrapper__', False) for name in names},
            'installed': REGISTRY.hooks_installed, 'failed': REGISTRY.hooks_failed, 'skipped': REGISTRY.hooks_skipped,
        }))
        """), upstream, tmp_path)
    result = _result(proc, "LAUNCH_HOOKS=")
    if result.get("missing_dependency"):
        pytest.skip(f"upstream launch_utils dependencies missing: {result['missing_dependency']}")
    assert Path(result["module"]).resolve() == upstream / "capx" / "utils" / "launch_utils.py"
    assert all(result["wrapped"].values()), result["wrapped"]
    assert result["failed"] == [], result["failed"]
    skipped = [entry for entry in result["skipped"] if entry["target"] == "capx.utils.launch_utils"]
    assert skipped == ([] if result["has_legacy"] else [{
        "hook": "H5/H6", "target": "capx.utils.launch_utils", "reason": "_build_multi_turn_decision_prompt_legacy: not found",
    }])
    installed = {entry.split(".")[-1] for entry in result["installed"] if ":capx.utils.launch_utils." in entry}
    assert installed == set(result["wrapped"])


def test_competition_client_records_model_calls(tmp_path):
    raw = os.environ.get("CAPX_UPSTREAM_DIR")
    if not raw:
        pytest.skip("CAPX_UPSTREAM_DIR is unset; provide a competition CaP-X checkout")
    upstream = Path(raw).resolve()
    fake = F.ScriptedLLM()
    with F.LoopbackServer(fake) as server:
        proc = _run(dedent(f"""\
            import json
            import os
            import threading
            from capx_trace_recorder import bootstrap, context as C
            from capx_trace_recorder.store import get_store

            os.environ['CAPX_TRACE_DIR'] = os.path.abspath('traces')
            os.environ['CAPX_LLM_TIMEOUT'] = '5'
            os.environ['CAPX_LLM_RETRY_DEADLINE_S'] = '10'
            bootstrap.activate()
            from capx.llm import client
            if not all(hasattr(client, name) for name in ('_before', '_body')):
                print('COMPETITION_TRACE=' + json.dumps({{'skip': True}}))
                raise SystemExit(0)

            assert getattr(threading.Thread.start, '__capx_trace_wrapper__', False)
            assert 'H1:threading.Thread.start' in C.REGISTRY.hooks_installed
            store = get_store()
            ep = C.open_episode(store, run_id='run', episode_id='ep', source='test')
            ep.emit('episode_start', data={{'tracer': {{}}}})
            role = C.RoleCtx('code_generator', 'initial_code', 0, ep)
            C.push_episode(ep)
            C.push_role(role)
            try:
                args = client.ModelQueryArgs(model='fixture/model', server_url={server.url + '/chat/completions'!r})
                prompt = [{{'role': 'user', 'content': 'Reply with the single word OK.'}}]
                query = client.query_model(args, prompt)
                stream = list(client.query_model_streaming(args, prompt))
                client.ENSEMBLE_CONFIGS = [('fixture/model', [0.1, 0.2, 0.3])]
                ensemble = client.query_model_ensemble(args, prompt, synthesis_model='fixture/synthesis')
            finally:
                C.pop_role(role)
                C.pop_episode(ep)
                C.close_episode(ep)
                assert store.flush(20)
            print('COMPETITION_TRACE=' + json.dumps({{
                'client': client.__file__, 'events': str(ep.events_path),
                'query': query, 'stream': stream[-1], 'ensemble': ensemble['content'],
            }}))
            """), upstream, tmp_path)

    result = _result(proc, "COMPETITION_TRACE=")
    if result.get("skip"):
        pytest.skip("checkout does not have the competition client's threaded transport")
    assert Path(result["client"]).resolve() == upstream / "capx" / "llm" / "client.py"
    assert result["query"]["content"] == result["stream"]["content"] == result["ensemble"] == "OK"
    assert len(fake.bodies) == 6
    events, corrupt, torn = read_events(Path(result["events"]))
    assert corrupt == 0 and not torn
    requests_by_id = {req["event_id"]: req["data"] for req in by_type(events, "model_request")}
    responses = by_type(events, "model_response")
    assert len(requests_by_id) == len(responses) == 6
    assert set(requests_by_id) == {response["parent_event_id"] for response in responses}
    assert Counter(req["call_kind"] for req in requests_by_id.values()) == {
        "initial_code": 2, "ensemble_member": 3, "ensemble_synthesis": 1,
    }
    for response in responses:
        req, data = requests_by_id[response["parent_event_id"]], response["data"]
        assert req["stream"] is True and req["reconstruction"]["verified"] is True
        assert data["logical_call_id"] == req["logical_call_id"]
        assert data["role"] == req["role"] == "code_generator"
        assert data["call_kind"] == req["call_kind"]
        assert data["http_status"] == 200 and data["content"] == "OK"

    stream, = [response["data"] for response in responses if response["data"]["streamed"]]
    assert stream["ttft_s"] >= 0 and stream["reasoning"]["text"] == "thinking briefly"
    returned = [response["data"] for response in responses if not response["data"]["streamed"]]
    assert all(data["source"] == "query_model_return_value" for data in returned)
    assert returned[0]["usage"] == result["query"]["usage"]
    assert returned[0]["reasoning"]["text"] == result["query"]["reasoning"]
