import test from 'node:test';
import assert from 'node:assert/strict';
import { apiDefinition } from '../apiDefinitions';
import { apiCallSite, apiLineMatch, recordedModelForApi } from '../apiPython';
import { buildEpisodeModel } from '../model';
import { dataOf } from '../types';
import { Rec } from './fixtures';

const code = 'obs = get_observation()\nposition = [0.4, 0.0, 0.2]\ngoto_pose(position)';

test('API line mapping uses exact call_site, even when the tree parent is a different block', () => {
  const r = new Rec();
  const oldBlock = r.blockStart(null, code);
  const currentBlock = r.blockStart(null, 'helper()');
  const api = r.apiStart(currentBlock, 'goto_pose', {}, null, {
    call_site: { code_block_id: oldBlock.event_id, line: 3 },
  });
  const model = buildEpisodeModel(r.events);
  const site = apiCallSite(model, model.nodeOfEvent.get(api.event_id)!);
  assert.equal(site.block?.primary.event_id, oldBlock.event_id);
  assert.deepEqual(apiLineMatch(site, code), { line: 3, reason: null });
});

test('missing call_site is not filled from parent, refs, source_line or nearby events', () => {
  const r = new Rec();
  const block = r.blockStart(null, code);
  const api = r.apiStart(block, 'goto_pose', {}, null, { call_site: { line: 3, source_line: 'goto_pose(position)' } });
  api.refs = { code_block_id: block.event_id };
  const model = buildEpisodeModel(r.events);
  const site = apiCallSite(model, model.nodeOfEvent.get(api.event_id)!);
  assert.equal(site.block, null);
  assert.equal(site.recordedLine, null);
  assert.match(site.reason!, /code_block_id.*未記録/);
});

test('missing, nonnumeric, fractional, nonfinite and nonpositive line numbers never highlight a guessed line', () => {
  for (const line of [null, undefined, '3', 0, -1, 1.5, NaN, Infinity]) {
    const r = new Rec();
    const block = r.blockStart(null, code);
    const api = r.apiStart(block, 'goto_pose', {}, null, { call_site: { code_block_id: block.event_id, line } });
    const model = buildEpisodeModel(r.events);
    const site = apiCallSite(model, model.nodeOfEvent.get(api.event_id)!);
    assert.equal(site.block?.primary.event_id, block.event_id);
    assert.equal(apiLineMatch(site, code).line, null);
    assert.match(site.reason!, /呼び出し行.*未記録/);
  }
});

test('unresolved or ambiguous block IDs do not resolve through the API parent', () => {
  const r = new Rec();
  const first = r.blockStart(null, code);
  const second = r.blockStart(null, code);
  first.data = { ...dataOf(first, 'code_block_start'), code_block_id: 'duplicate' };
  second.data = { ...dataOf(second, 'code_block_start'), code_block_id: 'duplicate' };
  const missing = r.apiStart(first, 'goto_pose', {}, null, { call_site: { code_block_id: 'absent', line: 3 } });
  const ambiguous = r.apiStart(first, 'goto_pose', {}, null, { call_site: { code_block_id: 'duplicate', line: 3 } });
  const model = buildEpisodeModel(r.events);
  assert.match(apiCallSite(model, model.nodeOfEvent.get(missing.event_id)!).reason!, /ブロック.*未記録/);
  const site = apiCallSite(model, model.nodeOfEvent.get(ambiguous.event_id)!);
  assert.equal(site.block, null);
  assert.match(site.reason!, /複数/);
});

test('only complete resolved code establishes a line; out-of-range and previews remain unmarked', () => {
  const r = new Rec();
  const block = r.blockStart(null, code);
  const api = r.apiStart(block, 'goto_pose');
  const model = buildEpisodeModel(r.events);
  const site = apiCallSite(model, model.nodeOfEvent.get(api.event_id)!);
  assert.equal(apiLineMatch(site, null).line, null);
  assert.equal(apiLineMatch(site, '').line, null);
  assert.equal(apiLineMatch(site, code, true).line, null);
  assert.match(apiLineMatch(site, 'one line').reason!, /範囲外/);
  assert.equal(apiLineMatch(site, code.replaceAll('\n', '\r\n')).line, 3);
});

