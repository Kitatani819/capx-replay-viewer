import test from 'node:test';
import assert from 'node:assert/strict';
import { advance, currentParams, findAll, popState, propsOf, resetBrowser, setLocation, type FakeElement } from './harness/browser';
import { mount } from './harness/fakeReact';
import TraceViewerPage from '../TraceViewerPage';
import { MediaPane } from '../components/MediaPane';
import { VideoPlayback } from '../components/VideoPlayback';
import { ApiPythonPanel } from '../components/ApiPythonPanel';
import { DetailTabs } from '../components/DetailTabs';
import { TopBar } from '../components/TopBar';
import { Timeline } from '../components/Timeline';
import { VirtualList } from '../components/VirtualList';
import type { TNode } from '../model';
import type { TraceEvent } from '../types';
import { Rec } from './fixtures';
import { addEpisode, makeRun, serve } from './pageServer';

type MediaProps = Parameters<typeof MediaPane>[0];
type PlayerProps = Parameters<typeof VideoPlayback>[0];
type DetailsProps = Parameters<typeof DetailTabs>[0];
type BarProps = Parameters<typeof TopBar>[0];
type TimelineProps = Parameters<typeof Timeline>[0];
interface LogRow { node: TNode; expanded: boolean }
interface LogListProps { items: LogRow[]; renderItem: (row: LogRow) => FakeElement; scrollToKey: string | null }

function recording() {
  const r = new Rec(); r.episodeStart();
  const at = (event: TraceEvent, step: number) => { event.sim_step = step; event.sim_epoch = 0; return event; };
  r.add('frame', { camera: 'main', epoch: 0, buffer_index: 0, sim_step: 0 });
  const services: TraceEvent[] = [], apis: TraceEvent[] = [];
  for (const turn of [0, 1]) {
    const block = at(r.blockStart(null, 'observe()\nsegment()\ngoto_pose(target)', { block_index: turn, turn_index: turn }), turn * 60);
    const service = at(r.add('service_call_start', {
      service: turn ? 'vdm' : 'sam3', service_call_id: `service-${turn}`, turn_index: turn,
    }, { parent: block.event_id }), turn * 60);
    at(r.add('service_call_end', { service_call_id: `service-${turn}` }, { parent: service.event_id }), turn * 60);
    services.push(service);
    // As in the browser fixture, SAM3 shares its video position with APIs.
    const api = at(r.apiStart(block, 'goto_pose'), turn * 60);
    at(r.apiEnd(api), turn * 60);
    apis.push(api);
    at(r.blockEnd(block, 0, 0), turn * 60);
  }
  r.add('frame', { camera: 'main', epoch: 0, buffer_index: 119, sim_step: 119 });
  const tail = r.add('trial_videos', {});
  return { events: r.events, sam: services[0], vdm: services[1], apis, tail };
}

async function replay(running = false) {
  resetBrowser(); const rec = recording(); const run = makeRun();
  const episode = addEpisode(run, 'e1', { status: running ? 'running' : 'ended', trace_complete: !running },
    rec.events.map(event => ({ ...event, run_id: 'r1', episode_id: 'e1' })));
  serve(run);
  const url = '/traces?view=details&run=r1&episode=e1';
  setLocation(url + (running ? '' : `&event=${rec.vdm.event_id}`));
  const page = mount(TraceViewerPage, {}); await advance(1000);
  const mediaProps = () => propsOf<MediaProps>(page.output, MediaPane);
  const details = () => propsOf<DetailsProps>(page.output, DetailTabs);
  const bar = () => propsOf<BarProps>(page.output, TopBar);
  const videos = [{ name: 'video_combined.mp4', url: '/video' }];
  const pane = mount(MediaPane, { ...mediaProps(), videos });
  const player = mount(VideoPlayback, propsOf<PlayerProps>(pane.output, VideoPlayback));
  const video = () => findAll(player.output, 'video')[0];
  const notify = (name: string) => (video().props[name] as Function)({ currentTarget: media });
  const media = {
    duration: 4, currentTime: 0, playbackRate: 1, paused: true,
    pause() {
      const wasPaused = this.paused; this.paused = true;
      if (!wasPaused) queueMicrotask(() => notify('onPause'));
    },
    play() { this.paused = false; notify('onPlay'); return Promise.resolve(); },
  };
  (video().props.ref as { current: unknown }).current = media;
  // Child components are mounted separately by the existing page harness.
  // Reflect both directions of the page/player controlled selection protocol.
  const sync = async () => {
    for (let i = 0; i < 2; i++) {
      await advance(0);
      pane.update({ ...mediaProps(), videos });
      player.update(propsOf<PlayerProps>(pane.output, VideoPlayback));
    }
    await advance(0);
  };
  const turn = () => findAll(player.output, 'select').find(select => select.props['aria-label'] === 'リプレイのターン')!;
  const panel = () => propsOf<Parameters<typeof ApiPythonPanel>[0]>(player.output, ApiPythonPanel);
  const logs = () => propsOf<TimelineProps>(player.output, Timeline);
  const chooseDisplay = async (label: '一覧' | 'APIとPython') => {
    const button = findAll(player.output, 'button').find(button => button.props.children === label)!;
    (button.props.onClick as () => void)(); await sync();
  };
  const nodeOf = (event: TraceEvent) => mediaProps().model.nodeOfEvent.get(event.event_id)!;
  const selected = () => details().selection?.eventId;
  const navigate = async (event: TraceEvent) => { popState(`${url}&event=${event.event_id}`); await sync(); };
  const move = async (time: number) => { media.currentTime = time; notify('onTimeUpdate'); await sync(); };
  notify('onLoadedMetadata'); await sync();
  return { rec, episode, page, pane, player, media, notify, sync, turn, panel, logs, chooseDisplay, nodeOf, selected, navigate, move, details, bar,
    close() { player.unmount(); pane.unmount(); page.unmount(); } };
}

