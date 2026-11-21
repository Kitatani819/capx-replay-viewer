import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEpisodeModel, nodeTitle } from '../model';
import { comparisonCalls } from '../sideBySide';
import { Rec } from './fixtures';

function titles(rec: Rec): string[] {
  return buildEpisodeModel(rec.events).calls.map(call => nodeTitle(call.node));
}

test('parallel reasoning candidates are numbered per turn and the synthesis is named', () => {
  const r = new Rec();
  r.response(r.request('vdm', 'scene', 1, { call_kind: 'initial_scene_description', turn_index: 0 }));
  for (const turn of [0, 1]) {
    for (const id of ['a', 'b', 'c']) r.response(r.request('code_generator', `${id}${turn}`, 1, { call_kind: 'ensemble_member', turn_index: turn }));
    r.response(r.request('code_generator', `s${turn}`, 1, { call_kind: 'ensemble_synthesis', turn_index: turn }));
  }
  assert.deepEqual(titles(r), [
    'vdm · initial_scene_description',
    'パラレルリーズニング：候補 1/3', 'パラレルリーズニング：候補 2/3', 'パラレルリーズニング：候補 3/3', 'パラレルリーズニング：統合',
    'パラレルリーズニング：候補 1/3', 'パラレルリーズニング：候補 2/3', 'パラレルリーズニング：候補 3/3', 'パラレルリーズニング：統合',
  ]);
});

test('a retried candidate keeps one number and a second group in the same turn starts again', () => {
  const r = new Rec();
  const first = r.request('code_generator', 'a', 1, { call_kind: 'ensemble_member', turn_index: 2 });
  r.attemptError(first, 503);
  r.response(r.request('code_generator', 'b', 1, { call_kind: 'ensemble_member', turn_index: 2 }));
  r.response(r.request('code_generator', 'a', 2, { call_kind: 'ensemble_member', turn_index: 2 }));
  r.response(r.request('code_generator', 's', 1, { call_kind: 'ensemble_synthesis', turn_index: 2 }));
  r.response(r.request('code_generator', 'c', 1, { call_kind: 'ensemble_member', turn_index: 2 }));
  assert.deepEqual(titles(r), [
    'パラレルリーズニング：候補 1/2', 'パラレルリーズニング：候補 2/2', 'パラレルリーズニング：統合', 'パラレルリーズニング：候補 1/1',
  ]);
});

test('side-by-side rows share one candidate name so candidates still line up', () => {
  const r = new Rec();
  for (const id of ['a', 'b']) r.response(r.request('code_generator', id, 1, { call_kind: 'ensemble_member', turn_index: 0 }));
  assert.deepEqual(comparisonCalls(buildEpisodeModel(r.events)).map(call => call.name), ['パラレルリーズニング：候補', 'パラレルリーズニング：候補']);
});
