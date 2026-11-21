/** Recorded calls aligned by identity within their recorded turn, never by time. */
import { siteHref } from '../navigation/site';
import { callOutcome, parallelReasoningTitle, textOf, type EpisodeModel, type TNode } from './model';
import { turnOf } from './replay';
import { dataOf, type TraceEvent } from './types';

export interface ComparisonCall {
  kind: 'model' | 'api' | 'service' | 'decision' | 'code';
  name: string;
  turn: number | null;
  eventId: string;
  seq: number;
  arguments: string;
  argumentSummary: string;
  status: string;
  returned: string;
  resultSummary: string;
  argumentsValue?: unknown;
  resultValue?: unknown;
  modelTextSignature?: string;
}
export interface ComparisonRow {
  turn: number | null;
  baseline: ComparisonCall | null;
  current: ComparisonCall | null;
  different: boolean;
  modelTextDifferent: boolean;
  firstDifference: boolean;
}

export function trialEventUrl(runId: string, episodeId: string, eventId?: string, camera?: string | null): string {
  const query = new URLSearchParams({ run: runId, episode: episodeId });
  if (eventId) query.set('event', eventId);
  if (camera) query.set('camera', camera);
  return siteHref(`/traces?${query}`);
}
export function comparisonUrl(runId: string, episodeId: string, baselineRunId: string, baselineEpisodeId: string, camera?: string | null): string {
  const query = new URLSearchParams({ run: runId, episode: episodeId, baseline_run: baselineRunId, baseline_episode: baselineEpisodeId });
  if (camera) query.set('camera', camera);
  return siteHref(`/traces/compare?${query}`);
}

const ellipsis = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : null;

