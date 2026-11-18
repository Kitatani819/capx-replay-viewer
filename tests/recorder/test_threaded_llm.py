"""H1 and H3 against the competition client's HTTP threading pattern."""

from __future__ import annotations

import functools
import gc
import json
import os
import threading
from collections import Counter
from concurrent.futures import Future, ThreadPoolExecutor
from types import SimpleNamespace

import pytest
import requests

import tracing_http_fakes as F
from capx_trace_recorder import bootstrap, context as C
from capx_trace_recorder.hooks import http, llm, services
from inprocess import Recorder, by_type


PROMPT = [{"role": "user", "content": "Reply with the single word OK."}]


def _before(call):
    result = Future()

    def run():
        try:
            result.set_result(call())
        except BaseException as exc:
            result.set_exception(exc)

    threading.Thread(target=run, daemon=True).start()
    return result.result(timeout=10)


def _post(args, prompt, *, sse=False):
    response = _before(functools.partial(requests.post, args.server_url, stream=True, timeout=5,
                                        json={"model": args.model, "messages": prompt, "stream": sse}))
    assert response._content is False  # H1 leaves the body to the client, including on 503.
    return response


def _body(response):
    read = functools.partial(response.raw.read1, 64 * 1024, decode_content=True)
    return _before(lambda: b"".join(iter(read, b"")))


def _query(args, prompt):
    for attempt in range(2):
        with _post(args, prompt) as response:
            if response.status_code == 503 and attempt == 0:
                continue
            response.raise_for_status()
            body = json.loads(_body(response))
            choice = body["choices"][0]
            return {**choice["message"], "usage": body["usage"],
                    "truncated": choice["finish_reason"] == "length"}


def _streaming(args, prompt):
    parts = {"content": [], "reasoning": []}
    with _post(args, prompt, sse=True) as response:
        response.raise_for_status()
        for line in _body(response).splitlines():
            if not line:
                continue
            if line == b"data: [DONE]":
                yield {"type": "done", **{key: "".join(values) for key, values in parts.items()}}
                break
            delta = json.loads(line.split(b": ", 1)[1])["choices"][0]["delta"]
            for key, text in delta.items():
                parts[key].append(text)
                yield {"type": f"{key}_delta", "content": text}


def _args(server, model="fake/model"):
    return SimpleNamespace(server_url=server.url + "/chat/completions", model=model)


@pytest.fixture()
def traced(tmp_path, monkeypatch):
    rec = Recorder(tmp_path / "traces", monkeypatch)
    ep = rec.open()
    # Restore the real methods after exercising the production installers.
    monkeypatch.setattr(requests.Session, "send", requests.Session.send)
    assert http.install(requests.sessions) is None
    monkeypatch.setattr(threading.Thread, "start", threading.Thread.start)
    assert http.install_thread_start() is None
    wrapper = threading.Thread.start
    assert http.install_thread_start() is None
    assert threading.Thread.start is wrapper
    try:
        yield rec, ep
    finally:
        rec.close()


