/** GMO picker flows against the API contract, with a virtual polling clock. */
import test from 'node:test';
import assert from 'node:assert/strict';
import TraceViewerPage from '../TraceViewerPage';
import { Picker, type PickerMode } from '../components/Picker';
import { GmoPicker } from '../components/GmoPicker';
import { TopBar } from '../components/TopBar';
import { SmallButton, Spinner } from '../components/common';
import { TaskOutcomeBadge } from '../components/TaskOutcomeBadge';
import type { GmoAutoStatus, GmoConfigResponse, GmoEpisodeSummary, GmoJob, GmoSettings } from '../api';
import { advance, findAll, net, propsOf, resetBrowser, setLocation, type FakeElement } from './harness/browser';
import { mount } from './harness/fakeReact';
import { addEpisode, ev, makeRun, serve } from './pageServer';

const browserFetch = globalThis.fetch;
interface SentRequest { path: string; method: string; headers: Headers; body: unknown }
function settings(overrides: Partial<GmoSettings> = {}): GmoSettings {
  return { host: 'gmo', port: null, identity_file: null, mine: ['/mine/traces'], team: ['/team/traces'], interval_s: 120, ...overrides };
}
function config(configured = true): GmoConfigResponse {
  return { enabled: true, configured, settings: configured ? settings() : settings({ host: '', mine: [], team: [] }), dest: '/local/traces', config_path: '/config/gmo.json' };
}
function episode(id: string, overrides: Partial<GmoEpisodeSummary> = {}): GmoEpisodeSummary {
  return { run_id: `run_${id}`, episode_id: id, owner: 'alice', mine: true, size_bytes: 2048,
    local_state: 'remote', conflict: false, task: `task_${id}`, seed: 7, status: 'ended',
    start_wall_time: 1790000000, end_reason: 'completed', episode: { harness_summary: { task_completed: true, sandbox_rc: 0 } }, ...overrides };
}
function job(row: GmoEpisodeSummary, overrides: Partial<GmoJob> = {}): GmoJob {
  return { job_id: 'job_1', run_id: row.run_id, episode_id: row.episode_id, state: 'queued', bytes: 0,
    error: null, note: null, started_at: null, finished_at: null, ...overrides };
}
function setup(rows: GmoEpisodeSummary[] = [], configured = true) {
  resetBrowser();
  const state = { config: config(configured), disabled: false, configError: '', configStatus: 502, configLatency: 5,
    legacyRuns: [] as { run_id: string; root_index: number; n_trials: number }[], legacyError: false, legacyLatency: 5,
    rows, jobs: [] as GmoJob[],
    auto: { enabled: configured, paused: false, interval_s: 120, running: false, last_run_at: null,
      next_run_at: new Date(Date.now() + 120_000).toISOString(), last_error: null, queued_in_last_run: 0, skipped_large: [] } as GmoAutoStatus,
    check: { ok: true, mine_episodes: 2, team_episodes: 3, error: null as string | null },
    saveError: '', fetchError: '', fetchStatus: 502, autoError: '', autoReadError: '', sent: [] as SentRequest[] };
  let nextJob = 1;
  globalThis.fetch = (input, init) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    state.sent.push({ path, method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) as unknown : null });
    return browserFetch(input, init);
  };
  net.handler = req => {
    const sent = state.sent[state.sent.length - 1];
    if (req.path === '/api/traces/runs') return { json: { runs: [{ run_id: 'local_run', n_episodes: 1 }] } };
    if (req.path === '/api/traces/legacy/runs') return state.legacyError
      ? { status: 500, json: { detail: 'Legacy list unavailable' }, latency: state.legacyLatency }
      : { json: { roots: [], runs: state.legacyRuns }, latency: state.legacyLatency };
    if (!req.path.startsWith('/api/gmo/')) return null;
    if (state.disabled) return { status: 404, json: { detail: 'Not Found' } };
    if (req.path === '/api/gmo/auto') {
      if (sent.method === 'PUT') {
        if (state.autoError) return { status: 502, json: { detail: state.autoError } };
        state.auto = { ...state.auto, paused: (sent.body as { paused: boolean }).paused };
      } else if (state.autoReadError) return { status: 502, json: { detail: state.autoReadError } };
      return { json: state.auto };
    }
    if (req.path === '/api/gmo/config') {
      if (state.configError) return { status: state.configStatus, json: { detail: state.configError }, latency: state.configLatency };
      if (sent.method === 'PUT') {
        if (state.saveError) return { status: 400, json: { detail: state.saveError } };
        const saved = sent.body as GmoSettings;
        state.config = { ...state.config, settings: saved, configured: Boolean(saved.host && (saved.mine.length || saved.team.length)) };
        state.auto = { ...state.auto, interval_s: saved.interval_s, enabled: Boolean(saved.host && saved.mine.length && saved.interval_s > 0) };
      }
      return { json: state.config, latency: state.configLatency };
    }
    if (req.path === '/api/gmo/check') return { json: state.check };
    if (req.path === '/api/gmo/episodes') return { json: state.rows };
    if (req.path === '/api/gmo/jobs') return { json: state.jobs };
    if (req.path === '/api/gmo/fetch') {
      if (state.fetchError) return { status: state.fetchStatus, json: { detail: state.fetchError } };
      const body = sent.body as { run_id: string; episode_id: string };
      const row = state.rows.find(item => item.run_id === body.run_id && item.episode_id === body.episode_id)!;
      state.jobs = [job(row, { job_id: `job_${nextJob++}` }), ...state.jobs].slice(0, 50);
      return { json: { job_id: state.jobs[0].job_id } };
    }
    return null;
  };
  return state;
}
function text(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (typeof node === 'object' && 'props' in node) return text((node as FakeElement).props.children);
  return '';
}
function button(node: unknown, label: string): FakeElement {
  const result = [...findAll(node, SmallButton), ...findAll(node, 'button')].find(el => text(el.props.children) === label);
  assert.ok(result, `button ${label} exists`);
  return result!;
}
function click(node: unknown, label: string): void {
  const el = button(node, label);
  assert.notEqual(el.props.disabled, true, `${label} is enabled`);
  (el.props.onClick as (event: unknown) => void)({ stopPropagation() {}, preventDefault() {} });
}
function change(node: unknown, label: string, value: string): void {
  const inputs = ['input', 'select', 'textarea'].flatMap(type => findAll(node, type));
  let input = inputs.find(el => el.props['aria-label'] === label);
  if (!input) {
    const fieldLabel = findAll(node, 'label').find(el => text(el).trim() === label || text(el).startsWith(label));
    input = fieldLabel && (inputs.find(el => el.props.id === fieldLabel.props.htmlFor) ?? ['input', 'select', 'textarea'].flatMap(type => findAll(fieldLabel, type))[0]);
  }
  assert.ok(input, `field ${label} has a label`);
  (input!.props.onChange as (event: unknown) => void)({ target: { value } });
}
function rowFor(node: unknown, task: string): FakeElement {
  const row = findAll(node, 'tr').find(el => text(el).includes(task));
  assert.ok(row, `row for ${task} exists`);
  return row!;
}
function rowsOf(node: unknown): FakeElement[] { return findAll(node, 'tbody').flatMap(body => findAll(body, 'tr')); }
function mountGmo(initialConfig: GmoConfigResponse | null, onPick: (run: string, episode: string) => void = () => {}, configError: string | null = null) {
  return mount(GmoPicker, { initialConfig, configError, onConfigChange: () => {}, onRetryConfig: () => {}, onDisabled: () => {}, onPick });
}
function assertGmoHeaders(sent: SentRequest[]): void {
  const requests = sent.filter(req => req.path.startsWith('/api/gmo/'));
  assert.ok(requests.length > 0);
  for (const req of requests) {
    assert.equal(req.headers.get('X-CapX-Request'), 'gmo', `${req.method} ${req.path}`);
    if (req.method === 'POST' || req.method === 'PUT') {
      assert.equal(req.headers.get('Content-Type'), 'application/json');
      assert.ok(req.body && typeof req.body === 'object');
    }
  }
}

