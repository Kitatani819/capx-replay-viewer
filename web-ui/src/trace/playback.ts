/** Video lookup and frame-based playback mapping; docs/trace-format.md §9.3. */
import { episodeFileUrl, traceApi, type EpisodeRef } from './api';
import { cameraForVideo } from './cameras';
import type { EpisodeModel, FrameRec, TNode } from './model';
import { dataOf } from './types';
import type { RunnerMatch } from './runner';
import { turnOf } from './replay';

export interface TrialVideo { url: string; name: string; turnIndex?: number; source?: 'episode' | 'runner' }
const object = (x: unknown): Record<string, unknown> => x && typeof x === 'object' ? x as Record<string, unknown> : {};
const safe = (x: string) => !!x && x !== '.' && x !== '..' && !/[\\/\0]/.test(x);

/** Only a time-verified final attempt may use the record's final artifacts. */
export function trialVideos(run: string, match: RunnerMatch, roots: string[]): TrialVideo[] {
  if (!match.record || !match.isFinal || match.unverified) return [];
  const r = match.record;
  const a = object(r.artifacts);
  if (typeof a.trial_dir !== 'string' || !Array.isArray(a.videos) || !r.task || !r.condition) return [];
  const dir = a.trial_dir;
  const trial = dir.split('/').at(-1)!;
  if (![run, r.task, r.condition, trial].every(safe)) return [];
  const root = roots.findIndex(x => `${x.replace(/\/$/, '')}/${run}/${r.task}/${r.condition}/${trial}` === dir);
  if (root < 0) return [];
  return a.videos.flatMap((p: unknown) => {
    if (typeof p !== 'string' || !p.startsWith(`${dir}/`)) return [];
    const name = p.slice(dir.length + 1);
    if (!/^video_combined(?:_[\w-]+)?\.mp4$/.test(name)) return [];
    return [{ name, url: traceApi.legacyFileUrl(run, r.task!, r.condition!, trial, name, root), source: 'runner' as const }];
  });
}

/** Videos copied into an upstream episode by H4; only declared, written files are shown. */
export function episodeVideos(ep: EpisodeRef, model: EpisodeModel): TrialVideo[] {
  return model.events.filter(e => e.event_type === 'trial_videos').flatMap(e => e.artifacts ?? []).flatMap(art => {
    if (art.written !== true || typeof art.path !== 'string' || art.mime !== 'video/mp4') return [];
    const match = /^videos\/(video_(?:turn_(\d+)(?:_[\w-]+)?|combined(?:_[\w-]+)?)\.mp4)$/.exec(art.path);
    if (!match || (match[2] !== undefined &&
      (typeof art.turn_index !== 'number' || art.turn_index !== Number(match[2])))) return [];
    return [{name: match[1], url: episodeFileUrl(ep, art.path), source: 'episode' as const,
      ...(match[2] !== undefined ? {turnIndex: Number(match[2])} : {})}];
  });
}

/** A missing code block event must never shift a later turn onto an earlier video. */
export function chooseExecutionVideo(block: TNode, videos: TrialVideo[]): {video: TrialVideo | undefined; wholeTrial: boolean} {
  const index = dataOf(block.primary, 'code_block_start').block_index;
  if (typeof index === 'number' && Number.isInteger(index) && index >= 0) {
    const turn = videos.find(v => v.turnIndex === index && !v.name.includes('_wrist'));
    if (turn) return {video: turn, wholeTrial: false};
  }
  const combined = videos.filter(v => /^video_combined(?:_[\w-]+)?\.mp4$/.test(v.name))
    .sort((a,b) => (a.name === 'video_combined.mp4' ? -1 : b.name === 'video_combined.mp4' ? 1 : a.name.localeCompare(b.name)))[0];
  return {video: combined, wholeTrial: true};
}

export function cameraVideos(videos: TrialVideo[]): TrialVideo[] {
  return videos.filter(v => v.turnIndex === undefined);
}

