import test from 'node:test';
import assert from 'node:assert/strict';
import { advance, clock, findAll, propsOf, resetBrowser } from './harness/browser';
import { mount } from './harness/fakeReact';
import { buildEpisodeModel } from '../model';
import { LIVE_DELAY_S, LIVE_FRAME_CLASS, MAX_LAG_S, LiveCameras, PLAYBACK_TICK_MS, frameIndexAt, indexLiveFrames } from '../components/LiveCameras';
import { MediaPane } from '../components/MediaPane';
import { SmallButton } from '../components/common';
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
    // Every live camera frame has the red frame, so it can't be mistaken for the saved video.
    for (const item of images) assert.ok(item.className!.includes(LIVE_FRAME_CLASS), item.className);
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
    for (let step = 0; step <= Math.ceil(6000 / PLAYBACK_TICK_MS); step++) {
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

test('a fast burst (30 frames in one second) plays smoothly, not as a few jumps', async () => {
  resetBrowser();
  const rec = new Rec(); rec.episodeStart();
  for (let i = 0; i < 30; i++) frame(rec, 'front', i, 1 - i / 30);
  const cameras = mount(LiveCameras, { model: buildEpisodeModel(rec.events), ep });
  try {
    const seen: string[] = [];
    for (let step = 0; step <= Math.ceil((LIVE_DELAY_S + 2) * 1000 / PLAYBACK_TICK_MS); step++) {
      const front = shownSources(cameras)[0];
      if (seen.at(-1) !== front) seen.push(front);
      await advance(PLAYBACK_TICK_MS);
    }
    // At 20 steps a second, a one-second burst shows about 20 distinct frames in order.
    assert.ok(seen.length >= 18, `only ${seen.length} distinct frames shown`);
    const order = seen.map(src => Number(/e0_(\d+)\.jpg$/.exec(src)![1]));
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    assert.equal(order.at(-1), 29);
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

type MediaProps = Parameters<typeof MediaPane>[0];
type LiveProps = Parameters<typeof LiveCameras>[0];
const videos = [{ name: 'video_combined.mp4', url: '/video' }];
const finishingNote = '試行が終わりました。残りの記録フレームを再生してから動画に切り替えます';

function mediaProps(rec: Rec, extra: Partial<MediaProps> = {}): MediaProps {
  return { model: buildEpisodeModel(rec.events), ep, selection: null,
    live3d: { available: false, reason: '' }, follow: true, videos: [],
    logPanel: <section aria-label="処理ログ" />, ...extra };
}

// The harness renders one component at a time; keep the child mounted across
// the transition, and pass down the parent's new props just as React does.
function mountLiveMedia(rec: Rec) {
  const media = mount(MediaPane, mediaProps(rec));
  const cameras = mount(LiveCameras, propsOf<LiveProps>(media.output, LiveCameras));
  return {
    media, cameras,
    update(extra: Partial<MediaProps>) {
      media.update({ ...media.props, ...extra });
      const live = findAll(media.output, LiveCameras)[0];
      if (live) cameras.update(live.props as LiveProps);
    },
    unmount() { cameras.unmount(); media.unmount(); },
  };
}

function switchNow(output: unknown) {
  const button = [...findAll(output, SmallButton), ...findAll(output, 'button')]
    .find(item => visibleText(item) === 'すぐ動画に切り替える');
  if (!button) throw new Error('the finishing view offers an immediate switch');
  (button.props.onClick as () => void)();
}

test('following → ended plays the remaining frames at the same pace, then restores the video and logs', async () => {
  resetBrowser();
  const rec = new Rec(); rec.episodeStart();
  for (let i = 0; i <= 3; i++) { frame(rec, 'front', i, 3 - i / 2); frame(rec, 'wrist', i, 3 - i / 2); }
  const view = mountLiveMedia(rec);
  try {
    const liveKey = (findAll(view.media.output, LiveCameras)[0] as { key?: unknown }).key;
    assert.equal(findAll(view.media.output, VideoPlayback).length, 0);
    assert.equal(findAll(view.media.output, 'section').filter(item => item.props['aria-label'] === '処理ログ').length, 1);
    await advance(1000);
    // The end arrives with the final half-second-spaced motion frames.
    for (let i = 4; i <= 5; i++) frame(rec, 'front', i, 3 - i / 2);
    for (let i = 4; i <= 6; i++) frame(rec, 'wrist', i, 3 - i / 2);
    rec.episodeEnd();
    view.update({ model: buildEpisodeModel(rec.events), follow: false, videos });
    await advance(0);
    assert.equal(findAll(view.media.output, LiveCameras).length, 1);
    assert.equal((findAll(view.media.output, LiveCameras)[0] as { key?: unknown }).key, liveKey, 'finishing keeps the mounted playback clock');
    assert.equal(findAll(view.media.output, VideoPlayback).length, 0);
    assert.ok(visibleText(view.media.output).includes(finishingNote));
    assert.ok(visibleText(view.media.output).includes('すぐ動画に切り替える'));
    const seen = [shownSources(view.cameras)[0]];
    // The preserved playhead needs 4.5 s; resetting to newest - delay would finish early.
    const ticksToNewest = Math.ceil((LIVE_DELAY_S + 1.5) * 1000 / PLAYBACK_TICK_MS);
    for (let i = 0; i < ticksToNewest; i++) {
      await advance(PLAYBACK_TICK_MS);
      const front = shownSources(view.cameras)[0];
      if (seen.at(-1) !== front) seen.push(front);
      if (i < ticksToNewest - 1) {
        assert.equal(findAll(view.media.output, LiveCameras).length, 1, 'all remaining frames play at real-time pace');
      }
    }
    assert.deepEqual(seen.map(src => src.replace(/^.*\/frames\//, '')), Array.from({ length: 6 }, (_, i) => `front/e0_${i}.jpg`));
    assert.ok(shownSources(view.cameras)[1].endsWith('wrist/e0_6.jpg'), 'the later frame of the other camera is also shown before switching');
    assert.equal(findAll(view.media.output, LiveCameras).length, 0);
    assert.ok(!visibleText(view.media.output).includes(finishingNote));
    const video = propsOf<Parameters<typeof VideoPlayback>[0]>(view.media.output, VideoPlayback);
    assert.deepEqual(video.videos, videos);
    assert.equal(video.logPanel, view.media.props.logPanel);
  } finally { view.unmount(); }
  assert.equal(clock.timers.size, 0);
});

test('videos arriving while follow is still true also finish the live frames before switching', async () => {
  resetBrowser();
  const rec = new Rec(); rec.episodeStart(); frame(rec, 'front', 0, 3); frame(rec, 'front', 1, 0);
  const view = mountLiveMedia(rec);
  try {
    view.update({ videos });
    await advance(0);
    assert.equal(findAll(view.media.output, LiveCameras).length, 1);
    assert.ok(visibleText(view.media.output).includes(finishingNote));
    await advance(LIVE_DELAY_S * 1000);
    assert.equal(findAll(view.media.output, LiveCameras).length, 0);
    assert.equal(findAll(view.media.output, VideoPlayback).length, 1);
  } finally { view.unmount(); }
});

test('an ended trial without a video finishes live frames and returns to the ordinary recorded view', async () => {
  resetBrowser();
  const rec = new Rec(); rec.episodeStart(); frame(rec, 'front', 0, 3); frame(rec, 'front', 1, 0);
  const view = mountLiveMedia(rec);
  try {
    view.update({ follow: false });
    await advance(0);
    assert.equal(findAll(view.media.output, LiveCameras).length, 1);
    await advance(LIVE_DELAY_S * 1000);
    assert.equal(findAll(view.media.output, LiveCameras).length, 0);
    assert.equal(findAll(view.media.output, VideoPlayback).length, 0);
    assert.equal(findAll(view.media.output, 'select').find(item => item.props['aria-label'] === '動画・記録フレーム')?.props.value, 'recorded');
  } finally { view.unmount(); }
});

test('leaving Live on a still-running trial switches at once, without the end note', async () => {
  resetBrowser();
  const rec = new Rec(); rec.episodeStart(); frame(rec, 'front', 0, 3); frame(rec, 'front', 1, 0);
  const view = mountLiveMedia(rec);
  try {
    view.update({ follow: false, running: true });
    await advance(0);
    assert.equal(findAll(view.media.output, LiveCameras).length, 0);
    assert.ok(!visibleText(view.media.output).includes(finishingNote));
    assert.equal(findAll(view.media.output, 'select').find(item => item.props['aria-label'] === '動画・記録フレーム')?.props.value, 'recorded');
    // The trial ending later, while the user browses, does not bring the live cameras back.
    view.update({ running: false, videos });
    await advance(0);
    assert.equal(findAll(view.media.output, LiveCameras).length, 0);
    assert.equal(findAll(view.media.output, VideoPlayback).length, 1);
  } finally { view.unmount(); }
  assert.equal(clock.timers.size, 0);
});

test('the immediate-switch button skips the remaining live playback', async () => {
  resetBrowser();
  const rec = new Rec(); rec.episodeStart(); frame(rec, 'front', 0, 3); frame(rec, 'front', 1, 0);
  const view = mountLiveMedia(rec);
  try {
    view.update({ follow: false, videos });
    await advance(0);
    switchNow(view.media.output);
    await advance(0);
    assert.equal(findAll(view.media.output, LiveCameras).length, 0);
    assert.equal(findAll(view.media.output, VideoPlayback).length, 1);
    assert.ok(shownSources(view.cameras)[0].endsWith('front/e0_0.jpg'), 'no playback tick was needed');
    // Re-rendering the ended episode cannot enter finishing again.
    view.update({ model: buildEpisodeModel(rec.events) });
    await advance(0);
    assert.equal(findAll(view.media.output, VideoPlayback).length, 1);
  } finally { view.unmount(); }
});

for (const remaining of ['no frames', 'no timed frames', 'only unsaved frames', 'already caught up'] as const) {
  test(`ending switches at once with ${remaining}`, async () => {
    resetBrowser();
    const rec = new Rec(); rec.episodeStart();
    if (remaining === 'no timed frames') frame(rec, 'front', 1).wall_time = Number.NaN;
    if (remaining === 'only unsaved frames') frame(rec, 'front', 1, 0, false);
    if (remaining === 'already caught up') { frame(rec, 'front', 0, 3); frame(rec, 'front', 1, 0); }
    const view = mountLiveMedia(rec);
    try {
      if (remaining === 'already caught up') await advance(LIVE_DELAY_S * 1000);
      view.update({ follow: false, videos });
      await advance(0);
      assert.equal(findAll(view.media.output, LiveCameras).length, 0);
      assert.equal(findAll(view.media.output, VideoPlayback).length, 1);
    } finally { view.unmount(); }
    assert.equal(clock.timers.size, 0);
  });
}

test('a single frame already shown does not hold the video for an artificial delay', async () => {
  resetBrowser();
  const rec = new Rec(); rec.episodeStart(); frame(rec, 'front', 1);
  const view = mountLiveMedia(rec);
  try {
    view.update({ follow: false, videos });
    await advance(0);
    assert.equal(findAll(view.media.output, LiveCameras).length, 0);
    assert.equal(findAll(view.media.output, VideoPlayback).length, 1);
  } finally { view.unmount(); }
});

test('the safety cap switches even if the playback clock stalls and updates keep arriving', async () => {
  resetBrowser();
  const rec = new Rec(); rec.episodeStart(); frame(rec, 'front', 0, 3); frame(rec, 'front', 1, 0);
  const view = mountLiveMedia(rec);
  const dateNow = Date.now;
  const frozenNow = clock.now;
  Date.now = () => frozenNow;
  try {
    view.update({ follow: false, videos });
    await advance(0);
    const capMs = (LIVE_DELAY_S + MAX_LAG_S) * 1000;
    await advance(capMs / 2);
    view.update({ model: buildEpisodeModel(rec.events) });
    await advance(capMs / 2 - 1);
    assert.equal(findAll(view.media.output, LiveCameras).length, 1);
    assert.ok(shownSources(view.cameras)[0].endsWith('front/e0_0.jpg'), 'the playhead really is stalled');
    await advance(1);
    assert.equal(findAll(view.media.output, LiveCameras).length, 0);
    assert.equal(findAll(view.media.output, VideoPlayback).length, 1);
  } finally { Date.now = dateNow; view.unmount(); }
  assert.equal(clock.timers.size, 0);
});

test('opening an already-ended episode or following an episode with video shows the player directly', () => {
  resetBrowser();
  const rec = new Rec(); rec.episodeStart(); frame(rec, 'front', 0, 3); frame(rec, 'front', 1, 0); rec.episodeEnd();
  for (const follow of [false, true]) {
    const media = mount(MediaPane, mediaProps(rec, { follow, videos }));
    try {
      assert.equal(findAll(media.output, LiveCameras).length, 0);
      assert.equal(findAll(media.output, VideoPlayback).length, 1);
      assert.ok(!visibleText(media.output).includes(finishingNote));
      assert.equal(clock.timers.size, 0);
    } finally { media.unmount(); }
  }
});

for (const destination of [
  { ...ep, episodeId: 'another-episode' },
  { ...ep, runId: 'another-run' },
  { ...ep, generation: 'generation-2' },
]) {
  const identity = destination.episodeId !== ep.episodeId ? 'episode' : destination.runId !== ep.runId ? 'run' : 'generation';
  test(`changing ${identity} clears finishing and cancels its safety timer`, async () => {
    resetBrowser();
    const rec = new Rec(); rec.episodeStart(); frame(rec, 'front', 0, 3); frame(rec, 'front', 1, 0);
    const media = mount(MediaPane, mediaProps(rec));
    try {
      media.update({ ...media.props, follow: false, videos });
      await advance(0);
      assert.equal(findAll(media.output, LiveCameras).length, 1);
      const staleCaughtUp = propsOf<LiveProps>(media.output, LiveCameras).onCaughtUp;
      media.update({ ...media.props, ep: destination });
      await advance(0);
      assert.equal(findAll(media.output, LiveCameras).length, 0);
      assert.equal(findAll(media.output, VideoPlayback).length, 1);
      assert.ok(!visibleText(media.output).includes(finishingNote));
      assert.equal(clock.timers.size, 0, 'the previous episode cannot keep a safety timeout');
      media.update({ ...media.props, follow: true, videos: [] });
      await advance(0);
      assert.equal(findAll(media.output, LiveCameras).length, 1);
      staleCaughtUp?.();
      await advance(0);
      assert.equal(findAll(media.output, LiveCameras).length, 1, 'an old callback cannot switch the new live episode');
      assert.ok(!visibleText(media.output).includes(finishingNote));
    } finally { media.unmount(); }
  });
}

test('changing the live episode resets the camera playback identity', async () => {
  resetBrowser();
  const rec = new Rec(); rec.episodeStart(); frame(rec, 'front', 0, 3); frame(rec, 'front', 1, 0);
  const media = mount(MediaPane, mediaProps(rec));
  try {
    const first = findAll(media.output, LiveCameras)[0] as { key?: unknown };
    media.update({ ...media.props, ep: { ...ep, episodeId: 'another-episode' } });
    await advance(0);
    const next = findAll(media.output, LiveCameras)[0] as { key?: unknown };
    assert.notEqual(next.key, first.key, 'React remounts LiveCameras rather than reusing the old playhead');
    assert.ok(!visibleText(media.output).includes(finishingNote));
  } finally { media.unmount(); }
});


test('LiveCameras renders long saved frame histories without exceeding the argument limit', () => {
  resetBrowser();
  const rec = new Rec();
  frame(rec, 'front', 0);
  const model = buildEpisodeModel(rec.events);
  const seed = model.frames[0];
  const frames = Array.from({ length: 200_000 }, (_, i) => ({ ...seed, bufferIndex: i,
    path: `frames/front/e0_${i}.jpg`, event: { ...seed.event, wall_time: clock.now / 1000 - 2000 + i / 100 } }));
  model.framesByCamera.set('front', frames);
  const cameras = mount(LiveCameras, { model, ep });
  try {
    assert.match(shownSources(cameras)[0], /frames\/front\/e0_199699.jpg$/);
    assert.equal(findAll(cameras.output, 'figure').length, 1);
  } finally { cameras.unmount(); }
});

test('indexed live frames preserve duplicate times, untimed fallbacks and playhead boundaries', () => {
  const rec = new Rec(); rec.episodeStart();
  for (let index = 0; index < 5; index++) {
    const event = rec.add('frame', {camera: 'main', epoch: 0, buffer_index: index, sim_step: index});
    event.wall_time = [10, 11, 11, NaN, Infinity][index];
  }
  const frames = buildEpisodeModel(rec.events).framesByCamera.get('main')!;
  const history = indexLiveFrames(frames);
  for (const [time, expected] of [[null, 4], [-Infinity, 0], [9, 0], [10, 0], [10.999, 2], [11, 2], [Infinity, 2], [NaN, 0]] as const) {
    assert.equal(frameIndexAt(history, time), expected, `playhead ${time}`);
  }
  assert.equal(frameIndexAt(indexLiveFrames([]), 0), -1);
  assert.equal(frameIndexAt(indexLiveFrames(frames.slice(3)), 0), 1);
});
