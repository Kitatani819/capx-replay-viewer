"""Perception outputs above the array budget are reported (docs/trace-format.md, sections 4.4 and 5.3).

SAM3 may return up to 200 masks of 512x512 per call,
and the per-call budget that was the default then (CAPX_TRACE_ARRAY_CALL_MB = 8)
held 32 of them. The default is now 64 MB, which holds 200. Masks beyond the
budget keep only shape, dtype and sha256; the service call must then carry
``array_budget_exceeded`` and an ``array_budget`` warning, so the episode is not
shown as complete.
"""

from __future__ import annotations

import json

import numpy as np
import pytest

from capx_trace_recorder import context as C
from capx_trace_recorder import store as S
from capx_trace_recorder.config import TraceConfig
from capx_trace_recorder.hooks import services
from capx_trace_recorder.hooks.services import make_service_wrapper
from trace_reader import by_type, read_events


def _masks(n: int) -> list[dict]:
    out = []
    for i in range(n):
        mask = np.zeros((64, 64), dtype=bool)
        mask[i % 64, :] = True
        out.append({"mask": mask, "score": 0.5, "label": "red cube"})
    return out


def _run(work_dir, n_masks: int, call_mb: float) -> tuple[dict, list[dict]]:
    store = S.TraceStore(TraceConfig(trace_dir=work_dir / "traces", array_call_mb=call_mb))
    ep = C.open_episode(store, run_id="svc-run", episode_id="ep", source="test")
    ep.emit("episode_start", data={"tracer": {}})
    C.push_episode(ep)
    try:
        seg = make_service_wrapper(lambda image, text: _masks(n_masks), "sam3", "sam3_seg_fn")
        result = seg(np.zeros((4, 4, 3), dtype=np.uint8), "red cube")
        assert len(result) == n_masks
    finally:
        C.pop_episode(ep)
    ep.emit("episode_end", data={"end_reason": "completed"})
    ep.ended = True
    assert store.flush(20)
    events, _corrupt, _torn = read_events(ep.events_path)
    doc = json.loads((ep.base_dir / "episode.json").read_text())
    C.close_episode(ep)
    store.shutdown(5)
    return doc, events


def test_masks_beyond_the_call_budget_are_reported(work_dir):
    # 64x64 bool masks are 4 KiB each; a 0.01 MiB budget holds two of them
    doc, events = _run(work_dir, 5, 0.01)
    end = by_type(events, "service_call_end")[0]["data"]
    items = end["response_summary"]["items"]
    saved = [i["items"]["mask"] for i in items if "npz" in i["items"]["mask"]]
    skipped = [i["items"]["mask"] for i in items if i["items"]["mask"].get("not_saved") == "array_budget"]
    assert len(saved) == 2 and len(skipped) == 3 and all(m["sha256"] for m in skipped)
    assert end["array_budget_exceeded"] == 3
    warning = by_type(events, "trace_warning")[0]["data"]
    assert warning["code"] == "array_budget"
    assert doc["trace_complete"] is False and [g["code"] for g in doc["gaps"]] == ["array_budget"]


def test_outputs_within_the_budget_leave_the_trace_complete(work_dir):
    doc, events = _run(work_dir, 3, 1.0)
    end = by_type(events, "service_call_end")[0]["data"]
    assert "array_budget_exceeded" not in end
    assert by_type(events, "trace_warning") == []
    assert doc["trace_complete"] is True


def test_service_signature_cache_is_per_wrapper_and_keeps_binding_fallback(monkeypatch):
    signatures = []

    def capture(service, function, fn, args, kwargs, cache):
        signatures.append(services._bind(fn, args, kwargs, cache))
        return None

    monkeypatch.setattr(services, "_service_before", capture)
    real_signature = services.inspect.signature
    inspected = []

    def inspect_once(fn):
        inspected.append(fn)
        return real_signature(fn)

    monkeypatch.setattr(services.inspect, "signature", inspect_once)

    def first(image, /, *, text="cube"):
        return image, text

    def second(value, **options):
        return value, options

    one = make_service_wrapper(first, "sam3", "sam3_seg_fn")
    two = make_service_wrapper(second, "sam3", "sam3_point_prompt_fn")
    assert one(1, text="box") == (1, "box")
    assert one(2) == (2, "cube")
    assert two(3, label="red") == (3, {"label": "red"})
    assert signatures == [{"image": 1, "text": "box"}, {"image": 2},
                          {"value": 3, "options": {"label": "red"}}]
    assert inspected == [first, second]
    # A mismatched call still gets the same positional fallback and the
    # original function's TypeError, rather than a stale binding from a prior call.
    with pytest.raises(TypeError):
        one(4, 5)
    assert signatures[-1] == {"arg0": 4, "arg1": 5}
    assert inspected == [first, second]


def test_uninspectable_service_signature_and_trial_alarm_are_not_confused(monkeypatch):
    cache = [services._SIGNATURE_UNSET]
    monkeypatch.setattr(services.inspect, "signature", lambda _fn: (_ for _ in ()).throw(ValueError("unknown")))
    assert services._bind(object(), (1,), {"text": "cube"}, cache) == {"arg0": 1, "text": "cube"}
    # Inspect failure is cached on this wrapper, with the positional fallback.
    monkeypatch.setattr(services.inspect, "signature", lambda _fn: (_ for _ in ()).throw(TimeoutError()))
    assert services._bind(object(), (2,), {}, cache) == {"arg0": 2}
    fresh = [services._SIGNATURE_UNSET]
    with pytest.raises(TimeoutError):
        services._bind(object(), (), {}, fresh)
    assert fresh[0] is services._SIGNATURE_UNSET
