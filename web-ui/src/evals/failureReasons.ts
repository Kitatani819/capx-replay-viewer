import type { EndCauseCode, EndClassification, EndReason } from '../trace/types';
import type { EvalTrial } from './api';
import { baselineTrialFor } from './model';

export const FAILURE_REASONS = ['error', 'timeout', 'finish_unmet', 'submission_reset', 'regen_limit', 'single_shot', 'unknown'] as const;
export type FailureReason = typeof FAILURE_REASONS[number];
export const END_LABELS: Record<EndReason, string> = {
  success: '成功', error: 'エラーで停止', timeout: '時間切れ・打ち切り',
  finish_unmet: '「終わった」と答えたが未達成', regen_limit: '書き直しの上限', unknown: '終わり方が不明',
  single_shot: '1回だけ実行して終了（single-shot）',
  submission_reset: '提出物が試行を終えた（未達成）',
};
// Mirrored from end_reason.py; a Python test checks both label maps.
export const END_CELL_WORDS: Record<EndReason, string> = {
  success: '成功', error: 'エラー', timeout: '時間切れ',
  finish_unmet: '未達成', regen_limit: '上限', unknown: '不明',
  single_shot: '1回実行',
  submission_reset: '終了',
};
// Labels only: end_reason.py is the sole cause classifier, including for old traces.
export const END_CAUSE_LABELS: Record<EndCauseCode, string> = {
  success: '成功', step_limit: 'ステップ上限に到達', env_horizon: '環境のステップ期限に到達', trial_time_limit: '1試行の時間制限を超過',
  code_time_limit: 'コード実行の時間切れ', turn_limit: 'ターンの上限に到達', regeneration_limit: '書き直しの上限に到達',
  finish_unmet: '「終わった」と答えたが未達成', parser_finish: '終了と解釈されたが未達成', execution_error: 'エラーで停止', simulator_crash: 'シミュレーターの異常終了',
  slurm_time_limit: '評価ジョブが時間制限で打ち切られた', manual_stop: '手動で停止', replaced: '別の試行に置き換え',
  recording_incomplete: '記録が途中で終わった', unknown: '終了原因を特定できない',
  evaluation_budget: '評価全体の時間制限に到達',
  planned_unrun: '計画された試行が実行されなかった',
  single_shot: '1回だけ実行して終了（single-shot）',
  submission_reset: '提出物が試行を終えた（未達成）',
  job_cut: '評価ジョブの終了で打ち切り',
};
// Canonical cell vocabulary mirrored from end_reason.py; parity is tested.
export const END_CAUSE_WORDS: Record<EndCauseCode, readonly [string, string]> = {
  success: ["成功", "課題を達成"],
  step_limit: ["ステップ上限", "ロボットを動かすステップ数の上限に到達"],
  trial_time_limit: ["試行時間", "1試行の時間制限を超過"],
  code_time_limit: ["実行時間", "1回のコード実行の時間制限を超過"],
  turn_limit: ["ターン上限", "コードを実行する回数の上限に到達"],
  regeneration_limit: ["書き直し上限", "コードを書き直す回数の上限に到達"],
  finish_unmet: ["未達成", "モデルが「終わった」と答えたが課題は未達成"],
  execution_error: ["エラー", "エラーで停止"],
  simulator_crash: ["環境異常", "シミュレーターの異常終了"],
  slurm_time_limit: ["ジョブ時間", "評価ジョブ全体の時間制限に到達"],
  manual_stop: ["手動停止", "手動で停止"],
  replaced: ["置き換え", "別の試行に置き換えて終了"],
  recording_incomplete: ["記録中断", "試行の終了または成否を記録できなかった"],
  unknown: ["不明", "終了原因を特定する記録が足りない"],
  parser_finish: ["終了扱い", "続行の指示がなく終了と扱われたが課題は未達成"],
  env_horizon: ["環境期限", "シミュレーター自身のステップ数の期限に到達"],
  evaluation_budget: ["評価時間", "評価全体の時間制限に到達"],
  planned_unrun: ["未走行", "計画されたが実行されず、失敗として集計した試行"],
  single_shot: ["1回実行", "初回のプログラムを実行し、書き直しの判断をせず終了"],
  submission_reset: ["終了", "審判が成功と判定する前に提出物が試行を終えた"],
  job_cut: ["打ち切り", "試行の途中で評価ジョブが終了し、公式集計では終了した試行に数えない"],
};
export const END_CAUSE_CELL_WORDS = Object.fromEntries(
  Object.entries(END_CAUSE_WORDS).map(([code, [word]]) => [code, word]),
) as Record<EndCauseCode, string>;
export type TrialCategory = EndReason | 'unjudged' | 'running';
export const UNJUDGED_LABEL = '成否が記録から分からない';
export const CATEGORY_CELL_WORDS: Record<TrialCategory, string> = { ...END_CELL_WORDS, unjudged: '未判定', running: '実行中' };
export const CATEGORY_LABELS: Record<TrialCategory, string> = {
  ...END_LABELS, unjudged: `${CATEGORY_CELL_WORDS.unjudged}（${UNJUDGED_LABEL}）`, running: CATEGORY_CELL_WORDS.running,
};
export const BREAKDOWN_CATEGORIES = [...FAILURE_REASONS, 'unjudged'] as const;
export type BreakdownCategory = typeof BREAKDOWN_CATEGORIES[number];

