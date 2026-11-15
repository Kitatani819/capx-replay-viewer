import test from 'node:test';
import assert from 'node:assert/strict';
import { advance, currentParams, findAll, propsOf, resetBrowser, setLocation } from './harness/browser';
import { mount } from './harness/fakeReact';
import { buildEpisodeModel } from '../model';
import { VideoPlayback } from '../components/VideoPlayback';
import { ApiPythonPanel } from '../components/ApiPythonPanel';
import { MediaPane } from '../components/MediaPane';
import { DetailTabs } from '../components/DetailTabs';
import TraceViewerPage from '../TraceViewerPage';
import { Rec } from './fixtures';
import { addEpisode, makeRun, serve } from './pageServer';

type PlayerProps = Parameters<typeof VideoPlayback>[0];
type PanelProps = Parameters<typeof ApiPythonPanel>[0];
type MediaProps = Parameters<typeof MediaPane>[0];
type DetailsProps = Parameters<typeof DetailTabs>[0];

function recording(mapped = true) {
  const r = new Rec(); r.episodeStart();
  if (mapped) r.add('frame', { camera: 'main', epoch: 0, buffer_index: 0, sim_step: 0 });
  const block = r.blockStart(null, 'a = 1\nb = 2\ngoto_pose(target)');
  block.sim_step = 0; block.sim_epoch = 0;
  const first = r.apiStart(block, 'goto_pose'); first.sim_step = 30; first.sim_epoch = 0;
  r.apiEnd(first);
  const unmapped = r.apiStart(block, 'unmapped_api'); r.apiEnd(unmapped);
  if (mapped) r.add('frame', { camera: 'main', epoch: 0, buffer_index: 59, sim_step: 59 });
  const model = buildEpisodeModel(r.events);
  return { model, events: r.events, first: model.nodeOfEvent.get(first.event_id)!, unmapped: model.nodeOfEvent.get(unmapped.event_id)! };
}

function player(rec: ReturnType<typeof recording>) {
  const updates: (string | null)[] = [];
  let accepted = 0;
  const props: PlayerProps = { model: rec.model, ep: { runId: 'run', episodeId: 'ep' },
    videos: [{ name: 'video_combined.mp4', url: '/video' }], initialKey: rec.first.key,
    onSelect: node => updates.push(node.key), onClearSelection: () => updates.push(null) };
  const page = mount(VideoPlayback, props);
  const video = () => findAll(page.output, 'video')[0];
  const media = { duration: 2, currentTime: 0, playbackRate: 1, paused: true, pauses: 0,
    pause() { this.pauses++; this.paused = true; },
    play() { this.paused = false; (video().props.onPlay as Function)(); return Promise.resolve(); } };
  (video().props.ref as { current: unknown }).current = media;
  const accept = async () => {
    await advance(0);
    if (updates.length !== accepted) {
      accepted = updates.length;
      page.update({ ...page.props, initialKey: updates.at(-1), allowInitialSelection: updates.at(-1) === null });
      await advance(0);
    }
  };
  const panel = () => propsOf<PanelProps>(page.output, ApiPythonPanel);
  const ready = async () => {
    (video().props.onLoadedMetadata as Function)({ currentTarget: media }); await advance(0);
    const mode = findAll(page.output, 'select').find(item => item.props['aria-label'] === '表示する処理')!;
    (mode.props.onChange as Function)({ target: { value: 'api-python' } }); await accept();
    (video().props.onSeeked as Function)({ currentTarget: media }); await advance(0);
  };
  return { page, video, media, updates, accept, panel, ready };
}

