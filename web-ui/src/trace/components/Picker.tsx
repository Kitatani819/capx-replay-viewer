import { remoteName } from '../../navigation/site';
/**
 * Run and episode picker (docs/trace-format.md 9.3): runs newest first, then
 * the episodes of a run with status badges (attempts of one seed next to each
 * other). Traced runs come from /api/traces/runs; runner directories written
 * before the recorder existed are listed separately under
 * 「古いログ（トレースなし）」 (9.4) from /api/traces/legacy/runs. GMO is
 * the initial list when its integration is available. A run's
 * unscoped logs (events with no episode, such as the runner's preflight
 * requests) are listed under the episodes and open like an episode; lines of
 * such a log that the recorder could not write (its unscoped.<pid>.status.json,
 * backend `write_status`) are named next to it, also when the log itself is
 * missing. An episode whose episode.json could not be used shows why.
 *
 * Related: TraceViewerPage.tsx (URL parameters), LegacyView.tsx.
 */

import { useMemo, useState } from 'react';
import { ApiError, gmoApi, traceApi } from '../api';
import { fmtBytes, fmtWall } from '../format';
import { useAsync, type AsyncState } from '../hooks';
import { LABELS, UNSCOPED_STATUS_LABEL, WARNING_CODE_LABELS, episodeStatusLabel, episodeStatusShortLabel } from '../labels';
import { LEGACY_PROMPT_HOOK_REASON, UNUSED_HOOK_STATUS, summaryRecordingWarnings } from '../recordingWarnings';
import type { EpisodeSummary, TraceConfigResponse, UnscopedFileInfo } from '../types';
import { Badge, ErrorText, Notice, Spinner, SmallButton } from './common';
import { episodeStatusTone } from './TopBar';
import { episodeVerdict, VERDICT_LABELS, type TaskVerdict } from '../outcome';
import { TaskOutcomeBadge } from './TaskOutcomeBadge';
import { legacyRootsOf, legacyRunsOf, legacyTrialsOf, type LegacyRunRef, type LegacyTrialRef } from './LegacyView';
import { GmoPicker } from './GmoPicker';

export type PickerMode = 'gmo' | 'traced' | 'legacy';

interface PickerProps {
  config: TraceConfigResponse | null;
  configError: string | null;
  currentRun: string | null;
  currentEpisode: string | null;
  currentLegacyRun?: string | null;
  initialMode?: PickerMode | null;
  onModeChange?: (mode: PickerMode) => void;
  onPick: (runId: string, episodeId: string) => void;
  onPickLegacy: (runId: string, trial: LegacyTrialRef) => void;
  onClose?: () => void;
}

