import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { TrialSummaryCard } from '../components/TrialSummary';
import { buildEpisodeModel, resolveSelection } from '../model';
import { baselineForEpisode, lastRecordedFrame, trialSummaryFacts } from '../trialSummary';
import type { EvalDetail, EvalTrial } from '../../evals/api';
import type { EndReason, EpisodeSummary } from '../types';
import { Rec } from './fixtures';

const ep = { runId: 'current', episodeId: 'trial', generation: 'g2' };
function trial(extra: Partial<EvalTrial> = {}): EvalTrial {
  return { episode_id: 'base', task: 'cube_lift', condition: 'C', seed: 7, attempt: 0, verdict: 'success', status: 'ended', trace_complete: true, local_state: 'local', ...extra };
}
function fixture() {
  const r = new Rec();
  r.episodeStart({ seed: 7 });
  const initial = r.request('code_generator', 'initial', 1, { call_kind: 'initial_code' });
  const initialResponse = r.response(initial);
  const block = r.blockStart(initialResponse, 'move()', { turn_index: 0 });
  const api = r.apiStart(block, 'move_to_pose');
  const error = r.apiError(api, 'RuntimeError', 'IK did not converge\ntraceback line');
  r.blockEnd(block, 0, 0);
  const observationRequest = r.request('vdm', 'observation', 1, { turn_index: 1 });
  const observation = r.response(observationRequest, 200, 'キューブは机の上に残っている。');
  const decisionRequest = r.request('code_generator', 'decision', 1, { turn_index: 1 });
  const answer = r.response(decisionRequest, 200, 'FINISH — finished\nsecond line');
  const decision = r.parsed(answer, { parser: '_parse_multi_turn_decision', decision: 'finish', model_said_finish: true });
  const frame = r.add('frame', { camera: 'agentview', buffer_index: 3 }, { artifacts: [{ path: 'frames/last.png', mime: 'image/png', written: true }] });
  const end = r.episodeEnd({ duration_s: 65, harness_summary: { task_completed: false, num_regenerations: 0 } });
  const summary: EpisodeSummary = { episode_id: ep.episodeId, status: 'ended', task: 'cube_lift', condition: 'C', seed: 7,
    end_reason: 'completed', episode: { harness_summary: { task_completed: false } },
    end_classification: { reason: 'finish_unmet', label: '終了（未達成）', evidence: { event_id: decision.event_id } } };
  return { r, error, observation, decision, frame, end, summary, model: buildEpisodeModel(r.events) };
}

test('summary renders available facts, baseline regression and exact event/file links', () => {
  const f = fixture();
  const baselineFrame = { event: { ...f.frame, event_id: 'base_frame' }, path: 'frames/base.png' };
  const html = renderToStaticMarkup(<TrialSummaryCard ep={ep} model={f.model} summary={f.summary} verdict="failure"
    baseline={{ ep: { runId: 'baseline', episodeId: 'base', generation: 'bg' }, trial: trial(), frame: baselineFrame }} />);
  for (const text of ['cube_lift', 'seed 7', '失敗', '悪化（基準では成功）', '「終わった」と答えたが未達成', '2（書き直し 0回）', '1 分 5 秒',
    'ターン0：エラー', 'ターン1：「終わった」と答えたが未達成', '最初のエラー', 'move_to_pose', 'IK did not converge', '最後の観察', 'キューブは机の上', '最後の判断', 'FINISH', '最後の画像', '基準と並べて見る']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /traceback line|second line|終了（未達成）/);
  for (const event of [f.error, f.observation, f.decision, f.frame]) assert.ok(html.includes(`event=${event.event_id}`), event.event_id);
  assert.match(html, /href="\/traces\?run=baseline&amp;episode=base&amp;event=base_frame"/);
  assert.match(html, /src="\/api\/traces\/runs\/current\/episodes\/trial\/file\/frames\/last.png\?g=g2"/);
  assert.match(html, /baseline_run=baseline&amp;baseline_episode=base/);
});

test('summary uses canonical long ending labels even when the API label is stale', () => {
  const labels: Record<EndReason, string> = {
    success: '成功', error: 'エラーで停止', timeout: '時間切れ・打ち切り',
    finish_unmet: '「終わった」と答えたが未達成', regen_limit: '書き直しの上限', single_shot: '1回だけ実行して終了（single-shot）', unknown: '終わり方が不明',
  };
  for (const [reason, label] of Object.entries(labels)) {
    const summary: EpisodeSummary = { episode_id: ep.episodeId,
      end_classification: { reason: reason as EndReason, label: '古い表示語', evidence: {} } };
    const html = renderToStaticMarkup(<TrialSummaryCard ep={ep} model={buildEpisodeModel([])} summary={summary}
      verdict={reason === 'success' ? 'success' : 'failure'} />);
    assert.ok(html.includes(`<dt>終わり方</dt><dd><strong>${label}</strong></dd>`), reason);
    assert.doesNotMatch(html, /古い表示語/);
  }
});

test('unavailable summary items leave no empty boxes or made-up facts', () => {
  const summary = { episode_id: ep.episodeId, task: 'cube', seed: 0 };
  const html = renderToStaticMarkup(<TrialSummaryCard ep={ep} model={buildEpisodeModel([])} summary={summary} verdict="unknown" />);
  assert.match(html, /cube.*seed 0/);
  for (const label of ['最初のエラー', '最後の観察', '最後の判断', '最後の画像', 'かかった時間', '終わり方', '基準と並べて見る']) assert.ok(!html.includes(label), label);
  assert.doesNotMatch(html, /<figure|<img|ログで見る|trial-summary-card|<dl/);
  const noIdentity = renderToStaticMarkup(<TrialSummaryCard ep={ep} model={buildEpisodeModel([])} summary={{ episode_id: 'missing' }} verdict="unknown" />);
  assert.doesNotMatch(noIdentity, /<h2|未記録|trial-summary-card|<dl/);
});

