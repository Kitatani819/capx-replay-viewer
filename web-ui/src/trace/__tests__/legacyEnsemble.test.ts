import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyEnsembleTurn, legacyOutputDecision, matchingLegacyExecution, parseLegacyCandidates, parseLegacySynthesis } from '../legacyEnsemble';
import { legacyResponses } from '../legacyResponses';

const rule = '='.repeat(60);
test('candidate logs retain recorded counts, order, errors and text without inventing truncation or adoption', () => {
  const log = `${rule}\nModel: same-model\nTemperature: 0.9\nSuccess: True\n${rule}\nFINISH\n\n${rule}\nModel: same-model\nTemperature: 0.1\nSuccess: False\n${rule}\nHTTP timeout`;
  const rows = parseLegacyCandidates(log.replace(/\n/g, '\r\n'));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => [r.temperature, r.success, r.response]), [['0.9', true, 'FINISH'], ['0.1', false, 'HTTP timeout']]);
  assert.equal('truncated' in rows[0], false);
  assert.equal('used' in rows[0], false);
  assert.deepEqual(parseLegacyCandidates('Model: no header'), []);
});

test('synthesis separates reasoning from OUTPUT and does not turn reasoning code into an executed block', () => {
  const log = `Model: example\n\n${rule}\nREASONING\n${rule}\nFINISH\n\`\`\`python\nwrong()\n\`\`\`\n\n${rule}\nOUTPUT\n${rule}\nREGENERATE\n\`\`\`python\nright()\n\`\`\``;
  const final = parseLegacySynthesis(log)!;
  assert.equal(final.model, 'example');
  assert.ok(final.reasoning?.includes('wrong()'));
  assert.equal(legacyOutputDecision(final.output), 'REGENERATE（修正）');
  const rows = legacyResponses([{block_idx: [3], code_blocks: ['right()']}]);
  assert.equal(matchingLegacyExecution(final.output, rows)?.codes[0].block, 3);
  assert.equal(matchingLegacyExecution(final.output, [...rows, ...rows]), null);
  assert.equal(matchingLegacyExecution(final.output, legacyResponses([{code_blocks: ['right()']}])), null);
});

test('missing or ambiguous OUTPUT is not presented as a synthesis response', () => {
  assert.equal(parseLegacySynthesis(`Model: example\n${rule}\nREASONING\n${rule}\nFINISH`), null);
  assert.equal(parseLegacySynthesis(`${rule}\nOUTPUT\n${rule}\nFINISH\n${rule}\nOUTPUT\n${rule}\nREGENERATE`), null);
  assert.equal(legacyOutputDecision('```python\nprint("FINISH")\n```'), 'Pythonコード');
  assert.equal(legacyOutputDecision('FINISH'), 'FINISH（終了・モデルの主張）');
  assert.equal(legacyOutputDecision('not sure'), '判断形式は未確認');
});

test('only exact candidate filenames provide regeneration numbers', () => {
  assert.equal(legacyEnsembleTurn('ensemble_candidates.txt'), 0);
  assert.equal(legacyEnsembleTurn('ensemble_candidates_regen_03.txt'), 3);
  assert.equal(legacyEnsembleTurn('ensemble_synthesis_regen_03.txt'), null);
  assert.equal(legacyEnsembleTurn('other/ensemble_candidates.txt'), null);
});
