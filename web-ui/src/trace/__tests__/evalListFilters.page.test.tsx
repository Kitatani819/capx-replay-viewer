import { advance, clock, currentParams, findAll, net, popState, resetBrowser, setLocation, type FakeElement } from './harness/browser';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount, type Mounted } from './harness/fakeReact';
import { EvalListPage, EvalListTable } from '../../evals/EvalPages';
import type { EvalListEntry, EvalRecord, EvalSummary } from '../../evals/api';

type Page = Mounted<Record<string, never>>;
const summary: EvalSummary = { trials: 1, success: 1, failure: 0, unknown: 0, incomplete: 0, tasks: [], seeds: [1], models: {}, config_flags: {}, mixed: [] };
function localDate(day: number, hour = 12, minute = 0, second = 0, ms = 0): string {
  return new Date(2026, 10, day, hour, minute, second, ms).toISOString();
}
function entry(id: string, day: number, by: string, tasks: string[], extra: Partial<EvalRecord> = {}, fields: Partial<EvalListEntry> = {}): EvalListEntry {
  const counts = { ...summary, tasks };
  return { eval_id: id, eval: { schema: 'capx-eval/1', eval_id: id, status: 'completed', by, changed: '基準', baseline_eval_id: null,
    eval_set: 'suite', git: null, started_at: localDate(day), heartbeat_at: localDate(day), ended_at: localDate(day), summary: counts, ...extra },
    error: null, location: 'gmo', display_status: null, summary: counts, baseline_summary: null, ...fields };
}
function fixtures(): EvalListEntry[] {
  return [
    entry('today-owned', 21, '実行者A', ['cube'], { changed: '把持位置を修正', started_at: localDate(21, 23, 59, 59, 999) }, { mine: true }),
    entry('today-team', 21, '実行者B', ['drawer', 'cube'], { status: 'running', eval_set: 'routeB:behavior', started_at: localDate(21, 0) }, { mine: false, display_status: 'running' }),
    entry('yesterday-owned', 20, '実行者A', ['drawer'], { status: 'interrupted', eval_set: 'routeB:libero' }, { mine: true, display_status: 'interrupted' }),
    entry('three-day-local', 19, '実行者C', ['stack'], { started_at: localDate(19, 0) }, { location: 'local' }),
    entry('seven-day-team', 15, '実行者B', ['stack'], { status: 'interrupted' }, { mine: false, display_status: 'failed' }),
    entry('older-team', 14, '実行者C', ['cube'], { started_at: localDate(14, 23, 59, 59, 999) }, { mine: false }),
  ];
}
function text(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return typeof node === 'object' && 'props' in node ? text((node as FakeElement).props.children) : '';
}
function control(output: unknown, label: string): FakeElement {
  const el = [...findAll(output, 'select'), ...findAll(output, 'input')].find(item => item.props['aria-label'] === label);
  assert.ok(el, `missing ${label} filter`);
  return el!;
}
async function change(page: Page, label: string, value: string): Promise<void> {
  (control(page.output, label).props.onChange as (event: unknown) => void)({ target: { value } });
  await advance(0);
}
function ids(page: Page): string[] {
  const tables = findAll(page.output, EvalListTable);
  return tables.length ? (tables[0].props.entries as EvalListEntry[]).map(item => item.eval_id) : [];
}
async function open(url = '/evals', entries = fixtures(), names: Record<string, string> = {}): Promise<Page> {
  resetBrowser();
  clock.now = new Date(2026, 10, 21, 12).getTime();
  setLocation(url);
  net.handler = req => req.path.endsWith('/evals') ? { json: { evals: entries, names } } : null;
  const page = mount(EvalListPage, {});
  await advance(100);
  return page;
}
async function reset(page: Page): Promise<void> {
  const button = findAll(page.output, 'button').find(item => text(item) === '絞り込みを解除');
  assert.ok(button, 'active filters have a reset button');
  (button!.props.onClick as () => void)();
  await advance(0);
}

