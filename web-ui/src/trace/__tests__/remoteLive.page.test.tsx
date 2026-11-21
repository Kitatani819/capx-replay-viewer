import { advance, net, propsOf, requests, resetBrowser, setLocation } from './harness/browser';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount, type Mounted } from './harness/fakeReact';
import TraceViewerPage from '../TraceViewerPage';
import { TopBar } from '../components/TopBar';
import { Picker } from '../components/Picker';
import { addEpisode, ev, makeRun, serve } from './pageServer';
import type { GmoLiveStatus, RemoteListingStatus } from '../api';

const LIVE = /^\/api\/gmo\/live$/;
type Bar = Parameters<typeof TopBar>[0];
const bar = (page: Mounted<Record<string, never>>) => propsOf<Bar>(page.output, TopBar);

function setup(localStatus = 'running') {
  resetBrowser();
  const run = makeRun();
  const episode = addEpisode(run, 'e1', { status: localStatus, heartbeat_age_s: 1 }, [ev('e1', 1, 'episode_start', {})]);
  addEpisode(run, 'e2', { status: 'running', heartbeat_age_s: 1 }, [ev('e2', 1, 'episode_start', {})]);
  serve(run);
  const traceHandler = net.handler;
  const state = {
    enabled: true, configured: true, conflict: false, remoteStatus: 'running', localOnly: false,
    missingUntilRefresh: false, latency: 5, error: false,
    listingStatus: { fetched_at: new Date(Date.now()).toISOString(), refreshing: false, error: null } as RemoteListingStatus,
    status: {
      following: true, run_id: 'r1', episode_id: 'e1', last_ok_at: '2026-11-20T00:00:00Z',
      last_error: null, interval_s: 2, copied_bytes: 100, stopped_reason: null,
    } as GmoLiveStatus,
  };
  const leases: { at: number; body: { run_id: string; episode_id: string } }[] = [];
  const lookups: { episode: string | null; refresh: string | null }[] = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    if (String(input) === '/api/gmo/live' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      leases.push({ at: Date.now(), body });
      state.status = { ...state.status, run_id: body.run_id, episode_id: body.episode_id };
    }
    return savedFetch(input, init);
  };
  net.handler = req => {
    if (req.path === '/api/gmo/config') return { json: { enabled: state.enabled, configured: state.configured } };
    if (req.path === '/api/gmo/episode') {
      const refresh = req.query.get('refresh');
      lookups.push({ episode: req.query.get('episode_id'), refresh });
      if (req.query.get('run_id') !== 'r1' || state.localOnly || (state.missingUntilRefresh && refresh !== '1')) {
        return { status: 404, json: { detail: 'Episode not found on GMO' } };
      }
      if (state.conflict) return { status: 409, json: { detail: 'Run ID exists in more than one GMO location' } };
      return { json: { run_id: 'r1', episode_id: req.query.get('episode_id'), status: state.remoteStatus, conflict: false } };
    }
    if (req.path === '/api/gmo/listing-status') return { json: state.listingStatus };
    if (req.path === '/api/gmo/live') return state.error
      ? { status: 502, json: { detail: '接続できません' }, latency: state.latency }
      : { json: state.status, latency: state.latency };
    return traceHandler(req);
  };
  return { episode, state, leases, lookups, restore: () => { globalThis.fetch = savedFetch; } };
}

function open(event = '') {
  setLocation(`/traces?view=details&run=r1&episode=e1${event}`);
  return mount(TraceViewerPage, {});
}

test('a remote running trial starts its lease, renews every ten seconds and polls fresh copies at the Live rate', async () => {
  const remote = setup();
  const page = open();
  try {
    await advance(100);
    assert.equal(remote.leases.length, 1);
    assert.deepEqual(remote.leases[0].body, { run_id: 'r1', episode_id: 'e1' });
    assert.match(bar(page).poll.text, /リモートからライブ更新中（約2秒ごと）/);
    remote.episode.events.push(ev('e1', 2, 'stdout', { text: 'new output' }));
    await advance(1100);
    assert.equal(bar(page).reader.count, 2);
    await advance(34_000);
    assert.ok(remote.leases.length >= 3);
    for (let i = 1; i < remote.leases.length; i++) assert.ok(remote.leases[i].at - remote.leases[i - 1].at < 30_000);
    assert.ok(requests(/\/episodes\/e1$/).done >= 30);
    assert.ok(requests(/\/episodes\/e1\/events$/).done >= 30);
    assert.ok(requests(LIVE).done > remote.leases.length, 'GET reads status between renewals');
  } finally { page.unmount(); remote.restore(); }
});

