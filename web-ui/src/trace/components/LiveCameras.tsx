/**
 * Saved frames of each camera while a trial is running in Live mode.
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
export const PLAYBACK_TICK_MS = 200;
/** Frames requested ahead of the one shown, so switching does not wait for a download. */
const PREFETCH = 3;

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

/** The frame on screen at `playhead`: the last one saved by then, else the first. */
export function frameAt(frames: FrameRec[], playhead: number | null): FrameRec | undefined {
  const timed = frames.filter(frame => wallOf(frame) !== null);
  if (playhead === null || timed.length === 0) return frames.at(-1);
  return timed.findLast(frame => wallOf(frame)! <= playhead) ?? timed[0];
}

export function LiveCameras({ model, ep }: { model: EpisodeModel; ep: EpisodeRef }) {
  // The main camera first, then the others by name; only frames whose image was saved.
  const cameras = useMemo(() => {
    const main = mainCameraOf(model);
    return Array.from(model.framesByCamera, ([camera, frames]) => ({
      camera,
      frames: frames.filter(frame => frame.written && frame.path)
        .sort((a, b) => (wallOf(a) ?? Infinity) - (wallOf(b) ?? Infinity)),
    })).sort((a, b) => Number(b.camera === main) - Number(a.camera === main) || a.camera.localeCompare(b.camera));
  }, [model]);
  const newest = useMemo(() => {
    const walls = cameras.flatMap(({ frames }) => frames.map(wallOf)).filter((wall): wall is number => wall !== null);
    return walls.length ? Math.max(...walls) : null;
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

  const shown = cameras.map(({ camera, frames }) => {
    const frame = frameAt(frames, playhead);
    const index = frame ? frames.indexOf(frame) : -1;
    return { camera, frame, upcoming: index < 0 ? [] : frames.slice(index + 1, index + 1 + PREFETCH) };
  });
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
              className="aspect-[4/3] w-full"
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