type PickerProps = Parameters<typeof Picker>[0];
type TopBarProps = Parameters<typeof TopBar>[0];
function pickerProps(overrides: Partial<PickerProps> = {}): PickerProps {
  return { config: null, configError: null, currentRun: null, currentEpisode: null,
    onPick: () => {}, onPickLegacy: () => {}, ...overrides };
}
function pickerTabs(node: unknown): FakeElement[] {
  return findAll(node, SmallButton).filter(el => ['GMO', '手元の記録', '古いログ（トレースなし）'].includes(text(el)));
}
function activeTab(node: unknown): string[] { return pickerTabs(node).filter(el => el.props.active).map(text); }

for (const configured of [true, false]) {
  test(`GMO is the initial tab without flashing the local list (configured=${configured})`, async () => {
    const state = setup([], configured); state.configLatency = 200;
    const page = mount(Picker, pickerProps());
    const assertPending = () => {
      assert.equal(findAll(page.output, Spinner).some(el => el.props.label === '一覧を確認中'), true);
      assert.doesNotMatch(text(page.output), /local_run|run（新しい順）|左の run を選んでください/);
      assert.deepEqual(activeTab(page.output), []);
      assert.equal(findAll(page.output, GmoPicker).length, 0);
    };
    assertPending();
    await advance(100);
    assertPending();
    await advance(100);
    assert.deepEqual(activeTab(page.output), ['GMO']);
    assert.equal(findAll(page.output, GmoPicker).length, 1);
    assert.doesNotMatch(text(page.output), /local_run|run（新しい順）/);
    assertGmoHeaders(state.sent);
    page.unmount();
  });
}

for (const initialMode of [null, 'traced'] as const) {
  test(`local recordings remain usable while GMO config is pending (${initialMode ?? 'manual selection'})`, async () => {
    const state = setup(); state.configLatency = 60_000;
    const pickerHandler = net.handler;
    const run = makeRun('local_run');
    addEpisode(run, 'e1', { status: 'ended', trace_complete: true }, []);
    serve(run); const traceHandler = net.handler;
    net.handler = req => traceHandler(req) ?? pickerHandler(req);
    const picked: string[][] = [];
    const page = mount(Picker, pickerProps({ initialMode, currentRun: run.runId,
      onPick: (runId, episodeId) => picked.push([runId, episodeId]) }));
    await advance(100);
    if (initialMode === null) {
      click(page.output, '手元の記録'); await advance(100);
    }
    assert.deepEqual(activeTab(page.output), ['手元の記録']);
    assert.equal(findAll(page.output, Spinner).some(el => el.props.label === '一覧を確認中'), false);
    assert.match(text(page.output), /local_run/);
    const episode = findAll(page.output, 'tr').find(el => el.props['aria-label'] === 'episode e1');
    assert.ok(episode, 'local episodes can be loaded before GMO config responds');
    (episode!.props.onClick as () => void)();
    assert.deepEqual(picked, [['local_run', 'e1']]);
    click(page.output, '一覧を更新'); await advance(100);
    assert.equal(net.log.filter(req => req.path === '/api/traces/runs' && req.doneAt !== null).length, 2);
    assert.equal(net.log.find(req => req.path === '/api/gmo/config')?.doneAt, null);
    await advance(state.configLatency);
    assert.ok(net.log.find(req => req.path === '/api/gmo/config')?.doneAt);
    assert.deepEqual(activeTab(page.output), ['手元の記録'], 'a late config response keeps the explicit local choice');
    page.unmount();
  });
}

for (const detail of ['Not Found', 'GMO is disabled in this deployment']) {
  test(`a GMO config 404 opens local recordings and hides GMO regardless of its body (${detail})`, async () => {
    const state = setup(); state.configError = detail; state.configStatus = 404;
    const page = mount(Picker, pickerProps()); await advance(100);
    assert.deepEqual(pickerTabs(page.output).map(text), ['手元の記録']);
    assert.deepEqual(activeTab(page.output), ['手元の記録']);
    assert.match(text(page.output), /local_run/);
    assert.doesNotMatch(text(page.output), /トレースあり|トレースなし（既存ログ）/);
    assertGmoHeaders(state.sent); page.unmount();
  });
}

