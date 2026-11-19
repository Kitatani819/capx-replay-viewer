import test from 'node:test';
import assert from 'node:assert/strict';
import { advance, currentParams, findAll, popState, propsOf, resetBrowser, setLocation, type FakeElement } from './harness/browser';
import { mount } from './harness/fakeReact';
import TraceViewerPage from '../TraceViewerPage';
import { MediaPane } from '../components/MediaPane';
import { VideoPlayback } from '../components/VideoPlayback';
import { DetailTabs } from '../components/DetailTabs';
import { Timeline } from '../components/Timeline';
import { VirtualList } from '../components/VirtualList';
import { playbackMap } from '../playback';
import type { TNode } from '../model';
import type { TraceEvent } from '../types';
import { Rec } from './fixtures';
import { addEpisode, makeRun, serve } from './pageServer';

type MediaProps = Parameters<typeof MediaPane>[0];
type PlayerProps = Parameters<typeof VideoPlayback>[0];
type DetailsProps = Parameters<typeof DetailTabs>[0];
type TimelineProps = Parameters<typeof Timeline>[0];
interface Row { node: TNode; expanded: boolean }
type ListProps = Parameters<typeof VirtualList<Row>>[0];

(globalThis as unknown as { CSS: unknown }).CSS = { escape: (key: string) => key };

function recording() {
  const r = new Rec();
  const start = r.episodeStart();
  const at = (event: TraceEvent, step: number) => { event.sim_step = step; event.sim_epoch = 0; return event; };
  r.add('frame', { camera: 'main', epoch: 0, buffer_index: 0, sim_step: 0 });
  const sourceCall = r.request('code_generator', 'source-call'); r.response(sourceCall);
  const firstBlock = at(r.blockStart(sourceCall), 0);
  const firstApi = at(r.apiStart(firstBlock, 'observe'), 0);
  at(r.apiEnd(firstApi), 0); at(r.blockEnd(firstBlock, 0, 0), 0);
  for (let i = 0; i < 75; i++) r.add('trace_warning', { message: `warning ${i}` });
  const call = r.request('code_generator', 'unmapped-call');
  r.response(call);
  const lastBlock = at(r.blockStart(null, 'goto_pose(target)', { turn_index: 1 }), 60);
  const lastApi = at(r.apiStart(lastBlock, 'goto_pose'), 60);
  at(r.apiEnd(lastApi), 60); at(r.blockEnd(lastBlock, 0, 0), 60);
  r.add('frame', { camera: 'main', epoch: 0, buffer_index: 119, sim_step: 119 });
  r.episodeEnd();
  return { events: r.events, start, sourceCall, firstBlock, firstApi, call, lastApi };
}

function namedElement(value: unknown, name: string): FakeElement | undefined {
  if (Array.isArray(value)) return value.map(child => namedElement(child, name)).find(Boolean);
  if (!value || typeof value !== 'object' || !('props' in value)) return undefined;
  const element = value as FakeElement;
  if (typeof element.type === 'function' && element.type.name === name) return element;
  return Object.values(element.props).map(child => namedElement(child, name)).find(Boolean);
}

