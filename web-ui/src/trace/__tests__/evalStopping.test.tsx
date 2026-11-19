import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { EvalComparison } from '../../evals/EvalPages';
import { FailureBreakdown } from '../../evals/FailureBreakdown';
import { CELL_LEGEND, causeCounts, trialCellWord } from '../../evals/failureReasons';
import type { EndClassification, EndCauseCode, EndReason, RuleDifference } from '../types';
import { breakdownDetail, classifiedTrial } from './failureBreakdownFixtures';

const source = 'https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/taskpacks/original/pack.yaml#L90';
function classification(reason: EndReason, code: EndCauseCode, headline: string, explanation: string): EndClassification {
  return { reason, label: headline, evidence: {}, cause: { code, label: headline, headline, explanation,
    limit: code === 'trial_time_limit' ? 2400 : null, used: code === 'unknown' && reason === 'regen_limit' ? 10 : null,
    evidence: { 'harness_summary.truncated': true }, missing_evidence: ['stop_context.step_limit'] } };
}

test('each failure group and unjudged group has causes with an expandable trial list', () => {
  const groups: [EndReason, EndCauseCode, string, string, boolean][] = [
    ['timeout', 'trial_time_limit', '1試行の時間制限（2400 秒）を超過', '1試行に使える 2400 秒を超えたため終了しました。', true],
    ['finish_unmet', 'finish_unmet', '「終わった」と答えたが未達成', 'ロボットは課題を達成していません。', false],
    ['regen_limit', 'unknown', '書き直し 10 回で終了（上限の設定は記録なし）', 'コードを書き直して試行を終えました。', false],
    ['error', 'execution_error', 'エラーで停止', '処理を続けられず終了しました。', false],
    ['unknown', 'unknown', '終了原因を特定できない', '終了した理由を確かめられません。', false],
  ];
  for (const [reason, code, headline, explanation, unjudged] of groups) {
    const detail = breakdownDetail(false);
    detail.trials = Array.from({ length: unjudged ? 6 : 1 }, (_, index) => classifiedTrial(`trial-${index}`, index, reason, {
      verdict: unjudged ? 'unknown' : 'failure', end_classification: classification(reason, code, headline, explanation),
    }));
    const category = unjudged ? 'unjudged' : reason === 'success' ? 'unknown' : reason;
    const causes = causeCounts(detail.trials, [], category);
    assert.equal(causes.length, 1);
    assert.equal(causes[0].current, unjudged ? 6 : 1);
    const html = renderToStaticMarkup(<FailureBreakdown detail={detail} />);
    assert.match(html, /<details class="failure-cause-trials"><summary>/);
    assert.ok(html.includes(headline), headline);
    assert.equal((html.match(/>試行を開く<\/a>/g) ?? []).length, unjudged ? 6 : 1);
    assert.doesNotMatch(html, /harness_summary|stop_context/);
    if (reason === 'regen_limit') assert.doesNotMatch(html, /終了原因を特定できない/);
    assert.match(html, /分類は記録から自動で推測したもので、外れることがあります。/);
  }
});

test('cell tooltip contains one cause line, one plain explanation and the trial action', () => {
  const detail = breakdownDetail(false);
  const headline = 'ステップ上限に到達（1000/1000 ステップ）';
  const explanation = 'ロボットを 1000 ステップ動かした時点で打ち切られました。';
  detail.trials = [classifiedTrial('step', 1, 'timeout', { end_classification: classification('timeout', 'step_limit', headline, explanation) })];
  const html = renderToStaticMarkup(<EvalComparison detail={detail} />);
  const tooltip = /class="eval-result [^"]*" title="([^"]*)"/.exec(html)?.[1];
  assert.equal(tooltip, `${headline}\n${explanation}\n試行を開く`);
  assert.doesNotMatch(tooltip!, /harness_summary|stop_context|根拠|規則/);
});

test('word legend explains exactly the canonical cell vocabulary', () => {
  const detail = breakdownDetail(false);
  const cause = classification('timeout', 'step_limit', 'ステップ上限に到達', 'ステップの上限で終了しました。');
  detail.trials = [classifiedTrial('step', 1, 'timeout', { end_classification: cause })];
  const html = renderToStaticMarkup(<EvalComparison detail={detail} />);
  const expected = Object.entries(CELL_LEGEND).map(([word, explanation]) => word === explanation ? word : `${word}＝${explanation}`).join('　');
  assert.ok(html.includes(`<p class="eval-legend">${expected}　空欄＝記録なし</p>`));
  assert.equal(CELL_LEGEND[trialCellWord(detail.trials[0])], 'ロボットを動かすステップ数の上限に到達');
});

test('official differences use compact sentences and put the fourth difference behind disclosure', () => {
  const detail = breakdownDetail(false);
  const ending = classification('timeout', 'step_limit', 'ステップ上限に到達', '終了しました。');
  const notes: RuleDifference[] = [
    { field: 'trial_time_limit_s', recorded: 2400, official: null, source, explanation: '1試行を 2400 秒で打ち切りますが、公式には1試行ごとの時間制限はありません。' },
    { field: 'success_timing', recorded: null, official: null, source, explanation: '公式では動作の途中で成功しても数えますが、今回はコードの実行が終わった時だけ確認します。' },
    { field: 'trial_attempt_limit', recorded: 3, official: null, source, explanation: '時間切れの試行を最大3回までやり直しますが、公式にはこのやり直しはありません。' },
    { field: 'step_limit', recorded: 4000, official: 8000, source, explanation: 'libero_10_0 のステップ上限は 4000 で、公式の上限は 8000 です。' },
  ];
  ending.rule_differences = notes;
  detail.trials = [classifiedTrial('one', 1, 'timeout', { end_classification: ending }), classifiedTrial('two', 2, 'timeout', { end_classification: ending })];
  const html = renderToStaticMarkup(<EvalComparison detail={detail} />);
  const note = /<div role="note" class="eval-note eval-rule-note">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
  assert.ok(note);
  assert.equal((note.match(/<li>/g) ?? []).length, 4);
  assert.equal((note.split('<details>')[0].match(/<li>/g) ?? []).length, 3);
  assert.match(note, /<details><summary>ほかの違い<\/summary>/);
  assert.equal((note.match(/>公開ルール<\/a>/g) ?? []).length, 4);
  for (const entry of notes) assert.ok(note.includes(entry.explanation!), entry.field);
  assert.doesNotMatch(note, /trial_time_limit_s|success_timing|trial_attempt_limit|step_limit/);
  ending.rule_differences = [];
  assert.doesNotMatch(renderToStaticMarkup(<EvalComparison detail={detail} />), /公式の評価と条件が違います/);
});