test('a non-404 GMO config error falls back to local recordings but keeps GMO available to retry', async () => {
  const state = setup(); state.configError = 'GMO config unavailable';
  const page = mount(Picker, pickerProps()); await advance(100);
  assert.deepEqual(pickerTabs(page.output).map(text), ['GMO', '手元の記録']);
  assert.deepEqual(activeTab(page.output), ['手元の記録']);
  assert.match(text(page.output), /local_run/);
  click(page.output, 'GMO'); await advance(0);
  const gmo = propsOf<Parameters<typeof GmoPicker>[0]>(page.output, GmoPicker);
  assert.equal(gmo.initialConfig, null);
  assert.match(gmo.configError ?? '', /GMO config unavailable/);
  state.configError = '';
  gmo.onRetryConfig(); await advance(100);
  assert.deepEqual(activeTab(page.output), ['GMO']);
  assert.deepEqual(propsOf<Parameters<typeof GmoPicker>[0]>(page.output, GmoPicker).initialConfig, state.config);
  assertGmoHeaders(state.sent); page.unmount();
});

test('a config refresh failure keeps an already open initial GMO tab and its last config', async () => {
  const state = setup();
  const page = mount(Picker, pickerProps()); await advance(100);
  assert.deepEqual(activeTab(page.output), ['GMO']);
  state.configError = 'Config refresh unavailable';
  propsOf<Parameters<typeof GmoPicker>[0]>(page.output, GmoPicker).onConfigChange(); await advance(100);
  assert.deepEqual(activeTab(page.output), ['GMO']);
  const gmo = propsOf<Parameters<typeof GmoPicker>[0]>(page.output, GmoPicker);
  assert.deepEqual(gmo.initialConfig, state.config);
  assert.match(gmo.configError ?? '', /Config refresh unavailable/);
  page.unmount();
});

test('legacy recordings appear only for a nonempty list, in GMO, local, legacy order', async () => {
  const state = setup();
  const empty = mount(Picker, pickerProps()); await advance(100);
  assert.deepEqual(pickerTabs(empty.output).map(text), ['GMO', '手元の記録']);
  empty.unmount();
  state.legacyRuns = [{ run_id: 'old_run', root_index: 0, n_trials: 1 }];
  const nonempty = mount(Picker, pickerProps()); await advance(100);
  assert.deepEqual(pickerTabs(nonempty.output).map(text), ['GMO', '手元の記録', '古いログ（トレースなし）']);
  for (const tab of pickerTabs(nonempty.output)) assert.equal(typeof tab.props.title, 'string');
  click(nonempty.output, '古いログ（トレースなし）'); await advance(100);
  assert.deepEqual(activeTab(nonempty.output), ['古いログ（トレースなし）']);
  assert.equal(net.log.filter(req => req.path === '/api/traces/legacy/runs' && !req.aborted).length, 2,
    'each picker reads legacy availability once and shares that list with the legacy pane');
  nonempty.unmount();
});

for (const legacyError of [false, true]) {
  test(`local refresh discovers hidden legacy recordings after an initially ${legacyError ? 'failed' : 'empty'} list`, async () => {
    const state = setup(); state.legacyError = legacyError;
    const page = mount(Picker, pickerProps()); await advance(100);
    click(page.output, '手元の記録'); await advance(0);
    assert.deepEqual(pickerTabs(page.output).map(text), ['GMO', '手元の記録']);
    state.legacyError = false;
    state.legacyRuns = [{ run_id: 'old_run', root_index: 0, n_trials: 1 }];
    click(page.output, '一覧を更新'); await advance(100);
    for (const path of ['/api/traces/runs', '/api/traces/legacy/runs']) {
      assert.equal(net.log.filter(req => req.path === path && req.doneAt !== null).length, 2, path);
    }
    assert.deepEqual(activeTab(page.output), ['手元の記録']);
    assert.deepEqual(pickerTabs(page.output).map(text), ['GMO', '手元の記録', '古いログ（トレースなし）']);
    click(page.output, '古いログ（トレースなし）'); await advance(0);
    assert.deepEqual(activeTab(page.output), ['古いログ（トレースなし）']);
    page.unmount();
  });
}

for (const legacyError of [false, true]) {
  test(`a legacy trial URL keeps the old-log tab even when the list is ${legacyError ? 'unavailable' : 'empty'}`, async () => {
    const state = setup(); state.legacyError = legacyError;
    setLocation('/traces?legacy_run=old_run&legacy_trial=cube_lift/C/trial_1&legacy_root=0');
    const page = mount(TraceViewerPage, {}); await advance(100);
    propsOf<TopBarProps>(page.output, TopBar).onOpenPicker(); await advance(0);
    const props = propsOf<PickerProps>(page.output, Picker);
    assert.equal(props.currentLegacyRun, 'old_run');
    const picker = mount(Picker, props); await advance(100);
    assert.deepEqual(pickerTabs(picker.output).map(text), ['GMO', '手元の記録', '古いログ（トレースなし）']);
    picker.unmount(); page.unmount();
  });
}

