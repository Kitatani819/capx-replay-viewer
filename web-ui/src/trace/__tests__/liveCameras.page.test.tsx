import test from 'node:test';
import assert from 'node:assert/strict';
import { advance, clock, findAll, propsOf, resetBrowser } from './harness/browser';
import { mount } from './harness/fakeReact';
import { buildEpisodeModel } from '../model';
import { LIVE_DELAY_S, LiveCameras, PLAYBACK_TICK_MS } from '../components/LiveCameras';
import { MediaPane } from '../components/MediaPane';
import { ImageModal, TraceImage } from '../components/TraceImage';
import { VideoPlayback } from '../components/VideoPlayback';
import { Rec } from './fixtures';

const ep = { runId: 'run', episodeId: 'ep', generation: 'generation-1' };
type ImageProps = Parameters<typeof TraceImage>[0];

function frame(rec: Rec, camera: string, index: number, age = 3, written = true) {
  return rec.add('frame', { camera, epoch: 0, buffer_index: index, reason: 'periodic' }, {
    wall: clock.now / 1000 - age,
    artifacts: [{ path: `frames/${camera}/e0_${index}.jpg`, mime: 'image/jpeg', written }],
  });
}

function visibleText(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(visibleText).join('');
  if (node && typeof node === 'object' && 'props' in node) {
    return visibleText((node as { props: { children?: unknown } }).props.children);
  }
  return '';
}

function shownSources(view: { output: unknown }) {
  return findAll(view.output as never, TraceImage).map(item => String((item.props as unknown as ImageProps).src).replace(/\?.*$/, ''));
}

test('LiveCameras shows every camera, keeping debug provenance and enlarge behavior', async () => {
  resetBrowser();
  const rec = new Rec(); rec.episodeStart();
  frame(rec, 'front', 10, 5); frame(rec, 'wrist', 2, 4); frame(rec, 'front', 11);
  frame(rec, 'front', 12, 2, false);
  const cameras = mount(LiveCameras, { model: buildEpisodeModel(rec.events), ep });
  try {
    assert.equal(findAll(cameras.output, 'figure').length, 2);
    await advance(LIVE_DELAY_S * 1000);
    assert.deepEqual(findAll(cameras.output, 'figcaption').map(item => visibleText(item)), ['front6秒前', 'wrist7秒前']);
    const images = findAll(cameras.output, TraceImage).map(item => item.props as unknown as ImageProps);
    assert.match(images[0].src!, /frames\/front\/e0_11.jpg\?g=generation-1$/);
    assert.match(images[1].src!, /frames\/wrist\/e0_2.jpg/);
    assert.equal(images[0].provenance, 'debug_frame');
    const image = mount(TraceImage, images[0]);
    try {
      (findAll(image.output, 'img')[0].props.onClick as Function)({ stopPropagation() {} });
      await advance(0);
      const enlarged = propsOf<Parameters<typeof ImageModal>[0]>(image.output, ImageModal);
      assert.equal(enlarged.src, images[0].src);
      assert.equal(enlarged.provenance, 'debug_frame');
      assert.equal(enlarged.alt, 'frontの記録フレーム');
    } finally { image.unmount(); }
  } finally { cameras.unmount(); }
});

