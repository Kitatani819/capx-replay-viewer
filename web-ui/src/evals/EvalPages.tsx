/** Calm, read-only evaluation list and baseline comparison. */
import { useEffect } from 'react';
import { useAsync, useInterval } from '../trace/hooks';
import { VERDICT_LABELS } from '../trace/outcome';
import { evalApi, type EvalCounts, type EvalDetail, type EvalListEntry, type EvalRecord } from './api';
import { comparisonTable, delta, isRegression, rate, summaryDiffers, type TrialCell } from './model';
import './evals.css';

const STATUS = { running: '実行中', interrupted: '中断', incomplete: '欠損あり' };
const FIELDS: Record<string, string> = { tasks: 'タスク', seeds: 'seed', models: 'モデル', config_flags: '設定', eval_set: '評価セット' };
function date(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}
function title(record: EvalRecord): string { return record.baseline_eval_id ? record.changed : `${record.changed || '評価'}（基準）`; }
function valueText(value: unknown): string {
  if (value === null || value === undefined) return '未記録';
  if (Array.isArray(value)) return value.map(valueText).join('、') || 'なし';
  if (typeof value === 'object') return Object.entries(value).map(([key, item]) => `${key}: ${valueText(item)}`).join('、') || 'なし';
  return String(value);
}
function Counts({ value }: { value: EvalCounts | null }) { return <>{value ? `${value.success}/${value.trials}` : '—'}</>; }
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
        <td><a href={href}>{title(record)}</a></td><td className="eval-numbers"><Rate entry={entry} /></td>
        <td>{record.git ? <>{record.git.commit.slice(0, 7)}{record.git.dirty ? '＋未コミット' : ''}</> : '—'}</td>
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
    <header className="eval-header"><h1>評価一覧</h1><a href="/traces">試行を見る</a></header>
    <p className="eval-intro">基準と改良の結果を比べ、試行の記録を開けます。</p>
    {listing.loading && !listing.data && <p role="status">評価を読み込み中…</p>}
    {listing.error && <p role="alert" className="eval-error">評価を読み込めません：{listing.error}</p>}
    {listing.data?.error && <p role="status" className="eval-note">{listing.data.error}</p>}
    {listing.data && (listing.data.evals.length ? <EvalListTable entries={listing.data.evals} /> : <p>評価の記録がありません。</p>)}
  </div></main>;
}
function Cell({ cell, evalId, regression }: { cell: TrialCell | undefined; evalId: string; regression: boolean }) {
  if (!cell) return <td className="eval-cell" aria-label="記録なし" />;
  const { trial, retried } = cell;
  const symbol = { success: '●', failure: '×', unknown: '–', running: '…' }[trial.verdict];
  const label = `${VERDICT_LABELS[trial.verdict]}${regression ? '・悪化（基準は成功）' : ''}${retried ? '・再試行あり' : ''}`;
  const query = new URLSearchParams({ run: evalId, episode: trial.episode_id });
  return <td className="eval-cell"><a href={`/traces?${query.toString()}`} className={`eval-result${regression ? ' eval-regression' : ''}`} title={label} aria-label={label}>
    <span aria-hidden="true">{symbol}</span>{regression && <small>悪化</small>}{retried && <small>再試行あり</small>}
  </a></td>;
}
export function EvalComparison({ detail }: { detail: EvalDetail }) {
  const { eval: record, baseline } = detail;
  if (!record) return <p role="alert" className="eval-error">評価の記録を読み取れません：{detail.error || '記録が不正です'}</p>;
  const table = comparisonTable(detail.trials, detail.baseline_trials);
  const mismatch = summaryDiffers(detail.summary, detail.trials) || (baseline && summaryDiffers(detail.baseline_summary, detail.baseline_trials));
  return <>
    <div className="eval-comparison-heading"><div><h1>{title(record)}</h1><p className="eval-meta">{record.by || '—'} · <time dateTime={record.started_at}>{date(record.started_at)}</time>{detail.display_status && <> · {STATUS[detail.display_status]}</>}</p></div>
      <p className="eval-score">{baseline && <>基準 <Counts value={detail.baseline_summary} /> → </>}今回 <Counts value={detail.summary} />{delta(detail.summary, detail.baseline_summary)}</p>
    </div>
    {detail.error && <p role="status" className="eval-note">{detail.error}</p>}
    {detail.remote_error && <p role="status" className="eval-note">{detail.remote_error}</p>}
    {detail.baseline_error && <p className="eval-note">{detail.baseline_error}</p>}
    {detail.differences.length > 0 && <div className="eval-note"><p>条件の違い：</p><ul>{detail.differences.map(diff => <li key={diff.field}>{FIELDS[diff.field] || diff.field}（基準 {valueText(diff.baseline)} / 今回 {valueText(diff.current)}）</li>)}</ul></div>}
    <div className="eval-table-heading"><p>タスク・seed ごとの結果</p>{baseline && <p>悪化 {table.regressions}件</p>}</div>
    {table.rows.length > 0 ? <div className="eval-table-scroll"><table className="eval-comparison" aria-label="評価の比較">
      <thead><tr><th scope="col">タスク{table.showConditions ? '・条件' : ''}</th><th scope="col">評価</th>{table.seeds.map(seed => <th key={String(seed)} scope="col">seed {seed ?? '—'}</th>)}</tr></thead>
      <tbody>{table.rows.map(row => <ComparisonRows key={row.key} row={row} seeds={table.seeds} record={record} baseline={baseline} showConditions={table.showConditions} />)}</tbody>
    </table></div> : <p className="eval-empty">試行の記録はまだありません。</p>}
    <p className="eval-legend">● 成功　× 失敗　– 未判定　… 実行中　空欄 記録なし</p>
    {mismatch && <p role="status" className="eval-note">eval.json の集計と試行の表の数が異なります。GMO の一覧には runner の記録が含まれないため、取り込み後に判定が変わる場合があります。</p>}
  </>;
}
function ComparisonRows({ row, seeds, record, baseline, showConditions }: {
  row: ReturnType<typeof comparisonTable>['rows'][number]; seeds: (number | null)[]; record: EvalRecord; baseline: EvalRecord | null; showConditions: boolean;
}) {
  return <>{baseline && <tr className="eval-task-start"><th scope="rowgroup" rowSpan={2}>{row.task || '未記録'}{showConditions && <small>{row.condition || '未記録'}</small>}</th><th scope="row">基準</th>{seeds.map(seed => <Cell key={String(seed)} cell={row.baseline.get(seed)} evalId={baseline.eval_id} regression={false} />)}</tr>}
    <tr className={baseline ? '' : 'eval-task-start'}>{!baseline && <th scope="row">{row.task || '未記録'}{showConditions && <small>{row.condition || '未記録'}</small>}</th>}<th scope="row">今回</th>{seeds.map(seed => <Cell key={String(seed)} cell={row.current.get(seed)} evalId={record.eval_id} regression={isRegression(row, seed)} />)}</tr></>;
}
export function EvalDetailPage({ evalId }: { evalId: string }) {
  const detail = useAsync(s => evalApi.detail(evalId, s), [evalId]);
  useEffect(() => { document.title = '評価の比較 · CaP-X'; }, []);
  useInterval(detail.poll, 30_000, detail.data?.eval?.status === 'running');
  return <main className="eval-page"><div className="eval-content"><nav className="eval-back"><a href="/evals">← 評価一覧</a></nav>
    {detail.loading && !detail.data && <p role="status">評価を読み込み中…</p>}
    {detail.error && <p role="alert" className="eval-error">評価を読み込めません：{detail.error}</p>}
    {detail.data && <EvalComparison detail={detail.data} />}
  </div></main>;
}