test('Live asks GMO about the open trial only, and asks again when a cached run listing predates it', async () => {
  const remote = setup();
  remote.state.missingUntilRefresh = true;
  const page = open();
  try {
    await advance(100);
    assert.deepEqual(remote.lookups, [{ episode: 'e1', refresh: '0' }, { episode: 'e1', refresh: '1' }]);
    assert.equal(remote.leases.length, 1);
    assert.equal(remote.leases[0].body.episode_id, 'e1');
    // The team listing can take minutes on a busy shared folder; Live never waits on it.
    assert.equal(requests(/\/api\/gmo\/episodes$/).sent, 0);
    assert.equal(requests(/\/api\/gmo\/listing-status$/).sent, 0);
  } finally { page.unmount(); remote.restore(); }
});

test('a failed GMO lookup is retried rather than ending Live discovery', async () => {
  const remote = setup();
  remote.state.localOnly = true;
  const failing = net.handler;
  let failures = 1;
  net.handler = req => req.path === '/api/gmo/episode' && failures-- > 0
    ? { status: 502, json: { detail: 'GMO operation timed out' } } : failing(req);
  const page = open();
  try {
    await advance(100);
    assert.equal(remote.leases.length, 0);
    assert.match(bar(page).poll.text, /再試行中：.*timed out/);
    remote.state.localOnly = false;
    await advance(2100);
    assert.equal(remote.leases.length, 1);
  } finally { page.unmount(); remote.restore(); }
});

test('Browse never starts a follower; turning Live off cancels further status reads and renewals', async () => {
  const remote = setup();
  const page = open('&event=e1_1');
  try {
    await advance(12_000);
    assert.equal(remote.leases.length, 0);
    bar(page).onLive(true);
    await advance(100);
    assert.equal(remote.leases.length, 1);
    bar(page).onLive(false);
    await advance(100);
    const before = requests(LIVE).sent;
    await advance(35_000);
    assert.equal(remote.leases.length, 1);
    assert.equal(requests(LIVE).sent, before);
    assert.match(bar(page).poll.text, /Browse/);
  } finally { page.unmount(); remote.restore(); }
});

for (const kind of ['disabled', 'unconfigured', 'local', 'conflict', 'remote-ended', 'local-ended'] as const) {
  test(`${kind} trials do not start or renew a remote follower`, async () => {
    const remote = setup(kind === 'local-ended' ? 'ended' : 'running');
    if (kind === 'disabled') remote.state.enabled = false;
    if (kind === 'unconfigured') remote.state.configured = false;
    if (kind === 'local') remote.state.localOnly = true;
    if (kind === 'conflict') remote.state.conflict = true;
    if (kind === 'remote-ended') remote.state.remoteStatus = 'ended';
    const page = open();
    try {
      await advance(35_000);
      assert.equal(remote.leases.length, 0);
      assert.equal(requests(LIVE).sent, 0);
    } finally { page.unmount(); remote.restore(); }
  });
}

test('an incomplete remote snapshot follows again and checks incoming copies every second', async () => {
  const remote = setup('incomplete');
  remote.episode.summary.heartbeat_age_s = 7200;
  const page = open();
  try {
    await advance(100);
    assert.equal(remote.leases.length, 1);
    remote.episode.summary = { ...remote.episode.summary, status: 'running', heartbeat_age_s: 1 };
    remote.episode.events.push(ev('e1', 2, 'stdout', { text: 'copied output' }));
    await advance(2200);
    assert.equal(bar(page).summary?.status, 'running');
    assert.equal(bar(page).reader.count, 2);
    assert.ok(requests(/\/episodes\/e1$/).done >= 3);
    assert.equal(remote.leases.length, 1, 'a fresh heartbeat does not restart the lease effect');
  } finally { page.unmount(); remote.restore(); }
});

test('the lease stops after the trial ends, and keeps final video copies alive while pending', async () => {
  const remote = setup();
  const page = open();
  try {
    await advance(100);
    remote.episode.summary = { ...remote.episode.summary, status: 'ended', episode: { video_copy_pending: true } };
    await advance(25_000);
    assert.ok(remote.leases.length >= 2, 'the pending MP4 can take longer than one cycle');
    remote.episode.summary = { ...remote.episode.summary, episode: { video_copy_pending: false } };
    await advance(1200);
    const before = requests(LIVE).sent;
    await advance(35_000);
    assert.equal(requests(LIVE).sent, before);
  } finally { page.unmount(); remote.restore(); }
});

