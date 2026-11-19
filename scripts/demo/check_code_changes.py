"""Check the evaluation's lazy, escaped code diff using a synthetic fixture."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright


def check(base_url: str, fixture: Path, output: Path) -> None:
    manifest = json.loads((fixture / "manifest.json").read_text())
    output.mkdir(parents=True, exist_ok=True)
    errors, requests = [], []
    eval_id = manifest["evals"]["improved"]
    endpoint = f"/api/evals/{eval_id}/code-changes"
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("request", lambda request: requests.append(request.url) if request.url.endswith(endpoint) else None)
        try:
            page.goto(base_url + "/evals/" + eval_id)
            panel = page.locator(".eval-code-changes")
            expect(panel.locator(":scope > summary")).to_have_text("変更したコード（1ファイル）")
            assert not requests, "Collapsed code changes must not fetch the artifact"
            panel.locator(":scope > summary").click()
            file = panel.locator(".eval-code-files details")
            expect(file.locator("summary")).to_have_text("synthetic_method.py")
            file.locator("summary").click()
            expect(file.locator("pre")).to_contain_text("+use_parallel_ensemble = True")
            assert len(requests) == 1
            page.screenshot(path=str(output / "code-changes.png"), full_page=True)

            # A failed read is distinct from an empty diff, and can be retried.
            page.route("**" + endpoint, lambda route: route.fulfill(status=503, json={"detail": "synthetic unavailable"}))
            panel.locator(":scope > summary").click()
            panel.locator(":scope > summary").click()
            expect(panel.get_by_role("alert")).to_contain_text("synthetic unavailable")
            page.unroute("**" + endpoint)
            panel.get_by_role("button", name="再読み込み", exact=True).click()
            expect(panel.locator(".eval-code-files summary")).to_be_visible()

            # Code is text, including HTML-looking content in an imported diff.
            original = page.request.get(base_url + endpoint).json()
            original["artifact"]["files"][0]["diff"] = '+notice = "<script>window.syntheticDiffExecuted = true</script>"'
            page.route("**" + endpoint, lambda route: route.fulfill(json=original))
            panel.locator(":scope > summary").click()
            panel.locator(":scope > summary").click()
            panel.locator(".eval-code-files summary").click()
            expect(panel.locator("pre")).to_contain_text("<script>window.syntheticDiffExecuted")
            assert page.evaluate("window.syntheticDiffExecuted === undefined")
            page.set_viewport_size({"width": 390, "height": 844})
            assert panel.evaluate("el => el.getBoundingClientRect().right <= innerWidth && el.scrollWidth <= el.clientWidth")
            panel.screenshot(path=str(output / "code-changes-mobile.png"))
            page.goto(base_url + "/evals/" + manifest["evals"]["baseline"])
            page.locator(".eval-code-changes > summary").click()
            expect(page.locator(".eval-code-changes")).to_contain_text("コード差分が記録されていません")
            assert not errors, errors
            result = {"passed": ["lazy artifact loading", "file list and saved diff", "failed read and retry",
                                 "HTML is escaped text", "diff panel mobile layout", "legacy record explanation"], "page_errors": errors}
            (output / "result.json").write_text(json.dumps(result, indent=2) + "\n")
            print(json.dumps(result))
        except Exception:
            page.screenshot(path=str(output / "failure.png"), full_page=True)
            (output / "failure.txt").write_text(page.locator("body").inner_text())
            raise
        finally:
            browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:18436")
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=Path("outputs/code-change-checks"))
    args = parser.parse_args()
    check(args.base_url, args.fixture, args.out)
