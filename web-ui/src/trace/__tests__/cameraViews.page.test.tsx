import { advance, currentParams, findAll, propsOf, resetBrowser, setLocation, type FakeElement } from './harness/browser';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from './harness/fakeReact';
import TraceViewerPage from '../TraceViewerPage';
import { SideBySideComparison, type TrialComparisonData } from '../SideBySidePage';
import { MediaPane } from '../components/MediaPane';
import { TrialSummary, TrialSummaryCard } from '../components/TrialSummary';
import { VideoPlayback } from '../components/VideoPlayback';
import { buildEpisodeModel, keyFramesOf } from '../model';
import { dataOf, type FrameRef } from '../types';
import { Rec } from './fixtures';
import { lastRecordedFrame } from '../trialSummary';
import { comparisonUrl, trialEventUrl } from '../sideBySide';
import { addEpisode, ev, makeRun, serve } from './pageServer';

function text(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return typeof node === 'object' && 'props' in node ? text((node as FakeElement).props.children) : '';
}
function recorded(ep: string, cameras = ['ego', 'left_wrist', 'right_wrist']) {
  let seq = 0;
  return cameras.flatMap(camera => [0, 59].map(index => ev(ep, ++seq, 'frame', {
    camera, epoch: 0, buffer_index: index, sim_step: index,
  }, { artifacts: [{ path: `frames/${camera}/e0_${index}.jpg`, mime: 'image/jpeg', written: true }] })));
}
function comparison(ep: string, cameras?: string[]): TrialComparisonData {
  return { ref: { runId: 'r1', episodeId: ep }, model: buildEpisodeModel(recorded(ep, cameras)),
    summary: { episode_id: ep, task: 'cube', seed: 7, status: 'ended' }, records: [] };
}
function select(output: unknown, label: string) {
  const element = findAll(output, 'select').find(item => item.props['aria-label'] === label);
  if (!element) throw new Error(`missing ${label}`);
  return element;
}
function change(element: FakeElement, value: string) {
  (element.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}

test('summary selects the chosen camera and shows the baseline main camera with a note when unavailable', async () => {
  resetBrowser();
  const current = comparison('current');
  const baseline = comparison('baseline', ['ego']);
  const changes: string[] = [];
  const page = mount(TrialSummaryCard, { ep: current.ref, model: current.model, summary: current.summary, verdict: 'unknown' as const,
    onCameraChange: (camera: string) => changes.push(camera),
    baseline: { ep: baseline.ref, model: baseline.model, frame: lastRecordedFrame(baseline.model),
      trial: { episode_id: 'baseline', task: 'cube', condition: 'C', seed: 7, attempt: 0, verdict: 'success' as const, status: 'ended', trace_complete: true, local_state: 'local' as const } } });
  try {
    assert.equal(select(page.output, '最後の画像のカメラ').props.value, 'ego');
    change(select(page.output, '最後の画像のカメラ'), 'left_wrist');
    await advance(0);
    assert.deepEqual(changes, ['left_wrist']);
    const images = findAll(page.output, 'img');
    assert.match(String(images[0].props.src), /frames\/left_wrist\/e0_59.jpg/);
    assert.match(String(images[1].props.src), /frames\/ego\/e0_59.jpg/);
    assert.match(text(page.output), /基準に同じカメラがないため、頭を表示しています。/);
    const link = findAll(page.output, 'a').find(item => item.props.className === 'trial-summary-compare');
    assert.match(String(link?.props.href), /camera=left_wrist/);
    assert.equal(select(page.output, '最後の画像のカメラ').props.title, 'left_wrist');
    assert.equal(findAll(page.output, 'option').find(item => item.props.value === 'left_wrist')?.props.children, '左手首');
  } finally { page.unmount(); }
});

test('side by side uses the same selected camera on both trials and falls back only for the baseline', async () => {
  resetBrowser();
  const current = comparison('current');
  const page = mount(SideBySideComparison, { current, baseline: comparison('baseline', ['ego', 'left_wrist']) });
  try {
    change(select(page.output, '比較のカメラ'), 'left_wrist');
    await advance(0);
    assert.ok(findAll(page.output, 'img').every(image => String(image.props.src).includes('/left_wrist/')));
    assert.doesNotMatch(text(page.output), /同じカメラがない/);
    change(select(page.output, '比較のカメラ'), 'right_wrist');
    await advance(0);
    const images = findAll(page.output, 'img');
    assert.match(String(images[0].props.src), /frames\/ego\/e0_59.jpg/);
    assert.match(String(images[1].props.src), /frames\/right_wrist\/e0_59.jpg/);
    assert.match(text(page.output), /基準に同じカメラがないため、頭を表示しています。/);
    assert.ok(findAll(page.output, 'a').some(link => String(link.props.href).includes('camera=right_wrist')));
  } finally { page.unmount(); }
});

test('recorded frames inherit the shared main camera and their select publishes changes', async () => {
  resetBrowser();
  const changes: string[] = [];
  const model = buildEpisodeModel(recorded('current'));
  const page = mount(MediaPane, { model, ep: { runId: 'r1', episodeId: 'current' }, selection: null,
    camera: 'left_wrist', onCameraChange: (camera: string) => changes.push(camera),
    live3d: { available: false as const, reason: 'recorded' }, follow: false,
    videos: [{ name: 'video_combined_ego.mp4', url: '/ego' }, { name: 'video_combined_left_wrist.mp4', url: '/left' }] });
  try {
    const playback = propsOf<Parameters<typeof VideoPlayback>[0]>(page.output, VideoPlayback);
    assert.equal(playback.camera, 'left_wrist');
    change(select(page.output, '動画・記録フレーム'), 'recorded');
    await advance(0);
    assert.equal(select(page.output, '記録フレームのカメラ').props.value, 'left_wrist');
    change(select(page.output, '記録フレームのカメラ'), 'right_wrist');
    await advance(0);
    assert.deepEqual(changes, ['right_wrist']);
  } finally { page.unmount(); }
});

test('the page shares camera changes between summary and playback while retaining event selection', async () => {
  resetBrowser();
  const run = makeRun('r1');
  addEpisode(run, 'current', { task: 'cube', seed: 7, status: 'ended' }, recorded('current'));
  serve(run);
  setLocation('/traces?run=r1&episode=current&event=current_1&camera=left_wrist');
  const page = mount(TraceViewerPage, {});
  try {
    await advance(100);
    const media = () => propsOf<Parameters<typeof MediaPane>[0]>(page.output, MediaPane);
    const summary = () => propsOf<Parameters<typeof TrialSummary>[0]>(page.output, TrialSummary);
    assert.equal(media().camera, 'left_wrist');
    assert.equal(summary().camera, 'left_wrist');
    summary().onCameraChange!('right_wrist');
    await advance(0);
    assert.equal(media().camera, 'right_wrist');
    assert.equal(currentParams().get('camera'), 'right_wrist');
    assert.equal(currentParams().get('event'), 'current_1');
    media().onCameraChange!('ego');
    await advance(0);
    assert.equal(summary().camera, 'ego');
    assert.equal(currentParams().get('event'), 'current_1');
  } finally { page.unmount(); }
});

test('single camera summary and comparison omit camera switches and links retain optional camera', () => {
  resetBrowser();
  const current = comparison('current', ['ego']);
  const summary = mount(TrialSummaryCard, { ep: current.ref, model: current.model, summary: current.summary, verdict: 'unknown' as const });
  const compared = mount(SideBySideComparison, { current, baseline: comparison('baseline', ['ego']) });
  try {
    assert.equal(findAll(summary.output, 'select').length, 0);
    assert.equal(findAll(compared.output, 'select').length, 0);
    assert.equal(comparisonUrl('r', 'e', 'b', 'be', 'left_wrist'), '/traces/compare?run=r&episode=e&baseline_run=b&baseline_episode=be&camera=left_wrist&site=b300');
    assert.equal(trialEventUrl('r', 'e', 'event', 'left_wrist'), '/traces?run=r&episode=e&event=event&camera=left_wrist&site=b300');
  } finally { summary.unmount(); compared.unmount(); }
});

test('the page retains a mapped wrist camera even when that camera has no frame records', async () => {
  resetBrowser();
  const run = makeRun('r1');
  const events = [ev('current', 1, 'episode_start', { frames: { cameras: ['agentview', 'robot0_eye_in_hand'] } }),
    ...recorded('current', ['agentview']).map((event, index) => ({ ...event, seq: index + 2, event_id: `frame_${index}` })),
    ev('current', 4, 'trial_videos', {}, { artifacts: [
      { path: 'videos/video_combined.mp4', mime: 'video/mp4', written: true },
      { path: 'videos/video_combined_wrist.mp4', mime: 'video/mp4', written: true },
    ] })];
  addEpisode(run, 'current', { task: 'cube', seed: 7, status: 'ended' }, events);
  serve(run);
  setLocation('/traces?run=r1&episode=current&event=frame_0');
  const page = mount(TraceViewerPage, {});
  try {
    await advance(100);
    const media = () => propsOf<Parameters<typeof MediaPane>[0]>(page.output, MediaPane);
    media().onCameraChange!('robot0_eye_in_hand');
    await advance(0);
    assert.equal(media().camera, 'robot0_eye_in_hand');
    assert.equal(propsOf<Parameters<typeof TrialSummary>[0]>(page.output, TrialSummary).camera, 'robot0_eye_in_hand');
    assert.equal(currentParams().get('event'), 'frame_0');
    const pane = mount(MediaPane, media());
    const summaryProps = propsOf<Parameters<typeof TrialSummary>[0]>(page.output, TrialSummary);
    const card = mount(TrialSummaryCard, { ep: summaryProps.ep, model: summaryProps.model, summary: summaryProps.summary,
      camera: summaryProps.camera, cameraOptions: summaryProps.cameraOptions, verdict: 'unknown' as const });
    try {
      assert.equal(propsOf<Parameters<typeof VideoPlayback>[0]>(pane.output, VideoPlayback).camera, 'robot0_eye_in_hand');
      change(select(pane.output, '動画・記録フレーム'), 'recorded');
      await advance(0);
      assert.equal(select(pane.output, '記録フレームのカメラ').props.value, 'robot0_eye_in_hand');
      assert.equal(select(card.output, '最後の画像のカメラ').props.value, 'robot0_eye_in_hand');
      assert.equal(findAll(card.output, 'img').length, 0, 'a missing wrist image must not be replaced with a main camera image');
      assert.match(text(card.output), /このカメラの画像は記録されていません/);
    } finally { pane.unmount(); card.unmount(); }
  } finally { page.unmount(); }
});


test('code and API boundaries keep every camera in frame_refs without fresh per-event frame records', async () => {
  resetBrowser();
  for (const cameras of [['agentview', 'robot0_eye_in_hand'], ['ego', 'left_wrist', 'right_wrist']]) {
    const recorder = new Rec();
    const refs = (index: number): FrameRef[] => cameras.map(camera => ({ camera, epoch: 0, buffer_index: index,
      frame_sim_step: index, path: `frames/${camera}/e0_${index}.jpg`, written: true }));
    const startRefs = refs(10), endRefs = refs(20);
    const startData = { frame_ref: startRefs[0], frame_refs: startRefs };
    const endData = { frame_ref: endRefs[0], frame_refs: endRefs };
    const block = recorder.blockStart(null, 'move()', startData);
    const api = recorder.apiStart(block, 'move', {}, null, startData);
    const apiEnd = recorder.apiEnd(api);
    Object.assign(dataOf(apiEnd, 'api_call_end'), endData);
    recorder.blockEnd(block, 0, 0, endData);
    const model = buildEpisodeModel(recorder.events);
    assert.equal(model.keyframesFor.size, 0);
    const wrist = cameras[1];
    for (const event of [block, api]) {
      const node = model.nodeOfEvent.get(event.event_id)!;
      const frames = keyFramesOf(model, node);
      assert.deepEqual(frames.before.map(frame => frame.camera), cameras);
      assert.deepEqual(frames.after.map(frame => frame.camera), cameras);
      assert.equal(frames.before.find(frame => frame.camera === wrist)?.path, `frames/${wrist}/e0_10.jpg`);
      assert.equal(frames.after.find(frame => frame.camera === wrist)?.path, `frames/${wrist}/e0_20.jpg`);
      const pane = mount(MediaPane, { model, ep: { runId: 'run', episodeId: 'ep' }, camera: wrist,
        selection: { node, eventId: event.event_id, attempt: null }, videos: [],
        live3d: { available: false as const, reason: 'recorded' }, follow: false });
      try { assert.equal(select(pane.output, '記録フレームのカメラ').props.value, wrist); }
      finally { pane.unmount(); }
    }
  }
});

test('single frame_ref stays unchanged and explicit refs take precedence over duplicate camera records', () => {
  const recorder = new Rec();
  const reference: FrameRef = { camera: 'agentview', epoch: 0, buffer_index: 10, frame_sim_step: 10, path: 'frames/chosen.jpg', written: true };
  const block = recorder.blockStart(null, 'move()', { frame_ref: reference });
  recorder.add('frame', { camera: 'agentview', epoch: 0, buffer_index: 11, sim_step: 11, for_event_id: block.event_id },
    { artifacts: [{ path: 'frames/fallback.jpg', mime: 'image/jpeg', written: true }] });
  let model = buildEpisodeModel(recorder.events);
  assert.equal(keyFramesOf(model, model.blocks[0]).before.length, 1);
  assert.equal(keyFramesOf(model, model.blocks[0]).before[0].path, reference.path);
  dataOf(block, 'code_block_start').frame_refs = [{ ...reference, path: 'frames/duplicate.jpg' }];
  model = buildEpisodeModel(recorder.events);
  assert.equal(keyFramesOf(model, model.blocks[0]).before.length, 1);
  assert.equal(keyFramesOf(model, model.blocks[0]).before[0].path, reference.path);
});

test('comparison keeps a known missing-frame camera instead of changing to the main camera', async () => {
  resetBrowser();
  const trial = (ep: string) => {
    const value = comparison(ep, ['agentview']);
    value.model = buildEpisodeModel([ev(ep, 0, 'episode_start', { frames: { cameras: ['agentview', 'robot0_eye_in_hand'] } }),
      ...recorded(ep, ['agentview']), ev(ep, 3, 'trial_videos', {}, { artifacts: [
        { path: 'videos/video_combined.mp4', mime: 'video/mp4', written: true },
        { path: 'videos/video_combined_wrist.mp4', mime: 'video/mp4', written: true },
      ] })]);
    return value;
  };
  const current = trial('current'), baseline = trial('baseline');
  const page = mount(SideBySideComparison, { current, baseline, camera: 'robot0_eye_in_hand' });
  const card = mount(TrialSummaryCard, { ep: current.ref, model: current.model, summary: current.summary, camera: 'robot0_eye_in_hand',
    verdict: 'unknown' as const, baseline: { ep: baseline.ref, model: baseline.model, frame: lastRecordedFrame(baseline.model),
      trial: { episode_id: 'baseline', task: 'cube', condition: 'C', seed: 7, attempt: 0, verdict: 'success' as const, status: 'ended', trace_complete: true, local_state: 'local' as const } } });
  try {
    assert.equal(select(page.output, '比較のカメラ').props.value, 'robot0_eye_in_hand');
    assert.equal(findAll(page.output, 'img').length, 0);
    assert.match(text(page.output), /画像は記録されていません。/);
    assert.doesNotMatch(text(page.output), /基準に同じカメラがない/);
    assert.equal(select(card.output, '最後の画像のカメラ').props.value, 'robot0_eye_in_hand');
    assert.equal(findAll(card.output, 'img').length, 0);
    assert.doesNotMatch(text(card.output), /基準に同じカメラがない/);
    assert.match(text(card.output), /基準：このカメラの画像は記録されていません/);
  } finally { page.unmount(); card.unmount(); }
});
