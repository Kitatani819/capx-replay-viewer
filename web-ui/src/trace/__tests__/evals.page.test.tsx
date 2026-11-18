import { advance, findAll, net, propsOf, resetBrowser, type FakeElement } from './harness/browser';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from './harness/fakeReact';
import { EvalComparison, EvalDetailPage, EvalListPage, EvalListTable } from '../../evals/EvalPages';

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
  assert.ok(findAll(page.output, 'a').some(a => a.props.href === '/evals'));
  page.unmount();
});
