import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { exactDiscordanceP, pairedResult, significanceLabel } from '../../evals/significance';
import { PairedSignificance } from '../../evals/PairedSignificance';
import type { EvalDetail, EvalTrial } from '../../evals/api';

function trial(seed: number, verdict: EvalTrial['verdict'], extra: Partial<EvalTrial> = {}): EvalTrial {
  return { episode_id: `trial-${seed}`, task: 'cube', condition: 'C', seed, attempt: 1, verdict,
    status: 'ended', trace_complete: true, local_state: 'local', ...extra };
}
function pairs(wins: number, losses: number) {
  return pairedResult(Array.from({ length: wins + losses }, (_, i) => trial(i, i < wins ? 'success' : 'failure')),
    Array.from({ length: wins + losses }, (_, i) => trial(i, i < wins ? 'failure' : 'success')));
}
test('exact two-sided McNemar probabilities include the zero-discordance boundary', () => {
  for (const [wins, losses, expected] of [[0, 0, 1], [1, 0, 1], [5, 0, .0625], [6, 0, .03125], [0, 6, .03125], [8, 2, .109375], [5, 5, 1]]) {
    assert.ok(Math.abs(exactDiscordanceP(wins, losses) - expected) < 1e-12);
  }
  assert.throws(() => exactDiscordanceP(-1, 2), RangeError);
  assert.throws(() => exactDiscordanceP(1.5, 2), RangeError);
  assert.ok(Number.isFinite(exactDiscordanceP(2000, 1999)));
  assert.ok(exactDiscordanceP(2000, 1999) > .99);
  assert.equal(exactDiscordanceP(2000, 0), 0);
});
test('only exact task-condition-seed pairs with known outcomes enter the test', () => {
  const result = pairedResult([
    trial(1, 'success'), trial(2, 'failure'), trial(3, 'success'), trial(4, 'failure'),
    trial(5, 'unknown'), trial(6, 'success'), trial(7, 'success', { condition: 'other' }),
    trial(8, 'success', { task: null }), trial(9, 'success', { condition: null }),
    trial(10, 'success', { seed: null }), trial(11, 'running'),
  ], [trial(1, 'failure'), trial(2, 'success'), trial(3, 'success'), trial(4, 'failure'),
    trial(5, 'success'), trial(7, 'failure'), trial(11, 'failure')]);
  assert.deepEqual(result, { paired: 4, improved: 1, worsened: 1, bothSuccess: 1, bothFailure: 1,
    unmatched: 4, unjudged: 2, unidentified: 2, omittedRetries: 0, p: 1 });
});
test('retries use the same last attempt as the displayed comparison table', () => {
  const now = [trial(1, 'success', { attempt: 1 }), trial(1, 'failure', { attempt: 2 })];
  for (const current of [now, [...now].reverse()]) {
    const result = pairedResult(current, [trial(1, 'success')]);
    assert.equal(result.worsened, 1);
    assert.equal(result.omittedRetries, 1);
  }
});
test('wording distinguishes clear directions, limited power, and provisional results', () => {
  assert.equal(significanceLabel(pairs(6, 0)), 'はっきり改善');
  assert.equal(significanceLabel(pairs(0, 6)), 'はっきり悪化');
  assert.equal(significanceLabel(pairs(5, 0)), 'ぶれの範囲内か、試行数が足りません');
  assert.equal(significanceLabel(pairs(6, 0), true), '実行中のため、結論は保留');
  assert.equal(significanceLabel(pairs(0, 0)), 'まだ比べられません');
});
test('repeat observations are linked and never added to significance counts', () => {
  const trials = Array.from({ length: 6 }, (_, i) => trial(i, 'success'));
  const before = trials.map(t => ({ ...t, verdict: 'failure' as const }));
  const detail = { eval: { status: 'completed' }, baseline: { status: 'completed' }, trials, baseline_trials: before,
    repeat_references: [{ side: 'current', eval: { eval_id: 'ev-repeat' }, trials: before }] } as EvalDetail;
  const html = renderToStaticMarkup(<PairedSignificance detail={detail} />);
  assert.match(html, /はっきり改善/);
  assert.match(html, /判定済み 6組/);
  assert.match(html, /p値 0.0313/);
  assert.match(html, /href="\/evals\/ev-repeat"/);
  assert.match(html, /6組中 6組（100.0%）/);
  assert.match(html, /判定には加えていません/);
});

test('the default null condition pairs only with the same default condition', () => {
  const result = pairedResult([trial(1, 'success', { condition: null }), trial(2, 'success', { condition: null })],
    [trial(1, 'failure', { condition: null }), trial(2, 'failure', { condition: 'C' })]);
  assert.equal(result.paired, 1);
  assert.equal(result.improved, 1);
  assert.equal(result.unmatched, 2);
});