/** Compare the recorded value's structure, never array samples, hashes or asset paths. */
function summary(value: unknown, depth = 0): string {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(Number(value.toPrecision(3))) : String(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return JSON.stringify(ellipsis(value.replace(/\s+/g, ' ').trim(), 40));
  if (depth > 5) return '…';
  if (Array.isArray(value)) return `[${value.slice(0, 8).map(item => summary(item, depth + 1)).join(',')}${value.length > 8 ? ',…' : ''}]`;
  const source = object(value);
  if (!source) return String(value);
  const type = typeof source.type === 'string' ? source.type : '';
  if (type === 'ndarray' || type === 'torch.Tensor' || (Array.isArray(source.shape) && typeof source.dtype === 'string')) {
    return `${type || 'ndarray'}(${Array.isArray(source.shape) ? source.shape.join(',') : '?'}) ${source.dtype ?? '?'}`;
  }
  if (source.truncated === true && (typeof source.preview === 'string' || typeof source.text === 'string')) {
    return summary(source.text ?? source.preview, depth + 1);
  }
  // The recorder wraps Python containers in {type, length, items}.
  if (Array.isArray(source.items) || object(source.items)) {
    const content = summary(source.items, depth);
    const label = typeof source.length === 'number' ? `${type.split('.').at(-1) || 'container'}(${source.length})` : type === 'tuple' ? 'tuple' : '';
    return `${label}${content}${source.truncated ? '…' : ''}`;
  }
  if (object(source.fields)) return `${type}(${summary(source.fields, depth + 1)})`;
  if (type === 'PIL.Image') return `PIL.Image(${Array.isArray(source.size) ? source.size.join(',') : '?'}) ${source.mode ?? ''}`.trim();
  if (type) return `<${type}>`;
  const keys = Object.keys(source).sort();
  return `{${keys.slice(0, 12).map(key => `${JSON.stringify(key)}:${summary(source[key], depth + 1)}`).join(',')}${keys.length > 12 ? ',…' : ''}}`;
}
export function shortCallSummary(value: unknown): string {
  return ellipsis(summary(value), 200);
}
/** The expanded row keeps everything the recorder stored, without summary limits. */
const fullValue = (value: unknown): string => value === undefined ? '' : textOf(value) || JSON.stringify(value, null, 2) || '';
const textSignature = (value: unknown): string => {
  const source = object(value);
  return source?.truncated === true ? String(source.sha256 ?? source.asset ?? JSON.stringify(source)) : fullValue(value);
};
const statusOf = (node: TNode) => node.failed ? 'error' : node.open ? 'started' : node.end?.status ?? node.primary.status ?? '未記録';
const nodeData = (event: TraceEvent | null) => event?.data && typeof event.data === 'object' && !Array.isArray(event.data)
  ? event.data as Record<string, unknown> : {};

/** Stored request details are for expansion only, never for semantic comparison. */
export function modelArgumentSummary(request: TraceEvent, payload?: unknown): string {
  const data = nodeData(request);
  return fullValue(payload ?? Object.fromEntries(['prompt', 'instructions', 'request_summary', 'messages', 'input', 'model', 'params', 'n_messages', 'n_images', 'n_videos']
    .filter(key => data[key] !== undefined && data[key] !== null).map(key => [key, data[key]])));
}

export function comparisonCalls(model: EpisodeModel, requestArguments: ReadonlyMap<string, string> = new Map()): ComparisonCall[] {
  const calls: ComparisonCall[] = [];
  for (const node of model.allNodes) {
    const start = nodeData(node.primary);
    const end = nodeData(node.end);
    const base = { eventId: node.primary.event_id, seq: node.seq, turn: turnOf(node) };
    if (node.kind === 'model_call' && node.call) {
      const call = node.call;
      const outcome = callOutcome(call);
      const request = call.attempts[0]?.request ?? null;
      const response = nodeData(outcome.finalError ?? outcome.httpAnswer);
      const result = response.message ?? response.content ?? response.partial_content;
      const args = request ? requestArguments.get(request.event_id) ?? modelArgumentSummary(request) : '';
      calls.push({ ...base, kind: 'model', name: parallelReasoningTitle(call, false) ?? [call.role, call.callKind].filter(Boolean).join(' · '),
        arguments: args,
        argumentSummary: '',
        status: outcome.state === 'failed' ? 'error' : outcome.state === 'open' ? 'started' : 'ok',
        returned: fullValue(result), resultSummary: '', resultValue: result,
        modelTextSignature: JSON.stringify([args, textSignature(result)]),
      });
    } else if (node.kind === 'api_call') {
      const result = end.message ?? end.return;
      calls.push({ ...base, kind: 'api', name: String(start.name ?? start.qualname ?? end.name ?? 'API'),
        arguments: fullValue(start.args), argumentSummary: shortCallSummary(start.args), argumentsValue: start.args, status: statusOf(node),
        returned: fullValue(result), resultSummary: shortCallSummary(result), resultValue: result,
      });
    } else if (node.kind === 'service_call') {
      const result = end.message ?? end.response_summary;
      calls.push({ ...base, kind: 'service', name: [start.service ?? end.service, start.function ?? end.function].filter(Boolean).join('.') || 'サービス',
        arguments: fullValue(start.request_summary), argumentSummary: shortCallSummary(start.request_summary), argumentsValue: start.request_summary, status: statusOf(node),
        returned: fullValue(result), resultSummary: shortCallSummary(result), resultValue: result,
      });
    } else if (node.kind === 'code_block') {
      calls.push({ ...base, kind: 'code', name: 'Pythonの実行', arguments: fullValue(start.code), argumentsValue: start.code,
        argumentSummary: '', status: statusOf(node), returned: fullValue(end), resultSummary: '', resultValue: end,
      });
    }
  }
  for (const event of model.events) {
    if (event.event_type !== 'model_output_parsed') continue;
    const decision = dataOf(event, 'model_output_parsed');
    if (typeof decision.decision !== 'string' || !/^(finish|regenerate)$/i.test(decision.decision)) continue;
    const call = model.callOfEvent.get(event.event_id);
    if (call && call.role !== 'code_generator') continue;
    const node = model.nodeOfEvent.get(event.event_id);
    calls.push({ kind: 'decision', name: 'コードを書くモデルの判断', eventId: event.event_id, seq: event.seq,
      turn: node ? turnOf(node) : event.refs?.turn_index ?? null,
      arguments: '', argumentSummary: '', status: event.status ?? '未記録', returned: decision.decision.toUpperCase(), resultSummary: decision.decision.toUpperCase(),
    });
  }
  return calls.sort((a, b) => a.seq - b.seq);
}

const sameIdentity = (a: ComparisonCall, b: ComparisonCall) => a.kind === b.kind && a.name === b.name;
function sameContents(a: ComparisonCall, b: ComparisonCall): boolean {
  if (!sameIdentity(a, b)) return false;
  if (a.kind === 'model') return true;
  if (a.kind === 'code') return a.status === b.status;
  if (a.kind === 'decision') return a.resultSummary === b.resultSummary;
  return a.argumentSummary === b.argumentSummary && a.status === b.status && a.resultSummary === b.resultSummary;
}

/** LCS lengths for Hirschberg's algorithm: memory stays linear in the call count. */
function lcsLengths(a: ComparisonCall[], b: ComparisonCall[]): Uint32Array {
  let previous = new Uint32Array(b.length + 1);
  for (const left of a) {
    const next = new Uint32Array(b.length + 1);
    for (let j = 0; j < b.length; j++) next[j + 1] = sameIdentity(left, b[j])
      ? previous[j] + 1 : Math.max(previous[j + 1], next[j]);
    previous = next;
  }
  return previous;
}
function alignTurn(a: ComparisonCall[], b: ComparisonCall[]): Array<[ComparisonCall | null, ComparisonCall | null]> {
  if (!a.length) return b.map(call => [null, call]);
  if (!b.length) return a.map(call => [call, null]);
  if (a.length === 1) {
    const match = b.findIndex(call => sameIdentity(a[0], call));
    return match < 0 ? [[a[0], null], ...b.map(call => [null, call] as [null, ComparisonCall])]
      : [...b.slice(0, match).map(call => [null, call] as [null, ComparisonCall]), [a[0], b[match]],
        ...b.slice(match + 1).map(call => [null, call] as [null, ComparisonCall])];
  }
  const mid = Math.floor(a.length / 2);
  const before = lcsLengths(a.slice(0, mid), b);
  const after = lcsLengths(a.slice(mid).reverse(), [...b].reverse());
  let split = 0;
  for (let j = 1; j <= b.length; j++) if (before[j] + after[b.length - j] > before[split] + after[b.length - split]) split = j;
  return [...alignTurn(a.slice(0, mid), b.slice(0, split)), ...alignTurn(a.slice(mid), b.slice(split))];
}

export function alignComparisonCalls(baseline: ComparisonCall[], current: ComparisonCall[]): ComparisonRow[] {
  const turns = [...new Set([...baseline, ...current].map(call => call.turn))]
    .sort((a, b) => a === null ? -1 : b === null ? 1 : a - b);
  let seenDifference = false;
  return turns.flatMap(turn => alignTurn(baseline.filter(call => call.turn === turn), current.filter(call => call.turn === turn))
    .map(([left, right]) => {
      const different = !left || !right || !sameContents(left, right);
      const firstDifference = different && !seenDifference;
      seenDifference ||= different;
      const modelTextDifferent = !!left && !!right && left.kind === 'model' && right.kind === 'model'
        && (left.modelTextSignature !== right.modelTextSignature || left.arguments !== right.arguments || left.returned !== right.returned);
      return { turn, baseline: left, current: right, different, modelTextDifferent, firstDifference };
    }));
}

export const comparisonTurnLabel = (turn: number | null) => turn === null ? 'ターン未記録' : `ターン${turn}`;
export function firstDifferenceDetails(row: ComparisonRow): string {
  if (!row.baseline || !row.current) {
    const call = (row.current ?? row.baseline)!;
    const details = [call.argumentSummary ? `引数：${call.argumentSummary}` : '',
      call.resultSummary ? `返った内容：${call.resultSummary}` : ''].filter(Boolean).join('。');
    return `${row.current ? '今回' : '基準'}だけに呼び出しがあります。${details}`;
  }
  const differences: string[] = [];
  const fields = row.baseline.kind === 'code' ? [['status', '状態']] as const
    : row.baseline.kind === 'decision' ? [['resultSummary', '判断']] as const
    : row.baseline.kind === 'model' ? [['name', '名前']] as const
    : [['name', '名前'], ['argumentSummary', '引数'], ['status', '状態'], ['resultSummary', '返った内容']] as const;
  for (const [field, label] of fields) {
    if (row.baseline[field] !== row.current[field]) differences.push(`${label}：基準「${row.baseline[field] || '未記録'}」 / 今回「${row.current[field] || '未記録'}」`);
  }
  return differences.join('。');
}
