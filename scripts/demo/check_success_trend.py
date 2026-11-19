"""Browser acceptance of the success-rate trend using synthetic evaluations only."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


def check(base_url: str, output: Path) -> None:
    output.mkdir(parents=True, exist_ok=True)
    errors = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        page.on("pageerror", lambda error: errors.append(str(error)))
        try:
            entries = page.request.get(base_url + "/api/evals").json()["evals"]
            ordered = sorted(entries, key=lambda entry: entry["eval"]["started_at"])
            assert len(ordered) == 2, "Use make_replay_demo.py --evals"
            page.goto(base_url + "/evals")
            chart = page.get_by_role("region", name="成功率の推移", exact=True)
            expect(chart.get_by_role("img")).to_be_visible()
            expect(chart.locator("circle")).to_have_count(2)
            assert chart.locator("svg a").evaluate_all("els => els.map(el => el.getAttribute('href'))") == [
                "/evals/" + entry["eval_id"] for entry in ordered]
            chart.locator("summary").click()
            rows = chart.get_by_role("table").locator("tbody tr")
            for index, entry in enumerate(ordered):
                summary = entry["summary"]
                expect(rows.nth(index)).to_contain_text(f"{summary['success']}/{summary['trials']}")
            page.screenshot(path=str(output / "trend-all.png"), full_page=True)
            page.get_by_label("推移に表示する課題").select_option("cube_lifting")
            for index, entry in enumerate(ordered):
                counts = entry["summary"]["by_task"]["cube_lifting"]
                expect(rows.nth(index)).to_contain_text(f"{counts['success']}/{counts['trials']}")
            expect(chart).to_contain_text("件数は評価全体の値です")
            page.screenshot(path=str(output / "trend-task.png"), full_page=True)
            chart.locator("svg a").first.click()
            expect(page).to_have_url(base_url + "/evals/" + ordered[0]["eval_id"])

            # The synthetic API data also exercises live/missing records without
            # creating or rewriting an evaluation on disk.
            changed = json.loads(json.dumps(ordered))
            changed[0]["eval"]["status"] = "running"
            changed[0]["display_status"] = "running"
            changed[0]["summary"]["unknown"] = 1
            changed[0]["summary"]["incomplete"] = 1
            changed[1]["summary"] = None
            changed[1]["eval"]["summary"] = None
            page.route("**/api/evals", lambda route: route.fulfill(json={"evals": changed}))
            page.goto(base_url + "/evals")
            expect(chart.locator("circle")).to_have_count(1)
            expect(chart.locator("circle.eval-trend-provisional")).to_have_count(1)
            chart.locator("summary").click()
            expect(chart.get_by_role("table")).to_contain_text("実行中・未判定 1件・記録欠損 1件")
            expect(chart.get_by_role("table")).to_contain_text("集計未記録")
            expect(chart.locator("polyline")).to_have_count(0)
            page.set_viewport_size({"width": 390, "height": 844})
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Page overflows mobile viewport"
            page.screenshot(path=str(output / "trend-mobile.png"), full_page=True)
            assert not errors, errors
            result = {"passed": ["start-time order", "recorded denominators", "task selection", "evaluation navigation",
                                 "live and missing summaries", "mobile layout"], "page_errors": errors}
            (output / "result.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
            print(json.dumps(result))
        except Exception:
            page.screenshot(path=str(output / "failure.png"), full_page=True)
            (output / "failure.txt").write_text(page.locator("body").inner_text(), encoding="utf-8")
            raise
        finally:
            browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:18434")
    parser.add_argument("--out", type=Path, default=Path("outputs/success-trend-checks"))
    args = parser.parse_args()
    check(args.base_url, args.out)
