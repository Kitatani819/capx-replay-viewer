"""Acceptance flow for the video-left/log-below/three-detail-tabs replay layout."""
import argparse
import json
import re
from pathlib import Path
from urllib.parse import urlencode

from playwright.sync_api import expect, sync_playwright


def check(base_url: str, root: Path, output: Path):
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    output.mkdir(parents=True, exist_ok=True)
    errors, passed, observations = [], [], {}
    url = base_url + "/traces?" + urlencode({"view": "details", "run": manifest["run"], "episode": manifest["episode"]})
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1600, "height": 1000})
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.set_default_timeout(12000)
        try:
            page.goto(url)
            video = page.get_by_label("試行の録画", exact=True)
            page.wait_for_function("document.querySelector('video[aria-label=\"試行の録画\"]')?.readyState >= 2")
            expect(page.get_by_text("フレーム記録から同期", exact=False)).to_be_visible()
            expect(page.get_by_role("tab")).to_have_count(3)
            page.evaluate("window.__acceptanceVideo = document.querySelector('video[aria-label=\"試行の録画\"]')")

            def cue(name):
                return page.locator(f'[data-replay-event="{manifest["events"][name]}"]')

            def all_turns():
                page.get_by_label("リプレイのターン", exact=True).select_option("all")

            def paused_same(expected):
                page.wait_for_function("!document.querySelector('video').seeking")
                assert video.evaluate("v => v === window.__acceptanceVideo && v.paused")
                assert abs(video.evaluate("v => v.currentTime") - expected) < .02

            def tab(label):
                before = video.evaluate("v => v.currentTime")
                page.get_by_role("tab", name=label, exact=True).click()
                expect(page.get_by_role("tab", name=label, exact=True)).to_have_attribute("aria-selected", "true")
                paused_same(before)

            left = page.locator('[data-replay-pane="left"]').bounding_box()
            right = page.locator('[data-replay-pane="details"]').bounding_box()
            recording = video.bounding_box()
            logs = page.locator('[data-replay-log-panel]').bounding_box()
            assert right["x"] >= left["x"] + left["width"] - 1
            assert logs["y"] >= recording["y"] + recording["height"] - 1
            assert recording["x"] < right["x"] and logs["x"] < right["x"]
            observations["desktop_bounds"] = {"video": recording, "logs": logs, "details": right}
            passed.append("Desktop layout: video left, process logs below it, exactly three detail tabs on the right")

            video.evaluate("v => { v.currentTime = 0; v.playbackRate = .5; return v.play(); }")
            page.wait_for_function("document.querySelector('video').currentTime > .3")
            video.evaluate("v => v.pause()")
            assert page.locator('[data-current="true"]').count() == 1
            all_turns()
            cue("sam_0").click()
            tab("入出力")
            panel = page.get_by_role("tabpanel")
            expect(panel).to_contain_text("red cube")
            expect(panel.locator('img[src*="/array-image/"]').first).to_be_visible()
            expect(panel.get_by_text("入力（サービスが受け取ったデータ）", exact=True).first).to_be_visible()
            panel.locator('img[src*="/array-image/"]').first.click()
            expect(page.get_by_role("dialog")).to_be_visible()
            page.screenshot(path=str(output / "sam-mask.png"), animations="disabled")
            page.get_by_role("button", name="閉じる", exact=True).click()
            paused_same(0)
            passed.append("Play, pause, select SAM3 log, inspect recorded image/instruction and open returned mask while paused")

            cue("vdm_1").click()
            expect(panel).to_contain_text("below the target height")
            expect(panel).to_contain_text("出典: VDM")
            expect(panel.locator('img').first).to_be_visible()
            assert panel.locator('img').count() >= 2
            vdm_time = video.evaluate("v => v.currentTime")
            cue("candidate_1").click()
            paused_same(vdm_time)
            expect(cue("candidate_1")).to_have_attribute("data-current", "true")
            cue("vdm_1").click()
            paused_same(vdm_time)
            expect(cue("vdm_1")).to_have_attribute("data-current", "true")
            page.screenshot(path=str(output / "vdm-paused.png"), animations="disabled")
            passed.append("VDM images/explanation and co-located candidate/VDM logs remain individually selectable with video paused")

            cue("candidate_1").click()
            tab("候補")
            expect(page.locator('[data-candidate]')).to_have_count(9)
            expect(page.locator('[data-synthesis]')).to_have_count(0)
            expect(page.locator('[id^="ensemble-input-"]')).to_have_count(1)
            page.locator('[data-candidate="1"] > summary').click()
            expect(page.locator('[data-candidate="1"]')).to_contain_text("統合入力に全文一致（送信を確認）")
            page.locator('[data-candidate="1"]').get_by_text("共通入力を開く", exact=True).click()
            expect(page.locator('[id^="ensemble-input-"]')).to_have_attribute("open", "")
            expect(page.locator('[data-candidate="7"] > summary')).to_contain_text("トークン上限")
            expect(page.locator('[data-candidate="8"] > summary')).to_contain_text("エラー")
            expect(page.locator('[data-candidate="9"] > summary')).to_contain_text("ストリーム中断")
            page.locator('[data-candidate="8"] > summary').click()
            expect(page.locator('[data-candidate="8"]')).to_contain_text("synthetic candidate error")
            page.locator('[data-candidate="9"] > summary').click()
            expect(page.locator('[data-candidate="9"]')).to_contain_text("partial stream")
            page.screenshot(path=str(output / "candidates.png"), animations="disabled")
            tab("統合結果")
            expect(page.locator('[data-candidate]')).to_have_count(0)
            synthesis = page.locator('[data-synthesis]')
            expect(synthesis).to_have_count(1)
            expect(synthesis).to_contain_text("REGENERATE（修正）")
            synthesis.get_by_text("統合時に実際に渡された入力", exact=True).click()
            expect(synthesis).to_contain_text("<candidate_solutions>")
            page.screenshot(path=str(output / "synthesis.png"), animations="disabled")
            paused_same(vdm_time)
            synthesis.get_by_role("button", name=re.compile("実行されたPythonへ")).click()
            expect(page.get_by_role("tab", name="入出力", exact=True)).to_have_attribute("aria-selected", "true")
            expect(panel).to_contain_text("実際に実行したPython")
            expect(panel).to_contain_text("Success!")
            expect(panel).to_contain_text("stdout")
            expect(panel).to_contain_text("stderr")
            assert video.evaluate("v => v.paused")
            passed.append("Candidate tab: nine candidates/shared input/errors/truncation; synthesis tab: actual input, REGENERATE and executable Python link")

            all_turns()
            cue("candidate_2").click()
            tab("候補")
            expect(page.locator('[data-candidate]')).to_have_count(3)
            tab("統合結果")
            expect(page.locator('[data-synthesis]')).to_contain_text("FINISH（終了・モデルの主張）")
            all_turns()
            cue("synthesis_0").click()
            expect(page.locator('[data-synthesis]')).to_contain_text("Pythonコード")
            passed.append("Recorded candidate count may be three; Python, REGENERATE and FINISH are distinguished per turn")

            video.evaluate("v => { v.currentTime = .2; v.playbackRate = 2; return v.play(); }")
            page.wait_for_function("document.querySelector('video').currentTime > 2.2")
            assert not video.evaluate("v => v.paused")
            video.evaluate("v => v.pause()")
            expect(page.get_by_role("tab", name="統合結果", exact=True)).to_have_attribute("aria-selected", "true")
            assert page.locator('[data-current="true"]').count() == 1
            page.wait_for_function("new URLSearchParams(location.search).get('event') === document.querySelector('[data-current=true]')?.dataset.replayEvent")
            page.get_by_role("button", name="2秒巻き戻す", exact=True).click()
            assert video.evaluate("v => v.currentTime") < 1
            passed.append("Native seek and replay resume event following across turns without remounting video or overriding chosen tab; rewind works")

            page.get_by_role("button", name="詳細ログ", exact=True).click()
            page.get_by_label("タイムラインを検索").fill("sam3_seg_fn")
            page.locator(f'[data-timeline-event="{manifest["events"]["sam_0"]}"]').click()
            paused_same(0)
            page.get_by_role("button", name="処理タイムライン", exact=True).click()
            expect(cue("sam_0")).to_have_attribute("data-current", "true")
            tab("入出力")
            page.screenshot(path=str(output / "replay-layout.png"), animations="disabled")
            passed.append("Detailed causal log below video can seek and pause at SAM3; compact timeline retains the same selection")

            page.emulate_media(reduced_motion="reduce")
            reduced = cue("sam_0").evaluate("el => getComputedStyle(el).animationDuration")
            assert all(float(value.strip().removesuffix('s')) <= .001 for value in reduced.split(',')), reduced
            # Width saved on a large display must not squeeze details to a few pixels.
            page.set_viewport_size({"width": 1000, "height": 900})
            page.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
            right = page.locator('[data-replay-pane="details"]').bounding_box()
            assert right["width"] >= 420, right
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1")
            page.set_viewport_size({"width": 760, "height": 900})
            # Chromium may report the new innerWidth before viewport-relative CSS
            # is laid out. Inspect responsive geometry after the next paint.
            page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
            left = page.locator('[data-replay-pane="left"]').bounding_box()
            right = page.locator('[data-replay-pane="details"]').bounding_box()
            assert right["y"] >= left["y"] + left["height"] - 1
            overflow = page.evaluate("""() => ({viewport:innerWidth, scroll:document.documentElement.scrollWidth,
                elements:[...document.querySelectorAll('*')].map(el=>({tag:el.tagName, className:el.className,
                    right:el.getBoundingClientRect().right, text:el.textContent.slice(0,60)}))
                    .filter(el=>el.right>innerWidth+1).slice(0,12)})""")
            assert overflow['scroll'] <= overflow['viewport'] + 1, overflow
            page.screenshot(path=str(output / "narrow-layout.png"), animations="disabled")
            observations["reduced_motion_animation_duration"] = reduced
            passed.append("Reduced-motion setting suppresses emphasis animation; narrow viewport stacks panels without horizontal overflow")

            page.set_viewport_size({"width": 1600, "height": 1000})
            legacy = manifest["legacy"]
            page.goto(base_url + "/traces?" + urlencode({"view": "details", "legacy_run": legacy["run"],
                "legacy_trial": "/".join([legacy["task"], legacy["condition"], legacy["trial"]]), "legacy_root": "0"}))
            expect(page.get_by_text(re.compile("同期情報なし"))).to_be_visible()
            legacy_video = page.get_by_label("試行の録画", exact=True)
            page.wait_for_function("document.querySelector('video')?.readyState >= 2")
            legacy_video.evaluate("v => v.play()")
            page.wait_for_function("document.querySelector('video').currentTime > .15")
            assert not legacy_video.evaluate("v => v.paused")
            legacy_video.evaluate("v => v.pause()")
            page.screenshot(path=str(output / "mp4-only.png"), animations="disabled")
            passed.append("MP4-only trial plays with 同期情報なし")
            assert not errors, errors
            result = {"url": url, "passed": passed, "page_errors": errors, "observations": observations}
            (output / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps({"passed": len(passed), "page_errors": errors}, ensure_ascii=False))
        except Exception:
            page.screenshot(path=str(output / "failure.png"))
            (output / "failure.txt").write_text(page.locator("body").inner_text(), encoding="utf-8")
            raise
        finally:
            browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8390")
    parser.add_argument("--fixture", type=Path, default=Path("outputs/geniac_demo"))
    parser.add_argument("--out", type=Path, default=Path("outputs/replay_layout_checks"))
    args = parser.parse_args()
    check(args.base_url, args.fixture, args.out)
