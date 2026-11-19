import test from 'node:test';
import assert from 'node:assert/strict';
import { baselineTrialFor, comparisonTable } from '../../evals/model';
import type { EvalTrial } from '../../evals/api';

const identity = { task: 'cube', seed: 7, condition: 'current_config' };
function trial(episodeId: string, condition: string | null, extra: Partial<EvalTrial> = {}): EvalTrial {
  return { episode_id: episodeId, task: 'cube', condition, seed: 7, attempt: 1, verdict: 'success', status: 'ended', trace_complete: true, local_state: 'local', ...extra };
}
test('same task/seed pairs across a unique changed condition using the existing latest-attempt rule', () => {
  const old = trial('old', 'baseline_config', { start_wall_time: 100, attempt: 3, runner_invocation: 1 });
  const recent = trial('recent', 'baseline_config', { start_wall_time: 200, attempt: 1, runner_invocation: 2 });
  for (const baseline of [[old, recent], [recent, old]]) assert.equal(baselineTrialFor(identity, baseline)?.episode_id, 'recent');
  assert.equal(baselineTrialFor(identity, [trial('old', 'baseline_config'), trial('retry', 'baseline_config', { attempt: 2 })])?.episode_id, 'retry');
  // The per-condition evaluation table still retains its original independent rows.
  const table = comparisonTable([trial('current', 'current_config')], [old]);
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows.find(row => row.condition === 'current_config')?.baseline.size, 0);
});
test('exact condition takes priority and multiple alternative conditions remain ambiguous', () => {
  const alternatives = [trial('a', 'A'), trial('b', 'B')];
  assert.equal(baselineTrialFor(identity, alternatives), null);
  assert.equal(baselineTrialFor(identity, [...alternatives, trial('exact', 'current_config')])?.episode_id, 'exact');
  assert.equal(baselineTrialFor({ ...identity, condition: null }, alternatives), null);
  assert.equal(baselineTrialFor(identity, [trial('only_missing_condition', null)])?.episode_id, 'only_missing_condition');
});
test('baseline pairing requires known task and seed and cannot join unrelated trials', () => {
  const baseline = [trial('match', 'baseline_config')];
  assert.equal(baselineTrialFor({ ...identity, task: null }, baseline), null);
  assert.equal(baselineTrialFor({ ...identity, seed: null }, baseline), null);
  assert.equal(baselineTrialFor({ ...identity, seed: 8 }, baseline), null);
  assert.equal(baselineTrialFor({ ...identity, task: 'different' }, baseline), null);
});
