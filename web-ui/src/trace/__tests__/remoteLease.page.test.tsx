import test from 'node:test';
import assert from 'node:assert/strict';
import { advance, net, resetBrowser, setLocation } from './harness/browser';
import { mount } from './harness/fakeReact';
import { useRemoteLive } from '../remoteLive';
import type { GmoLiveStatus } from '../api';

function setup(site: string, stallAcquisition = false) {
  resetBrowser();
  setLocation(`/traces?site=${site}`);
  const prefix = site === 'b300' ? '/api/gmo' : `/api/sites/${site}/gmo`;
  let status: GmoLiveStatus & { lease_token: string } = {
    following: false, run_id: null, episode_id: null, lease_token: '',
    last_ok_at: null, last_error: null, interval_s: 2, copied_bytes: 0, stopped_reason: null,
  };
  const writes: { path: string; body: Record<string, string> }[] = [];
  let conflict = false;
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const path = String(input);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, string>;
      writes.push({ path, body });
      conflict = path === `${prefix}/live/renew` && (body.lease_token !== status.lease_token
        || body.run_id !== status.run_id || body.episode_id !== status.episode_id);
      if (path === `${prefix}/live`) {
        status = { ...status, following: true, run_id: body.run_id, episode_id: body.episode_id,
          lease_token: `lease-${writes.length}`, stopped_reason: null };
      } else if (!conflict) status = { ...status, following: true, stopped_reason: null };
    }
    return savedFetch(input, init);
  };
  net.handler = req => {
    if (req.path === `${prefix}/config`) return { json: { enabled: true, configured: true } };
    if (req.path === `${prefix}/episode`) return { json: { status: 'running', conflict: false } };
    if (req.path === `${prefix}/live/renew` && conflict) {
      return { status: 409, json: { error: 'lease_replaced', status: { ...status } } };
    }
    if (req.path === `${prefix}/live` && stallAcquisition) {
      stallAcquisition = false;
      return { json: { ...status }, latency: 120_000 };
    }
    if (req.path.startsWith(`${prefix}/live`)) return { json: { ...status } };
    return null;
  };
  const page = mount(() => useRemoteLive('run', 'trial', true, 'running', false), {});
  return { page, writes, prefix, get status() { return status; },
    get current() { return page.output as ReturnType<typeof useRemoteLive>; },
    replace(sameTrial = false) {
      status = { ...status, lease_token: 'other-tab', run_id: sameTrial ? 'run' : 'other', episode_id: sameTrial ? 'trial' : 'new' };
    },
    expire() { status = { ...status, following: false, stopped_reason: 'lease_expired' }; },
    restore() { page.unmount(); globalThis.fetch = savedFetch; },
  };
}

for (const site of ['b300', 'rtx']) {
  test(`${site}: an uncertain acquisition is not retried over another tab's lease`, async () => {
    const remote = setup(site, true);
    try {
      await advance(100); // Server acquired the lease, but its response has stalled.
      remote.replace();
      await advance(35_000);
      assert.equal(remote.writes.length, 1);
      assert.equal(remote.status.lease_token, 'other-tab');
      assert.equal(remote.current.status?.stopped_reason, 'acquisition_failed');
      assert.ok(remote.current.error);
    } finally { remote.restore(); }
  });

  test(`${site}: renewal boundary cannot take another tab's lease back`, async () => {
    const remote = setup(site);
    try {
      await advance(10_100); // A has just read status; B acquires before A's renewal.
      remote.replace();
      await advance(2400);
      assert.equal(remote.writes.filter(write => write.path === `${remote.prefix}/live`).length, 1);
      const renewal = remote.writes.find(write => write.path === `${remote.prefix}/live/renew`);
      assert.deepEqual(renewal?.body, { run_id: 'run', episode_id: 'trial', lease_token: 'lease-1' });
      assert.equal(remote.status.lease_token, 'other-tab');
      assert.equal(remote.current.status?.stopped_reason, 'replaced');
      assert.equal(remote.current.status?.run_id, 'other', 'retain the current follower status');
      const before = remote.writes.length;
      await advance(35_000);
      assert.equal(remote.writes.length, before);
    } finally { remote.restore(); }
  });

  test(`${site}: expiry recovery renews the retained token without another acquisition`, async () => {
    const remote = setup(site);
    try {
      await advance(100);
      remote.expire();
      await advance(5000);
      assert.deepEqual(remote.writes.map(write => write.path), [`${remote.prefix}/live`, `${remote.prefix}/live/renew`]);
      assert.equal(remote.writes[1].body.lease_token, 'lease-1');
      assert.equal(remote.current.status?.following, true);
    } finally { remote.restore(); }
  });

  test(`${site}: replacement while recovering an expired lease remains with the new owner`, async () => {
    const remote = setup(site);
    try {
      await advance(100);
      remote.expire();
      await advance(2100); // Expiry status schedules immediate conditional renewal.
      remote.replace();
      await advance(2500);
      assert.equal(remote.writes.filter(write => write.path === `${remote.prefix}/live`).length, 1);
      assert.equal(remote.status.lease_token, 'other-tab');
      assert.equal(remote.current.status?.stopped_reason, 'replaced');
    } finally { remote.restore(); }
  });

  test(`${site}: a new lease for the same trial also stops the previous owner`, async () => {
    const remote = setup(site);
    try {
      await advance(100);
      remote.replace(true);
      await advance(35_000);
      assert.equal(remote.writes.length, 1);
      assert.equal(remote.current.status?.stopped_reason, 'replaced');
    } finally { remote.restore(); }
  });
}