for (const mapped of [true, false]) test(`URL selection survives overlapping turn-seek media events (${mapped ? 'mapped SAM3' : 'unmapped video record'})`, async () => {
  const p = await replay();
  await p.chooseDisplay('APIとPython');
  try {
    assert.equal(p.selected(), p.rec.vdm.event_id);
    assert.equal(p.media.currentTime, 2);
    p.details().onTab(2); await p.sync();
    await p.media.play(); await p.move(2.3);
    assert.equal(p.selected(), p.rec.apis[1].event_id);
    assert.equal(p.media.paused, false);
    (p.turn().props.onChange as Function)({ target: { value: '1' } }); await p.sync();
    assert.equal(p.turn().props.value, 1);
    assert.equal(p.media.currentTime, 2);

    const incoming = mapped ? p.rec.sam : p.rec.tail;
    await p.navigate(incoming);
    assert.equal(p.selected(), incoming.event_id);
    assert.equal(p.media.currentTime, mapped ? 0 : 2);
    // A completed earlier seek can dispatch seeked before the seeking task
    // queued by the latest turn/URL seek. Both read the video's current time.
    p.notify('onSeeked'); p.notify('onSeeking'); await p.sync();
    p.notify('onTimeUpdate'); p.notify('onSeeked'); await p.sync();
    assert.equal(p.selected(), incoming.event_id, 'queued media events must not replace the URL with the same-position API');
    assert.equal(currentParams().get('event'), incoming.event_id);
    assert.equal(p.media.paused, true);
    assert.equal(p.media.currentTime, mapped ? 0 : 2);
    assert.equal(p.details().tab, 2);
    if (mapped) assert.equal(p.turn().props.value, 0);
    assert.equal(p.panel().selectedKey, p.nodeOf(incoming).key);
    assert.equal(p.panel().apiCues.some(cue => cue.node.key === p.panel().selectedKey), false, 'a service or unmapped record cannot highlight an unrelated API');

    // An intentional slider seek at the exact same time still resumes API
    // following and preserves both the requested stop position and right tab.
    const slider = findAll(p.player.output, 'input').find(input => input.props['aria-label'] === '動画の再生位置')!;
    (slider.props.onChange as Function)({ target: { value: String(p.media.currentTime) } }); await p.sync();
    assert.equal(p.selected(), p.rec.apis[mapped ? 0 : 1].event_id);
    assert.equal(p.media.currentTime, mapped ? 0 : 2);
    assert.equal(p.media.paused, true);
    assert.equal(p.details().tab, 2);
  } finally { p.close(); }
});

