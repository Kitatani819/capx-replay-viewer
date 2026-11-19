/**
 * Top bar of the trace viewer (docs/trace-format.md 9.3): run, episode,
 * task, seed, attempt, runner invocation; the condition label (display only)
 * next to the real config flags; models and roles, with configured roles that
 * sent nothing marked 「未使用」; episode status; polling status; recording
 * gaps (episode_end gaps and trace_warning codes in plain words, a hook
 * that failed during the episode named); three separate outcome fields
 * (evaluator, model claim, runner verdict); the Live and Browse switch. A run's
 * unscoped log gets a one-line explanation instead of the episode fields.
 *
 * The runner verdict is joined to this episode by task, condition, seed,
 * attempt and time (runner.ts); when no single record fits (a later
 * invocation redid the trial, times missing) the bar says so and shows none.
 * A record's `outcome` is the result of the trial's LAST attempt: it is shown
 * as this episode's verdict only when this episode is that attempt. For an
 * earlier attempt (a timeout that was retried) the bar shows that attempt's
 * own status, and the trial's final result separately, named with its attempt.
 * While the run's records are being read, or when that
 * read failed, the bar says so instead of 「runner の記録なし」; so it does when
 * the server read the run but not its runner_records.jsonl (runner_records_info:
 * the file exists but cannot be read, or has lines it could not parse). A
 * reason why episode.json could not be used (episode_json_error) is listed with
 * the recording gaps.
 *
 * Related: TraceViewerPage.tsx (state), model.ts, labels.ts, runner.ts.
 */

import { useState, type ReactNode } from 'react';
import { pendingAsset, type DataAssetState } from '../dataAsset';
import { fmtClock, fmtNum } from '../format';
import { LABELS, NOT_MODEL_INPUT, WARNING_CODE_LABELS, episodeStatusLabel } from '../labels';
import type { EpisodeModel } from '../model';
import { LEGACY_PROMPT_HOOK_REASON, UNUSED_HOOK_STATUS, awaitingOracleHookEvidence, episodeRecordingWarnings } from '../recordingWarnings';
import { episodeKeyOf, runnerRecordFor, type RunnerAttempt, type RunnerMatch } from '../runner';
import { dataOf, type EpisodeSummary, type RunnerRecord, type RunnerRecordsInfo, type TraceEvent } from '../types';
import { Badge, SmallButton, type Tone } from './common';
import { DataAssetInline, NO_ASSET_STATES } from './DataAssetState';
import { roleTone } from './Timeline';

export interface PollStatus {
  text: string;
  tone: Tone;
}

interface TopBarProps {
  onSimpleView?: () => void;
  compareHref?: string;
  /** Labels of the run/episode picker button. */
  runLabel: string | null;
  episodeLabel: string | null;
  /** The open traced episode; null hides the episode-only controls (picker page, legacy trial). */
  episodeId: string | null;
  summary: EpisodeSummary | null;
  model: EpisodeModel | null;
  runnerRecords: RunnerRecord[];
  /** Whether `runnerRecords` were read yet, and whether the last read failed (default: read). */
  runnerRead?: RunnerReadState;
  /** How the server read runner_records.jsonl (a file it could not read, lines it skipped). */
  runnerRecordsInfo?: RunnerRecordsInfo | null;
  /** Episode start, seconds since the epoch (episode_start wall_time or the summary); joins the runner record. */
  startWall?: number | null;
  live: boolean;
  onLive: (v: boolean) => void;
  poll: PollStatus;
  lastFetch: number | null;
  /** `error`: the last read of events.jsonl failed (the pager's error text), else absent or null. */
  reader: { corruptLines: number; tornTail: boolean; eof: boolean; count: number; replaced: boolean; error?: string | null };
  onOpenPicker: () => void;
  onRefresh: () => void;
  legacy?: ReactNode;
  /** Loading state of data moved to assets (episode_start's flags and models can be there). */
  assetStates?: ReadonlyMap<string, DataAssetState>;
  onRetryAsset?: (ev: TraceEvent) => void;
}

export function episodeStatusTone(status: string | null | undefined): Tone {
  switch (status) {
    case 'running':
      return 'gold';
    case 'ended':
      return 'green';
    case 'ended_with_gaps':
      return 'amber';
    case 'incomplete':
      return 'red';
    default:
      return 'neutral';
  }
}

