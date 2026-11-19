import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { EvalComparison, EvalListTable } from '../../evals/EvalPages';
import { comparisonTable, delta, summaryDiffers } from '../../evals/model';
import { CELL_LEGEND } from '../../evals/failureReasons';
import type { EvalDetail, EvalRecord, EvalSummary, EvalTrial } from '../../evals/api';

const wordLegend = `${Object.entries(CELL_LEGEND).map(([word, explanation]) => word === explanation ? word : `${word}＝${explanation}`).join('　')}　空欄＝記録なし`;

const summary: EvalSummary = { trials: 2, success: 1, failure: 1, unknown: 0, incomplete: 0, tasks: ['cube'], seeds: [401, 402], models: {}, config_flags: {}, mixed: [] };
function record(id: string, baseline: string | null = null): EvalRecord {
  return { schema: 'capx-eval/1', eval_id: id, status: 'completed', by: 'alice', changed: baseline ? '把持位置の修正' : '', baseline_eval_id: baseline, eval_set: 'demo',
    git: { commit: 'a1b2c3d4', dirty: true }, started_at: '2026-11-18T09:30:00Z', heartbeat_at: '2026-11-18T09:31:00Z', ended_at: '2026-11-18T09:31:00Z', summary };
}
function trial(id: string, seed: number | null, verdict: EvalTrial['verdict'], extra: Partial<EvalTrial> = {}): EvalTrial {
  return { episode_id: id, task: 'cube', condition: 'C', seed, attempt: 1, verdict, status: 'ended', trace_complete: true, local_state: 'local', ...extra };
}
function detail(): EvalDetail {
  return { eval_id: 'improved', eval: record('improved', 'baseline'), baseline: record('baseline'), error: null, location: 'both', display_status: null,
    summary, baseline_summary: summary, baseline_error: null,
    baseline_trials: [trial('b1', 401, 'success'), trial('b2', 402, 'failure')],
    trials: [trial('c1', 401, 'success'), trial('c1-retry', 401, 'failure', { attempt: 2 }), trial('c3', 403, 'unknown')],
    differences: [{ field: 'seeds', baseline: [401, 402], current: [401, 403] }] };
}
test('comparison uses last retry and union seeds, retaining missing cells', () => {
  const d = detail();
  const table = comparisonTable(d.trials, d.baseline_trials);
  assert.deepEqual(table.seeds, [401, 402, 403]);
  assert.equal(table.rows.length, 1);
  assert.equal(table.showConditions, false);
  assert.equal(table.rows[0].current.get(401)?.trial.episode_id, 'c1-retry');
  assert.equal(table.rows[0].current.get(401)?.retried, true);
  assert.equal(table.rows[0].current.has(402), false);
  assert.equal(table.regressions, 1);
  const reversed = comparisonTable([...d.trials].reverse(), d.baseline_trials);
  assert.equal(reversed.rows[0].current.get(401)?.trial.episode_id, 'c1-retry');
});
test('multiple conditions get separate task/condition rows', () => {
  const table = comparisonTable([trial('a', 1, 'failure', { condition: 'A' }), trial('b', 1, 'success', { condition: 'B' })], []);
  assert.equal(table.showConditions, true);
  assert.deepEqual(table.rows.map(row => row.condition), ['A', 'B']);
  assert.equal(table.regressions, 0);
});
test('a later invocation can reset attempt numbers and still supplies the displayed cell', () => {
  const attempts = [trial('old', 1, 'success', { attempt: 3, runner_invocation: 1, start_wall_time: 100 }),
    trial('new', 1, 'failure', { attempt: 1, runner_invocation: 2, start_wall_time: 200 })];
  for (const ordered of [attempts, [...attempts].reverse()]) {
    const cell = comparisonTable(ordered, []).rows[0].current.get(1)!;
    assert.equal(cell.trial.episode_id, 'new');
    assert.equal(cell.retried, true);
  }
});
test('comparison renders regression text and border, retry, blanks, condition differences and trace links', () => {
  const html = renderToStaticMarkup(<EvalComparison detail={detail()} />);
  assert.match(html, /悪化 1件/);
  assert.match(html, /class="eval-result eval-result-failure eval-regression"/);
  assert.match(html, /悪化（基準は成功）/);
  assert.match(html, /再試行あり/);
  assert.match(html, /aria-label="記録なし"/);
  assert.match(html, /seed（基準 401、402 \/ 今回 401、403）/);
  assert.match(html, /href="\/traces\?run=improved&amp;episode=c1-retry"/);
  assert.match(html, /title="試行を開く" aria-label="失敗（終わり方が不明）・悪化（基準は成功）・再試行あり（試行を開く）"/);
  assert.match(html, /集計と試行の表の数が異なります/);
});
test('condition differences show only changed config flags and preserve the API data', () => {
  const d = detail();
  d.differences = [{ field: 'config_flags',
    baseline: { multi_turn: true, use_parallel_ensemble: false, nested: { count: 2, options: ['a', 'b'] }, removed: 'old' },
    current: { multi_turn: true, use_parallel_ensemble: true, nested: { options: ['a', 'b'], count: 2 }, added: 'new' } }];
  const original = JSON.stringify(d.differences);
  const html = renderToStaticMarkup(<EvalComparison detail={d} />);
  assert.match(html, /use_parallel_ensemble（基準 false \/ 今回 true）/);
  assert.match(html, /added（基準 未記録 \/ 今回 new）/);
  assert.match(html, /removed（基準 old \/ 今回 未記録）/);
  assert.doesNotMatch(html, /multi_turn|nested|設定（/);
  assert.equal(JSON.stringify(d.differences), original);
});
test('condition differences show only changed model names including an initially missing model map', () => {
  const d = detail();
  d.differences = [{ field: 'models', baseline: { code_generator: 'old-model', planner: 'shared-model' }, current: { code_generator: 'new-model', planner: 'shared-model' } }];
  const html = renderToStaticMarkup(<EvalComparison detail={d} />);
  assert.match(html, /code_generator（基準 old-model \/ 今回 new-model）/);
  assert.doesNotMatch(html, /planner|shared-model|モデル（/);
  d.differences = [{ field: 'models', baseline: null, current: { code_generator: 'new-model' } }];
  assert.match(renderToStaticMarkup(<EvalComparison detail={d} />), /code_generator（基準 未記録 \/ 今回 new-model）/);
});
test('baseline evaluations show only current row and every verdict reads as a word with a label', () => {
  const d = detail(); d.eval = record('baseline'); d.baseline = null; d.baseline_trials = []; d.differences = []; d.baseline_error = null;
  d.trials = ['success', 'failure', 'unknown', 'running'].map((v, i) => trial(`e${i}`, i, v as EvalTrial['verdict']));
  d.trials[1] = { ...d.trials[1], end_classification: { reason: 'finish_unmet', label: 'FINISHだが未達成', evidence: {} } } as EvalTrial;
  const html = renderToStaticMarkup(<EvalComparison detail={d} />);
  assert.doesNotMatch(html, /scope="row">基準/);
  assert.match(html, /評価（基準）/);
  for (const label of ['成功', '失敗（「終わった」と答えたが未達成）', '未判定（成否が記録から分からない）', '実行中']) assert.ok(html.includes(`title="試行を開く" aria-label="${label}（試行を開く）"`), label);
  // Failures show how they ended, not one shared symbol.
  for (const word of ['成功', '未達成', '未判定', '実行中']) assert.match(html, new RegExp(`<span aria-hidden="true">${word}</span>`));
  assert.ok(html.includes(`<p class="eval-legend">${wordLegend}</p>`));
  assert.doesNotMatch(html, /FINISHだが未達成/);
  assert.doesNotMatch(html, /class="eval-compare-link"/);
});
test('more seeds than fit as words fall back to symbols with their legend', () => {
  const d = detail(); d.eval = record('baseline'); d.baseline = null; d.baseline_trials = []; d.differences = []; d.baseline_error = null;
  d.trials = Array.from({ length: 21 }, (_, i) => trial(`e${i}`, i, i % 2 ? 'failure' : 'success'));
  const html = renderToStaticMarkup(<EvalComparison detail={d} />);
  assert.match(html, /<span aria-hidden="true">○<\/span>/);
  assert.match(html, /<span aria-hidden="true">×<\/span>/);
  assert.match(html, /seed が多いため記号で表示しています/);
  for (const words of ['○ 成功', '× 失敗', '– 未判定', '… 実行中', '未判定＝成否が記録から分からない', '空欄＝記録なし']) assert.ok(html.includes(words), words);
});
test('every ending uses the canonical cell word and long accessible label', () => {
  const d = detail(); d.baseline = null; d.baseline_trials = []; d.differences = []; d.baseline_error = null;
  const endings = [
    ['error', 'エラー', 'エラーで停止'],
    ['timeout', '時間切れ', '時間切れ・打ち切り'],
    ['finish_unmet', '未達成', '「終わった」と答えたが未達成'],
    ['regen_limit', '上限', '書き直しの上限'],
    ['unknown', '不明', '終わり方が不明'],
  ] as const;
  d.trials = endings.map(([reason], seed) => trial(reason, seed, 'failure', {
    end_classification: { reason, label: '古い表示名', evidence: {} },
  }));
  const html = renderToStaticMarkup(<EvalComparison detail={d} />);
  for (const [, word, label] of endings) {
    assert.ok(html.includes(`<span aria-hidden="true">${word}</span>`), word);
    assert.ok(html.includes(`aria-label="失敗（${label}）（試行を開く）"`), label);
  }
  assert.doesNotMatch(html, /古い表示名/);
});
test('paired current cells offer a separate small compare button beside the trial button', () => {
  const html = renderToStaticMarkup(<EvalComparison detail={detail()} />);
  assert.equal((html.match(/class="eval-compare-link"/g) || []).length, 1);
  assert.match(html, /<div class="eval-cell-actions"><a[^>]+episode=c1-retry[^>]+>[\s\S]*?<\/a><a class="eval-compare-link" href="\/traces\/compare\?run=improved&amp;episode=c1-retry&amp;baseline_run=baseline&amp;baseline_episode=b1" aria-label="cube seed 401を基準と並べて見る">並べて見る<\/a><\/div>/);
});
test('list preserves invalid records as errors and completed evaluations have no state label', () => {
  const d = detail();
  const html = renderToStaticMarkup(<EvalListTable entries={[d, { ...d, eval_id: 'broken', eval: null, error: 'schema が不正です' }]} />);
  assert.match(html, /把持位置の修正/);
  assert.match(html, /a1b2c3d＋未コミット/);
  assert.match(html, /読み取れない評価：broken/);
  assert.match(html, /schema が不正です/);
  assert.doesNotMatch(html, /完了/);
});
test('list and comparison show short commits and distinguish unknown uncommitted changes', () => {
  for (const dirty of [true, false, null]) {
    const d = detail();
    d.eval!.git = { commit: 'a1b2c3d4', dirty, diff_sha256: dirty ? 'a'.repeat(64) : null };
    for (const html of [renderToStaticMarkup(<EvalListTable entries={[d]} />), renderToStaticMarkup(<EvalComparison detail={d} />)]) {
      assert.match(html, /a1b2c3d/);
      assert.doesNotMatch(html, /a1b2c3d4/);
      assert.equal(html.includes('＋未コミット'), dirty === true);
      assert.equal(html.includes('title="未コミットの変更の有無は不明"'), dirty === null);
    }
  }
});
test('remote connection warning and running baseline computed summary remain visible', () => {
  const d = detail();
  d.baseline = { ...d.baseline!, status: 'running', summary: null };
  d.remote_error = 'GMOの一覧を取得できません。手元の記録を表示しています。';
  d.trials = [trial('now1', 401, 'success'), trial('now2', 402, 'failure')];
  d.baseline_trials = [trial('old1', 401, 'failure'), trial('old2', 402, 'failure')];
  const html = renderToStaticMarkup(<EvalComparison detail={d} />);
  assert.match(html, /基準 1\/2 → 今回 1\/2/);
  assert.match(html, /GMOの一覧を取得できません/);
  assert.match(html, /集計と試行の表の数が異なります/);
});
test('rates compare percentage points and no empty denominator is divided', () => {
  assert.equal(delta({ success: 14, trials: 20 }, { success: 13, trials: 20 }), '（+5pt）');
  assert.equal(delta({ success: 0, trials: 0 }, summary), '');
  assert.equal(summaryDiffers({ success: 1, trials: 1 }, [trial('x', 1, 'success')]), false);
});
