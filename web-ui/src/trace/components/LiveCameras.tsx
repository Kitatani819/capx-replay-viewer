/**
 * Saved frames of each camera in Live mode, including the final playback at end.
 *
 * The recorder saves every frame the simulator renders (a few per second), but a
 * remote copy arrives in batches every ~2 s. Showing only the newest frame skips
 * most of them, so the view plays the saved frames in recorded order, a few
 * seconds behind the newest one, and jumps ahead when it falls far behind.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { episodeFileUrl } from '../api';
import { cameraLabel, mainCameraOf } from '../cameras';
import type { EpisodeModel, FrameRec } from '../model';
import { TraceImage } from './TraceImage';
import type { EpisodeRef } from './ValueView';

/** How far playback stays behind the newest saved frame, so each batch plays out smoothly. */
export const LIVE_DELAY_S = 3;
/** Falling further behind than this (a long pause, then a burst) jumps back to near-live. */
export const MAX_LAG_S = 10;
/** Playback steps 20 times a second, so a fast burst (a GPU-rendered motion saves ~30 frames/s) plays smoothly. */
export const PLAYBACK_TICK_MS = 50;
/** A red frame marks live camera frames, so they are not mistaken for the saved video. */
export const LIVE_FRAME_CLASS = 'rounded ring-2 ring-red-500';
const PLAYHEAD_EPSILON_S = 1e-3;
/** Frames requested ahead of the one shown, so switching does not wait for a download. */
const PREFETCH = 6;

const wallOf = (frame: FrameRec) => {
  const wall = frame.event.wall_time;
  return typeof wall === 'number' && Number.isFinite(wall) ? wall : null;
};

/** Next playback time (recorded wall-clock seconds) after `elapsedS` seconds of real time. */
export function nextPlayhead(previous: number | null, elapsedS: number, newest: number): number {
  const target = newest - LIVE_DELAY_S;
  if (previous === null) return target;
  const next = previous + Math.max(0, elapsedS);
  return Math.min(next < target - MAX_LAG_S ? target : next, newest);
}

/** Built once for each saved, time-sorted camera history, including untimed frames. */
export function indexLiveFrames(frames: FrameRec[]) {
  return { frames, timed: frames.flatMap((frame, index) => {
    const wall = wallOf(frame);
    return wall === null ? [] : [{ wall, index }];
  }) };
}
/** The frame on screen at `playhead`: the last one saved by then, else the first. */
export function frameIndexAt({ frames, timed }: ReturnType<typeof indexLiveFrames>, playhead: number | null): number {
  if (playhead === null || timed.length === 0) return frames.length - 1;
  // The playhead adds many short steps to an epoch time (~1.7e9 s), whose rounding
  // grows to microseconds, so allow a millisecond (frames are >= ~33 ms apart).
  let lo = 0, hi = timed.length;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (timed[mid].wall <= playhead + PLAYHEAD_EPSILON_S) lo = mid + 1;
    else hi = mid;
  }
  return timed[Math.max(0, lo - 1)].index;
}

export function LiveCameras({ model, ep, ended = false, onCaughtUp }: {
  model: EpisodeModel;
  ep: EpisodeRef;
  ended?: boolean;
  onCaughtUp?: () => void;
}) {
  // The main camera first, then the others by name; only frames whose image was saved.
  const cameras = useMemo(() => {
    const main = mainCameraOf(model);
    return Array.from(model.framesByCamera, ([camera, frames]) => ({
      camera,
      ...indexLiveFrames(frames.filter(frame => frame.written && frame.path)
        .sort((a, b) => (wallOf(a) ?? Infinity) - (wallOf(b) ?? Infinity))),
    })).sort((a, b) => Number(b.camera === main) - Number(a.camera === main) || a.camera.localeCompare(b.camera));
  }, [model]);
  const newest = useMemo(() => {
    let latest: number | null = null;
    for (const { timed } of cameras) {
      const wall = timed.at(-1)?.wall;
      if (wall !== undefined && (latest === null || wall > latest)) latest = wall;
    }
    return latest;
  }, [cameras]);

  const newestRef = useRef(newest);
  newestRef.current = newest;
  const [clock, setClock] = useState(() => ({ now: Date.now(), playhead: newest === null ? null : nextPlayhead(null, 0, newest) }));
  useEffect(() => {
    let last = Date.now();
    const timer = window.setInterval(() => {
      const now = Date.now();
      const elapsed = (now - last) / 1000;
      last = now;
      setClock(previous => {
        const latest = newestRef.current;
        return { now, playhead: latest === null ? null : nextPlayhead(previous.playhead, elapsed, latest) };
      });
    }, PLAYBACK_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  // The first frames of a trial start playback without waiting for a tick.
  const playhead = clock.playhead ?? (newest === null ? null : nextPlayhead(null, 0, newest));

  const shown = cameras.map(history => {
    const { camera, frames } = history;
    const index = frameIndexAt(history, playhead);
    const frame = frames[index];
    return { camera, frame, upcoming: index < 0 ? [] : frames.slice(index + 1, index + 1 + PREFETCH) };
  });
  // Compare the frames actually shown: a camera with only one frame is already
  // done, even when the delayed playhead is still before that frame's time.
  const caughtUp = cameras.every((history, index) => shown[index].frame === history.frames[frameIndexAt(history, Infinity)]);
  useEffect(() => {
    if (ended && caughtUp) onCaughtUp?.();
  }, [ended, caughtUp, onCaughtUp]);
  const prefetchKey = shown.flatMap(({ upcoming }) => upcoming.map(frame => frame.path)).join('\n');
  useEffect(() => {
    if (typeof Image === 'undefined') return;
    for (const { upcoming } of shown) for (const frame of upcoming) new Image().src = episodeFileUrl(ep, frame.path!);
    // Only a changed set of upcoming frames needs new requests.
  }, [prefetchKey, ep.runId, ep.episodeId, ep.generation]);

  return (
    <section aria-label="ライブカメラ" className="p-3 space-y-2">
      <p className="text-xs text-text-secondary">各カメラの記録フレームを、記録された順に約{LIVE_DELAY_S}秒遅れで再生しています（デバッグ用。モデルへの入力ではありません）</p>
      {cameras.length === 0 && <p className="text-xs text-text-tertiary">カメラの記録を待っています。</p>}
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(Math.max(cameras.length, 1), 3)}, minmax(0, 1fr))` }}>
        {shown.map(({ camera, frame }) => {
          const wall = frame ? wallOf(frame) : null;
          const age = wall !== null ? agoText(clock.now / 1000 - wall) : '時刻不明';
          return <figure key={camera} className="min-w-0 space-y-1">
            <figcaption className="flex items-center justify-between gap-2 text-xs text-text-secondary">
              <span title={camera}>{cameraLabel(camera)}</span><span>{frame ? age : '記録を待っています'}</span>
            </figcaption>
            <TraceImage
              src={frame?.path ? episodeFileUrl(ep, frame.path) : null}
              alt={`${cameraLabel(camera)}の記録フレーム`}
              provenance="debug_frame"
              compact
              retryMs={2000}
              className={`aspect-[4/3] w-full ${LIVE_FRAME_CLASS}`}
              meta={<span>{camera} · {age} · e{frame?.epoch ?? '?'} #{frame?.bufferIndex ?? '?'}</span>}
            />
          </figure>;
        })}
      </div>
    </section>
  );
}

/** 「12秒前」「3分前」「2時間前」. */
export function agoText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}秒前`;
  if (s < 3600) return `${Math.floor(s / 60)}分前`;
  return `${Math.floor(s / 3600)}時間前`;
}
