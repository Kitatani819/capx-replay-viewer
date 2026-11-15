/** Recorded links for the API/Python replay. Never infer a call site from time or ancestry. */
import type { EpisodeModel, LogicalCall, TNode } from './model';
import { dataOf, type TraceEvent } from './types';

export interface ApiCallSite {
  block: TNode | null;
  recordedLine: number | null;
  reason: string | null;
}

/** A valid block remains useful even when its line number was not recorded. */
export function apiCallSite(model: EpisodeModel, node: TNode): ApiCallSite {
  if (node.kind !== 'api_call' || node.primary.event_type !== 'api_call_start') {
    return { block: null, recordedLine: null, reason: 'APIの呼び出し位置は未記録です。' };
  }
  const site = dataOf(node.primary, 'api_call_start').call_site;
  const id = site?.code_block_id;
  if (typeof id !== 'string' || !id.trim()) {
    return { block: null, recordedLine: null, reason: '呼び出し元の code_block_id は未記録です。' };
  }
  // The model also accepts event_id as an alias. Detect duplicate recorded block
  // IDs here rather than silently accepting whichever record populated the map last.
  const matches = model.blocks.filter((block) =>
    block.primary.event_id === id || dataOf(block.primary, 'code_block_start').code_block_id === id);
  if (matches.length !== 1) {
    return {
      block: null,
      recordedLine: null,
      reason: matches.length ? '同じIDのPythonブロックが複数あり、対応を特定できません。' : '呼び出し元のPythonブロックは未記録です。',
    };
  }
  const line = site?.line;
  if (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1) {
    return { block: matches[0], recordedLine: null, reason: '有効な呼び出し行は未記録です。' };
  }
  return { block: matches[0], recordedLine: line, reason: null };
}

/** Only a complete, resolved code asset can establish that the recorded line exists. */
export function apiLineMatch(site: ApiCallSite, code: string | null, partial = false): { line: number | null; reason: string | null } {
  if (!site.block || site.recordedLine === null) return { line: null, reason: site.reason };
  if (code === null || code === '') return { line: null, reason: '実行されたPythonコードは未記録です。' };
  if (partial) return { line: null, reason: 'Pythonの全文を取得できていないため、呼び出し行は確認できません。' };
  if (site.recordedLine > code.split('\n').length) {
    return { line: null, reason: '記録された呼び出し行がPythonの範囲外です。' };
  }
  return { line: site.recordedLine, reason: null };
}

export interface RecordedApiModel {
  call: LogicalCall | null;
  /** The exact response referenced by the executed block, including its HTTP attempt. */
  response: TraceEvent | null;
  block: TNode | null;
  reason: string | null;
}

/** Do not replace missing source IDs with another model call in the same turn. */
export function recordedModelForApi(model: EpisodeModel, node: TNode): RecordedApiModel {
  const site = node.kind === 'code_block' ? { block: node, reason: null } : apiCallSite(model, node);
  const block = site.block;
  const missing = (reason: string): RecordedApiModel => ({ call: null, response: null, block, reason });
  if (!block) return missing(site.reason ?? '呼び出し元のPythonブロックは未記録です。');
  const data = dataOf(block.primary, 'code_block_start');
  const sourceId = data.source_model_event_id;
  if (typeof sourceId !== 'string' || !sourceId.trim()) {
    return missing(data.code_source === 'oracle' ? 'Oracle由来のコードです。生成元のモデル入出力はありません。' : '生成元の source_model_event_id は未記録です。');
  }
  const response = model.byId.get(sourceId);
  if (!response || response.event_type !== 'model_response') {
    return missing('source_model_event_id に対応するモデルの回答は未記録です。');
  }
  const call = model.callOfEvent.get(response.event_id) ?? null;
  if (!call) return { call: null, response, block, reason: '回答は記録されていますが、生成元のモデル呼び出しとの対応は未記録です。' };
  return { call, response, block, reason: null };
}
