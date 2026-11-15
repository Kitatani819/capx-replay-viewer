import test from 'node:test';
import assert from 'node:assert/strict';
import { advance, findAll, propsOf, resetBrowser, setLocation } from './harness/browser';
import { mount } from './harness/fakeReact';
import { buildEpisodeModel, type TNode } from '../model';
import type { TraceEvent } from '../types';
import { VideoPlayback } from '../components/VideoPlayback';
import { ApiPythonPanel } from '../components/ApiPythonPanel';
import { MediaPane } from '../components/MediaPane';
import { DetailTabs } from '../components/DetailTabs';
import { ApiTurnModelTab } from '../components/tabs/ApiTurnModelTab';
import { EnsembleTab } from '../components/tabs/EnsembleTab';
import TraceViewerPage from '../TraceViewerPage';
import { Rec } from './fixtures';
import { addEpisode, makeRun, serve } from './pageServer';

type PlayerProps = Parameters<typeof VideoPlayback>[0];
type PanelProps = Parameters<typeof ApiPythonPanel>[0];
type MediaProps = Parameters<typeof MediaPane>[0];
type DetailsProps = Parameters<typeof DetailTabs>[0];

function recording() {
  const r = new Rec(); r.episodeStart();
  const at = (event: TraceEvent, step: number) => { event.sim_step = step; event.sim_epoch = 0; return event; };
  r.add('frame', { camera: 'main', epoch: 0, buffer_index: 0, sim_step: 0 });
  const request = at(r.request('code_generator', 'generator', 1, { turn_index: 1 }), 0);
  const response = r.response(request, 200, 'first model answer');
  const block = at(r.blockStart(response, 'target = [0, 0, 1]\n# approach\ngoto_pose(target)\nclose_gripper()', { turn_index: 1 }), 0);
  const first = at(r.apiStart(block, 'goto_pose'), 15);
  at(r.apiEnd(first), 15);
  const same = at(r.apiStart(block, 'close_gripper', {}, null, {
    call_site: { code_block_id: block.event_id, line: 4 },
  }), 15);
  at(r.apiEnd(same), 30);
  at(r.blockEnd(block, 0, 0), 30);
  const request2 = at(r.request('code_generator', 'generator2', 1, { turn_index: 2 }), 60);
  const response2 = r.response(request2, 200, 'second model answer');
  const block2 = at(r.blockStart(response2, 'target = [0, 0, 2]\n# lift\ngoto_pose(target)', { block_index: 1, turn_index: 2 }), 60);
  const later = at(r.apiStart(block2, 'goto_pose'), 75);
  at(r.apiEnd(later), 90);
  at(r.blockEnd(block2, 0, 0), 90);
  r.add('frame', { camera: 'main', epoch: 0, buffer_index: 119, sim_step: 119 });
  r.add('trial_videos', {});
  const model = buildEpisodeModel(r.events);
  const node = (event: TraceEvent) => model.nodeOfEvent.get(event.event_id)!;
  return { model, events: r.events, block: node(block), block2: node(block2), first: node(first), same: node(same), later: node(later) };
}

function player(rec: ReturnType<typeof recording>) {
  const selections: { node: TNode; openDetail: boolean | undefined }[] = [];
  const modes: boolean[] = [];
  const props: PlayerProps = {
    model: rec.model, ep: { runId: 'run', episodeId: 'ep' }, videos: [{ name: 'video_combined.mp4', url: '/video' }],
    initialKey: rec.block.key, logPanel: 'recorded logs',
    onSelect: (node, openDetail) => selections.push({ node, openDetail }), onApiPythonModeChange: active => modes.push(active),
  };
  const page = mount(VideoPlayback, props);
  const video = () => findAll(page.output, 'video')[0];
  const media = {
    duration: 4, currentTime: 0, playbackRate: 1, paused: true, pauses: 0,
    pause() {
      this.pauses++;
      const wasPaused = this.paused; this.paused = true;
      // Native pause events are queued, and a paused video emits no second one.
      if (!wasPaused) queueMicrotask(() => (video().props.onPause as Function)({ currentTarget: this }));
    },
    play() { this.paused = false; (video().props.onPlay as Function)(); return Promise.resolve(); },
  };
  (video().props.ref as { current: unknown }).current = media;
  const mode = () => findAll(page.output, 'select').find(element => element.props['aria-label'] === '表示する処理')!;
  const panel = () => propsOf<PanelProps>(page.output, ApiPythonPanel);
  // Mirror the controlled parent accepting the event returned by the player.
  const accept = async () => {
    await advance(0);
    const selected = selections.at(-1);
    if (selected) page.update({ ...page.props, initialKey: selected.node.key });
    await advance(0);
  };
  const metadata = async () => { (video().props.onLoadedMetadata as Function)({ currentTarget: media }); await advance(0); };
  const changeMode = async (value: string) => { (mode().props.onChange as Function)({ target: { value } }); await accept(); };
  const moveTime = async (time: number) => { media.currentTime = time; (video().props.onTimeUpdate as Function)({ currentTarget: media }); await accept(); };
  return { page, media, video, mode, panel, selections, modes, accept, metadata, changeMode, moveTime };
}

