import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { EvalComparison } from '../../evals/EvalPages';
import { FailureBreakdown } from '../../evals/FailureBreakdown';
import { CELL_LEGEND, causeCounts, causeTooltip, changeTag, ruleSourceHref, trialCategory, trialCellWord } from '../../evals/failureReasons';
import { TrialSummaryCard } from '../components/TrialSummary';
import { buildEpisodeModel } from '../model';
import { episodeVerdict } from '../outcome';
import type { EndClassification, EndCauseCode, EpisodeSummary } from '../types';
import { breakdownDetail, classifiedTrial } from './failureBreakdownFixtures';

function ending(code: EndCauseCode = 'step_limit', limit = 1000): EndClassification {
  return { reason: 'timeout', label: '時間切れ・打ち切り', evidence: { event_id: 'end' },
    cause: { code, label: 'ステップ上限に到達', explanation: `ロボットを ${limit} ステップ動かした時点で打ち切られました。`,
      limit, used: limit, source: 'taskpacks/original/pack.yaml:19', evidence: { 'harness_summary.sim_steps': limit, 'env.max_steps': limit } } };
}

test('trial summary shows a bold numbered cause and plain sentence with technical evidence collapsed', () => {
  const html = renderToStaticMarkup(<TrialSummaryCard ep={{ runId: 'run', episodeId: 'trial' }} model={buildEpisodeModel([])}
    summary={{ episode_id: 'trial', end_classification: ending() }} verdict="failure" />);
  for (const value of ['<strong>ステップ上限に到達（1000/1000 ステップ）</strong>', 'ロボットを 1000 ステップ動かした時点で打ち切られました。',
    'harness_summary.sim_steps = 1000', 'env.max_steps = 1000', 'taskpacks/original/pack.yaml:19']) assert.ok(html.includes(value), value);
  assert.match(html, /href="https:\/\/github.com\/matsuolab\/geniac_prize_2026_code\/blob\/d64344d\/taskpacks\/original\/pack.yaml#L19"/);
  assert.match(html, /event=end/);
  assert.match(html, /<details[^>]*><summary>根拠を見る<\/summary>/);
  assert.doesNotMatch(html, /<details[^>]*\sopen/);
  const visible = html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, '');
  assert.doesNotMatch(visible, /harness_summary|env.max_steps|taskpacks\/|不足している記録/);
  assert.doesNotMatch(html, /不足している記録/);
});

test('an incomplete record explains the missing evidence even without a verdict', () => {
  const classification = ending('recording_incomplete');
  classification.reason = 'unknown';
  classification.cause = { code: 'recording_incomplete', label: '記録が途中で終わった', explanation: '試行の最終結果は記録されていません。',
    missing_evidence: ['runner_record.outcome', 'episode_end'] };
  const html = renderToStaticMarkup(<TrialSummaryCard ep={{ runId: 'run', episodeId: 'trial' }} model={buildEpisodeModel([])}
    summary={{ episode_id: 'trial', end_classification: classification }} verdict="unknown" />);
  assert.match(html, /記録が途中で終わった/);
  assert.match(html, /不足している記録：runner_record.outcome、episode_end/);
  assert.doesNotMatch(html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, ''), /runner_record|episode_end/);
  assert.doesNotMatch(html, /上限：|使用：|規則：/);
});

test('summary trusts the canonical verdict after a scheduler timeout despite stale running metadata', () => {
  const classification = ending('slurm_time_limit', 3600);
  classification.verdict = 'unknown';
  classification.cause!.explanation = '評価ジョブの時間制限で終了しました。';
  const summary: EpisodeSummary = { episode_id: 'trial', status: 'running', end_classification: classification };
  assert.equal(episodeVerdict(summary), 'unknown');
  const html = renderToStaticMarkup(<TrialSummaryCard ep={{ runId: 'run', episodeId: 'trial' }} model={buildEpisodeModel([])}
    summary={summary} verdict={episodeVerdict(summary)} />);
  assert.match(html, /未判定/);
  assert.match(html, /評価ジョブが時間制限で打ち切られた/);
  assert.doesNotMatch(html, /実行中/);
  // Older servers without a canonical verdict preserve the legacy live display.
  assert.equal(episodeVerdict({ ...summary, end_classification: { ...classification, verdict: undefined } }), 'running');
});

test('environment horizon remains distinct from the gateway step limit in summary and cells', () => {
  const classification = ending('env_horizon', 2000);
  classification.cause!.explanation = '環境のステップ期限 2000 に到達（2000/2000 ステップ）';
  classification.cause!.evidence = { 'stop_context.env_horizon': 2000, 'stop_context.horizon_steps_used': 2000 };
  const detail = breakdownDetail(false);
  detail.trials = [classifiedTrial('horizon', 1, 'timeout', { end_classification: classification })];
  const html = renderToStaticMarkup(<EvalComparison detail={detail} />);
  assert.match(html, /<span aria-hidden="true">環境期限<\/span>/);
  assert.match(html, /環境のステップ期限に到達（上限 2000）/);
  assert.doesNotMatch(html, /stop_context.horizon_steps_used/);
});