export function canPlayExecutionVideo(video: TrialVideo | undefined, turnVideo: boolean,
  clip: {start:number;end:number} | null): boolean {
  return !!video && (turnVideo || video.source === 'episode' || !!clip && clip.end > clip.start);
}

export function validClip(clip: {start:number;end:number} | null): {start:number;end:number} | null {
  return clip && Number.isFinite(clip.start) && Number.isFinite(clip.end) && clip.end > clip.start ? clip : null;
}

export function videosForEpisode(ep: EpisodeRef, model: EpisodeModel, match: RunnerMatch | null,
  roots: string[]): TrialVideo[] {
  const runner = match ? trialVideos(ep.runId, match, roots) : [];
  return runner.length ? runner : episodeVideos(ep, model);
}

// the runner that wrote the trace encodes combined videos at 30 fps.
// Do not use wall-clock duration: inference delays are absent from the MP4.
export const RECORDED_VIDEO_FPS = 30;
export interface PlaybackCue { time: number; node: TNode; positionSource?: 'sim_step' | 'turn_synthesis'; candidateCount?: number }
export interface PlaybackGroup { time: number; cues: PlaybackCue[] }
export interface PlaybackMap { reason: string | null; pending?: boolean; prompts: PlaybackCue[]; actions: PlaybackCue[]; all: PlaybackCue[]; unsynced: TNode[]; timeForStep?: (step: number) => number }
const replayKinds = new Set(['model_call', 'api_call', 'code_block', 'service_call', 'stdout', 'stderr', 'evaluator', 'feedback']);
const primaryKinds = new Set(['model_call', 'code_block', 'service_call', 'evaluator']);

export function isPrimaryReplayNode(node: TNode): boolean {
  return primaryKinds.has(node.kind);
}
export function groupCues(cues: PlaybackCue[]): PlaybackGroup[] {
  const groups: PlaybackGroup[] = [];
  for (const cue of [...cues].sort((a,b) => a.time-b.time || a.node.seq-b.node.seq)) {
    const last = groups.at(-1);
    if (last && Math.abs(last.time-cue.time) < 0.000001) last.cues.push(cue);
    else groups.push({time: cue.time, cues: [cue]});
  }
  return groups;
}
/** One row per recorded candidate group in the main view. Logical call nodes
 * already contain HTTP retries; those retries never increase the candidate count.
 * Unknown turns are left separate because co-location alone is not identity. */
