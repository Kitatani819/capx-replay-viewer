"""Browser acceptance of evaluations and one simulated missing-trial import."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from urllib.parse import urlencode

from playwright.sync_api import expect, sync_playwright


def check(base_url: str, fixture: Path, output: Path) -> None:
    manifest = json.loads((fixture / "manifest.json").read_text(encoding="utf-8"))
    evaluations = manifest["evals"]
    run_id, episode_id = evaluations["improved"], evaluations["regression_episode"]
    episode_api = f"/api/traces/runs/{run_id}/episodes/{episode_id}"
    trial_url = base_url + "/traces?" + urlencode({"run": run_id, "episode": episode_id})
    output.mkdir(parents=True, exist_ok=True)
    errors, passed = [], []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        page.set_default_timeout(12000)
        page.on("pageerror", lambda error: errors.append(str(error)))
        try:
            page.goto(base_url + "/evals")
            expect(page.get_by_role("table", name="評価一覧", exact=True)).to_be_visible()
            page.get_by_role("link", name="並列候補の変更（合成デモ）", exact=True).click()
            expect(page.get_by_role("table", name="評価の比較", exact=True)).to_be_visible()
            expect(page.get_by_text("悪化 1件", exact=True)).to_be_visible()
            expect(page.get_by_text("再試行あり", exact=True)).to_be_visible()
            expect(page.get_by_text("条件の違い：", exact=True)).to_be_visible()
            regression = page.get_by_role("link", name="失敗・悪化（基準は成功）", exact=True)
            expect(regression).to_have_class("eval-result eval-regression")
            page.screenshot(path=str(output / "comparison.png"), animations="disabled")
            passed.append("一覧から比較を開き、悪化・再試行・条件の違いを表示")
            regression.click()
            page.wait_for_function("document.querySelector('video')?.readyState >= 2")
            assert f"run={run_id}" in page.url and f"episode={episode_id}" in page.url
            page.go_back()
            expect(page.get_by_role("table", name="評価の比較", exact=True)).to_be_visible()
            passed.append("悪化したセルから録画を開き、ブラウザの戻るで比較へ戻る")

            # Simulate only discovery and transfer, using real synthetic trace data
            # after completion. No SSH connection or remote evaluation is started.
            original = page.request.get(base_url + episode_api).json()
            fetched, polls, posts = False, 0, []

            def summary(route):
                route.fulfill(status=200 if fetched else 404,
                              json=original if fetched else {"detail": "episode not found"})

            def fetch(route):
                assert route.request.method == "POST"
                posts.append(route.request.post_data_json)
                route.fulfill(json={"job_id": "synthetic-import"})

            def jobs(route):
                nonlocal fetched, polls
                polls += 1
                fetched = polls >= 3
                route.fulfill(json=[{"job_id": "synthetic-import", "run_id": run_id, "episode_id": episode_id,
                                     "state": "done" if fetched else "running", "bytes": 2048,
                                     "error": None, "note": None, "started_at": None, "finished_at": None}])

            page.route("**" + episode_api, summary)
            page.route("**/api/gmo/config", lambda route: route.fulfill(json={"enabled": True, "configured": True}))
            page.route("**/api/gmo/episodes?*", lambda route: route.fulfill(json=[{
                **original, "run_id": run_id, "episode_id": episode_id, "owner": "合成デモ",
                "mine": False, "size_bytes": 2048, "local_state": "remote", "conflict": False}]))
            page.route("**/api/gmo/fetch", fetch)
            page.route("**/api/gmo/jobs", jobs)
            page.goto(trial_url)
            expect(page.get_by_text("GMOから取り込み中（2.0 KB）", exact=True)).to_be_visible()
            expect(page.get_by_role("link", name="比較ページへ戻る", exact=True)).to_have_attribute("href", f"/evals/{run_id}")
            page.wait_for_function("document.querySelector('video')?.readyState >= 2")
            assert posts == [{"run_id": run_id, "episode_id": episode_id}]
            passed.append("未取得の試行1件だけを模擬GMOから取り込み、完了後に録画を表示")
            page.screenshot(path=str(output / "imported-trial.png"), animations="disabled")
            assert not errors, errors
            result = {"passed": passed, "page_errors": errors, "gmo": "simulated"}
            (output / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps(result, ensure_ascii=False))
        except Exception:
            page.screenshot(path=str(output / "failure.png"))
            (output / "failure.txt").write_text(page.locator("body").inner_text(), encoding="utf-8")
            raise
        finally:
            browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8390")
    parser.add_argument("--fixture", type=Path, default=Path("outputs/evals_demo"))
    parser.add_argument("--out", type=Path, default=Path("outputs/evals_checks"))
    args = parser.parse_args()
    check(args.base_url, args.fixture, args.out)