test('referee reset and job cut have clear cells, tooltips, legend and breakdown causes before opening a trial', () => {
  const examples = [
    { code: 'submission_reset', reason: 'submission_reset', word: '終了', label: '提出物が試行を終えた（未達成）',
      explanation: '提出物が試行をリセットし、審判が成功と判定する前に終了しました。' },
    { code: 'job_cut', reason: 'timeout', word: '打ち切り', label: '評価ジョブの終了で打ち切り',
      explanation: '試行の途中で評価ジョブが終了しました。公式集計では終了した試行に数えません。' },
  ] as const;
  for (const { code, reason, word, label, explanation } of examples) {
    const detail = breakdownDetail(false);
    const classification: EndClassification = { reason, label, evidence: {},
      cause: { code, label, explanation, source: '審判（gateway）', evidence: { 'harness_summary.referee.ended': code === 'job_cut' ? 'cut' : 'reset' } } };
    detail.trials = [classifiedTrial('referee', 1, reason, { local_state: 'remote', end_classification: classification })];
    assert.equal(trialCellWord(detail.trials[0]), word);
    const html = renderToStaticMarkup(<EvalComparison detail={detail} />);
    assert.ok(html.includes(`<span aria-hidden="true">${word}</span>`));
    assert.ok(html.includes(`title="${label}\n${explanation}\n試行を開く"`));
    assert.ok(html.includes(`${word}＝${CELL_LEGEND[word]}`));
    const breakdown = renderToStaticMarkup(<FailureBreakdown detail={detail} />);
    assert.ok(breakdown.includes(`<summary><span>${label}</span>`));
    assert.ok(breakdown.includes(explanation));
    assert.ok(breakdown.includes('失敗 1件・未判定 0件'));
    assert.match(breakdown, /終わり方が不明：今回 0件/);
  }
});

test('breakdown compares causes and limits within the existing coarse categories', () => {
  const detail = breakdownDetail();
  const timeout = { ...ending('trial_time_limit', 300), cause: { ...ending('trial_time_limit', 300).cause!, label: '1試行の時間制限を超過', explanation: '1試行の時間制限 300 秒を超過' } };
  detail.trials = [classifiedTrial('step', 1, 'timeout', { end_classification: ending() }),
    classifiedTrial('wall', 2, 'timeout', { end_classification: timeout })];
  detail.baseline_trials = [classifiedTrial('old-step', 1, 'timeout', { end_classification: ending() }),
    classifiedTrial('other-limit', 2, 'timeout', { end_classification: ending('step_limit', 1500) })];
  const counts = causeCounts(detail.trials, detail.baseline_trials, 'timeout');
  assert.deepEqual(counts.map(row => [row.key, row.baseline, row.current]), [
    ['step_limit:1000', 1, 1], ['step_limit:1500', 1, 0], ['trial_time_limit:300', 0, 1],
  ]);
  const html = renderToStaticMarkup(<FailureBreakdown detail={detail} />);
  assert.match(html, /aria-label="時間切れ・打ち切りの原因別比較"/);
  for (const label of ['ステップ上限に到達（上限 1000）', 'ステップ上限に到達（上限 1500）', '1試行の時間制限（300 秒）を超過']) assert.ok(html.includes(label), label);
  assert.match(html, /<th scope="col">基準<\/th><th scope="col">今回<\/th>/);
  assert.equal(changeTag(detail.baseline_trials[1], detail.trials[1]), '別の失敗へ');
});

test('cells show known causes while preserving unjudged verdicts in categories and tooltips', () => {
  const detail = breakdownDetail(false);
  detail.trials = [classifiedTrial('step', 1, 'timeout', { end_classification: ending() }),
    classifiedTrial('unjudged', 2, 'timeout', { verdict: 'unknown', end_classification: ending('slurm_time_limit', 3600) })];
  const html = renderToStaticMarkup(<EvalComparison detail={detail} />).split('<section class="failure-breakdown"')[0];
  assert.match(html, /<span aria-hidden="true">ステップ上限<\/span>/);
  assert.doesNotMatch(html, /harness_summary.sim_steps/);
  assert.match(html, /<span aria-hidden="true">ジョブ時間<\/span>/);
  assert.match(html, /未判定（成否が記録から分からない）・評価ジョブが時間制限で打ち切られた/);
  assert.equal(trialCategory(detail.trials[1]), 'unjudged');
});

test('a recorded regeneration count is never displayed as an unrecorded limit', () => {
  const detail = breakdownDetail(false);
  const classification: EndClassification = { reason: 'regen_limit', label: '書き直しの上限', evidence: {},
    cause: { code: 'regeneration_limit', label: '書き直しの上限に到達', explanation: '書き直し後に終了しましたが、上限値は記録されていません。',
      limit: null, used: 5, missing_evidence: ['regeneration_limit'] } };
  detail.trials = [classifiedTrial('regenerations', 1, 'regen_limit', { end_classification: classification })];
  const html = renderToStaticMarkup(<FailureBreakdown detail={detail} />);
  assert.match(html, /書き直し 5 回で終了（上限の設定は記録なし）/);
  assert.doesNotMatch(html, /不足している記録：regeneration_limit/);
  assert.doesNotMatch(html, /上限 5/);
});

