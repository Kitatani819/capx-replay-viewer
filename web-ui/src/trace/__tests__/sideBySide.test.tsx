import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildEpisodeModel } from '../model';
import { SideBySideComparison, type TrialComparisonData } from '../SideBySidePage';
import { alignComparisonCalls, comparisonCalls, comparisonUrl, firstDifferenceDetails, modelArgumentSummary, shortCallSummary, type ComparisonCall } from '../sideBySide';
import { Rec } from './fixtures';

const call = (name: string, eventId: string, turn = 0, args = ''): ComparisonCall => ({
  kind: 'api', name, eventId, turn, seq: Number(eventId.replace(/\D/g, '')) || 1,
  arguments: args, argumentSummary: args, status: 'ok', returned: 'true', resultSummary: 'true',
});
test('LCS preserves gaps for insertions and deletions and never crosses recorded turns', () => {
  const rows = alignComparisonCalls([call('observe', 'b1'), call('move', 'b2'), call('grip', 'b3'), call('move', 'b4', 1)],
    [call('observe', 'c1'), call('plan', 'c2'), call('move', 'c3'), call('grip', 'c4'), call('move', 'c5', 2)]);
  assert.deepEqual(rows.map(row => [row.turn, row.baseline?.name ?? null, row.current?.name ?? null]), [
    [0, 'observe', 'observe'], [0, null, 'plan'], [0, 'move', 'move'], [0, 'grip', 'grip'], [1, 'move', null], [2, null, 'move'],
  ]);
  assert.deepEqual(rows.map(row => row.different), [false, true, false, false, true, true]);
  assert.equal(rows.filter(row => row.firstDifference).length, 1);
  assert.equal(rows[1].firstDifference, true);
  assert.match(firstDifferenceDetails(rows[1]), /^今回だけに呼び出しがあります。/);
});
test('API argument summaries, status and result summaries affect differences', () => {
  const original = call('move', 'b1', 0, 'z=0.8');
  const changed = { ...original, eventId: 'c1', argumentSummary: 'z=0.9', status: 'error', resultSummary: 'IK failed' };
  const row = alignComparisonCalls([original], [changed])[0];
  assert.equal(row.firstDifference, true);
  assert.match(firstDifferenceDetails(row), /引数：基準「z=0.8」 \/ 今回「z=0.9」/);
  assert.match(firstDifferenceDetails(row), /状態：基準「ok」 \/ 今回「error」/);
  assert.match(firstDifferenceDetails(row), /返った内容：基準「true」 \/ 今回「IK failed」/);
  for (const field of ['argumentSummary', 'status', 'resultSummary'] as const) {
    assert.equal(alignComparisonCalls([original], [{ ...original, [field]: changed[field] }])[0].different, true, field);
  }
  assert.equal(alignComparisonCalls([original], [{ ...original, arguments: 'full data changed', returned: 'full result changed' }])[0].different, false);
});
test('short summaries use shapes and dtypes, three significant digits and at most 40 string characters', () => {
  assert.equal(shortCallSummary({ z: 2, a: 1 }), shortCallSummary({ a: 1, z: 2 }));
  assert.equal(shortCallSummary({ joints: { type: 'ndarray', shape: [7], dtype: 'float64', values: [0.1234567], path: 'one.npy', sha256: 'one' } }),
    '{"joints":ndarray(7) float64}');
  assert.equal(shortCallSummary({ x: 0.1234567, y: 1234567 }), '{"x":0.123,"y":1230000}');
  assert.equal(JSON.parse(shortCallSummary('x'.repeat(300))).length, 40);
  assert.match(shortCallSummary('x'.repeat(300)), /…"$/);
  assert.equal(shortCallSummary({ type: 'tuple', length: 2, items: [{ type: 'ndarray', shape: [7], dtype: 'float64' }, 0.123456] }),
    'tuple(2)[ndarray(7) float64,0.123]');
  assert.equal(shortCallSummary({ type: 'collections.OrderedDict', items: { b: 1, a: 2 } }), '{"a":2,"b":1}');
  assert.notEqual(shortCallSummary({ type: 'list', length: 9, items: [1, 2], truncated: 7 }),
    shortCallSummary({ type: 'list', length: 900, items: [1, 2], truncated: 898 }));
  const nested = (dtype: string) => ({ type: 'dict', length: 1, items: { camera: { type: 'dict', length: 1, items: {
    images: { type: 'dict', length: 1, items: { rgb: { type: 'ndarray', shape: [512, 512, 3], dtype } } },
  } } } });
  assert.match(shortCallSummary(nested('uint8')), /ndarray\(512,512,3\) uint8/);
  assert.notEqual(shortCallSummary(nested('uint8')), shortCallSummary(nested('float32')));
});
test('API and service calls ignore array samples, asset metadata and insignificant scalar changes', () => {
  function recording(value: number, dtype = 'float64') {
    const rec = new Rec();
    const array = { type: 'ndarray', shape: [7], dtype, values: [value], stats: { mean: value }, path: `${value}.npy`, sha256: String(value) };
    rec.add('api_call_start', { api_call_id: 'api', name: 'move', args: { joints: array, speed: value } });
    rec.add('service_call_start', { service_call_id: 'service', service: 'solver', function: 'ik', request_summary: { joints: array, speed: value } });
    rec.add('service_call_end', { service_call_id: 'service', response_summary: array });
    rec.add('api_call_end', { api_call_id: 'api', return: array });
    return comparisonCalls(buildEpisodeModel(rec.events));
  }
  const baseline = recording(0.123401);
  assert.ok(alignComparisonCalls(baseline, recording(0.123402)).every(row => !row.different));
  assert.ok(alignComparisonCalls(baseline, recording(0.124)).every(row => row.different));
  assert.ok(alignComparisonCalls(baseline, recording(0.123401, 'float32')).every(row => row.different));
  assert.match(firstDifferenceDetails(alignComparisonCalls(baseline, recording(0.124))[0]), /ndarray\(7\) float64/);
});

export function comparisonRecording(regenerate = false): TrialComparisonData {
  const rec = new Rec();
  rec.episodeStart();
  const request = rec.request('code_generator', 'write', 1, { turn_index: 0, call_kind: 'initial_code', params: { temperature: 0 } });
  const response = rec.response(request, 200, 'FINISH\nThe cube is lifted.');
  const block = rec.add('code_block_start', { code_block_id: 'block', turn_index: 0 });
  const api = rec.add('api_call_start', { api_call_id: 'api', name: 'move_to_pose', args: { z: 1 } }, { parent: block.event_id, refs: { code_block_id: 'block' } });
  const service = rec.add('service_call_start', { service_call_id: 'service', service: 'solver', function: 'ik', request_summary: { pos: [0, 1] } }, { parent: api.event_id });
  rec.add('service_call_end', { service_call_id: 'service', response_summary: { joints: [1, 2] } }, { parent: service.event_id });
  rec.add('api_call_end', { api_call_id: 'api', return: true });
  rec.add('code_block_end', { code_block_id: 'block' });
  rec.add('model_output_parsed', { model_event_id: response.event_id, decision: regenerate ? 'regenerate' : 'finish' }, { refs: { turn_index: 0 } });
  rec.episodeEnd({ duration_s: 40 });
  return { ref: { runId: regenerate ? 'current' : 'baseline', episodeId: 'trial' }, model: buildEpisodeModel(rec.events), records: [],
    summary: { episode_id: 'trial', status: 'ended', task: 'cube', seed: 7, end_reason: 'completed', episode: { harness_summary: { task_completed: !regenerate } } } };
}
test('recorder-shaped calls pair model retries, API and service completions and include decisions', () => {
  const calls = comparisonCalls(comparisonRecording().model);
  assert.deepEqual(calls.map(value => [value.kind, value.turn]), [['model', 0], ['code', 0], ['api', 0], ['service', 0], ['decision', 0]]);
  assert.equal(calls[2].name, 'move_to_pose');
  assert.equal(calls[2].argumentSummary, '{"z":1}');
  assert.equal(calls[2].returned, 'true');
  assert.equal(calls[3].name, 'solver.ik');
  assert.equal(calls[3].resultSummary, '{"joints":[1,2]}');
  assert.equal(calls[4].returned, 'FINISH');
});
test('logical model calls keep a recovered HTTP attempt together and ignore full recorded prompts', () => {
  const rec = new Rec();
  const first = rec.request('code_generator', 'logical', 1, { n_messages: 1 });
  rec.attemptError(first, 503);
  const retry = rec.request('code_generator', 'logical', 2, { n_messages: 1 });
  rec.response(retry, 200, 'FINISH');
  const model = buildEpisodeModel(rec.events);
  assert.equal(comparisonCalls(model).length, 1);
  assert.equal(comparisonCalls(model)[0].status, 'ok');
  const before = modelArgumentSummary(first, { messages: [{ role: 'user', content: 'Move to z=0.8' }] });
  const after = modelArgumentSummary(first, { messages: [{ role: 'user', content: 'Move to z=0.9' }] });
  assert.match(before, /Move to z=0.8/);
  const rows = alignComparisonCalls(comparisonCalls(model, new Map([[first.event_id, before]])), comparisonCalls(model, new Map([[first.event_id, after]])));
  assert.equal(rows[0].different, false);
  assert.equal(rows[0].modelTextDifferent, true);
  assert.equal(rows[0].firstDifference, false);
  assert.equal(firstDifferenceDetails(rows[0]), '');
});
test('VDM, generated code and ensemble member text never start a semantic difference', () => {
  function recording(changed: boolean) {
    const rec = new Rec();
    for (const [role, kind] of [['vdm', 'initial_scene_description'], ['code_generator', 'initial_code'], ['code_generator', 'ensemble_member']]) {
      const request = rec.request(role, kind, 1, { call_kind: kind, prompt: changed ? 'new prompt' : 'old prompt' });
      rec.response(request, 200, changed ? 'new response' : 'old response');
    }
    return comparisonCalls(buildEpisodeModel(rec.events));
  }
  const rows = alignComparisonCalls(recording(false), recording(true));
  assert.ok(rows.every(row => !row.different && !row.firstDifference && row.modelTextDifferent));
  const changedName = recording(true);
  changedName[0].name = 'vdm · image_diff';
  assert.ok(alignComparisonCalls(recording(false), changedName).some(row => row.firstDifference));
});
test('text asset hashes detect optional model text differences beyond identical previews', () => {
  function recording(hash: string) {
    const rec = new Rec();
    const request = rec.request('vdm', 'scene');
    rec.response(request, 200, { truncated: true, preview: 'identical preview', length: 5000, sha256: hash, asset: `${hash}.txt.gz` });
    return comparisonCalls(buildEpisodeModel(rec.events));
  }
  const row = alignComparisonCalls(recording('a'), recording('b'))[0];
  assert.equal(row.different, false);
  assert.equal(row.modelTextDifferent, true);
});
test('code blocks compare status only, keeping full recorded code for expansion', () => {
  function recording(code: string, rc: number) {
    const rec = new Rec();
    rec.add('code_block_start', { code_block_id: 'block', turn_index: 0, code });
    rec.add('code_block_end', { code_block_id: 'block', sandbox_rc: rc, result_summary: code });
    return comparisonCalls(buildEpisodeModel(rec.events));
  }
  const baseline = recording('old code'.repeat(100), 0);
  assert.equal(baseline[0].arguments.length, 800);
  assert.equal(alignComparisonCalls(baseline, recording('different code', 0))[0].different, false);
  const failed = alignComparisonCalls(baseline, recording('different code', 1))[0];
  assert.equal(failed.firstDifference, true);
  assert.equal(firstDifferenceDetails(failed), '状態：基準「ok」 / 今回「error」');
});
test('only parsed code-writer FINISH and REGENERATE decisions affect semantic differences', () => {
  const baseline = comparisonCalls(comparisonRecording().model);
  const current = comparisonCalls(comparisonRecording(true).model);
  const rows = alignComparisonCalls(baseline, current);
  assert.deepEqual(rows.filter(row => row.different).map(row => row.current?.kind), ['decision']);
  assert.equal(firstDifferenceDetails(rows.find(row => row.firstDifference)!), '判断：基準「FINISH」 / 今回「REGENERATE」');
  const rec = new Rec();
  const request = rec.request('perception_vlm', 'point', 1, { call_kind: 'point' });
  const response = rec.response(request, 200, 'FINISH');
  rec.parsed(response, { decision: 'finish' });
  assert.deepEqual(comparisonCalls(buildEpisodeModel(rec.events)).map(value => value.kind), ['model']);
});
test('comparison renders first-difference marker, factual banner and event links for both trials', () => {
  const html = renderToStaticMarkup(<SideBySideComparison baseline={comparisonRecording()} current={comparisonRecording(true)} />);
  assert.equal((html.match(/ここから違う/g) ?? []).length, 1);
  assert.match(html, /ターン0の コードを書くモデルの判断 から違います/);
  assert.match(html, /判断：基準「FINISH」 \/ 今回「REGENERATE」/);
  assert.match(html, /role="switch" aria-checked="false"/);
  assert.match(html, /違う行だけ表示/);
  assert.match(html, /モデルの文章の違いも表示/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /1ターン/);
  assert.match(html, /40.0 s/);
  assert.match(html, /成功/);
  assert.match(html, /失敗/);
  assert.equal(comparisonUrl('current', 'trial', 'baseline', 'trial'), '/traces/compare?run=current&episode=trial&baseline_run=baseline&baseline_episode=trial&site=b300');
});
test('all-same banners distinguish identical calls and differences confined to model text', () => {
  const baseline = comparisonRecording();
  const same = renderToStaticMarkup(<SideBySideComparison baseline={baseline} current={baseline} />);
  assert.match(same, /API の呼び出しと判断は同じです/);
  assert.doesNotMatch(same, /ここから違う|モデルの文章だけが違います/);
  const current = comparisonRecording();
  current.model.events.find(event => event.event_type === 'model_response')!.data = { content: 'DIFFERENT GENERATED TEXT' };
  current.model = buildEpisodeModel(current.model.events);
  const textOnly = renderToStaticMarkup(<SideBySideComparison baseline={baseline} current={current} />);
  assert.match(textOnly, /API の呼び出しと判断は同じです（モデルの文章だけが違います）/);
  assert.doesNotMatch(textOnly, /ここから違う|DIFFERENT GENERATED TEXT/);
});
