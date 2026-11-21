import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { FailureBreakdown } from '../../evals/FailureBreakdown';
import { breakdownTrials, changeTag, reasonCounts, trialCategory } from '../../evals/failureReasons';
import { EvalComparison } from '../../evals/EvalPages';
import { comparisonTable } from '../../evals/model';
import { breakdownDetail, classifiedTrial } from './failureBreakdownFixtures';

test('breakdown separates failures from unjudged trials and preserves category order', () => {
  const d = breakdownDetail();
  assert.deepEqual(reasonCounts(d.trials), { error: 2, timeout: 0, finish_unmet: 1, submission_reset: 0, regen_limit: 0, single_shot: 0, unknown: 0, unjudged: 1 });
  assert.deepEqual(reasonCounts(d.baseline_trials), { error: 1, timeout: 2, finish_unmet: 0, submission_reset: 0, regen_limit: 0, single_shot: 0, unknown: 0, unjudged: 0 });
  assert.deepEqual(reasonCounts([classifiedTrial('old', 1, 'success', { end_classification: undefined })]),
    { error: 0, timeout: 0, finish_unmet: 0, submission_reset: 0, regen_limit: 0, single_shot: 0, unknown: 0, unjudged: 0 });
  const html = renderToStaticMarkup(<FailureBreakdown detail={d} />);
  assert.match(html, /失敗 3件（基準 3件）・未判定 1件（基準 0件）/);
  const rows = [...html.matchAll(/<button[^>]+aria-label="([^"]+)"/g)].map(match => match[1].split('：')[0]);
  assert.deepEqual(rows, ['エラーで停止', '時間切れ・打ち切り', '「終わった」と答えたが未達成', '提出物が試行を終えた（未達成）', '書き直しの上限', '1回だけ実行して終了（single-shot）', '終わり方が不明', '未判定（成否が記録から分からない）']);
  assert.match(html, /failure-increase[^>]*>\+1/);
  assert.match(html, /failure-decrease[^>]*>-2/);
  assert.match(html, /分類は記録から自動で推測したもので、外れることがあります。/);
  assert.doesNotMatch(html, /最後の試行だけを数えています/);
});
test('verdict precedence keeps unknown and running trials out of failure endings', () => {
  assert.equal(trialCategory(classifiedTrial('unjudged', 1, 'error', { verdict: 'unknown' })), 'unjudged');
  assert.equal(trialCategory(classifiedTrial('running', 2, 'error', { verdict: 'running' })), 'running');
  assert.equal(trialCategory(classifiedTrial('success', 3, 'error', { verdict: 'success' })), 'success');
  assert.equal(trialCategory(classifiedTrial('failed', 4, 'unknown', { verdict: 'failure' })), 'unknown');
  const d = breakdownDetail(false);
  d.trials = [classifiedTrial('unjudged', 1, 'error', { verdict: 'unknown' }),
    classifiedTrial('failed', 2, 'unknown', { verdict: 'failure' }),
    classifiedTrial('running', 3, 'error', { verdict: 'running' })];
  const tableHtml = renderToStaticMarkup(<EvalComparison detail={d} />).split('<section class="failure-breakdown"')[0];
  assert.match(tableHtml, /episode=unjudged[^>]+aria-label="[^"]*未判定[^"]*"[^>]*><span aria-hidden="true">未判定<\/span>/);
  assert.match(tableHtml, /episode=failed[^>]+aria-label="[^"]*終わり方が不明[^"]*"[^>]*><span aria-hidden="true">不明<\/span>/);
  const breakdownHtml = renderToStaticMarkup(<FailureBreakdown detail={d} />);
  assert.match(breakdownHtml, /aria-label="エラーで停止：今回 0件"/);
  assert.match(breakdownHtml, /aria-label="終わり方が不明：今回 1件"/);
  assert.match(breakdownHtml, /aria-label="未判定（成否が記録から分からない）：今回 1件"/);
  assert.match(breakdownHtml, /失敗 1件・未判定 1件/);
  assert.match(breakdownHtml, /今回：終わり方が不明/);
  assert.doesNotMatch(breakdownHtml, /episode=running/);
});
test('breakdown counts only the attempts displayed in the table and explains omitted retries', () => {
  const d = breakdownDetail();
  d.trials = [classifiedTrial('old-error', 1, 'error', { attempt: 3, runner_invocation: 1, start_wall_time: 100 }),
    classifiedTrial('middle-timeout', 1, 'timeout', { attempt: 4, runner_invocation: 1, start_wall_time: 150 }),
    classifiedTrial('last-success', 1, 'success', { attempt: 1, runner_invocation: 2, start_wall_time: 200 }),
    classifiedTrial('old-finish', 2, 'finish_unmet'),
    classifiedTrial('last-unknown', 2, 'unknown', { verdict: 'failure', attempt: 2 })];
  d.baseline_trials = [classifiedTrial('base-old-timeout', 1, 'timeout'),
    classifiedTrial('base-error', 1, 'error', { attempt: 2 })];
  for (const reverse of [false, true]) {
    if (reverse) { d.trials.reverse(); d.baseline_trials.reverse(); }
    const table = comparisonTable(d.trials, d.baseline_trials);
    assert.deepEqual(table.currentTrials.map(t => t.episode_id).sort(), ['last-success', 'last-unknown']);
    assert.deepEqual(table.baselineTrials.map(t => t.episode_id), ['base-error']);
    assert.equal(table.omittedRetries, 4);
    const html = renderToStaticMarkup(<FailureBreakdown detail={d} />);
    assert.match(html, /失敗 1件（基準 1件）・未判定 0件（基準 0件）/);
    assert.match(html, /aria-label="エラーで停止：基準 1件、今回 0件"/);
    assert.match(html, /aria-label="時間切れ・打ち切り：基準 0件、今回 0件"/);
    assert.match(html, /aria-label="終わり方が不明：基準 0件、今回 1件"/);
    assert.match(html, /再試行 4件は最後の試行だけを数えています/);
    assert.match(html, /episode=last-unknown/);
    assert.doesNotMatch(html, /episode=(?:old-error|middle-timeout|old-finish|base-old-timeout)/);
  }
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
  assert.match(html, /失敗 3件・未判定 1件/);
  assert.match(html, /href="\/traces\?run=current&amp;episode=c2"/);
});
test('change tags compare verdict categories rather than raw end reasons', () => {
  const unjudgedError = classifiedTrial('b', 1, 'error', { verdict: 'unknown' });
  const unjudgedTimeout = classifiedTrial('c', 1, 'timeout', { verdict: 'unknown' });
  assert.equal(changeTag(unjudgedError, unjudgedTimeout), '変わらず');
  assert.equal(changeTag(unjudgedError, classifiedTrial('failed', 1, 'error')), '比較なし');
});
test('comparison cell links include both matching trial ids and omit missing pairs', () => {
  const d = breakdownDetail();
  const html = renderToStaticMarkup(<EvalComparison detail={d} />);
  assert.match(html, /href="\/traces\/compare\?run=current&amp;episode=c1&amp;baseline_run=baseline&amp;baseline_episode=b1"/);
  assert.doesNotMatch(html, /\/traces\/compare\?run=current&amp;episode=c5/);
});
