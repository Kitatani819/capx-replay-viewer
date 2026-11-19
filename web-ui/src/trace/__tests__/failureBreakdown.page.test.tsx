import { advance, findAll, resetBrowser, type FakeElement } from './harness/browser';
import { mount } from './harness/fakeReact';
import test from 'node:test';
import assert from 'node:assert/strict';
import { FailureBreakdown } from '../../evals/FailureBreakdown';
import { breakdownDetail } from './failureBreakdownFixtures';

function text(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return typeof node === 'object' && 'props' in node ? text((node as FakeElement).props.children) : '';
}
test('clicking a breakdown button selects its category and lists only current trials', async () => {
  resetBrowser();
  const page = mount(FailureBreakdown, { detail: breakdownDetail() });
  assert.match(text(page.output), /エラーで停止：今回 2件/);
  assert.deepEqual(findAll(page.output, 'a').map(a => a.props.href), ['/traces?run=current&episode=c2', '/traces?run=current&episode=c3']);
  const button = findAll(page.output, 'button').find(b => text(b).includes('FINISHだが未達成'))!;
  (button.props.onClick as () => void)(); await advance(0);
  assert.match(text(page.output), /FINISHだが未達成：今回 1件/);
  assert.match(text(page.output), /基準：成功/);
  assert.match(text(page.output), /悪化/);
  assert.deepEqual(findAll(page.output, 'a').map(a => a.props.href), ['/traces?run=current&episode=c1']);
  assert.equal(findAll(page.output, 'button').filter(b => b.props['aria-pressed'] === true).length, 1);
  (findAll(page.output, 'button').find(b => text(b).includes('書き直しの上限'))!.props.onClick as () => void)(); await advance(0);
  assert.match(text(page.output), /この分類の試行はありません/);
  page.unmount();
});
