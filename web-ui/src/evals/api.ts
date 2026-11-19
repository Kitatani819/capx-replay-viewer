/** Evaluation records are validated by /api/evals before being displayed. */
import { getJson } from '../trace/api';
import type { TaskVerdict } from '../trace/outcome';
import type { EndClassification } from '../trace/types';

export interface EvalCounts { trials: number; success: number }
export interface EvalSummary extends EvalCounts {
  by_task?: Record<string, EvalCounts>;
  failure: number;
  unknown: number;
  incomplete: number;
  tasks: string[];
  seeds: number[];
  models: Record<string, string>;
  config_flags: Record<string, unknown>;
  mixed: string[];
}
export interface EvalRecord {
  schema: 'capx-eval/1';
  eval_id: string;
  status: 'running' | 'completed' | 'interrupted';
  by: string;
  changed: string;
  baseline_eval_id: string | null;
  eval_set: string | null;
  git: { commit: string; dirty: boolean | null; diff_sha256?: string | null } | null;
  started_at: string;
  heartbeat_at: string;
  ended_at: string | null;
  summary: EvalSummary | null;
}
export interface EvalListEntry {
  eval_id: string;
  eval: EvalRecord | null;
  error: string | null;
  location: 'local' | 'gmo' | 'both';
  display_status: 'running' | 'interrupted' | 'incomplete' | null;
  summary: EvalSummary | null;
  baseline_summary: EvalCounts | null;
}
export interface EvalTrial {
  episode_id: string;
  task: string | null;
  condition: string | null;
  seed: number | null;
  attempt: number | null;
  runner_invocation?: number | null;
  start_wall_time?: number | null;
  verdict: TaskVerdict;
  end_classification?: EndClassification | null;
  status: string;
  trace_complete: boolean | null;
  local_state: 'remote' | 'local' | 'stale' | 'fetching';
}
export interface EvalDifference { field: string; baseline: unknown; current: unknown }
export interface EvalDetail extends EvalListEntry {
  baseline: EvalRecord | null;
  baseline_error: string | null;
  trials: EvalTrial[];
  baseline_trials: EvalTrial[];
  differences: EvalDifference[];
  remote_error?: string | null;
  repeat_references?: { side: 'current' | 'baseline'; eval: EvalRecord; trials: EvalTrial[] }[];
}
export interface EvalList { evals: EvalListEntry[]; error?: string | null }
export const evalApi = {
  list: (signal?: AbortSignal): Promise<EvalList> => getJson('/api/evals', signal),
  detail: (id: string, signal?: AbortSignal): Promise<EvalDetail> => getJson(`/api/evals/${encodeURIComponent(id)}`, signal),
};
