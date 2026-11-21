import { advance, clock, findAll, net, resetBrowser, setLocation, type FakeElement } from './harness/browser';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from './harness/fakeReact';
import { Picker } from '../components/Picker';
import { GmoPicker } from '../components/GmoPicker';
import { SmallButton } from '../components/common';
import type { EpisodeSummary } from '../types';
import type { GmoConfigResponse, GmoEpisodeSummary } from '../api';

function text(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return typeof node === 'object' && 'props' in node ? text((node as FakeElement).props.children) : '';
}
function input(node: unknown, label: string): FakeElement {
  const element = ['input', 'select'].flatMap(type => findAll(node, type)).find(el => el.props['aria-label'] === label);
  assert.ok(element, `control ${label} exists`);
  return element!;
}
async function change(node: unknown, label: string, value: string): Promise<void> {
  (input(node, label).props.onChange as (event: unknown) => void)({ target: { value } });
  await advance(100);
}
function dataRows(node: unknown): FakeElement[] {
  return findAll(node, 'tbody').flatMap(body => findAll(body, 'tr')).filter(row => findAll(row, 'td').length > 0);
}
function headers(node: unknown): string[] {
  return findAll(node, 'th').filter(el => el.props.scope === 'rowgroup').map(text);
}
async function more(node: unknown, remaining: number): Promise<void> {
  const label = `さらに表示（残り ${remaining} 件）`;
  const button = [...findAll(node, 'button'), ...findAll(node, SmallButton)].find(el => text(el) === label);
  assert.ok(button, label);
  (button!.props.onClick as () => void)();
  await advance(0);
}
function setupClock(): void {
  resetBrowser();
  clock.now = new Date(2026, 10, 21, 14).getTime();
}
function episode(id: string, day: number, task = 'task-a', run = 'run-a', success = true): EpisodeSummary {
  return { run_id: run, episode_id: id, task, seed: 1, status: 'ended', end_reason: 'completed',
    start_wall_time: new Date(2026, 10, day, 12).getTime() / 1000,
    episode: { trial_outcome: { source: 'evaluation_finalizer', task_success: success } } };
}
function localPage(episodes: EpisodeSummary[], extra: EpisodeSummary[] = []) {
  net.handler = req => {
    const path = req.path.replace(/^\/api\/sites\/[^/]+/, '/api');
    if (path === '/api/traces/runs') return { json: { runs: [
      { run_id: 'run-a', n_episodes: episodes.length }, { run_id: 'run-b', n_episodes: extra.length },
    ] } };
    if (path === '/api/traces/runs/run-a') return { json: { run_id: 'run-a', episodes } };
    if (path === '/api/traces/runs/run-b') return { json: { run_id: 'run-b', episodes: extra } };
    if (path === '/api/traces/legacy/runs') return { json: { roots: [], runs: [] } };
    return null;
  };
  return mount(Picker, { config: null, configError: null, currentRun: 'run-a', currentEpisode: null,
    initialMode: 'traced', onPick: () => {}, onPickLegacy: () => {} });
}
const config: GmoConfigResponse = { enabled: true, configured: true, dest: '', config_path: '', settings: {
  host: '', port: null, identity_file: null, shared_root: '', submission_root: '', mine: [], team: [], interval_s: 0,
} };
function remoteEpisode(id: string, day: number, task = 'task-a', run = 'run-a', success = true, mine = true): GmoEpisodeSummary {
  return { ...episode(id, day, task, run, success), run_id: run, owner: '', mine,
    size_bytes: 1, local_state: 'local', conflict: false };
}
function remotePage(episodes: GmoEpisodeSummary[]) {
  net.handler = req => {
    if (req.path.endsWith('/episodes')) return { json: episodes };
    if (req.path.endsWith('/jobs')) return { json: [] };
    if (req.path.endsWith('/listing-status')) return { json: { fetched_at: null, refreshing: false, error: null } };
    if (req.path.endsWith('/auto')) return { json: { enabled: false, paused: false, interval_s: 0,
      running: false, last_run_at: null, next_run_at: null, last_error: null, queued_in_last_run: 0, skipped_large: [] } };
    return null;
  };
  return mount(GmoPicker, { initialConfig: config, configError: null, onConfigChange: () => {},
    onRetryConfig: () => {}, onDisabled: () => {}, onPick: () => {} });
}

