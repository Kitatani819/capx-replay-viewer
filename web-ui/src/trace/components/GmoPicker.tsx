import { remoteName } from '../../navigation/site';
/** GMO discovery and imports inside the trial picker. Transfers stay on the server. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { dateHeading, dateKey, listOptionValue, matchesPeriod, type DateFilter, type Period } from '../../listFilters';
import { GmoDisabledError, errorText, gmoApi, type GmoConfigResponse, type GmoJob, type GmoScope, type GmoSettings } from '../api';
import { fmtBytes, fmtWall } from '../format';
import { useAsync, useInterval } from '../hooks';
import { remoteListingText } from '../remoteListing';
import { episodeVerdict, VERDICT_LABELS, type TaskVerdict } from '../outcome';
import { Badge, ErrorText, SmallButton, Spinner } from './common';
import { TaskOutcomeBadge } from './TaskOutcomeBadge';

interface GmoPickerProps {
  initialConfig: GmoConfigResponse | null;
  configError: string | null;
  onConfigChange: () => void;
  onRetryConfig: () => void;
  onDisabled: () => void;
  onPick: (runId: string, episodeId: string) => void;
}

interface SettingsDraft {
  sharedRoot: string;
  host: string;
  port: string;
  identityFile: string;
  mine: string;
  team: string;
  interval: string;
}

function settingsDraft(settings?: GmoSettings): SettingsDraft {
  return {
    sharedRoot: settings?.shared_root ?? '~/shared-storage/traces',
    host: settings?.host ?? 'gmo', port: settings?.port?.toString() ?? '',
    identityFile: settings?.identity_file ?? '', mine: settings?.mine.join('\n') ?? '',
    team: settings?.team.join('\n') ?? '',
    interval: String(settings?.interval_s ?? 120),
  };
}

const rowKey = (row: { run_id: string; episode_id: string }) => `${row.run_id}\0${row.episode_id}`;
const activeJob = (job: GmoJob) => job.state === 'queued' || job.state === 'running';
const LOCAL_LABELS = { remote: '未取得', local: '取り込み済み', stale: '更新あり', fetching: '取り込み中' };
const INPUT_CLASS = 'w-full px-2 py-1 bg-surface-sunken border border-surface-border rounded text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent/40';
const INTERVAL_OPTIONS = [
  { value: 60, label: '1 分' },
  { value: 120, label: '2 分（既定）' },
  { value: 300, label: '5 分' },
  { value: 0, label: '取り込まない' },
];

export function GmoPicker({ initialConfig, configError, onConfigChange, onRetryConfig, onDisabled, onPick }: GmoPickerProps) {
  const [config, setConfig] = useState(initialConfig);
  const [settingsOpen, setSettingsOpen] = useState(!initialConfig?.configured);
  const [patternsOpen, setPatternsOpen] = useState(() => !initialConfig?.settings.shared_root && !!(initialConfig?.settings.mine.length || initialConfig?.settings.team.length));
  const [draft, setDraft] = useState(() => settingsDraft(initialConfig?.settings));
  const [saving, setSaving] = useState(false);
  const [autoSaving, setAutoSaving] = useState(false);
  const [autoActionError, setAutoActionError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const [checkMessage, setCheckMessage] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [scope, setScope] = useState<GmoScope>('all');
  const [resultFilter, setResultFilter] = useState<TaskVerdict | 'all'>('all');
  const [query, setQuery] = useState('');
  const [dateFilter, setDateFilter] = useState<DateFilter>({ period: 'all', from: '', to: '' });
  const [taskFilter, setTaskFilter] = useState('all');
  const [runFilter, setRunFilter] = useState('all');
  const [visibleCount, setVisibleCount] = useState(100);
  useEffect(() => setVisibleCount(100), [scope, resultFilter, query, dateFilter, taskFilter, runFilter]);
  // null marks the POST in flight; job ids are reconciled through /jobs or the list.
  const [pending, setPending] = useState<Record<string, string | null>>({});
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const refreshNext = useRef(false);
  const seenJobs = useRef(new Map<string, GmoJob['state']>());
  const reconciledJobs = useRef(new Set<string>());
  const missingJobs = useRef(new Set<string>());
  const recheckedSnapshot = useRef<GmoJob[] | null>(null);
  const actions = useRef(new Set<AbortController>());
  const savingRef = useRef(false);
  const autoSavingRef = useRef(false);
  const seenAutoRun = useRef<string | null>(null);
  const seenListingFetchedAt = useRef<string | null>(null);

  useEffect(() => {
    if (!initialConfig) return;
    setConfig(initialConfig);
    setDraft(settingsDraft(initialConfig.settings));
    setPatternsOpen(!initialConfig.settings.shared_root && !!(initialConfig.settings.mine.length || initialConfig.settings.team.length));
    if (!initialConfig.configured) setSettingsOpen(true);
  }, [initialConfig]);
  useEffect(() => () => {
    for (const controller of actions.current) controller.abort();
    actions.current.clear();
  }, []);

  const configured = config?.configured === true;
  const handleError = (error: unknown, signal: AbortSignal) => {
    if (!signal.aborted && error instanceof GmoDisabledError) onDisabled();
    throw error;
  };
  const listing = useAsync(configured ? async (signal) => {
    const refresh = refreshNext.current;
    refreshNext.current = false;
    // Only a list requested after a job disappeared can release its pending row.
    const recheckingJobs = new Set(missingJobs.current);
    try {
      const rows = await gmoApi.episodes('all', refresh, signal);
      const status = await gmoApi.listingStatus(signal);
      return { rows, status, recheckingJobs };
    } catch (error) { return handleError(error, signal); }
  } : null, [config?.settings]);
  const remoteStatus = listing.data?.status;
  useInterval(listing.poll, remoteStatus?.refreshing || (remoteStatus && !remoteStatus.fetched_at && !remoteStatus.error) ? 2000 : 30_000, configured);
  useEffect(() => {
    const fetchedAt = remoteStatus?.fetched_at;
    if (!fetchedAt || seenListingFetchedAt.current === fetchedAt) return;
    seenListingFetchedAt.current = fetchedAt;
    // A refresh can finish between the rows and status reads. Read its rows
    // once more when that completion is observed, including the cold start.
    listing.reload();
  }, [remoteStatus?.fetched_at, listing.reload]);
  const jobs = useAsync(configured ? async (signal) => {
    try { return await gmoApi.jobs(signal); }
    catch (error) { return handleError(error, signal); }
  } : null, [config?.settings]);
  const auto = useAsync(config ? async (signal) => {
    try { return await gmoApi.auto(signal); }
    catch (error) { return handleError(error, signal); }
  } : null, [config?.settings]);
  useInterval(auto.poll, 5000, config !== null);
  useInterval(() => setNow(Date.now()), 1000, !!auto.data?.enabled && !auto.data.paused);
  useEffect(() => {
    if (!auto.data?.last_run_at) return;
    const run = JSON.stringify([auto.data.last_run_at, auto.data.running, auto.data.queued_in_last_run]);
    if (seenAutoRun.current === run) return;
    seenAutoRun.current = run;
    // A scan can enqueue jobs after this tab's last snapshot. Reconcile the
    // shared jobs and list once per change, using a cached listing if available.
    listing.reload();
    jobs.reload();
  }, [auto.data, listing.reload, jobs.reload]);

  const reloadList = () => { refreshNext.current = true; listing.reload(); };
  const hasActiveJobs = jobs.data?.some(activeJob) || Object.keys(pending).length > 0 || listing.data?.rows.some(row => row.local_state === 'fetching') === true;
  useInterval(jobs.poll, 1000, configured && hasActiveJobs);
  useEffect(() => {
    if (!jobs.data) return;
    let finished = false;
    const completed = new Set<string>();
    const latest = new Set<string>();
    const ids = new Set(jobs.data.map(job => job.job_id));
    const activeKeys = new Set(jobs.data.filter(activeJob).map(rowKey));
    missingJobs.current = new Set(Object.values(pendingRef.current).filter((id): id is string => id !== null && !ids.has(id)));
    for (const job of jobs.data) {
      const key = rowKey(job);
      const isLatest = !latest.has(key);
      latest.add(key);
      if (!activeJob(job)) {
        const previous = seenJobs.current.get(job.job_id);
        // The first jobs snapshot can already be terminal even though the list
        // was read during the transfer. Reconcile that snapshot once as well.
        const listedFetching = isLatest && listing.data?.rows.some(row => rowKey(row) === key && row.local_state === 'fetching');
        if (previous === 'queued' || previous === 'running' || Object.values(pendingRef.current).includes(job.job_id) || (listedFetching && !reconciledJobs.current.has(job.job_id))) {
          finished = true;
          reconciledJobs.current.add(job.job_id);
        }
        completed.add(job.job_id);
      }
      seenJobs.current.set(job.job_id, job.state);
    }
    if (Object.values(pendingRef.current).some(id => id !== null && completed.has(id))) {
      setPending(previous => Object.fromEntries(Object.entries(previous).filter(([, id]) => id === null || !completed.has(id))));
    }
    // /jobs retains only 50 records; a missing job may still be queued or running.
    // Even a cached episode list checks the server's full pending set, so a
    // missing active job does not require a fresh SSH listing on every tick.
    const needsRecheck = missingJobs.current.size > 0 || listing.data?.rows.some(row => row.local_state === 'fetching' && !activeKeys.has(rowKey(row)));
    if (finished || (needsRecheck && recheckedSnapshot.current !== jobs.data)) {
      recheckedSnapshot.current = jobs.data;
      if (finished) refreshNext.current = true;
      listing.reload();
    }
  }, [jobs.data, listing.data, listing.reload]);
  useEffect(() => {
    if (!listing.data?.recheckingJobs.size) return;
    const { rows, recheckingJobs } = listing.data;
    const fetching = new Set(rows.filter(row => row.local_state === 'fetching').map(rowKey));
    if (Object.entries(pendingRef.current).some(([key, id]) => id !== null && recheckingJobs.has(id) && !fetching.has(key))) {
      setPending(previous => Object.fromEntries(Object.entries(previous).filter(([key, id]) => id === null || !recheckingJobs.has(id) || fetching.has(key))));
    }
  }, [listing.data]);

  const latestJobs = useMemo(() => {
    const result = new Map<string, GmoJob>();
    // /jobs is newest first, including repeated imports of the same episode.
    for (const job of jobs.data ?? []) if (!result.has(rowKey(job))) result.set(rowKey(job), job);
    return result;
  }, [jobs.data]);
  // Relative date filters change only when the local calendar day changes.
  const filterDate = new Date(Date.now());
  filterDate.setHours(0, 0, 0, 0);
  const filterNow = filterDate.getTime();
  const tasks = [...new Set((listing.data?.rows ?? []).map(row => row.task).filter((task): task is string => !!task))].sort();
  const runIds = [...new Set((listing.data?.rows ?? []).map(row => row.run_id))];
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (listing.data?.rows ?? []).filter(row =>
      (scope === 'all' || row.mine === (scope === 'mine')) &&
      (resultFilter === 'all' || episodeVerdict(row) === resultFilter) &&
      (taskFilter === 'all' || listOptionValue(row.task ?? '') === taskFilter) &&
      (runFilter === 'all' || listOptionValue(row.run_id) === runFilter) &&
      matchesPeriod(row.start_wall_time, dateFilter, filterNow) &&
      (!q || [row.task, row.seed, row.owner, row.mine ? '自分' : ''].some(value => String(value ?? '').toLowerCase().includes(q))),
    // Newest first, so the first page and its date headers start from today and paging goes back in time.
    ).sort((left, right) => (right.start_wall_time ?? -Infinity) - (left.start_wall_time ?? -Infinity));
  }, [listing.data, scope, resultFilter, query, taskFilter, runFilter, dateFilter, filterNow]);
  const filtersActive = scope !== 'all' || resultFilter !== 'all' || query.trim() !== '' || dateFilter.period !== 'all' || taskFilter !== 'all' || runFilter !== 'all';
  const visibleRows = rows.slice(0, visibleCount);

  const fetchEpisode = async (runId: string, episodeId: string) => {
    const key = rowKey({ run_id: runId, episode_id: episodeId });
    if (Object.hasOwn(pendingRef.current, key)) return;
    pendingRef.current = { ...pendingRef.current, [key]: null };
    setPending(pendingRef.current);
    setRowErrors(previous => { const next = { ...previous }; delete next[key]; return next; });
    const controller = new AbortController();
    actions.current.add(controller);
    try {
      const { job_id } = await gmoApi.fetch(runId, episodeId, controller.signal);
      if (controller.signal.aborted) return;
      setPending(previous => ({ ...previous, [key]: job_id }));
      jobs.reload();
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof GmoDisabledError) onDisabled();
      setRowErrors(previous => ({ ...previous, [key]: errorText(error) }));
      setPending(previous => { const next = { ...previous }; delete next[key]; return next; });
    } finally { actions.current.delete(controller); }
  };

  const toggleAuto = async (paused: boolean) => {
    if (autoSavingRef.current) return;
    autoSavingRef.current = true;
    setAutoSaving(true);
    setAutoActionError(null);
    const controller = new AbortController();
    actions.current.add(controller);
    try {
      await gmoApi.setAutoPaused(paused, controller.signal);
      if (!controller.signal.aborted) auto.reload();
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof GmoDisabledError) onDisabled();
      setAutoActionError(errorText(error));
    } finally {
      actions.current.delete(controller);
      autoSavingRef.current = false;
      if (!controller.signal.aborted) setAutoSaving(false);
    }
  };

  const saveAndCheck = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setCheckMessage(null);
    setCheckError(null);
    const controller = new AbortController();
    actions.current.add(controller);
    const lines = (text: string) => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    try {
      const saved = await gmoApi.saveConfig({
        shared_root: draft.sharedRoot.trim(),
        submission_root: config?.settings.submission_root ?? '~/shared-storage/submission_evals/_viewer',
        host: draft.host.trim(), port: draft.port.trim() ? Number(draft.port) : null,
        identity_file: draft.identityFile.trim() || null, mine: lines(draft.mine), team: lines(draft.team),
        interval_s: Number(draft.interval),
      }, controller.signal);
      if (controller.signal.aborted) return;
      setConfig(saved);
      onConfigChange();
      const checked = await gmoApi.check(controller.signal);
      if (controller.signal.aborted) return;
      if (checked.ok) {
        setCheckMessage(`接続できました：自分 ${checked.mine_episodes} 件、チーム ${checked.team_episodes} 件`);
        reloadList();
      } else setCheckError(checked.error || '接続を確認できませんでした');
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof GmoDisabledError) onDisabled();
      setCheckError(errorText(error));
    } finally {
      actions.current.delete(controller);
      savingRef.current = false;
      if (!controller.signal.aborted) setSaving(false);
    }
  };

  const initialConfigError = !config ? configError : null;
  const connectionError = checkError || listing.error || listing.data?.status.error || initialConfigError;
  const connectionStatus = saving ? '接続を確認中…' : connectionError ? '接続エラー' : !configured ? '未設定' : listing.data || checkMessage ? '接続できました' : listing.loading ? '接続中…' : '未確認';
  const updateDraft = (key: keyof SettingsDraft, value: string) => setDraft(previous => ({ ...previous, [key]: value }));
  const configuredInterval = config?.settings.interval_s ?? 120;
  const customInterval = !INTERVAL_OPTIONS.some(option => option.value === configuredInterval);
  const autoStatus = auto.data;
  const autoFollowing = autoStatus?.enabled === true && !autoStatus.paused;
  const secondsUntilNext = autoStatus?.next_run_at ? Math.max(0, Math.ceil((Date.parse(autoStatus.next_run_at) - now) / 1000)) : null;
  const autoError = autoActionError || auto.error || autoStatus?.last_error;
  const skippedLarge = new Set(autoStatus?.skipped_large.map(rowKey));
  const usingDefaults = config?.settings.host === 'gmo' && config.settings.port === null
    && config.settings.identity_file === null && config.settings.shared_root === '~/shared-storage/traces'
    && config.settings.submission_root === '~/shared-storage/submission_evals/_viewer'
    && !config.settings.mine.length && !config.settings.team.length && config.settings.interval_s === 120;

  return (
    <div className="flex-1 min-h-0 min-w-0 flex flex-col overflow-y-auto">
      <div className="flex-shrink-0 flex flex-wrap items-center gap-2 px-3 py-2 border-b border-surface-border">
        <span role="status" className="text-xs text-text-secondary">接続の状態：{connectionStatus}</span>
        {remoteStatus && <span role="status" className="text-[11px] text-text-tertiary">{remoteListingText(remoteStatus)}</span>}
        <div className="ml-auto flex gap-2">
          <SmallButton onClick={reloadList} disabled={!configured || listing.loading || remoteStatus?.refreshing || saving}>一覧を更新</SmallButton>
          <SmallButton active={settingsOpen} onClick={() => setSettingsOpen(previous => !previous)}>接続設定</SmallButton>
        </div>
      </div>
      {config && <section aria-label="自動取り込み" className="flex-shrink-0 px-3 py-2 border-b border-surface-border text-xs text-text-secondary">
        <label className="flex items-center gap-2">
          <input type="checkbox" aria-label="自分の試行を自動で取り込む" checked={autoFollowing} disabled={!autoStatus?.enabled || autoSaving || saving} onChange={event => void toggleAuto(!event.target.checked)} />
          自分の試行を自動で取り込む
          {autoSaving && <span>変更中…</span>}
        </label>
        <p className="mt-1 text-[11px]">
          <span role="status">{!autoStatus ? '自動取り込みの状態を確認中…' : !autoStatus.enabled ? autoStatus.interval_s === 0 ? '自動取り込みは無効です（間隔 0 秒）' : '接続先と共有の記録フォルダー、または自分の記録の場所を設定してください' : autoStatus.paused ? '自動取り込みは一時停止中' : autoStatus.running ? '自動取り込み：巡回中…' : '次の巡回を待っています'}</span>
          {autoFollowing && !autoStatus?.running && secondsUntilNext !== null && <span> · 次の巡回まで {secondsUntilNext} 秒</span>}
        </p>
        {autoStatus && <p className="mt-1 text-[11px]">{autoStatus.last_run_at ? `最後の巡回：${fmtWall(autoStatus.last_run_at)} · ${autoStatus.queued_in_last_run} 件を取り込みキューに登録` : 'まだ巡回していません'}</p>}
        {!!autoStatus?.skipped_large.length && <p className="mt-1 text-[11px] text-amber-500">大きいため手動：{autoStatus.skipped_large.length} 件（1 回の巡回は 1 GiB 未満）</p>}
        {autoError && <div role="alert" className="mt-1"><ErrorText>自動取り込み：{autoError}</ErrorText></div>}
      </section>}
      {settingsOpen && (
        <section aria-label={`${remoteName()} の接続設定`} className="flex-shrink-0 px-3 py-3 border-b border-surface-border bg-surface-raised">
          <h3 className="text-xs font-bold text-text-primary mb-2">{remoteName()} の接続設定</h3>
          <p className="mb-2 text-xs text-text-secondary">{usingDefaults ? '既定の設定を使っています。Host gmo が設定済みなら入力は不要です。' : 'Host gmo が設定済みなら、接続先 gmo と共有フォルダー ~/shared-storage/traces で使えます。'}</p>
          {initialConfigError && <div role="alert" className="mb-2"><ErrorText>{initialConfigError}</ErrorText><SmallButton onClick={onRetryConfig}>設定を読み直す</SmallButton></div>}
          <form onSubmit={event => { event.preventDefault(); void saveAndCheck(); }}>
            <fieldset disabled={saving} className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs text-text-secondary">
              <div className="sm:col-span-2 space-y-1">
                <label htmlFor="gmo-shared-root">共有の記録フォルダー</label>
                <input id="gmo-shared-root" name="gmo-shared-root" aria-label="共有の記録フォルダー" aria-describedby="gmo-shared-root-help" value={draft.sharedRoot} onChange={event => updateDraft('sharedRoot', event.target.value)} placeholder="~/shared-storage/traces" className={`${INPUT_CLASS} font-mono`} />
                <p id="gmo-shared-root-help" className="text-text-tertiary">記録の場所はここだけで設定できます。この下の {remoteName()} のユーザー名フォルダーから、自分とチームの記録を探します。絶対パスか ~/ で始まるパスを 1 つ指定してください。~/ は {remoteName()} 側のホームです。空欄にすると共有フォルダーを使いません。</p>
              </div>
              <label className="space-y-1">接続先<input aria-label="接続先" name="gmo-host" required value={draft.host} onChange={event => updateDraft('host', event.target.value)} placeholder="host-alias または user@host" className={INPUT_CLASS} /></label>
              <label className="space-y-1">ポート<input aria-label="ポート" name="gmo-port" type="number" min="1" max="65535" step="1" value={draft.port} onChange={event => updateDraft('port', event.target.value)} placeholder="SSH の設定を使う" className={INPUT_CLASS} /></label>
              <label className="space-y-1">鍵ファイル<input aria-label="鍵ファイル" name="gmo-identity-file" value={draft.identityFile} onChange={event => updateDraft('identityFile', event.target.value)} placeholder="/path/to/private_key（省略可）" className={INPUT_CLASS} /></label>
              <div className="space-y-1">
                <label htmlFor="gmo-interval">自動取り込みの間隔</label>
                <select id="gmo-interval" name="gmo-interval" value={draft.interval} onChange={event => updateDraft('interval', event.target.value)} aria-describedby={draft.interval === '0' ? 'gmo-interval-help' : undefined} className={INPUT_CLASS}>
                  {INTERVAL_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  {customInterval && <option value={configuredInterval}>{configuredInterval % 60 === 0 ? `${configuredInterval / 60} 分` : `${configuredInterval} 秒`}（設定ファイルの値）</option>}
                </select>
                {draft.interval === '0' && <p id="gmo-interval-help" className="text-text-tertiary">保存すると自動取り込みが止まります。</p>}
              </div>
              <details open={patternsOpen} onToggle={event => setPatternsOpen(event.currentTarget.open)} className="sm:col-span-2">
                <summary className="cursor-pointer">場所を個別に指定する（詳細）</summary>
                <p className="mt-2 text-text-tertiary">共有フォルダーに加えて探す場所を指定できます。自分とチームの両方に当てはまる記録は自分の記録として扱います。</p>
                <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="space-y-1">自分の記録の場所<textarea aria-label="自分の記録の場所" name="gmo-mine" rows={3} value={draft.mine} onChange={event => updateDraft('mine', event.target.value)} placeholder="/path/to/mine/*/traces" className={`${INPUT_CLASS} font-mono`} /><span className="text-text-tertiary">1 行に 1 つ。* や ? を使えます。</span></label>
                  <label className="space-y-1">チームの記録の場所<textarea aria-label="チームの記録の場所" name="gmo-team" rows={3} value={draft.team} onChange={event => updateDraft('team', event.target.value)} placeholder="/path/to/team/*/traces" className={`${INPUT_CLASS} font-mono`} /><span className="text-text-tertiary">1 行に 1 つ。* や ? を使えます。</span></label>
                </div>
              </details>
              <div className="sm:col-span-2"><button type="submit" className="px-2 py-1 rounded border border-surface-border-light bg-surface-sunken text-xs text-text-secondary hover:text-text-primary disabled:opacity-40">{saving ? '保存して確認中…' : '保存して確かめる'}</button></div>
            </fieldset>
          </form>
          {checkMessage && <p role="status" className="mt-2 text-xs text-nv-green">{checkMessage}</p>}
          {checkError && <div role="alert" className="mt-2"><ErrorText>{checkError}</ErrorText></div>}
          <p className="mt-3 text-[11px] text-text-secondary">自動取り込みは自分の記録だけが対象です。チームの試行は「取り込む」「更新を取り込む」で取り込めます。</p>
          <p className="mt-3 text-[11px] text-text-secondary">鍵は ssh-agent に読み込ませておく必要があります。この画面ではパスフレーズは聞けません。</p>
          <details className="mt-2 text-[11px] text-text-tertiary"><summary className="cursor-pointer">~/.ssh/config の例</summary><pre className="mt-1 p-2 rounded bg-surface-sunken overflow-x-auto">{'Host gmo\n  HostName <host>\n  User <user>\n  Port <port>\n  IdentityFile ~/.ssh/id_ed25519_gmo\n  IdentitiesOnly yes'}</pre></details>
        </section>
      )}
      {listing.error && <div role="alert" className="px-3 py-2"><ErrorText>一覧を取得できませんでした：{listing.error}</ErrorText></div>}
      {remoteStatus?.error && <div role="status" className="px-3 py-2"><ErrorText>{remoteName()} の一覧を更新できませんでした：{remoteStatus.error}</ErrorText></div>}
      {jobs.error && <div role="alert" className="px-3 py-2"><ErrorText>取り込み状況を確認できませんでした：{jobs.error}</ErrorText><SmallButton onClick={jobs.reload}>取り込み状況を再確認</SmallButton></div>}
      {configured && <>
        <div className="trial-list-filters flex-shrink-0 px-3 py-2 border-b border-surface-border">
          <select aria-label={`${remoteName()} の範囲`} value={scope} onChange={event => setScope(event.target.value as GmoScope)} className="rounded border border-surface-border bg-surface-sunken p-1 text-xs">
            <option value="all">すべて</option><option value="mine">自分</option><option value="team">チーム</option>
          </select>
          <select aria-label={`${remoteName()} の結果で絞り込み`} value={resultFilter} onChange={event => setResultFilter(event.target.value as TaskVerdict | 'all')} className="rounded border border-surface-border bg-surface-sunken p-1 text-xs">
            <option value="all">すべての結果</option>{Object.entries(VERDICT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <label>期間<select aria-label="期間" value={dateFilter.period} onChange={event => setDateFilter(previous => ({ ...previous, period: event.target.value as Period }))}>
            <option value="all">すべて</option><option value="today">今日</option><option value="3d">過去3日</option><option value="7d">過去7日</option><option value="custom">日付を指定</option>
          </select></label>
          {dateFilter.period === 'custom' && <><label>開始日<input type="date" aria-label="開始日" max={dateFilter.to || undefined} value={dateFilter.from} onChange={event => setDateFilter(previous => ({ ...previous, from: event.target.value }))} /></label><label>終了日<input type="date" aria-label="終了日" min={dateFilter.from || undefined} value={dateFilter.to} onChange={event => setDateFilter(previous => ({ ...previous, to: event.target.value }))} /></label></>}
          <label>タスク<select aria-label="タスク" value={taskFilter} onChange={event => setTaskFilter(event.target.value)}><option value="all">すべて</option>{tasks.map(task => <option key={task} value={listOptionValue(task)}>{task}</option>)}</select></label>
          <label>評価<select aria-label="評価" value={runFilter} onChange={event => setRunFilter(event.target.value)}><option value="all">すべて</option>{runIds.map(run => <option key={run} value={listOptionValue(run)}>{run}</option>)}</select></label>
          <input type="search" name="gmo-filter" aria-label={`${remoteName()} の試行を検索`} value={query} onChange={event => setQuery(event.target.value)} placeholder="絞り込み（task / seed / 実行者）" className={`${INPUT_CLASS} flex-1 min-w-40`} />
        </div>
        {listing.data && <p role="status" className="trial-list-count">{filtersActive ? `${listing.data.rows.length} 件中 ${rows.length} 件` : `${listing.data.rows.length} 件`}</p>}
        {/* Only the first load shows a spinner; the 2 s polls while GMO refreshes are reported in the status line and must not shift the rows. */}
        {listing.loading && !listing.data && <div className="p-3"><Spinner label="一覧を読み込み中" /></div>}
        <div className="trial-list-scroll min-h-0 overflow-x-auto">
          <table aria-label={`${remoteName()} の試行`} className="w-full text-xs">
            <thead className="sticky top-0 bg-surface-raised"><tr className="text-left text-text-tertiary border-b border-surface-border">
              {['手元の状態', '結果', 'task・seed', '実行者', '開始時刻', '大きさ', '操作'].map(label => <th key={label} scope="col" className="py-1.5 px-3 font-normal whitespace-nowrap">{label}</th>)}
            </tr></thead>
            <tbody>{visibleRows.flatMap((row, index) => {
              const key = rowKey(row);
              const job = latestJobs.get(key);
              const busy = Object.hasOwn(pending, key) || (job && activeJob(job)) || row.local_state === 'fetching';
              // Total size cannot predict the changed-file transfer size; the server enforces its limit.
              const reason = row.conflict ? `同じ run ID が ${remoteName()} の複数の場所にあるため取り込めません` : null;
              const localState = busy ? 'fetching' : row.local_state;
              const error = rowErrors[key] || (!busy && job?.state === 'failed' ? job.error || '取り込みに失敗しました' : null);
              return [
                (index === 0 || dateKey(visibleRows[index - 1].start_wall_time) !== dateKey(row.start_wall_time)) ? <tr key={`date-${index}`} className="trial-date-heading"><th scope="rowgroup" colSpan={7}>{dateHeading(row.start_wall_time)}</th></tr> : null,
                <tr key={`${key}\0${index}`} className="border-b border-surface-border/50 align-top">
                <td className="py-2 px-3"><Badge tone={localState === 'local' ? 'green' : localState === 'stale' ? 'amber' : localState === 'fetching' ? 'gold' : 'neutral'}>{LOCAL_LABELS[localState]}</Badge>
                  {row.mine && row.status === 'running' && autoFollowing && !row.conflict && !skippedLarge.has(key) && <p className="mt-1 text-[11px] text-nv-green">自動で追従中</p>}
                  {skippedLarge.has(key) && <p className="mt-1 text-[11px] text-amber-500">大きいため手動</p>}
                </td>
                <td className="py-2 px-3"><TaskOutcomeBadge verdict={episodeVerdict(row)} /></td>
                <td className="py-2 px-3"><div>{row.task ?? '—'} · seed {row.seed ?? '—'}</div><div className="text-[11px] text-text-tertiary font-mono break-all">{row.run_id} / {row.episode_id}</div></td>
                <td className="py-2 px-3">{row.mine ? '自分' : row.owner || '—'}</td>
                <td className="py-2 px-3 whitespace-nowrap">{fmtWall(row.start_wall_time)}</td>
                <td className="py-2 px-3 whitespace-nowrap">{row.size_approximate ? '約 ' : ''}{fmtBytes(row.size_bytes)}</td>
                <td className="py-2 px-3"><div className="flex flex-wrap gap-1 whitespace-nowrap"><SmallButton disabled={!!reason || !!busy} title={reason ?? undefined} onClick={() => row.local_state === 'local' ? onPick(row.run_id, row.episode_id) : void fetchEpisode(row.run_id, row.episode_id)}>{busy ? '取り込み中…' : row.local_state === 'local' ? '開く' : row.local_state === 'stale' ? '更新を取り込む' : '取り込む'}</SmallButton></div>
                  {reason && <p className="mt-1 text-[11px] text-text-secondary">{reason}</p>}
                  {error && <div role="alert" className="mt-1"><ErrorText>{error}</ErrorText></div>}
                  {job?.note && <p className="mt-1 text-[11px] text-text-tertiary break-all">{job.note}</p>}
                </td>
              </tr>];
            })}</tbody>
          </table>
          {rows.length > visibleCount && <button type="button" className="trial-list-more" onClick={() => setVisibleCount(previous => previous + 100)}>さらに表示（残り {rows.length - visibleCount} 件）</button>}
          {listing.data && rows.length === 0 && <p className="p-4 text-xs text-text-tertiary">該当する試行がありません</p>}
        </div>
      </>}
    </div>
  );
}