test('evaluation filters start at all with dynamic people and task options and an unfiltered count', async () => {
  const page = await open();
  assert.equal(ids(page).length, 6);
  for (const label of ['期間', '実行者', '種類', 'タスク', '状態']) assert.equal(control(page.output, label).props.value, 'all');
  assert.deepEqual(findAll(control(page.output, '実行者'), 'option').map(item => text(item)), ['すべて', '自分', '実行者A', '実行者B', '実行者C']);
  assert.deepEqual(findAll(control(page.output, 'タスク'), 'option').map(item => item.props.value), ['all', 'cube', 'drawer', 'stack']);
  assert.match(text(page.output), /6 件/);
  assert.doesNotMatch(text(page.output), /件中|絞り込みを解除/);
  assert.equal(window.location.search, '?site=b300');
  page.unmount();
});

for (const [period, expected] of [
  ['today', ['today-owned', 'today-team']],
  ['3d', ['today-owned', 'today-team', 'yesterday-owned', 'three-day-local']],
  ['7d', ['today-owned', 'today-team', 'yesterday-owned', 'three-day-local', 'seven-day-team']],
] as const) {
  test(`evaluation period ${period} includes the local calendar boundary`, async () => {
    const page = await open();
    await change(page, '期間', period);
    assert.deepEqual(ids(page), [...expected]);
    assert.match(text(page.output), new RegExp(`6 件中 ${expected.length} 件`));
    assert.equal(currentParams().get('period'), period);
    page.unmount();
  });
}

test('evaluation custom dates include both whole local days and allow an open end', async () => {
  const page = await open();
  await change(page, '期間', 'custom');
  await change(page, '開始日', '2026-11-20');
  await change(page, '終了日', '2026-11-21');
  assert.deepEqual(ids(page), ['today-owned', 'today-team', 'yesterday-owned']);
  assert.equal(currentParams().get('from'), '2026-11-20');
  assert.equal(currentParams().get('to'), '2026-11-21');
  await change(page, '開始日', '');
  await change(page, '終了日', '2026-11-19');
  assert.deepEqual(ids(page), ['three-day-local', 'seven-day-team', 'older-team']);
  page.unmount();
});

test('evaluation person and mine filters use the display name and ownership flag including local records', async () => {
  const page = await open();
  await change(page, '実行者', '実行者B');
  assert.deepEqual(ids(page), ['today-team', 'seven-day-team']);
  assert.equal(currentParams().get('by'), '実行者B');
  await change(page, '実行者', 'mine');
  assert.deepEqual(ids(page), ['today-owned', 'yesterday-owned', 'three-day-local']);
  assert.match(text(page.output), /6 件中 3 件/);
  page.unmount();
});

test('evaluation kind filters share route B detection and task matches any listed task', async () => {
  const page = await open();
  await change(page, '種類', 'b');
  assert.deepEqual(ids(page), ['today-team', 'yesterday-owned']);
  await reset(page);
  await change(page, '種類', 'a');
  assert.deepEqual(ids(page), ['today-owned', 'three-day-local', 'seven-day-team', 'older-team']);
  await reset(page);
  await change(page, 'タスク', 'cube');
  assert.deepEqual(ids(page), ['today-owned', 'today-team', 'older-team']);
  page.unmount();
});

for (const [status, expected] of [
  ['completed', ['today-owned', 'three-day-local', 'older-team']],
  ['running', ['today-team']],
  ['stopped', ['yesterday-owned', 'seven-day-team']],
] as const) {
  test(`evaluation status ${status} uses the displayed state`, async () => {
    const page = await open();
    await change(page, '状態', status);
    assert.deepEqual(ids(page), [...expected]);
    page.unmount();
  });
}

test('evaluation keywords search changed parts, suite, id and person without case sensitivity', async () => {
  const page = await open();
  for (const [q, expected] of [
    [' 把持位置 ', ['today-owned']],
    ['ROUTEB:BEHAVIOR', ['today-team']],
    ['seven-day', ['seven-day-team']],
    ['実行者C', ['three-day-local', 'older-team']],
  ] as const) {
    await change(page, 'キーワード', q);
    assert.deepEqual(ids(page), [...expected]);
  }
  page.unmount();
});

