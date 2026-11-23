import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, GmoDisabledError, gmoApi, type GmoSettings } from '../api';

const settings: GmoSettings = {
  host: 'gmo', port: 8822, identity_file: '~/.ssh/gmo',
  shared_root: '/path/to/shared/traces',
  submission_root: '~/shared-storage/submission_evals/_viewer',
  mine: ['/mine/*/traces'], team: ['/team/traces'], interval_s: 120,
};

test('every GMO endpoint sends the request header; writes send JSON and scopes and refresh are forwarded', async () => {
  const savedFetch = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  };
  const controller = new AbortController();
  try {
    await gmoApi.config(controller.signal);
    await gmoApi.saveConfig(settings, controller.signal);
    await gmoApi.check(controller.signal);
    await gmoApi.episodes('team', true, controller.signal);
    await gmoApi.episodes();
    await gmoApi.fetch('run_a', 'ep_1', controller.signal);
    await gmoApi.jobs(controller.signal);
    await gmoApi.auto(controller.signal);
    await gmoApi.setAutoPaused(true, controller.signal);
    await gmoApi.live(controller.signal);
    await gmoApi.follow('run_a', 'ep_1', controller.signal);
    await gmoApi.listingStatus(controller.signal);
    await gmoApi.names(controller.signal);
    await gmoApi.localCopies(controller.signal);
    await gmoApi.deleteLocalCopy('run_a', controller.signal);
    assert.deepEqual(calls.map(call => [call.init.method, call.url]), [
      ['GET', '/api/gmo/config'],
      ['PUT', '/api/gmo/config'],
      ['POST', '/api/gmo/check'],
      ['GET', '/api/gmo/episodes?scope=team&refresh=1'],
      ['GET', '/api/gmo/episodes?scope=all&refresh=0'],
      ['POST', '/api/gmo/fetch'],
      ['GET', '/api/gmo/jobs'],
      ['GET', '/api/gmo/auto'],
      ['PUT', '/api/gmo/auto'],
      ['GET', '/api/gmo/live'],
      ['POST', '/api/gmo/live'],
      ['GET', '/api/gmo/listing-status'],
      ['GET', '/api/gmo/names'],
      ['GET', '/api/gmo/local-copies'],
      ['POST', '/api/gmo/local-copies/delete'],
    ]);
    for (const { init } of calls) {
      const headers = new Headers(init.headers);
      assert.equal(headers.get('X-CapX-Request'), 'gmo');
      assert.equal(headers.get('Accept'), 'application/json');
      if (init.method === 'POST' || init.method === 'PUT') {
        assert.equal(headers.get('Content-Type'), 'application/json');
        assert.doesNotThrow(() => JSON.parse(String(init.body)));
      } else {
        assert.equal(init.body, undefined);
      }
    }
    assert.deepEqual(JSON.parse(String(calls[1].init.body)), settings);
    assert.deepEqual(JSON.parse(String(calls[2].init.body)), {});
    assert.deepEqual(JSON.parse(String(calls[5].init.body)), { run_id: 'run_a', episode_id: 'ep_1' });
    assert.deepEqual(JSON.parse(String(calls[8].init.body)), { paused: true });
    assert.deepEqual(JSON.parse(String(calls[10].init.body)), { run_id: 'run_a', episode_id: 'ep_1' });
    assert.deepEqual(JSON.parse(String(calls[14].init.body)), { run_id: 'run_a' });
    assert.ok(calls.filter((_, i) => i !== 4).every(({ init }) => init.signal === controller.signal));
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('GMO route-not-found answers identify a disabled integration on every endpoint', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"detail":"Not Found"}', {
    status: 404, headers: { 'Content-Type': 'application/json' },
  });
  try {
    const calls = [
      () => gmoApi.config(), () => gmoApi.saveConfig(settings), () => gmoApi.check(),
      () => gmoApi.episodes(), () => gmoApi.fetch('r', 'e'), () => gmoApi.jobs(),
      () => gmoApi.auto(), () => gmoApi.setAutoPaused(false),
      () => gmoApi.live(), () => gmoApi.follow('r', 'e'),
      () => gmoApi.listingStatus(), () => gmoApi.names(),
      () => gmoApi.localCopies(), () => gmoApi.deleteLocalCopy('r'),
    ];
    for (const call of calls) {
      await assert.rejects(call, (error: unknown) => {
        assert.ok(error instanceof GmoDisabledError);
        assert.equal((error as GmoDisabledError).status, 404);
        assert.match((error as GmoDisabledError).message, /GMO 連携が無効/);
        return true;
      });
    }
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('a removed GMO episode returns its resource error without disabling the integration', async () => {
  const savedFetch = globalThis.fetch;
  const body = { detail: 'Episode not found on GMO' };
  globalThis.fetch = async () => new Response(JSON.stringify(body), {
    status: 404, headers: { 'Content-Type': 'application/json' },
  });
  try {
    await assert.rejects(gmoApi.fetch('r', 'removed'), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error instanceof GmoDisabledError, false);
      assert.equal((error as ApiError).status, 404);
      assert.equal((error as ApiError).url, '/api/gmo/fetch');
      assert.equal((error as ApiError).message, body.detail);
      assert.deepEqual((error as ApiError).body, body);
      return true;
    });
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('GMO JSON responses and API error reasons are preserved', async () => {
  const savedFetch = globalThis.fetch;
  const config = { enabled: true, configured: true, settings, dest: '/tmp/traces', config_path: '/tmp/gmo.json' };
  const answers = [
    new Response(JSON.stringify(config), { headers: { 'Content-Type': 'application/json' } }),
    new Response('{"ok":false,"mine_episodes":0,"team_episodes":0,"error":"Permission denied"}', { headers: { 'Content-Type': 'application/json' } }),
    new Response('{"detail":"Already running"}', { status: 409, headers: { 'Content-Type': 'application/json' } }),
    new Response('ssh disconnected', { status: 502 }),
    new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }),
  ];
  globalThis.fetch = async () => answers.shift()!;
  try {
    assert.deepEqual(await gmoApi.config(), config);
    assert.deepEqual(await gmoApi.check(), { ok: false, mine_episodes: 0, team_episodes: 0, error: 'Permission denied' });
    await assert.rejects(gmoApi.fetch('r', 'e'), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal((error as ApiError).status, 409);
      assert.deepEqual((error as ApiError).body, { detail: 'Already running' });
      assert.equal((error as ApiError).message, 'Already running');
      return true;
    });
    await assert.rejects(gmoApi.episodes(), /ssh disconnected/);
    await assert.rejects(gmoApi.jobs(), /JSON ではない応答/);
  } finally {
    globalThis.fetch = savedFetch;
  }
});