function evaluatorOutcome(model: EpisodeModel | null): { text: string; tone: Tone; source: string | null } {
  if (!model) return { text: '—', tone: 'neutral', source: null };
  const eps = model.evaluators.filter((e) => dataOf(e, 'evaluator_result').scope === 'episode');
  const pick: TraceEvent | undefined = eps[eps.length - 1] ?? model.evaluators[model.evaluators.length - 1];
  if (!pick) return { text: '評価器の結果なし', tone: 'neutral', source: null };
  const d = dataOf(pick, 'evaluator_result');
  return {
    text: `task_completed=${String(d.task_completed ?? '—')} · reward=${fmtNum(d.reward)}${d.scope !== 'episode' ? '（最後のブロック）' : ''}`,
    tone: d.task_completed === true ? 'green' : d.task_completed === false ? 'red' : 'neutral',
    source: d.source ?? null,
  };
}

function modelClaim(model: EpisodeModel | null): ReactNode {
  if (!model) return '—';
  const parsed = model.calls.filter((c) => c.role === 'code_generator').flatMap((c) => c.parsed);
  if (parsed.length === 0) return <span className="text-[11px] text-text-tertiary">—</span>;
  const claimed = parsed.some((p) => dataOf(p, 'model_output_parsed').model_said_finish === true);
  return claimed ? <Badge tone="green">{LABELS.modelClaimsFinish}</Badge> : <span className="text-[11px] text-text-tertiary">完了の主張なし</span>;
}

function attemptTone(status: string | null | undefined): Tone {
  return status === 'timeout' ? 'amber' : status === 'error' ? 'red' : 'neutral';
}

/** An attempt's status as the runner recorded it, with where a timeout happened. */
function attemptStatusText(a: RunnerAttempt): string {
  const where = a.status === 'timeout' && typeof a.timed_out_in_sandbox === 'boolean' ? (a.timed_out_in_sandbox ? '（生成コードの実行中）' : '（生成コードの外）') : '';
  return `${a.status ?? '?'}${where}`;
}

/** task_success and the other outcome fields of a record; `verdict` colours task_success. */
function OutcomeFields({ outcome, verdict }: { outcome: RunnerRecord['outcome']; verdict: boolean }) {
  const ts = outcome?.task_success;
  return (
    <>
      {verdict ? (
        <Badge tone={ts === true ? 'green' : ts === false ? 'red' : 'neutral'}>task_success={String(ts ?? '—')}</Badge>
      ) : (
        <span>task_success={String(ts ?? '—')}</span>
      )}
      <span>code_execution_success={String(outcome?.code_execution_success ?? '—')}</span>
      <span>agent_finish={String(outcome?.agent_finish ?? '—')}</span>
      {outcome?.termination_reason ? <span>termination_reason={outcome.termination_reason}</span> : null}
    </>
  );
}

/** How the run's runner records were read (the page's /runs/{run} read). */
export interface RunnerReadState {
  /** A read of this run has succeeded (its records are the ones shown). */
  loaded: boolean;
  loading: boolean;
  /** The last read failed; records of an earlier read, if any, are still shown. */
  error: string | null;
}

const RUNNER_READ_DONE: RunnerReadState = { loaded: true, loading: false, error: null };

/**
 * What the server could not read of runner_records.jsonl, in words (empty when it read it all).
 * `error`: the file exists but could not be opened or read, so "no record" would be wrong.
 */
export function runnerRecordsProblems(info: RunnerRecordsInfo | null | undefined): { unreadable: string | null; parts: string[] } {
  const parts: string[] = [];
  if (!info) return { unreadable: null, parts };
  const unreadable = typeof info.error === 'string' && info.error ? info.error : null;
  if (typeof info.corrupt_lines === 'number' && info.corrupt_lines > 0) parts.push(`読めない行 ${info.corrupt_lines} 件`);
  if (info.torn_tail === true) parts.push('末尾の行が書きかけ');
  if (info.truncated === true) parts.push('読み込み上限を超えた分は未読');
  return { unreadable, parts };
}

/**
 * The runner's result for this episode. `outcome` belongs to the trial's last attempt, so it
 * is this episode's verdict only when this episode is that attempt (match.isFinal); otherwise
 * this attempt's own status comes first and the trial's final result is labelled with its
 * attempt, in plain text. Until the run's records were read (or when that read failed) the
 * bar says so, never 「runner の記録なし」.
 */
