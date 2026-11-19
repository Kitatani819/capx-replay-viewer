import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { TrialConditions } from '../../evals/TrialConditions';

test('recorded cycle limits and shared budget use plain words without invented values', () => {
  const html = renderToStaticMarkup(<TrialConditions ending={{ reason: 'success', label: '成功', evidence: {},
    conditions: { step_limit: 8000, steps_used: 42, evaluation_budget_s: 600, evaluation_elapsed_s: 123,
      success_policy: 'per_cycle_sticky' } }} />);
  for (const text of ['42 / 8,000', '123 / 600 秒', '一度でも成功なら達成']) assert.ok(html.includes(text));
  assert.equal(renderToStaticMarkup(<TrialConditions />), '');
  const limitOnly = renderToStaticMarkup(<TrialConditions ending={{ reason: 'unknown', label: '', evidence: {}, conditions: { step_limit: 1500 } }} />);
  assert.match(limitOnly, /上限 1,500/);
  assert.doesNotMatch(limitOnly, /0 \/|評価全体/);
});
