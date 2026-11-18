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
import { Timeline } from '../components/Timeline';
import { Badge } from '../components/common';
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
  const visibility: boolean[] = [];
  const props: PlayerProps = {
    model: rec.model, ep: { runId: 'run', episodeId: 'ep' }, videos: [{ name: 'video_combined.mp4', url: '/video' }],
    initialKey: rec.block.key, logPanel: 'recorded logs',
    onSelect: (node, openDetail) => selections.push({ node, openDetail }), onApiPythonVisibleChange: visible => visibility.push(visible),
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
  const panel = () => propsOf<PanelProps>(page.output, ApiPythonPanel);
  // Mirror the controlled parent accepting the event returned by the player.
  const accept = async () => {
    await advance(0);
    const selected = selections.at(-1);
    if (selected) page.update({ ...page.props, initialKey: selected.node.key });
    await advance(0);
  };
  const metadata = async () => { (video().props.onLoadedMetadata as Function)({ currentTarget: media }); await advance(0); };
  const toggleLogs = async () => {
    const button = findAll(page.output, 'button').find(element =>
      element.props.children === '詳細ログ' || element.props.children === 'APIとPythonに戻る')!;
    (button.props.onClick as Function)(); await advance(0);
  };
  const moveTime = async (time: number) => { media.currentTime = time; (video().props.onTimeUpdate as Function)({ currentTarget: media }); await accept(); };
  return { page, media, video, panel, selections, visibility, accept, metadata, toggleLogs, moveTime };
}

test('a recorded evaluation beyond the final frame stays selectable without changing the video position', async () => {
  resetBrowser();
  const rec = recording();
  const last = rec.events.at(-1)!;
  const evaluation: TraceEvent = {
    ...last, event_id: 'final-evaluation', event_type: 'evaluator_result', seq: last.seq + 1,
    sim_step: 120, sim_epoch: 0, data: { scope: 'episode', reward: 1, task_completed: true },
  };
  const events = [...rec.events, evaluation];
  const p = player({ ...rec, events, model: buildEpisodeModel(events) });
  await p.metadata();
  await p.media.play();
  await p.moveTime(3.25);
  await p.toggleLogs();
  const selectedKey = p.page.props.model.nodeOfEvent.get(evaluation.event_id)!.key;
  // Detailed-log selections arrive through the controlled parent and seek token.
  p.page.update({ ...p.page.props, initialKey: selectedKey, seekRequest: { key: selectedKey, token: 1 } });
  await advance(0);
  assert.equal(p.media.currentTime, 3.25);
  assert.equal(p.media.paused, true);
  await p.toggleLogs();
  assert.equal(p.panel().selectedKey, selectedKey);
  p.page.unmount();
});

test('unsynced process rows switch turn recordings and remain selectable before video metadata', async () => {
  resetBrowser();
  const rec = recording();
  const p = player(rec);
  p.page.update({ ...p.page.props, videos: [
    { name: 'video_turn_00.mp4', url: '/turn0', turnIndex: 0 },
    { name: 'video_turn_01.mp4', url: '/turn1', turnIndex: 1 },
  ] });
  await p.metadata();
  await p.moveTime(1.25);
  const choose = async (node: TNode) => {
    const panel = mount(ApiPythonPanel, p.panel());
    try {
      const row = findAll(panel.output, 'button').find(button => button.props['data-api-event'] === node.primary.event_id);
      if (!row) throw new Error('the unsynced API is missing while waiting for metadata');
      assert.equal(p.panel().apiCues.length, 0);
      (row.props.onClick as () => void)();
    } finally { panel.unmount(); }
    await p.accept();
    assert.equal(p.selections.at(-1)?.node.key, node.key);
  };
  try {
    await choose(rec.later);
    assert.equal(p.video().props.src, '/turn1');
    const slider = findAll(p.page.output, 'input').find(input => input.props['aria-label'] === '動画の再生位置');
    assert.equal(slider?.props.disabled, true, 'the newly selected video has not loaded metadata');
    await choose(rec.first);
    assert.equal(p.video().props.src, '/turn0');

    const recordingSelect = findAll(p.page.output, 'select').find(select => select.props['aria-label'] === '録画カメラ');
    if (!recordingSelect) throw new Error('missing recording select');
    (recordingSelect.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'video_turn_01.mp4' } });
    await advance(0);
    await choose(rec.later);
    await choose(rec.first);
    assert.equal(p.video().props.src, '/turn1', 'an explicitly selected recording stays pinned');
  } finally {
    p.page.unmount();
  }
});

