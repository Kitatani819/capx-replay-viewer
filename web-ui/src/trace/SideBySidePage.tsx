import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, episodeFileUrl, fetchJsonFile, traceApi, type EpisodeRef } from './api';
import { TaskOutcomeBadge } from './components/TaskOutcomeBadge';
import { ValueView } from './components/ValueView';
import { applyDataAssets, pendingAsset } from './dataAsset';
import { fmtDuration } from './format';
import { useAsync, useDataAssets, useEpisodeEvents, useFullText, useInterval, useUrlParams } from './hooks';
import { useMissingEpisodeImport } from './importEpisode';
import { buildEpisodeModel, type EpisodeModel } from './model';
import { episodeVerdict } from './outcome';
import { recordedTurns } from './replay';
import { alignComparisonCalls, comparisonCalls, comparisonTurnLabel, firstDifferenceDetails, trialEventUrl,
  modelArgumentSummary, type ComparisonCall } from './sideBySide';
import { dataOf, type EpisodeSummary, type RunnerRecord, type TextValue } from './types';
import './replay.css';
import './sideBySide.css';

export interface TrialComparisonData {
  ref: EpisodeRef;
  summary: EpisodeSummary;
  model: EpisodeModel;
  records: RunnerRecord[];
  requestArguments?: ReadonlyMap<string, string>;
}

function durationOf(trial: TrialComparisonData): number | null {
  const duration = dataOf(trial.model.episodeEnd, 'episode_end').duration_s;
  if (typeof duration === 'number' && Number.isFinite(duration)) return duration;
  const start = trial.summary.start_wall_time, end = trial.summary.end_wall_time;
  return typeof start === 'number' && typeof end === 'number' && end >= start ? end - start : null;
}
function TrialHeading({ trial, label }: { trial: TrialComparisonData; label: string }) {
  const turns = recordedTurns(trial.model);
  const duration = durationOf(trial);
  return <div className="comparison-trial-heading">
    <strong>{label}</strong><TaskOutcomeBadge verdict={episodeVerdict(trial.summary, trial.records)} />
    {turns.length > 0 && <span>{turns.length}ターン</span>}
    {duration !== null && <span>{fmtDuration(duration)}</span>}
    <a href={trialEventUrl(trial.ref.runId, trial.ref.episodeId)}>試行を開く</a>
  </div>;
}
const KIND_LABELS = { model: 'モデル', api: 'API', service: 'サービス', decision: '判断', code: 'コード' };
function callSummary(call: ComparisonCall | null, side: string) {
  if (!call) return <span className="comparison-gap" aria-label={`${side}に対応する呼び出しなし`}>
    <span className="comparison-side-label">{side}</span>対応する呼び出しなし
  </span>;
  return <span className="comparison-call">
    <span className="comparison-side-label">{side}</span>
    <span className={`comparison-kind comparison-kind-${call.kind}`}>{KIND_LABELS[call.kind]}</span>
    <strong className="comparison-call-name">{call.name}</strong>
    <span className="comparison-call-arguments">{call.kind === 'decision' ? call.resultSummary : call.argumentSummary}</span>
    <span className="comparison-call-status">{call.status}</span>
  </span>;
}
function RecordedComparisonText({ trial, value }: { trial: TrialComparisonData; value: TextValue }) {
  const full = useFullText(trial.ref, value);
  return <><pre>{full.text || '未記録'}</pre>{full.partial && <p>{full.loading ? '全文を読み込み中…' : `全文は未取得です${full.error ? `：${full.error}` : ''}`}</p>}</>;
}
function detailValue(trial: TrialComparisonData, call: ComparisonCall, raw: unknown, fallback: string) {
  if (raw === undefined || raw === null || typeof raw === 'string') return <pre>{typeof raw === 'string' ? raw : fallback || '未記録'}</pre>;
  if (typeof raw === 'object' && !Array.isArray(raw) && !('type' in raw) && !('shape' in raw)
      && ['text', 'preview', 'head', 'asset', 'path', '$asset'].some(key => key in raw)) {
    return <RecordedComparisonText trial={trial} value={raw as TextValue} />;
  }
  if (call.kind === 'model' || call.kind === 'code') return <pre>{fallback || '未記録'}</pre>;
  return <div className="comparison-call-value"><ValueView value={raw} ep={trial.ref} /></div>;
}
function callDetails(trial: TrialComparisonData, call: ComparisonCall | null, side: string) {
  if (!call) return <div className="comparison-gap">{side}：対応する呼び出しなし</div>;
  return <div className="comparison-call-details">
    <a href={trialEventUrl(trial.ref.runId, trial.ref.episodeId, call.eventId)} aria-label={`${side} ${call.name} のログを見る`}>{side}の詳細ログを開く</a>
    <dl><dt>引数</dt><dd>{detailValue(trial, call, call.argumentsValue, call.arguments)}</dd>
      <dt>返った内容</dt><dd>{detailValue(trial, call, call.resultValue, call.returned)}</dd></dl>
  </div>;
}