test('URL-held service and unmapped selections release to native seek and playback; Live regains the latest event', async () => {
  const p = await replay(true);
  await p.chooseDisplay('APIとPython');
  try {
    assert.equal(p.bar().live, true);
    assert.equal(p.selected(), p.rec.tail.event_id);
    assert.equal(p.panel().apiCues.some(cue => cue.node.key === p.panel().selectedKey), false);
    await p.navigate(p.rec.sam);
    p.notify('onSeeking'); p.notify('onSeeked'); await p.sync();
    assert.equal(p.bar().live, false);
    assert.equal(p.selected(), p.rec.sam.event_id);
    assert.equal(p.media.paused, true);

    // A different native seek is intentional and keeps that position paused.
    p.media.currentTime = 2.3; p.notify('onSeeking'); p.notify('onSeeked'); await p.sync();
    assert.equal(p.selected(), p.rec.apis[1].event_id);
    assert.equal(p.media.currentTime, 2.3);
    assert.equal(p.media.paused, true);
    await p.navigate(p.rec.tail);
    assert.equal(p.media.currentTime, 2.3);
    assert.equal(p.selected(), p.rec.tail.event_id);
    await p.media.play(); await p.move(2.4);
    assert.equal(p.selected(), p.rec.apis[1].event_id);
    assert.equal(p.media.paused, false);

    p.bar().onLive(true); await p.sync();
    assert.equal(p.media.paused, true);
    assert.equal(p.selected(), p.rec.tail.event_id);
    assert.equal(p.bar().live, true);
    const warning = { ...p.rec.tail, run_id: 'r1', episode_id: 'e1', event_id: 'new-live-warning',
      seq: p.rec.tail.seq + 1, event_type: 'trace_warning', data: { message: 'latest Live event' } };
    p.episode.events.push(warning); await advance(1500); await p.sync();
    assert.equal(p.selected(), warning.event_id);
    assert.equal(p.bar().live, true);
    await p.navigate(p.rec.vdm);
    assert.equal(p.bar().live, false);
    assert.equal(p.selected(), p.rec.vdm.event_id);
    assert.equal(p.media.currentTime, 2);
    assert.equal(p.media.paused, true);
  } finally { p.close(); }
});

test('the default compact list expands and scrolls to URL, playback, slider and API-time selections; row clicks pause and seek', async () => {
  const p = await replay();
  const timeline = mount(Timeline, p.logs());
  const syncLog = () => timeline.update(p.logs());
  const list = () => propsOf<LogListProps>(timeline.output, VirtualList);
  const selectedRow = (event: TraceEvent) => {
    syncLog();
    assert.equal(p.logs().selectedEventId, event.event_id);
    const key = p.nodeOf(event).key;
    assert.equal(p.logs().selectedKey, key);
    assert.equal(list().scrollToKey, key);
    const row = list().items.find(row => row.node.key === key);
    if (!row) throw new Error('selected event is not reachable in the compact list');
    assert.equal(row.expanded, true, 'selection expands its details');
  };
  try {
    assert.equal(findAll(p.player.output, 'button').find(button => button.props.children === '一覧')?.props['aria-pressed'], true);
    assert.equal(findAll(p.player.output, ApiPythonPanel).length, 0);
    selectedRow(p.rec.vdm);
    await p.media.play(); await p.move(2.3);
    assert.equal(p.media.paused, false);
    selectedRow(p.rec.apis[1]);
    await p.navigate(p.rec.sam);
    assert.equal(p.media.paused, true);
    selectedRow(p.rec.sam);
    const slider = findAll(p.player.output, 'input').find(input => input.props['aria-label'] === '動画の再生位置')!;
    (slider.props.onChange as Function)({ target: { value: '2.3' } }); await p.sync();
    assert.equal(p.media.currentTime, 2.3);
    selectedRow(p.rec.apis[1]);

    await p.chooseDisplay('APIとPython');
    const apiPanel = mount(ApiPythonPanel, p.panel());
    try {
      const row = findAll(apiPanel.output, 'button').find(button => button.props['data-api-event'] === p.rec.apis[0].event_id)!;
      assert.ok(row, 'API video-time row is selectable');
      (row.props.onClick as () => void)(); await p.sync();
    } finally { apiPanel.unmount(); }
    await p.chooseDisplay('一覧');
    selectedRow(p.rec.apis[0]);

    await p.navigate(p.rec.vdm);
    selectedRow(p.rec.vdm);
    await p.media.play(); await p.sync();
    assert.equal(p.media.paused, false);
    selectedRow(p.rec.apis[1]);
    const api = p.nodeOf(p.rec.apis[0]);
    const row = list().items.find(row => row.node.key === api.key)!;
    const boundary = list().renderItem(row);
    const element = boundary.props.children as FakeElement;
    const card = mount(element.type as (props: Record<string, unknown>) => unknown, element.props);
    try {
      const button = findAll(card.output, 'button').find(button => button.props['data-timeline-event'] === api.primary.event_id)!;
      assert.ok(button, 'compact row is clickable');
      (button.props.onClick as () => void)(); await p.sync();
    } finally { card.unmount(); }
    assert.equal(p.media.paused, true);
    assert.equal(p.media.currentTime, 0);
    assert.equal(currentParams().get('event'), api.primary.event_id);
    selectedRow(p.rec.apis[0]);
    assert.equal(findAll(p.player.output, 'button').find(button => button.props.children === '一覧')?.props['aria-pressed'], true);
  } finally { timeline.unmount(); p.close(); }
});