async function replay(display: 'video' | 'recorded') {
  resetBrowser();
  const rec = recording(); const run = makeRun();
  addEpisode(run, 'e1', { status: 'ended', trace_complete: true },
    rec.events.map(event => ({ ...event, run_id: 'r1', episode_id: 'e1' })));
  serve(run);
  const url = '/traces?view=details&run=r1&episode=e1';
  setLocation(`${url}&event=${rec.lastApi.event_id}`);
  const page = mount(TraceViewerPage, {}); await advance(1000);
  const mediaProps = () => propsOf<MediaProps>(page.output, MediaPane);
  const details = () => propsOf<DetailsProps>(page.output, DetailTabs);
  const videos = [{ name: 'video_combined.mp4', url: '/video' }];
  const pane = mount(MediaPane, { ...mediaProps(), videos });
  if (display === 'recorded') {
    const selector = findAll(pane.output, 'select').find(el => el.props['aria-label'] === '動画・記録フレーム')!;
    (selector.props.onChange as Function)({ target: { value: 'recorded' } }); await advance(0);
  }
  const player = display === 'video' ? mount(VideoPlayback, propsOf<PlayerProps>(pane.output, VideoPlayback)) : null;
  const video = () => findAll(player!.output, 'video')[0];
  const notify = (name: string) => (video().props[name] as Function)({ currentTarget: media });
  const media = {
    duration: 4, currentTime: 0, playbackRate: 1, paused: true,
    pause() { const playing = !this.paused; this.paused = true; if (playing) queueMicrotask(() => notify('onPause')); },
    play() { this.paused = false; notify('onPlay'); return Promise.resolve(); },
  };
  if (player) (video().props.ref as { current: unknown }).current = media;
  const logs = () => propsOf<TimelineProps>(player?.output ?? pane.output, Timeline);
  const timeline = mount(Timeline, logs());
  const listProps = () => propsOf<ListProps>(timeline.output, VirtualList);
  const list = mount(VirtualList<Row>, listProps());
  const root = () => findAll(list.output, 'div')[0];
  const heights = new Map<string, number>();
  const height = (row: Row) => heights.get(row.node.key) ?? listProps().estimateHeight(row);
  const offset = (key: string) => {
    let result = 0;
    for (const row of listProps().items) { if (row.node.key === key) return result; result += height(row); }
    throw new Error(`missing row ${key}`);
  };
  let scrollTop = 0, writes = 0;
  const container = {
    get scrollTop() { return scrollTop; }, set scrollTop(value: number) { writes++; scrollTop = value; },
    clientHeight: 300,
    get scrollHeight() { return listProps().items.reduce((total, row) => total + height(row), 0); },
    getBoundingClientRect: () => ({ top: 0, bottom: 300, height: 300 }),
    querySelector(selector: string) {
      const key = selector.match(/data-vkey="([^"]+)"/)?.[1];
      const row = listProps().items.find(row => row.node.key === key);
      return row ? { getBoundingClientRect: () => {
        const top = offset(row.node.key) - scrollTop;
        return { top, bottom: top + height(row), height: height(row) };
      } } : null;
    },
  };
  (root().props.ref as { current: unknown }).current = container;
  const sync = async () => {
    // The harness mounts one component at a time; mirror controlled props in
    // both directions as the page acknowledges the player's URL selection.
    for (let i = 0; i < 2; i++) {
      await advance(0);
      pane.update({ ...mediaProps(), videos });
      player?.update(propsOf<PlayerProps>(pane.output, VideoPlayback));
      timeline.update(logs()); list.update(listProps());
    }
    await advance(0);
  };
  if (player) { notify('onLoadedMetadata'); await sync(); }
  const nodeOf = (event: TraceEvent) => mediaProps().model.nodeOfEvent.get(event.event_id)!;
  const click = async (event: TraceEvent) => {
    const row = listProps().items.find(row => row.node.key === nodeOf(event).key)!;
    const boundary = listProps().renderItem(row) as FakeElement;
    const element = boundary.props.children as FakeElement;
    const card = mount(element.type as (props: Record<string, unknown>) => unknown, element.props);
    try {
      const button = findAll(card.output, 'button').find(el => el.props['data-timeline-event'] === row.node.primary.event_id)!;
      assert.ok(button, 'click the compact row header');
      (root().props.onPointerDown as Function)();
      (button.props.onClick as Function)(); await sync();
    } finally { card.unmount(); }
  };
  const position = async (event: TraceEvent, top = 250) => {
    (root().props.onWheel as Function)();
    scrollTop = offset(nodeOf(event).key) - top;
    (root().props.onScroll as Function)(); await advance(32);
    writes = 0;
  };
  return { rec, page, pane, player, timeline, media, mediaProps, details, logs, listProps, list, root, container, heights,
    nodeOf, notify, sync, click, position, writes: () => writes,
    top: (event: TraceEvent) => offset(nodeOf(event).key) - scrollTop,
    async navigate(event: TraceEvent) { popState(`${url}&event=${event.event_id}`); await sync(); },
    close() { list.unmount(); timeline.unmount(); player?.unmount(); pane.unmount(); page.unmount(); } };
}

