"""The definition in a trace describes the function that actually ran."""

import inspect
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from capx_trace_recorder import context as C
from capx_trace_recorder import store as S
from capx_trace_recorder.config import TraceConfig
from capx_trace_recorder.hooks import api as API
from trace_reader import by_type, read_events


class WidgetApi:
    api_methods = ("grasp_widget",)

    def functions(self):
        return {name: getattr(self, name) for name in self.api_methods}

    def combined_doc(self):
        # Installation has a separate combined_doc preservation test. Keeping
        # this constant lets these tests count call-time introspection only.
        return "Synthetic widget API."

    def grasp_widget(self, phrase: str, height: float | None = None,
                     round_widget: bool = False) -> dict:
        """Grasp the requested widget.

        This second paragraph is not a summary.
        """
        return {"phrase": phrase, "height": height, "round_widget": round_widget}


@pytest.fixture
def definition_episode(tmp_path, monkeypatch):
    monkeypatch.setattr(API, "_SIGNATURES", {})
    monkeypatch.setattr(API, "_DEFINITIONS", {}, raising=False)
    store = S.TraceStore(TraceConfig(trace_dir=tmp_path / "traces"))
    ep = C.open_episode(store, run_id="widget-run", episode_id="ep", source="test")
    ep.emit("episode_start", data={"tracer": {}})
    C.push_episode(ep)
    yield store, ep
    C.pop_episode(ep)
    C.close_episode(ep)
    store.shutdown(5)


def recorded_start(episode):
    store, ep = episode
    assert store.flush(20)
    events, corrupt, torn = read_events(ep.events_path)
    assert corrupt == 0 and not torn
    return by_type(events, "api_call_start")[-1]["data"]


def call_widget(api, *args, **kwargs):
    assert API.install_api(api)[0]
    try:
        return api.grasp_widget(*args, **kwargs)
    finally:
        API.uninstall_api(api)


def test_records_annotations_defaults_and_first_doc_line(definition_episode):
    assert call_widget(WidgetApi(), "blue widget")["phrase"] == "blue widget"
    start = recorded_start(definition_episode)
    assert start["signature"] == (
        "(phrase: str, height: float | None = None, round_widget: bool = False) -> dict"
    )
    assert start["doc"] == "Grasp the requested widget."


def test_future_annotations_are_not_quoted(definition_episode):
    namespace = {"WidgetApi": WidgetApi}
    exec(compile(
        "from __future__ import annotations\n"
        "class FutureWidgetApi(WidgetApi):\n"
        "    def grasp_widget(self, phrase: str, height: float | None = None) -> dict[str, int]:\n"
        "        return {'count': 1}\n",
        "<synthetic-widget-api>", "exec", dont_inherit=True,
    ), namespace)
    assert call_widget(namespace["FutureWidgetApi"](), "widget") == {"count": 1}
    assert recorded_start(definition_episode)["signature"] == (
        "(phrase: str, height: float | None = None) -> dict[str, int]"
    )


def test_variadic_positional_only_and_keyword_only_markers(definition_episode):
    class VariadicWidgetApi(WidgetApi):
        def grasp_widget(self, phrase, /, *offsets: float, gentle: bool = True, **options: str):
            return phrase, offsets, gentle, options

    assert call_widget(VariadicWidgetApi(), "widget", 1.0, speed="slow") == (
        "widget", (1.0,), True, {"speed": "slow"},
    )
    start = recorded_start(definition_episode)
    assert start["signature"] == "(phrase, /, *offsets: float, gentle: bool = True, **options: str)"
    assert start["doc"] is None


def test_bare_keyword_only_marker(definition_episode):
    class KeywordWidgetApi(WidgetApi):
        def grasp_widget(self, *, gentle: bool = True):
            return gentle

    assert call_widget(KeywordWidgetApi()) is True
    assert recorded_start(definition_episode)["signature"] == "(*, gentle: bool = True)"


def test_default_repr_is_capped_at_eighty_characters(definition_episode):
    class LongDefault:
        def __repr__(self):
            return "x" * 1000

    class DefaultWidgetApi(WidgetApi):
        def grasp_widget(self, value=LongDefault()):
            return value

    sentinel = object()
    assert call_widget(DefaultWidgetApi(), sentinel) is sentinel
    assert recorded_start(definition_episode)["signature"] == "(value=" + "x" * 79 + "…)"


