/** Small facts from the recorded trace. End classification remains server-owned. */
import { baselineTrialFor } from '../evals/model';
import { END_LABELS } from '../evals/failureReasons';
import type { EvalDetail, EvalTrial } from '../evals/api';
import { nodeTitle, textOf, type EpisodeModel } from './model';
import { recordedTurns, turnOf } from './replay';
import { dataOf, type EpisodeSummary, type TextValue, type TraceEvent } from './types';

export interface SummaryFact { event: TraceEvent; text: string; turn: number | null; value?: TextValue | null }
export interface SummaryFrame { event: TraceEvent; path: string; camera?: string | null }
export interface TurnFlow { turn: number; labels: string[]; event: TraceEvent }

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function firstLine(value: string): string { return value.trim().split(/\r?\n/)[0] ?? ''; }
export function eventTurn(model: EpisodeModel, event: TraceEvent): number | null {
  const node = model.nodeOfEvent.get(event.event_id);
  if (node) return turnOf(node);
  const turn = event.refs?.turn_index ?? object(event.data).turn_index;
  return typeof turn === 'number' && Number.isInteger(turn) && turn >= 0 ? turn : null;
}
export function recordedDecision(model: EpisodeModel, event: TraceEvent): 'FINISH' | 'REGENERATE' | null {
  if (event.event_type !== 'model_output_parsed') return null;
  const call = model.callOfEvent.get(event.event_id);
  const data = dataOf(event, 'model_output_parsed');
  if (call && call.role !== 'code_generator') return null;
  if (!call && data.parser !== '_parse_multi_turn_decision') return null;
  const decision = data.decision?.toUpperCase();
  return decision === 'FINISH' || decision === 'REGENERATE' ? decision : null;
}
function errorValue(event: TraceEvent): TextValue | null {
  const data = object(event.data);
  const exception = object(data.exception);
  return (data.message ?? exception.message ?? data.error_type ?? exception.type) as TextValue | null;
}
export function isRecordedError(event: TraceEvent): boolean {
  const data = object(event.data);
  return event.status === 'error' || ['api_call_error', 'service_call_error', 'model_error'].includes(event.event_type) || !!data.exception;
}
export function lastRecordedFrame(model: EpisodeModel, camera?: string | null): SummaryFrame | null {
  // Snapshots are harness renders too. Exclude model-input and perception artifacts.
  for (const event of [...model.events].sort((a, b) => b.seq - a.seq)) {
    if (event.event_type !== 'frame' && event.event_type !== 'observation_snapshot') continue;
    const recordedCamera = object(event.data).camera;
    if (camera && recordedCamera !== camera) continue;
    const image = event.artifacts?.find(a => a.path && a.written !== false &&
      (a.mime?.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(a.path)));
    if (image?.path) return { event, path: image.path, camera: typeof recordedCamera === 'string' ? recordedCamera : null };
  }
  // Older or partial records can retain a written frame reference without its
  // separate frame event. Keep that reference anchored to the call that saved it.
  for (const event of [...model.events].sort((a, b) => b.seq - a.seq)) {
    const data = object(event.data);
    for (const value of [data.frame_ref, data.frame_refs]) {
      for (const ref of Array.isArray(value) ? value : [value]) {
        const image = object(ref);
        if ((!camera || image.camera === camera) && typeof image.path === 'string' && image.written === true) {
          return { event, path: image.path, camera: typeof image.camera === 'string' ? image.camera : null };
        }
      }
    }
  }
  return null;
}
export function trialSummaryFacts(model: EpisodeModel, summary: EpisodeSummary) {
  const ordered = [...model.events].sort((a, b) => a.seq - b.seq);
  const firstErrorEvent = ordered.find(isRecordedError);
  let firstError: SummaryFact | null = null;
  if (firstErrorEvent) {
    const node = model.nodeOfEvent.get(firstErrorEvent.event_id);
    const data = object(firstErrorEvent.data);
    const name = typeof data.name === 'string' ? data.name : node ? nodeTitle(node) : firstErrorEvent.event_type;
    const value = errorValue(firstErrorEvent);
    firstError = { event: firstErrorEvent, turn: eventTurn(model, firstErrorEvent), text: name, value };
  }
  let observation: SummaryFact | null = null;
  let decision: SummaryFact | null = null;
  const lastVdm = [...model.calls].reverse().find(call => call.role === 'vdm');
  for (const event of ordered) {
    if (event.event_type === 'model_response') {
      const data = dataOf(event, 'model_response');
      const role = data.role ?? model.callOfEvent.get(event.event_id)?.role;
      if (role === 'vdm' && (!lastVdm || model.callOfEvent.get(event.event_id) === lastVdm) && data.content != null) {
        observation = { event, turn: eventTurn(model, event), text: textOf(data.content), value: data.content };
      }
    }
    const choice = recordedDecision(model, event);
    if (choice) {
      const data = dataOf(event, 'model_output_parsed');
      const responseId = data.model_event_id ?? event.parent_event_id;
      const response = responseId ? model.byId.get(responseId) : null;
      const value = response?.event_type === 'model_response' ? dataOf(response, 'model_response').content : null;
      decision = { event, turn: eventTurn(model, event), text: choice, value };
    }
  }
  const harness = object(summary.episode?.harness_summary ?? dataOf(model.episodeEnd, 'episode_end').harness_summary);
  const regenerationCount = typeof harness.num_regenerations === 'number' && Number.isInteger(harness.num_regenerations) && harness.num_regenerations >= 0
    ? harness.num_regenerations : ordered.filter(event => recordedDecision(model, event) === 'REGENERATE').length;
  const turns = recordedTurns(model);
  const duration = dataOf(model.episodeEnd, 'episode_end').duration_s;
  const wallStart = summary.start_wall_time ?? model.episodeStart?.wall_time;
  const wallEnd = summary.end_wall_time ?? model.episodeEnd?.wall_time;
  const durationSeconds = typeof duration === 'number' && duration >= 0 ? duration :
    typeof wallStart === 'number' && typeof wallEnd === 'number' && wallEnd >= wallStart ? wallEnd - wallStart : null;
  const flow: TurnFlow[] = [];
  for (const turn of turns) {
    const events = ordered.filter(event => eventTurn(model, event) === turn);
    const labels: string[] = [];
    let anchor = events[0];
    for (const event of events) {
      const choice = recordedDecision(model, event);
      const label = choice === 'REGENERATE' ? '書き直し' : choice === 'FINISH' ?
        summary.end_classification?.reason === 'finish_unmet' && decision?.event.event_id === event.event_id ? END_LABELS.finish_unmet : '終了' :
        isRecordedError(event) ? 'エラー' : null;
      if (label && labels[labels.length - 1] !== label) { labels.push(label); anchor = event; }
    }
    if (!labels.length) labels.push('実行');
    if (anchor) flow.push({ turn, labels, event: anchor });
  }
  return { firstError, observation, decision, regenerationCount, turnCount: turns.length || null, durationSeconds, flow, frame: lastRecordedFrame(model) };
}

/** Pair the same task/seed, including a unique baseline under a changed condition. */
export function baselineForEpisode(detail: EvalDetail | null, summary: EpisodeSummary): EvalTrial | null {
  if (!detail?.baseline) return null;
  return baselineTrialFor({ task: summary.task ?? null, seed: summary.seed ?? null, condition: summary.condition ?? null }, detail.baseline_trials);
}

/** Only a few summary facts need their full data, even before a row is selected. */
export function summaryAssetTargets(model: EpisodeModel): TraceEvent[] {
  const error = model.events.find(isRecordedError);
  const vdm = [...model.calls].reverse().find(call => call.role === 'vdm');
  const writer = [...model.calls].reverse().find(call => call.role === 'code_generator' && call.parsed.some(event => recordedDecision(model, event)));
  return [...new Set([
    ...(error ? [error] : []),
    ...(vdm ? [...vdm.attempts.flatMap(attempt => attempt.responses), ...vdm.unmatched].slice(-1) : []),
    ...(writer ? [...writer.parsed, ...writer.attempts.flatMap(attempt => attempt.responses)] : []),
  ])];
}