export function SideBySideComparison({ baseline, current }: { baseline: TrialComparisonData; current: TrialComparisonData }) {
  const [onlyDifferent, setOnlyDifferent] = useState(false);
  const [includeModelText, setIncludeModelText] = useState(false);
  const [expandedRows, setExpandedRows] = useState<ReadonlySet<string>>(() => new Set());
  const rows = useMemo(() => alignComparisonCalls(comparisonCalls(baseline.model, baseline.requestArguments), comparisonCalls(current.model, current.requestArguments)),
    [baseline.model, baseline.requestArguments, current.model, current.requestArguments]);
  const firstDifference = rows.find(row => row.firstDifference);
  const isDifferent = (row: typeof rows[number]) => row.different || (includeModelText && row.modelTextDifferent);
  const visibleRows = rows.map((row, index) => ({ row, index })).filter(({ row }) => !onlyDifferent || isDifferent(row));
  const hasModelTextDifferences = rows.some(row => row.modelTextDifferent);
  return <>
    <div className="comparison-toolbar">
      <h1>同じseedで比べる {current.summary.task && <code>{current.summary.task}</code>}
        {typeof current.summary.seed === 'number' && <span> · seed {current.summary.seed}</span>}</h1>
      <div className="comparison-switches">
        <button type="button" role="switch" aria-checked={onlyDifferent} onClick={() => setOnlyDifferent(value => !value)}>
          <span className="comparison-switch-track" aria-hidden="true"><span /></span>違う行だけ表示
        </button>
        <button type="button" role="switch" aria-checked={includeModelText} onClick={() => setIncludeModelText(value => !value)}>
          <span className="comparison-switch-track" aria-hidden="true"><span /></span>モデルの文章の違いも表示
        </button>
      </div>
    </div>
    {firstDifference ? <div className="comparison-first-banner" role="status">
      <strong>{comparisonTurnLabel(firstDifference.turn)}の {firstDifference.current?.name ?? firstDifference.baseline?.name} から違います</strong>
      <p>{firstDifferenceDetails(firstDifference)}</p>
    </div> : <p className="comparison-note" role="status">{rows.length
      ? hasModelTextDifferences ? 'API の呼び出しと判断は同じです（モデルの文章だけが違います）' : 'API の呼び出しと判断は同じです'
      : '比較できる呼び出しが記録されていません。'}</p>}
    <div className="comparison-headings"><TrialHeading trial={baseline} label="基準" /><TrialHeading trial={current} label="今回" /></div>
    <div className="comparison-rows" aria-label="ターンごとの呼び出しの比較">
      {visibleRows.map(({ row, index }) => {
        const key = `${row.baseline?.eventId ?? '-'}:${row.current?.eventId ?? '-'}`;
        const expanded = expandedRows.has(key);
        const detailsId = `comparison-details-${encodeURIComponent(key)}`;
        const different = isDifferent(row);
        return <section key={key}
          className={`comparison-row${different ? ' comparison-different' : ''}${row.firstDifference ? ' comparison-first' : ''}`}
          data-first-difference={row.firstDifference || undefined}>
          <div className="comparison-row-label"><span>{comparisonTurnLabel(row.turn)} · {index + 1}</span>
            <span className="comparison-mark">{different ? '違い' : '同じ'}</span>
            {row.firstDifference && <strong className="comparison-first-mark">ここから違う</strong>}</div>
          <button type="button" className="comparison-row-toggle" aria-expanded={expanded} aria-controls={detailsId}
            onClick={() => setExpandedRows(previous => {
              const next = new Set(previous);
              if (next.has(key)) next.delete(key); else next.add(key);
              return next;
            })}>
            {callSummary(row.baseline, '基準')}{callSummary(row.current, '今回')}
            <span className="comparison-expand-icon" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
          </button>
          <div className="comparison-row-details" id={detailsId} hidden={!expanded}>
            {expanded && <>{callDetails(baseline, row.baseline, '基準')}{callDetails(current, row.current, '今回')}</>}
          </div>
        </section>;
      })}
    </div>
    {onlyDifferent && visibleRows.length === 0 && rows.length > 0 && <p className="comparison-note">違う行はありません。</p>}
    <p className="comparison-note">同じターン内の種類と呼び出し名で対応付けています。API・サービスは引数と結果の短い要約・状態、モデルは名前と判断、コードは状態を比較します。行を押すと両方の引数と返った内容が開きます。</p>
  </>;
}

