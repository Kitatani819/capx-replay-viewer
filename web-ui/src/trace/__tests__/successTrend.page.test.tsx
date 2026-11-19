import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from './harness/fakeReact';
import { advance, findAll, type FakeElement } from './harness/browser';
import { SuccessTrend } from '../../evals/SuccessTrend';
import type { EvalListEntry, EvalSummary } from '../../evals/api';

function text(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return typeof node === 'object' && 'props' in node ? text((node as FakeElement).props.children) : '';
}

test('task selector changes rates and handles a disappeared task after a list refresh', async () => {
  const summary: EvalSummary = { trials: 4, success: 2, failure: 2, unknown: 0, incomplete: 0,
    by_task: { cube: { trials: 3, success: 2 }, nut: { trials: 1, success: 0 } },
    tasks: ['cube', 'nut'], seeds: [401], models: {}, config_flags: {}, mixed: [] };
  const entry: EvalListEntry = { eval_id: 'eval', eval: { schema: 'capx-eval/1', eval_id: 'eval', status: 'completed',
    by: '', changed: 'test', baseline_eval_id: null, eval_set: null, git: null, started_at: '2026-11-20T01:00:00Z',
    heartbeat_at: '2026-11-20T01:00:00Z', ended_at: '2026-11-20T01:00:00Z', summary },
    summary, error: null, display_status: null, baseline_summary: null, location: 'local' };
  const chart = mount(SuccessTrend, { entries: [entry] });
  assert.match(text(chart.output), /2\/4（50%）/);
  const select = findAll(chart.output, 'select')[0];
  (select.props.onChange as (event: unknown) => void)({ target: { value: 'cube' } });
  await advance(1);
  assert.match(text(chart.output), /2\/3（67%）/);
  assert.match(text(chart.output), /未判定・記録欠損の件数は評価全体/);
  assert.equal(findAll(chart.output, 'select')[0].props.value, 'cube');
  chart.update({ entries: [{ ...entry, summary: { ...summary, by_task: {} } }] });
  assert.equal(findAll(chart.output, 'select')[0].props.value, '');
  assert.match(text(chart.output), /2\/4（50%）/);
  chart.unmount();
});