test('entering API/Python while playing selects the API at this position without pausing or seeking', async () => {
  resetBrowser(); const rec = recording(); const p = player(rec);
  await p.metadata(); await p.media.play(); await p.moveTime(.75);
  const pauses = p.media.pauses;
  await p.changeMode('api-python');
  assert.equal(p.media.currentTime, .75);
  assert.equal(p.media.pauses, pauses);
  assert.equal(p.media.paused, false);
  assert.equal(p.panel().selectedKey, rec.same.key);
  assert.equal(p.selections.at(-1)?.openDetail, true);
  assert.equal(p.modes.at(-1), true);
  await p.moveTime(2.75);
  assert.equal(p.panel().selectedKey, rec.later.key, 'playback continues following API events');
  assert.equal(p.media.paused, false);
  assert.equal(p.media.pauses, pauses, 'accepting player selections must not feed back as a manual seek');
  p.page.unmount();
});

test('API clicks pause and seek; individual same-frame selections survive late paused timeupdates', async () => {
  resetBrowser(); const rec = recording(); const p = player(rec);
  await p.metadata(); await p.changeMode('api-python');
  await p.media.play(); await p.moveTime(2.75);
  p.panel().onSelect(rec.first); await p.accept();
  assert.equal(p.media.currentTime, .5);
  assert.equal(p.media.paused, true);
  assert.equal(p.panel().selectedKey, rec.first.key);
  assert.equal(p.selections.at(-1)?.openDetail, true);
  const peers = p.panel().apiCues.filter(cue => cue.time === .5).map(cue => cue.node.key);
  assert.deepEqual(peers, [rec.first.key, rec.same.key], 'same-frame APIs retain their recorded order');
  p.panel().onSelect(rec.same); await p.accept();
  assert.equal(p.media.currentTime, .5);
  assert.equal(p.panel().selectedKey, rec.same.key);
  p.panel().onSelect(rec.first); await p.accept();
  const count = p.selections.length;
  await p.moveTime(.5);
  assert.equal(p.selections.length, count, 'the last API in the frame cannot overwrite a manual selection');
  assert.equal(p.panel().selectedKey, rec.first.key);
  assert.equal(p.media.paused, true);
  p.page.unmount();
});

test('hover previews neither select APIs nor move the recording, and block navigation keeps API/Python mode', async () => {
  resetBrowser(); const rec = recording(); const p = player(rec);
  await p.metadata(); await p.changeMode('api-python');
  p.panel().onSelect(rec.first); await p.accept();
  const panel = mount(ApiPythonPanel, p.panel());
  const row = findAll(panel.output, 'button').find(button => button.props['data-api-event'] === rec.later.primary.event_id)!;
  const count = p.selections.length, time = p.media.currentTime, pauses = p.media.pauses;
  (row.props.onMouseEnter as Function)({ currentTarget: { getBoundingClientRect: () => ({ left: 20, bottom: 80 }) } });
  await advance(0);
  assert.equal(findAll(panel.output, 'div').filter(element => element.props.role === 'tooltip').length, 1);
  (row.props.onMouseLeave as Function)(); await advance(0);
  assert.equal(p.selections.length, count);
  assert.equal(p.panel().selectedKey, rec.first.key);
  assert.equal(p.media.currentTime, time);
  assert.equal(p.media.pauses, pauses);
  const next = findAll(panel.output, 'button').find(button => button.props['aria-label'] === '次のコードブロック')!;
  (next.props.onClick as Function)(); await p.accept();
  assert.equal(p.panel().selectedKey, rec.block2.key);
  assert.equal(p.mode().props.value, 'api-python');
  assert.equal(p.media.currentTime, 2);
  panel.update(p.panel());
  const previous = findAll(panel.output, 'button').find(button => button.props['aria-label'] === '前のコードブロック')!;
  (previous.props.onClick as Function)(); await p.accept();
  assert.equal(p.panel().selectedKey, rec.block.key);
  assert.equal(p.mode().props.value, 'api-python');
  assert.equal(p.media.currentTime, 0);
  assert.equal(p.media.paused, true);
  panel.unmount(); p.page.unmount();
});