function useComparisonTrial(runId: string | null, episodeId: string | null) {
  const key = JSON.stringify([runId, episodeId]);
  const [missingKey, setMissingKey] = useState<string | null>(null);
  const summary = useAsync(runId && episodeId ? async signal => {
    try {
      const value = await traceApi.episode(runId, episodeId, signal);
      if (!signal.aborted) setMissingKey(null);
      return value;
    } catch (error) {
      if (!signal.aborted && error instanceof ApiError && error.status === 404) setMissingKey(key);
      throw error;
    }
  } : null, [runId, episodeId]);
  const run = useAsync(runId ? signal => traceApi.run(runId, signal) : null, [runId]);
  const events = useEpisodeEvents(runId, episodeId, summary.data?.status === 'running');
  const onReady = useCallback(() => { summary.reload(); run.reload(); events.refresh(); }, [summary.reload, run.reload, events.refresh]);
  const importing = useMissingEpisodeImport(runId, episodeId, missingKey === key && !summary.data, onReady, summary);
  useInterval(summary.poll, 5000, summary.data?.status === 'running');
  const ref = useMemo(() => runId && episodeId ? { runId, episodeId, generation: events.generation } : null, [runId, episodeId, events.generation]);
  const assets = useDataAssets(ref, String(events.resets));
  const assetTargets = useMemo(() => events.events.filter(event => /^(model_|api_call_|service_call_|code_block_)/.test(event.event_type)), [events.events]);
  useEffect(() => { assets.ensure(assetTargets); }, [assets.ensure, assetTargets]);
  const resolved = useMemo(() => applyDataAssets(events.events, assets.states), [events.events, assets.states]);
  const model = useMemo(() => buildEpisodeModel(resolved), [resolved]);
  const pending = resolved.filter(event => /^(model_|api_call_|service_call_|code_block_)/.test(event.event_type))
    .map(event => pendingAsset(event, assets.states)).filter(Boolean);
  const assetsLoading = pending.some(item => item?.kind === 'loading' || item?.kind === 'idle');
  const requests = model.calls.map(call => call.attempts[0]?.request).filter(request => request && dataOf(request, 'model_request').payload_path);
  const requestPayloads = useAsync(ref && requests.length ? async () => {
    const loaded = await Promise.all(requests.map(async request => {
      try {
        const payload = await fetchJsonFile(episodeFileUrl(ref, dataOf(request, 'model_request').payload_path!));
        return { id: request.event_id, summary: modelArgumentSummary(request, payload), failed: false };
      } catch {
        return { id: request.event_id, summary: modelArgumentSummary(request), failed: true };
      }
    }));
    return { summaries: new Map(loaded.map(item => [item.id, item.summary])), partial: loaded.some(item => item.failed) };
  } : null, [runId, episodeId, events.generation, requests.map(request => [request.event_id, dataOf(request, 'model_request').payload_path])]);
  const error = importing?.message ?? summary.error ?? events.error;
  const data: TrialComparisonData | null = ref && summary.data && events.eof && !events.loading && !assetsLoading && !events.error && !requestPayloads.loading
    ? { ref, summary: summary.data, model, records: run.data?.runner_records ?? [], requestArguments: requestPayloads.data?.summaries } : null;
  return { data, message: error ?? '記録を読み込み中…', retry: onReady, importing,
    partial: pending.some(item => item?.kind === 'failed' || item?.kind === 'unwritten') || requestPayloads.data?.partial || events.corruptLines > 0 || events.tornTail,
  };
}

export default function SideBySidePage() {
  const [params] = useUrlParams();
  const runId = params.get('run'), episodeId = params.get('episode');
  const baselineRunId = params.get('baseline_run'), baselineEpisodeId = params.get('baseline_episode');
  const current = useComparisonTrial(runId, episodeId);
  const baseline = useComparisonTrial(baselineRunId, baselineEpisodeId);
  const complete = !!runId && !!episodeId && !!baselineRunId && !!baselineEpisodeId;
  useEffect(() => { document.title = '同じseedで比べる · CaP-X'; }, []);
  return <main className="replay-workspace comparison-page">
    <nav><a href={runId && episodeId ? trialEventUrl(runId, episodeId) : '/traces'}>← 試行の要約へ戻る</a><a href="/evals">評価の一覧</a></nav>
    {!complete ? <p role="alert">比較する2つの試行を指定してください。</p> : <>
      {!baseline.data && <div className="comparison-loading" role="status">基準：{baseline.message}
        {!baseline.importing?.busy && <button type="button" onClick={baseline.retry}>再読み込み</button>}</div>}
      {!current.data && <div className="comparison-loading" role="status">今回：{current.message}
        {!current.importing?.busy && <button type="button" onClick={current.retry}>再読み込み</button>}</div>}
      {(baseline.partial || current.partial) && <p className="comparison-first-banner">一部の記録が欠けているため、読み込めた要約で比較しています。</p>}
      {baseline.data && current.data && <SideBySideComparison baseline={baseline.data} current={current.data} />}
    </>}
  </main>;
}