for (const [label, mode] of [['GMO', 'gmo'], ['手元の記録', 'traced'], ['古いログ（トレースなし）', 'legacy']] as const) {
  test(`the page preserves the chosen ${label} tab when its picker is closed and reopened`, async () => {
    const state = setup(); state.legacyRuns = [{ run_id: 'old_run', root_index: 0, n_trials: 1 }];
    const pickerHandler = net.handler;
    const run = makeRun();
    addEpisode(run, 'e1', { status: 'ended', trace_complete: true }, [
      ev('e1', 1, 'episode_start', {}), ev('e1', 2, 'episode_end', { trace_complete: true }),
    ]);
    serve(run); const traceHandler = net.handler;
    net.handler = req => traceHandler(req) ?? pickerHandler(req);
    setLocation('/traces?run=r1&episode=e1');
    const page = mount(TraceViewerPage, {}); await advance(100);
    propsOf<TopBarProps>(page.output, TopBar).onOpenPicker(); await advance(0);
    const first = mount(Picker, propsOf<PickerProps>(page.output, Picker)); await advance(100);
    click(first.output, label); await advance(0);
    assert.deepEqual(activeTab(first.output), [label]);
    click(first.output, '閉じる'); await advance(0);
    first.unmount();
    assert.equal(findAll(page.output, Picker).length, 0);
    propsOf<TopBarProps>(page.output, TopBar).onOpenPicker(); await advance(0);
    const reopenedProps = propsOf<PickerProps>(page.output, Picker);
    assert.equal(reopenedProps.initialMode, mode satisfies PickerMode);
    const reopened = mount(Picker, reopenedProps); await advance(100);
    assert.deepEqual(activeTab(reopened.output), [label]);
    reopened.unmount(); page.unmount();

    // A fresh page may recompute its default even when the URL is unchanged.
    const reloadedPage = mount(TraceViewerPage, {}); await advance(100);
    propsOf<TopBarProps>(reloadedPage.output, TopBar).onOpenPicker(); await advance(0);
    const reset = mount(Picker, propsOf<PickerProps>(reloadedPage.output, Picker)); await advance(100);
    assert.deepEqual(activeTab(reset.output), ['GMO']);
    reset.unmount(); reloadedPage.unmount();
  });
}

test('unconfigured GMO opens the labelled connection settings without listing remotely', async () => {
  const state = setup([], false);
  const page = mountGmo(state.config); await advance(100);
  for (const label of ['接続先', 'ポート', '鍵ファイル', '自分の記録の場所', 'チームの記録の場所']) {
    assert.ok(text(page.output).includes(label), label);
  }
  assert.ok(button(page.output, '保存して確かめる'));
  assert.match(text(page.output), /~\/\.ssh\/config/);
  assert.match(text(page.output), /ssh-agent/);
  assert.match(text(page.output), /パスフレーズ/);
  assert.equal(intervalSelect(page.output).props.value, '120');
  assert.match(text(page.output), /接続先と自分の記録の場所を設定してください/);
  assert.equal(findAll(page.output, 'input').find(el => el.props.type === 'checkbox')?.props.disabled, true);
  assert.equal(state.sent.some(req => req.path === '/api/gmo/episodes'), false);
  page.unmount();
});

test('GMO lists local state, result, owner and size and filters scope, outcome, task, seed and owner', async () => {
  const state = setup([
    episode('mine'),
    episode('team', { mine: false, owner: 'bob', seed: 42, local_state: 'local', episode: { harness_summary: { task_completed: false, sandbox_rc: 0 } } }),
    episode('stale', { local_state: 'stale', status: 'running' }),
  ]);
  const page = mountGmo(state.config); await advance(100);
  assert.equal(rowsOf(page.output).length, 3);
  assert.match(text(rowFor(page.output, 'task_mine')), /未取得.*task_mine.*7.*自分/);
  assert.match(text(rowFor(page.output, 'task_mine')), /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}.*2\.0 KB/);
  assert.match(text(rowFor(page.output, 'task_team')), /取り込み済み.*bob/);
  assert.match(text(rowFor(page.output, 'task_stale')), /更新あり/);
  assert.equal(findAll(rowFor(page.output, 'task_mine'), TaskOutcomeBadge)[0].props.verdict, 'success');
  assert.equal(findAll(rowFor(page.output, 'task_team'), TaskOutcomeBadge)[0].props.verdict, 'failure');
  assert.equal(findAll(rowFor(page.output, 'task_stale'), TaskOutcomeBadge)[0].props.verdict, 'running');
  assert.match(text(page.output), /一覧の更新時刻/);
  change(page.output, 'GMO の範囲', 'mine'); await advance(0);
  assert.equal(rowsOf(page.output).length, 2);
  change(page.output, 'GMO の範囲', 'team'); await advance(0);
  assert.equal(rowsOf(page.output).length, 1);
  assert.match(text(rowsOf(page.output)[0]), /task_team/);
  change(page.output, 'GMO の範囲', 'all'); await advance(0);
  change(page.output, 'GMO の結果で絞り込み', 'failure'); await advance(0);
  assert.equal(rowsOf(page.output).length, 1);
  change(page.output, 'GMO の結果で絞り込み', 'all'); await advance(0);
  for (const query of ['task_team', '42', 'BOB']) {
    change(page.output, 'GMO の試行を検索', query); await advance(0);
    assert.equal(rowsOf(page.output).length, 1, query);
    assert.match(text(rowsOf(page.output)[0]), /task_team/);
  }
  change(page.output, 'GMO の試行を検索', 'no-such-task'); await advance(0);
  assert.equal(rowsOf(page.output).length, 0);
  click(page.output, '一覧を更新'); await advance(100);
  assert.ok(net.log.some(req => req.path === '/api/gmo/episodes' && req.query.get('refresh') === '1'));
  assertGmoHeaders(state.sent); page.unmount();
});

function autoCheckbox(node: unknown): FakeElement {
  const input = findAll(node, 'input').find(el => el.props['aria-label'] === '自分の試行を自動で取り込む');
  assert.ok(input);
  return input!;
}
function toggleAuto(node: unknown, checked: boolean): void {
  const input = autoCheckbox(node);
  assert.notEqual(input.props.disabled, true);
  (input.props.onChange as (event: unknown) => void)({ target: { checked } });
}