export function primaryPlaybackCues(cues: PlaybackCue[]): PlaybackCue[] {
  return groupCues(cues).flatMap(group => {
    const seen = new Set<number>();
    return group.cues.flatMap(cue => {
      if(cue.node.call?.callKind === 'ensemble_member') {
        const turn = turnOf(cue.node);
        if(turn === null)return [{...cue,candidateCount:1}];
        if(seen.has(turn))return [];
        seen.add(turn);
        const members=group.cues.filter(c=>c.node.call?.callKind==='ensemble_member' && turnOf(c.node)===turn);
        return [{...cue,candidateCount:new Set(members.map(c=>c.node.call!.id)).size}];
      }
      return isPrimaryReplayNode(cue.node) ? [cue] : [];
    });
  });
}
export function playbackMap(model: EpisodeModel, name: string, duration: number): PlaybackMap {
  const nodes = model.allNodes.filter(node => replayKinds.has(node.kind));
  const fail = (reason: string, pending = false): PlaybackMap => ({reason, pending, prompts: [], actions: [], all: [], unsynced: nodes});
  if (!/^video_combined(?:_[\w-]+)?\.mp4$/.test(name)) return fail('このカメラの動画とイベントの対応は未記録です。');
  if (!(duration > 0)) return fail('動画を読み込み中です。', true);
  if (!Number.isFinite(duration)) return fail('動画の長さを取得できないため、自動同期はできません。');
  if (model.events.some(e => e.event_type === 'env_reset')) return fail('環境リセットを含むため、自動同期はできません。');
  const camera = cameraForVideo(model, name);
  if (!camera) return fail('動画と記録カメラを一意に対応付けられません。');
  const usable = (frames: FrameRec[]) => frames.filter(f => f.simStep !== null && Number.isFinite(f.simStep) && Number.isInteger(f.bufferIndex) && f.bufferIndex >= 0);
  let frames = usable(model.framesByCamera.get(camera) ?? []);
  if (frames.length === 0) {
    const cameras = [...model.framesByCamera.values()].map(usable).filter(fs => fs.length > 0);
    // All recorded cameras share buffer indices. Borrow anchors only when the
    // surviving camera records prove exactly the same index-to-step mapping.
    const signature = (fs: FrameRec[]) => JSON.stringify([...new Set(fs.map(f => `${f.epoch}:${f.bufferIndex}:${f.simStep}`))].sort());
    if (!cameras.length || cameras.some(fs => signature(fs) !== signature(cameras[0]))) {
      return fail('動画と記録カメラを一意に対応付けられません。');
    }
    frames = cameras[0];
  }
  if (frames.length < 2 || frames.some(f => f.epoch !== 0)) return fail('動画との対応に必要なフレーム記録が不足しています。');
  const unique = new Map<number, FrameRec>();
  for (const f of frames) {
    if (unique.has(f.bufferIndex) && unique.get(f.bufferIndex)!.simStep !== f.simStep) return fail('同じフレーム番号に異なるシミュレーション位置が記録されています。');
    unique.set(f.bufferIndex, f);
  }
  const anchors = [...unique.values()].sort((a,b) => a.bufferIndex-b.bufferIndex);
  if (anchors[0].bufferIndex !== 0 || Math.abs((anchors.at(-1)!.bufferIndex + 1) - duration * RECORDED_VIDEO_FPS) > 1.1 ||
      anchors.some((f,i) => i > 0 && f.simStep! < anchors[i-1].simStep!)) {
    return fail('動画全体とフレーム記録の対応を確認できません。動画のみ再生できます。');
  }
  const seconds = (step: number): number => {
    const hi = anchors.findIndex(f => f.simStep! >= step);
    if (hi < 0) return duration;
    if (hi === 0) return anchors[0].bufferIndex / RECORDED_VIDEO_FPS;
    const lo = anchors[hi-1], up = anchors[hi];
    const fraction = (step-lo.simStep!) / Math.max(1,up.simStep!-lo.simStep!);
    return (lo.bufferIndex + fraction*(up.bufferIndex-lo.bufferIndex))/RECORDED_VIDEO_FPS;
  };
  const all: PlaybackCue[] = [];
  const unsynced: TNode[] = [];
  for (const node of nodes) {
    let anchor = node;
    let positionSource: PlaybackCue['positionSource'] = 'sim_step';
    // Worker threads do not carry simulator coordinates. A unique, recorded
    // synthesis in the SAME turn can provide a turn position, explicitly labelled.
    if (node.primary.sim_step == null && node.call?.callKind === 'ensemble_member' && turnOf(node) !== null) {
      const syntheses = model.calls.filter(c => c.callKind === 'ensemble_synthesis' && c.turnIndex === turnOf(node));
      if (syntheses.length === 1) {
        anchor = syntheses[0].node;
        positionSource = 'turn_synthesis';
      }
    }
    const step = anchor.primary.sim_step;
    if (typeof step !== 'number' || !Number.isFinite(step) || anchor.primary.sim_epoch !== 0 ||
        step < anchors[0].simStep! || step > anchors.at(-1)!.simStep!) {
      unsynced.push(node);
      continue;
    }
    all.push({node, time: seconds(step), positionSource});
  }
  all.sort((a,b) => a.time-b.time || a.node.seq-b.node.seq);
  return {reason:null, timeForStep: seconds, all, unsynced, prompts:all.filter(c => c.node.kind === 'model_call'),
    actions:all.filter(c => c.node.kind !== 'model_call')};
}
export function cueAt(cues: PlaybackCue[], time: number): PlaybackCue | null {
  let last: PlaybackCue | null = null;
  for (const c of cues) { if (c.time > time + 0.001) break; last=c; }
  return last;
}