test('evaluation combined filters report counts, show the empty message and reset all URL filter keys', async () => {
  const page = await open('/evals?site=rtx');
  await change(page, '期間', '3d');
  await change(page, '実行者', '実行者B');
  await change(page, '種類', 'b');
  await change(page, 'タスク', 'drawer');
  await change(page, '状態', 'running');
  await change(page, 'キーワード', 'BEHAVIOR');
  assert.deepEqual(ids(page), ['today-team']);
  assert.match(text(page.output), /6 件中 1 件/);
  await change(page, 'キーワード', '存在しない条件');
  assert.deepEqual(ids(page), []);
  assert.match(text(page.output), /条件に合う評価はありません/);
  assert.match(text(page.output), /6 件中 0 件/);
  await reset(page);
  assert.equal(ids(page).length, 6);
  assert.deepEqual([...currentParams()], [['site', 'rtx']]);
  assert.doesNotMatch(text(page.output), /条件に合う評価はありません|件中|絞り込みを解除/);
  assert.ok(net.log.every(req => req.path === '/api/sites/rtx/evals'));
  page.unmount();
});

test('typing a keyword or a date replaces the history entry; choosing from a list adds one', async () => {
  const page = await open('/evals?site=rtx');
  const history = window.history as { pushState: (...args: unknown[]) => void; replaceState: (...args: unknown[]) => void };
  const calls: string[] = [];
  const { pushState, replaceState } = history;
  history.pushState = (...args) => { calls.push('push'); pushState(...args); };
  history.replaceState = (...args) => { calls.push('replace'); replaceState(...args); };
  try {
    for (const typed of ['B', 'BE', 'BEH']) await change(page, 'キーワード', typed);
    assert.deepEqual(calls, ['replace', 'replace', 'replace'], 'Back must not step through every keystroke');
    assert.equal(currentParams().get('q'), 'BEH');
    calls.length = 0;
    await change(page, '期間', 'custom');
    await change(page, '開始日', '2026-11-20');
    assert.deepEqual(calls, ['push', 'replace']);
  } finally {
    history.pushState = pushState; history.replaceState = replaceState;
    page.unmount();
  }
});

test('evaluation filters restore a shared URL and respond to back navigation while preserving the site', async () => {
  const params = new URLSearchParams({ site: 'rtx', period: 'custom', from: '2026-11-20', to: '2026-11-21', by: '実行者B', kind: 'b', task: 'drawer', status: 'running', q: 'BEHAVIOR' });
  const page = await open(`/evals?${params}`);
  assert.deepEqual(ids(page), ['today-team']);
  for (const [key, value] of params) assert.equal(currentParams().get(key), value);
  assert.equal(control(page.output, '開始日').props.value, '2026-11-20');
  assert.equal(control(page.output, '終了日').props.value, '2026-11-21');
  await change(page, 'タスク', 'stack');
  assert.deepEqual(ids(page), []);
  popState(`/evals?${params}`);
  await advance(0);
  assert.deepEqual(ids(page), ['today-team']);
  assert.equal(control(page.output, 'タスク').props.value, 'drawer');
  popState('/evals?site=rtx');
  await advance(0);
  assert.equal(ids(page).length, 6);
  assert.equal(control(page.output, '期間').props.value, 'all');
  assert.equal(control(page.output, 'キーワード').props.value, '');
  page.unmount();
});

test('evaluation URL rejects unknown enums, people, tasks and dates and removes default values', async () => {
  const page = await open('/evals?site=rtx&period=invalid&by=unknown&kind=invalid&task=unknown&status=invalid&from=2026-02-30&to=invalid&q=');
  assert.equal(ids(page).length, 6);
  assert.deepEqual([...currentParams()], [['site', 'rtx']]);
  for (const label of ['期間', '実行者', '種類', 'タスク', '状態']) assert.equal(control(page.output, label).props.value, 'all');
  page.unmount();
  const defaults = await open('/evals?period=all&by=all&kind=all&task=all&status=all');
  assert.equal(window.location.search, '?site=b300');
  defaults.unmount();
});

