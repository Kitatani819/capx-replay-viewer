import { siteHref } from '../navigation/site';
import { useMemo, useState } from 'react';
import type { EvalDetail } from './api';
import { comparisonTable, indexBaselineTrials, type ComparisonTable } from './model';
import { baselineBreakdownTrials, breakdownTrials, CATEGORY_LABELS, BREAKDOWN_CATEGORIES, FAILURE_REASONS, causeCounts, causeGroupKey, causeTooltip, reasonCounts, reasonLabel, type BreakdownCategory } from './failureReasons';
import './failureBreakdown.css';

export function FailureBreakdown({ detail, table }: { detail: EvalDetail; table?: ComparisonTable }) {
  const { currentTrials, baselineTrials, omittedRetries } = useMemo(
    () => table ?? comparisonTable(detail.trials, detail.baseline_trials), [table, detail.trials, detail.baseline_trials]);
  const baselineIndex = useMemo(() => indexBaselineTrials(baselineTrials), [baselineTrials]);
  const current = reasonCounts(currentTrials);
  const baseline = reasonCounts(baselineTrials);
  const hasBaseline = !!detail.baseline;
  const [selected, setSelected] = useState<BreakdownCategory>(() => BREAKDOWN_CATEGORIES.find(reason => current[reason] > 0)
    ?? (hasBaseline ? BREAKDOWN_CATEGORIES.find(reason => baseline[reason] > 0) : undefined) ?? 'error');
  const trials = breakdownTrials(currentTrials, baselineIndex, selected);
  const baseTrials = hasBaseline ? baselineBreakdownTrials(baselineTrials, selected) : [];
  const baselineRun = detail.baseline?.eval_id;
  const causes = causeCounts(currentTrials, baselineTrials, selected);
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
      <h3>{CATEGORY_LABELS[selected]}：今回 {trials.length}件{hasBaseline && <>・基準 {baseTrials.length}件</>}</h3>
      {causes.length > 0 && <div className="failure-cause-scroll" tabIndex={0} role="region" aria-label={`${CATEGORY_LABELS[selected]}の原因別比較（横にスクロールできます）`}><table className="failure-cause-table" aria-label={`${CATEGORY_LABELS[selected]}の原因別比較`}>
        <thead><tr><th scope="col">具体的な原因</th>{hasBaseline && <th scope="col">基準</th>}<th scope="col">今回</th>{hasBaseline && <th scope="col">増減</th>}</tr></thead>
        <tbody>{causes.map(cause => <tr key={cause.key}><th scope="row"><details className="failure-cause-trials">
          <summary><span>{cause.label}</span><small>今回 {cause.current}件{hasBaseline && <>・基準 {cause.baseline}件</>}の試行を見る</small></summary>
          {cause.current === 0 ? (!hasBaseline || cause.baseline === 0) && <p>今回の試行はありません。</p> : <ul>{trials.filter(({ trial }) => causeGroupKey(trial) === cause.key).map(({ trial, baseline: paired, tag }) => <li key={trial.episode_id}>
            <span className="failure-trial-name">{trial.task ?? 'タスク未記録'} · seed {trial.seed ?? '—'}{trial.condition && <small>条件 {trial.condition}</small>}</span>
            {hasBaseline && <span className="failure-trial-baseline" title={paired?.end_classification ? causeTooltip(paired.end_classification) || undefined : undefined}>基準：{paired ? reasonLabel(paired) : '記録なし'}</span>}
            <span title={trial.end_classification ? causeTooltip(trial.end_classification) || undefined : undefined}>今回：{reasonLabel(trial)}</span>
            {hasBaseline && <span className={`failure-tag${tag === '悪化' ? ' failure-increase' : tag === '改善' ? ' failure-decrease' : ''}`}>{tag}</span>}
            <a href={siteHref(`/traces?${new URLSearchParams({ run: detail.eval_id, episode: trial.episode_id })}`)}>試行を開く</a>
          </li>)}</ul>}
          {hasBaseline && baselineRun && cause.baseline > 0 && <ul className="failure-baseline-trials" aria-label={`${cause.label}：基準の試行`}>{baseTrials.filter(trial => causeGroupKey(trial) === cause.key).map(trial => <li key={`base-${trial.episode_id}`}>
            <span className="failure-trial-name">{trial.task ?? 'タスク未記録'} · seed {trial.seed ?? '—'}{trial.condition && <small>条件 {trial.condition}</small>}</span>
            <span title={trial.end_classification ? causeTooltip(trial.end_classification) || undefined : undefined}>基準：{reasonLabel(trial)}</span>
            <a href={siteHref(`/traces?${new URLSearchParams({ run: baselineRun, episode: trial.episode_id })}`)}>基準の試行を開く</a>
          </li>)}</ul>}
        </details></th>
          {hasBaseline && <td>{cause.baseline}件</td>}<td>{cause.current}件</td>{hasBaseline && <td>{cause.current > cause.baseline ? '+' : ''}{cause.current - cause.baseline}</td>}</tr>)}</tbody>
      </table></div>}
      {trials.length === 0 && baseTrials.length === 0 && <p>この分類の試行はありません。</p>}
    </div>
    <p className="eval-legend">分類は記録から自動で推測したもので、外れることがあります。</p>
  </section>;
}