test('LiveCameras plays every saved frame in recorded order a few seconds behind, then holds the newest', async () => {
  resetBrowser();
  const rec = new Rec(); rec.episodeStart();
  // Five frames per camera, half a second apart, the newest saved now.
  for (let i = 0; i < 5; i++) { frame(rec, 'front', i, 2 - i / 2); frame(rec, 'wrist', i, 2 - i / 2); }
  const cameras = mount(LiveCameras, { model: buildEpisodeModel(rec.events), ep });
  try {
    const seen: string[] = [];
    for (let step = 0; step <= 30; step++) {
      const front = shownSources(cameras)[0];
      if (seen.at(-1) !== front) seen.push(front);
      await advance(PLAYBACK_TICK_MS);
    }
    assert.deepEqual(seen.map(src => src.replace(/^.*\/frames\//, '')), [0, 1, 2, 3, 4].map(i => `front/e0_${i}.jpg`));
    assert.ok(shownSources(cameras)[1].endsWith('wrist/e0_4.jpg'), 'each camera reaches its newest frame');
    await advance(10_000);
    assert.ok(shownSources(cameras)[0].endsWith('front/e0_4.jpg'), 'playback never runs past the record');
  } finally { cameras.unmount(); }
});

test('after a long pause, a new burst plays from a few seconds behind its newest frame, not from the pause', async () => {
  resetBrowser();
  const rec = new Rec(); rec.episodeStart(); frame(rec, 'front', 1, 60);
  const cameras = mount(LiveCameras, { model: buildEpisodeModel(rec.events), ep });
  try {
    await advance(1000);
    // A minute of model thinking, then twenty seconds of motion arrive at once.
    for (let i = 0; i < 40; i++) frame(rec, 'front', 100 + i, 20 - i / 2);
    cameras.update({ model: buildEpisodeModel(rec.events), ep });
    await advance(PLAYBACK_TICK_MS);
    const shown = Number(/e0_(\d+)\.jpg$/.exec(shownSources(cameras)[0])![1]);
    // Newest is frame 139 (saved 0.5 s ago); playback resumes about LIVE_DELAY_S behind it.
    assert.ok(shown >= 139 - (LIVE_DELAY_S + 1) * 2 && shown < 139, `resumed near-live at frame ${shown}`);
  } finally { cameras.unmount(); }
});

test('LiveCameras updates each camera independently as frames arrive and keeps one timer until unmounted', async () => {
  resetBrowser();
  const rec = new Rec(); rec.episodeStart(); frame(rec, 'front', 1); frame(rec, 'wrist', 1, 5);
  const cameras = mount(LiveCameras, { model: buildEpisodeModel(rec.events), ep });
  try {
    await advance(2000);
    frame(rec, 'front', 2, 0);
    cameras.update({ model: buildEpisodeModel(rec.events), ep });
    await advance(LIVE_DELAY_S * 1000);
    assert.ok(shownSources(cameras)[0].endsWith('front/e0_1.jpg'), 'a new frame plays only after the delay');
    // Playback started 3 s behind front 1 (saved 3 s before mount) and has now caught up with front 2.
    await advance(3000);
    const images = shownSources(cameras);
    assert.ok(images[0].endsWith('front/e0_2.jpg'));
    assert.ok(images[1].endsWith('wrist/e0_1.jpg'));
    assert.deepEqual(findAll(cameras.output, 'figcaption').map(item => visibleText(item)), ['front6秒前', 'wrist13秒前']);
    assert.equal(clock.timers.size, 1);
  } finally { cameras.unmount(); }
  assert.equal(clock.timers.size, 0, 'the playback timer stops with the view');
});

test('a live JPEG not yet copied is retried with a fresh URL and stops retrying on unmount', async () => {
  resetBrowser();
  const rec = new Rec(); rec.episodeStart(); frame(rec, 'front', 1);
  const cameras = mount(LiveCameras, { model: buildEpisodeModel(rec.events), ep });
  const image = mount(TraceImage, propsOf<Parameters<typeof TraceImage>[0]>(cameras.output, TraceImage));
  try {
    (findAll(image.output, 'img')[0].props.onError as () => void)();
    await advance(0);
    assert.equal(findAll(image.output, 'img').length, 0);
    await advance(2000);
    assert.match(String(findAll(image.output, 'img')[0].props.src), /&image_retry=1$/);
    (findAll(image.output, 'img')[0].props.onError as () => void)();
    await advance(0);
  } finally { image.unmount(); cameras.unmount(); }
  assert.equal(clock.timers.size, 0);
});

test('LiveCameras waits for the first frames and retains a camera whose images have not been saved', () => {
  resetBrowser();
  const rec = new Rec(); rec.episodeStart();
  const cameras = mount(LiveCameras, { model: buildEpisodeModel(rec.events), ep });
  try {
    assert.match(visibleText(cameras.output), /カメラの記録を待っています/);
    frame(rec, 'front', 1, 0, false);
    cameras.update({ model: buildEpisodeModel(rec.events), ep });
    assert.equal(findAll(cameras.output, 'figure').length, 1);
    assert.match(visibleText(cameras.output), /front記録を待っています/);
    assert.equal(propsOf<ImageProps>(cameras.output, TraceImage).src, null);
  } finally { cameras.unmount(); }
});

test('MediaPane shows live cameras with logs only during follow, and restores the ordinary video view afterward', () => {
  // Following with videos already present keeps the player (checked in check_replay_layout.py).
  resetBrowser();
  const rec = new Rec(); rec.episodeStart(); frame(rec, 'front', 1);
  const props: Parameters<typeof MediaPane>[0] = {
    model: buildEpisodeModel(rec.events), ep, selection: null,
    live3d: { available: false, reason: '' }, follow: true,
    videos: [],
    logPanel: <section aria-label="処理ログ" />,
  };
  const media = mount(MediaPane, props);
  try {
    assert.equal(findAll(media.output, LiveCameras).length, 1);
    assert.equal(findAll(media.output, VideoPlayback).length, 0);
    assert.equal(findAll(media.output, 'section').filter(item => item.props['aria-label'] === '処理ログ').length, 1);
    rec.episodeEnd();
    const videos = [{ name: 'video_combined.mp4', url: '/video' }];
    media.update({ ...props, model: buildEpisodeModel(rec.events), follow: false, videos });
    assert.equal(findAll(media.output, LiveCameras).length, 0);
    const video = propsOf<Parameters<typeof VideoPlayback>[0]>(media.output, VideoPlayback);
    assert.deepEqual(video.videos, videos);
    assert.equal(video.logPanel, props.logPanel);
  } finally { media.unmount(); }
});
