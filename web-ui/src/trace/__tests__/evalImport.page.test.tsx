/** Only the missing URL episode is imported; failures keep a comparison link. */
import { advance, findAll, net, propsOf, resetBrowser, setLocation, type FakeElement } from './harness/browser';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from './harness/fakeReact';
import TraceViewerPage from '../TraceViewerPage';
import { TopBar } from '../components/TopBar';
import type { GmoEpisodeSummary, GmoJob, RemoteListingStatus } from '../api';
import { addEpisode, ev, makeRun, serve } from './pageServer';

const browserFetch = globalThis.fetch;
function text(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (typeof node === 'object' && 'props' in node) return text((node as FakeElement).props.children);
  return '';
}
function setup() {
  resetBrowser();
  const run = makeRun('ev-demo');
  serve(run); const traceHandler = net.handler;
  const row: GmoEpisodeSummary = { run_id: run.runId, episode_id: 'target', task: 'cube', seed: 401, status: 'ended', owner: 'alice', mine: false, size_bytes: 2048, local_state: 'remote', conflict: false };
  const state = { rows: [row], enabled: true, configured: true, configStatus: 200, fetchStatus: 200,
    listingStatus: { fetched_at: new Date(Date.now()).toISOString(), refreshing: false, error: null } as RemoteListingStatus,
    job: { job_id: 'job_1', run_id: run.runId, episode_id: 'target', state: 'queued', bytes: 0, error: null, note: null, started_at: null, finished_at: null } as GmoJob,
    otherJobs: [] as GmoJob[],
    posts: [] as { path: string; body: unknown }[] };
  globalThis.fetch = (input, init) => {
    if (init?.method === 'POST') state.posts.push({ path: new URL(String(input), 'http://localhost').pathname, body: JSON.parse(String(init.body)) as unknown });
    return browserFetch(input, init);
  };
  net.handler = req => {
    if (req.path === '/api/gmo/config') return { status: state.configStatus, json: { enabled: state.enabled, configured: state.configured } };
    if (req.path === '/api/gmo/episode') {
      assert.equal(req.query.get('run_id'), run.runId);
      assert.equal(req.query.get('episode_id'), 'target');
      if (state.listingStatus.error) return { status: 502, json: { detail: state.listingStatus.error } };
      const rows = state.rows.filter(item => item.run_id === run.runId && item.episode_id === 'target');
      if (!rows.length) return { status: 404, json: { detail: 'Episode not found on GMO' } };
      if (rows.length > 1 || rows.some(item => item.conflict)) return { status: 409, json: { detail: 'Run ID exists in more than one GMO location' } };
      return { json: rows[0] };
    }
    if (req.path === '/api/gmo/listing-status') return { json: state.listingStatus };
    if (req.path === '/api/gmo/fetch') return state.fetchStatus === 200 ? { json: { job_id: 'job_1' } } : { status: state.fetchStatus, json: { detail: state.fetchStatus === 409 ? 'This episode is already queued or running' : '1 GiB transfer limit' } };
    if (req.path === '/api/gmo/jobs') return { json: [...state.otherJobs, state.job] };
    return traceHandler(req);
  };
  setLocation('/traces?run=ev-demo&episode=target');
  const complete = () => {
    state.job.state = 'done';
    addEpisode(run, 'target', { status: 'ended', task: 'cube', trace_complete: true }, [ev('target', 1, 'episode_start', { task: 'cube' }), ev('target', 2, 'episode_end', { end_reason: 'completed', trace_complete: true })]);
  };
  return { state, row, run, complete };
}
test('missing trial follows discovery, one fetch and jobs, then opens local trace', async () => {
  const { state, complete } = setup();
  state.rows.push({ ...state.rows[0], episode_id: 'unrelated' });
  const page = mount(TraceViewerPage, {});
  await advance(100);
  assert.match(text(page.output), /GMOから取り込み中（2.0 KB）/);
  assert.deepEqual(state.posts, [{ path: '/api/gmo/fetch', body: { run_id: 'ev-demo', episode_id: 'target' } }]);
  assert.ok(findAll(page.output, 'a').some(a => a.props.href === '/evals/ev-demo?site=b300'));
  complete(); await advance(1500);
  assert.equal(propsOf<Parameters<typeof TopBar>[0]>(page.output, TopBar).summary?.task, 'cube');
  assert.doesNotMatch(text(page.output), /GMOから取り込み中/);
  assert.equal(state.posts.length, 1);
  page.unmount();
});

