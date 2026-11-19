import test from 'node:test';
import assert from 'node:assert/strict';
import { advance, findAll, resetBrowser } from './harness/browser';
import { mount } from './harness/fakeReact';
import { buildEpisodeModel } from '../model';
import { VideoPlayback } from '../components/VideoPlayback';
import { ApiPythonPanel } from '../components/ApiPythonPanel';
import { Rec } from './fixtures';

type Props = Parameters<typeof VideoPlayback>[0];
const STORAGE_KEY = 'capx.replay.belowVideo';

function viewer(overrides: Partial<Props> = {}) {
  const r = new Rec(); r.episodeStart();
  const page = mount(VideoPlayback, {
    model: buildEpisodeModel(r.events), ep: { runId: 'run', episodeId: 'episode' },
    videos: [{ name: 'video_combined.mp4', url: '/video' }], logPanel: <section aria-label="compact logs"/>,
    onSelect() {}, ...overrides,
  });
  const group = () => findAll(page.output, 'div').find(element => element.props.role === 'group' && element.props['aria-label'] === '動画の下に出す内容');
  const buttons = () => findAll(group(), 'button');
  const button = (label: string) => {
    const element = buttons().find(element => element.props.children === label);
    if (!element) throw new Error(`missing display button ${label}`);
    return element;
  };
  const choose = async (label: string) => { (button(label).props.onClick as () => void)(); await advance(0); };
  const logsVisible = () => findAll(page.output, 'div').some(element => element.props.hidden === false && findAll(element.props.children, 'section').some(section => section.props['aria-label'] === 'compact logs'));
  return { page, group, buttons, button, choose, logsVisible };
}

test('video defaults to the compact list with two accessible pressed-state buttons', async () => {
  resetBrowser(); const p = viewer();
  try {
    assert.ok(p.group());
    assert.deepEqual(p.buttons().map(button => button.props.children), ['一覧', 'APIとPython']);
    for (const button of p.buttons()) assert.equal(button.props.type, 'button');
    assert.equal(p.button('一覧').props['aria-pressed'], true);
    assert.equal(p.button('APIとPython').props['aria-pressed'], false);
    assert.equal(p.logsVisible(), true);
    assert.equal(findAll(p.page.output, ApiPythonPanel).length, 0);
    await p.choose('APIとPython');
    assert.equal(p.button('一覧').props['aria-pressed'], false);
    assert.equal(p.button('APIとPython').props['aria-pressed'], true);
    assert.equal(p.logsVisible(), false);
    assert.equal(findAll(p.page.output, ApiPythonPanel).length, 1);
    await p.choose('一覧');
    assert.equal(p.button('一覧').props['aria-pressed'], true);
    assert.equal(p.logsVisible(), true);
    assert.equal(findAll(p.page.output, ApiPythonPanel).length, 0);
  } finally { p.page.unmount(); }
});

test('the below-video choice survives remounts and trial changes in the viewer', async () => {
  resetBrowser();
  const first = viewer(); await first.choose('APIとPython'); first.page.unmount();
  assert.equal(window.localStorage.getItem(STORAGE_KEY), JSON.stringify('process'));
  const otherTrial = viewer({ ep: { runId: 'another-run', episodeId: 'another-episode' } });
  try {
    assert.equal(otherTrial.button('APIとPython').props['aria-pressed'], true);
    assert.equal(findAll(otherTrial.page.output, ApiPythonPanel).length, 1);
    await otherTrial.choose('一覧');
  } finally { otherTrial.page.unmount(); }
  assert.equal(window.localStorage.getItem(STORAGE_KEY), JSON.stringify('list'));
  const restored = viewer();
  try { assert.equal(restored.button('一覧').props['aria-pressed'], true); }
  finally { restored.page.unmount(); }
});

test('non-API mode labels the alternate display as the process timeline', async () => {
  resetBrowser(); const p = viewer({ ep: undefined });
  const process = () => findAll(p.page.output, 'div').find(element => element.props['aria-label'] === '記録された処理')!;
  try {
    assert.deepEqual(p.buttons().map(button => button.props.children), ['一覧', '処理タイムライン']);
    assert.equal(p.button('一覧').props['aria-pressed'], true);
    assert.equal(process().props.hidden, true);
    await p.choose('処理タイムライン');
    assert.equal(p.button('一覧').props['aria-pressed'], false);
    assert.equal(p.button('処理タイムライン').props['aria-pressed'], true);
    assert.equal(process().props.hidden, false);
    assert.equal(p.logsVisible(), false);
    await p.choose('一覧');
    assert.equal(process().props.hidden, true);
    assert.equal(p.logsVisible(), true);
  } finally { p.page.unmount(); }
});

test('without a log panel the existing API or process view stays available without a switch', () => {
  resetBrowser();
  for (const api of [true, false]) {
    const p = viewer({ logPanel: undefined, ...(api ? {} : { ep: undefined }) });
    try {
      assert.equal(p.group(), undefined);
      assert.equal(findAll(p.page.output, ApiPythonPanel).length, api ? 1 : 0);
      const process = findAll(p.page.output, 'div').find(element => element.props['aria-label'] === '記録された処理')!;
      assert.equal(process.props.hidden, api);
    } finally { p.page.unmount(); }
  }
});

test('unavailable localStorage reads and writes leave the default list and display switch usable', async () => {
  resetBrowser(); const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
  try {
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => { throw new Error('storage blocked'); } });
    const p = viewer();
    try {
      assert.equal(p.button('一覧').props['aria-pressed'], true);
      await p.choose('APIとPython');
      assert.equal(p.button('APIとPython').props['aria-pressed'], true);
      assert.equal(findAll(p.page.output, ApiPythonPanel).length, 1);
      await p.choose('一覧');
      assert.equal(p.logsVisible(), true);
    } finally { p.page.unmount(); }
  } finally { Object.defineProperty(window, 'localStorage', descriptor); }

  const storage = window.localStorage, setItem = storage.setItem;
  storage.setItem(STORAGE_KEY, JSON.stringify('process'));
  try {
    storage.setItem = () => { throw new Error('storage full'); };
    const p = viewer();
    try {
      assert.equal(p.button('APIとPython').props['aria-pressed'], true);
      await p.choose('一覧');
      assert.equal(p.button('一覧').props['aria-pressed'], true);
      assert.equal(p.logsVisible(), true);
    } finally { p.page.unmount(); }
  } finally { storage.setItem = setItem; }
});

for (const saved of ['invalid JSON', JSON.stringify('unknown'), JSON.stringify(null)]) test(`invalid stored below-video choice falls back to the list: ${saved}`, () => {
  resetBrowser(); window.localStorage.setItem(STORAGE_KEY, saved);
  const p = viewer();
  try { assert.equal(p.button('一覧').props['aria-pressed'], true); assert.equal(p.logsVisible(), true); }
  finally { p.page.unmount(); }
});
