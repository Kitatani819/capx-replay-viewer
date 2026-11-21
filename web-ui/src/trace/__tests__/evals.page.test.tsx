import { advance, findAll, net, propsOf, resetBrowser, type FakeElement } from './harness/browser';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from './harness/fakeReact';
import { EvalComparison, EvalDetailPage, EvalListPage, EvalListTable } from '../../evals/EvalPages';
import { Breadcrumb } from '../../navigation/Breadcrumb';
import { breakdownDetail } from './failureBreakdownFixtures';
import type { RemoteListingStatus } from '../api';

function text(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (typeof node === 'object' && 'props' in node) return text((node as FakeElement).props.children);
  return '';
}
test('evaluation list reads /api/evals, shows connection errors without losing local entries and polls', async () => {
  resetBrowser();
  net.handler = req => req.path === '/api/evals' ? { json: { evals: [], error: 'GMO の一覧を取得できません' } } : null;
  const page = mount(EvalListPage, {});
  await advance(100);
  assert.match(text(page.output), /評価の記録がありません/);
  assert.match(text(page.output), /GMO の一覧を取得できません/);
  assert.equal(findAll(page.output, 'select').length, 0);
  const crumbProps = propsOf<Parameters<typeof Breadcrumb>[0]>(page.output, Breadcrumb);
  assert.deepEqual(crumbProps.items, [{ label: '評価一覧' }]);
  const breadcrumb = mount(Breadcrumb, crumbProps);
  assert.equal(findAll(breadcrumb.output, 'nav')[0].props['aria-label'], '現在の場所');
  assert.equal(findAll(breadcrumb.output, 'a').length, 0);
  assert.equal(findAll(breadcrumb.output, 'span').find(item => item.props['aria-current'] === 'page')?.props.children, '評価一覧');
  breadcrumb.unmount();
  await advance(30_000);
  assert.equal(net.log.filter(req => req.path === '/api/evals').length, 2);
  net.handler = req => req.path === '/api/evals' ? { json: { evals: [{ eval_id: 'bad', eval: null, error: 'schema', location: 'local' }] } } : null;
  await advance(30_000);
  assert.equal(propsOf<Parameters<typeof EvalListTable>[0]>(page.output, EvalListTable).entries[0].error, 'schema');
  page.unmount();
});
test('evaluation detail loads its pathname id through the API and provides list navigation', async () => {
  resetBrowser();
  net.handler = req => req.path === '/api/evals/ev-demo' ? { json: { eval_id: 'ev-demo', eval: null, error: '不正な記録', trials: [], baseline_trials: [], differences: [] } } : null;
  const page = mount(EvalDetailPage, { evalId: 'ev-demo' });
  await advance(100);
  assert.equal(propsOf<Parameters<typeof EvalComparison>[0]>(page.output, EvalComparison).detail.error, '不正な記録');
  assert.deepEqual(propsOf<Parameters<typeof Breadcrumb>[0]>(page.output, Breadcrumb).items,
    [{ label: '評価一覧', href: '/evals' }, { label: 'ev-demo' }]);
  assert.doesNotMatch(text(page.output), /← 評価一覧/);
  page.unmount();
});
test('evaluation comparison breadcrumb uses the list title and a real ancestor link', async () => {
  for (const hasBaseline of [true, false]) {
    resetBrowser();
    const detail = breakdownDetail(hasBaseline);
    if (!hasBaseline) detail.eval!.changed = '';
    net.handler = req => req.path === '/api/evals/current' ? { json: detail } : null;
    const page = mount(EvalDetailPage, { evalId: 'current' });
    await advance(100);
    const label = hasBaseline ? '把持位置の修正' : '評価（基準）';
    const crumbProps = propsOf<Parameters<typeof Breadcrumb>[0]>(page.output, Breadcrumb);
    assert.deepEqual(crumbProps.items, [{ label: '評価一覧', href: '/evals' }, { label }]);
    const breadcrumb = mount(Breadcrumb, crumbProps);
    const links = findAll(breadcrumb.output, 'a');
    assert.equal(links.length, 1);
    assert.equal(links[0].props.href, '/evals?site=b300');
    assert.equal(text(links[0]), '評価一覧');
    assert.equal(findAll(breadcrumb.output, 'span').find(item => item.props['aria-current'] === 'page')?.props.children, label);
    assert.doesNotMatch(text(page.output), /← 評価一覧/);
    breadcrumb.unmount(); page.unmount();
  }
});