test('the default API/Python view follows playback and has no process display selector', async () => {
  resetBrowser(); const rec = recording(); const p = player(rec);
  await p.metadata(); await p.media.play(); await p.moveTime(.75);
  const pauses = p.media.pauses;
  assert.equal(findAll(p.page.output, 'select').some(element => element.props['aria-label'] === '表示する処理'), false);
  assert.equal(p.media.currentTime, .75);
  assert.equal(p.media.pauses, pauses);
  assert.equal(p.media.paused, false);
  assert.equal(p.panel().selectedKey, rec.same.key);
  assert.equal(p.visibility.at(-1), true);
  await p.moveTime(2.75);
  assert.equal(p.panel().selectedKey, rec.later.key, 'playback continues following API events');
  assert.equal(p.media.paused, false);
  assert.equal(p.media.pauses, pauses, 'accepting player selections must not feed back as a manual seek');
  p.page.unmount();
});

test('API clicks pause and seek; individual same-frame selections survive late paused timeupdates', async () => {
  resetBrowser(); const rec = recording(); const p = player(rec);
  await p.metadata();
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

test('hover previews neither select APIs nor move the recording, and block navigation keeps the API/Python view', async () => {
  resetBrowser(); const rec = recording(); const p = player(rec);
  await p.metadata();
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
  assert.equal(p.visibility.at(-1), true);
  assert.equal(p.media.currentTime, 2);
  panel.update(p.panel());
  const previous = findAll(panel.output, 'button').find(button => button.props['aria-label'] === '前のコードブロック')!;
  (previous.props.onClick as Function)(); await p.accept();
  assert.equal(p.panel().selectedKey, rec.block.key);
  assert.equal(p.visibility.at(-1), true);
  assert.equal(p.media.currentTime, 0);
  assert.equal(p.media.paused, true);
  panel.unmount(); p.page.unmount();
});

test('the API/Python visibility callback follows detailed logs and unmount without moving paused video', async () => {
  resetBrowser(); const rec = recording(); const p = player(rec);
  await p.metadata();
  p.panel().onSelect(rec.first); await p.accept();
  const time = p.media.currentTime, pauses = p.media.pauses;
  await p.toggleLogs();
  assert.equal(p.visibility.at(-1), false);
  assert.equal(findAll(p.page.output, ApiPythonPanel).length, 0);
  await p.toggleLogs();
  assert.equal(p.visibility.at(-1), true);
  assert.equal(p.panel().selectedKey, rec.first.key);
  assert.equal(p.media.currentTime, time);
  assert.equal(p.media.pauses, pauses);
  p.page.unmount();
  assert.equal(p.visibility.at(-1), false, 'unmount clears the pane visibility');
});

test('selecting a turn with executed code and no APIs shows that code without an earlier turn API', async () => {
  resetBrowser(); const original = recording();
  // Turn 2 contains executed code but no recorded API.
  const events = original.events.filter(event => event.event_id !== original.later.primary.event_id && event.parent_event_id !== original.later.primary.event_id);
  const rec = { ...original, model: buildEpisodeModel(events) };
  const p = player(rec); await p.metadata();
  const turn = () => findAll(p.page.output, 'select').find(element => element.props['aria-label'] === 'リプレイのターン')!;
  (turn().props.onChange as Function)({ target: { value: '2' } }); await p.accept();
  assert.equal(turn().props.value, 2);
  assert.equal(p.media.currentTime, 2);
  assert.equal(p.panel().selectedKey, rec.block2.key);
  assert.equal(p.panel().turn, 2);
  assert.equal(turn().props.value, 2);
  assert.equal(p.media.paused, true);
  p.page.unmount();
});

test('API details always show the generating model and preserve selection across tabs and detailed logs', async () => {
  resetBrowser(); const rec = recording(); const run = makeRun();
  addEpisode(run, 'e1', { status: 'ended', trace_complete: true }, rec.events.map(event => ({ ...event, run_id: 'r1', episode_id: 'e1' })));
  serve(run); setLocation(`/traces?view=details&run=r1&episode=e1&event=${rec.first.primary.event_id}`);
  const page = mount(TraceViewerPage, {}); await advance(1000);
  const media = () => propsOf<MediaProps>(page.output, MediaPane);
  const details = () => propsOf<DetailsProps>(page.output, DetailTabs);
  const inspector = mount(DetailTabs, details());
  assert.equal(findAll(inspector.output, ApiTurnModelTab).length, 1, 'an event URL opens the same model I/O presentation immediately');
  media().onApiPythonVisibleChange!(true); await advance(0);
  const api = media().model.nodeOfEvent.get(rec.same.primary.event_id)!;
  media().onPlaybackSelect!(api, true); await advance(0);
  assert.equal(details().selection?.eventId, api.primary.event_id);
  assert.equal(media().selectionFromPlayback, true, 'a player selection stays tagged as the parent reflects it');
  assert.equal(media().seekRequest, null, 'playback selections do not create a manual seek token');
  inspector.update(details());
  assert.equal(propsOf<Parameters<typeof ApiTurnModelTab>[0]>(inspector.output, ApiTurnModelTab).selection.node.key, api.key);
  for (const tab of [1, 2, 0]) {
    details().onTab(tab); await advance(0); inspector.update(details());
    assert.equal(media().selection?.node.key, api.key);
    assert.equal(media().seekRequest, null);
    if (tab) assert.equal(propsOf<Parameters<typeof EnsembleTab>[0]>(inspector.output, EnsembleTab).mode, tab === 1 ? 'candidates' : 'synthesis');
    else assert.equal(findAll(inspector.output, ApiTurnModelTab).length, 1);
  }
  media().onApiPythonVisibleChange!(false); await advance(0);
  details().onSelect(api); await advance(0);
  assert.equal(media().selectionFromPlayback, false);
  assert.equal(media().seekRequest?.key, api.key, 'an external event click still requests a seek');
  inspector.update(details());
  assert.equal(findAll(inspector.output, ApiTurnModelTab).length, 1, 'the same presentation is used when the detailed log is open');
  inspector.unmount(); page.unmount();
});

for (const synced of [true, false]) test(`synthesis survives the detailed-log all-turns selection and still shows the recorded Python answer (${synced ? 'synced' : 'before metadata'})`, async () => {
  resetBrowser(); const rec = recording(); const run = makeRun();
  const request = rec.events.find(event => event.event_type === 'model_request')!;
  (request.data as Record<string, unknown>).call_kind = 'ensemble_synthesis';
  const response = rec.events.find(event => event.event_type === 'model_response')!;
  (response.data as Record<string, unknown>).content = '```python\ngoto_pose(target)\n```';
  addEpisode(run, 'e1', { status: 'ended', trace_complete: true }, rec.events.map(event => ({ ...event, run_id: 'r1', episode_id: 'e1' })));
  serve(run); setLocation(`/traces?view=details&run=r1&episode=e1&event=${rec.later.primary.event_id}`);
  const page = mount(TraceViewerPage, {}); await advance(1000);
  const mediaProps = () => propsOf<MediaProps>(page.output, MediaPane);
  const details = () => propsOf<DetailsProps>(page.output, DetailTabs);
  const pane = mount(MediaPane, { ...mediaProps(), videos: [{ name: 'video_combined.mp4', url: '/video' }] });
  const player = mount(VideoPlayback, propsOf<PlayerProps>(pane.output, VideoPlayback));
  const inspector = mount(DetailTabs, details());
  const sync = async () => {
    await advance(0);
    pane.update({ ...mediaProps(), videos: [{ name: 'video_combined.mp4', url: '/video' }] });
    if (findAll(pane.output, VideoPlayback).length) player.update(propsOf<PlayerProps>(pane.output, VideoPlayback));
    inspector.update(details());
    await advance(0);
  };
  const video = () => findAll(player.output, 'video')[0];
  const mediaElement = { duration: 4, currentTime: 0, playbackRate: 1, paused: true, pause() { this.paused = true; } };
  (video().props.ref as { current: unknown }).current = mediaElement;
  try {
    if (synced) (video().props.onLoadedMetadata as Function)({ currentTarget: mediaElement });
    await sync();
    // Match the CI sequence: choose synthesis, open detailed logs, reset the
    // turn filter, then select the ensemble_synthesis card through its callback.
    details().onTab(2); await sync();
    const logs = findAll(player.output, 'button').find(button => button.props.children === '詳細ログ')!;
    (logs.props.onClick as Function)(); await sync();
    const turn = findAll(player.output, 'select').find(select => select.props['aria-label'] === 'リプレイのターン')!;
    (turn.props.onChange as Function)({ target: { value: 'all' } }); await sync();
    assert.equal(details().tab, 2, 'turn navigation preserves the chosen inspector tab');
    const timeline = propsOf<Parameters<typeof Timeline>[0]>(player.output, Timeline);
    const synthesis = timeline.model.nodeOfEvent.get(request.event_id)!;
    timeline.onSelect(synthesis); await sync();
    assert.equal(details().selection?.node.key, synthesis.key);
    assert.equal(details().tab, 2);
    assert.equal(findAll(inspector.output, 'button').find(button => button.props.children === '統合結果')?.props['aria-selected'], true);
    const result = mount(EnsembleTab, propsOf<Parameters<typeof EnsembleTab>[0]>(inspector.output, EnsembleTab));
    try {
      await advance(0);
      assert.equal(findAll(result.output, 'section').filter(section => section.props['data-synthesis'] !== undefined).length, 1);
      assert.ok(findAll(result.output, Badge).some(badge => badge.props.children === 'Pythonコード'));
    } finally { result.unmount(); }

    // The same detailed log is used below recorded frames. Both user tabs
    // survive its event selections; directly picking an API still opens I/O.
    const display = findAll(pane.output, 'select').find(select => select.props['aria-label'] === '動画・記録フレーム')!;
    (display.props.onChange as Function)({ target: { value: 'recorded' } }); await advance(0);
    for (const tab of [1, 2]) {
      details().onTab(tab); await sync();
      propsOf<Parameters<typeof Timeline>[0]>(pane.output, Timeline).onSelect(synthesis); await sync();
      assert.equal(details().tab, tab, 'recorded-frame log selection preserves the chosen tab');
    }
    (display.props.onChange as Function)({ target: { value: 'video' } }); await sync();
    const apiList = findAll(player.output, 'button').find(button => button.props.children === 'APIとPythonに戻る')!;
    (apiList.props.onClick as Function)(); await sync();
    propsOf<PanelProps>(player.output, ApiPythonPanel).onSelect(mediaProps().model.nodeOfEvent.get(rec.first.primary.event_id)!); await sync();
    assert.equal(details().tab, 0, 'explicit API-list selection opens the model I/O');
  } finally {
    inspector.unmount(); player.unmount(); pane.unmount(); page.unmount();
  }
});
