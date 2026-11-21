import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { comparisonTable } from '../../evals/model';
import { EvalComparison } from '../../evals/EvalPages';
import { FailureBreakdown } from '../../evals/FailureBreakdown';
import { breakdownDetail, classifiedTrial } from './failureBreakdownFixtures';

test('comparison retains unidentified episodes separately without retries or baseline pairing', () => {
  const current = [
    classifiedTrial('missing-seed-1', 1, 'error', { seed: null }),
    classifiedTrial('missing-seed-2', 1, 'error', { seed: null }),
    classifiedTrial('missing-task-1', 7, 'error', { task: null }),
    classifiedTrial('missing-task-2', 7, 'error', { task: null }),
  ];
  // Episode identifiers may be reused across evaluations, but are not task/seed identities.
  const baseline = current.map(trial => ({ ...trial, verdict: 'success' as const }));
  const table = comparisonTable(current, baseline);
  assert.equal(table.currentTrials.length, 4);
  assert.equal(table.baselineTrials.length, 4);
  assert.equal(table.rows.length, 8);
  assert.equal(new Set(table.rows.map(row => row.key)).size, 8);
  assert.equal(table.omittedRetries, 0);
  assert.equal(table.regressions, 0);
  assert.ok(table.rows.every(row => !(row.current.size && row.baseline.size)));
  assert.ok(table.rows.every(row => [...row.current.values(), ...row.baseline.values()].every(cell => !cell.retried)));

  const detail = breakdownDetail();
  detail.trials = current;
  detail.baseline_trials = baseline;
  const comparisonHtml = renderToStaticMarkup(<EvalComparison detail={detail} />);
  const breakdownHtml = renderToStaticMarkup(<FailureBreakdown detail={detail} />);
  for (const trial of current) assert.ok(comparisonHtml.includes(`episode=${trial.episode_id}`), trial.episode_id);
  assert.doesNotMatch(comparisonHtml, /class="eval-compare-link"|再試行あり/);
  assert.match(breakdownHtml, /失敗 4件（基準 0件）/);
  assert.doesNotMatch(breakdownHtml, /再試行 \d+件/);
});
