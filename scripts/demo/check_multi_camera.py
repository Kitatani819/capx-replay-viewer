"""Check labelled camera videos, shared playback and API following in a real browser.

Generate the fixture with ``make_replay_demo.py --cameras 3`` first. This script
uses an already running viewer; check_replay_platform.py handles launching in CI.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from urllib.parse import urlencode

from playwright.sync_api import expect, sync_playwright


def check(base_url: str, root: Path, output: Path) -> None:
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    assert manifest.get("cameras") == ["ego", "left_wrist", "right_wrist"], "Use a --cameras 3 fixture"
    output.mkdir(parents=True, exist_ok=True)
    url = base_url + "/traces?" + urlencode({"view": "details", "run": manifest["run"], "episode": manifest["episode"]})
    errors, passed, observations = [], [], {}
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1600, "height": 1000})
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.set_default_timeout(12000)
        try:
            page.goto(url)
            player = page.locator(".replay-player")
            videos = player.locator("video[data-camera]")
            main = player.locator('video[data-main-camera="true"]')
            secondary = player.locator('video[data-main-camera="false"]')
            expect(videos).to_have_count(3)
            expect(main).to_have_count(1)
            expect(secondary).to_have_count(2)
            page.wait_for_function("[...document.querySelectorAll('video[data-camera]')].every(v => v.readyState >= 2)")
            for label in ("頭", "左手首", "右手首"):
                assert any(node.is_visible() for node in player.get_by_text(label, exact=True).all()), label
            for camera in manifest["cameras"]:
                expect(player.locator(f'video[data-camera="{camera}"]')).to_have_count(1)
            assert secondary.evaluate_all("vs => vs.every(v => v.muted && v.playsInline && !v.controls)")
            expect(player.get_by_text("同期情報なし", exact=False)).to_have_count(0)
            passed.append("Three labelled camera recordings render, including combined-only R1Pro files")

            page.get_by_role("button", name="APIとPython", exact=True).click()
            selected = page.locator('[data-api-selected="true"]')
            expect(selected).to_have_count(1)
            initial_api = selected.get_attribute("data-api-event")
            main.evaluate("v => { v.playbackRate = 1; return v.play(); }")
            page.wait_for_function("document.querySelector('video[data-main-camera=true]').currentTime > .15")

            def sample_sync() -> None:
                sample = videos.evaluate_all("""vs => {
                    const main = vs.find(v => v.dataset.mainCamera === 'true');
                    return {time: main.currentTime, rate: main.playbackRate, paused: main.paused,
                        secondary: vs.filter(v => v !== main).map(v => ({time: v.currentTime,
                            rate: v.playbackRate, paused: v.paused}))};
                }""")
                assert not sample["paused"], sample
                for item in sample["secondary"]:
                    assert not item["paused"] and item["rate"] == sample["rate"], sample
                    assert abs(item["time"] - sample["time"]) <= .2, sample
                observations.setdefault("sync_samples", []).append(sample)

            for _ in range(6):
                sample_sync()
                page.wait_for_timeout(100)
            main.evaluate("v => v.pause()")
            page.wait_for_function("[...document.querySelectorAll('video[data-camera]')].every(v => v.paused)")
            position = main.evaluate("v => v.currentTime")
            chosen_api = selected.get_attribute("data-api-event")
            page.get_by_role("button", name="左手首をメインにする", exact=True).click()
            expect(main).to_have_attribute("data-camera", "left_wrist")
            page.wait_for_function("""time => {
                const main = document.querySelector('video[data-main-camera=true]');
                return !main.seeking && Math.abs(main.currentTime - time) < .05;
            }""", arg=position)
            assert main.evaluate("v => v.paused")
            expect(selected).to_have_attribute("data-api-event", chosen_api)
            assert main.evaluate("v => v.playbackRate") == 1
            passed.append("Secondary cameras mirror rate, play and pause; swapping retains position and selected API")

            # A native seek resumes following without selecting a row merely
            # because its video became the main camera.
            main.evaluate("v => { v.currentTime = 2.25; }")
            page.wait_for_function("document.querySelector('video[data-main-camera=true]').currentTime > 2.2")
            expect(selected).not_to_have_attribute("data-api-event", initial_api)
            expect(selected).to_contain_text("2.00")
            page.wait_for_function("new URLSearchParams(location.search).get('event') === document.querySelector('[data-api-selected=true]')?.dataset.apiEvent")
            main.evaluate("v => v.play()")
            page.wait_for_function("[...document.querySelectorAll('video[data-camera]')].every(v => !v.paused)")
            for _ in range(4):
                sample_sync()
                page.wait_for_timeout(100)
            main.evaluate("v => v.pause()")
            passed.append("The API list follows seek and playback after the main camera changes")

            layout = page.get_by_role("group", name="カメラの表示", exact=True)
            layout.get_by_role("button", name="1台", exact=True).click()
            expect(player.locator("video[data-camera]:visible")).to_have_count(1)
            assert page.evaluate("JSON.parse(localStorage.getItem('capx.replay.cameraLayout'))") == "single"
            layout.get_by_role("button", name="全カメラ", exact=True).click()
            expect(player.locator("video[data-camera]:visible")).to_have_count(3)
            for width in (1600, 760):
                page.set_viewport_size({"width": width, "height": 1000})
                page.wait_for_function("w => innerWidth === w", arg=width)
                page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
                assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1")
            page.screenshot(path=str(output / "multi-camera.png"), animations="disabled")
            passed.append("All-camera/single-camera layout switch persists and both desktop and narrow layouts fit")
            assert not errors, errors
            (output / "multi-camera-result.json").write_text(json.dumps({"url": url, "passed": passed,
                "page_errors": errors, "observations": observations}, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps({"multi_camera_passed": len(passed), "page_errors": errors}, ensure_ascii=False))
        except Exception:
            page.screenshot(path=str(output / "multi-camera-failure.png"))
            (output / "multi-camera-failure.txt").write_text(page.locator("body").inner_text(), encoding="utf-8")
            raise
        finally:
            browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8390")
    parser.add_argument("--fixture", type=Path, default=Path("outputs/multi_camera_demo"))
    parser.add_argument("--out", type=Path, default=Path("outputs/multi_camera_checks"))
    args = parser.parse_args()
    check(args.base_url, args.fixture, args.out)