/** Every word the cells can render, including compatibility with older servers. */
export const CELL_LEGEND: Record<string, string> = {
  ...Object.fromEntries(Object.entries(END_CELL_WORDS).map(([reason, word]) => [word, END_LABELS[reason as EndReason]])),
  ...Object.fromEntries(Object.values(END_CAUSE_WORDS)),
  [CATEGORY_CELL_WORDS.unjudged]: UNJUDGED_LABEL,
  [CATEGORY_CELL_WORDS.running]: '試行を実行中',
};

/** Verdict takes priority over ending evidence in both the table and breakdown. */
export function trialCategory(trial: EvalTrial): TrialCategory {
  if (trial.verdict === 'running') return 'running';
  if (trial.verdict === 'unknown') return 'unjudged';
  if (trial.verdict === 'success') return 'success';
  const reason = trial.end_classification?.reason ?? 'unknown';
  return reason === 'success' ? 'unknown' : reason;
}
export function causeLabel(ending: EndClassification): string {
  return ending.cause ? END_CAUSE_LABELS[ending.cause.code] ?? ending.cause.label : END_LABELS[ending.reason];
}
/** Display recorded values without treating a public/default limit as a local setting. */
export function causeHeadline(ending: EndClassification): string {
  const cause = ending.cause;
  if (!cause) return END_LABELS[ending.reason];
  if (cause.headline) return cause.headline;
  const { code, limit, used } = cause;
  if (ending.reason === 'regen_limit' && limit == null && used != null) return `書き直し ${evidenceValue(used)} 回で終了（上限の設定は記録なし）`;
  if (code === 'trial_time_limit' && limit != null) return `1試行の時間制限（${evidenceValue(limit)} 秒）を超過`;
  if (['step_limit', 'env_horizon'].includes(code)) {
    const count = used != null && limit != null ? `${evidenceValue(used)}/${evidenceValue(limit)} ステップ`
      : used != null ? `${evidenceValue(used)} ステップ、上限は記録なし`
      : limit != null ? `上限 ${evidenceValue(limit)} ステップ` : '上限・ステップ数は記録なし';
    return `${causeLabel(ending)}（${count}）`;
  }
  if (limit != null) {
    const unit = ['code_time_limit', 'slurm_time_limit', 'evaluation_budget'].includes(code) ? ' 秒' : ' 回';
    return `${causeLabel(ending)}（上限 ${evidenceValue(limit)}${unit}）`;
  }
  return causeLabel(ending);
}
export function evidenceValue(value: unknown): string {
  if (value === undefined || value === null) return '未記録';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
export function causeEvidence(ending: EndClassification): string {
  return Object.entries(ending.cause?.evidence ?? {}).map(([field, value]) => `${field} = ${evidenceValue(value)}`).join('、');
}
export function causeTooltip(ending: EndClassification): string {
  if (!ending.cause) return '';
  return [...new Set([causeHeadline(ending), ending.cause?.explanation].filter(Boolean))].join('\n');
}
/** Link only recognized public competition paths, never a recorded filesystem path. */
export function ruleSourceHref(source: string): string | undefined {
  if (/^https:\/\/github\.com\/matsuolab\/geniac_prize_2026_code\/blob\/[\da-f]{7,40}\/[\w./-]+(?:#L\d+)?$/.test(source)) return source;
  const match = /^(PRELIM_RULEBOOK\.md|(?:capx|taskpacks|env_configs|scripts|docs)\/[\w./-]+)(?::(\d+)(?:,\d+)*|:[A-Za-z_]\w*)?$/.exec(source);
  return match ? `https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/${match[1]}${match[2] ? `#L${match[2]}` : ''}` : undefined;
}
export function reasonLabel(trial: EvalTrial): string {
  const category = trialCategory(trial);
  if (category === 'success' || category === 'running' || !trial.end_classification?.cause) return CATEGORY_LABELS[category];
  const ending = trial.end_classification;
  const cause = trial.end_classification.cause;
  const label = ending.reason === 'regen_limit' && cause.limit == null && cause.used != null
    ? causeHeadline(ending) : causeLabel(ending);
  return category === 'unjudged' ? `${CATEGORY_LABELS.unjudged}・${label}` : label;
}
export function trialCellWord(trial: EvalTrial): string {
  const category = trialCategory(trial);
  const cause = trial.end_classification?.cause;
  if (category === 'success' || category === 'running' || !cause) return CATEGORY_CELL_WORDS[category];
  // The task verdict can be missing while the reason recording stopped is known.
  if (category === 'unjudged' && (cause.code === 'unknown' || cause.code === 'success')) return CATEGORY_CELL_WORDS.unjudged;
  return END_CAUSE_CELL_WORDS[cause.code] ?? CATEGORY_CELL_WORDS[category];
}
/** Group server-classified causes within a coarse category, including differing limits. */
export function causeGroupKey(trial: EvalTrial): string {
  const cause = trial.end_classification?.cause;
  if (!cause) return 'legacy';
  const observedRewrites = trial.end_classification?.reason === 'regen_limit' && cause.limit == null && cause.used != null;
  return `${cause.code}:${JSON.stringify(cause.limit ?? null)}${observedRewrites ? `:used=${evidenceValue(cause.used)}` : ''}`;
}
export function causeCounts(current: EvalTrial[], baseline: EvalTrial[], category: BreakdownCategory) {
  const rows = new Map<string, { key: string; label: string; current: number; baseline: number; tooltip: string; missingEvidence: string[] }>();
  for (const [side, trials] of [['current', current], ['baseline', baseline]] as const) {
    for (const trial of trials) {
      if (trialCategory(trial) !== category) continue;
      const ending = trial.end_classification;
      const cause = ending?.cause;
      const key = causeGroupKey(trial);
      const limitCause = cause && ['step_limit', 'env_horizon', 'trial_time_limit', 'code_time_limit', 'turn_limit', 'regeneration_limit', 'slurm_time_limit'].includes(cause.code);
      const row = rows.get(key) ?? { key,
        label: ending && cause ? ending.reason === 'regen_limit' && cause.limit == null && cause.used != null
          ? causeHeadline(ending) : cause.code === 'trial_time_limit' ? causeHeadline(ending)
          : `${causeLabel(ending)}${cause.limit != null ? `（上限 ${evidenceValue(cause.limit)}）` : limitCause ? '（上限未記録）' : ''}` : '詳細な原因の記録なし',
        current: 0, baseline: 0, tooltip: '', missingEvidence: [] };
      const tooltip = ending ? causeTooltip(ending) : '';
      if (tooltip && !row.tooltip.includes(tooltip)) row.tooltip += `${row.tooltip ? '\n\n' : ''}${tooltip}`;
      row.missingEvidence = [...new Set([...row.missingEvidence, ...(cause?.missing_evidence ?? [])])];
      row[side]++;
      rows.set(key, row);
    }
  }
  return [...rows.values()].sort((a, b) => a.key.localeCompare(b.key));
}
export function reasonCounts(trials: EvalTrial[]): Record<BreakdownCategory, number> {
  const counts: Record<BreakdownCategory, number> = { error: 0, timeout: 0, finish_unmet: 0, submission_reset: 0, regen_limit: 0, single_shot: 0, unknown: 0, unjudged: 0 };
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
  if (baseline.verdict === 'failure' && current.verdict === 'failure' && (previous !== next ||
    baseline.end_classification?.cause && current.end_classification?.cause &&
    baseline.end_classification.cause.code !== current.end_classification.cause.code)) return '別の失敗へ';
  return previous === next ? '変わらず' : '比較なし';
}
/** Baseline trials in a category, so they can be opened even when this run has none. */
export function baselineBreakdownTrials(baseline: EvalTrial[], category: BreakdownCategory) {
  return baseline.filter(trial => trialCategory(trial) === category);
}

export function breakdownTrials(current: EvalTrial[], baseline: EvalTrial[], category: BreakdownCategory) {
  return current.filter(trial => trialCategory(trial) === category).map(trial => {
    const paired = baselineTrialFor(trial, baseline) ?? undefined;
    return { trial, baseline: paired, tag: changeTag(paired, trial) };
  });
}
