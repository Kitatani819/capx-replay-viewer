/** The evaluation list manages disposable copies within the selected site. */
import { advance, findAll, net, resetBrowser, setLocation, type FakeElement } from './harness/browser';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from './harness/fakeReact';
import { EvalListPage } from '../../evals/EvalPages';
import type { GmoLocalCopies, GmoLocalCopy } from '../api';

function text(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return typeof node === 'object' && 'props' in node ? text((node as FakeElement).props.children) : '';
}
function button(node: unknown, label: string): FakeElement {
  const found = findAll(node, 'button').find(item => text(item) === label || item.props['aria-label'] === label);
  if (!found) throw new Error(`button: ${label}`);
  return found;
}
function click(element: FakeElement) {
  (element.props.onClick as (event: unknown) => void)({ currentTarget: { focus() {} } });
}
function copy(run_id: string, size_bytes: number, extra: Partial<GmoLocalCopy> = {}): GmoLocalCopy {
  return { run_id, size_bytes, episode_count: 3, is_eval: false, started_at: null, deletable: true, ...extra };
}
async function open({ site = 'b300', enabled = true, rows = [copy('ev-large', 29_400_000_000, { is_eval: true, started_at: '2026-11-20T00:00:00Z' }), copy('run-small', 800)] } = {}) {
  resetBrowser();
  setLocation(`/evals?site=${site}`);
  const root = site === 'b300' ? '/api' : `/api/sites/${site}`;
  const state = { rows, failure: null as string | null, latency: 5, enabled };
  net.handler = request => {
    if (request.path === `${root}/evals`) return { json: { evals: [], ...(state.enabled ? { remote_status: { fetched_at: '2026-11-20T00:00:00Z', refreshing: false, error: null } } : {}) } };
    if (request.path === `${root}/gmo/local-copies`) return { json: { runs: state.rows, total_bytes: state.rows.reduce((total, row) => total + row.size_bytes, 0) } satisfies GmoLocalCopies };
    if (request.path === `${root}/gmo/local-copies/delete`) {
      if (state.failure) return { status: state.failure === 'unknown' ? 502 : 409, json: { detail: { reason: state.failure, message: 'Server refusal' } }, latency: state.latency };
      state.rows = state.rows.filter(row => row.run_id !== 'ev-large');
      return { json: { run_id: 'ev-large', freed_bytes: 29_400_000_000 }, latency: state.latency };
    }
    return null;
  };
  const page = mount(EvalListPage, {});
  await advance(100);
  return { page, state, root };
}
async function showPanel(page: ReturnType<typeof mount<Record<string, never>>>) {
  const trigger = findAll(page.output, 'button').find(item => text(item).startsWith('手元の写し '));
  if (!trigger) throw new Error('local copies button');
  click(trigger); await advance(100);
}

test('local copies button opens an accessible largest-first panel with sizes and evaluation time', async () => {
  const { page } = await open({ rows: [copy('run-small', 800), copy('ev-large', 29_400_000_000, { is_eval: true, started_at: '2026-11-20T00:00:00Z' })] });
  const trigger = button(page.output, '手元の写し 29.4 GB');
  assert.equal(trigger.props['aria-expanded'], false);
  click(trigger); await advance(100);
  assert.equal(button(page.output, '手元の写し 29.4 GB').props['aria-expanded'], true);
  const section = findAll(page.output, 'section').find(item => item.props.id === trigger.props['aria-controls'])!;
  assert.ok(section);
  assert.equal(section.props['aria-labelledby'], 'eval-local-copies-title');
  const rows = findAll(section, 'li');
  assert.deepEqual(rows.map(row => text(findAll(row, 'strong')[0])), ['ev-large', 'run-small']);
  assert.match(text(rows[0]), /3 試行29.4 GB/);
  assert.equal(findAll(rows[0], 'time')[0].props.dateTime, '2026-11-20T00:00:00Z');
  assert.equal(findAll(rows[1], 'time').length, 0);
  assert.match(text(rows[1]), /800 B/);
  click(button(page.output, '閉じる')); await advance(0);
  assert.equal(findAll(page.output, 'section').length, 0);
  page.unmount();
});