test('local trial period filters and date headings use local days without changing row order', async () => {
  setupClock();
  const page = localPage([episode('e1', 21, 'a'), episode('e2', 20, 'b'), episode('e3', 19, 'c'), episode('e4', 15, 'd'), episode('e5', 14, 'e')]);
  await advance(100);
  assert.equal(dataRows(page.output).length, 5);
  assert.match(text(page.output), /(?<![\d]|件中 )5 件/); assert.doesNotMatch(text(page.output), /件中/);
  assert.deepEqual(headers(page.output), ['11月21日（土）', '11月20日（金）', '11月19日（木）', '11月15日（日）', '11月14日（土）']);
  assert.equal(findAll(page.output, 'thead').length, 1);
  for (const [period, count] of [['today', 1], ['3d', 3], ['7d', 4], ['all', 5]] as const) {
    await change(page.output, '期間', period);
    assert.equal(dataRows(page.output).length, count);
    assert.match(text(page.output), period === 'all' ? /(?<![\d]|件中 )5 件/ : new RegExp(`5 件中 ${count} 件`));
  }
  await change(page.output, '期間', 'custom');
  await change(page.output, '開始日', '2026-11-19');
  await change(page.output, '終了日', '2026-11-20');
  assert.deepEqual(dataRows(page.output).map(row => row.props['aria-label']), ['episode e2', 'episode e3']);
  page.unmount();
});

test('local task and evaluation filters keep existing result, text and selection URL state', async () => {
  setupClock(); setLocation('/traces?run=run-a&episode=e1&site=rtx');
  const local = localPage([episode('e1', 21, 'task-a'), episode('e2', 20, 'task-b', 'run-a', false)], [episode('e3', 21, 'task-c', 'run-b')]);
  await advance(100);
  await change(local.output, 'タスク', 'task-b');
  assert.deepEqual(dataRows(local.output).map(row => row.props['aria-label']), ['episode e2']);
  await change(local.output, '結果で絞り込み', 'success');
  assert.equal(dataRows(local.output).length, 0);
  await change(local.output, '結果で絞り込み', 'all');
  await change(local.output, 'タスク', 'all');
  await change(local.output, '試行を検索', 'e1');
  assert.deepEqual(dataRows(local.output).map(row => row.props['aria-label']), ['episode e1']);
  await change(local.output, '試行を検索', '');
  await change(local.output, '評価', 'run-b');
  assert.ok(net.log.some(req => req.path.endsWith('/runs/run-b')));
  assert.deepEqual(dataRows(local.output).map(row => row.props['aria-label']), ['episode e3']);
  assert.equal(window.location.search, '?run=run-a&episode=e1&site=rtx');
  local.unmount();
});

test('local trial lists add one hundred rows per request and reset the limit after filtering', async () => {
  setupClock();
  const page = localPage(Array.from({ length: 205 }, (_, i) => episode(`e${String(i).padStart(3, '0')}`, 21, i < 3 ? 'task-a' : 'task-b')));
  await advance(100);
  assert.equal(dataRows(page.output).length, 100);
  assert.match(text(page.output), /(?<![\d]|件中 )205 件/); assert.doesNotMatch(text(page.output), /件中/);
  await more(page.output, 105);
  assert.equal(dataRows(page.output).length, 200);
  await more(page.output, 5);
  assert.equal(dataRows(page.output).length, 205);
  await change(page.output, 'タスク', 'task-a');
  assert.equal(dataRows(page.output).length, 3);
  await change(page.output, 'タスク', 'all');
  assert.equal(dataRows(page.output).length, 100);
  page.unmount();
});

test('remote trial period, task and evaluation filters intersect and keep date headings and counts', async () => {
  setupClock();
  const page = remotePage([remoteEpisode('e1', 21), remoteEpisode('e2', 20, 'task-b', 'run-b'), remoteEpisode('e3', 19), remoteEpisode('e4', 14)]);
  await advance(100);
  assert.match(text(page.output), /(?<![\d]|件中 )4 件/); assert.doesNotMatch(text(page.output), /件中/);
  assert.deepEqual(headers(page.output), ['11月21日（土）', '11月20日（金）', '11月19日（木）', '11月14日（土）']);
  for (const [period, count] of [['today', 1], ['3d', 3], ['7d', 3], ['all', 4]] as const) {
    await change(page.output, '期間', period);
    assert.equal(dataRows(page.output).length, count);
  }
  await change(page.output, 'タスク', 'task-b');
  assert.equal(dataRows(page.output).length, 1);
  await change(page.output, '評価', 'run-a');
  assert.equal(dataRows(page.output).length, 0);
  await change(page.output, '評価', 'run-b');
  assert.equal(dataRows(page.output).length, 1);
  assert.match(text(page.output), /4 件中 1 件/);
  await change(page.output, '期間', 'custom');
  await change(page.output, '開始日', '2026-11-20');
  await change(page.output, '終了日', '2026-11-20');
  assert.equal(dataRows(page.output).length, 1);
  assert.deepEqual(headers(page.output), ['11月20日（金）']);
  page.unmount();
});

test('remote trials list newest first, so the first page starts today and paging goes back in time', async () => {
  setupClock();
  const page = remotePage([remoteEpisode('e14', 14), remoteEpisode('e21', 21), remoteEpisode('e19', 19), remoteEpisode('e20', 20)]);
  await advance(100);
  assert.deepEqual(headers(page.output), ['11月21日（土）', '11月20日（金）', '11月19日（木）', '11月14日（土）']);
  page.unmount();
});

