import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { FailureBreakdown } from '../../evals/FailureBreakdown';
import { breakdownTrials, changeTag, reasonCounts } from '../../evals/failureReasons';
import { EvalComparison } from '../../evals/EvalPages';
import { breakdownDetail, classifiedTrial } from './failureBreakdownFixtures';

test('breakdown counts each recorded trial and keeps unclassified records unknown', () => {
  const d = breakdownDetail();
  assert.deepEqual(reasonCounts(d.trials), { error: 2, timeout: 0, finish_unmet: 1, regen_limit: 0, unknown: 1 });
  assert.deepEqual(reasonCounts(d.baseline_trials), { error: 1, timeout: 2, finish_unmet: 0, regen_limit: 0, unknown: 0 });
  assert.equal(reasonCounts([classifiedTrial('old', 1, 'success', { end_classification: undefined })]).unknown, 1);
  const html = renderToStaticMarkup(<FailureBreakdown detail={d} />);
  assert.match(html, /基準 3件 → 今回 4件/);
  assert.match(html, /failure-increase[^>]*>\+1/);
  assert.match(html, /failure-decrease[^>]*>-2/);
  assert.match(html, /分類は記録から自動で推測したもので、外れることがあります。/);
});
test('selected current trials pair with the latest baseline by task, condition and seed', () => {
  const d = breakdownDetail();
  d.baseline_trials.push(classifiedTrial('b2-new', 2, 'finish_unmet', { attempt: 2 }));
  const trials = breakdownTrials(d.trials, d.baseline_trials, 'error');
  assert.deepEqual(trials.map(t => [t.trial.episode_id, t.baseline?.episode_id, t.tag]), [['c2', 'b2-new', '別の失敗へ'], ['c3', 'b3', '変わらず']]);
  assert.equal(breakdownTrials(d.trials, d.baseline_trials, 'finish_unmet')[0].tag, '悪化');
  assert.equal(changeTag(classifiedTrial('b', 1, 'error'), classifiedTrial('c', 1, 'success')), '改善');
  assert.equal(changeTag(undefined, d.trials[0]), '比較なし');
  d.trials[1].condition = 'different';
  assert.equal(breakdownTrials(d.trials, d.baseline_trials, 'error')[0].baseline?.episode_id, 'b2-new');
  d.baseline_trials.push(classifiedTrial('b2-other', 2, 'error', { condition: 'another' }));
  assert.equal(breakdownTrials(d.trials, d.baseline_trials, 'error')[0].baseline, undefined);
});
test('without baseline only current counts and trial links are displayed', () => {
  const html = renderToStaticMarkup(<FailureBreakdown detail={breakdownDetail(false)} />);
  assert.doesNotMatch(html, /基準|増減|failure-bar-baseline|比較なし/);
  assert.match(html, /今回 4件/);
  assert.match(html, /href="\/traces\?run=current&amp;episode=c2"/);
});
test('comparison cell links include both matching trial ids and omit missing pairs', () => {
  const d = breakdownDetail();
  const html = renderToStaticMarkup(<EvalComparison detail={d} />);
  assert.match(html, /href="\/traces\/compare\?run=current&amp;episode=c1&amp;baseline_run=baseline&amp;baseline_episode=b1"/);
  assert.doesNotMatch(html, /\/traces\/compare\?run=current&amp;episode=c5/);
});
