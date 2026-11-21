import { advance, currentParams, findAll, net, propsOf, resetBrowser, setLocation } from './harness/browser';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from './harness/fakeReact';
import { EvalComparison, EvalDetailPage, EvalListPage, EvalListTable } from '../../evals/EvalPages';
import { breakdownDetail } from './failureBreakdownFixtures';

test('completed evaluation continues polling a running baseline and stops when both finish', async () => {
  resetBrowser();
  let baselineRunning = true;
  const detail = breakdownDetail();
  net.handler = req => req.path === '/api/evals/current' ? { json: {
    ...detail,
    baseline: { ...detail.baseline!, status: baselineRunning ? 'running' : 'completed' },
    baseline_summary: { trials: 4, success: baselineRunning ? 1 : 2 },
    remote_status: { fetched_at: '2026-11-21T01:00:00Z', refreshing: false, error: null },
  } } : null;
  const page = mount(EvalDetailPage, { evalId: 'current' });
  await advance(100);
  const reads = () => net.log.filter(req => req.path === '/api/evals/current').length;
  assert.equal(reads(), 1);
  await advance(90_000);
  assert.equal(reads(), 4, 'the baseline remains live after the current evaluation has ended');
  baselineRunning = false;
  await advance(30_000);
  assert.equal(reads(), 5);
  const displayed = propsOf<Parameters<typeof EvalComparison>[0]>(page.output, EvalComparison).detail;
  assert.equal(displayed.baseline?.status, 'completed');
  assert.equal(displayed.baseline_summary?.success, 2);
  await advance(90_000);
  assert.equal(reads(), 5);
  page.unmount();
});

for (const failedStatus of ['cold', 'cached', 'legacy'] as const) {
  test(`shared evaluation filters survive ${failedStatus} discovery failure and reconnect`, async () => {
    resetBrowser();
    setLocation('/evals?by=remote-author&task=remote-task');
    const remote = breakdownDetail(false);
    remote.eval!.by = 'remote-author';
    remote.summary = { trials: 5, success: 1, failure: 3, unknown: 1, incomplete: 0,
      tasks: ['remote-task'], seeds: [1, 2, 3, 4, 5], models: {}, config_flags: {}, mixed: [] };
    let ready = false;
    net.handler = req => req.path === '/api/evals' ? { json: {
      evals: ready ? [remote] : [],
      error: !ready && failedStatus === 'legacy' ? 'リモートの一覧を取得できません' : null,
      remote_status: failedStatus === 'legacy' && !ready ? null : {
        fetched_at: ready || failedStatus === 'cached' ? '2026-11-21T01:00:00Z' : null,
        refreshing: false,
        error: ready ? null : 'connection failed',
      },
    } } : null;
    const page = mount(EvalListPage, {});
    await advance(100);
    const filters = () => findAll(page.output, 'select').filter(item => ['実行者', 'タスク'].includes(item.props['aria-label'] as string));
    assert.deepEqual(filters().map(item => item.props.value), ['remote-author', 'remote-task']);
    assert.equal(currentParams().get('by'), 'remote-author');
    assert.equal(currentParams().get('task'), 'remote-task');
    ready = true;
    await advance(30_000);
    assert.equal(currentParams().get('by'), 'remote-author');
    assert.equal(currentParams().get('task'), 'remote-task');
    assert.deepEqual(propsOf<Parameters<typeof EvalListTable>[0]>(page.output, EvalListTable).entries.map(entry => entry.eval_id), [remote.eval_id]);
    page.unmount();
  });
}
