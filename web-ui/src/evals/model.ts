/** Table cells show the last attempt for each task, condition and seed. */
import type { EvalCounts, EvalTrial } from './api';

export interface TrialCell { trial: EvalTrial; retried: boolean }
export interface ComparisonRow {
  key: string;
  task: string | null;
  condition: string | null;
  baseline: Map<number | null, TrialCell>;
  current: Map<number | null, TrialCell>;
}
function later(trial: EvalTrial, previous: EvalTrial): boolean {
  const segment = (value: number | null | undefined) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1000 ? value : 0;
  if (segment(trial.eval_segment) !== segment(previous.eval_segment)) return segment(trial.eval_segment) > segment(previous.eval_segment);
  if (typeof trial.start_wall_time === 'number' && typeof previous.start_wall_time === 'number' && trial.start_wall_time !== previous.start_wall_time) return trial.start_wall_time > previous.start_wall_time;
  if (typeof trial.runner_invocation === 'number' && typeof previous.runner_invocation === 'number' && trial.runner_invocation !== previous.runner_invocation) return trial.runner_invocation > previous.runner_invocation;
  return (trial.attempt ?? 0) >= (previous.attempt ?? 0);
}
/** Pair a known task/seed, preferring its condition and refusing ambiguous alternatives. */
export function baselineTrialFor(trial: Pick<EvalTrial, 'task' | 'seed' | 'condition'>, baselineTrials: EvalTrial[]): EvalTrial | null {
  if (!trial.task || typeof trial.seed !== 'number' || !Number.isInteger(trial.seed)) return null;
  const candidates = baselineTrials.filter(candidate => candidate.task === trial.task && candidate.seed === trial.seed);
  const exact = trial.condition !== null ? candidates.filter(candidate => candidate.condition === trial.condition) : [];
  const matching = exact.length ? exact : new Set(candidates.map(candidate => candidate.condition)).size === 1 ? candidates : [];
  return matching.reduce<EvalTrial | null>((latest, candidate) => !latest || later(candidate, latest) ? candidate : latest, null);
}
export function comparisonTable(current: EvalTrial[], baseline: EvalTrial[]) {
  const all = [...baseline, ...current];
  const showConditions = new Set(all.map(t => t.condition)).size > 1;
  const seeds = [...new Set(all.map(t => t.seed))].sort((a, b) => a === null ? 1 : b === null ? -1 : a - b);
  const rows = new Map<string, ComparisonRow>();
  for (const [side, trials] of [['baseline', baseline], ['current', current]] as const) {
    for (const trial of trials) {
      const key = JSON.stringify([trial.task, showConditions ? trial.condition : null]);
      let row = rows.get(key);
      if (!row) {
        row = { key, task: trial.task, condition: showConditions ? trial.condition : null, baseline: new Map(), current: new Map() };
        rows.set(key, row);
      }
      const previous = row[side].get(trial.seed);
      if (!previous || later(trial, previous.trial)) {
        row[side].set(trial.seed, { trial, retried: !!previous });
      } else previous.retried = true;
    }
  }
  const sorted = [...rows.values()].sort((a, b) => (a.task ?? '').localeCompare(b.task ?? '') || (a.condition ?? '').localeCompare(b.condition ?? ''));
  const regressions = sorted.reduce((n, row) => n + seeds.filter(seed => isRegression(row, seed)).length, 0);
  const currentTrials = sorted.flatMap(row => [...row.current.values()].map(cell => cell.trial));
  const baselineTrials = sorted.flatMap(row => [...row.baseline.values()].map(cell => cell.trial));
  const omittedRetries = current.length + baseline.length - currentTrials.length - baselineTrials.length;
  return { rows: sorted, seeds, showConditions, regressions, currentTrials, baselineTrials, omittedRetries };
}
export function isRegression(row: ComparisonRow, seed: number | null): boolean {
  return row.baseline.get(seed)?.trial.verdict === 'success' && row.current.get(seed)?.trial.verdict === 'failure';
}
export function rate(counts: EvalCounts | null | undefined): string {
  return counts && counts.trials > 0 ? `${Math.round(counts.success / counts.trials * 100)}%` : '—';
}
export function delta(current: EvalCounts | null | undefined, baseline: EvalCounts | null | undefined): string {
  if (!current?.trials || !baseline?.trials) return '';
  const value = Math.round((current.success / current.trials - baseline.success / baseline.trials) * 100);
  return `（${value > 0 ? '+' : ''}${value}pt）`;
}
export function summaryDiffers(summary: EvalCounts | null | undefined, trials: EvalTrial[]): boolean {
  return !!summary && (summary.trials !== trials.length || summary.success !== trials.filter(t => t.verdict === 'success').length);
}
