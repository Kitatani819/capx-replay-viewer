import type { EvalDetail, EvalRecord, EvalTrial } from '../../evals/api';
import type { EndReason } from '../types';
import { END_LABELS } from '../../evals/failureReasons';

export function classifiedTrial(id: string, seed: number, reason: EndReason, extra: Partial<EvalTrial> = {}): EvalTrial {
  return { episode_id: id, task: 'cube', condition: 'C', seed, attempt: 1,
    verdict: reason === 'success' ? 'success' : reason === 'unknown' ? 'unknown' : 'failure',
    end_classification: { reason, label: END_LABELS[reason], evidence: { event_id: `${id}-end` } },
    status: 'ended', trace_complete: true, local_state: 'local', ...extra };
}
export function breakdownDetail(hasBaseline = true): EvalDetail {
  const record: EvalRecord = { schema: 'capx-eval/1', eval_id: 'current', status: 'completed', by: 'demo', changed: '把持位置の修正', baseline_eval_id: hasBaseline ? 'baseline' : null,
    eval_set: 'demo', git: null, started_at: '2026-11-18T09:30:00Z', heartbeat_at: '2026-11-18T09:31:00Z', ended_at: '2026-11-18T09:31:00Z', summary: null };
  return { eval_id: 'current', eval: record, error: null, location: 'local', display_status: null, summary: null, baseline_summary: null,
    baseline: hasBaseline ? { ...record, eval_id: 'baseline', baseline_eval_id: null } : null, baseline_error: null, differences: [],
    trials: [classifiedTrial('c1', 1, 'finish_unmet'), classifiedTrial('c2', 2, 'error'), classifiedTrial('c3', 3, 'error'), classifiedTrial('c4', 4, 'success'), classifiedTrial('c5', 5, 'unknown')],
    baseline_trials: hasBaseline ? [classifiedTrial('b1', 1, 'success'), classifiedTrial('b2', 2, 'timeout'), classifiedTrial('b3', 3, 'error'), classifiedTrial('b4', 4, 'timeout')] : [] };
}