test('parser fallback is displayed as an interpretation rather than a model FINISH claim', () => {
  const classification: EndClassification = { reason: 'unknown', label: '終わり方が不明', evidence: {},
    cause: { code: 'parser_finish', label: '終了と解釈されたが未達成', explanation: 'REGENERATE がなかったため終了として扱われました。',
      evidence: { 'model_output_parsed.model_said_finish': false, 'model_output_parsed.harness_reading': 'no REGENERATE -> finish' } } };
  const detail = breakdownDetail(false);
  detail.trials = [classifiedTrial('fallback', 1, 'unknown', { verdict: 'failure', end_classification: classification })];
  const html = renderToStaticMarkup(<EvalComparison detail={detail} />);
  assert.match(html, /<span aria-hidden="true">終了扱い<\/span>/);
  assert.match(html, /終了と解釈されたが未達成/);
  assert.doesNotMatch(html, /model_output_parsed.model_said_finish/);
  const summary = renderToStaticMarkup(<TrialSummaryCard ep={{ runId: 'run', episodeId: 'trial' }} model={buildEpisodeModel([])}
    summary={{ episode_id: 'trial', end_classification: classification }} verdict="failure" />);
  assert.match(summary, /REGENERATE がなかったため終了として扱われました。/);
  assert.doesNotMatch(summary, /「終わった」と答えたが未達成/);
});

test('evaluation notes list only server-reported official rule differences and deduplicate task limits', () => {
  const detail = breakdownDetail(false);
  const classification = ending('step_limit', 500);
  classification.rule_differences = [
    { field: 'step_limit', recorded: 500, official: 1000, source: 'taskpacks/original/pack.yaml:19', explanation: 'ローカルのステップ上限は 500、公式は 1000 です。' },
    { field: 'trial_time_limit_s', recorded: 300, official: null, source: 'capx/envs/runner.py:14', explanation: 'ローカルは1試行 300 秒で打ち切りますが、公式には1試行ごとの時間制限がありません。' },
  ];
  detail.trials = [classifiedTrial('one', 1, 'timeout', { end_classification: classification }),
    classifiedTrial('two', 2, 'timeout', { end_classification: classification })];
  const html = renderToStaticMarkup(<EvalComparison detail={detail} />);
  assert.match(html, /公式の評価と条件が違います：/);
  assert.equal((html.match(/ローカルのステップ上限は 500、公式は 1000 です。/g) ?? []).length, 1);
  assert.match(html, /ローカルは1試行 300 秒で打ち切りますが、公式には1試行ごとの時間制限がありません。/);
  detail.trials = [classifiedTrial('old', 1, 'timeout')];
  assert.doesNotMatch(renderToStaticMarkup(<EvalComparison detail={detail} />), /公式の評価と条件が違います/);
  assert.equal(ruleSourceHref('/tmp/private/settings.py:1'), undefined);
  const publicUrl = 'https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/taskpacks/original/pack.yaml#L90';
  assert.equal(ruleSourceHref(publicUrl), publicUrl);
  assert.equal(ruleSourceHref('capx/utils/launch_utils.py:_parse_multi_turn_decision'),
    'https://github.com/matsuolab/geniac_prize_2026_code/blob/d64344d/capx/utils/launch_utils.py');
});

test('tooltips contain just the cause line and plain sentence with no duplicates or technical fields', () => {
  const classification = ending();
  classification.cause!.missing_evidence = ['stop_context.step_limit'];
  const tooltip = causeTooltip(classification);
  assert.deepEqual(tooltip.split('\n'), [
    'ステップ上限に到達（1000/1000 ステップ）',
    'ロボットを 1000 ステップ動かした時点で打ち切られました。',
  ]);
  assert.doesNotMatch(tooltip, /harness_summary|env.max_steps|stop_context|taskpacks/);
});

test('summary preserves a server sentence comparing an unrecorded local limit with the official task limit', () => {
  const classification = ending();
  classification.cause!.headline = 'ステップ上限に到達（1000 ステップ、上限は記録なし）';
  classification.cause!.limit = null;
  classification.cause!.explanation = 'ロボットを 1000 ステップ動かした時点で打ち切られました。この記録には実際の上限値が残っていません（公式の上限は 1000）。';
  classification.cause!.missing_evidence = ['stop_context.step_limit'];
  const html = renderToStaticMarkup(<TrialSummaryCard ep={{ runId: 'run', episodeId: 'trial' }} model={buildEpisodeModel([])}
    summary={{ episode_id: 'trial', end_classification: classification }} verdict="failure" />);
  const visible = html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, '');
  assert.match(visible, /この記録には実際の上限値が残っていません（公式の上限は 1000）/);
  assert.doesNotMatch(visible, /1000\/1000|stop_context/);
});
