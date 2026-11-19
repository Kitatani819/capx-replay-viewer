import type { EndClassification } from '../trace/types';

/** Effective, recorded conditions; missing historical values stay absent. */
export function TrialConditions({ ending }: { ending?: EndClassification | null }) {
  const c = ending?.conditions;
  if (!c || !Object.keys(c).length) return null;
  const seconds = (value: number) => Math.round(value).toLocaleString('ja-JP');
  return <span className="trial-conditions">
    {c.step_limit != null && <span>ステップ {c.steps_used != null ? `${c.steps_used.toLocaleString('ja-JP')} / ` : '上限 '}{c.step_limit.toLocaleString('ja-JP')}</span>}
    {c.evaluation_budget_s != null && <span>評価全体の時間 {c.evaluation_elapsed_s != null ? `${seconds(c.evaluation_elapsed_s)} / ` : '上限 '}{seconds(c.evaluation_budget_s)} 秒</span>}
    {c.success_policy && <span>成功判定：{c.success_policy === 'per_cycle_sticky' ? '制御サイクルごとに判定・一度でも成功なら達成' : 'コードの実行終了時'}</span>}
  </span>;
}
