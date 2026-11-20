import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteListingText } from '../remoteListing';

test('remote listing status uses the fetched timestamp and distinguishes refreshing and failed snapshots', () => {
  const fetched_at = '2026-11-20T02:34:00Z';
  const time = new Date(fetched_at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', hour12: false });
  assert.equal(remoteListingText({ fetched_at, refreshing: false, error: null }), `GMO の一覧：${time} 時点`);
  assert.equal(remoteListingText({ fetched_at, refreshing: true, error: 'previous failure' }), `GMO の一覧：${time} 時点（更新中…）`);
  assert.equal(remoteListingText({ fetched_at, refreshing: false, error: 'failed' }), `GMO の一覧：${time} 時点（更新に失敗）`);
  assert.equal(remoteListingText({ fetched_at: null, refreshing: true, error: null }), 'GMO の一覧：未取得（更新中…）');
});