test('API/Python mode callback follows log visibility, filter changes and unmount without moving paused video', async () => {
  resetBrowser(); const rec = recording(); const p = player(rec);
  await p.metadata(); await p.changeMode('api-python');
  p.panel().onSelect(rec.first); await p.accept();
  const time = p.media.currentTime, pauses = p.media.pauses;
  const toggle = (label: string) => findAll(p.page.output, 'button').find(button => button.props.children === label)!;
  (toggle('詳細ログ').props.onClick as Function)(); await advance(0);
  assert.equal(p.modes.at(-1), false);
  assert.equal(findAll(p.page.output, ApiPythonPanel).length, 0);
  (toggle('処理タイムライン').props.onClick as Function)(); await advance(0);
  assert.equal(p.modes.at(-1), true);
  assert.equal(p.panel().selectedKey, rec.first.key);
  await p.changeMode('all');
  assert.equal(p.modes.at(-1), false);
  assert.equal(p.media.currentTime, time);
  assert.equal(p.media.pauses, pauses);
  await p.changeMode('api-python');
  p.page.unmount();
  assert.equal(p.modes.at(-1), false, 'unmount clears the parent inspector mode');
});

test('entering API/Python aligns an active turn filter with the selected last API without seeking or pausing', async () => {
  resetBrowser(); const original = recording();
  // Turn 2 contains executed code but no recorded API. At its video position,
  // the last API is still the turn 1 call, which must not be hidden by filtering.
  const events = original.events.filter(event => event.event_id !== original.later.primary.event_id && event.parent_event_id !== original.later.primary.event_id);
  const rec = { ...original, model: buildEpisodeModel(events) };
  const p = player(rec); await p.metadata();
  const turn = () => findAll(p.page.output, 'select').find(element => element.props['aria-label'] === 'リプレイのターン')!;
  (turn().props.onChange as Function)({ target: { value: '2' } }); await p.accept();
  assert.equal(turn().props.value, 2);
  assert.equal(p.media.currentTime, 2);
  const pauses = p.media.pauses;
  await p.changeMode('api-python');
  assert.equal(p.panel().selectedKey, rec.same.key);
  assert.equal(p.panel().turn, 1);
  assert.equal(turn().props.value, 1, 'the selected API must remain visible under the active turn filter');
  assert.equal(p.media.currentTime, 2, 'changing the display filter must not rewind to the earlier API');
  assert.equal(p.media.pauses, pauses);
  assert.equal(p.media.paused, true);
  p.page.unmount();
});

test('page forwards API/Python mode and preserves API selection and seek state while inspecting all three tabs', async () => {
  resetBrowser(); const rec = recording(); const run = makeRun();
  addEpisode(run, 'e1', { status: 'ended', trace_complete: true }, rec.events.map(event => ({ ...event, run_id: 'r1', episode_id: 'e1' })));
  serve(run); setLocation(`/traces?view=details&run=r1&episode=e1&event=${rec.first.primary.event_id}`);
  const page = mount(TraceViewerPage, {}); await advance(1000);
  const media = () => propsOf<MediaProps>(page.output, MediaPane);
  const details = () => propsOf<DetailsProps>(page.output, DetailTabs);
  assert.equal(details().apiPythonMode, false);
  media().onApiPythonModeChange!(true); await advance(0);
  assert.equal(details().apiPythonMode, true);
  const api = media().model.nodeOfEvent.get(rec.same.primary.event_id)!;
  media().onPlaybackSelect!(api, true); await advance(0);
  assert.equal(details().selection?.eventId, api.primary.event_id);
  assert.equal(media().seekRequest, null, 'playback selections do not create a manual seek token');
  const inspector = mount(DetailTabs, details());
  assert.equal(propsOf<Parameters<typeof ApiTurnModelTab>[0]>(inspector.output, ApiTurnModelTab).selection.node.key, api.key);
  for (const tab of [1, 2, 0]) {
    details().onTab(tab); await advance(0); inspector.update(details());
    assert.equal(media().selection?.node.key, api.key);
    assert.equal(media().seekRequest, null);
    assert.equal(details().apiPythonMode, true);
    if (tab) assert.equal(propsOf<Parameters<typeof EnsembleTab>[0]>(inspector.output, EnsembleTab).mode, tab === 1 ? 'candidates' : 'synthesis');
    else assert.equal(findAll(inspector.output, ApiTurnModelTab).length, 1);
  }
  media().onApiPythonModeChange!(false); await advance(0);
  assert.equal(details().apiPythonMode, false);
  inspector.unmount(); page.unmount();
});
