import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { EvalListEntry, EvalSummary } from '../../evals/api';
import { SuccessTrend } from '../../evals/SuccessTrend';
import { successTrend, trendTasks } from '../../evals/trendModel';

export function trendEntry(id: string, started: string, extra: Partial<EvalListEntry> = {}): EvalListEntry {
  const summary: EvalSummary = { trials: 4, success: 2, failure: 1, unknown: 1, incomplete: 1,
    by_task: { cube: { trials: 3, success: 2 }, nut: { trials: 1, success: 0 } },
    tasks: ['cube', 'nut'], seeds: [401, 402], models: {}, config_flags: {}, mixed: [] };
  return { eval_id: id, eval: { schema: 'capx-eval/1', eval_id: id, status: 'completed', by: '', changed: id,
    baseline_eval_id: null, eval_set: null, git: null, started_at: started, heartbeat_at: started, ended_at: started, summary },
    summary, error: null, display_status: 'incomplete', baseline_summary: null, location: 'local', ...extra };
}

test('trend orders evaluations by start time without mutating listing order or hiding uncertain denominators', () => {
  const newer = trendEntry('new', '2026-11-20T12:00:00Z');
  const older = trendEntry('old', '2026-11-19T12:00:00Z');
  const entries = [newer, older, trendEntry('bad-date', 'invalid'), { ...older, eval_id: 'invalid', eval: null }];
  const points = successTrend(entries);
  assert.deepEqual(points.map(point => point.entry.eval_id), ['old', 'new']);
  assert.equal(entries[0], newer);
  assert.equal(points[0].fraction, .5); // 2 / all 4 recorded trials, including the unjudged one.
  assert.equal(points[0].provisional, true);
  assert.match(points[0].state, /未判定 1件.*記録欠損 1件/);
  assert.deepEqual(trendTasks(entries), ['cube', 'nut']);
  assert.equal(successTrend(entries, 'cube')[0].fraction, 2 / 3);
  assert.match(successTrend(entries, 'cube')[0].state, /評価全体で未判定/);
  assert.deepEqual(successTrend(entries, 'not-recorded'), []);
});

test('missing, empty and live summaries remain gaps or provisional values rather than zero-percent failures', () => {
  const missing = trendEntry('missing', '2026-11-20T01:00:00Z', { summary: null });
  missing.eval = { ...missing.eval!, status: 'running', summary: null, ended_at: null };
  const empty = trendEntry('empty', '2026-11-20T02:00:00Z');
  empty.summary = { ...empty.summary!, trials: 0, success: 0, failure: 0, unknown: 0, incomplete: 0, by_task: {} };
  const live = trendEntry('live', '2026-11-20T03:00:00Z');
  live.eval = { ...live.eval!, status: 'running', ended_at: null };
  live.display_status = 'interrupted';
  const points = successTrend([live, empty, missing]);
  assert.deepEqual(points.map(point => point.fraction), [null, null, .5]);
  assert.match(points[0].state, /実行中.*集計未記録/);
  assert.match(points[2].state, /中断の可能性/);
  assert.equal(points[2].provisional, true);
  const good = trendEntry('good', '2026-11-20T04:00:00Z');
  good.summary = { ...good.summary!, unknown: 0, incomplete: 0 };
  assert.equal(successTrend([good])[0].provisional, false);
});

test('accessible chart links points to evaluations and exposes denominators, gaps and condition caveats', () => {
  const entries = ['01', '02', '03'].map(hour => trendEntry(`eval-${hour}`, `2026-11-20T${hour}:00:00Z`));
  entries[1].summary = { ...entries[1].summary!, trials: 0, success: 0, by_task: {} };
  const html = renderToStaticMarkup(<SuccessTrend entries={entries} />);
  assert.match(html, /推移に表示する課題/);
  assert.match(html, /全課題/);
  assert.match(html, /aria-label="成功率の推移/);
  assert.match(html, /href="\/evals\/eval-01"/);
  assert.match(html, /2\/4/);
  assert.match(html, /0\/0/);
  assert.match(html, /未判定・実行中の試行や再試行も分母/);
  assert.match(html, /課題・seed・モデル・設定が異なる/);
  assert.doesNotMatch(html, /<polyline/); // The missing denominator breaks the line.
  assert.equal([...html.matchAll(/<circle /g)].length, 2);
});
