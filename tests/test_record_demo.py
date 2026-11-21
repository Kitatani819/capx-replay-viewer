"""Demo navigation contracts, without starting Chromium or recording video."""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import pytest


ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def demo(monkeypatch):
    # Playwright is an optional dependency; these regressions only exercise orchestration.
    playwright = ModuleType("playwright")
    sync_api = ModuleType("playwright.sync_api")
    sync_api.sync_playwright = None
    monkeypatch.setitem(sys.modules, "playwright", playwright)
    monkeypatch.setitem(sys.modules, "playwright.sync_api", sync_api)
    spec = importlib.util.spec_from_file_location("record_demo", ROOT / "scripts/demo/record_demo.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_demo_recordings_and_screenshots_start_in_explicit_simple_view(demo, monkeypatch, tmp_path):
    args = SimpleNamespace(base_url="http://localhost:8290", run="demo", episode="trial",
                           trial_label="seed 1", block_label="3回目", api_call="api",
                           service_call="service", model_event="model", search="search",
                           out_dir=tmp_path, prefix="demo_", only=None)
    browser = SimpleNamespace(close=lambda: None)

    class Playwright:
        def __enter__(self):
            return SimpleNamespace(chromium=SimpleNamespace(launch=lambda: browser))

        def __exit__(self, *_args):
            pass

    urls = {}
    monkeypatch.setattr(demo, "parse_args", lambda: args)
    monkeypatch.setattr(demo, "sync_playwright", Playwright)
    monkeypatch.setattr(demo, "record", lambda _browser, url, scenario, *_args: (
        urls.update({scenario.stem: url}) or (tmp_path / "raw.webm", 0, 1)))
    monkeypatch.setattr(demo, "screenshots", lambda _browser, url, _args: urls.update(screens=url))
    monkeypatch.setattr(demo, "encode", lambda *_args: None)
    demo.main()
    assert set(urls) == {"scenario_simple", "scenario_details", "screens"}
    for url in urls.values():
        assert urlsplit(url).path == "/traces"
        assert parse_qs(urlsplit(url).query)["view"] == ["simple"]
    assert parse_qs(urlsplit(urls["scenario_details"]).query)["episode"] == ["trial"]


def test_demo_screenshots_and_details_scenario_use_current_replay_navigation(demo, tmp_path):
    clicks = []

    class Page:
        first = property(lambda self: self)

        def goto(self, *_args, **_kwargs):
            pass

        def wait_for_timeout(self, *_args):
            pass

        def screenshot(self, **_kwargs):
            pass

        def get_by_label(self, label):
            assert label == "実験を選ぶ"
            return self

        def locator(self, selector):
            assert selector == "option"
            return self

        def all_inner_texts(self):
            return ["demo"]

        def select_option(self, **_kwargs):
            pass

        def get_by_role(self, role, *, name, **_kwargs):
            assert role == "button"
            assert name in {"seed 1", "モデル出力", "実行ログ", "リプレイを見る"}
            clicks.append(name)
            return self

        def click(self):
            pass

        def evaluate(self, *_args):
            pass

        def close(self):
            pass

    page = Page()
    demo.screenshots(SimpleNamespace(new_page=lambda **_kwargs: page),
                     "http://localhost:8290/traces?view=simple",
                     SimpleNamespace(out_dir=tmp_path, run="demo", trial_label="seed 1", api_call="api"))
    assert clicks[-1] == "リプレイを見る"
    scenario = (ROOT / "scripts/demo/scenario_details.js").read_text(encoding="utf-8")
    assert "d.click(B, 'リプレイを見る'," in scenario
