import test from 'node:test';
import assert from 'node:assert/strict';
import { advance, currentParams, findAll, popState, propsOf, requests, resetBrowser, setLocation, type FakeElement } from './harness/browser';
import { mount } from './harness/fakeReact';
import TraceViewerPage from '../TraceViewerPage';
import { MediaPane } from '../components/MediaPane';
import { VideoPlayback } from '../components/VideoPlayback';
import { DetailTabs } from '../components/DetailTabs';
import { Timeline } from '../components/Timeline';
import { VirtualList } from '../components/VirtualList';
import { TopBar } from '../components/TopBar';
import { playbackMap } from '../playback';
import type { TNode } from '../model';
import type { EpisodeSummary, TraceEvent } from '../types';
import { Rec } from './fixtures';
import { addEpisode, ev, makeRun, serve } from './pageServer';

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

async function replay(display: 'video' | 'recorded', summary: Partial<EpisodeSummary> = {}) {
  resetBrowser();
  const rec = recording(); const run = makeRun();
  const episode = addEpisode(run, 'e1', { status: 'ended', trace_complete: true, ...summary },
    rec.events.filter(event => summary.status !== 'incomplete' || event.event_type !== 'episode_end')
      .map(event => ({ ...event, run_id: 'r1', episode_id: 'e1' })));
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
  return { rec, episode, page, pane, player, timeline, media, mediaProps, details, logs, listProps, list, root, container, heights,
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

for (const [age, interval] of [[120, 20_000], [3600, 60_000]] as const) {
  test(`incomplete compact API details survive heartbeat-only polls (${age}s old)`, async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
    const observed: unknown[] = [], unobserved: unknown[] = [];
    class Observer {
      constructor(readonly callback: ResizeObserverCallback) {}
      observe(target: unknown) { observed.push(target); }
      unobserve(target: unknown) { unobserved.push(target); }
      disconnect() {}
    }
    Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: Observer });
    const p = await replay('recorded', { status: 'incomplete', trace_complete: false, heartbeat_age_s: age });
    let measured: ReturnType<typeof mount<Record<string, unknown>>> | null = null;
    try {
      // Actually close and open the selected API through its compact header.
      await p.click(p.rec.lastApi); await p.click(p.rec.lastApi);
      propsOf<Parameters<typeof TopBar>[0]>(p.page.output, TopBar).onLive(true);
      await p.sync();
      const firstRow = p.listProps().items[0];
      const firstKey = p.listProps().itemKey(firstRow);
      const rowType = namedElement(p.list.output, 'MeasuredRow')!.type;
      const rowElements = () => findAll(p.list.output, rowType) as Array<FakeElement & { key: string }>;
      const observer = rowElements()[0].props.observer as Observer;
      // A tall row measured before it leaves the window must keep contributing
      // its real height when the parent is re-rendered by summary/event polls.
      p.heights.set(firstKey, 500);
      observer.callback([{ target: { dataset: { vkey: firstKey, vmeasurement: p.listProps().measurementKey!(firstRow) },
        getBoundingClientRect: () => ({ height: 500 }) } } as unknown as ResizeObserverEntry], {} as ResizeObserver);
      await advance(32);
      await p.position(p.rec.lastApi, 80);
      const key = p.nodeOf(p.rec.lastApi).key;
      const element = () => rowElements().find(row => row.props.vkey === key)!;
      const initialElement = element();
      assert.ok(initialElement, 'the expanded API row is mounted in the virtual window');
      const target = { dataset: { vkey: key, vmeasurement: initialElement.props.measurement },
        getBoundingClientRect: () => ({ height: 118 }) };
      // The harness renders one component at a time. Retain the keyed measured
      // row as React would, and supply its DOM ref before layout effects run.
      measured = mount((props: Record<string, unknown>) => {
        const output = (rowType as (props: Record<string, unknown>) => FakeElement)(props);
        (output.props.ref as { current: unknown }).current = target;
        return output;
      }, initialElement.props);
      const model = p.logs().model, rows = p.listProps().items, videos = p.mediaProps().videos;
      const summary = p.logs().summary;
      const measurement = p.listProps().measurementKey!(rows.find(row => row.node.key === key)!);
      const before = p.container.scrollTop, top = p.top(p.rec.lastApi);
      const spacer = () => (findAll(p.list.output, 'div')[1].props.style as { height: number }).height;
      const leadingHeight = spacer(), subscriptions = observed.length, removals = unobserved.length;
      const readsBefore = requests(/\/episodes\/e1$/).sent;
      const eventReadsBefore = requests(/\/events$/).sent;
      for (let i = 1; i <= 3; i++) {
        p.episode.summary = { ...p.episode.summary, heartbeat_age_s: age + i * interval / 1000 };
        await advance(interval + 50); await p.sync();
        assert.equal(p.logs().model, model, 'heartbeat and empty event reads do not rebuild the episode model');
        assert.equal(p.listProps().items, rows, 'the Timeline keeps the same derived row array');
        assert.equal(p.logs().summary, summary, 'content above the list receives a stable summary');
        assert.equal(p.mediaProps().videos, videos, 'heartbeat-only reads do not rebuild the media descriptors');
        assert.equal(element().type, initialElement.type);
        assert.equal(element().key, initialElement.key, 'the visible API row keeps its React identity');
        measured.update(element().props);
        assert.equal(p.listProps().measurementKey!(rows.find(row => row.node.key === key)!), measurement);
        assert.equal(observed.length, subscriptions, 'the row remains mounted without restarting its measurement');
        assert.equal(unobserved.length, removals, 'the row measurement is never torn down');
        assert.equal(spacer(), leadingHeight, 'offscreen measured heights survive the polls');
        assert.equal(p.container.scrollTop, before);
        assert.equal(p.top(p.rec.lastApi), top);
        assert.equal(p.writes(), 0, 'polling never requests a selection scroll');
      }
      assert.equal(requests(/\/episodes\/e1$/).sent - readsBefore, 3, 'three summary polls ran');
      assert.equal(requests(/\/events$/).sent - eventReadsBefore, 3, 'three empty Live event refreshes ran');
      for (const re of [/\/episodes\/e1$/, /\/events$/]) {
        const reads = requests(re).list;
        for (let i = 2; i < reads.length; i++) assert.ok(reads[i].sentAt - reads[i - 1].sentAt >= interval,
          'stale incomplete traces are read at most once a minute');
      }
    } finally {
      measured?.unmount(); p.close();
      if (previous) Object.defineProperty(globalThis, 'ResizeObserver', previous);
      else Reflect.deleteProperty(globalThis, 'ResizeObserver');
    }
  });
}