test('evaluation invalid custom dates become open bounds and reversed dates reset the period', async () => {
  const page = await open('/evals?period=custom&from=2026-02-30&to=invalid');
  assert.equal(control(page.output, '期間').props.value, 'custom');
  assert.equal(control(page.output, '開始日').props.value, '');
  assert.equal(control(page.output, '終了日').props.value, '');
  assert.equal(currentParams().has('from'), false);
  assert.equal(currentParams().has('to'), false);
  assert.equal(ids(page).length, 6);
  page.unmount();
  const reversed = await open('/evals?period=custom&from=2026-11-21&to=2026-11-20');
  assert.equal(control(reversed.output, '期間').props.value, 'all');
  assert.equal(window.location.search, '?site=b300');
  assert.equal(ids(reversed).length, 6);
  reversed.unmount();
});

test('evaluation table has one column header and accessible local date groups newest first', () => {
  resetBrowser();
  const entries = fixtures();
  const input = [...entries].reverse();
  const before = input.map(item => item.eval_id);
  const table = mount(EvalListTable, { entries: input });
  const headings = findAll(table.output, 'th').filter(item => item.props.scope === 'rowgroup');
  assert.deepEqual(headings.map(item => text(item)), ['11月21日（土）', '11月20日（金）', '11月19日（木）', '11月15日（日）', '11月14日（土）']);
  assert.ok(headings.every(item => item.props.colSpan === 6));
  assert.equal(findAll(table.output, 'thead').length, 1);
  const times = findAll(table.output, 'time').map(item => item.props.dateTime);
  assert.deepEqual(times, entries.map(item => item.eval!.started_at));
  assert.match(text(table.output), /実行中/);
  assert.deepEqual(input.map(item => item.eval_id), before, 'grouping does not mutate source rows');
  table.unmount();
});

test('evaluation invalid person and task defaults remain cleared when a later poll introduces matching options', async () => {
  const params = new URLSearchParams({ by: '実行者D', task: 'new-task' });
  const page = await open(`/evals?${params}`);
  assert.equal(control(page.output, '実行者').props.value, 'all');
  assert.equal(control(page.output, 'タスク').props.value, 'all');
  assert.equal(window.location.search, '?site=b300');
  const entries = [...fixtures(), entry('later-evaluation', 21, '実行者D', ['new-task'])];
  net.handler = req => req.path.endsWith('/evals') ? { json: { evals: entries } } : null;
  await advance(30_000);
  assert.equal(ids(page).length, 7, 'a formerly invalid URL filter must not silently reactivate');
  assert.equal(control(page.output, '実行者').props.value, 'all');
  assert.equal(control(page.output, 'タスク').props.value, 'all');
  assert.equal(window.location.search, '?site=b300');
  assert.match(text(page.output), /7 件/);
  assert.doesNotMatch(text(page.output), /件中/);
  page.unmount();
});

test('evaluation shared person and task filters survive an empty refreshing listing until the remote options arrive', async () => {
  for (const valid of [true, false]) {
    resetBrowser();
    clock.now = new Date(2026, 10, 21, 12).getTime();
    const params = new URLSearchParams({ by: valid ? '実行者B' : 'unknown', task: valid ? 'drawer' : 'unknown' });
    setLocation(`/evals?${params}`);
    let ready = false;
    net.handler = req => req.path.endsWith('/evals') ? { json: {
      evals: ready ? fixtures() : [],
      remote_status: { fetched_at: ready ? localDate(21) : null, refreshing: !ready, error: null },
    } } : null;
    const page = mount(EvalListPage, {});
    await advance(100);
    assert.deepEqual([...currentParams()], [['site', 'b300'], ...params], 'cold remote placeholders cannot validate dynamic options');
    assert.equal(control(page.output, '実行者').props.value, params.get('by'));
    assert.equal(control(page.output, 'タスク').props.value, params.get('task'));
    ready = true;
    await advance(2000);
    assert.equal(net.log.filter(req => req.path === '/api/evals').length, 2, 'refreshing remote listings use the short poll');
    if (valid) {
      assert.deepEqual(ids(page), ['today-team']);
      assert.deepEqual([...currentParams()], [['site', 'b300'], ...params]);
      assert.match(text(page.output), /6 件中 1 件/);
    } else {
      assert.equal(ids(page).length, 6);
      assert.equal(control(page.output, '実行者').props.value, 'all');
      assert.equal(control(page.output, 'タスク').props.value, 'all');
      assert.equal(window.location.search, '?site=b300', 'invalid dynamic options default once the remote listing settles');
    }
    page.unmount();
  }
});