test('opening another episode follows its ids; unmounting leaves no renewal timer', async () => {
  const remote = setup();
  const page = open();
  try {
    await advance(100);
    bar(page).onOpenPicker();
    await advance(50);
    propsOf<Parameters<typeof Picker>[0]>(page.output, Picker).onPick('r1', 'e2');
    await advance(100);
    assert.deepEqual(remote.leases.map(lease => lease.body.episode_id), ['e1', 'e2']);
    page.unmount();
    const before = requests(LIVE).sent;
    await advance(35_000);
    assert.equal(requests(LIVE).sent, before);
  } finally { page.unmount(); remote.restore(); }
});

test('remote errors, recovery and settings changes appear in the polling status', async () => {
  const remote = setup();
  const page = open();
  try {
    await advance(100);
    remote.state.status.last_error = '接続が切れました';
    remote.state.status.interval_s = 4;
    await advance(2100);
    assert.match(bar(page).poll.text, /リモートの更新を再試行中：接続が切れました/);
    remote.state.status.last_error = null;
    remote.state.status.interval_s = 2;
    await advance(2000);
    assert.match(bar(page).poll.text, /約2秒ごと/);
    remote.state.error = true;
    await advance(2000);
    assert.match(bar(page).poll.text, /再試行中：.*接続できません/);
    remote.state.error = false;
    remote.state.status.following = false;
    remote.state.status.stopped_reason = 'settings_changed';
    remote.state.status.last_error = '前の接続エラー';
    await advance(2000);
    assert.match(bar(page).poll.text, /接続設定が変わったため/);
    const before = requests(LIVE).sent;
    await advance(30_000);
    assert.equal(requests(LIVE).sent, before);
  } finally { page.unmount(); remote.restore(); }
});

test('a slow lease request never overlaps another and leaving Live aborts it', async () => {
  const remote = setup();
  remote.state.latency = 12_000;
  const page = open();
  try {
    await advance(11_000);
    assert.equal(requests(LIVE).sent, 1);
    assert.equal(requests(LIVE).done, 0);
    bar(page).onLive(false);
    await advance(35_000);
    assert.equal(requests(LIVE).sent, 1);
    assert.equal(requests(LIVE).aborted, 1);
  } finally { page.unmount(); remote.restore(); }
});

test('an open Live page renews again after its lease expired during browser suspension', async () => {
  const remote = setup();
  const page = open();
  try {
    await advance(100);
    remote.state.status.following = false;
    remote.state.status.stopped_reason = 'lease_expired';
    await advance(2100);
    remote.state.status.following = true;
    remote.state.status.stopped_reason = null;
    await advance(2000);
    assert.equal(remote.leases.length, 2);
    assert.match(bar(page).poll.text, /リモートからライブ更新中/);
  } finally { page.unmount(); remote.restore(); }
});

for (const phase of ['config', 'episode', 'status', 'renewal'] as const) {
  test(`Live aborts a stalled ${phase} request and retries without losing its polling loop`, async () => {
    const remote = setup();
    const handler = net.handler;
    let stalled = false;
    let liveReads = 0;
    net.handler = req => {
      if (req.path === '/api/gmo/live') liveReads += 1;
      const matches = phase === 'config' ? req.path === '/api/gmo/config'
        : phase === 'episode' ? req.path === '/api/gmo/episode'
        : phase === 'status' ? req.path === '/api/gmo/live' && liveReads === 2
        : req.path === '/api/gmo/live' && remote.leases.length === 2;
      const answer = handler(req);
      if (!stalled && matches) {
        stalled = true;
        return { ...answer, latency: 120_000 };
      }
      return answer;
    };
    const page = open();
    try {
      await advance(45_000);
      assert.equal(stalled, true);
      const aborted = net.log.filter(req => req.path.startsWith('/api/gmo/') && req.aborted);
      assert.equal(aborted.length, 1, 'the request deadline cancels the stalled request');
      assert.ok(remote.leases.length >= 2, 'the loop retries and continues renewing');
      assert.match(bar(page).poll.text, /リモートからライブ更新中/);
      const before = requests(LIVE).sent;
      page.unmount();
      await advance(35_000);
      assert.equal(requests(LIVE).sent, before, 'unmount cancels the retry timer');
    } finally { page.unmount(); remote.restore(); }
  });
}