test('rewinding before the first API clears the controlled selection and does not reinitialize a future event', async () => {
  resetBrowser(); const rec = recording(); const p = player(rec);
  try {
    await p.ready(); assert.equal(p.media.currentTime, 1); assert.equal(p.panel().selectedKey, rec.first.key);
    const seek = findAll(p.page.output, 'input').find(item => item.props['aria-label'] === '動画の再生位置')!;
    (seek.props.onChange as Function)({ target: { value: '0' } }); await p.accept();
    assert.equal(p.media.currentTime, 0);
    assert.equal(p.panel().selectedKey, null, 'API list and Python receive no future selection');
    assert.equal(p.updates.at(-1), null);
    assert.equal(p.media.paused, true);
    const count = p.updates.length;
    (p.video().props.onTimeUpdate as Function)({ currentTarget: p.media }); await p.accept();
    assert.equal(p.updates.length, count, 'clearing is not followed by archived initial selection');
    await p.media.play(); await p.accept();
    const pauses = p.media.pauses;
    p.media.currentTime = 1.1; (p.video().props.onTimeUpdate as Function)({ currentTarget: p.media }); await p.accept();
    assert.equal(p.panel().selectedKey, rec.first.key, 'following resumes when the first recorded API is reached');
    assert.equal(p.media.pauses, pauses);
    assert.equal(p.media.paused, false);
  } finally { p.page.unmount(); }
});

test('clearing before the first API during an active seek preserves playback', async () => {
  resetBrowser(); const p = player(recording());
  try {
    await p.ready(); await p.media.play(); await p.accept();
    const pauses = p.media.pauses;
    p.media.currentTime = 0;
    (p.video().props.onSeeking as Function)({ currentTarget: p.media }); await p.accept();
    assert.equal(p.panel().selectedKey, null);
    assert.equal(p.media.currentTime, 0);
    assert.equal(p.media.paused, false);
    assert.equal(p.media.pauses, pauses, 'accepting the player-owned null is not a manual-selection pause');
  } finally { p.page.unmount(); }
});

test('manual unmapped APIs remain selected while paused, and unknown video maps do not imply an empty API position', async () => {
  for (const mapped of [true, false]) {
    resetBrowser(); const rec = recording(mapped); const p = player(rec);
    try {
      await p.ready(); p.panel().onSelect(rec.unmapped); await p.accept();
      const count = p.updates.length;
      p.media.currentTime = 0; (p.video().props.onTimeUpdate as Function)({ currentTarget: p.media }); await p.accept();
      assert.equal(p.panel().selectedKey, rec.unmapped.key);
      assert.equal(p.updates.length, count, 'late timeupdate cannot discard a manual unmapped selection');
      if (!mapped) {
        await p.media.play(); await p.accept();
        assert.equal(p.panel().selectedKey, rec.unmapped.key);
        assert.equal(p.updates.length, count, 'no frame map is not evidence that no API occurred');
      }
    } finally { p.page.unmount(); }
  }
});

test('the replay clear callback removes the event URL and right-pane selection through MediaPane', async () => {
  resetBrowser(); const rec = recording(); const run = makeRun('run');
  addEpisode(run, 'ep', { status: 'ended' }, rec.events); serve(run);
  setLocation(`/traces?view=details&run=run&episode=ep&event=${rec.first.primary.event_id}`);
  const page = mount(TraceViewerPage, {});
  try {
    await advance(1000);
    const media = propsOf<MediaProps>(page.output, MediaPane);
    assert.equal(propsOf<DetailsProps>(page.output, DetailTabs).selection?.node.key, rec.first.key);
    const pane = mount(MediaPane, { ...media, videos: [{ name: 'video_combined.mp4', url: '/video' }] });
    try { assert.equal(propsOf<PlayerProps>(pane.output, VideoPlayback).onClearSelection, media.onPlaybackClear); }
    finally { pane.unmount(); }
    media.onPlaybackClear!(); await advance(0);
    assert.equal(currentParams().get('event'), null);
    assert.equal(propsOf<MediaProps>(page.output, MediaPane).selection, null);
    assert.equal(propsOf<DetailsProps>(page.output, DetailTabs).selection, null);
  } finally { page.unmount(); }
});
