/** Latest saved frame of each camera while a trial is running in Live mode. */
import { useEffect, useMemo, useState } from 'react';
import { episodeFileUrl } from '../api';
import { cameraLabel, mainCameraOf } from '../cameras';
import type { EpisodeModel } from '../model';
import { TraceImage } from './TraceImage';
import type { EpisodeRef } from './ValueView';

export function LiveCameras({ model, ep }: { model: EpisodeModel; ep: EpisodeRef }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  // The main camera first, then the others by name.
  const cameras = useMemo(() => {
    const main = mainCameraOf(model);
    return Array.from(model.framesByCamera, ([camera, frames]) => ({
      camera,
      frame: frames.findLast(frame => frame.written && frame.path),
    })).sort((a, b) => Number(b.camera === main) - Number(a.camera === main) || a.camera.localeCompare(b.camera));
  }, [model]);

  return (
    <section aria-label="ライブカメラ" className="p-3 space-y-2">
      <p className="text-xs text-text-secondary">各カメラの最新の記録フレーム（デバッグ用。モデルへの入力ではありません）</p>
      {cameras.length === 0 && <p className="text-xs text-text-tertiary">カメラの記録を待っています。</p>}
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(Math.max(cameras.length, 1), 3)}, minmax(0, 1fr))` }}>
        {cameras.map(({ camera, frame }) => {
          const wall = frame?.event.wall_time;
          const age = typeof wall === 'number' && Number.isFinite(wall)
            ? agoText(now / 1000 - wall) : '時刻不明';
          return <figure key={camera} className="min-w-0 space-y-1">
            <figcaption className="flex items-center justify-between gap-2 text-xs text-text-secondary">
              <span title={camera}>{cameraLabel(camera)}</span><span>{frame ? age : '記録を待っています'}</span>
            </figcaption>
            <TraceImage
              src={frame?.path ? episodeFileUrl(ep, frame.path) : null}
              alt={`${cameraLabel(camera)}の最新フレーム`}
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