export function RunnerVerdict({
  match,
  recordsRead,
  read = RUNNER_READ_DONE,
  info = null,
}: {
  match: RunnerMatch;
  recordsRead: number;
  read?: RunnerReadState;
  info?: RunnerRecordsInfo | null;
}) {
  if (!read.loaded) {
    return read.error ? (
      <span className="text-[11px] text-amber-300">
        runner 記録を読み込めません: {read.error}
        {read.loading ? '（再取得中…）' : ''}
      </span>
    ) : (
      <span className="text-[11px] text-text-tertiary">runner 記録を読み込み中…</span>
    );
  }
  const stale = read.error ? <span className="text-[11px] text-amber-300">（runner 記録の再取得に失敗: {read.error}。前回の取得結果で表示）</span> : null;
  const record = match.record;
  if (!record) {
    const problems = runnerRecordsProblems(info);
    return (
      <span className="flex flex-wrap items-center gap-1">
        {match.problem ? (
          <span className="text-[11px] text-amber-300">対応する runner 記録を特定できません: {match.problem}</span>
        ) : problems.unreadable ? (
          <span className="text-[11px] text-amber-300">runner_records.jsonl を読めません（{problems.unreadable}）。runner の判定は不明です</span>
        ) : (
          <span className="text-[11px] text-text-tertiary">{recordsRead ? '該当する記録なし' : 'runner の記録なし'}</span>
        )}
        {problems.parts.length > 0 && (
          <span className="text-[11px] text-amber-300">
            （runner_records.jsonl: {problems.parts.join('、')}。この trial の記録がその中にある可能性があります）
          </span>
        )}
        {stale}
      </span>
    );
  }
  const attempts = record.attempts ?? [];
  const finalId = match.finalAttempt?.attempt_id ?? null;
  return (
    <span className="flex flex-wrap items-center gap-1 text-[11px]">
      {match.isFinal ? (
        <>
          <OutcomeFields outcome={record.outcome} verdict />
          {attempts.length > 1 && <span className="text-text-tertiary">（この試行 attempt {match.attemptId ?? '?'} が trial の最終試行）</span>}
        </>
      ) : (
        <>
          {match.attempt ? (
            <Badge tone={attemptTone(match.attempt.status)} title={match.attempt.error ?? undefined}>
              この試行（attempt {match.attempt.attempt_id ?? '?'}）: {attemptStatusText(match.attempt)}
            </Badge>
          ) : (
            <span className="text-amber-300">このエピソードが記録のどの試行かは特定できません</span>
          )}
          <span className="flex flex-wrap items-center gap-1 text-text-tertiary">
            trial の最終結果（attempt {finalId ?? '?'}
            {match.attempt ? '。このエピソードの試行ではありません' : ''}）: <OutcomeFields outcome={record.outcome} verdict={false} />
          </span>
        </>
      )}
      {attempts.map((a, i) => (
        <Badge key={i} tone={match.attempt !== null && a === match.attempt ? 'gold' : 'neutral'} title={a?.error ?? undefined}>
          attempt {a?.attempt_id ?? '?'}: {a ? attemptStatusText(a) : '?'}
        </Badge>
      ))}
      {match.unverified && <span className="text-amber-300">（開始時刻がないため時刻での照合はしていません）</span>}
      {match.candidates > 1 && !match.unverified && (
        <span className="text-text-tertiary">（同じ task/condition/seed の記録 {match.candidates} 件から時刻で特定）</span>
      )}
      {stale}
    </span>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <span className="text-[10px] uppercase tracking-widest font-display text-text-muted whitespace-nowrap">{label}</span>
      <span className="text-xs text-text-primary min-w-0 truncate">{children}</span>
    </div>
  );
}

export function UnusedHookNotice({ count }: { count: number }) {
  return <div className="mt-2 text-sm text-text-secondary">
    <p>使われなかったフックの登録警告（{count}件）</p>
    <p>旧式プロンプト用の関数が実行環境に見つかりませんでした。</p>
    <code className="break-all">{LEGACY_PROMPT_HOOK_REASON}</code>
  </div>;
}