test('GMO shows automatic import status, own recording follow and manual large rows, and refreshes every five seconds', async () => {
  const mine = episode('recording', { status: 'running' });
  const team = episode('team_recording', { status: 'running', mine: false });
  const large = episode('large_recording', { status: 'running' });
  const state = setup([mine, team, large]);
  state.auto = { ...state.auto, last_run_at: new Date(Date.now() - 1000).toISOString(), queued_in_last_run: 2,
    skipped_large: [{ run_id: large.run_id, episode_id: large.episode_id, size_bytes: 1024 ** 3 }] };
  const page = mountGmo(state.config); await advance(100);
  assert.equal(autoCheckbox(page.output).props.checked, true);
  assert.match(text(page.output), /次の巡回まで 120 秒/);
  assert.match(text(page.output), /最後の巡回：.*2 件を取り込みキューに登録/);
  assert.match(text(page.output), /大きいため手動：1 件/);
  assert.match(text(rowFor(page.output, mine.task!)), /自動で追従中/);
  assert.doesNotMatch(text(rowFor(page.output, team.task!)), /自動で追従中/);
  assert.doesNotMatch(text(rowFor(page.output, large.task!)), /自動で追従中/);
  assert.match(text(rowFor(page.output, large.task!)), /大きいため手動/);
  const initialReads = state.sent.filter(req => req.path.endsWith('/auto')).length;
  const statusText = () => ['span', 'p', 'div'].flatMap(type => findAll(page.output, type))
    .filter(el => el.props.role === 'status').map(text);
  const waitingStatus = statusText();
  assert.ok(waitingStatus.includes('次の巡回を待っています'));
  assert.equal(waitingStatus.some(message => /次の巡回まで \d+ 秒/.test(message)), false, 'countdown stays outside live regions');
  await advance(1000);
  assert.match(text(page.output), /次の巡回まで 119 秒/);
  assert.deepEqual(statusText(), waitingStatus, 'each countdown tick leaves live-region messages unchanged');
  assert.equal(state.sent.filter(req => req.path.endsWith('/auto')).length, initialReads);
  state.auto = { ...state.auto, running: true, last_error: 'Permission denied (publickey)' };
  await advance(3800);
  assert.equal(state.sent.filter(req => req.path.endsWith('/auto')).length, initialReads);
  await advance(200);
  assert.equal(state.sent.filter(req => req.path.endsWith('/auto')).length, initialReads + 1);
  assert.match(text(page.output), /巡回中/);
  assert.ok(statusText().includes('自動取り込み：巡回中…'), 'scan state changes remain announced');
  assert.match(text(page.output), /Permission denied \(publickey\)/);
  assertGmoHeaders(state.sent);
  page.unmount();
  const readsAtClose = state.sent.length;
  await advance(10_000);
  assert.equal(state.sent.length, readsAtClose, 'closing the GMO tab stops status polling');
});

test('GMO pauses and resumes automatic imports through the guarded JSON API and preserves failed-toggle state', async () => {
  const row = episode('recording', { status: 'running' });
  const state = setup([row]);
  const page = mountGmo(state.config); await advance(100);
  toggleAuto(page.output, false); await advance(100);
  assert.equal(autoCheckbox(page.output).props.checked, false);
  assert.match(text(page.output), /一時停止中/);
  assert.doesNotMatch(text(rowFor(page.output, row.task!)), /自動で追従中/);
  toggleAuto(page.output, true); await advance(100);
  assert.equal(autoCheckbox(page.output).props.checked, true);
  assert.match(text(rowFor(page.output, row.task!)), /自動で追従中/);
  state.autoError = 'Cannot change automatic imports';
  toggleAuto(page.output, false); await advance(100);
  assert.equal(autoCheckbox(page.output).props.checked, true);
  assert.match(text(page.output), /Cannot change automatic imports/);
  assert.deepEqual(state.sent.filter(req => req.path === '/api/gmo/auto' && req.method === 'PUT').map(req => req.body),
    [{ paused: true }, { paused: false }, { paused: true }]);
  assertGmoHeaders(state.sent); page.unmount();
});

test('GMO shows zero interval and status read errors and reconciles automatically queued jobs', async () => {
  const row = episode('automatic'); const state = setup([row]);
  state.auto = { ...state.auto, enabled: false, interval_s: 0, next_run_at: null };
  const page = mountGmo(state.config); await advance(100);
  assert.equal(autoCheckbox(page.output).props.disabled, true);
  assert.match(text(page.output), /自動取り込みは無効です（間隔 0 秒）/);
  state.autoReadError = 'Automatic status unavailable';
  await advance(5000);
  assert.match(text(page.output), /Automatic status unavailable/);
  state.autoReadError = '';
  state.rows = [{ ...row, local_state: 'fetching' }];
  state.jobs = [job(row)];
  state.auto = { ...state.auto, enabled: true, interval_s: 120, last_run_at: new Date(Date.now()).toISOString(), queued_in_last_run: 1 };
  await advance(5000);
  assert.doesNotMatch(text(page.output), /Automatic status unavailable/);
  assert.equal(button(rowFor(page.output, row.task!), '取り込み中…').props.disabled, true);
  assert.ok(net.log.filter(req => req.path.endsWith('/episodes')).every(req => req.query.get('refresh') === '0'), 'automatic status uses the cached listing');
  page.unmount();
});