for (const display of ['video', 'recorded'] as const) {
  test(`compact ${display} row clicks keep the scroll token and container position while details grow`, async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
    const callbacks: ResizeObserverCallback[] = [];
    class Observer {
      constructor(callback: ResizeObserverCallback) { callbacks.push(callback); }
      observe() {} unobserve() {} disconnect() {}
    }
    Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: Observer });
    const p = await replay(display);
    try {
      await p.position(p.rec.call);
      const token = p.logs().scrollToken, before = p.container.scrollTop, top = p.top(p.rec.call);
      await p.click(p.rec.call);
      assert.equal(p.logs().scrollToken, token, 'click and selection effects leave the scroll token unchanged');
      await advance(64);
      assert.equal(p.details().selection?.eventId, p.rec.call.event_id);
      assert.equal(p.logs().scrollToken, token, 'neither onSelect nor its selection effect requests a scroll');
      assert.equal(p.container.scrollTop, before);
      assert.equal(p.top(p.rec.call), top, 'opening near the viewport bottom keeps the header under the pointer');
      const key = p.nodeOf(p.rec.call).key;
      p.heights.set(key, 900);
      const row = p.listProps().items.find(row => row.node.key === key)!;
      const target = { dataset: { vkey: key, vmeasurement: p.listProps().measurementKey!(row) },
        getBoundingClientRect: () => ({ height: 900 }) };
      callbacks[0]([{ target } as unknown as ResizeObserverEntry], {} as ResizeObserver);
      await advance(64);
      assert.equal(p.container.scrollTop, before, 'late thumbnail measurements must not create a pending reveal');
      assert.equal(p.top(p.rec.call), top);
      assert.equal(p.writes(), 0, 'VirtualList never writes scrollTop for the list selection');
      await p.click(p.rec.call); await advance(64);
      assert.equal(currentParams().get('event'), null);
      assert.equal(p.logs().scrollToken, token);
      assert.equal(p.container.scrollTop, before, 'closing leaves the header in place too');
      assert.equal(p.top(p.rec.call), top);
      await p.position(p.rec.firstApi, 20);
      await p.navigate(p.rec.call); await advance(64);
      assert.ok(p.logs().scrollToken > token, 'a URL selecting the just-collapsed event requests a fresh reveal');
      assert.ok(p.top(p.rec.call) >= 0 && p.top(p.rec.call) < 300);
    } finally {
      p.close();
      if (previous) Object.defineProperty(globalThis, 'ResizeObserver', previous);
      else Reflect.deleteProperty(globalThis, 'ResizeObserver');
    }
  });
}

test('an unmapped model-call list selection survives queued seek events until explicit replay input', async () => {
  const p = await replay('video');
  try {
    assert.equal(playbackMap(p.mediaProps().model, 'video_combined.mp4', 4).all.some(cue => cue.node.key === p.nodeOf(p.rec.call).key), false);
    await p.media.play(); p.media.currentTime = 2.3; p.notify('onTimeUpdate'); await p.sync();
    await p.position(p.rec.call);
    const token = p.logs().scrollToken, before = p.container.scrollTop;
    await p.click(p.rec.call);
    assert.equal(p.logs().scrollToken, token);
    assert.equal(p.media.paused, true);
    p.notify('onSeeked'); p.notify('onSeeking'); await p.sync();
    p.notify('onTimeUpdate'); p.notify('onSeeked'); await p.sync(); await advance(64);
    assert.equal(p.details().selection?.eventId, p.rec.call.event_id);
    assert.equal(currentParams().get('event'), p.rec.call.event_id);
    assert.equal(p.logs().scrollToken, token);
    assert.equal(p.container.scrollTop, before, 'the list must not jump to the cue at the landed position or episode #1');
    assert.equal(p.writes(), 0);
    await p.media.play(); await p.sync();
    assert.equal(p.details().selection?.eventId, p.rec.lastApi.event_id, 'explicit play releases the held selection');
    await p.click(p.rec.call);
    const slider = findAll(p.player!.output, 'input').find(el => el.props['aria-label'] === '動画の再生位置')!;
    (slider.props.onChange as Function)({ target: { value: '0' } }); await p.sync();
    assert.equal(p.details().selection?.eventId, p.rec.firstApi.event_id, 'explicit seek releases it too');
  } finally { p.close(); }
});

