import { useState } from 'react';
import type { EvalDetail } from './api';
import { comparisonTable } from './model';
import { breakdownTrials, CATEGORY_LABELS, BREAKDOWN_CATEGORIES, FAILURE_REASONS, reasonCounts, reasonLabel, type BreakdownCategory } from './failureReasons';
import './failureBreakdown.css';

export function FailureBreakdown({ detail }: { detail: EvalDetail }) {
  const { currentTrials, baselineTrials, omittedRetries } = comparisonTable(detail.trials, detail.baseline_trials);
  const current = reasonCounts(currentTrials);
  const baseline = reasonCounts(baselineTrials);
  const [selected, setSelected] = useState<BreakdownCategory>(() => BREAKDOWN_CATEGORIES.find(reason => current[reason] > 0) ?? 'error');
  const hasBaseline = !!detail.baseline;
  const trials = breakdownTrials(currentTrials, baselineTrials, selected);
  const max = Math.max(1, ...Object.values(current), ...(hasBaseline ? Object.values(baseline) : []));
  const total = (counts: typeof current) => FAILURE_REASONS.reduce((sum, reason) => sum + counts[reason], 0);
  return <section className="failure-breakdown" aria-labelledby="failure-breakdown-title">
    <h2 id="failure-breakdown-title">失敗の内訳</h2>
    <div className="failure-counts">
      <div className={`failure-count-heading${hasBaseline ? '' : ' failure-current-only'}`} aria-hidden="true"><span>失敗の終わり方</span>{hasBaseline && <span>基準</span>}<span>今回</span>{hasBaseline && <span>増減</span>}</div>
      {BREAKDOWN_CATEGORIES.map(reason => {
        const change = current[reason] - baseline[reason];
        return <button key={reason} type="button" className={`failure-count-row${hasBaseline ? '' : ' failure-current-only'}`} aria-pressed={selected === reason}
          aria-label={`${CATEGORY_LABELS[reason]}：${hasBaseline ? `基準 ${baseline[reason]}件、` : ''}今回 ${current[reason]}件`}
          onClick={() => setSelected(reason)}>
          <span>{CATEGORY_LABELS[reason]}</span>
          {hasBaseline && <span className="failure-bar-count"><span className="failure-bar failure-bar-baseline" style={{ width: `${baseline[reason] / max * 100}%` }} aria-hidden="true" /><span className="failure-number">{baseline[reason]}件</span></span>}
          <span className="failure-bar-count"><span className="failure-bar failure-bar-current" style={{ width: `${current[reason] / max * 100}%` }} aria-hidden="true" /><span className="failure-number">{current[reason]}件</span></span>
          {hasBaseline && <span className={`failure-delta ${change < 0 ? 'failure-decrease' : change > 0 ? 'failure-increase' : ''}`}>{change > 0 ? '+' : change === 0 ? '±' : ''}{change}</span>}
        </button>;
      })}
      <p className="failure-total">失敗 {total(current)}件{hasBaseline && <>（基準 {total(baseline)}件）</>}・未判定 {current.unjudged}件{hasBaseline && <>（基準 {baseline.unjudged}件）</>}</p>
    </div>
    {omittedRetries > 0 && <p className="eval-note">再試行 {omittedRetries}件は最後の試行だけを数えています</p>}
    <div className="failure-trials" aria-live="polite">
      <h3>{CATEGORY_LABELS[selected]}：今回 {trials.length}件</h3>
      {trials.length === 0 ? <p>この分類の試行はありません。</p> : <ul>{trials.map(({ trial, baseline: paired, tag }) => <li key={trial.episode_id}>
        <span className="failure-trial-name">{trial.task ?? 'タスク未記録'} · seed {trial.seed ?? '—'}{trial.condition && <small>条件 {trial.condition}</small>}</span>
        {hasBaseline && <span className="failure-trial-baseline">基準：{paired ? reasonLabel(paired) : '記録なし'}</span>}
        <span>今回：{reasonLabel(trial)}</span>
        {hasBaseline && <span className={`failure-tag${tag === '悪化' ? ' failure-increase' : tag === '改善' ? ' failure-decrease' : ''}`}>{tag}</span>}
        <a href={`/traces?${new URLSearchParams({ run: detail.eval_id, episode: trial.episode_id })}`}>試行を開く</a>
      </li>)}</ul>}
    </div>
    <p className="eval-legend">分類は記録から自動で推測したもので、外れることがあります。</p>
  </section>;
}