def test_query_response_from_return_value(traced):
    rec, ep = traced
    role = C.RoleCtx("vdm", "image_diff", 0, ep)
    with F.LoopbackServer(F.ScriptedLLM()) as server:
        C.push_role(role)
        try:
            result = llm.make_query_model_wrapper(_query)(_args(server), PROMPT)
        finally:
            C.pop_role(role)

    events = rec.events(ep)
    request, = by_type(events, "model_request")
    response, = by_type(events, "model_response")
    assert response["parent_event_id"] == request["event_id"]
    assert request["data"]["stream"] is True
    assert request["data"]["reconstruction"] == {"verified": True, "method": "json_roundtrip"}
    data = response["data"]
    assert data["logical_call_id"] == request["data"]["logical_call_id"]
    assert data["http_status"] == 200 and data["latency_s"] > 0
    assert data["content"] == result["content"] == "OK"
    assert data["reasoning"] == {"text": "short reasoning", "field": "query_model_return.reasoning"}
    assert data["usage"] == result["usage"] == {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
    assert data["streamed"] is False and data["body_captured"] is False
    for key in ("n_chunks", "ttft_s", "finish_reason", "response_model", "response_id"):
        assert data[key] is None
    assert data["source"] == "query_model_return_value"
    assert data["payload_path"] == f"payloads/{response['event_id']}.response.json"
    assert any(artifact.get("assembled_from_return_value") is True for artifact in response["artifacts"])
    payload = json.loads((ep.base_dir / data["payload_path"]).read_text())
    assert payload == {key: result[key] for key in ("content", "reasoning", "usage", "truncated")}
    assert ep.vdm_responses == [(response["event_id"], "OK")]


def test_truncated_reply_keeps_json_safe_usage(traced):
    rec, ep = traced

    def query(args, prompt):
        result = _query(args, prompt)
        result["truncated"] = True
        result["usage"]["reasoning_tokens"] = float("inf")
        return result

    with F.LoopbackServer(F.ScriptedLLM()) as server:
        result = llm.make_query_model_wrapper(query)(_args(server), PROMPT)

    response, = by_type(rec.events(ep), "model_response")
    assert result["usage"]["reasoning_tokens"] == float("inf")
    assert response["data"]["finish_reason"] == "length"
    assert response["data"]["usage"]["reasoning_tokens"] == "inf"


def test_stream_transport_records_503_then_success(traced):
    rec, ep = traced
    with F.LoopbackServer(F.ScriptedLLM(fail_first=1)) as server:
        assert llm.make_query_model_wrapper(_query)(_args(server), PROMPT)["content"] == "OK"

    events = rec.events(ep)
    first, second = by_type(events, "model_request")
    err, = by_type(events, "model_error")
    reply, = by_type(events, "model_response")
    assert [event["data"]["http_attempt"] for event in (first, err, second, reply)] == [1, 1, 2, 2]
    assert len({event["data"]["logical_call_id"] for event in (first, err, second, reply)}) == 1
    assert err["parent_event_id"] == first["event_id"]
    assert err["data"]["scope"] == "attempt" and err["data"]["http_status"] == 503
    assert err["data"]["body_excerpt"] is None and err["data"]["reason"] == "stream_body_not_read"
    assert reply["parent_event_id"] == second["event_id"] and reply["data"]["http_status"] == 200


def test_threaded_sse_records_stream_timing(traced):
    rec, ep = traced
    with F.LoopbackServer(F.ScriptedLLM()) as server:
        chunks = list(llm.make_streaming_wrapper(_streaming)(_args(server), PROMPT))

    assert chunks[-1] == {"type": "done", "content": "OK", "reasoning": "thinking briefly"}
    events = rec.events(ep)
    request, = by_type(events, "model_request")
    response, = by_type(events, "model_response")
    assert response["parent_event_id"] == request["event_id"]
    data = response["data"]
    assert data["streamed"] is True and data["http_status"] == 200
    assert 0 <= data["ttft_s"] <= data["latency_s"]
    assert data["content"] == "OK" and data["n_chunks"] == 3


def test_ensemble_member_and_synthesis_requests_and_responses(traced):
    rec, ep = traced
    query = llm.make_query_model_wrapper(_query)

    def ensemble(server):
        with ThreadPoolExecutor(max_workers=3) as pool:
            members = [pool.submit(query, _args(server, f"fake/member-{i}"), PROMPT) for i in range(3)]
            assert [member.result(timeout=10)["content"] for member in members] == ["OK"] * 3
        return query(_args(server, "fake/synthesis"), PROMPT)

    with F.LoopbackServer(F.ScriptedLLM()) as server:
        assert llm.make_ensemble_wrapper(ensemble)(server)["content"] == "OK"

    events = rec.events(ep)
    requests_by_id = {request["event_id"]: request["data"] for request in by_type(events, "model_request")}
    responses = by_type(events, "model_response")
    assert set(requests_by_id) == {response["parent_event_id"] for response in responses}
    assert len(requests_by_id) == len(responses) == 4
    assert Counter(req["call_kind"] for req in requests_by_id.values()) == {"ensemble_member": 3, "ensemble_synthesis": 1}
    for response in responses:
        req, data = requests_by_id[response["parent_event_id"]], response["data"]
        assert data["logical_call_id"] == req["logical_call_id"]
        assert data["role"] == req["role"] == "code_generator"
        assert data["call_kind"] == req["call_kind"]


def test_unscoped_daemon_request_is_ignored(traced):
    rec, ep = traced
    fake = F.ScriptedLLM()
    with F.LoopbackServer(fake) as server, _post(_args(server), PROMPT) as response:
        assert response.status_code == 200
    assert len(fake.bodies) == 1
    assert [event["event_type"] for event in rec.events(ep)] == ["episode_start"]


def test_pool_worker_never_inherits_the_call(traced):
    rec, ep = traced
    fake = F.ScriptedLLM()
    with F.LoopbackServer(fake) as server, ThreadPoolExecutor(max_workers=1) as pool:
        def first_job(_args, _prompt):
            def probe():
                assert C.inherited_http_context() is None
                return threading.get_ident()

            return pool.submit(probe).result(timeout=10)

        def second_job():
            with requests.post(_args(server).server_url, json={"messages": PROMPT}, timeout=5) as response:
                assert response.status_code == 200
            return threading.get_ident()

        worker_id = llm.make_query_model_wrapper(first_job)(_args(server), PROMPT)
        assert pool.submit(second_job).result(timeout=10) == worker_id
    assert len(fake.bodies) == 1
    assert [event["event_type"] for event in rec.events(ep)] == ["episode_start"]


@pytest.mark.parametrize("raises", [False, True])
def test_abandoned_send_after_call_closes_is_ignored(traced, raises):
    rec, ep = traced
    fake = F.ScriptedLLM()
    release = threading.Event()
    result = Future()
    marker = RuntimeError("original error")

    def run(args):
        try:
            assert release.wait(timeout=10)
            with requests.post(args.server_url, json={"messages": PROMPT}, timeout=5) as response:
                result.set_result(response.status_code)
        except BaseException as exc:
            result.set_exception(exc)

    with F.LoopbackServer(fake) as server:
        args = _args(server)
        thread = threading.Thread(target=run, args=(args,), daemon=True)
        calls = []

        def abandon(args, prompt):
            calls.append(C.innermost())  # keep the weakref live to exercise the finished flag
            thread.start()
            if raises:
                raise marker
            return "original return"

        query = llm.make_query_model_wrapper(abandon)
        try:
            if raises:
                with pytest.raises(RuntimeError) as error:
                    query(args, PROMPT)
                assert error.value is marker
            else:
                assert query(args, PROMPT) == "original return"
            assert calls[0].finished is True
        finally:
            release.set()
            thread.join(timeout=10)
        assert result.result(timeout=10) == 200
    assert len(fake.bodies) == 1
    events = rec.events(ep)
    assert by_type(events, "model_request") == by_type(events, "model_response") == []
    assert [error["data"]["scope"] for error in by_type(events, "model_error")] == (["logical"] if raises else [])


def test_cached_http_body_is_recorded_once(traced):
    rec, ep = traced

    def query(args, prompt):
        response = requests.post(args.server_url, json={"model": args.model, "messages": prompt}, timeout=5)
        return response.json()["choices"][0]["message"]

    with F.LoopbackServer(F.ScriptedLLM()) as server:
        assert llm.make_query_model_wrapper(query)(_args(server), PROMPT)["content"] == "OK"

    events = rec.events(ep)
    request, = by_type(events, "model_request")
    response, = by_type(events, "model_response")
    assert response["parent_event_id"] == request["event_id"]
    assert response["data"]["finish_reason"] == "stop"
    assert response["data"].get("source") != "query_model_return_value"


def test_daemon_service_send_is_attributed_without_exposing_the_context_stack(traced):
    rec, ep = traced

    def send(url):
        assert C.innermost() is None
        with requests.post(url, json={"target": [0]}, timeout=5) as response:
            return response.json()

    with F.LoopbackServer(F.ScriptedLLM()) as server:
        def solve(url):
            return _before(functools.partial(send, url))

        run_ik = services.make_service_wrapper(solve, "pyroki", "ik_solve_fn")
        assert run_ik(server.url + "/ik") == {"joint_positions": [0.1] * 7}

    events = rec.events(ep)
    end, = by_type(events, "service_call_end")
    attempt, = end["data"]["http_attempts"]
    assert attempt["status"] == 200 and attempt["endpoint"].endswith("/ik")
    assert by_type(events, "model_request") == []


def test_worker_context_is_weak_and_invalidated_by_fork_reset(monkeypatch):
    worker = threading.Thread(target=lambda: None)
    ctx = C.LogicalCall("test", None, "code_generator", "initial_code", 0, "fake/model", None, "test")
    C.push_ctx(ctx)
    try:
        C.prepare_http_thread(worker)
    finally:
        C.pop_ctx(ctx)

    monkeypatch.setattr(threading, "current_thread", lambda: worker)
    assert C.inherited_http_context() is ctx
    with monkeypatch.context() as reset:
        for name in ("REGISTRY", "_THREAD", "_HTTP_CONTEXT_GENERATION"):
            reset.setattr(C, name, getattr(C, name))
        C.reset_registry_after_fork()
        assert C.inherited_http_context() is None
    assert C.inherited_http_context() is ctx
    del ctx
    gc.collect()
    assert C.inherited_http_context() is None


def test_thread_start_install_failure_is_reported(tmp_path, monkeypatch):
    def fail(*_args):
        raise AttributeError("unpatchable")

    monkeypatch.setenv("CAPX_TRACE_DIR", str(tmp_path))
    monkeypatch.setattr(C, "REGISTRY", C.Registry())
    monkeypatch.setattr(bootstrap, "_ACTIVE_RECORDER", "public")
    monkeypatch.setattr(bootstrap, "_H11_OK", True)
    monkeypatch.setattr(requests.Session, "send", requests.Session.send)
    monkeypatch.setattr(http, "patch_attribute", fail)
    bootstrap._patch_requests(requests.sessions)

    assert requests.Session.send.__capx_trace_wrapper__ is True
    status_path, = tmp_path.glob(f"recorder_status.{os.getpid()}.*.json")
    status = json.loads(status_path.read_text())
    assert status["active"] == "public"
    assert status["hooks_failed"] == [{"hook": "H1", "target": "threading.Thread.start",
                                       "reason": "Thread.start: AttributeError"}]
