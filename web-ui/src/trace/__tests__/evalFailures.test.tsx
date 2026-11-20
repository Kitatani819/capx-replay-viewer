import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { EvalComparison, EvalListTable } from '../../evals/EvalPages';
import type { EvaluationFailure } from '../../evals/api';
import { breakdownDetail } from './failureBreakdownFixtures';

const infrastructure: EvaluationFailure = {
  kind: 'infrastructure', reason: 'task setup or worker failed', count: 1,
  infrastructure_failures: [{ task: 'cube', seed: 441, reason: 'simulator setup failed' }],
};

test('failed evaluation list shows a status word and the task, seed and reason in its tooltip', () => {
  const detail = breakdownDetail(false);
  detail.eval!.status = 'interrupted';
  detail.display_status = 'failed';
  detail.evaluation_failure = infrastructure;
  const html = renderToStaticMarkup(<EvalListTable entries={[detail]} />);
  assert.match(html, /title="task setup or worker failed\ncube・seed 441・simulator setup failed" class="eval-error">評価失敗<\/span>/);
  assert.doesNotMatch(html, />中断</);
});

test('comparison explains evaluation setup or worker failure before the trial table', () => {
  const detail = breakdownDetail(false);
  detail.eval!.status = 'interrupted';
  detail.display_status = 'failed';
  detail.evaluation_failure = infrastructure;
  const html = renderToStaticMarkup(<EvalComparison detail={detail} />);
  const line = 'この評価は準備・実行の失敗で止まりました：cube・seed 441・simulator setup failed';
  assert.ok(html.includes(`<p role="note" class="eval-note eval-failure-note">${line}</p>`));
  assert.ok(html.indexOf(line) < html.indexOf('タスク・seed ごとの結果'));
});

test('evaluation-level errors without a task retain their reason and escape stored text', () => {
  const detail = breakdownDetail(false);
  detail.evaluation_failure = { kind: 'infrastructure', reason: 'worker exited <unexpectedly> & stopped', infrastructure_failures: [], count: 0 };
  detail.display_status = 'failed';
  const html = renderToStaticMarkup(<EvalComparison detail={detail} />);
  assert.match(html, /この評価は準備・実行の失敗で止まりました：worker exited &lt;unexpectedly&gt; &amp; stopped/);
  assert.doesNotMatch(html, /<unexpectedly>/);

  detail.evaluation_failure = { ...infrastructure, infrastructure_failures: [{ task: null, seed: null, reason: 'configuration missing' }] };
  assert.match(renderToStaticMarkup(<EvalComparison detail={detail} />), /課題未記録・seed 未記録・configuration missing/);
});

test('incomplete evaluations use a distinct status and a plain explanation', () => {
  const detail = breakdownDetail(false);
  detail.display_status = 'incomplete';
  detail.evaluation_failure = { kind: 'incomplete', reason: '2 planned trials are incomplete', infrastructure_failures: [], count: 0 };
  const listing = renderToStaticMarkup(<EvalListTable entries={[detail]} />);
  assert.match(listing, /title="2 planned trials are incomplete" class="eval-error">未完了<\/span>/);
  const html = renderToStaticMarkup(<EvalComparison detail={detail} />);
  assert.match(html, /この評価は一部の試行を終えずに止まりました：2 planned trials are incomplete/);
  assert.doesNotMatch(html, /準備・実行の失敗/);
});

test('baseline failure is explained separately and truncated diagnostic counts remain visible', () => {
  const detail = breakdownDetail(true);
  detail.baseline_evaluation_failure = { ...infrastructure, count: 3 };
  const html = renderToStaticMarkup(<EvalComparison detail={detail} />);
  assert.match(html, /基準の評価は準備・実行の失敗で止まりました：cube・seed 441・simulator setup failed \/ ほか 2件/);
  assert.doesNotMatch(html, /この評価は準備/);
});

test('older records keep their existing status and task failures do not create an evaluation banner', () => {
  const detail = breakdownDetail(false);
  for (const status of [null, 'interrupted', 'incomplete'] as const) {
    detail.display_status = status;
    const listing = renderToStaticMarkup(<EvalListTable entries={[detail]} />);
    if (status === 'interrupted') assert.match(listing, />中断<\/span>/);
    if (status === 'incomplete') assert.match(listing, />欠損あり<\/span>/);
    const html = renderToStaticMarkup(<EvalComparison detail={detail} />);
    assert.doesNotMatch(html, /eval-failure-note|この評価は準備|この評価は一部/);
  }
});