test('GMO imports, polls once a second while active, reloads on completion and opens with existing onPick', async () => {
  const row = episode('fetch'); const state = setup([row]); const picked: string[] = [];
  const page = mountGmo(state.config, (run, ep) => picked.push(`${run}/${ep}`)); await advance(100);
  const initialJobs = state.sent.filter(req => req.path.endsWith('/jobs')).length;
  await advance(2100);
  assert.equal(state.sent.filter(req => req.path.endsWith('/jobs')).length, initialJobs, 'idle jobs are not polled');
  click(rowFor(page.output, row.task!), '取り込む'); await advance(100);
  assert.equal(state.sent.find(req => req.path === '/api/gmo/fetch')?.method, 'POST');
  assert.deepEqual(state.sent.find(req => req.path === '/api/gmo/fetch')?.body, { run_id: row.run_id, episode_id: row.episode_id });
  assert.equal(button(rowFor(page.output, row.task!), '取り込み中…').props.disabled, true);
  state.jobs[0] = { ...state.jobs[0], state: 'running' };
  const beforeTick = state.sent.filter(req => req.path.endsWith('/jobs')).length;
  await advance(800);
  assert.equal(state.sent.filter(req => req.path.endsWith('/jobs')).length, beforeTick, 'the next poll waits one second');
  await advance(300);
  const activePolls = net.log.filter(req => req.path.endsWith('/jobs'));
  assert.ok(activePolls.length >= initialJobs + 1);
  state.rows = [{ ...row, local_state: 'local' }];
  state.jobs[0] = { ...state.jobs[0], state: 'done', note: '実行中のファイルを除外しました', bytes: 2048, finished_at: '2026-11-17T00:00:00Z' };
  const beforeReload = state.sent.filter(req => req.path.endsWith('/episodes')).length;
  await advance(1100);
  assert.ok(state.sent.filter(req => req.path.endsWith('/episodes')).length > beforeReload);
  assert.match(text(rowFor(page.output, row.task!)), /取り込み済み.*実行中のファイルを除外しました/);
  assert.deepEqual(picked, [], 'a completed import waits for the user to open it');
  click(rowFor(page.output, row.task!), '開く');
  assert.deepEqual(picked, [`${row.run_id}/${row.episode_id}`]);
  const finishedPolls = state.sent.filter(req => req.path.endsWith('/jobs')).length;
  await advance(2500);
  assert.equal(state.sent.filter(req => req.path.endsWith('/jobs')).length, finishedPolls, 'finished jobs stop polling');
  assertGmoHeaders(state.sent); page.unmount();
});

test('GMO reconciles an initially fetching row when the first jobs response is already complete', async () => {
  const row = episode('finished_elsewhere', { local_state: 'fetching' });
  const state = setup([row]);
  state.jobs = [job(row, { state: 'done', bytes: 2048, finished_at: '2026-11-17T00:00:00Z' })];
  const handler = net.handler;
  let listings = 0;
  net.handler = req => {
    const answer = handler(req);
    if (req.path === '/api/gmo/episodes' && listings++ === 0) state.rows = [{ ...row, local_state: 'local' }];
    return answer;
  };
  const page = mountGmo(state.config); await advance(100);
  assert.ok(listings >= 2, 'a completed transfer refreshes the stale fetching snapshot');
  assert.notEqual(button(rowFor(page.output, row.task!), '開く').props.disabled, true);
  const polls = state.sent.filter(req => req.path.endsWith('/jobs')).length;
  await advance(2100);
  assert.equal(state.sent.filter(req => req.path.endsWith('/jobs')).length, polls);
  page.unmount();
});

test('GMO refresh discovers an import started elsewhere and resumes polling until it completes', async () => {
  const row = episode('external'); const state = setup([row]);
  const page = mountGmo(state.config); await advance(100);
  state.rows = [{ ...row, local_state: 'fetching' }]; state.jobs = [job(row, { state: 'running' })];
  const initialPolls = state.sent.filter(req => req.path.endsWith('/jobs')).length;
  click(page.output, '一覧を更新'); await advance(100);
  assert.equal(button(rowFor(page.output, row.task!), '取り込み中…').props.disabled, true);
  await advance(1100);
  assert.ok(state.sent.filter(req => req.path.endsWith('/jobs')).length > initialPolls, 'fetching rows resume job polling');
  state.rows = [{ ...row, local_state: 'local' }];
  state.jobs = [job(row, { state: 'done', bytes: 2048, finished_at: '2026-11-17T00:00:00Z' })];
  await advance(1100);
  assert.notEqual(button(rowFor(page.output, row.task!), '開く').props.disabled, true);
  page.unmount();
});

test('GMO reconciles pending imports evicted from the latest 50 jobs without releasing an active transfer', async () => {
  const rows = Array.from({ length: 51 }, (_, index) => episode(`evicted_${index}`));
  const state = setup(rows);
  const handler = net.handler;
  net.handler = req => {
    const answer = handler(req);
    if (req.path === '/api/gmo/fetch') {
      const current = state.jobs[0];
      state.rows = state.rows.map(row => row.episode_id === current.episode_id ? { ...row, local_state: 'fetching' } : row);
    }
    return answer;
  };
  const page = mountGmo(state.config); await advance(100);
  for (const row of rows) {
    click(rowFor(page.output, row.task!), '取り込む'); await advance(10);
  }
  assert.equal(state.jobs.length, 50);
  assert.equal(state.jobs.some(entry => entry.episode_id === rows[0].episode_id), false);
  assert.equal(button(rowFor(page.output, rows[0].task!), '取り込み中…').props.disabled, true, 'eviction alone does not finish a transfer');
  assert.equal(net.log.some(req => req.path.endsWith('/episodes') && req.query.get('refresh') === '1'), false, 'active evicted jobs reuse the cached remote listing');
  state.rows = state.rows.map((row, index) => index === 0 ? { ...row, local_state: 'local' } : row);
  await advance(1100);
  assert.notEqual(button(rowFor(page.output, rows[0].task!), '開く').props.disabled, true, 'the list releases a finished evicted job');
  assert.equal(button(rowFor(page.output, rows[1].task!), '取り込み中…').props.disabled, true);
  state.rows = state.rows.map(row => ({ ...row, local_state: 'local' }));
  state.jobs = state.jobs.map(entry => ({ ...entry, state: 'done' }));
  await advance(1100);
  const polls = state.sent.filter(req => req.path.endsWith('/jobs')).length;
  await advance(2100);
  assert.equal(state.sent.filter(req => req.path.endsWith('/jobs')).length, polls, 'all finished imports stop polling');
  page.unmount();
});

test('GMO reconciles a fetching row whose externally started job is outside the history', async () => {
  const row = episode('external_evicted', { local_state: 'fetching' });
  const state = setup([row]);
  const page = mountGmo(state.config); await advance(100);
  assert.equal(button(rowFor(page.output, row.task!), '取り込み中…').props.disabled, true);
  state.rows = [{ ...row, local_state: 'stale' }];
  await advance(1100);
  assert.notEqual(button(rowFor(page.output, row.task!), '更新を取り込む').props.disabled, true);
  const polls = state.sent.filter(req => req.path.endsWith('/jobs')).length;
  await advance(2100);
  assert.equal(state.sent.filter(req => req.path.endsWith('/jobs')).length, polls);
  page.unmount();
});

