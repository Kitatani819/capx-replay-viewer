import type { EndReason } from '../trace/types';
import type { EvalTrial } from './api';
import { baselineTrialFor } from './model';

export const FAILURE_REASONS = ['error', 'timeout', 'finish_unmet', 'regen_limit', 'unknown'] as const;
export type FailureReason = typeof FAILURE_REASONS[number];
export const END_LABELS: Record<EndReason, string> = {
  success: '成功', error: 'エラーで停止', timeout: '時間切れ・打ち切り',
  finish_unmet: 'FINISHだが未達成', regen_limit: '書き直しの上限', unknown: '未判定・記録不足',
};
// A missing classification is unknown; task verdicts are never reclassified in the browser.
export function trialReason(trial: EvalTrial): EndReason { return trial.end_classification?.reason ?? 'unknown'; }
export function reasonLabel(trial: EvalTrial): string { return trial.end_classification?.label || END_LABELS.unknown; }
export function reasonCounts(trials: EvalTrial[]): Record<FailureReason, number> {
  const counts: Record<FailureReason, number> = { error: 0, timeout: 0, finish_unmet: 0, regen_limit: 0, unknown: 0 };
  for (const trial of trials) {
    const reason = trialReason(trial);
    if (reason !== 'success') counts[reason]++;
  }
  return counts;
}
export function changeTag(baseline: EvalTrial | undefined, current: EvalTrial): string {
  if (!baseline) return '比較なし';
  if (baseline.verdict !== 'success' && current.verdict === 'success') return '改善';
  if (baseline.verdict === 'success' && current.verdict === 'failure') return '悪化';
  if (baseline.verdict === 'failure' && current.verdict === 'failure' && trialReason(baseline) !== trialReason(current)) return '別の失敗へ';
  return trialReason(baseline) === trialReason(current) ? '変わらず' : '比較なし';
}
export function breakdownTrials(current: EvalTrial[], baseline: EvalTrial[], reason: FailureReason) {
  return current.filter(trial => trialReason(trial) === reason).map(trial => {
    const paired = baselineTrialFor(trial, baseline) ?? undefined;
    return { trial, baseline: paired, tag: changeTag(paired, trial) };
  });
}
