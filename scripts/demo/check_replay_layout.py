"""Acceptance flow for the video-left/log-below/three-detail-tabs replay layout."""
import argparse
import json
import re
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

from playwright.sync_api import expect, sync_playwright
from check_api_python import check_api_python


def check_recorded_frame_scroll(page, url: str, event_id: str):
    page.goto(url + "&event=" + event_id)
    page.get_by_label("動画・記録フレーム", exact=True).select_option("recorded")
    frame = page.get_by_role("region", name="記録フレームの画像", exact=True)
    frame.locator("img").evaluate("img => img.decode()")
    log = page.get_by_role("region", name="タイムラインのイベント", exact=True)
    expect(log).to_be_visible()

    def position():
        return log.evaluate("""async el => {
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            return {page: window.scrollY, log: el.scrollTop, height: el.scrollHeight, width: el.offsetWidth};
        }""")

    page.evaluate("window.scrollTo(0, document.scrollingElement.scrollHeight - innerHeight - 100)")
    before = position()
    box = log.bounding_box()
    y = box["y"] + 100
    page.mouse.move(box["x"] + 100, y)
    page.mouse.wheel(0, 720)
    after = position()
    assert after["log"] > before["log"], (before, after)
    assert after["page"] == before["page"] and after["height"] == before["height"], (before, after)

    log.evaluate("el => el.scrollTop = el.scrollHeight")
    end = position()
    page.mouse.wheel(0, 150)
    assert position() == end
    page.mouse.move(box["x"] / 2, y)
    page.mouse.wheel(0, 150)
    assert position()["page"] > end["page"]

    log.evaluate("el => el.scrollTop = 180")
    before = position()
    thumb = log.evaluate("""el => {
        const rect = el.getBoundingClientRect();
        return {
            x: rect.right - (el.offsetWidth - el.clientWidth) / 2,
            y: rect.top + (el.scrollTop + el.clientHeight / 2) * el.clientHeight / el.scrollHeight,
        };
    }""")
    page.mouse.move(thumb["x"], thumb["y"])
    page.mouse.down()
    page.mouse.move(thumb["x"], thumb["y"] + 100, steps=10)
    page.mouse.up()
    after = position()
    assert after["log"] > before["log"], (before, after)
    assert after["page"] == before["page"] and after["width"] == before["width"], (before, after)
    expect(page.get_by_role("tabpanel")).to_have_attribute("data-selected-event", event_id)