for (const display of ['video', 'recorded'] as const) {
  test(`playback and URL selections still reveal their compact ${display} rows`, async () => {
    const p = await replay(display);
    try {
      await p.position(p.rec.call);
      const before = p.container.scrollTop, token = p.logs().scrollToken;
      p.mediaProps().onPlaybackSelect!(p.nodeOf(p.rec.firstApi)); await p.sync(); await advance(64);
      assert.ok(p.logs().scrollToken > token);
      assert.ok(p.container.scrollTop < before);
      assert.ok(p.top(p.rec.firstApi) >= 0 && p.top(p.rec.firstApi) < 300);
      const playbackToken = p.logs().scrollToken;
      await p.navigate(p.rec.call); await advance(64);
      assert.ok(p.logs().scrollToken > playbackToken);
      assert.ok(p.top(p.rec.call) >= 0 && p.top(p.rec.call) < 300, 'URL selection reveals a distant row');
    } finally { p.close(); }
  });
}

test('keyboard next and previous selections still request row scrolling', async () => {
  const p = await replay('recorded');
  try {
    await p.position(p.rec.call);
    await p.click(p.rec.call);
    await p.position(p.rec.firstApi, 20);
    const token = p.logs().scrollToken;
    const keyDown = (key: string) => (findAll(p.timeline.output, 'div')[0].props.onKeyDown as Function)({
      key, target: { tagName: 'DIV' }, preventDefault() {},
    });
    keyDown('ArrowDown'); await p.sync(); await advance(64);
    assert.ok(p.logs().scrollToken > token);
    const next = p.details().selection!.node;
    assert.ok(next.seq > p.nodeOf(p.rec.call).seq);
    const nextRow = p.container.querySelector(`[data-vkey="${next.key}"]`)!.getBoundingClientRect();
    assert.ok(nextRow.top >= 0 && nextRow.top < 300);
    const nextToken = p.logs().scrollToken;
    keyDown('ArrowUp'); await p.sync(); await advance(64);
    assert.equal(p.details().selection?.eventId, p.rec.call.event_id);
    assert.ok(p.logs().scrollToken > nextToken);
    assert.ok(p.top(p.rec.call) >= 0 && p.top(p.rec.call) < 300);
  } finally { p.close(); }
});

test('an in-row source-call link still reveals the linked row', async () => {
  const p = await replay('recorded');
  const children: Array<{ unmount(): void }> = [];
  const render = (element: FakeElement) => {
    const child = mount(element.type as (props: Record<string, unknown>) => unknown, element.props);
    children.push(child); return child;
  };
  try {
    await p.click(p.rec.firstBlock);
    await p.position(p.rec.call);
    const token = p.logs().scrollToken, before = p.container.scrollTop;
    const row = p.listProps().items.find(row => row.node.key === p.nodeOf(p.rec.firstBlock).key)!;
    const boundary = p.listProps().renderItem(row) as FakeElement;
    const card = render(boundary.props.children as FakeElement);
    const body = render(namedElement(card.output, 'CardBody')!);
    const code = render(namedElement(body.output, 'CodeBlockBody')!);
    const link = namedElement(code.output, 'EventLink');
    if (!link) throw new Error('the expanded code row must link to its source call');
    (link.props.onClick as Function)(); await p.sync(); await advance(64);
    assert.equal(p.details().selection?.eventId, p.rec.sourceCall.event_id);
    assert.ok(p.logs().scrollToken > token, 'in-row links are navigation rather than disclosure clicks');
    assert.ok(p.container.scrollTop < before);
    assert.ok(p.top(p.rec.sourceCall) >= 0 && p.top(p.rec.sourceCall) < 300);
  } finally { children.reverse().forEach(child => child.unmount()); p.close(); }
});