test('missing trial discovers its run while an unrelated team listing stays cold', async () => {
  const { state, complete } = setup();
  state.listingStatus = { fetched_at: null, refreshing: true, error: null };
  const page = mount(TraceViewerPage, {});
  await advance(100);
  assert.deepEqual(state.posts, [{ path: '/api/gmo/fetch', body: { run_id: 'ev-demo', episode_id: 'target' } }]);
  assert.equal(net.log.filter(req => ['/api/gmo/episodes', '/api/gmo/listing-status'].includes(req.path)).length, 0);
  complete(); await advance(1100);
  assert.equal(propsOf<Parameters<typeof TopBar>[0]>(page.output, TopBar).summary?.task, 'cube');
  page.unmount();
});

test('missing trial reports background discovery failures without declaring a remote episode absent', async () => {
  const { state } = setup();
  state.rows = [];
  state.listingStatus = { fetched_at: null, refreshing: false, error: 'GMO listing failed' };
  const page = mount(TraceViewerPage, {});
  await advance(100);
  assert.match(text(page.output), /GMOから取り込めません：HTTP 502: GMO listing failed/);
  assert.doesNotMatch(text(page.output), /GMO にも見つかりません/);
  assert.equal(state.posts.length, 0);
  page.unmount();
});

test('automatic import leaves approximate transfer limits to the server exact manifest', async () => {
  const { row, state } = setup();
  row.size_bytes = 1024 ** 3;
  row.size_approximate = true;
  const page = mount(TraceViewerPage, {});
  await advance(100);
  assert.equal(state.posts.length, 1);
  assert.match(text(page.output), /GMOから取り込み中（約 1.00 GB）/);
  page.unmount();
});
for (const jobState of ['queued', 'running'] as const) {
  test(`missing trial follows an existing ${jobState} job after a fetch conflict`, async () => {
    const { state, complete } = setup();
    state.fetchStatus = 409;
    state.job.state = jobState;
    state.otherJobs = [
      { ...state.job, job_id: 'other_run', run_id: 'other', state: 'failed', error: 'wrong run' },
      { ...state.job, job_id: 'other_episode', episode_id: 'other', state: 'failed', error: 'wrong episode' },
      { ...state.job, job_id: 'old_job', state: 'failed', error: 'old failure' },
    ];
    const page = mount(TraceViewerPage, {});
    await advance(100);
    assert.match(text(page.output), /GMOから取り込み中/);
    complete(); await advance(1500);
    assert.equal(propsOf<Parameters<typeof TopBar>[0]>(page.output, TopBar).summary?.task, 'cube');
    assert.equal(state.posts.length, 1);
    page.unmount();
  });
}
test('fetch conflict follows a job that finishes before the jobs lookup', async () => {
  const { state, complete } = setup();
  state.fetchStatus = 409;
  const handler = net.handler;
  net.handler = req => {
    if (req.path === '/api/gmo/fetch') complete();
    return handler(req);
  };
  const page = mount(TraceViewerPage, {}); await advance(100);
  assert.equal(propsOf<Parameters<typeof TopBar>[0]>(page.output, TopBar).summary?.task, 'cube');
  assert.doesNotMatch(text(page.output), /GMOから取り込み中/);
  assert.equal(state.posts.length, 1);
  assert.equal(net.log.filter(req => req.path === '/api/gmo/jobs').length, 2);
  page.unmount();
});
test('fetch conflict without a matching job keeps the conflict reason', async () => {
  const { state } = setup();
  state.fetchStatus = 409;
  state.job.episode_id = 'unrelated';
  const page = mount(TraceViewerPage, {}); await advance(100);
  assert.match(text(page.output), /GMOから取り込めません：HTTP 409: This episode is already queued or running/);
  assert.equal(state.posts.length, 1);
  page.unmount();
});
for (const reloadStatus of [404, 500]) {
  test(`finished import reports a ${reloadStatus} reload failure and retries the local read`, async () => {
    const { state, complete } = setup();
    const handler = net.handler;
    let failReload = false;
    net.handler = req => failReload && req.path === '/api/traces/runs/ev-demo/episodes/target'
      ? { status: reloadStatus, json: { detail: 'imported trace is unavailable' }, latency: 500 }
      : handler(req);
    const page = mount(TraceViewerPage, {}); await advance(100);
    failReload = true;
    state.job.state = 'done';
    await advance(1000);
    assert.match(text(page.output), /取り込んだ試行を読み込み中/);
    assert.equal(findAll(page.output, 'button').filter(button => text(button) === 'もう一度読み込む').length, 0);
    await advance(600);
    assert.match(text(page.output), /試行を読み込めません：.*imported trace is unavailable/);
    assert.doesNotMatch(text(page.output), /GMOから取り込み中/);
    const retry = findAll(page.output, 'button').find(button => text(button) === 'もう一度読み込む');
    assert.ok(retry);
    failReload = false;
    complete();
    (retry!.props.onClick as () => void)();
    await advance(100);
    assert.equal(propsOf<Parameters<typeof TopBar>[0]>(page.output, TopBar).summary?.task, 'cube');
    assert.equal(state.posts.length, 1);
    page.unmount();
  });
}
for (const reason of ['disabled', 'unconfigured', 'absent', 'large', 'conflict', 'duplicate', 'fetch-limit', 'job-failure'] as const) {
  test(`missing trial explains ${reason} and links back without unrelated imports`, async () => {
    const { state, row } = setup();
    let expected: RegExp;
    if (reason === 'disabled') { state.configStatus = 404; expected = /GMO連携を有効にすると自動で取り込みます/; }
    else if (reason === 'unconfigured') { state.configured = false; expected = /GMO連携を有効にすると自動で取り込みます/; }
    else if (reason === 'absent') { state.rows = []; expected = /GMO にも見つかりません/; }
    else if (reason === 'large') { row.size_bytes = 1024 ** 3; expected = /1 GiB の上限/; }
    else if (reason === 'conflict') { row.conflict = true; expected = /複数の場所/; }
    else if (reason === 'duplicate') { state.rows.push({ ...row }); expected = /複数の場所/; }
    else if (reason === 'fetch-limit') { state.fetchStatus = 413; expected = /1 GiB transfer limit/; }
    else { state.job.state = 'failed'; state.job.error = 'rsync failed'; expected = /rsync failed/; }
    const page = mount(TraceViewerPage, {}); await advance(100);
    assert.match(text(page.output), expected);
    assert.ok(findAll(page.output, 'a').some(a => a.props.href === '/evals/ev-demo?site=b300'));
    assert.equal(state.posts.length, reason === 'fetch-limit' || reason === 'job-failure' ? 1 : 0);
    page.unmount();
  });
}
test('local trial never looks at GMO', async () => {
  const { complete } = setup(); complete();
  const page = mount(TraceViewerPage, {}); await advance(100);
  assert.equal(net.log.filter(req => req.path.startsWith('/api/gmo/')).length, 0);
  page.unmount();
});
test('navigation cancels pending discovery so it cannot import the previous trial', async () => {
  const { state, complete } = setup();
  const handler = net.handler;
  net.handler = req => req.path === '/api/gmo/episode' ? { json: state.rows[0], latency: 5000 } : handler(req);
  const page = mount(TraceViewerPage, {}); await advance(100);
  complete();
  page.unmount(); await advance(6000);
  assert.equal(state.posts.length, 0);
});