test('a stale incomplete trial still imports new events into its expanded compact log', async () => {
  const p = await replay('recorded', { status: 'incomplete', trace_complete: false, heartbeat_age_s: 3600 });
  try {
    await p.click(p.rec.lastApi); await p.click(p.rec.lastApi);
    propsOf<Parameters<typeof TopBar>[0]>(p.page.output, TopBar).onLive(true);
    await p.sync(); await p.position(p.rec.lastApi, 80);
    const before = p.logs().model, rows = p.listProps().items;
    const added = ev('e1', Math.max(...p.episode.events.map(event => event.seq)) + 1, 'trace_warning', { message: 'imported after wall-clock limit' });
    p.episode.events.push(added);
    p.episode.summary = { ...p.episode.summary, heartbeat_age_s: 3660 };
    await advance(60_100); await p.sync();
    assert.notEqual(p.logs().model, before, 'new events rebuild the episode model');
    assert.notEqual(p.listProps().items, rows, 'new data rebuilds the Timeline rows');
    const node = p.logs().model.nodeOfEvent.get(added.event_id);
    if (!node) throw new Error('the next minute poll must import the new event without manual refresh');
    assert.ok(p.listProps().items.some(row => row.node.key === node.key));
    assert.ok(p.listProps().items.find(row => row.node.key === p.nodeOf(p.rec.lastApi).key)?.expanded,
      'the API details stay expanded after imported data arrives');
  } finally { p.close(); }
});

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