test('model source follows the exact producing response and HTTP attempt, not the last answer in the turn', () => {
  const r = new Rec();
  const firstRequest = r.request('code_generator', 'synthesis', 1, { turn_index: 1 });
  const firstResponse = r.response(firstRequest, 200, code);
  const secondRequest = r.request('code_generator', 'synthesis', 2, { turn_index: 1 });
  r.response(secondRequest, 200, 'print("later retry")');
  r.response(r.request('code_generator', 'other-call', 1, { turn_index: 1 }), 200, 'FINISH');
  const block = r.blockStart(firstResponse, code);
  const api = r.apiStart(block, 'goto_pose');
  const model = buildEpisodeModel(r.events);
  const source = recordedModelForApi(model, model.nodeOfEvent.get(api.event_id)!);
  assert.equal(source.call?.id, 'synthesis');
  assert.equal(source.response, firstResponse);
  assert.equal(source.block?.primary.event_id, block.event_id);
  assert.equal(source.reason, null);
});

test('valid block source resolves even when the API line is missing', () => {
  const r = new Rec();
  const response = r.response(r.request('code_generator', 'producer'), 200, code);
  const block = r.blockStart(response, code);
  const api = r.apiStart(block, 'goto_pose', {}, null, { call_site: { code_block_id: block.event_id } });
  const model = buildEpisodeModel(r.events);
  assert.equal(recordedModelForApi(model, model.nodeOfEvent.get(api.event_id)!).response, response);
  assert.equal(recordedModelForApi(model, model.nodeOfEvent.get(block.event_id)!).response, response);
});

test('missing and Oracle model sources do not borrow another response', () => {
  const r = new Rec();
  const request = r.request('code_generator', 'unrelated', 1, { turn_index: 1 });
  r.response(request, 200, code);
  const noSource = r.blockStart(null, code, { turn_index: 1 });
  const oracle = r.blockStart(null, code, { code_source: 'oracle' });
  const requestSource = r.blockStart(request, code);
  const model = buildEpisodeModel(r.events);
  for (const block of [noSource, oracle, requestSource]) {
    const source = recordedModelForApi(model, model.nodeOfEvent.get(block.event_id)!);
    assert.equal(source.call, null);
    assert.equal(source.response, null);
    assert.ok(source.reason);
  }
  assert.match(recordedModelForApi(model, model.nodeOfEvent.get(oracle.event_id)!).reason!, /Oracle/);
});

test('an explicitly referenced response is preserved when its request attempt is absent', () => {
  const r = new Rec();
  r.request('code_generator', 'producer', 1);
  const response = r.add('model_response', { role: 'code_generator', logical_call_id: 'producer', http_attempt: 5, content: code });
  const block = r.blockStart(response, code);
  const model = buildEpisodeModel(r.events);
  const source = recordedModelForApi(model, model.nodeOfEvent.get(block.event_id)!);
  assert.equal(source.response, response);
  assert.equal(source.call?.id, 'producer');
  assert.ok(source.call?.unmatched.includes(response));
});

test('registered descriptions identify pinned reference definitions and never infer unfamiliar suffixes', () => {
  const r = new Rec();
  const block = r.blockStart(null, code);
  const names = ['goto_pose', 'get_observation', 'segment_sam3_text_prompt', 'custom.goto_pose', 'unknown', 'toString'];
  const apis = names.map((name) => r.apiStart(block, name));
  const model = buildEpisodeModel(r.events);
  for (const api of apis.slice(0, 3)) {
    const definition = apiDefinition(model.nodeOfEvent.get(api.event_id)!)!;
    assert.ok(definition.summaryJa);
    assert.ok(definition.docstring);
    assert.match(definition.sourceUrl, /blob\/e26d1ea5f7f164511120c6395f126262a2c1c886\//);
    assert.match(definition.sourceLabel, /参照実装/);
    assert.match(definition.scopeNote, /一致は未確認/);
  }
  for (const api of apis.slice(3)) assert.equal(apiDefinition(model.nodeOfEvent.get(api.event_id)!), null);
  assert.equal(apiDefinition(model.nodeOfEvent.get(block.event_id)!), null);
});
