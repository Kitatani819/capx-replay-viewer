import { listOptionValue, matchesPeriod, validDate, type DateFilter, type Period } from '../listFilters';
import type { EvalListEntry, EvalRecord } from './api';

export interface EvalFilters extends DateFilter {
  by: string;
  kind: 'all' | 'a' | 'b';
  task: string;
  status: 'all' | 'completed' | 'running' | 'stopped';
  q: string;
}

export const DEFAULT_EVAL_FILTERS: EvalFilters = {
  period: 'all', from: '', to: '', by: 'all', kind: 'all', task: 'all', status: 'all', q: '',
};
const FILTER_KEYS = Object.keys(DEFAULT_EVAL_FILTERS) as (keyof EvalFilters)[];
function option<T extends string>(value: string | null, values: readonly T[], fallback: T): T {
  return values.includes(value as T) ? value as T : fallback;
}

export function readEvalFilters(search: string): EvalFilters {
  const query = new URLSearchParams(search);
  const period = option<Period>(query.get('period'), ['all', 'today', '3d', '7d', 'custom'], 'all');
  return normalizeEvalFilters({
    period,
    from: query.get('from') ?? '', to: query.get('to') ?? '',
    by: query.get('by') || 'all', task: query.get('task') || 'all', q: query.get('q') ?? '',
    kind: option(query.get('kind'), ['all', 'a', 'b'], 'all'),
    status: option(query.get('status'), ['all', 'completed', 'running', 'stopped'], 'all'),
  });
}

/** Resolve list-dependent URL values only once a listing is available. */
export function normalizeEvalFilters(filters: EvalFilters, entries?: EvalListEntry[]): EvalFilters {
  const result = { ...filters };
  result.from = result.period === 'custom' && validDate(result.from) ? result.from : '';
  result.to = result.period === 'custom' && validDate(result.to) ? result.to : '';
  if (result.from && result.to && result.from > result.to) {
    result.period = 'all'; result.from = ''; result.to = '';
  }
  if (entries) {
    if (!['all', 'mine'].includes(result.by) && !entries.some(entry => entry.eval && listOptionValue(entry.eval.by) === result.by)) result.by = 'all';
    if (result.task !== 'all' && !entries.some(entry => evaluationTasks(entry).some(task => listOptionValue(task) === result.task))) result.task = 'all';
  }
  return result;
}

/** Preserve site and unrelated parameters, omitting defaults from shared links. */
export function evalFilterSearch(search: string, filters: EvalFilters): string {
  const query = new URLSearchParams(search);
  for (const key of FILTER_KEYS) {
    query.delete(key);
    const value = filters[key];
    if (value !== DEFAULT_EVAL_FILTERS[key] && (key !== 'q' || value.trim())) query.set(key, value);
  }
  const value = query.toString();
  return value ? `?${value}` : '';
}

export function evalFiltersActive(filters: EvalFilters): boolean {
  return FILTER_KEYS.some(key => key === 'q' ? !!filters.q.trim() : filters[key] !== DEFAULT_EVAL_FILTERS[key]);
}

/** Same route marker used by the notes below the evaluation title. */
export function isRouteB(record: EvalRecord): boolean { return record.eval_set?.startsWith('routeB:') === true; }
export function evaluationTasks(entry: EvalListEntry): string[] { return (entry.summary ?? entry.eval?.summary)?.tasks ?? []; }
export function evaluationStatus(entry: EvalListEntry): EvalFilters['status'] {
  if (entry.display_status) return entry.display_status === 'running' ? 'running' : 'stopped';
  if (entry.eval?.status === 'running') return 'running';
  return entry.eval?.status === 'completed' ? 'completed' : 'stopped';
}
export function filterEvaluations(entries: EvalListEntry[], filters: EvalFilters, now: number): EvalListEntry[] {
  const q = filters.q.trim().toLocaleLowerCase();
  return entries.filter(entry => {
    const record = entry.eval;
    if (!matchesPeriod(record?.started_at, filters, now)) return false;
    if (filters.by === 'mine' && !(entry.mine ?? entry.location === 'local')) return false;
    if (filters.by !== 'all' && filters.by !== 'mine' && (!record || listOptionValue(record.by) !== filters.by)) return false;
    if (filters.kind !== 'all' && (!record || isRouteB(record) !== (filters.kind === 'b'))) return false;
    if (filters.task !== 'all' && !evaluationTasks(entry).some(task => listOptionValue(task) === filters.task)) return false;
    if (filters.status !== 'all' && (!record || evaluationStatus(entry) !== filters.status)) return false;
    return !q || [record?.changed, record?.eval_set, entry.eval_id, record?.by].some(value => value?.toLocaleLowerCase().includes(q));
  });
}
