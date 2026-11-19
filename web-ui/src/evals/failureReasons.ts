import type { EndReason } from '../trace/types';
import type { EvalTrial } from './api';
import { baselineTrialFor } from './model';

export const FAILURE_REASONS = ['error', 'timeout', 'finish_unmet', 'regen_limit', 'unknown'] as const;
export type FailureReason = typeof FAILURE_REASONS[number];
export const END_LABELS: Record<EndReason, string> = {
  success: '成功', error: 'エラーで停止', timeout: '時間切れ・打ち切り',
  finish_unmet: '「終わった」と答えたが未達成', regen_limit: '書き直しの上限', unknown: '終わり方が不明',
};
// Mirrored from end_reason.py; a Python test checks both label maps.
export const END_CELL_WORDS: Record<EndReason, string> = {
  success: '成功', error: 'エラー', timeout: '時間切れ',
  finish_unmet: '未達成', regen_limit: '上限', unknown: '不明',
};
export type TrialCategory = EndReason | 'unjudged' | 'running';
export const UNJUDGED_LABEL = '成否が記録から分からない';
export const CATEGORY_CELL_WORDS: Record<TrialCategory, string> = { ...END_CELL_WORDS, unjudged: '未判定', running: '実行中' };
export const CATEGORY_LABELS: Record<TrialCategory, string> = {
  ...END_LABELS, unjudged: `${CATEGORY_CELL_WORDS.unjudged}（${UNJUDGED_LABEL}）`, running: CATEGORY_CELL_WORDS.running,
};
export const BREAKDOWN_CATEGORIES = [...FAILURE_REASONS, 'unjudged'] as const;
export type BreakdownCategory = typeof BREAKDOWN_CATEGORIES[number];

/** Verdict takes priority over ending evidence in both the table and breakdown. */
export function trialCategory(trial: EvalTrial): TrialCategory {
  if (trial.verdict === 'running') return 'running';
  if (trial.verdict === 'unknown') return 'unjudged';
  if (trial.verdict === 'success') return 'success';
  const reason = trial.end_classification?.reason ?? 'unknown';
  return reason === 'success' ? 'unknown' : reason;
}
export function reasonLabel(trial: EvalTrial): string { return CATEGORY_LABELS[trialCategory(trial)]; }
export function reasonCounts(trials: EvalTrial[]): Record<BreakdownCategory, number> {
  const counts: Record<BreakdownCategory, number> = { error: 0, timeout: 0, finish_unmet: 0, regen_limit: 0, unknown: 0, unjudged: 0 };
  for (const trial of trials) {
    const category = trialCategory(trial);
    if (category !== 'success' && category !== 'running') counts[category]++;
  }
  return counts;
}
export function changeTag(baseline: EvalTrial | undefined, current: EvalTrial): string {
  if (!baseline) return '比較なし';
  const previous = trialCategory(baseline), next = trialCategory(current);
  if (previous !== 'success' && next === 'success') return '改善';
  if (previous === 'success' && current.verdict === 'failure') return '悪化';
  if (baseline.verdict === 'failure' && current.verdict === 'failure' && previous !== next) return '別の失敗へ';
  return previous === next ? '変わらず' : '比較なし';
}
export function breakdownTrials(current: EvalTrial[], baseline: EvalTrial[], category: BreakdownCategory) {
  return current.filter(trial => trialCategory(trial) === category).map(trial => {
    const paired = baselineTrialFor(trial, baseline) ?? undefined;
    return { trial, baseline: paired, tag: changeTag(paired, trial) };
  });
}
