import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyDecision, legacyResponses } from '../legacyResponses';

test('legacy final responses remain sequential parsed records, including a finish without prompt', () => {
  const rows = legacyResponses([
    {block_idx: [0], code_blocks: ['print("success")'], decision: 'initial', initial_prompt: [{role: 'user', content: 'task'}], reasoning: 'Candidate temp=0.1'},
    {block_idx: [1], code_blocks: ['retry()'], decision: 'regenerate'},
    {block_idx: [2], code_blocks: ['retry_again()'], decision: 'regenerate'},
    {decision: 'finish'},
  ]);
  assert.deepEqual(rows.map(r => r.index), [0, 1, 2, 3]);
  assert.deepEqual(rows.map(legacyDecision), ['Pythonコード（初回）', 'REGENERATE（修正）', 'REGENERATE（修正）', 'FINISH（終了・モデルの主張）']);
  assert.equal(rows[3].prompt, null);
  assert.deepEqual(rows[3].codes, []);
  // Mentioning a candidate in reasoning supplies neither its identity nor its answer.
  assert.equal('members' in rows[0], false);
});

test('malformed legacy rows do not fabricate code, decisions or block identity', () => {
  assert.deepEqual(legacyResponses({choices: []}), []);
  const rows = legacyResponses([null, [], 'invalid', {code_blocks: ['a', 3, 'c'], block_idx: [-1, 1, '2']}]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].index, 3);
  assert.deepEqual(rows[0].codes, [{code: 'a', block: null}, {code: 'c', block: null}]);
  assert.equal(legacyDecision(rows[0]), '判断は未記録');
});
