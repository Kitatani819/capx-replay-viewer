import { remoteName } from '../navigation/site';
import { siteHref } from '../navigation/site';
import { SiteTabs } from '../navigation/SiteTabs';
/** Calm, read-only evaluation list and baseline comparison. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { dateHeading, dateKey, listOptionValue } from '../listFilters';
import { DEFAULT_EVAL_FILTERS, evalFilterSearch, evalFiltersActive, evaluationTasks, filterEvaluations, isRouteB, normalizeEvalFilters, readEvalFilters, type EvalFilters } from './filters';
import { Breadcrumb, evaluationTitle } from '../navigation/Breadcrumb';
import { useAsync, useInterval } from '../trace/hooks';
import { remoteListingText } from '../trace/remoteListing';
import { evalApi, type EvalCounts, type EvalDetail, type EvalDifference, type EvalListEntry, type EvalRecord, type EvaluationFailure } from './api';
import { comparisonTable, delta, isRegression, rate, summaryDiffers, type TrialCell } from './model';
import { FailureBreakdown } from './FailureBreakdown';
import { EvalSegments } from './EvalSegments';
import { evaluationConditions, sharedStepLimit, stepLimitText, stepsText } from './TrialConditions';
import { PairedSignificance } from './PairedSignificance';
import { EvalCodeChanges } from './EvalCodeChanges';
import { CATEGORY_CELL_WORDS, CELL_LEGEND, END_LABELS, UNJUDGED_LABEL, causeTooltip, evidenceValue, reasonLabel, ruleSourceHref, trialCategory, trialCellWord } from './failureReasons';
import './evals.css';

const STATUS = { running: '実行中', interrupted: '中断', incomplete: '欠損あり', failed: '評価失敗' };
function failureReasons(failure: EvaluationFailure): string[] {
  const reasons = failure.infrastructure_failures.map(item => `${item.task ?? '課題未記録'}・seed ${item.seed ?? '未記録'}・${item.reason}`);
  if (reasons.length && failure.count > reasons.length) reasons.push(`ほか ${failure.count - reasons.length}件`);
  return reasons;
}
function failureTooltip(failure: EvaluationFailure | null | undefined): string | undefined {
  return failure ? [failure.reason, ...failureReasons(failure)].join('\n') : undefined;
}
function failureLine(failure: EvaluationFailure, baseline = false): string {
  const subject = baseline ? '基準の評価' : 'この評価';
  const stop = failure.kind === 'infrastructure' ? '準備・実行の失敗で止まりました' : '一部の試行を終えずに止まりました';
  return `${subject}は${stop}：${failureReasons(failure).join(' / ') || failure.reason}`;
}
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
/** Exported evaluation sets identify the route and suite without relying on run names. */
function RouteBNotes({ record }: { record: EvalRecord }) {
  const suite = record.eval_set?.split(':')[1];
  if (!isRouteB(record)) return null;
  return <span className="eval-route-notes"><span>提出の形の評価（経路 B）・成否は審判の判定</span>
    {suite === 'behavior' && <span>シミュレーターは RTX、モデルと記録は B300</span>}</span>;
}
export function EvalListTable({ entries }: { entries: EvalListEntry[] }) {
  const ordered = [...entries].sort((left, right) => {
    const started = (entry: EvalListEntry) => {
      const time = Date.parse(entry.eval?.started_at ?? '');
      return Number.isFinite(time) ? time : -Infinity;
    };
    return started(right) - started(left);
  });
  const groups = new Map<string, EvalListEntry[]>();
  for (const entry of ordered) {
    const key = dateKey(entry.eval?.started_at);
    const rows = groups.get(key) ?? [];
    rows.push(entry); groups.set(key, rows);
  }
  return <div className="eval-table-scroll"><table className="eval-list" aria-label="評価一覧">
    <thead><tr>{['日付', '実行者', '変更した部品', '成功率', 'コミット', '状態'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
    {[...groups].map(([key, rows]) => <tbody key={key}>
      <tr className="eval-date-heading"><th colSpan={6} scope="rowgroup">{dateHeading(rows[0].eval?.started_at)}</th></tr>
      {rows.map((entry, index) => {
      const record = entry.eval;
      if (!record) return <tr key={`${entry.eval_id}-${index}`}><td colSpan={6} className="eval-error">読み取れない評価：{entry.eval_id}<br />{entry.error || '記録が不正です'}</td></tr>;
      const href = siteHref(`/evals/${encodeURIComponent(record.eval_id)}`);
      return <tr key={`${entry.eval_id}-${index}`} onClick={() => { window.location.href = href; }}>
        <td><time dateTime={record.started_at}>{date(record.started_at)}</time></td><td>{record.by || '—'}</td>
        <td><a href={href}>{evaluationTitle(record)}</a>{record.eval_set && <small className="eval-set">{record.eval_set}</small>}<RouteBNotes record={record} />{(record.segments?.length ?? 0) > 1 && <small className="eval-segment-count">{record.segments!.length}回に分けて実行</small>}</td><td className="eval-numbers"><Rate entry={entry} /></td>
        <td><GitCommit git={record.git} /></td>
        <td>{entry.display_status && <span title={failureTooltip(entry.evaluation_failure)} className={entry.evaluation_failure ? 'eval-error' : undefined}>{entry.evaluation_failure?.kind === 'incomplete' ? '未完了' : STATUS[entry.display_status]}</span>}{entry.error && <span className="eval-error">{entry.error}</span>}</td>
      </tr>;
    })}</tbody>)}
  </table></div>;
}
export function EvalListPage() {
  const refreshNext = useRef(false);
  const [urlFilters, setUrlFilters] = useState(() => readEvalFilters(window.location.search));
  const listing = useAsync(s => {
    const refresh = refreshNext.current;
    refreshNext.current = false;
    return evalApi.list(s, refresh);
  }, []);
  useEffect(() => { document.title = '評価一覧 · CaP-X'; }, []);
  useEffect(() => {
    const navigate = () => setUrlFilters(readEvalFilters(window.location.search));
    window.addEventListener('popstate', navigate);
    return () => window.removeEventListener('popstate', navigate);
  }, []);
  useInterval(listing.poll, listing.data?.remote_status?.refreshing ? 2000 : 30_000, true);
  const entries = listing.data?.evals;
  // A cold remote listing can temporarily contain only local records. Keep
  // shared person/task choices until remote discovery has succeeded.
  const remoteStatus = listing.data?.remote_status;
  const filterEntries = listing.data?.error || (remoteStatus && (remoteStatus.refreshing || remoteStatus.error || !remoteStatus.fetched_at)) ? undefined : entries;
  const filters = normalizeEvalFilters(urlFilters, filterEntries);
  useEffect(() => {
    const normalized = normalizeEvalFilters(urlFilters, filterEntries);
    const search = evalFilterSearch(window.location.search, normalized);
    if (search !== window.location.search) window.history.replaceState(null, '', `${window.location.pathname}${search}${window.location.hash}`);
    if (JSON.stringify(normalized) !== JSON.stringify(urlFilters)) setUrlFilters(normalized);
  }, [urlFilters, filterEntries]);
  const changeFilters = (patch: Partial<EvalFilters>) => {
    const next = normalizeEvalFilters({ ...filters, ...patch }, filterEntries);
    const search = evalFilterSearch(window.location.search, next);
    // Typing a keyword or a date replaces the entry, so Back does not step through every keystroke.
    const typed = Object.keys(patch).every(key => key === 'q' || key === 'from' || key === 'to');
    if (search !== window.location.search) window.history[typed ? 'replaceState' : 'pushState'](null, '', `${window.location.pathname}${search}${window.location.hash}`);
    setUrlFilters(next);
  };
  const resetFilters = () => changeFilters(DEFAULT_EVAL_FILTERS);
  const active = evalFiltersActive(filters);
  // All comparisons in this render share one clock reading (including fake clocks).
  const now = Date.now();
  const filtered = filterEvaluations(entries ?? [], filters, now);
  const people = [...new Set(entries?.flatMap(entry => entry.eval?.by ? [entry.eval.by] : []) ?? [])].sort((a, b) => a.localeCompare(b, 'ja'));
  const tasks = [...new Set(entries?.flatMap(evaluationTasks) ?? [])].sort((a, b) => a.localeCompare(b, 'ja'));
  const status = listing.data?.remote_status;
  return <main className="eval-page"><div className="eval-content">
    <Breadcrumb items={[{ label: '評価一覧' }]} />
    <header className="eval-header"><h1>評価一覧</h1><SiteTabs /><a href={siteHref('/traces')}>試行を見る</a></header>
    <p className="eval-intro">基準と改良の結果を比べ、試行の記録を開けます。</p>
    {listing.loading && !listing.data && <p role="status">評価を読み込み中…</p>}
    {listing.error && <p role="alert" className="eval-error">評価を読み込めません：{listing.error}</p>}
    {listing.data?.error && <p role="status" className="eval-note">{listing.data.error}</p>}
    {status && <div className="eval-remote-status"><p role="status">{remoteListingText(status)}</p><button type="button" disabled={listing.loading || status.refreshing} onClick={() => { refreshNext.current = true; listing.reload(); }}>{remoteName()} の一覧を更新</button></div>}
    {listing.data && <>
      {(listing.data.evals.length > 0 || active) && <div className="eval-filters" role="search" aria-label="評価の絞り込み">
        <label>期間<select aria-label="期間" value={filters.period} onChange={event => changeFilters({ period: event.target.value as EvalFilters['period'] })}>
          <option value="all">すべて</option><option value="today">今日</option><option value="3d">過去3日</option><option value="7d">過去7日</option><option value="custom">日付を指定</option>
        </select></label>
        {filters.period === 'custom' && <div className="eval-filter-dates">
          <label>開始日<input aria-label="開始日" type="date" value={filters.from} max={filters.to || undefined} onChange={event => changeFilters({ from: event.target.value })} /></label>
          <span aria-hidden="true">〜</span><label>終了日<input aria-label="終了日" type="date" value={filters.to} min={filters.from || undefined} onChange={event => changeFilters({ to: event.target.value })} /></label>
        </div>}
        <label>実行者<select aria-label="実行者" value={filters.by} onChange={event => changeFilters({ by: event.target.value })}>
          <option value="all">すべて</option><option value="mine">自分</option>{people.map(person => <option key={person} value={listOptionValue(person)}>{person}</option>)}
        </select></label>
        <label>種類<select aria-label="種類" value={filters.kind} onChange={event => changeFilters({ kind: event.target.value as EvalFilters['kind'] })}>
          <option value="all">すべて</option><option value="a">自分たちの評価（経路 A）</option><option value="b">提出の形（経路 B）</option>
        </select></label>
        <label>タスク<select aria-label="タスク" value={filters.task} onChange={event => changeFilters({ task: event.target.value })}>
          <option value="all">すべて</option>{tasks.map(task => <option key={task} value={listOptionValue(task)}>{task}</option>)}
        </select></label>
        <label>状態<select aria-label="状態" value={filters.status} onChange={event => changeFilters({ status: event.target.value as EvalFilters['status'] })}>
          <option value="all">すべて</option><option value="completed">完了</option><option value="running">実行中</option><option value="stopped">途中で終了</option>
        </select></label>
        <label className="eval-filter-keyword">キーワード<input aria-label="キーワード" type="search" value={filters.q} placeholder="変えた部品・組・評価ID・実行者" onChange={event => changeFilters({ q: event.target.value })} /></label>
      </div>}
      <div className="eval-filter-summary"><p role="status">{active ? `${listing.data.evals.length} 件中 ${filtered.length} 件` : `${listing.data.evals.length} 件`}</p>
        {active && <button type="button" onClick={resetFilters}>絞り込みを解除</button>}
      </div>
      {filtered.length ? <EvalListTable entries={filtered} /> : active ? <div className="eval-empty"><p>条件に合う評価はありません</p><button type="button" onClick={resetFilters}>絞り込みを解除</button></div> : <p>評価の記録がありません。</p>}
    </>}
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
  const tooltip = [trial.end_classification && causeTooltip(trial.end_classification), stepsText(trial.end_classification), '試行を開く'].filter(Boolean).join('\n');
  return <td className="eval-cell"><div className="eval-cell-actions"><a href={siteHref(`/traces?${query.toString()}`)} className={`eval-result eval-result-${word.tone}${compact ? ' eval-result-compact' : ''}${regression ? ' eval-regression' : ''}`} title={tooltip} aria-label={`${label}（試行を開く）`}>
    <span aria-hidden="true">{symbol}</span>{regression && <small>悪化</small>}{retried && <small>再試行あり</small>}
  </a>{baselineCell && baselineId && <a className="eval-compare-link" href={siteHref(`/traces/compare?${new URLSearchParams({ run: evalId, episode: trial.episode_id, baseline_run: baselineId, baseline_episode: baselineCell.trial.episode_id })}`)} aria-label={`${trial.task ?? 'タスク未記録'} seed ${trial.seed ?? '—'}を基準と並べて見る`}>並べて見る</a>}</div></td>;
}
export function EvalComparison({ detail }: { detail: EvalDetail }) {
  const { eval: record, baseline } = detail;
  const table = useMemo(() => comparisonTable(detail.trials, detail.baseline_trials), [detail.trials, detail.baseline_trials]);
  if (!record) return <p role="alert" className="eval-error">評価の記録を読み取れません：{detail.error || '記録が不正です'}</p>;
  const mismatch = summaryDiffers(detail.summary, table.currentTrials) || (baseline && summaryDiffers(detail.baseline_summary, table.baselineTrials));
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
    <div className="eval-comparison-heading"><div><h1>{evaluationTitle(record)}</h1><p className="eval-meta">{record.by || '—'} · <time dateTime={record.started_at}>{date(record.started_at)}</time> · <GitCommit git={record.git} />{detail.display_status && <> · <span title={failureTooltip(detail.evaluation_failure)}>{detail.evaluation_failure?.kind === 'incomplete' ? '未完了' : STATUS[detail.display_status]}</span></>}</p><RouteBNotes record={record} /></div>
      <p className="eval-score">{baseline && <>基準 <Counts value={detail.baseline_summary} /> → </>}今回 <Counts value={detail.summary} />{delta(detail.summary, detail.baseline_summary)}</p>
    </div>
    {detail.evaluation_failure && <p role="note" className="eval-note eval-failure-note">{failureLine(detail.evaluation_failure)}</p>}
    {baseline && detail.baseline_evaluation_failure && <p role="note" className="eval-note eval-failure-note">{failureLine(detail.baseline_evaluation_failure, true)}</p>}
    {detail.error && <p role="status" className="eval-note">{detail.error}</p>}
    {detail.remote_error && <p role="status" className="eval-note">{detail.remote_error}</p>}
    {detail.baseline_error && <p className="eval-note">{detail.baseline_error}</p>}
    <EvalSegments record={record} />
    {differences.length > 0 && <div className="eval-note"><p>条件の違い：</p><ul>{differences.map(diff => <li key={diff.key}>{diff.label}（基準 {valueText(diff.baseline)} / 今回 {valueText(diff.current)}）</li>)}</ul></div>}
    {officialNotes.length > 0 && <div role="note" className="eval-note eval-rule-note"><p>公式の評価と条件が違います：</p>{renderOfficialNotes(officialNotes.slice(0, 3))}
      {officialNotes.length > 3 && <details><summary>ほかの違い</summary>{renderOfficialNotes(officialNotes.slice(3))}</details>}</div>}
    <PairedSignificance detail={detail} table={table} />
    <div className="eval-table-heading"><p>タスク・seed ごとの結果</p>{baseline && <p>悪化 {table.regressions}件</p>}</div>
    <EvalConditions detail={detail} />
    {table.rows.length > 0 ? <div className="eval-table-scroll"><table className="eval-comparison" aria-label="評価の比較">
      <thead><tr><th scope="col">タスク{table.showConditions ? '・条件' : ''}</th><th scope="col">評価</th>{table.seeds.map(seed => <th key={String(seed)} scope="col">seed {seed ?? '—'}</th>)}</tr></thead>
      <tbody>{table.rows.map(row => <ComparisonRows key={row.key} row={row} seeds={table.seeds} record={record} baseline={baseline} showConditions={table.showConditions} />)}</tbody>
    </table></div> : <p className="eval-empty">試行の記録はまだありません。</p>}
    <p className="eval-legend">{table.seeds.length > MAX_SEEDS_FOR_WORDS
      ? `○ ${END_LABELS.success}　× 失敗　– ${CATEGORY_CELL_WORDS.unjudged}＝${UNJUDGED_LABEL}　… ${CATEGORY_CELL_WORDS.running}　空欄＝記録なし（seed が多いため記号で表示しています）`
      : WORD_LEGEND}</p>
    {mismatch && <p role="status" className="eval-note">eval.json の集計と試行の表の数が異なります。{remoteName()} の一覧には runner の記録が含まれないため、取り込み後に判定が変わる場合があります。</p>}
    <EvalCodeChanges record={record} />
    <FailureBreakdown detail={detail} table={table} />
  </>;
}
/** Conditions every trial of an evaluation shares, shown once instead of in every cell. */
function EvalConditions({ detail }: { detail: EvalDetail }) {
  const current = evaluationConditions(detail.trials.map(t => t.end_classification));
  const base = detail.baseline ? evaluationConditions(detail.baseline_trials.map(t => t.end_classification)) : [];
  if (!current.length && !base.length) return null;
  const line = (label: string, parts: string[]) => <p>{label}：{parts.length ? parts.map(part => <span key={part}>{part}</span>) : <span>記録なし</span>}</p>;
  return <div className="eval-conditions">{detail.baseline && base.join() !== current.join()
    ? <>{line('基準の評価条件', base)}{line('今回の評価条件', current)}</>
    : line('評価条件', current.length ? current : base)}</div>;
}
type ComparisonRow = ReturnType<typeof comparisonTable>['rows'][number];
function rowStepLimit(row: ComparisonRow, hasBaseline: boolean): string | null {
  const limit = (cells: ComparisonRow['current']) => sharedStepLimit([...cells.values()].map(cell => cell.trial.end_classification));
  return stepLimitText(hasBaseline ? limit(row.baseline) : null, limit(row.current));
}
function ComparisonRows({ row, seeds, record, baseline, showConditions }: {
  row: ComparisonRow; seeds: (number | null)[]; record: EvalRecord; baseline: EvalRecord | null; showConditions: boolean;
}) {
  const stepLimit = rowStepLimit(row, !!baseline);
  const heading = <>{row.task || '未記録'}{showConditions && <small>{row.condition || '未記録'}</small>}{stepLimit && <small>{stepLimit}</small>}</>;
  return <>{baseline && <tr className="eval-task-start"><th scope="rowgroup" rowSpan={2}>{heading}</th><th scope="row">基準</th>{seeds.map(seed => <Cell key={String(seed)} cell={row.baseline.get(seed)} evalId={baseline.eval_id} regression={false} compact={seeds.length > MAX_SEEDS_FOR_WORDS} />)}</tr>}
    <tr className={baseline ? '' : 'eval-task-start'}>{!baseline && <th scope="row">{heading}</th>}<th scope="row">今回</th>{seeds.map(seed => <Cell key={String(seed)} cell={row.current.get(seed)} evalId={record.eval_id} regression={isRegression(row, seed)} baselineCell={row.baseline.get(seed)} baselineId={baseline?.eval_id} compact={seeds.length > MAX_SEEDS_FOR_WORDS} />)}</tr></>;
}
export function EvalDetailPage({ evalId }: { evalId: string }) {
  const refreshNext = useRef(false);
  const detail = useAsync(s => {
    const refresh = refreshNext.current;
    refreshNext.current = false;
    return evalApi.detail(evalId, s, refresh);
  }, [evalId]);
  useEffect(() => { document.title = '評価の比較 · CaP-X'; }, []);
  const status = detail.data?.remote_status;
  useInterval(detail.poll, status?.refreshing ? 2000 : 30_000, status?.refreshing === true || detail.data?.eval?.status === 'running' || detail.data?.baseline?.status === 'running');
  return <main className="eval-page"><div className="eval-content">
    <div className="site-page-navigation"><Breadcrumb items={[{ label: '評価一覧', href: '/evals' }, { label: detail.data?.eval ? evaluationTitle(detail.data.eval) : evalId }]} /><SiteTabs /></div>
    {detail.loading && !detail.data && <p role="status">評価を読み込み中…</p>}
    {detail.error && <p role="alert" className="eval-error">評価を読み込めません：{detail.error}</p>}
    {status && <div className="eval-remote-status"><p role="status">{remoteListingText(status)}</p><button type="button" disabled={detail.loading || status.refreshing} onClick={() => { refreshNext.current = true; detail.reload(); }}>{remoteName()} の一覧を更新</button></div>}
    {detail.data?.loading_remote ? <p role="status">{remoteName()} の評価を取得中…</p> : detail.data && <EvalComparison detail={detail.data} />}
  </div></main>;
}
