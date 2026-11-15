"""Browser acceptance of recorded API/call-site replay (synthetic fixture only)."""
from playwright.sync_api import expect


def check_api_python(page, url, events, output):
    passed = []
    page.goto(url)
    page.wait_for_function("document.querySelector('video')?.readyState >= 2")
    video = page.get_by_label('試行の録画', exact=True)
    page.evaluate("window.__apiVideo = document.querySelector('video')")
    calls = [event for event in events if event['event_type'] == 'api_call_start']
    calls.sort(key=lambda event: event['seq'])
    assert len(calls) == 6
    by_id = {event['event_id']: event for event in events}
    mode = page.get_by_label('表示する処理', exact=True)
    mode.select_option('api-python')
    api_panel = page.locator('[data-api-python-panel]')
    details = page.get_by_role('tabpanel')

    def row(event):
        return api_panel.locator(f'[data-api-event="{event["event_id"]}"]')

    def selected(event, line):
        expect(row(event)).to_have_attribute('data-api-selected', 'true')
        expect(api_panel.locator('[data-api-selected=true]')).to_have_count(1)
        expect(api_panel.locator('[data-api-line]')).to_have_attribute('data-api-line', str(line))
        expect(api_panel.locator('[data-code-highlighted=true]')).to_have_attribute('data-code-line', str(line))
        expect(details).to_have_attribute('data-selected-event', event['event_id'])

    def paused_at(time):
        page.wait_for_function("!document.querySelector('video').seeking")
        assert video.evaluate('v => v === window.__apiVideo && v.paused')
        assert abs(video.evaluate('v => v.currentTime') - time) < .02

    goto0, goto1 = calls[2], calls[5]
    row(goto0).click()
    selected(goto0, 3)
    paused_at(0)
    expect(api_panel.locator('[data-api-description]')).to_contain_text('指定した位置・姿勢へ移動')
    expect(api_panel.locator('[data-code-line]')).to_have_count(4)
    expect(api_panel.locator('[data-code-line="4"]')).to_contain_text('Success!')
    # Unhighlighted names inherited the dark theme's pale text before this mode.
    assert api_panel.locator('[data-code-line="3"] > .text-sand-200').evaluate('el => getComputedStyle(el).color') == 'rgb(36, 51, 43)'
    expect(details.get_by_role('heading', name='このPythonを生成したモデル')).to_be_visible()
    block = by_id[goto0['data']['call_site']['code_block_id']]
    source_id = block['data']['source_model_event_id']
    expect(details.locator('[data-api-model-source]')).to_have_attribute('data-api-model-source', source_id)
    expect(details.locator('[data-api-model-output]')).to_have_attribute('data-api-model-output', source_id)
    expect(details.locator('[data-api-model-input]')).not_to_have_attribute('data-api-model-input', 'unrecorded')
    expect(details.locator('[data-api-model-input]')).to_contain_text('user の指示・入力')
    expect(details.locator('[data-api-model-output]')).to_contain_text('goto_pose')
    assert details.locator('[data-api-model-input]').bounding_box()['y'] < details.locator('[data-api-model-output]').bounding_box()['y']
    passed.append('API/Python: goto_pose selects recorded line 3 beside the paused video and exact producing model input/output; all four code lines are present')

    assert api_panel.locator('[data-api-event]').evaluate_all('(rows) => rows.map(row => row.dataset.apiEvent)') == [event['event_id'] for event in calls]
    row(calls[0]).click()
    selected(calls[0], 1)
    row(goto0).hover()
    expect(page.get_by_role('tooltip')).to_contain_text('指定した位置・姿勢へ移動')
    selected(calls[0], 1)
    paused_at(0)
    page.mouse.move(5, 5)
    expect(page.get_by_role('tooltip')).to_have_count(0)
    selected(calls[0], 1)
    for event, line in zip(calls[:3], (1, 2, 3)):
        row(event).click()
        selected(event, line)
        paused_at(0)
    passed.append('API/Python: hover leaves time/selection unchanged; three same-frame APIs are independently selectable in recorded order')

    api_panel.locator('.api-python-details > summary').click()
    expect(api_panel.get_by_role('heading', name='API定義の説明')).to_be_visible()
    expect(api_panel.locator('a[href*="/control.py#L417-L455"]')).to_have_count(1)
    expect(api_panel.locator('[data-api-recorded-evidence]')).to_contain_text('記録された引数')
    expect(api_panel.locator('[data-api-recorded-evidence]')).to_contain_text('position')
    expect(api_panel.locator('[data-api-recorded-evidence]')).to_contain_text('記録された結果')
    expect(api_panel.locator('[data-api-recorded-evidence]')).to_contain_text('例外の記録なし')
    api_panel.locator('.api-python-details > summary').click()
    row(goto1).click()
    selected(goto1, 3)
    paused_at(2)
    expect(api_panel.locator('[data-code-line="3"]')).to_contain_text('1.1')
    api_panel.get_by_role('button', name='前のコードブロック', exact=True).click()
    paused_at(0)
    expect(mode).to_have_value('api-python')
    expect(api_panel.locator('[data-code-line="3"]')).to_contain_text('0.93')
    expect(api_panel.locator('[data-code-highlighted=true]')).to_have_count(0)
    api_panel.get_by_role('button', name='次のコードブロック', exact=True).click()
    paused_at(2)
    expect(api_panel.locator('[data-code-line="3"]')).to_contain_text('1.1')
    row(goto0).click()
    paused_at(0)
    passed.append('API/Python: definition details and recorded evidence are separate; other-time selection and previous/next full-code navigation pause and seek without leaving the mode')

    # Wait for the programmatic jump to settle before a native seek/play.
    page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    video.evaluate('v => { v.playbackRate = 2; v.currentTime = .2; return v.play(); }')
    page.wait_for_function("document.querySelector('video').currentTime > 2.2")
    selected(goto1, 3)
    assert not video.evaluate('v => v.paused')
    video.evaluate('v => v.pause()')
    row(goto0).click()
    paused_at(0)
    for name in ('候補', '統合結果', '入出力'):
        page.get_by_role('tab', name=name, exact=True).click()
        paused_at(0)
        expect(row(goto0)).to_have_attribute('data-api-selected', 'true')
        if name == '候補':
            expect(details).to_contain_text('9件')
        if name == '統合結果':
            expect(details).to_contain_text('goto_pose')
    selected(goto0, 3)
    page.mouse.move(5, 5)
    # Video, selected row and call line must actually fit in the desktop view.
    for locator in (video, row(goto0), api_panel.locator('[data-code-highlighted=true]'), api_panel.locator('[data-code-line="4"]')):
        box = locator.bounding_box()
        assert box and box['y'] >= 0 and box['y'] + box['height'] <= 1000, box
    page.screenshot(path=str(output / 'api-python.png'), animations='disabled')
    passed.append('API/Python: playback follows API and Python line across turns; candidate/synthesis tabs preserve paused position and selected API')

    page.set_viewport_size({'width': 760, 'height': 900})
    page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
    page.screenshot(path=str(output / 'api-python-narrow.png'), animations='disabled')
    page.set_viewport_size({'width': 1600, 'height': 1000})
    return passed