for (const localState of ['local', 'stale'] as const) {
  test(`an evicted import job stays pending then opens its ${localState} episode`, async () => {
    const { row, state, complete } = setup();
    const handler = net.handler;
    let evicted = false;
    net.handler = req => {
      if (evicted && req.path === '/api/gmo/jobs') return { json: [] };
      if (req.path === '/api/gmo/episode') {
        assert.equal(req.query.get('run_id'), 'ev-demo');
        assert.equal(req.query.get('episode_id'), 'target');
        return { json: row };
      }
      return handler(req);
    };
    const page = mount(TraceViewerPage, {});
    try {
      await advance(100);
      evicted = true;
      row.local_state = 'fetching';
      await advance(2100);
      assert.match(text(page.output), /GMOから取り込み中/);
      assert.doesNotMatch(text(page.output), /取り込み状況が見つかりません/);
      complete();
      row.local_state = localState;
      await advance(1100);
      assert.equal(propsOf<Parameters<typeof TopBar>[0]>(page.output, TopBar).summary?.task, 'cube');
      assert.equal(state.posts.length, 1, 'eviction never starts a second transfer');
    } finally { page.unmount(); }
  });
}

test('an evicted import job reports failure when its episode is no longer pending or local', async () => {
  const { row } = setup();
  const handler = net.handler;
  let evicted = false;
  net.handler = req => {
    if (evicted && req.path === '/api/gmo/jobs') return { json: [] };
    if (req.path === '/api/gmo/episode') return { json: row };
    return handler(req);
  };
  const page = mount(TraceViewerPage, {});
  try {
    await advance(100);
    evicted = true;
    await advance(1100);
    assert.match(text(page.output), /取り込み状況が見つかりません/);
    assert.equal(net.log.filter(req => req.path === '/api/gmo/episode').length, 2);
  } finally { page.unmount(); }
});
