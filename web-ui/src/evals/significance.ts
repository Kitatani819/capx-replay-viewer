/** Exact two-sided sign test (the exact McNemar test on discordant pairs). */
import type { EvalTrial } from './api';
import { comparisonTable } from './model';

export interface PairedResult {
  paired: number;
  improved: number;
  worsened: number;
  bothSuccess: number;
  bothFailure: number;
  unmatched: number;
  unjudged: number;
  unidentified: number;
  omittedRetries: number;
  p: number | null;
}

/** Stable even when 2 ** -n underflows; sum the smaller binomial tail in log space. */
export function exactDiscordanceP(improved: number, worsened: number): number {
  if (![improved, worsened].every(n => Number.isSafeInteger(n) && n >= 0)) throw new RangeError('Counts must be nonnegative integers');
  const n = improved + worsened;
  const k = Math.min(improved, worsened);
  if (n === 0 || k * 2 === n) return 1;
  let logMass = -n * Math.LN2;
  for (let i = 1; i <= k; i++) logMass += Math.log(n - i + 1) - Math.log(i);
  let relativeMass = 1, relativeTail = 1;
  for (let i = k; i > 0; i--) {
    relativeMass *= i / (n - i + 1);
    relativeTail += relativeMass;
  }
  return Math.min(1, Math.exp(logMass + Math.log(relativeTail) + Math.LN2));
}
function identified(trial: EvalTrial): boolean {
  return !!trial.task && !!trial.condition && typeof trial.seed === 'number' && Number.isSafeInteger(trial.seed);
}
export function pairedResult(current: EvalTrial[], baseline: EvalTrial[]): PairedResult {
  const knownCurrent = current.filter(identified), knownBaseline = baseline.filter(identified);
  const table = comparisonTable(knownCurrent, knownBaseline);
  const result: PairedResult = { paired: 0, improved: 0, worsened: 0, bothSuccess: 0, bothFailure: 0,
    unmatched: 0, unjudged: 0, unidentified: current.length + baseline.length - knownCurrent.length - knownBaseline.length,
    omittedRetries: table.omittedRetries, p: null };
  for (const row of table.rows) {
    for (const seed of new Set([...row.current.keys(), ...row.baseline.keys()])) {
      const now = row.current.get(seed)?.trial, before = row.baseline.get(seed)?.trial;
      if (!now || !before) { result.unmatched++; continue; }
      if (!['success', 'failure'].includes(now.verdict) || !['success', 'failure'].includes(before.verdict)) { result.unjudged++; continue; }
      result.paired++;
      if (now.verdict === before.verdict) result[now.verdict === 'success' ? 'bothSuccess' : 'bothFailure']++;
      else result[now.verdict === 'success' ? 'improved' : 'worsened']++;
    }
  }
  if (result.paired > 0) result.p = exactDiscordanceP(result.improved, result.worsened);
  return result;
}
export function significanceLabel(result: PairedResult, provisional = false): string {
  if (!result.paired) return 'まだ比べられません';
  if (provisional) return '実行中のため、結論は保留';
  if (result.p !== null && result.p <= .05) return result.improved > result.worsened ? 'はっきり改善' : 'はっきり悪化';
  return 'ぶれの範囲内か、試行数が足りません';
}
export function pText(p: number): string { return p < .0001 ? '0.0001未満' : p.toFixed(4); }