def check(base_url: str, root: Path, output: Path):
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    output.mkdir(parents=True, exist_ok=True)
    errors, passed, observations = [], [], {}
    url = base_url + "/traces?" + urlencode({"view": "details", "run": manifest["run"], "episode": manifest["episode"]})
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, ignore_default_args=["--hide-scrollbars"])
        page = browser.new_page(viewport={"width": 1600, "height": 1000})
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.set_default_timeout(12000)
        try:
            # Exercise the actual picker flow: a direct event URL cannot catch
            # the initial-selection regression caused by default Live state.
            page.goto(base_url + "/traces?view=details")
            picker_details = page.locator('[data-picker-details="trace"]')
            expect(picker_details).not_to_have_attribute("open", "")
            expect(picker_details.get_by_text("viewer-only（記録の閲覧専用）", exact=True)).to_be_hidden()
            picker_details.locator("summary").click()
            expect(picker_details.get_by_text("viewer-only（記録の閲覧専用）", exact=True)).to_be_visible()
            picker_details.locator("summary").click()
            page.get_by_role("button", name="トレースなし（既存ログ）", exact=True).click()
            expect(page.locator('[data-picker-details="legacy"]')).not_to_have_attribute("open", "")
            page.get_by_role("button", name="トレースあり", exact=True).click()
            page.get_by_role("button").filter(has=page.get_by_text(manifest["run"], exact=True)).click()
            search = page.get_by_role("searchbox", name="試行を検索")
            episode = page.get_by_role("button", name="episode " + manifest["episode"], exact=True)
            search.fill("no-such-demo-trial")
            expect(episode).to_have_count(0)
            search.fill("cube_lifting")
            expect(page.get_by_label("結果で絞り込み")).to_be_visible()
            expect(episode).to_be_visible()
            episode.click()
            video = page.get_by_label("試行の録画", exact=True)
            page.wait_for_function("document.querySelector('video[aria-label=\"試行の録画\"]')?.readyState >= 2")
            expect(page.get_by_text("同期情報なし", exact=False)).to_have_count(0)
            assert page.locator('.replay-header-main').bounding_box()['height'] < 100
            expect(page.get_by_role('button', name='試行の詳細', exact=True)).to_have_attribute('aria-expanded', 'false')
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

            panel = page.get_by_role("tabpanel")
            expect(cue("sam_0")).to_have_attribute("data-current", "true")
            expect(panel).to_have_attribute("data-selected-event", manifest["events"]["sam_0"])
            expect(panel).to_contain_text("red cube")
            assert video.evaluate("v => v.paused && v.currentTime === 0")
            page.wait_for_function("new URLSearchParams(location.search).get('event') === document.querySelector('[role=tabpanel]')?.dataset.selectedEvent")
            page.screenshot(path=str(output / "initial-selection.png"), animations="disabled")
            passed.append("Picker search/filter/mode controls stay visible; storage details fold away; before playback SAM3 highlight, URL and input/output select the same event")

            left = page.locator('[data-replay-pane="left"]').bounding_box()
            right = page.locator('[data-replay-pane="details"]').bounding_box()
            recording = video.bounding_box()
            logs = page.locator('[data-replay-log-panel]').bounding_box()
            assert right["x"] >= left["x"] + left["width"] - 1
            assert logs["y"] >= recording["y"] + recording["height"] - 1
            assert recording["x"] < right["x"] and logs["x"] < right["x"]
            observations["desktop_bounds"] = {"video": recording, "logs": logs, "details": right}
            passed.append("Desktop layout: video left, process logs below it, exactly three detail tabs on the right")

            video.evaluate("v => { v.currentTime = 0; v.playbackRate = .5; }")
            page.get_by_role("button", name="再生", exact=True).click()
            page.wait_for_function("document.querySelector('video').currentTime > .3")
            page.get_by_role("button", name="一時停止", exact=True).click()
            expect(page.get_by_role("button", name="再生", exact=True)).to_be_visible()
            assert page.locator('[data-current="true"]').count() == 1
            all_turns()
            cue("sam_0").click()
            tab("入出力")
            panel = page.get_by_role("tabpanel")
            expect(panel).to_contain_text("red cube")
            expect(panel.locator('img[src*="/array-image/"]').first).to_be_visible()
            expect(panel.get_by_role("heading", name="渡した画像", exact=True)).to_be_visible()
            expect(panel.get_by_role("heading", name="返った検出結果", exact=True)).to_be_visible()
            assert panel.locator("img").count() == 2
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
            expect(cue("candidate_1").locator('.replay-event-kind')).to_have_text("候補生成（9件）")
            paused_same(vdm_time)
            expect(cue("candidate_1")).to_have_attribute("data-current", "true")
            cue("vdm_1").click()
            paused_same(vdm_time)
            expect(cue("vdm_1")).to_have_attribute("data-current", "true")
            page.get_by_label("表示する処理", exact=True).select_option("all")
            same_frame_candidates = page.locator('[data-replay-time="2"] .replay-event-row').filter(has=page.locator('.replay-event-kind', has_text="候補生成"))
            expect(same_frame_candidates).to_have_count(9)
            same_frame_candidates.last.click()
            paused_same(vdm_time)
            expect(same_frame_candidates.last).to_have_attribute("data-current", "true")
            cue("vdm_1").click()
            page.screenshot(path=str(output / "vdm-paused.png"), animations="disabled")
            passed.append("VDM images/explanation and co-located candidate/VDM logs remain individually selectable with video paused")

            cue("candidate_1").click()
            tab("候補")
            expect(page.locator('[data-candidate]')).to_have_count(9)
            expect(page.locator('[data-synthesis]')).to_have_count(0)
            expect(page.locator('[id^="ensemble-input-"]')).to_have_count(1)
            candidate = page.get_by_label("候補を選択", exact=True)
            detail = page.locator('[data-candidate-detail]')
            candidate.select_option(index=0)
            detail.get_by_text("この候補の入力を見る", exact=True).click()
            expect(page.locator('[data-ensemble-common]')).to_have_attribute("open", "")
            expect(page.locator('[id^="ensemble-input-"]')).to_have_attribute("open", "")
            page.locator('[data-ensemble-common] > summary').click()
            expect(candidate.locator('option').nth(6)).to_contain_text("トークン上限")
            expect(candidate.locator('option').nth(7)).to_contain_text("エラー")
            expect(candidate.locator('option').nth(8)).to_contain_text("ストリーム中断")
            candidate.select_option(index=7)
            expect(detail).to_contain_text("synthetic candidate error")
            candidate.select_option(index=8)
            expect(detail).to_contain_text("partial stream")
            paused_same(vdm_time)
            page.screenshot(path=str(output / "candidates.png"), animations="disabled")
            tab("統合結果")
            expect(page.locator('[data-candidate]')).to_have_count(0)
            synthesis = page.locator('[data-synthesis]')
            expect(synthesis).to_have_count(1)
            expect(synthesis).to_contain_text("REGENERATE（修正）")
            synthesis.get_by_text("統合入力に含まれた候補を確認", exact=True).click()
            expect(synthesis).to_contain_text("統合入力に全文一致（送信を確認）")
            synthesis.get_by_text("統合入力に含まれた候補を確認", exact=True).click()
            synthesis.get_by_text("統合時に実際に渡された入力", exact=True).click()
            expect(synthesis).to_contain_text("<candidate_solutions>")
            page.screenshot(path=str(output / "synthesis.png"), animations="disabled")
            paused_same(vdm_time)
            # A cross-panel jump must reveal its target even under a model-only filter.
            page.get_by_label("表示する処理", exact=True).select_option("prompts")
            synthesis.get_by_role("button", name=re.compile("実行されたPython")).click()
            expect(page.get_by_role("tab", name="入出力", exact=True)).to_have_attribute("aria-selected", "true")
            expect(panel).to_contain_text("実際に実行したPython")
            expect(panel).to_contain_text("Success!")
            expect(panel).to_contain_text("標準出力")
            expect(panel).to_contain_text("標準エラー")
            expect(page.get_by_label("表示する処理", exact=True)).to_have_value("all")
            expect(cue("block_1")).to_have_attribute("data-current", "true")
            assert video.evaluate("v => v.paused")
            passed.append("Candidate tab: nine candidates/shared input/errors/truncation; synthesis tab: actual input, REGENERATE and executable Python link")

            all_turns()
            page.get_by_label("表示する処理", exact=True).select_option("main")
            expect(cue("candidate_2").locator('.replay-event-kind')).to_have_text("候補生成（3件）")
            cue("candidate_2").click()
            tab("候補")
            expect(page.locator('[data-candidate]')).to_have_count(3)
            tab("統合結果")
            expect(page.locator('[data-synthesis]')).to_contain_text("FINISH（終了・モデルの主張）")
            all_turns()
            cue("synthesis_0").click()
            expect(page.locator('[data-synthesis]')).to_contain_text("Pythonコード")
            expect(cue("synthesis_0")).to_have_attribute("data-current", "true")
            # Complete the preceding manual selection/seek before exercising a
            # separate native seek+play action (React effects run after paint).
            page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
            paused_same(0)
            passed.append("Recorded candidate count may be three; Python, REGENERATE and FINISH are distinguished per turn")

            video.evaluate("v => { v.currentTime = .2; v.playbackRate = 2; return v.play(); }")
            page.wait_for_function("document.querySelector('video').currentTime > 2.2")
            assert not video.evaluate("v => v.paused")
            video.evaluate("v => v.pause()")
            expect(page.get_by_role("tab", name="統合結果", exact=True)).to_have_attribute("aria-selected", "true")
            assert page.locator('[data-current="true"]').count() == 1
            page.wait_for_function("new URLSearchParams(location.search).get('event') === document.querySelector('[data-current=true]')?.dataset.replayEvent")
            page.locator('.replay-playback-options > summary').click()
            page.get_by_role("button", name="2秒巻き戻す", exact=True).click()
            page.locator('.replay-playback-options > summary').click()
            assert video.evaluate("v => v.currentTime") < 1
            passed.append("Native seek and replay resume event following across turns without remounting video or overriding chosen tab; rewind works")

            page.get_by_role("button", name="詳細ログ", exact=True).click()
            page.get_by_label("タイムラインを検索").fill("sam3_seg_fn")
            page.locator(f'[data-timeline-event="{manifest["events"]["sam_0"]}"]').click()
            paused_same(0)
            page.get_by_role("button", name="処理タイムライン", exact=True).click()
            expect(cue("sam_0")).to_have_attribute("data-current", "true")
            tab("入出力")
            page.get_by_label("表示する処理", exact=True).select_option("main")
            expect(panel.locator('img[src*="/array-image/"]').first).to_be_visible()
            page.wait_for_function("[...document.querySelectorAll('[role=tabpanel] img')].every(image => image.complete && image.naturalWidth > 0)")
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
            episode_api = f'/api/traces/runs/{manifest["run"]}/episodes/{manifest["episode"]}'
            snapshot = page.request.get(base_url + episode_api + '/events?after_offset=0').json()
            recorded_events = snapshot['events']
            video_event = next(event for event in recorded_events if event['event_type'] == 'trial_videos')
            page.goto(url + '&event=' + manifest['events']['vdm_1'])
            expect(cue('vdm_1')).to_have_attribute('data-current', 'true')
            expect(panel).to_have_attribute('data-selected-event', manifest['events']['vdm_1'])
            expect(panel).to_contain_text('below the target height')
            page.wait_for_function("!document.querySelector('video').seeking && Math.abs(document.querySelector('video').currentTime - 2) < .02")
            assert video.evaluate('v => v.paused')
            page.get_by_role('button', name='再生', exact=True).click()
            page.wait_for_function("document.querySelector('video').currentTime > 2.2")
            page.get_by_label('リプレイのターン', exact=True).select_option('1')
            page.evaluate("url => { history.pushState({}, '', url); dispatchEvent(new PopStateEvent('popstate')); }",
                url + '&event=' + manifest['events']['sam_0'])
            expect(cue('sam_0')).to_have_attribute('data-current', 'true')
            expect(page.get_by_label('リプレイのターン', exact=True)).to_have_value('0')
            expect(panel).to_have_attribute('data-selected-event', manifest['events']['sam_0'])
            page.wait_for_function("document.querySelector('video').paused && !document.querySelector('video').seeking && document.querySelector('video').currentTime < .02")
            page.get_by_role('button', name='再生', exact=True).click()
            page.wait_for_function("document.querySelector('video').currentTime > .2")
            before_unmapped = page.evaluate("url => { const time=document.querySelector('video').currentTime; history.pushState({}, '', url); dispatchEvent(new PopStateEvent('popstate')); return time; }",
                url + '&event=' + video_event['event_id'])
            page.wait_for_function("document.querySelector('video').paused")
            assert abs(video.evaluate('v => v.currentTime') - before_unmapped) < .15
            expect(panel).to_have_attribute('data-selected-event', video_event['event_id'])
            expect(page.locator('[data-current="true"]')).to_have_count(0)
            expect(panel.locator('.replay-debug-banner')).to_have_count(0)
            expect(panel.get_by_role('button', name=re.compile('イベントの生データを表示'))).to_have_count(0)
            panel.get_by_text('記録の詳細', exact=True).click()
            banner = panel.locator('.replay-debug-banner')
            expect(banner).to_have_count(1)
            expect(banner).to_be_visible()
            expect(panel.get_by_role('button', name=re.compile('イベントの生データを表示'))).to_have_count(1)
            colors = banner.evaluate("el => ({background:getComputedStyle(el).backgroundColor, text:getComputedStyle(el).color, icon:getComputedStyle(el.querySelector('svg')).stroke})")
            assert colors == {'background': 'rgb(231, 241, 244)', 'text': 'rgb(35, 75, 90)', 'icon': 'rgb(35, 75, 90)'}, colors

            def luminance(rgb):
                components = [channel / 255 for channel in rgb]
                linear = [c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4 for c in components]
                return sum(c * weight for c, weight in zip(linear, (.2126, .7152, .0722)))

            contrast = (luminance((231, 241, 244)) + .05) / (luminance((35, 75, 90)) + .05)
            assert contrast > 8.2
            observations['debug_banner'] = {**colors, 'contrast': contrast}
            page.screenshot(path=str(output / 'debug-details.png'), animations='disabled')
            panel.get_by_text('記録の詳細', exact=True).click()
            expect(banner).to_have_count(0)
            passed.append('Explicit URLs retain mapped VDM; URL changes during playback pause and seek mapped SAM3 or retain the position for unmapped trial_videos; debug disclosure has one banner/raw record with requested colors and >8.2:1 contrast')

            # Exercise real browser polling and player effects against an explicitly
            # simulated running response; this does not claim a real robot is Live.
            running_summary = page.request.get(base_url + episode_api).json()
            running_summary['status'] = 'running'
            live_events = list(recorded_events)

            def serve_live_events(route):
                offset = int(parse_qs(urlparse(route.request.url).query).get('after_offset', ['0'])[0])
                route.fulfill(json={'events': live_events[offset:], 'next_offset': len(live_events),
                    'eof': True, 'generation': 'browser-live-regression'})

            page.route('**' + episode_api, lambda route: route.fulfill(json=running_summary))
            page.route('**' + episode_api + '/events?*', serve_live_events)
            page.goto(url)
            page.wait_for_function("document.querySelector('video')?.readyState >= 2")
            expect(panel).to_have_attribute('data-selected-event', video_event['event_id'])
            page.get_by_role('button', name='試行の詳細', exact=True).click()
            live_switch = page.get_by_role('checkbox', name='新しい記録に追従')
            expect(live_switch).to_be_checked()
            expect(page.locator('[data-current="true"]')).to_have_count(0)
            new_event = {**video_event, 'event_id': 'browser_live_warning_1', 'seq': video_event['seq'] + 1,
                'event_type': 'trace_warning', 'status': 'warning', 'artifacts': [], 'data': {'message': 'browser Live regression event'}}
            live_events.append(new_event)
            expect(panel).to_have_attribute('data-selected-event', new_event['event_id'])
            expect(live_switch).to_be_checked()
            expect(page.locator('[data-current="true"]')).to_have_count(0)
            page.get_by_role('button', name='再生', exact=True).click()
            expect(live_switch).not_to_be_checked()
            page.wait_for_function("document.querySelector('video').currentTime > .2")
            page.wait_for_function("document.querySelector('[data-current=true]')?.dataset.replayEvent === document.querySelector('[role=tabpanel]')?.dataset.selectedEvent")
            live_switch.check()
            expect(live_switch).to_be_checked()
            expect(panel).to_have_attribute('data-selected-event', new_event['event_id'])
            assert video.evaluate('v => v.paused')
            new_event2 = {**new_event, 'event_id': 'browser_live_warning_2', 'seq': new_event['seq'] + 1}
            live_events.append(new_event2)
            expect(panel).to_have_attribute('data-selected-event', new_event2['event_id'])
            expect(live_switch).to_be_checked()
            expect(page.locator('[data-current="true"]')).to_have_count(0)
            page.evaluate("url => { history.pushState({}, '', url); dispatchEvent(new PopStateEvent('popstate')); }",
                url + '&event=' + manifest['events']['vdm_1'])
            expect(live_switch).not_to_be_checked()
            expect(panel).to_have_attribute('data-selected-event', manifest['events']['vdm_1'])
            expect(cue('vdm_1')).to_have_attribute('data-current', 'true')
            page.wait_for_function("document.querySelector('video').paused && !document.querySelector('video').seeking && Math.abs(document.querySelector('video').currentTime - 2) < .02")
            page.unroute('**' + episode_api)
            page.unroute('**' + episode_api + '/events?*')
            passed.append('Simulated running trace: polls new events without video overriding Live; playback or external URL enters Browse; re-enabling Live pauses video and follows appended events')

            passed.extend(check_api_python(page, url, recorded_events, output))

            check_recorded_frame_scroll(page, url, manifest["events"]["block_0"])
            passed.append("Recorded frames: log wheel and scrollbar stay in the log, and the page scrolls outside it")

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
            (output / "failure.json").write_text(json.dumps({"url": page.url,
                "passed": passed, "page_errors": errors, "observations": observations},
                ensure_ascii=False, indent=2), encoding="utf-8")
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