test('remote trial filters preserve scope, result, search and existing URL parameters', async () => {
  setupClock(); setLocation('/traces?run=run-a&episode=e1&site=rtx');
  const page = remotePage([remoteEpisode('e1', 21), remoteEpisode('e2', 21, 'task-a', 'run-b', false, false), remoteEpisode('e3', 20)]);
  await advance(100);
  await change(page.output, '期間', 'today');
  await change(page.output, 'タスク', 'task-a');
  await change(page.output, 'RTX の範囲', 'team');
  assert.equal(dataRows(page.output).length, 1);
  await change(page.output, 'RTX の結果で絞り込み', 'success');
  assert.equal(dataRows(page.output).length, 0);
  await change(page.output, 'RTX の結果で絞り込み', 'failure');
  await change(page.output, 'RTX の試行を検索', 'task-a');
  assert.equal(dataRows(page.output).length, 1);
  await change(page.output, 'RTX の試行を検索', 'missing');
  assert.equal(dataRows(page.output).length, 0);
  assert.equal(window.location.search, '?run=run-a&episode=e1&site=rtx');
  page.unmount();
});

test('remote trial lists retain API order while adding one hundred rows at a time', async () => {
  setupClock();
  const episodes = Array.from({ length: 205 }, (_, i) => remoteEpisode(`e${String(204 - i).padStart(3, '0')}`, 21, i < 3 ? 'task-a' : 'task-b'));
  const page = remotePage(episodes);
  await advance(100);
  assert.equal(dataRows(page.output).length, 100);
  assert.match(text(dataRows(page.output)[0]), /e204/);
  await more(page.output, 105);
  assert.equal(dataRows(page.output).length, 200);
  await more(page.output, 5);
  assert.equal(dataRows(page.output).length, 205);
  assert.match(text(dataRows(page.output)[204]), /e000/);
  await change(page.output, 'タスク', 'task-a');
  assert.equal(dataRows(page.output).length, 3);
  await change(page.output, 'タスク', 'all');
  assert.equal(dataRows(page.output).length, 100);
  page.unmount();
});

test('local trial task and evaluation names remain selectable when they match filter sentinel values', async () => {
  setupClock();
  const names = ['all', 'mine', 'value:all'];
  net.handler = req => {
    if (req.path === '/api/traces/runs') return { json: { runs: names.map(run_id => ({ run_id, n_episodes: 3 })) } };
    if (req.path === '/api/traces/legacy/runs') return { json: { roots: [], runs: [] } };
    if (req.path.startsWith('/api/traces/runs/')) {
      const run = decodeURIComponent(req.path.slice('/api/traces/runs/'.length));
      return { json: { run_id: run, episodes: names.map((task, index) => episode(`${run}-e${index}`, 21, task, run)) } };
    }
    return null;
  };
  const page = mount(Picker, { config: null, configError: null, currentRun: 'all', currentEpisode: null,
    initialMode: 'traced', onPick: () => {}, onPickLegacy: () => {} });
  await advance(100);
  for (const [name, value] of [['all', 'value:all'], ['mine', 'value:mine'], ['value:all', 'value:value:all']]) {
    assert.ok(findAll(input(page.output, '評価'), 'option').some(option => text(option) === name && option.props.value === value));
    await change(page.output, '評価', value);
    assert.equal(dataRows(page.output).length, 3);
    assert.ok(findAll(input(page.output, 'タスク'), 'option').some(option => text(option) === name && option.props.value === value));
    await change(page.output, 'タスク', value);
    const index = names.indexOf(name);
    assert.deepEqual(dataRows(page.output).map(row => row.props['aria-label']), [`episode ${name}-e${index}`]);
    await change(page.output, 'タスク', 'all');
    assert.equal(dataRows(page.output).length, 3);
  }
  await change(page.output, '評価', 'all');
  assert.equal(input(page.output, '評価').props.value, 'all');
  assert.equal(dataRows(page.output).length, 3);
  page.unmount();
});

test('remote trial task and evaluation names are distinct from default and escaped filter values', async () => {
  setupClock();
  const names = ['all', 'mine', 'value:all'];
  const page = remotePage(names.flatMap((run, runIndex) => names.map((task, taskIndex) =>
    remoteEpisode(`reserved-${runIndex}-${taskIndex}`, 21, task, run))));
  await advance(100);
  assert.equal(dataRows(page.output).length, 9);
  for (const [index, value] of ['value:all', 'value:mine', 'value:value:all'].entries()) {
    await change(page.output, 'タスク', value);
    assert.equal(dataRows(page.output).length, 3);
    await change(page.output, '評価', value);
    assert.equal(dataRows(page.output).length, 1);
    assert.match(text(dataRows(page.output)[0]), new RegExp(`reserved-${index}-${index}`));
    await change(page.output, 'タスク', 'all');
    assert.equal(dataRows(page.output).length, 3);
    await change(page.output, '評価', 'all');
    assert.equal(dataRows(page.output).length, 9);
  }
  page.unmount();
});
