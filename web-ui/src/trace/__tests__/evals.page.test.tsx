import { advance, findAll, net, propsOf, resetBrowser, type FakeElement } from './harness/browser';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from './harness/fakeReact';
import { EvalComparison, EvalDetailPage, EvalListPage, EvalListTable } from '../../evals/EvalPages';
import { Breadcrumb } from '../../navigation/Breadcrumb';
import { breakdownDetail } from './failureBreakdownFixtures';

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
    assert.equal(links[0].props.href, '/evals');
    assert.equal(text(links[0]), '評価一覧');
    assert.equal(findAll(breadcrumb.output, 'span').find(item => item.props['aria-current'] === 'page')?.props.children, label);
    assert.doesNotMatch(text(page.output), /← 評価一覧/);
    breadcrumb.unmount(); page.unmount();
  }
});