export function TopBar({
  onSimpleView,
  compareHref,
  runLabel,
  episodeLabel,
  episodeId,
  summary,
  model,
  runnerRecords,
  runnerRead,
  runnerRecordsInfo = null,
  startWall = null,
  live,
  onLive,
  poll,
  lastFetch,
  reader,
  onOpenPicker,
  onRefresh,
  legacy,
  assetStates = NO_ASSET_STATES,
  onRetryAsset,
}: TopBarProps) {
  const [expanded, setExpanded] = useState(false);
  const start = model?.episodeStart ? dataOf(model.episodeStart, 'episode_start') : null;
  const end = model?.episodeEnd ? dataOf(model.episodeEnd, 'episode_end') : null;
  const task = start?.task ?? summary?.task ?? null;
  const condition = start?.condition ?? summary?.condition ?? null;
  const seed = start?.seed ?? summary?.seed ?? null;
  const attempt = start?.attempt_index ?? summary?.attempt_index ?? null;
  const invocation = start?.runner_invocation ?? summary?.runner_invocation ?? null;
  const conditionLabel = start?.condition_label ?? summary?.condition_label ?? null;
  const flags = start?.config_flags ?? null;
  const models = start?.models ?? null;
  const status = summary?.status ?? null;
  // episode_start's objects (flags, models) are missing until its asset is merged, if it had one.
  const startEv = model?.episodeStart ?? null;
  const startPending = startEv && pendingAsset(startEv, assetStates) ? startEv : null;
  const notRecordedOrPending = startPending ? <DataAssetInline ev={startPending} states={assetStates} onRetry={onRetryAsset} /> : LABELS.notRecorded;
  const evalOut = evaluatorOutcome(model);
  const match = runnerRecordFor(runnerRecords, episodeKeyOf(start, summary, startWall));

  const unscoped = status === 'unscoped';
  const recording = episodeRecordingWarnings(model, summary);
  const checkingHook = awaitingOracleHookEvidence(summary, reader);
  const gaps = checkingHook ? [] : recording.gaps;
  const gapParts: string[] = gaps.map((g) => `${WARNING_CODE_LABELS[g.code ?? ''] ?? g.code ?? '?'}×${g.count ?? '?'}`);
  const gapDetails: string[] = gaps.map((g) => `${g.code ?? '?'}×${g.count ?? '?'}（最初 seq ${g.first_seq ?? '?'}）`);
  const dropped = summary?.dropped_events ?? end?.dropped_events ?? 0;
  const late = summary?.late_events ?? end?.late_events ?? 0;
  const nWarn = checkingHook ? 0 : model?.warnings.length ?? 0;
  if (dropped && !gaps.some((g) => g.code === 'dropped_events')) gapParts.push(`dropped ${dropped}`);
  if (late && !gaps.some((g) => g.code === 'late_event')) gapParts.push(`late ${late}`);
  if (nWarn) {
    // trace_warning events by code; a hook that failed while this episode was open is named.
    const byCode = new Map<string, number>();
    let hookDuring = 0;
    for (const w of model?.warnings ?? []) {
      const d = dataOf(w, 'trace_warning');
      byCode.set(d.code ?? '?', (byCode.get(d.code ?? '?') ?? 0) + 1);
      if (d.code === 'hook_install_failed' && d.during_episode === true) hookDuring += 1;
    }
    // codes the episode_end gaps already name are not repeated in the badge (the tooltip lists all)
    const gapCodes = new Set(gaps.map((g) => g.code));
    const extra = Array.from(byCode.entries()).filter(([c]) => !gapCodes.has(c));
    if (extra.length) {
      const n = extra.reduce((acc, [, k]) => acc + k, 0);
      gapParts.push(`記録の警告 ${n}（${extra.map(([c, k]) => `${WARNING_CODE_LABELS[c] ?? c}×${k}`).join(', ')}）`);
    }
    gapDetails.push(...Array.from(byCode.entries()).map(([c, n]) => `trace_warning ${c}×${n}`));
    if (hookDuring) gapDetails.push(`エピソード中のフック導入失敗 ${hookDuring}`);
  }
  if (reader.corruptLines) gapParts.push(`破損行 ${reader.corruptLines}`);
  if (reader.tornTail && status !== 'running') gapParts.push('末尾の行が途中で切れています');
  if (reader.replaced) gapParts.push('表示中に events.jsonl が置き換えられ、最初から読み直しました');
  // events.jsonl exists but could not be read (backend 403/500): nothing of the episode is shown.
  if (reader.error && reader.count === 0 && !unscoped) gapParts.push('events.jsonl を読み込めません');
  // episode.json exists but could not be used: the status and summary fields come without it.
  const episodeJsonError = !unscoped && typeof summary?.episode_json_error === 'string' && summary.episode_json_error !== 'missing' ? summary.episode_json_error : null;
  if (episodeJsonError) gapParts.push(`episode.json を読めません（${episodeJsonError}）`);
  const hooksFailed = checkingHook ? [] : recording.hooksFailed;
  if (hooksFailed.length) {
    const names = hooksFailed.map((h) => (typeof h === 'string' ? h : h && typeof h === 'object' ? String((h as { hook?: unknown; id?: unknown }).hook ?? (h as { id?: unknown }).id ?? '?') : '?'));
    if (gaps.some(gap => gap.code === 'hook_install_failed')) gapDetails.push(`導入に失敗したフック ${names.join(', ')}`);
    else gapParts.push(`フック導入失敗 ${hooksFailed.length}（${names.join(', ')}）`);
  }
  const incomplete = !unscoped && !checkingHook && !recording.onlyUnused &&
    (status === 'incomplete' || status === 'ended_with_gaps' || (summary?.trace_complete ?? end?.trace_complete) === false);
  if (incomplete && gapParts.length === 0) gapParts.push(status === 'incomplete' ? 'episode_end なし' : 'trace_complete=false');
  // The recorder reported a complete trace, but reading it found gaps: never show it as complete.
  const readerGaps = reader.corruptLines > 0 || hooksFailed.length > 0;
  const onlyHookNotice = recording.onlyUnused && gapParts.length === 0 && status === 'ended_with_gaps';
  const statusText = checkingHook && gapParts.length === 0 ? '記録の警告を確認中' : onlyHookNotice ? UNUSED_HOOK_STATUS :
    status === 'ended' && readerGaps ? '終了（記録完了と報告。ただし欠落を検出）' : episodeStatusLabel(status);
  const statusToneValue: Tone = onlyHookNotice ? 'neutral' : status === 'ended' && readerGaps ? 'amber' : episodeStatusTone(status);

  return (
    <header className="replay-header">
      <div className="replay-header-main">
        <h1 title={task ?? undefined}>{task ?? (episodeLabel?.split('/')[0] || '試行のリプレイ')}</h1>
        <div className="replay-header-actions">
          {episodeId && status === 'running' && <span className="replay-live-status" role="status">
            <span className="text-sm text-accent">記録中</span>
            <span className="text-xs text-text-secondary" title={lastFetch ? `最終取得 ${fmtClock(lastFetch)}` : undefined}>{poll.text}</span>
            <label className="text-xs"><input type="checkbox" checked={live} onChange={e => onLive(e.target.checked)} /> 新しい記録に追従</label>
          </span>}
          {episodeId && gapParts.length > 0 && <span className="replay-warning" title={[...gapParts, ...gapDetails].join('\n')}>記録に欠落があります</span>}
          {episodeId && reader.error && reader.count > 0 && <span role="status" className="replay-warning" title={reader.error}>記録の更新に失敗しています</span>}
          <button className="replay-text-button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>試行の詳細</button>
          {compareHref && <a className="replay-compare-button" href={compareHref}>基準と並べて比べる</a>}
          <button type="button" className="replay-trial-button" onClick={onOpenPicker} title={episodeLabel ?? undefined}>
            別の試行を選ぶ <span aria-hidden>⌄</span>
          </button>
        </div>
      </div>
      <div hidden={!expanded}>
      <div className="replay-trial-meta">
        <div className="flex flex-wrap gap-3 items-center">
          <span className="break-all">run: {runLabel ?? '—'} / episode: {episodeLabel ?? '—'}</span>{legacy}
          {episodeId && <><Badge tone={statusToneValue}>{statusText}</Badge><span title={lastFetch ? `最終取得 ${fmtClock(lastFetch)}` : undefined}>{poll.text}</span>
            {status !== 'running' && <label><input type="checkbox" checked={live} onChange={e => onLive(e.target.checked)} /> 新しい記録に追従</label>}
            <SmallButton onClick={onRefresh}>更新</SmallButton></>}
          {onSimpleView && <SmallButton onClick={onSimpleView}>実行回ごとの表示</SmallButton>}
        </div>
        {gapParts.length > 0 && <p className="replay-warning">記録の欠落: {gapParts.join('、')}</p>}
        {recording.count > 0 && <UnusedHookNotice count={recording.count}/>}
      </div>
      {episodeId && unscoped && (
        <div className="px-4 pb-2 text-[11px] text-text-secondary">
          run の unscoped ログです（pid {String(summary?.pid ?? '?')}）。runner の preflight 要求や、所属するエピソードを決められなかったイベントが入ります。エピソードではないため、task・評価器・runner の判定はありません。
        </div>
      )}
      {episodeId && !unscoped && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 px-4 pb-2">
          <Field label="task">{task ?? '—'}</Field>
          <Field label="seed">{seed ?? '—'}</Field>
          <Field label="attempt">{attempt ?? '—'}</Field>
          <Field label="invocation">{invocation ?? '—'}</Field>
          <div className="flex flex-wrap items-center gap-1 min-w-0">
            <span className="text-[10px] uppercase tracking-widest font-display text-text-muted">条件</span>
            {condition && <span className="text-xs font-mono">{condition}</span>}
            {conditionLabel && (
              <Badge
                tone="neutral"
                title={[
                  'ラベルは表示用です。実際の設定は右のフラグで判断してください',
                  typeof start?.runner_condition?.config_path === 'string' ? `config: ${start.runner_condition.config_path}` : null,
                  typeof start?.runner_condition?.note === 'string' ? `note: ${start.runner_condition.note}` : null,
                ]
                  .filter(Boolean)
                  .join('\n')}
              >
                ラベル（表示のみ）: {conditionLabel}
              </Badge>
            )}
            {flags ? (
              Object.entries(flags).map(([k, v]) =>
                typeof v === 'boolean' ? (
                  <Badge key={k} tone={v ? 'gold' : 'neutral'} className={v ? '' : 'opacity-50 line-through'}>
                    {k}
                  </Badge>
                ) : v === null || v === undefined ? null : (
                  <Badge key={k} tone="neutral">
                    {k}={typeof v === 'object' ? JSON.stringify(v) : String(v)}
                  </Badge>
                ),
              )
            ) : (
              <span className="text-[11px] text-text-tertiary">設定フラグ: {notRecordedOrPending}</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[10px] uppercase tracking-widest font-display text-text-muted">モデル</span>
            {models ? (
              Object.entries(models).map(([role, m]) => (
                <Badge key={role} tone={roleTone(role)} title={typeof m?.endpoint === 'string' ? m.endpoint : m?.endpoint?.url ?? undefined}>
                  {role}: {m?.model ?? '?'}
                  {model && !model.rolesSeen.has(role) && <span className="ml-1 text-text-tertiary">（{LABELS.unusedRole}）</span>}
                </Badge>
              ))
            ) : (
              <span className="text-[11px] text-text-tertiary">{notRecordedOrPending}</span>
            )}
            {model &&
              Array.from(model.rolesSeen)
                .filter((r) => !models || !(r in models))
                .map((r) => (
                  <Badge key={r} tone={roleTone(r)} title="episode_start の models に無い役割">
                    {r}（設定外）
                  </Badge>
                ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] uppercase tracking-widest font-display text-text-muted">評価器</span>
            <Badge tone={evalOut.tone} title={NOT_MODEL_INPUT}>
              {evalOut.text}
            </Badge>
            {evalOut.source && <span className="text-[11px] text-text-tertiary">source: {evalOut.source}</span>}
            <span className="text-[10px] uppercase tracking-widest font-display text-text-muted">モデルの主張</span>
            {modelClaim(model)}
            <span className="text-[10px] uppercase tracking-widest font-display text-text-muted">runner</span>
            <RunnerVerdict match={match} recordsRead={runnerRecords.length} read={runnerRead} info={runnerRecordsInfo} />
          </div>
          <span className="text-[10px] text-text-muted font-mono">
            events {reader.count}
            {reader.error ? '（読み込めません）' : !reader.eof ? '（読み込み中）' : ''}
          </span>
        </div>
      )}
      </div>
    </header>
  );
}
