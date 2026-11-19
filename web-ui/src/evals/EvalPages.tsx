/** Calm, read-only evaluation list and baseline comparison. */
import { useEffect } from 'react';
import { Breadcrumb, evaluationTitle } from '../navigation/Breadcrumb';
import { useAsync, useInterval } from '../trace/hooks';
import { evalApi, type EvalCounts, type EvalDetail, type EvalDifference, type EvalListEntry, type EvalRecord } from './api';
import { comparisonTable, delta, isRegression, rate, summaryDiffers, type TrialCell } from './model';
import { FailureBreakdown } from './FailureBreakdown';
import { TrialConditions } from './TrialConditions';
import { CATEGORY_CELL_WORDS, CELL_LEGEND, END_LABELS, UNJUDGED_LABEL, causeTooltip, evidenceValue, reasonLabel, ruleSourceHref, trialCategory, trialCellWord } from './failureReasons';
import './evals.css';

const STATUS = { running: '実行中', interrupted: '中断', incomplete: '欠損あり' };
const FIELDS: Record<string, string> = { tasks: 'タスク', seeds: 'seed', models: 'モデル', config_flags: '設定', eval_set: '評価セット' };
function date(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}
function valueText(value: unknown): string {
  if (value === null || value === undefined) return '未記録';
  if (Array.isArray(value)) return value.map(valueText).join('、') || 'なし';
  if (typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key}: ${valueText(item)}`).join('、') || 'なし';
  return String(value);
}
function equalValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => equalValue(value, right[index]));
  if (left && right && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
    const entries = Object.entries(left);
    return entries.length === Object.keys(right).length && entries.every(([key, value]) => Object.hasOwn(right, key) && equalValue(value, (right as Record<string, unknown>)[key]));
  }
  return false;
}
function differenceItems(diff: EvalDifference) {
  if (diff.field !== 'models' && diff.field !== 'config_flags') return [{ ...diff, key: diff.field, label: FIELDS[diff.field] || diff.field }];
  const baseline = (diff.baseline || {}) as Record<string, unknown>;
  const current = (diff.current || {}) as Record<string, unknown>;
  return [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort()
    .map(key => ({ key: `${diff.field}.${key}`, label: key,
      baseline: Object.hasOwn(baseline, key) ? baseline[key] : undefined,
      current: Object.hasOwn(current, key) ? current[key] : undefined }))
    .filter(item => !equalValue(item.baseline, item.current));
}
function Counts({ value }: { value: EvalCounts | null }) { return <>{value ? `${value.success}/${value.trials}` : '—'}</>; }
function GitCommit({ git }: { git: EvalRecord['git'] }) {
  return git ? <span title={git.dirty === null ? '未コミットの変更の有無は不明' : undefined}>{git.commit.slice(0, 7)}{git.dirty ? '＋未コミット' : ''}</span> : <>—</>;
}
function Rate({ entry }: { entry: EvalListEntry }) {
  return <>{entry.baseline_summary && <>基準 {rate(entry.baseline_summary)} → </>}{rate(entry.summary)}{delta(entry.summary, entry.baseline_summary)}</>;
}
export function EvalListTable({ entries }: { entries: EvalListEntry[] }) {
  return <div className="eval-table-scroll"><table className="eval-list" aria-label="評価一覧">
    <thead><tr>{['日付', '実行者', '変更した部品', '成功率', 'コミット', '状態'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
    <tbody>{entries.map((entry, index) => {
      const record = entry.eval;
      if (!record) return <tr key={`${entry.eval_id}-${index}`}><td colSpan={6} className="eval-error">読み取れない評価：{entry.eval_id}<br />{entry.error || '記録が不正です'}</td></tr>;
      const href = `/evals/${encodeURIComponent(record.eval_id)}`;
      return <tr key={`${entry.eval_id}-${index}`} onClick={() => { window.location.href = href; }}>
        <td><time dateTime={record.started_at}>{date(record.started_at)}</time></td><td>{record.by || '—'}</td>
        <td><a href={href}>{evaluationTitle(record)}</a></td><td className="eval-numbers"><Rate entry={entry} /></td>
        <td><GitCommit git={record.git} /></td>
        <td>{entry.display_status ? STATUS[entry.display_status] : ''}{entry.error && <span className="eval-error">{entry.error}</span>}</td>
      </tr>;
    })}</tbody>
  </table></div>;
}
export function EvalListPage() {
  const listing = useAsync(s => evalApi.list(s), []);
  useEffect(() => { document.title = '評価一覧 · CaP-X'; }, []);
  useInterval(listing.poll, 30_000, true);
  return <main className="eval-page"><div className="eval-content">
    <Breadcrumb items={[{ label: '評価一覧' }]} />
    <header className="eval-header"><h1>評価一覧</h1><a href="/traces">試行を見る</a></header>
    <p className="eval-intro">基準と改良の結果を比べ、試行の記録を開けます。</p>
    {listing.loading && !listing.data && <p role="status">評価を読み込み中…</p>}
    {listing.error && <p role="alert" className="eval-error">評価を読み込めません：{listing.error}</p>}
    {listing.data?.error && <p role="status" className="eval-note">{listing.data.error}</p>}
    {listing.data && (listing.data.evals.length ? <EvalListTable entries={listing.data.evals} /> : <p>評価の記録がありません。</p>)}
  </div></main>;
}
const WORD_LEGEND = `${Object.entries(CELL_LEGEND).map(([word, explanation]) => word === explanation ? word : `${word}＝${explanation}`).join('　')}　空欄＝記録なし`;
// Beyond this many seeds the words no longer fit, so the table falls back to symbols.
const MAX_SEEDS_FOR_WORDS = 20;
function cellWord(trial: TrialCell['trial']): { text: string; tone: string } {
  const category = trialCategory(trial);
  return { text: trialCellWord(trial), tone: category === 'unjudged' ? 'unknown' : category === 'success' || category === 'running' ? category : 'failure' };
}
function Cell({ cell, evalId, regression, baselineCell, baselineId, compact }: { cell: TrialCell | undefined; evalId: string; regression: boolean; baselineCell?: TrialCell; baselineId?: string; compact: boolean }) {
  if (!cell) return <td className="eval-cell" aria-label="記録なし" />;
  const { trial, retried } = cell;
  const word = cellWord(trial);
  const symbol = compact ? { success: '○', failure: '×', unknown: '–', running: '…' }[trial.verdict] : word.text;
  const label = `${trial.verdict === 'failure' ? `失敗（${reasonLabel(trial)}）` : reasonLabel(trial)}${regression ? '・悪化（基準は成功）' : ''}${retried ? '・再試行あり' : ''}`;
  const query = new URLSearchParams({ run: evalId, episode: trial.episode_id });
  const tooltip = trial.end_classification && causeTooltip(trial.end_classification);
  return <td className="eval-cell"><div className="eval-cell-actions"><a href={`/traces?${query.toString()}`} className={`eval-result eval-result-${word.tone}${compact ? ' eval-result-compact' : ''}${regression ? ' eval-regression' : ''}`} title={tooltip ? `${tooltip}\n試行を開く` : '試行を開く'} aria-label={`${label}（試行を開く）`}>
    <span aria-hidden="true">{symbol}</span>{regression && <small>悪化</small>}{retried && <small>再試行あり</small>}
  </a><TrialConditions ending={trial.end_classification} />{baselineCell && baselineId && <a className="eval-compare-link" href={`/traces/compare?${new URLSearchParams({ run: evalId, episode: trial.episode_id, baseline_run: baselineId, baseline_episode: baselineCell.trial.episode_id })}`} aria-label={`${trial.task ?? 'タスク未記録'} seed ${trial.seed ?? '—'}を基準と並べて見る`}>並べて見る</a>}</div></td>;
}
export function EvalComparison({ detail }: { detail: EvalDetail }) {
  const { eval: record, baseline } = detail;
  if (!record) return <p role="alert" className="eval-error">評価の記録を読み取れません：{detail.error || '記録が不正です'}</p>;
  const table = comparisonTable(detail.trials, detail.baseline_trials);
  const mismatch = summaryDiffers(detail.summary, detail.trials) || (baseline && summaryDiffers(detail.baseline_summary, detail.baseline_trials));
  const differences = detail.differences.flatMap(differenceItems);
  const ruleDifferences = new Map<string, { text: string; source: string; sides: string[] }>();
  for (const [side, trials] of [['今回', detail.trials], ['基準', detail.baseline_trials]] as const) {
    for (const trial of trials) for (const diff of trial.end_classification?.rule_differences ?? []) {
      const explanation = diff.explanation ?? (
        ['step_limit', 'trial_steplimit'].includes(diff.field)
          ? `ステップ上限は ${evidenceValue(diff.recorded)} で、公式の上限は ${evidenceValue(diff.official)} です。`
          : ['trial_time_limit_s', 'per_trial_timeout_s'].includes(diff.field)
            ? `1試行を ${evidenceValue(diff.recorded)} 秒で打ち切りますが、公式には1試行ごとの時間制限はありません。`
            : null);
      if (!explanation || !ruleSourceHref(diff.source)) continue;
      const key = `${explanation}:${diff.source}`;
      const note = ruleDifferences.get(key) ?? { text: explanation, source: diff.source, sides: [] };
      if (!note.sides.includes(side)) note.sides.push(side);
      ruleDifferences.set(key, note);
    }
  }
  const officialNotes = [...ruleDifferences];
  const renderOfficialNotes = (notes: typeof officialNotes) => <ul>{notes.map(([key, diff]) => <li key={key}>{diff.sides.join('・')}：{diff.text} <a href={ruleSourceHref(diff.source)} target="_blank" rel="noreferrer">公開ルール</a></li>)}</ul>;
  return <>
    <div className="eval-comparison-heading"><div><h1>{evaluationTitle(record)}</h1><p className="eval-meta">{record.by || '—'} · <time dateTime={record.started_at}>{date(record.started_at)}</time> · <GitCommit git={record.git} />{detail.display_status && <> · {STATUS[detail.display_status]}</>}</p></div>
      <p className="eval-score">{baseline && <>基準 <Counts value={detail.baseline_summary} /> → </>}今回 <Counts value={detail.summary} />{delta(detail.summary, detail.baseline_summary)}</p>
    </div>
    {detail.error && <p role="status" className="eval-note">{detail.error}</p>}
    {detail.remote_error && <p role="status" className="eval-note">{detail.remote_error}</p>}
    {detail.baseline_error && <p className="eval-note">{detail.baseline_error}</p>}
    {differences.length > 0 && <div className="eval-note"><p>条件の違い：</p><ul>{differences.map(diff => <li key={diff.key}>{diff.label}（基準 {valueText(diff.baseline)} / 今回 {valueText(diff.current)}）</li>)}</ul></div>}
    {officialNotes.length > 0 && <div role="note" className="eval-note eval-rule-note"><p>公式の評価と条件が違います：</p>{renderOfficialNotes(officialNotes.slice(0, 3))}
      {officialNotes.length > 3 && <details><summary>ほかの違い</summary>{renderOfficialNotes(officialNotes.slice(3))}</details>}</div>}
    <div className="eval-table-heading"><p>タスク・seed ごとの結果</p>{baseline && <p>悪化 {table.regressions}件</p>}</div>
    {table.rows.length > 0 ? <div className="eval-table-scroll"><table className="eval-comparison" aria-label="評価の比較">
      <thead><tr><th scope="col">タスク{table.showConditions ? '・条件' : ''}</th><th scope="col">評価</th>{table.seeds.map(seed => <th key={String(seed)} scope="col">seed {seed ?? '—'}</th>)}</tr></thead>
      <tbody>{table.rows.map(row => <ComparisonRows key={row.key} row={row} seeds={table.seeds} record={record} baseline={baseline} showConditions={table.showConditions} />)}</tbody>
    </table></div> : <p className="eval-empty">試行の記録はまだありません。</p>}
    <p className="eval-legend">{table.seeds.length > MAX_SEEDS_FOR_WORDS
      ? `○ ${END_LABELS.success}　× 失敗　– ${CATEGORY_CELL_WORDS.unjudged}＝${UNJUDGED_LABEL}　… ${CATEGORY_CELL_WORDS.running}　空欄＝記録なし（seed が多いため記号で表示しています）`
      : WORD_LEGEND}</p>
    {mismatch && <p role="status" className="eval-note">eval.json の集計と試行の表の数が異なります。GMO の一覧には runner の記録が含まれないため、取り込み後に判定が変わる場合があります。</p>}
    <FailureBreakdown detail={detail} />
  </>;
}
function ComparisonRows({ row, seeds, record, baseline, showConditions }: {
  row: ReturnType<typeof comparisonTable>['rows'][number]; seeds: (number | null)[]; record: EvalRecord; baseline: EvalRecord | null; showConditions: boolean;
}) {
  return <>{baseline && <tr className="eval-task-start"><th scope="rowgroup" rowSpan={2}>{row.task || '未記録'}{showConditions && <small>{row.condition || '未記録'}</small>}</th><th scope="row">基準</th>{seeds.map(seed => <Cell key={String(seed)} cell={row.baseline.get(seed)} evalId={baseline.eval_id} regression={false} compact={seeds.length > MAX_SEEDS_FOR_WORDS} />)}</tr>}
    <tr className={baseline ? '' : 'eval-task-start'}>{!baseline && <th scope="row">{row.task || '未記録'}{showConditions && <small>{row.condition || '未記録'}</small>}</th>}<th scope="row">今回</th>{seeds.map(seed => <Cell key={String(seed)} cell={row.current.get(seed)} evalId={record.eval_id} regression={isRegression(row, seed)} baselineCell={row.baseline.get(seed)} baselineId={baseline?.eval_id} compact={seeds.length > MAX_SEEDS_FOR_WORDS} />)}</tr></>;
}
export function EvalDetailPage({ evalId }: { evalId: string }) {
  const detail = useAsync(s => evalApi.detail(evalId, s), [evalId]);
  useEffect(() => { document.title = '評価の比較 · CaP-X'; }, []);
  useInterval(detail.poll, 30_000, detail.data?.eval?.status === 'running');
  return <main className="eval-page"><div className="eval-content">
    <Breadcrumb items={[{ label: '評価一覧', href: '/evals' }, { label: detail.data?.eval ? evaluationTitle(detail.data.eval) : evalId }]} />
    {detail.loading && !detail.data && <p role="status">評価を読み込み中…</p>}
    {detail.error && <p role="alert" className="eval-error">評価を読み込めません：{detail.error}</p>}
    {detail.data && <EvalComparison detail={detail.data} />}
  </div></main>;
}
