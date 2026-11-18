import test from 'node:test';
import assert from 'node:assert/strict';
import { advance, findAll, propsOf, resetBrowser } from './harness/browser';
import { mount } from './harness/fakeReact';
import { buildEpisodeModel } from '../model';
import { ApiPythonPanel, type ApiPythonPanelProps } from '../components/ApiPythonPanel';
import { CodeView } from '../components/CodeView';
import { Rec } from './fixtures';

test('hover and focus preview an API without selecting it; clicks and block navigation use the explicit callback', async () => {
  resetBrowser();
  const r = new Rec(); r.episodeStart();
  const block = r.blockStart(null, 'a = 1\nb = 2\ngoto_pose(target)');
  const first = r.apiStart(block, 'get_observation', {}, null, { call_site: { code_block_id: block.event_id, line: 1 } });
  const second = r.apiStart(block, 'goto_pose');
  const laterBlock = r.blockStart(null, 'later_code = 1');
  const model = buildEpisodeModel(r.events);
  const nodes = [first, second].map(event => model.nodeOfEvent.get(event.event_id)!);
  const selected: string[] = [];
  const props: ApiPythonPanelProps = { model, ep: { runId: 'run', episodeId: 'ep' },
    apiCues: nodes.map(node => ({ node, time: 2 })), selectedKey: nodes[0].key,
    onSelect: node => selected.push(node.key) };
  const panel = mount(ApiPythonPanel, props);
  const rows = () => findAll(panel.output, 'button').filter(row => row.props['data-api-event']);
  const target = { getBoundingClientRect: () => ({ left: 40, bottom: 80 }) };
  try {
    (rows()[1].props.onMouseEnter as Function)({ currentTarget: target }); await advance(0);
    assert.equal(findAll(panel.output, 'div').filter(item => item.props.role === 'tooltip').length, 1);
    assert.deepEqual(selected, [], 'hover must not invoke the playback/selection callback');
    assert.equal(rows()[0].props['data-api-selected'], true);
    assert.equal(rows()[1].props['data-api-selected'], false);
    assert.equal(propsOf<Parameters<typeof CodeView>[0]>(panel.output, CodeView).markLine, 1);
    (rows()[1].props.onMouseLeave as Function)(); await advance(0);
    assert.equal(findAll(panel.output, 'div').filter(item => item.props.role === 'tooltip').length, 0);
    (rows()[1].props.onFocus as Function)({ currentTarget: target }); await advance(0);
    assert.deepEqual(selected, [], 'keyboard focus also only previews');
    (rows()[1].props.onClick as Function)();
    assert.deepEqual(selected, [nodes[1].key]);
    panel.update({ ...props, selectedKey: nodes[1].key }); await advance(0);
    assert.equal(rows()[1].props['data-api-selected'], true);
    assert.equal(propsOf<Parameters<typeof CodeView>[0]>(panel.output, CodeView).markLine, 3);
    const next = findAll(panel.output, 'button').find(item => item.props['aria-label'] === '次のコードブロック')!;
    assert.equal(next.props.disabled, false);
    (next.props.onClick as Function)();
    assert.equal(selected.at(-1), model.nodeOfEvent.get(laterBlock.event_id)!.key);
    panel.update({ ...props, selectedKey: model.nodeOfEvent.get(laterBlock.event_id)!.key }); await advance(0);
    assert.equal(propsOf<Parameters<typeof CodeView>[0]>(panel.output, CodeView).code, 'later_code = 1');
    assert.equal(propsOf<Parameters<typeof CodeView>[0]>(panel.output, CodeView).markLine, null);
    const previous = findAll(panel.output, 'button').find(item => item.props['aria-label'] === '前のコードブロック')!;
    (previous.props.onClick as Function)();
    assert.equal(selected.at(-1), model.nodeOfEvent.get(block.event_id)!.key);
  } finally { panel.unmount(); }
});

test('resizing the API and Python panes preserves manual scroll and keeps a visible selection in view on shrink', () => {
  resetBrowser();
  const r = new Rec();
  r.episodeStart();
  const block = r.blockStart(null, 'get_observation()');
  const api = r.apiStart(block, 'get_observation', {}, null, { call_site: { code_block_id: block.event_id, line: 1 } });
  const model = buildEpisodeModel(r.events);
  const props: ApiPythonPanelProps = { model, ep: { runId: 'run', episodeId: 'ep' }, apiCues: [], selectedKey: null, onSelect() {} };
  const panel = mount(ApiPythonPanel, props);
  const resize = new Map<object, () => void>();
  const originalObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  Object.assign(globalThis, { ResizeObserver: class {
    constructor(private notify: () => void) {}
    observe(pane: object) { resize.set(pane, this.notify); }
    disconnect() {}
  } });
  try {
    const panes = ['API呼び出し', 'Pythonコードと記録'].map(label => {
      const pane = {
        clientHeight: 100, clientWidth: 300, clientTop: 0, scrollTop: 0,
        getBoundingClientRect: () => ({ top: 0 }),
        querySelector: () => ({ getBoundingClientRect: () => ({ top: 300 - pane.scrollTop, height: 10, bottom: 310 - pane.scrollTop }) }),
      };
      const element = findAll(panel.output, 'div').find(el => el.props['aria-label'] === label)!;
      (element.props.ref as { current: unknown }).current = pane;
      return pane;
    });
    panel.update({ ...props, selectedKey: model.nodeOfEvent.get(api.event_id)!.key });
    for (const pane of panes) {
      const resized = resize.get(pane)!;
      assert.equal(pane.scrollTop, 255, 'selecting an API reveals its row and its call line');
      pane.scrollTop = 20;
      pane.clientHeight = 200;
      resized();
      assert.equal(pane.scrollTop, 20, 'growing the pane leaves the reading position alone');
      pane.clientHeight = 100;
      resized();
      assert.equal(pane.scrollTop, 20, 'shrinking the pane also preserves a manual scroll away from the selection');
      pane.scrollTop = 225; // The selected row is now visible, 75 px from the top.
      pane.clientHeight = 50;
      resized();
      assert.equal(pane.scrollTop, 280, 'a previously visible selection stays inside the smaller pane');
    }
  } finally {
    panel.unmount();
    if (originalObserver) Object.defineProperty(globalThis, 'ResizeObserver', originalObserver);
    else Reflect.deleteProperty(globalThis, 'ResizeObserver');
  }
});
