import type { EndClassification } from '../trace/types';

type Conditions = NonNullable<EndClassification['conditions']>;
const number = (value: number) => Math.round(value).toLocaleString('ja-JP');
const SUCCESS_POLICY_TEXT: Record<NonNullable<Conditions['success_policy']>, string> = {
  per_cycle_sticky: '制御サイクルごとに判定・一度でも成功なら達成',
  block_end: 'コードの実行終了時',
};

/** Effective, recorded conditions; missing historical values stay absent. */
export function TrialConditions({ ending }: { ending?: EndClassification | null }) {
  const c = ending?.conditions;
  if (!c || !Object.keys(c).length) return null;
  const steps = stepsText(ending);
  return <span className="trial-conditions">
    {c.step_limit != null ? <span>ステップ {c.steps_used != null ? `${number(c.steps_used)} / ` : '上限 '}{number(c.step_limit)}</span>
      : steps && <span>{steps}</span>}
    {c.evaluation_budget_s != null && <span>評価全体の時間 {c.evaluation_elapsed_s != null ? `${number(c.evaluation_elapsed_s)} / ` : '上限 '}{number(c.evaluation_budget_s)} 秒</span>}
    {c.success_policy && <span>成功判定：{SUCCESS_POLICY_TEXT[c.success_policy]}</span>}
  </span>;
}

/** Steps this trial used, for the result cell's tooltip. */
export function stepsText(ending?: EndClassification | null): string | null {
  const c = ending?.conditions;
  if (c?.steps_used == null || (c.step_limit == null && ending?.evidence.source !== '審判（gateway）')) return null;
  return `ステップ ${number(c.steps_used)}${c.step_limit != null ? ` / ${number(c.step_limit)}` : ''}`;
}

/** The step limit every given trial shares, or null when unrecorded or mixed. */
export function sharedStepLimit(endings: (EndClassification | null | undefined)[]): number | null {
  const limits = new Set(endings.map(e => e?.conditions?.step_limit).filter((v): v is number => v != null));
  return limits.size === 1 ? [...limits][0] : null;
}

export function stepLimitText(baseline: number | null, current: number | null): string | null {
  if (baseline != null && current != null && baseline !== current) return `ステップ上限 基準 ${number(baseline)} / 今回 ${number(current)}`;
  const limit = current ?? baseline;
  return limit == null ? null : `ステップ上限 ${number(limit)}`;
}

/**
 * One line for a whole evaluation: the time budget and scoring every trial
 * shares, with the most time any recorded trial had used.
 */
export function evaluationConditions(endings: (EndClassification | null | undefined)[]): string[] {
  const all = endings.map(e => e?.conditions).filter((c): c is Conditions => !!c);
  const budgets = new Set(all.map(c => c.evaluation_budget_s).filter((v): v is number => v != null));
  const policies = new Set(all.map(c => c.success_policy).filter((v): v is NonNullable<Conditions['success_policy']> => !!v));
  const parts: string[] = [];
  if (budgets.size === 1) {
    const used = all.map(c => c.evaluation_elapsed_s).filter((v): v is number => v != null);
    parts.push(`評価全体の時間 ${used.length ? `${number(Math.max(...used))} / ` : '上限 '}${number([...budgets][0])} 秒`);
  }
  if (policies.size === 1) parts.push(`成功判定：${SUCCESS_POLICY_TEXT[[...policies][0]]}`);
  return parts;
}