def test_entire_signature_is_capped_at_five_hundred_characters(definition_episode):
    class LongWidgetApi(WidgetApi):
        def grasp_widget(self, value):
            return value

    LongWidgetApi.grasp_widget.__annotations__["value"] = "Widget" * 150
    assert call_widget(LongWidgetApi(), 1) == 1
    signature = recorded_start(definition_episode)["signature"]
    assert len(signature) == 500 and signature.endswith("…")


def test_doc_skips_empty_lines_and_is_capped(definition_episode):
    class DocumentedWidgetApi(WidgetApi):
        def grasp_widget(self):
            return 1

    DocumentedWidgetApi.grasp_widget.__doc__ = "\n\n   " + "w" * 400 + "  \nDetails."
    assert call_widget(DocumentedWidgetApi()) == 1
    assert recorded_start(definition_episode)["doc"] == "w" * 299 + "…"


@pytest.mark.parametrize("error_type", [TypeError, ValueError, RuntimeError])
def test_signature_failure_keeps_the_call_and_records_null(definition_episode, monkeypatch, error_type):
    def fail(_func):
        raise error_type("synthetic introspection failure")

    monkeypatch.setattr(inspect, "signature", fail)
    assert call_widget(WidgetApi(), "widget")["phrase"] == "widget"
    start = recorded_start(definition_episode)
    assert start["signature"] is None
    assert start["doc"] == "Grasp the requested widget."


def test_doc_failure_does_not_lose_signature_or_call(definition_episode, monkeypatch):
    def fail(_func):
        raise RuntimeError("synthetic doc failure")

    monkeypatch.setattr(inspect, "getdoc", fail)
    assert call_widget(WidgetApi(), "widget")["phrase"] == "widget"
    start = recorded_start(definition_episode)
    assert start["signature"].startswith("(phrase: str,")
    assert start["doc"] is None


def test_default_repr_failure_does_not_lose_the_call(definition_episode):
    class BrokenDefault:
        def __repr__(self):
            raise RuntimeError("synthetic repr failure")

    class BrokenWidgetApi(WidgetApi):
        def grasp_widget(self, value=BrokenDefault()):
            return value

    assert call_widget(BrokenWidgetApi(), 7) == 7
    assert recorded_start(definition_episode)["signature"] is None


@pytest.mark.parametrize("fails", [False, True])
def test_definition_is_computed_once_per_function(definition_episode, monkeypatch, fails):
    counts = {"signature": 0, "doc": 0}
    real_signature, real_getdoc = inspect.signature, inspect.getdoc

    def signature(func):
        counts["signature"] += 1
        if fails:
            raise ValueError("synthetic introspection failure")
        return real_signature(func)

    def getdoc(func):
        counts["doc"] += 1
        if fails:
            raise ValueError("synthetic doc failure")
        return real_getdoc(func)

    monkeypatch.setattr(inspect, "signature", signature)
    monkeypatch.setattr(inspect, "getdoc", getdoc)
    for phrase in ("first widget", "second widget"):
        assert call_widget(WidgetApi(), phrase)["phrase"] == phrase
    start = recorded_start(definition_episode)
    assert "signature" in start and "doc" in start
    assert counts == {"signature": 1, "doc": 1}


def test_concurrent_definition_reads_compute_once(definition_episode, monkeypatch):
    counts = {"signature": 0, "doc": 0}
    real_signature, real_getdoc = inspect.signature, inspect.getdoc
    ready = threading.Barrier(4)
    signature_started, release_signature = threading.Event(), threading.Event()

    def signature(func):
        counts["signature"] += 1
        signature_started.set()
        assert release_signature.wait(5)
        return real_signature(func)

    def getdoc(func):
        counts["doc"] += 1
        return real_getdoc(func)

    def read_definition():
        ready.wait(5)
        return API._recorded_definition(WidgetApi.grasp_widget)

    monkeypatch.setattr(inspect, "signature", signature)
    monkeypatch.setattr(inspect, "getdoc", getdoc)
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(read_definition) for _ in range(4)]
        try:
            assert signature_started.wait(5)
        finally:
            release_signature.set()
        definitions = [future.result(timeout=5) for future in futures]
    assert all(definition == definitions[0] for definition in definitions)
    assert definitions[0][1] == "Grasp the requested widget."
    assert counts == {"signature": 1, "doc": 1}