test('summary uses recorded REGENERATE decisions and latest VDM text', () => {
  const f = fixture();
  const request = f.r.request('code_generator', 'later', 1, { turn_index: 2 });
  const response = f.r.response(request, 200, 'Try again\nREGENERATE');
  f.r.parsed(response, { parser: '_parse_multi_turn_decision', decision: 'regenerate' });
  const vdm = f.r.request('vdm', 'last_vdm', 1, { turn_index: 3 });
  f.r.response(vdm, 200, '最後に記録した観察');
  const facts = trialSummaryFacts(buildEpisodeModel(f.r.events), { ...f.summary, episode: { harness_summary: {} } });
  assert.equal(facts.regenerationCount, 1);
  assert.equal(facts.decision?.text, 'REGENERATE');
  assert.equal(facts.observation?.text, '最後に記録した観察');
  const html = renderToStaticMarkup(<TrialSummaryCard ep={ep} model={f.model} summary={f.summary} verdict="success"
    baseline={{ ep, trial: trial({ verdict: 'failure' }), frame: null }} />);
  assert.match(html, />改善</);
});

test('baseline pairing follows latest attempt, known task/seed and table conditions', () => {
  const detail = { baseline: { eval_id: 'baseline' }, trials: [trial({ episode_id: 'current' })], baseline_trials: [trial(), trial({ episode_id: 'latest', attempt: 2 }), trial({ episode_id: 'other_condition', condition: 'D', attempt: 3 })] } as unknown as EvalDetail;
  const summary = { episode_id: 'current', task: 'cube_lift', condition: 'C', seed: 7 };
  assert.equal(baselineForEpisode(detail, summary)?.episode_id, 'latest');
  assert.equal(baselineForEpisode(detail, { ...summary, seed: 8 }), null);
  assert.equal(baselineForEpisode(detail, { ...summary, task: null }), null);
  assert.equal(baselineForEpisode(detail, { ...summary, seed: null }), null);
  const changedCondition = { ...detail, baseline_trials: [trial({ condition: 'baseline_config' }), trial({ episode_id: 'latest_cross_condition', condition: 'baseline_config', attempt: 2 })] };
  assert.equal(baselineForEpisode(changedCondition, summary)?.episode_id, 'latest_cross_condition');
  assert.equal(baselineForEpisode(detail, { ...summary, condition: 'new_config' }), null);

});

test('last recorded frame excludes unwritten frames and image event anchors are selectable', () => {
  const f = fixture();
  f.r.add('frame', {}, { artifacts: [{ path: 'frames/missing.png', mime: 'image/png', written: false }] });
  const model = buildEpisodeModel(f.r.events);
  assert.equal(lastRecordedFrame(model)?.event.event_id, f.frame.event_id);
  assert.equal(resolveSelection(model, f.frame.event_id)?.eventId, f.frame.event_id);
  const snapshot = f.r.add('observation_snapshot', {}, { artifacts: [{ path: 'snapshots/final.png', mime: 'image/png' }] });
  const withSnapshot = buildEpisodeModel(f.r.events);
  assert.equal(lastRecordedFrame(withSnapshot)?.event.event_id, snapshot.event_id);
  assert.equal(resolveSelection(withSnapshot, snapshot.event_id)?.eventId, snapshot.event_id);
  assert.ok(!withSnapshot.roots.some(node => node.primary.event_id === snapshot.event_id));
});

test('a last VDM call without a response does not reuse an older observation', () => {
  const f = fixture();
  const request = f.r.request('vdm', 'vdm_failed', 1, { turn_index: 2 });
  f.r.logicalError(request, 'ConnectionError', 'unavailable');
  const facts = trialSummaryFacts(buildEpisodeModel(f.r.events), f.summary);
  assert.equal(facts.observation, null);
});

test('a written frame reference remains usable when a separate frame event is missing', () => {
  const r = new Rec();
  const block = r.blockStart(null);
  const end = r.blockEnd(block, 0, 0, { frame_ref: { path: 'frames/final.jpg', written: true } });
  const model = buildEpisodeModel(r.events);
  assert.equal(lastRecordedFrame(model)?.path, 'frames/final.jpg');
  assert.equal(lastRecordedFrame(model)?.event.event_id, end.event_id);
  assert.equal(resolveSelection(model, end.event_id)?.eventId, end.event_id);
});

test('a running trial says it is still running instead of naming a partial record as its ending', () => {
  const f = fixture();
  const summary: EpisodeSummary = { ...f.summary, status: 'running', end_reason: null,
    end_classification: { reason: 'unknown', label: '', evidence: {},
      cause: { code: 'recording_incomplete', explanation: '試行の終了または成否の記録が欠けています。' } } as EpisodeSummary['end_classification'] };
  const html = renderToStaticMarkup(<TrialSummaryCard ep={ep} model={f.model} summary={summary} verdict="running" />);
  assert.match(html, /<dt>終わり方<\/dt><dd><strong>まだ実行中です<\/strong><\/dd>/);
  assert.doesNotMatch(html, /記録が欠けています|根拠を見る/);
  assert.match(html, /最新（今回）/);
  assert.doesNotMatch(html, /終了時（今回）/);
});
