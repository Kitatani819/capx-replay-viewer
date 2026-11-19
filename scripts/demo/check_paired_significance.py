"""Browser acceptance for paired outcomes and conservative rerun references.

Run against a local viewer serving the synthetic fixture. No SSH or GPU is used.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from capx_trace_viewer import evals


def add_fixture(fixture: Path) -> None:
    ids = ("ev-sign-base", "ev-sign-current", "ev-sign-repeat", "ev-sign-small", "ev-sign-down")
    for index, run_id in enumerate(ids):
        run = fixture / "traces" / run_id
        run.mkdir(parents=True, exist_ok=True)
        for seed in range(1, 8):
            success = run_id in ("ev-sign-current", "ev-sign-repeat") or seed == 7
            if run_id == "ev-sign-repeat" and seed == 1:
                success = False
            if run_id == "ev-sign-small":
                success = seed < 3 or seed == 7
            directory = run / f"synthetic-{seed}"
            directory.mkdir(exist_ok=True)
            raw = {"task": "synthetic_cube", "condition": "C", "seed": seed, "status": "ended",
                   "trace_complete": True, "end_reason": "completed", "harness_summary": {"task_completed": success},
                   "config_flags": {"multi_turn": True}, "models": {"code_generator": {"model": "synthetic-model"}},
                   "env": {"class": "synthetic.Env", "low_level_class": "synthetic.Low"},
                   "stop_context": {"step_limit": 1500, "trial_time_limit_s": 0, "trial_attempt_limit": 1,
                                    "success_policy": "per_cycle_sticky", "evaluation_budget_s": 2100,
                                    "steps_used": 10 + seed, "evaluation_elapsed_s": seed}}
            (directory / "episode.json").write_text(json.dumps(raw), encoding="utf-8")
        baseline = "ev-sign-current" if run_id == "ev-sign-down" else "ev-sign-base" if index else None
        stamp = f"2026-11-20T00:0{index}:00Z"
        record = {"schema": "capx-eval/1", "eval_id": run_id, "status": "completed",
                  "end": {"exit_code": 0, "signal": None}, "by": "合成テスト", "changed": run_id,
                  "baseline_eval_id": baseline, "eval_set": "synthetic-paired-7",
                  "git": {"commit": ("b" if run_id in ("ev-sign-current", "ev-sign-repeat") else "a") * 40,
                          "dirty": False, "diff_sha256": None},
                  "started_at": stamp, "heartbeat_at": stamp, "ended_at": stamp,
                  "summary": evals.summarize_run(fixture / "traces", run_id)}
        evals.validate_eval_record(record)
        (run / "eval.json").write_text(json.dumps(record), encoding="utf-8")


def check(base_url: str, fixture: Path, output: Path) -> None:
    add_fixture(fixture)
    output.mkdir(parents=True, exist_ok=True)
    errors, passed = [], []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 1100})
        page.set_default_timeout(12000)
        page.on("pageerror", lambda error: errors.append(str(error)))
        try:
            page.goto(base_url + "/evals/ev-sign-current")
            panel = page.get_by_role("region", name="差とぶれの確認")
            expect(panel.get_by_text("はっきり改善", exact=True)).to_be_visible()
            expect(panel.get_by_text("判定済み 7組", exact=False)).to_be_visible()
            expect(panel.get_by_text("7組中 1組（14.3%）", exact=False)).to_be_visible()
            expect(panel.get_by_role("link", name="ev-sign-repeat")).to_have_attribute("href", "/evals/ev-sign-repeat")
            panel.get_by_text("検定の見方（p値 0.0313）", exact=True).click()
            expect(panel.get_by_text("p値は「改善が偶然である確率」ではありません。", exact=False)).to_be_visible()
            page.screenshot(path=str(output / "paired-improvement.png"), full_page=True, animations="disabled")
            passed.append("同じseedの6改善・0悪化で正確検定p=0.0313と改善を表示、同コード再実行の1/7変動を別に表示")
            page.goto(base_url + "/evals/ev-sign-small")
            expect(page.get_by_text("ぶれの範囲内か、試行数が足りません", exact=True)).to_be_visible()
            expect(page.get_by_text("差がないと分かったわけではありません。", exact=False)).to_be_visible()
            passed.append("2改善・0悪化は差なしと断定せず不確実性を表示")
            page.goto(base_url + "/evals/ev-sign-down")
            expect(page.get_by_text("はっきり悪化", exact=True)).to_be_visible()
            passed.append("0改善・6悪化で悪化を表示")
            page.set_viewport_size({"width": 390, "height": 844})
            panel = page.get_by_role("region", name="差とぶれの確認")
            expect(panel).to_be_visible()
            assert panel.evaluate("element => element.scrollWidth <= element.clientWidth + 1")
            page.screenshot(path=str(output / "paired-mobile.png"), full_page=True, animations="disabled")
            passed.append("390px幅で検定パネルがはみ出さない")
            assert not errors, errors
            result = {"passed": passed, "page_errors": errors, "fixture": "synthetic"}
            (output / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps(result, ensure_ascii=False))
        finally:
            browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:18431")
    parser.add_argument("--fixture", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    check(args.base_url, args.fixture, args.out)
