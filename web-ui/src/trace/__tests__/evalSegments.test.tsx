import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { comparisonTable } from '../../evals/model';
import { EvalSegments } from '../../evals/EvalSegments';
import { EvalComparison, EvalListTable } from '../../evals/EvalPages';
import type { EvalDetail, EvalRecord } from '../../evals/api';

const record: EvalRecord = { schema: 'capx-eval/1', eval_id: 'ev-resume', status: 'completed', by: '合成テスト', changed: '分割',
  baseline_eval_id: null, eval_set: 'synthetic', git: null, started_at: '2026-11-20T01:00:00Z', heartbeat_at: '2026-11-20T02:01:00Z', ended_at: '2026-11-20T02:01:00Z', summary: null,
  segments: [{ index: 1, status: 'interrupted', started_at: '2026-11-20T01:00:00Z', ended_at: null, end: null, stop_verified: true, completed_before: 0, completed_after: 1,
    budget: { limit_s: 600, used_before_s: 0, used_s: 100 } },
  { index: 2, status: 'completed', started_at: '2026-11-20T02:00:00Z', ended_at: '2026-11-20T02:01:00Z', end: { exit_code: 0, signal: null }, completed_before: 1, completed_after: 2,
    budget: { limit_s: 600, used_before_s: 100, used_s: 60 } }] };

test('segments explain logical counts, cumulative budget and unknown stop evidence', () => {
  const html = renderToStaticMarkup(<EvalSegments record={record} />);
  for (const text of ['2回に分けて実行した評価', '各組の最後の試行', '累積 160.0秒 / 600.0秒', '終了日時不明', '終了時刻や終了信号は記録されていません', '公式は1つの連続したジョブ']) assert.ok(html.includes(text), text);
  assert.equal(renderToStaticMarkup(<EvalSegments record={{ ...record, segments: [] }} />), '');
});
test('evaluation list identifies split records and resumed summaries match latest displayed attempts', () => {
  const trial = { episode_id: 'new', task: 'cube', condition: null, seed: 1, attempt: 1, start_wall_time: 20,
    verdict: 'success', status: 'ended', trace_complete: true, local_state: 'local' } as const;
  const detail = { eval_id: record.eval_id, eval: record, baseline: null, baseline_trials: [], baseline_error: null,
    summary: { trials: 1, success: 1, failure: 0, unknown: 0, incomplete: 0, tasks: ['cube'], seeds: [1], models: {}, config_flags: {}, mixed: [] }, baseline_summary: null, error: null, location: 'local', display_status: null,
    trials: [{ ...trial, episode_id: 'old', verdict: 'failure', start_wall_time: 10 }, trial], differences: [] } as EvalDetail;
  assert.match(renderToStaticMarkup(<EvalListTable entries={[detail]} />), /2回に分けて実行/);
  const html = renderToStaticMarkup(<EvalComparison detail={detail} />);
  assert.match(html, /分割した評価の履歴/);
  assert.doesNotMatch(html, /集計と試行の表の数が異なります/);
});

test('a newer segment wins even when the wall clock moved backwards', () => {
  const common = { task: 'cube', condition: null, seed: 1, verdict: 'failure', status: 'ended', trace_complete: true, local_state: 'local', attempt: 1 } as const;
  const old = { ...common, episode_id: 'old', eval_segment: 1, start_wall_time: 1000 };
  const now = { ...common, episode_id: 'new', eval_segment: 2, start_wall_time: 900, verdict: 'success' as const };
  assert.equal(comparisonTable([now, old], []).currentTrials[0].episode_id, 'new');
});
