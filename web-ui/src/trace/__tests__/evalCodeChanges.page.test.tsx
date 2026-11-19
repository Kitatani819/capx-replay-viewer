import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from './harness/fakeReact';
import { advance, findAll, net, resetBrowser, type FakeElement } from './harness/browser';
import { EvalCodeChanges } from '../../evals/EvalCodeChanges';
import type { CodeChangeMetadata } from '../../evals/api';
import { breakdownDetail } from './failureBreakdownFixtures';

function text(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return typeof node === 'object' && 'props' in node ? text((node as FakeElement).props.children) : '';
}
const metadata: CodeChangeMetadata = { status: 'recorded', baseline_commit: 'a'.repeat(40), current_commit: 'b'.repeat(40),
  artifact: 'code_changes.json', sha256: 'c'.repeat(64), size_bytes: 300, files: 1, excluded_files: 2, untracked_files: 1, redacted: true };

test('code diff is read only after opening, with retry and accurate snapshot exclusions', async () => {
  resetBrowser();
  const record = { ...breakdownDetail().eval!, code_changes: metadata };
  net.handler = () => ({ status: 503, json: { detail: 'temporarily unavailable' } });
  const view = mount(EvalCodeChanges, { record });
  await advance(100);
  assert.equal(net.log.length, 0);
  assert.match(text(view.output), /除外 2ファイル・Git未管理 1ファイル・秘密情報のマスクあり/);
  (findAll(view.output, 'details')[0].props.onToggle as (event: unknown) => void)({ currentTarget: { open: true } });
  await advance(100);
  assert.equal(net.log.length, 1);
  assert.equal(net.log[0].path, '/api/evals/current/code-changes');
  assert.match(text(view.output), /temporarily unavailable/);
  net.handler = () => ({ json: { metadata, artifact: { files: [{ path: 'method.py', diff: '+value = "<script>synthetic</script>"' }] }, error: null, location: 'gmo' } });
  (findAll(view.output, 'button')[0].props.onClick as () => void)();
  await advance(100);
  assert.match(text(view.output), /GMO上の記録/);
  assert.equal(findAll(view.output, 'code')[0].props.children, '+value = "<script>synthetic</script>"');
  assert.equal(findAll(view.output, 'script').length, 0);
  view.unmount();
});

test('missing and unreproducible snapshots explain the reason without requesting an artifact', async () => {
  resetBrowser();
  const record = breakdownDetail().eval!;
  const view = mount(EvalCodeChanges, { record });
  assert.match(text(view.output), /コード差分が記録されていません/);
  view.update({ record: { ...record, code_changes: { ...metadata, status: 'baseline_dirty', artifact: null, sha256: null, size_bytes: null, files: 0 } } });
  (findAll(view.output, 'details')[0].props.onToggle as (event: unknown) => void)({ currentTarget: { open: true } });
  await advance(100);
  assert.match(text(view.output), /基準のコードを再現できず/);
  assert.equal(net.log.length, 0);
  view.unmount();
});