test('closing the GMO picker stops polling active imports', async () => {
  const row = episode('background', { local_state: 'fetching' }); const state = setup([row]);
  state.jobs = [job(row, { state: 'running' })];
  const page = mountGmo(state.config); await advance(1100);
  const polls = state.sent.filter(req => req.path.endsWith('/jobs')).length;
  assert.ok(polls >= 2);
  page.unmount(); await advance(2500);
  assert.equal(state.sent.filter(req => req.path.endsWith('/jobs')).length, polls);
});

test('GMO shows job and enqueue failures on their row, and allows retry', async () => {
  const row = episode('failure'); const state = setup([row]);
  const page = mountGmo(state.config); await advance(100);
  state.fetchError = 'SSH 接続が切れました';
  click(rowFor(page.output, row.task!), '取り込む'); await advance(100);
  assert.match(text(rowFor(page.output, row.task!)), /SSH 接続が切れました/);
  state.fetchError = '';
  click(rowFor(page.output, row.task!), '取り込む'); await advance(100);
  state.jobs[0] = { ...state.jobs[0], state: 'failed', error: '空き容量が足りません', finished_at: '2026-11-17T00:00:00Z' };
  await advance(1100);
  assert.match(text(rowFor(page.output, row.task!)), /空き容量が足りません/);
  assert.notEqual(button(rowFor(page.output, row.task!), '取り込む').props.disabled, true);
  const polls = state.sent.filter(req => req.path.endsWith('/jobs')).length;
  await advance(2100);
  assert.equal(state.sent.filter(req => req.path.endsWith('/jobs')).length, polls);
  page.unmount();
});

test('GMO keeps the tab and reports an episode deleted after listing as a row error', async () => {
  const row = episode('deleted'); const state = setup([row]);
  let disabled = false;
  const page = mount(GmoPicker, { initialConfig: state.config, configError: null, onConfigChange: () => {}, onRetryConfig: () => {}, onDisabled: () => { disabled = true; }, onPick: () => {} });
  await advance(100);
  state.fetchStatus = 404;
  state.fetchError = 'Episode not found on GMO';
  click(rowFor(page.output, row.task!), '取り込む'); await advance(100);
  assert.equal(disabled, false);
  assert.match(text(rowFor(page.output, row.task!)), /Episode not found on GMO/);
  assert.notEqual(button(rowFor(page.output, row.task!), '取り込む').props.disabled, true);
  page.unmount();
});

test('GMO disables conflicts but lets the server limit changed files for large imports and opens large local episodes', async () => {
  const state = setup([
    episode('conflict', { conflict: true }), episode('large', { size_bytes: 1024 ** 3 }),
    episode('stale', { size_bytes: 1100 * 1024 ** 2, local_state: 'stale' }),
    episode('local', { size_bytes: 2 * 1024 ** 3, local_state: 'local' }),
  ]);
  const picked: string[] = [];
  const page = mountGmo(state.config, (run, ep) => picked.push(`${run}/${ep}`)); await advance(100);
  assert.match(text(rowFor(page.output, 'task_conflict')), /同じ|重複|複数/);
  assert.equal(button(rowFor(page.output, 'task_conflict'), '取り込む').props.disabled, true);
  click(rowFor(page.output, 'task_stale'), '更新を取り込む'); await advance(100);
  assert.deepEqual(state.sent.find(req => req.path.endsWith('/fetch'))?.body, { run_id: 'run_stale', episode_id: 'stale' });
  click(rowFor(page.output, 'task_local'), '開く');
  assert.deepEqual(picked, ['run_local/local']);
  click(rowFor(page.output, 'task_large'), '取り込む'); await advance(100);
  state.jobs[0] = { ...state.jobs[0], state: 'failed', error: '1 GiB exceeds the 1 GiB transfer limit' };
  await advance(1100);
  assert.match(text(rowFor(page.output, 'task_large')), /exceeds the 1 GiB transfer limit/);
  assert.notEqual(button(rowFor(page.output, 'task_large'), '取り込む').props.disabled, true);
  page.unmount();
});

async function saveForm(output: unknown): Promise<void> {
  const form = findAll(output, 'form')[0];
  if (form?.props.onSubmit) (form.props.onSubmit as (event: unknown) => void)({ preventDefault() {} });
  else click(output, '保存して確かめる');
  await advance(100);
}

function intervalSelect(output: unknown): FakeElement {
  const label = findAll(output, 'label').find(el => text(el) === '自動取り込みの間隔');
  assert.ok(label, 'the interval select has a visible label');
  assert.ok(label!.props.htmlFor, 'the label is associated with its control');
  const select = findAll(output, 'select').find(el => el.props.id === label!.props.htmlFor);
  assert.ok(select, 'the interval label refers to a select');
  return select!;
}

for (const interval of [60, 120, 300, 0]) {
  test(`GMO initializes the interval select from the current settings (${interval} seconds)`, async () => {
    const state = setup(); state.config.settings.interval_s = interval;
    const page = mountGmo(state.config); await advance(100);
    click(page.output, '接続設定'); await advance(0);
    const select = intervalSelect(page.output);
    assert.equal(select.props.value, String(interval));
    assert.deepEqual(findAll(select, 'option').map(el => [String(el.props.value), text(el)]), [
      ['60', '1 分'], ['120', '2 分（既定）'], ['300', '5 分'], ['0', '取り込まない'],
    ]);
    page.unmount();
  });
}