export function Picker({ config, configError, currentRun, currentEpisode, currentLegacyRun, initialMode, onModeChange, onPick, onPickLegacy, onClose }: PickerProps) {
  const [selectedMode, setSelectedMode] = useState<PickerMode | null>(initialMode ?? null);
  const [gmoDisabled, setGmoDisabled] = useState(false);
  const [runSel, setRunSel] = useState<string | null>(currentRun);
  const [filter, setFilter] = useState('');
  const [resultFilter, setResultFilter] = useState<TaskVerdict | 'all'>('all');
  const runs = useAsync((s) => traceApi.runs(s), []);
  const legacyRuns = useAsync((s) => traceApi.legacyRuns(s), []);
  const gmoConfig = useAsync(async (signal) => {
    try {
      return { config: await gmoApi.config(signal) };
    } catch (error) {
      // Keep a completed 404 distinct from a config request still in flight.
      if (error instanceof ApiError && error.status === 404) return { config: null };
      throw error;
    }
  }, []);
  const gmoAvailable = !gmoDisabled && !!(gmoConfig.data?.config || gmoConfig.error);
  const legacyAvailable = !!currentLegacyRun || legacyRunsOf(legacyRuns.data).length > 0;
  // Only automatic/GMO selection needs this config; local choices work while
  // it is pending, including a restored choice when reopening the picker.
  const checking = ((selectedMode === null || selectedMode === 'gmo') && gmoConfig.data === null && !gmoConfig.error) ||
    (selectedMode === 'legacy' && !currentLegacyRun && legacyRuns.data === null && legacyRuns.loading);
  // A later refresh failure must not move the initial GMO tab away from a
  // config that was already read successfully (for example, after saving).
  const preferredMode = selectedMode ?? (!gmoDisabled && gmoConfig.data?.config ? 'gmo' : 'traced');
  const availableMode = (preferredMode === 'gmo' && !gmoAvailable) || (preferredMode === 'legacy' && !legacyAvailable) ? 'traced' : preferredMode;
  const mode = checking ? null : availableMode;
  const selectMode = (next: PickerMode) => {
    setSelectedMode(next);
    onModeChange?.(next);
  };
  const reloadLocalLists = () => {
    runs.reload();
    // The legacy tab may be hidden after an empty or failed initial read.
    legacyRuns.reload();
  };
  const detail = useAsync(runSel && mode === 'traced' ? (s) => traceApi.run(runSel, s) : null, [runSel, mode]);

  const episodes = useMemo(() => {
    const list = [...(detail.data?.episodes ?? [])].filter(episode => resultFilter === 'all' || episodeVerdict(episode, detail.data?.runner_records ?? []) === resultFilter);
    const q = filter.trim().toLowerCase();
    const filtered = q
      ? list.filter((e) => [e.episode_id, e.task, e.condition, e.condition_label, String(e.seed ?? '')].some((x) => (x ?? '').toString().toLowerCase().includes(q)))
      : list;
    filtered.sort((a, b) => {
      const k = (e: EpisodeSummary) => [e.task ?? '', e.condition ?? '', String(e.seed ?? '').padStart(8, '0'), String(e.attempt_index ?? '').padStart(4, '0'), e.episode_id].join('|');
      return k(a) < k(b) ? -1 : k(a) > k(b) ? 1 : 0;
    });
    return filtered;
  }, [detail.data, filter, resultFilter]);

  return (
    <div className="flex flex-col h-full min-h-0 bg-surface">
      <div className="flex-shrink-0 flex flex-wrap items-center gap-2 px-4 py-2 border-b border-surface-border bg-surface-raised">
        {gmoAvailable && (
          <SmallButton active={mode === 'gmo'} title={`${remoteName()} の記録を探して取り込み、開きます`} onClick={() => selectMode('gmo')}>{remoteName()}</SmallButton>
        )}
        <SmallButton active={mode === 'traced'} title="手元に保存されたトレースの一覧です" onClick={() => selectMode('traced')}>
          {LABELS.localSection}
        </SmallButton>
        {legacyAvailable && (
          <SmallButton active={mode === 'legacy'} title="トレースのない既存 runner ログの一覧です" onClick={() => selectMode('legacy')}>
            {LABELS.legacySection}
          </SmallButton>
        )}
        <details data-picker-details="trace" className="min-w-0 text-xs text-text-secondary open:order-last open:basis-full">
          <summary className="cursor-pointer px-2 py-1">一覧の詳細</summary>
          <dl className="mt-2 space-y-2 px-2 pb-2">
            <div><dt className="text-text-tertiary">トレースの保存先</dt>
              <dd className="font-mono break-all">{config?.trace_root ?? '—'}{config?.exists === false ? '（存在しません）' : ''}</dd>
            </div>
            <div><dt className="text-text-tertiary">動作モード</dt>
              <dd>{config?.viewer_only === true ? 'viewer-only（記録の閲覧専用）' : config?.viewer_only === false ? '通常モード' : '未取得'}</dd>
            </div>
          </dl>
        </details>
        {mode === 'traced' && config?.exists === false && <span role="status" className="text-xs text-text-secondary">トレースの保存先が見つかりません</span>}
        {configError && <div role="alert"><ErrorText>{configError}</ErrorText></div>}
        <div className="ml-auto flex gap-2">
          {mode !== null && mode !== 'gmo' && <SmallButton onClick={mode === 'legacy' ? legacyRuns.reload : reloadLocalLists}>一覧を更新</SmallButton>}
          {onClose && <SmallButton onClick={onClose}>閉じる</SmallButton>}
        </div>
      </div>
      {mode === null ? (
        <div role="status" className="p-4"><Spinner label="一覧を確認中" /></div>
      ) : mode === 'gmo' ? (
        <GmoPicker
          initialConfig={gmoConfig.data?.config ?? null}
          configError={gmoConfig.error}
          onConfigChange={gmoConfig.reload}
          onRetryConfig={gmoConfig.reload}
          onDisabled={() => { setGmoDisabled(true); selectMode('traced'); }}
          onPick={onPick}
        />
      ) : mode === 'legacy' ? (
        <LegacyPicker runs={legacyRuns} onPickLegacy={onPickLegacy} />
      ) : (
        <div className="flex-1 min-h-0 flex">
          <div className="w-80 flex-shrink-0 border-r border-surface-border overflow-y-auto">
            <div className="px-3 py-2 text-[11px] font-bold font-display uppercase tracking-widest text-text-tertiary">run（新しい順）</div>
            {runs.loading && !runs.data && (
              <div className="px-3">
                <Spinner label="読み込み中" />
              </div>
            )}
            {runs.error && (
              <div className="px-3">
                <ErrorText>{runs.error}</ErrorText>
              </div>
            )}
            {runs.data && runs.data.runs.length === 0 && <div className="px-3 text-xs text-text-tertiary">トレースのある run がありません</div>}
            {runs.data?.runs.map((r) => (
              <button
                key={r.run_id}
                type="button"
                onClick={() => setRunSel(r.run_id)}
                className={`w-full text-left px-3 py-2 border-b border-surface-border/60 hover:bg-surface-overlay ${runSel === r.run_id ? 'bg-accent/10 border-l-2 border-l-accent' : ''}`}
              >
                <div className="text-xs font-mono text-text-primary break-all">{r.run_id}</div>
                <div className="flex flex-wrap items-center gap-1 mt-1 text-[11px] text-text-tertiary">
                  <span>エピソード {r.n_episodes ?? '?'}</span>
                  <span>· {fmtWall(r.last_modified ?? null)}</span>
                  {Object.entries(r.status_counts ?? {})
                    .filter(([, n]) => n > 0)
                    .map(([st, n]) => (
                      <Badge key={st} tone={episodeStatusTone(st)} title={episodeStatusLabel(st)}>
                        {episodeStatusShortLabel(st)} {n}
                      </Badge>
                    ))}
                </div>
              </button>
            ))}
          </div>
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 border-b border-surface-border">
              <span className="text-[11px] font-bold font-display uppercase tracking-widest text-text-tertiary">episode</span>
              <select aria-label="結果で絞り込み" value={resultFilter} onChange={event => setResultFilter(event.target.value as TaskVerdict | 'all')} className="rounded border border-surface-border bg-surface-sunken p-1 text-xs">
                <option value="all">すべての結果</option>{Object.entries(VERDICT_LABELS).map(([value,label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <input
                type="search"
                name="trace-episode-filter"
                aria-label="試行を検索"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="絞り込み（task / condition / seed / id）"
                className="flex-1 px-2 py-1 bg-surface-sunken border border-surface-border rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent/40"
              />
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              {!runSel && <div className="p-4 text-xs text-text-tertiary">左の run を選んでください</div>}
              {detail.loading && !detail.data && (
                <div className="p-4">
                  <Spinner label="読み込み中" />
                </div>
              )}
              {detail.error && (
                <div className="p-4">
                  <ErrorText>{detail.error}</ErrorText>
                </div>
              )}
              {detail.data?.run_json_error && (
                <div className="px-3 pt-2">
                  <Notice tone="amber" className="text-xs">
                    この run の run.json を読めません（{detail.data.run_json_error}）。run の設定情報は表示できません。
                  </Notice>
                </div>
              )}
              {detail.data && (
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-surface-raised">
                    <tr className="text-left text-text-tertiary border-b border-surface-border">
                      <th className="py-1.5 px-3 font-normal">結果</th>
                      <th className="py-1.5 pr-2 font-normal">記録状態</th>
                      <th className="py-1.5 pr-2 font-normal">task</th>
                      <th className="py-1.5 pr-2 font-normal">condition</th>
                      <th className="py-1.5 pr-2 font-normal">seed</th>
                      <th className="py-1.5 pr-2 font-normal">attempt</th>
                      <th className="py-1.5 pr-2 font-normal">end_reason</th>
                      <th className="py-1.5 pr-2 font-normal">episode_id</th>
                    </tr>
                  </thead>
                  <tbody>
                    {episodes.map((e) => (
                      <tr
                        key={e.episode_id}
                        tabIndex={0}
                        role="button"
                        aria-label={`episode ${e.episode_id}`}
                        onClick={() => runSel && onPick(runSel, e.episode_id)}
                        onKeyDown={(ev) => {
                          if ((ev.key === 'Enter' || ev.key === ' ') && runSel) {
                            ev.preventDefault();
                            onPick(runSel, e.episode_id);
                          }
                        }}
                        className={`cursor-pointer border-b border-surface-border/50 hover:bg-surface-overlay focus:outline-none focus:bg-surface-overlay ${
                          runSel === currentRun && e.episode_id === currentEpisode ? 'bg-accent/10' : ''
                        }`}
                      >
                        <td className="py-1.5 px-3">
                          <TaskOutcomeBadge verdict={episodeVerdict(e, detail.data?.runner_records ?? [])} />
                        </td>
                        <td className="py-1.5 pr-2">
                          <EpisodeStatusCell episode={e} />
                        </td>
                        <td className="py-1.5 pr-2">{e.task ?? '—'}</td>
                        <td className="py-1.5 pr-2">
                          {e.condition ?? '—'}
                          {e.condition_label && e.condition_label !== e.condition ? <span className="text-text-tertiary">（{e.condition_label}）</span> : null}
                        </td>
                        <td className="py-1.5 pr-2 font-mono">{e.seed ?? '—'}</td>
                        <td className="py-1.5 pr-2 font-mono">{e.attempt_index ?? '—'}</td>
                        <td className="py-1.5 pr-2">{e.end_reason ?? '—'}</td>
                        <td className="py-1.5 pr-2 font-mono text-[11px] text-text-tertiary break-all">{e.episode_id}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {detail.data && episodes.length === 0 && <div className="p-4 text-xs text-text-tertiary">該当するエピソードがありません</div>}
              {detail.data && (detail.data.unscoped_files ?? []).length > 0 && (
                <UnscopedFileList
                  files={detail.data.unscoped_files ?? []}
                  runId={runSel}
                  currentRun={currentRun}
                  currentEpisode={currentEpisode}
                  onPick={onPick}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * An episode's status badge in the picker, with the reason when its episode.json could not be
 * used (`episode_json_error` other than "missing": unreadable, a symlink, invalid JSON, ...).
 */
export function EpisodeStatusCell({ episode: e }: { episode: EpisodeSummary }) {
  const { onlyUnused, gaps } = summaryRecordingWarnings(e);
  const gapReasons = gaps.map(g => `${WARNING_CODE_LABELS[g.code ?? ''] ?? g.code ?? '?'}×${g.count ?? '?'}`);
  return (
    <>
      {onlyUnused ? (
        <Badge tone="neutral" title={LEGACY_PROMPT_HOOK_REASON}>{UNUSED_HOOK_STATUS}</Badge>
      ) : (
        <Badge tone={episodeStatusTone(e.status)} title={gapReasons.join('、') || undefined}>{episodeStatusLabel(e.status)}</Badge>
      )}
      {typeof e.episode_json_error === 'string' && e.episode_json_error !== 'missing' && (
        <Badge tone="amber" title={`episode.json を読めません（${e.episode_json_error}）`} className="ml-1">
          episode.json: {e.episode_json_error}
        </Badge>
      )}
    </>
  );
}

/**
 * The run's unscoped logs, each with a button that opens it, and what the recorder could not
 * write to it (unscoped.<pid>.status.json: `write_status`, or `write_status_error` when that
 * file could not be read). A log that exists only as its status file (`bytes` null) is listed
 * too, so its lost lines are never hidden by the missing log.
 */
export function UnscopedFileList({
  files,
  runId,
  currentRun,
  currentEpisode,
  onPick,
}: {
  files: UnscopedFileInfo[];
  runId: string | null;
  currentRun: string | null;
  currentEpisode: string | null;
  onPick: (runId: string, episodeId: string) => void;
}) {
  return (
    <div className="px-3 py-2 text-[11px] text-text-tertiary border-t border-surface-border space-y-1">
      <div>{UNSCOPED_STATUS_LABEL}: runner の preflight 要求や、所属するエピソードを決められなかったイベントです。</div>
      <div className="flex flex-wrap gap-2">
        {files.map((f, i) => {
          const size = f.bytes === null || f.bytes === undefined ? 'ファイルなし' : fmtBytes(f.bytes);
          const ws = f.write_status;
          const lost = ws && typeof ws.lines_not_written === 'number' ? ws.lines_not_written : null;
          const status =
            f.write_status_error ? (
              <span className="text-amber-300">書き込み状況ファイル（status.json）を読めません（{f.write_status_error}）</span>
            ) : ws ? (
              <span className="text-amber-300">
                書き込めなかった行 {lost ?? '?'} 件{ws.last_reason ? `（最後の理由: ${ws.last_reason}）` : ''}
              </span>
            ) : null;
          return (
            <span key={f.file ?? f.log_id ?? i} className="inline-flex flex-wrap items-center gap-1">
              {f.log_id && runId ? (
                <button
                  type="button"
                  onClick={() => onPick(runId, f.log_id!)}
                  className={`px-2 py-0.5 rounded border font-mono hover:border-accent/50 hover:text-accent ${
                    runId === currentRun && f.log_id === currentEpisode ? 'border-accent/60 text-accent' : 'border-surface-border text-text-secondary'
                  }`}
                >
                  {f.file}（{size}）を開く
                </button>
              ) : (
                <span className="font-mono">
                  {f.file ?? '?'}（{size}）
                </span>
              )}
              {status}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function LegacyPicker({ runs, onPickLegacy }: { runs: AsyncState<unknown>; onPickLegacy: (runId: string, trial: LegacyTrialRef) => void }) {
  const [runSel, setRunSel] = useState<LegacyRunRef | null>(null);
  const [filter, setFilter] = useState('');
  const detail = useAsync(runSel ? (s) => traceApi.legacyRun(runSel.runId, runSel.root, s) : null, [runSel?.runId, runSel?.root]);
  const runList = useMemo(() => legacyRunsOf(runs.data), [runs.data]);
  const roots = useMemo(() => legacyRootsOf(runs.data), [runs.data]);
  const trials = useMemo(() => {
    const all = legacyTrialsOf(detail.data, runSel?.root ?? null);
    const q = filter.trim().toLowerCase();
    return q ? all.filter((t) => `${t.task} ${t.condition} ${t.trialDir}`.toLowerCase().includes(q)) : all;
  }, [detail.data, filter, runSel]);
  const isSel = (r: LegacyRunRef) => !!runSel && runSel.runId === r.runId && runSel.root === r.root;
  return (
    <div className="flex-1 min-h-0 flex">
      <div className="w-80 flex-shrink-0 border-r border-surface-border overflow-y-auto">
        <div className="px-3 py-2 text-[11px] text-text-tertiary">
          保存されている録画とログを表示します。
          {roots.some(r => !r.exists) && <p role="status" className="mt-1">見つからない保存先があります。</p>}
          <details data-picker-details="legacy" className="mt-2">
          <summary className="cursor-pointer py-1">保存先の詳細</summary>
          <div className="font-mono mt-1 space-y-2 break-all">
            {roots.map((r) => (
              <div key={r.index}>
                root {r.index}: {r.path}
                {r.exists ? '' : '（存在しません）'}
              </div>
            ))}
          </div>
          </details>
        </div>
        {runs.loading && !runs.data && (
          <div className="px-3">
            <Spinner />
          </div>
        )}
        {runs.error && (
          <div className="px-3">
            <ErrorText>{runs.error}</ErrorText>
          </div>
        )}
        {runs.data !== null && runList.length === 0 && <div className="px-3 text-xs text-text-tertiary">runner の run がありません</div>}
        {runList.map((r) => (
          <button
            key={`${r.root}:${r.runId}`}
            type="button"
            onClick={() => setRunSel(r)}
            className={`w-full text-left px-3 py-2 border-b border-surface-border/60 hover:bg-surface-overlay ${isSel(r) ? 'bg-accent/10 border-l-2 border-l-accent' : ''}`}
          >
            <div className="text-xs font-mono text-text-primary break-all">{r.runId}</div>
            <div className="text-[11px] text-text-tertiary">
              {r.root !== null && roots.length > 1 ? `root ${r.root} · ` : ''}
              {r.detail}
            </div>
          </button>
        ))}
      </div>
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex-shrink-0 px-3 py-2 border-b border-surface-border">
          <input
            type="search"
            name="trace-legacy-filter"
            aria-label="試行を検索"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="絞り込み（task / condition / trial）"
            className="w-full px-2 py-1 bg-surface-sunken border border-surface-border rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent/40"
          />
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {!runSel && <div className="p-4 text-xs text-text-tertiary">左の run を選んでください</div>}
          {detail.loading && !detail.data && (
            <div className="p-4">
              <Spinner />
            </div>
          )}
          {detail.error && (
            <div className="p-4">
              <ErrorText>{detail.error}</ErrorText>
            </div>
          )}
          {runSel &&
            trials.map((t) => (
              <button
                key={`${t.task}/${t.condition}/${t.trialDir}`}
                type="button"
                onClick={() => onPickLegacy(runSel.runId, t)}
                className="w-full text-left px-3 py-1.5 border-b border-surface-border/50 hover:bg-surface-overlay text-xs"
              >
                <span className="mr-2"><TaskOutcomeBadge verdict={t.taskVerdict ?? 'unknown'} /></span>
                <span className="text-text-primary">{t.task}</span>
                <span className="mx-1 text-text-tertiary">/</span>
                <span className="text-text-primary">{t.condition}</span>
                <span className="mx-1 text-text-tertiary">/</span>
                <span className="font-mono text-text-secondary">{t.trialDir}</span>
                {t.note && <span className="ml-2 text-text-tertiary">{t.note}</span>}
              </button>
            ))}
          {runSel && detail.data !== null && trials.length === 0 && <div className="p-4 text-xs text-text-tertiary">trial がありません</div>}
        </div>
      </div>
    </div>
  );
}