test('evaluation literal reserved person and task names stay distinct from all and mine filters in shared URLs', async () => {
  const entries = [
    entry('person-mine', 21, 'mine', ['all'], {}, { mine: false }),
    entry('person-all', 21, 'all', ['cube'], {}, { mine: false }),
    entry('person-prefix', 21, 'value:mine', ['cube'], {}, { mine: false }),
    entry('owned-other-person', 21, '実行者A', ['cube'], {}, { mine: true }),
  ];
  const page = await open('/evals', entries);
  for (const [person, value, id] of [
    ['mine', 'value:mine', 'person-mine'],
    ['all', 'value:all', 'person-all'],
    ['value:mine', 'value:value:mine', 'person-prefix'],
  ]) {
    const option = findAll(control(page.output, '実行者'), 'option').find(item => text(item) === person);
    assert.equal(option?.props.value, value);
    await change(page, '実行者', value);
    assert.deepEqual(ids(page), [id]);
    assert.equal(currentParams().get('by'), value);
  }
  await change(page, '実行者', 'mine');
  assert.deepEqual(ids(page), ['owned-other-person'], '自分 follows ownership rather than the literal person name mine');
  await change(page, '実行者', 'all');
  assert.equal(ids(page).length, 4);
  const task = findAll(control(page.output, 'タスク'), 'option').find(item => text(item) === 'all');
  assert.equal(task?.props.value, 'value:all');
  await change(page, 'タスク', 'value:all');
  assert.deepEqual(ids(page), ['person-mine']);
  await change(page, '実行者', 'value:mine');
  const shared = `${window.location.pathname}${window.location.search}`;
  assert.equal(currentParams().get('task'), 'value:all');
  page.unmount();
  const restored = await open(shared, entries);
  assert.deepEqual(ids(restored), ['person-mine']);
  assert.equal(control(restored.output, '実行者').props.value, 'value:mine');
  assert.equal(control(restored.output, 'タスク').props.value, 'value:all');
  restored.unmount();
});


test('evaluation runner options show names while filter values and keyword search retain account IDs', async () => {
  const entries = [entry('named', 21, 'user_00099_test', ['cube']), entry('fallback', 21, 'user_00098_test', ['cube'])];
  const names = { user_00099_test: '山田太郎' };
  const page = await open('/evals?site=rtx', entries, names);
  const options = findAll(control(page.output, '実行者'), 'option');
  assert.ok(options.some(option => option.props.value === 'user_00099_test' && text(option) === '山田太郎'));
  assert.ok(options.some(option => option.props.value === 'user_00098_test' && text(option) === 'user_00098_test'));
  assert.deepEqual(findAll(page.output, EvalListTable)[0].props.names, names);
  await change(page, '実行者', 'user_00099_test');
  assert.deepEqual(ids(page), ['named']);
  assert.equal(currentParams().get('by'), 'user_00099_test');
  await change(page, '実行者', 'all');
  for (const q of ['山田', 'USER_00099_TEST']) {
    await change(page, 'キーワード', q);
    assert.deepEqual(ids(page), ['named']);
  }
  await change(page, 'キーワード', 'user_00098_test');
  assert.deepEqual(ids(page), ['fallback']);
  assert.ok(net.log.every(req => req.path === '/api/sites/rtx/evals'));
  page.unmount();
});
