import { advance, findAll, resetBrowser, type FakeElement } from './harness/browser';
import { mount } from './harness/fakeReact';
import test from 'node:test';
import assert from 'node:assert/strict';
import { FailureBreakdown } from '../../evals/FailureBreakdown';
import { breakdownDetail, classifiedTrial } from './failureBreakdownFixtures';

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
  const button = findAll(page.output, 'button').find(b => text(b).includes('「終わった」と答えたが未達成'))!;
  (button.props.onClick as () => void)(); await advance(0);
  assert.match(text(page.output), /「終わった」と答えたが未達成：今回 1件/);
  assert.match(text(page.output), /基準：成功/);
  assert.match(text(page.output), /悪化/);
  assert.deepEqual(findAll(page.output, 'a').map(a => a.props.href), ['/traces?run=current&episode=c1']);
  assert.equal(findAll(page.output, 'button').filter(b => b.props['aria-pressed'] === true).length, 1);
  (findAll(page.output, 'button').find(b => text(b).includes('書き直しの上限'))!.props.onClick as () => void)(); await advance(0);
  assert.match(text(page.output), /この分類の試行はありません/);
  page.unmount();
});
test('trial list uses the same unjudged and unknown-ending categories for both evaluations', async () => {
  resetBrowser();
  const detail = breakdownDetail();
  detail.trials = [classifiedTrial('current-error', 1, 'error'),
    classifiedTrial('current-unjudged', 2, 'error', { verdict: 'unknown' }),
    classifiedTrial('current-unknown-ending', 3, 'unknown', { verdict: 'failure' })];
  detail.baseline_trials = [classifiedTrial('baseline-unjudged', 1, 'error', { verdict: 'unknown' }),
    classifiedTrial('baseline-error', 2, 'error'),
    classifiedTrial('baseline-unknown-ending', 3, 'unknown', { verdict: 'failure' })];
  const page = mount(FailureBreakdown, { detail });
  assert.deepEqual(findAll(page.output, 'a').map(a => a.props.href), ['/traces?run=current&episode=current-error']);
  assert.match(text(page.output), /基準：未判定（成否が記録から分からない）/);
  assert.match(text(page.output), /今回：エラーで停止/);
  assert.match(text(page.output), /比較なし/);
  const unjudged = findAll(page.output, 'button').find(b => text(b).startsWith('未判定（成否が記録から分からない）'))!;
  (unjudged.props.onClick as () => void)(); await advance(0);
  assert.deepEqual(findAll(page.output, 'a').map(a => a.props.href), ['/traces?run=current&episode=current-unjudged']);
  assert.match(text(page.output), /基準：エラーで停止/);
  assert.match(text(page.output), /今回：未判定（成否が記録から分からない）/);
  assert.match(text(page.output), /比較なし/);
  const unknownEnding = findAll(page.output, 'button').find(b => text(b).startsWith('終わり方が不明'))!;
  (unknownEnding.props.onClick as () => void)(); await advance(0);
  assert.deepEqual(findAll(page.output, 'a').map(a => a.props.href), ['/traces?run=current&episode=current-unknown-ending']);
  assert.match(text(page.output), /基準：終わり方が不明/);
  assert.match(text(page.output), /今回：終わり方が不明/);
  assert.match(text(page.output), /変わらず/);
  page.unmount();
});