test('delete confirmation describes remote safety and automatic-import behavior and can be cancelled', async () => {
  const { page } = await open();
  await showPanel(page);
  let restored = 0;
  const label = 'ev-large の手元の写しを消す';
  (button(page.output, label).props.onClick as (event: unknown) => void)({ currentTarget: { focus() { if (!button(page.output, label).props.disabled) restored += 1; } } });
  await advance(0);
  const dialog = findAll(page.output, 'div').find(item => item.props.role === 'alertdialog')!;
  assert.ok(dialog);
  assert.equal(dialog.props['aria-describedby'], 'eval-local-confirm-text');
  assert.match(text(dialog), /ev-large の手元の写し（29.4 GB）を消します。GMO 上の記録は消えません。自動では取り込み直さず、試行を開いたときにその試行だけ取り込みます。/);
  click(button(dialog, 'やめる')); await advance(0);
  assert.equal(findAll(page.output, 'div').filter(item => item.props.role === 'alertdialog').length, 0);
  assert.equal(net.log.filter(req => req.path.endsWith('/delete')).length, 0);
  assert.equal(restored, 1, 'focus returns after the row button becomes enabled');
  click(button(page.output, 'ev-large の手元の写しを消す')); await advance(0);
  const second = findAll(page.output, 'div').find(item => item.props.role === 'alertdialog')!;
  (second.props.onKeyDown as (event: unknown) => void)({ key: 'Escape', preventDefault() {} });
  await advance(0);
  assert.equal(findAll(page.output, 'div').filter(item => item.props.role === 'alertdialog').length, 0);
  page.unmount();
});

test('successful deletion submits once while busy, reports freed space and refreshes the panel and evaluations', async () => {
  const { page, state, root } = await open();
  state.latency = 1000;
  await showPanel(page);
  const panelReads = net.log.filter(req => req.path === `${root}/gmo/local-copies`).length;
  const evalReads = net.log.filter(req => req.path === `${root}/evals`).length;
  click(button(page.output, 'ev-large の手元の写しを消す')); await advance(0);
  const confirm = findAll(page.output, 'div').find(item => item.props.role === 'alertdialog')!;
  const remove = button(confirm, '消す');
  click(remove); click(remove); await advance(0);
  assert.equal(net.log.filter(req => req.path.endsWith('/delete')).length, 1);
  assert.equal(button(page.output, '消しています…').props.disabled, true);
  assert.equal(button(page.output, 'やめる').props.disabled, true);
  assert.equal(button(page.output, '手元の写し 29.4 GB').props.disabled, true);
  await advance(1100);
  assert.match(text(page.output), /29.4 GB を空けました/);
  assert.equal(findAll(page.output, 'div').filter(item => item.props.role === 'alertdialog').length, 0);
  assert.equal(button(page.output, '手元の写し 800 B').props.disabled, false);
  assert.equal(findAll(page.output, 'strong').some(row => text(row) === 'ev-large'), false);
  assert.equal(net.log.filter(req => req.path === `${root}/gmo/local-copies`).length, panelReads + 1);
  assert.equal(net.log.filter(req => req.path === `${root}/evals`).length, evalReads + 1);
  page.unmount();
});

test('local copy rows explain every refusal and deletion failures translate the fresh server reason', async () => {
  for (const site of ['b300', 'rtx']) {
    const remote = site === 'b300' ? 'GMO' : 'RTX';
    const expected: Record<string, string> = {
      busy: '実行中か取り込み中のため消せません',
      not_on_remote: `${remote} に元の記録がないため消せません（消すと戻せません）`,
      unknown: `${remote} の一覧を確認できないため、今は消せません`,
    };
    const { page, state, root } = await open({ site, rows: [copy('ev-large', 29_400_000_000), ...Object.keys(expected).map(reason => copy(`run-${reason}`, 100, { deletable: false, reason }))] });
    await showPanel(page);
    for (const [reason, message] of Object.entries(expected)) {
      const row = findAll(page.output, 'li').find(item => text(item).startsWith(`run-${reason}`))!;
      assert.ok(text(row).includes(message));
      assert.equal(findAll(row, 'button').length, 0);
      state.failure = reason;
      click(button(page.output, 'ev-large の手元の写しを消す')); await advance(0);
      const dialog = findAll(page.output, 'div').find(item => item.props.role === 'alertdialog')!;
      assert.ok(text(dialog).includes(`${remote} 上の記録は消えません`));
      click(button(dialog, '消す')); await advance(100);
      assert.ok(findAll(page.output, 'p').some(item => item.props.role === 'alert' && text(item) === message));
      assert.equal(button(page.output, 'やめる').props.disabled, false);
      click(button(page.output, 'やめる')); await advance(0);
    }
    assert.ok(net.log.every(req => req.path.startsWith(root)));
    page.unmount();
  }
});

test('local copies button and requests stay hidden when the selected site has no GMO service', async () => {
  const { page } = await open({ enabled: false, site: 'rtx' });
  assert.equal(findAll(page.output, 'button').some(item => text(item).startsWith('手元の写し')), false);
  assert.equal(net.log.some(req => req.path.includes('/gmo/')), false);
  page.unmount();
});