for (const interval of [60, 120, 300]) {
  test(`GMO saves the selected interval with the other settings (${interval} seconds)`, async () => {
    const state = setup(); state.config.settings.interval_s = interval === 120 ? 300 : 120;
    const page = mountGmo(state.config); await advance(100);
    click(page.output, '接続設定'); await advance(0);
    change(page.output, '自動取り込みの間隔', String(interval)); await advance(0);
    assert.equal(intervalSelect(page.output).props.value, String(interval));
    await saveForm(page.output);
    const saved = state.sent.find(req => req.path === '/api/gmo/config' && req.method === 'PUT');
    assert.deepEqual(saved?.body, settings({ interval_s: interval }));
    assertGmoHeaders(state.sent); page.unmount();
  });
}

for (const [interval, label] of [[600, '10 分（設定ファイルの値）'], [90, '90 秒（設定ファイルの値）']] as const) {
  test(`GMO preserves a custom configuration interval without editing it (${interval} seconds)`, async () => {
    const state = setup(); state.config.settings.interval_s = interval;
    const page = mountGmo(state.config); await advance(100);
    click(page.output, '接続設定'); await advance(0);
    const select = intervalSelect(page.output);
    assert.equal(select.props.value, String(interval));
    assert.deepEqual(findAll(select, 'option').map(el => String(el.props.value)), ['60', '120', '300', '0', String(interval)]);
    assert.equal(text(findAll(select, 'option').find(el => String(el.props.value) === String(interval))), label);
    await saveForm(page.output);
    const saved = state.sent.find(req => req.path === '/api/gmo/config' && req.method === 'PUT');
    assert.deepEqual(saved?.body, settings({ interval_s: interval }));
    page.unmount();
  });
}

test('GMO explains stopping automatic imports and shows disabled status after saving zero', async () => {
  const state = setup();
  const page = mountGmo(state.config); await advance(100);
  click(page.output, '接続設定'); await advance(0);
  assert.doesNotMatch(text(page.output), /自動取り込みは無効/);
  change(page.output, '自動取り込みの間隔', '0'); await advance(0);
  const descriptionId = intervalSelect(page.output).props['aria-describedby'];
  assert.ok(descriptionId, 'the stopping explanation is associated with the interval select');
  const description = findAll(page.output, 'p').find(el => el.props.id === descriptionId);
  assert.match(text(description), /保存すると自動取り込みが止まります/);
  assert.doesNotMatch(text(page.output), /自動取り込みは無効/, 'selection takes effect when saved');
  await saveForm(page.output);
  const saved = state.sent.find(req => req.path === '/api/gmo/config' && req.method === 'PUT');
  assert.deepEqual(saved?.body, settings({ interval_s: 0 }));
  assert.ok(findAll(page.output, 'span').some(el => el.props.role === 'status' && /自動取り込みは無効/.test(text(el))));
  const autoToggle = findAll(page.output, 'input').find(el => el.props['aria-label'] === '自分の試行を自動で取り込む');
  assert.equal(autoToggle?.props.checked, false);
  assert.equal(autoToggle?.props.disabled, true);
  assertGmoHeaders(state.sent); page.unmount();
});

test('GMO saves labelled settings as JSON then checks and reports counts', async () => {
  const state = setup([], false);
  state.config.settings.interval_s = 300;
  const page = mountGmo(state.config); await advance(100);
  change(page.output, '接続先', 'user@gmo.example'); await advance(0);
  change(page.output, 'ポート', '8822'); await advance(0);
  change(page.output, '鍵ファイル', '~/.ssh/gmo_key'); await advance(0);
  change(page.output, '自分の記録の場所', ' /mine/a/traces \n\n/mine/b/traces\n'); await advance(0);
  change(page.output, 'チームの記録の場所', '/team/*/traces'); await advance(0);
  await saveForm(page.output);
  const writes = state.sent.filter(req => req.method !== 'GET');
  assert.deepEqual(writes.map(req => [req.method, req.path]), [['PUT', '/api/gmo/config'], ['POST', '/api/gmo/check']]);
  assert.deepEqual(writes[0].body, settings({ host: 'user@gmo.example', port: 8822, identity_file: '~/.ssh/gmo_key', mine: ['/mine/a/traces', '/mine/b/traces'], team: ['/team/*/traces'], interval_s: 300 }));
  assert.deepEqual(writes[1].body, {});
  assert.match(text(page.output), /接続できました：自分 2 件、チーム 3 件/);
  assertGmoHeaders(state.sent); page.unmount();
});

test('GMO keeps settings errors visible and does not check after a failed save', async () => {
  const state = setup(); const page = mountGmo(state.config); await advance(100);
  click(page.output, '接続設定'); await advance(0);
  state.saveError = '接続先の形式が正しくありません';
  await saveForm(page.output);
  assert.match(text(page.output), /接続先の形式が正しくありません/);
  assert.equal(state.sent.some(req => req.path.endsWith('/check')), false);
  state.saveError = ''; state.check = { ok: false, mine_episodes: 0, team_episodes: 0, error: 'Permission denied (publickey)' };
  await saveForm(page.output);
  assert.match(text(page.output), /Permission denied \(publickey\)/);
  assertGmoHeaders(state.sent); page.unmount();
});

test('GMO can repair an unreadable configuration by saving editable connection settings', async () => {
  const state = setup([], false);
  const page = mountGmo(null, () => {}, 'Invalid JSON in GMO settings'); await advance(100);
  assert.match(text(page.output), /Invalid JSON in GMO settings/);
  assert.equal(intervalSelect(page.output).props.value, '120', 'missing settings default to two minutes');
  assert.notEqual(findAll(page.output, 'fieldset')[0].props.disabled, true, 'failed GET /config does not prevent repair');
  change(page.output, '接続先', 'gmo'); await advance(0);
  change(page.output, '自分の記録の場所', '/mine/traces'); await advance(0);
  await saveForm(page.output);
  assert.deepEqual(state.sent.filter(req => req.method !== 'GET').map(req => [req.method, req.path]), [['PUT', '/api/gmo/config'], ['POST', '/api/gmo/check']]);
  assert.match(text(page.output), /接続できました：自分 2 件、チーム 3 件/);
  assert.doesNotMatch(text(page.output), /Invalid JSON in GMO settings/);
  assertGmoHeaders(state.sent); page.unmount();
});