test('evaluation list keeps cached entries, polls a background refresh, and forces only the light listing', async () => {
  resetBrowser();
  let status: RemoteListingStatus = { fetched_at: '2026-11-20T02:34:00Z', refreshing: true, error: null };
  let entries = [{ eval_id: 'local', eval: null, error: 'local record', location: 'local' }];
  net.handler = req => req.path === '/api/evals' ? { json: { evals: entries, remote_status: status } } : null;
  const page = mount(EvalListPage, {});
  await advance(100);
  assert.match(text(page.output), /GMO の一覧：\d{2}:\d{2} 時点（更新中…）/);
  assert.equal(propsOf<Parameters<typeof EvalListTable>[0]>(page.output, EvalListTable).entries[0].eval_id, 'local');
  assert.equal(findAll(page.output, 'button')[0].props.disabled, true);
  status = { ...status, refreshing: false, fetched_at: '2026-11-20T02:35:00Z' };
  entries = [...entries, { eval_id: 'remote', eval: null, error: 'remote record', location: 'gmo' }];
  await advance(2000);
  assert.deepEqual(propsOf<Parameters<typeof EvalListTable>[0]>(page.output, EvalListTable).entries.map(entry => entry.eval_id), ['local', 'remote']);
  assert.doesNotMatch(text(page.output), /更新中/);
  const button = findAll(page.output, 'button')[0];
  assert.equal(button.props.disabled, false);
  status = { ...status, error: 'GMO unavailable' };
  (button.props.onClick as () => void)();
  await advance(100);
  assert.ok(net.log.some(req => req.path === '/api/evals' && req.query.get('refresh') === '1'));
  assert.match(text(page.output), /GMO の一覧：\d{2}:\d{2} 時点（更新に失敗）/);
  assert.equal(propsOf<Parameters<typeof EvalListTable>[0]>(page.output, EvalListTable).entries.length, 2);
  assert.equal(net.log.some(req => req.path === '/api/gmo/episodes'), false);
  page.unmount();
});

test('cold evaluation detail polls its 202 placeholder until the GMO evaluation arrives', async () => {
  resetBrowser();
  const completed = breakdownDetail(true);
  let ready = false;
  net.handler = req => req.path === '/api/evals/current' ? { status: ready ? 200 : 202, json: ready
    ? { ...completed, remote_status: { fetched_at: '2026-11-20T02:34:00Z', refreshing: false, error: null } }
    : { eval_id: 'current', eval: null, loading_remote: true, remote_status: { fetched_at: null, refreshing: true, error: null } } } : null;
  const page = mount(EvalDetailPage, { evalId: 'current' });
  await advance(100);
  assert.match(text(page.output), /GMO の評価を取得中/);
  assert.match(text(page.output), /GMO の一覧：未取得（更新中…）/);
  assert.equal(findAll(page.output, EvalComparison).length, 0);
  ready = true;
  await advance(2000);
  assert.equal(propsOf<Parameters<typeof EvalComparison>[0]>(page.output, EvalComparison).detail.eval_id, completed.eval_id);
  assert.doesNotMatch(text(page.output), /GMO の評価を取得中/);
  const button = findAll(page.output, 'button')[0];
  (button.props.onClick as () => void)();
  await advance(100);
  assert.ok(net.log.some(req => req.path === '/api/evals/current' && req.query.get('refresh') === '1'));
  page.unmount();
});
