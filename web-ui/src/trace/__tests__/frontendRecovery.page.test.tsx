import { advance, findAll, net, propsOf, requests, resetBrowser, setLocation, type FakeElement } from './harness/browser';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from './harness/fakeReact';
import { currentSiteName, rememberSite, siteHref } from '../../navigation/site';
import { comparisonUrl, trialEventUrl } from '../sideBySide';
import SideBySidePage, { SideBySideComparison } from '../SideBySidePage';
import { useEpisodeEvents, type EpisodeEvents } from '../hooks';
import { EventsPager } from '../pager';
import type { EventsPage } from '../types';
import { Picker } from '../components/Picker';
import { SimplePicker } from '../components/SimpleViewer';
import { SmallButton } from '../components/common';
import { addEpisode, ev, makeRun, serve } from './pageServer';

function text(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return typeof node === 'object' && 'props' in node ? text((node as FakeElement).props.children) : '';
}
function click(node: unknown, label: string): void {
  const button = [...findAll(node, SmallButton), ...findAll(node, 'button')].find(item => text(item) === label);
  assert.ok(button, `${label} exists`);
  (button!.props.onClick as () => void)();
}
function comparisonSetup(status: 'running' | 'ended' | 'incomplete', pending = false) {
  resetBrowser();
  const run = makeRun();
  addEpisode(run, 'baseline', { status: 'ended' }, []);
  const current = addEpisode(run, 'current', { status, episode: { video_copy_pending: pending } }, [
    ev('current', 1, 'api_call_start', { api_call_id: 'call', name: 'observe' }),
  ]);
  serve(run);
  setLocation('/traces/compare?run=r1&episode=current&baseline_run=r1&baseline_episode=baseline');
  return { run, current, page: mount(SideBySidePage, {}) };
}

test('primary evaluation and trial links override a recipient tab remembering another site', () => {
  resetBrowser();
  const links = [siteHref('/evals/current'), trialEventUrl('run', 'trial'), comparisonUrl('run', 'trial', 'base', 'trial')];
  for (const link of links) {
    rememberSite('rtx');
    setLocation(link);
    assert.equal(currentSiteName(), 'b300');
    assert.equal(new URLSearchParams(window.location.search).get('site'), 'b300');
  }
  rememberSite('rtx');
  setLocation('/evals/current?site=b300#trials');
  assert.equal(currentSiteName(), 'b300');
  assert.equal(new URLSearchParams(window.location.search).get('site'), 'b300');
  assert.equal(window.location.hash, '#trials');
});

test('comparison reads late completion events through the replay grace period', async () => {
  const { current, page } = comparisonSetup('running');
  await advance(100);
  current.summary.status = 'ended';
  await advance(5200);
  current.events.push(ev('current', 2, 'api_call_end', { api_call_id: 'call', return: true }));
  await advance(2000);
  const props = propsOf<Parameters<typeof SideBySideComparison>[0]>(page.output, SideBySideComparison);
  assert.equal(props.current.model.events.length, 2);
  await advance(70_000);
  const before = requests(/episodes\/current\/events$/).sent;
  await advance(10_000);
  assert.equal(requests(/episodes\/current\/events$/).sent, before, 'grace polling eventually stops');
  page.unmount();
});

test('comparison polls pending video copies and refreshes once the copy finishes', async () => {
  const { current, page } = comparisonSetup('ended', true);
  await advance(100);
  current.events.push(ev('current', 2, 'api_call_end', { api_call_id: 'call', return: true }));
  current.summary.episode = { video_copy_pending: false };
  await advance(2200);
  const props = propsOf<Parameters<typeof SideBySideComparison>[0]>(page.output, SideBySideComparison);
  assert.equal(props.current.model.events.length, 2);
  assert.equal(props.current.summary.episode?.video_copy_pending, false);
  page.unmount();
});

test('comparison polls incomplete snapshots and permits refreshing loaded trials', async () => {
  const { current, page } = comparisonSetup('incomplete');
  await advance(100);
  current.events.push(ev('current', 2, 'api_call_end', { api_call_id: 'call', return: true }));
  current.summary.status = 'ended';
  await advance(21_000);
  let props = propsOf<Parameters<typeof SideBySideComparison>[0]>(page.output, SideBySideComparison);
  assert.equal(props.current.model.events.length, 2);
  await advance(70_000);
  current.events.push(ev('current', 3, 'stdout', { text: 'late' }));
  click(page.output, '更新');
  await advance(100);
  props = propsOf<Parameters<typeof SideBySideComparison>[0]>(page.output, SideBySideComparison);
  assert.equal(props.current.model.events.length, 3);
  page.unmount();
});

test('event paging cancels a stalled page and resumes at its last committed offset', async () => {
  resetBrowser();
  const run = makeRun();
  const episode = addEpisode(run, 'current', { status: 'running' }, [ev('current', 1, 'stdout', { text: 'first' })]);
  serve(run);
  let seen!: EpisodeEvents;
  const page = mount(() => { seen = useEpisodeEvents('r1', 'current', true); return null; }, {});
  await advance(100);
  run.latency.events = 10 * 60_000;
  seen.refresh();
  await advance(500);
  episode.events.push(ev('current', 2, 'stdout', { text: 'second' }));
  run.latency.events = 20;
  await advance(121_000);
  assert.equal(requests(/\/events$/).aborted, 1);
  assert.deepEqual(seen.events.map(event => event.event_id), ['current_1', 'current_2']);
  assert.ok(requests(/\/events$/).list.slice(1).every(request => request.query.get('after_offset') === '100' || request.query.get('after_offset') === '200'));
  page.unmount();
});

for (const simple of [false, true]) {
  test(`${simple ? 'simple' : 'local'} picker refresh reloads selected-run episodes and verdicts`, async () => {
    resetBrowser();
    const run = makeRun();
    const first = addEpisode(run, 'first', { status: 'ended', task: 'first', episode: { trial_outcome: { task_success: false } } }, []);
    serve(run);
    const handler = net.handler;
    net.handler = request => request.path === '/api/traces/runs'
      ? { json: { runs: [{ run_id: 'r1', n_episodes: run.episodes.size }] } } : handler(request);
    const page = simple ? mount(SimplePicker, { onPick: () => {}, onDetails: () => {} })
      : mount(Picker, { config: null, configError: null, currentRun: 'r1', currentEpisode: null,
        initialMode: 'traced', onPick: () => {}, onPickLegacy: () => {} });
    await advance(100);
    if (simple) {
      const selector = findAll(page.output, 'select').find(item => item.props['aria-label'] === '実験を選ぶ')!;
      (selector.props.onChange as (event: unknown) => void)({ target: { value: 'r1' } });
      await advance(100);
    }
    first.summary.episode = { trial_outcome: { task_success: true } };
    addEpisode(run, 'second', { status: 'ended', task: 'second' }, []);
    click(page.output, '一覧を更新');
    await advance(100);
    assert.equal(requests(/\/runs\/r1$/).sent, 2, simple ? 'simple detail reloads' : 'local detail reloads');
    assert.match(text(page.output), /second/);
    page.unmount();
  });
}

test('legacy picker refresh reloads the selected run without reselecting it', async () => {
  resetBrowser();
  let trials = [{ task: 'task', condition: 'C', trial_dir: 'first', task_completed: false }];
  net.handler = request => request.path === '/api/traces/legacy/runs'
    ? { json: { roots: [], runs: [{ run_id: 'old', root_index: 0, n_trials: trials.length }] } }
    : request.path === '/api/traces/legacy/runs/old' ? { json: { trials } } : null;
  const parent = mount(Picker, { config: null, configError: null, currentRun: null, currentEpisode: null,
    initialMode: 'legacy', onPick: () => {}, onPickLegacy: () => {} });
  await advance(100);
  const childElement = () => ((parent.output as FakeElement).props.children as FakeElement[])
    .find(element => element && typeof element.type === 'function' && 'runs' in element.props)!;
  const element = childElement();
  const child = mount(element.type as (props: Record<string, unknown>) => unknown, element.props);
  (findAll(child.output, 'button')[0].props.onClick as () => void)();
  await advance(100);
  assert.match(text(child.output), /first/);
  trials = [...trials, { task: 'task', condition: 'C', trial_dir: 'second', task_completed: true }];
  click(parent.output, '一覧を更新');
  await advance(100);
  child.update(childElement().props);
  await advance(100);
  assert.equal(requests(/\/legacy\/runs\/old$/).sent, 2);
  assert.match(text(child.output), /second/);
  child.unmount();
  parent.unmount();
});

test('event paging ignores abandoned results even when the transport ignores cancellation', async () => {
  resetBrowser();
  let resolveAbandoned!: (page: EventsPage) => void;
  let signal: AbortSignal | undefined;
  let count = 0;
  const pager = new EventsPager((offset, _generation, requestSignal?: AbortSignal) => {
    count += 1;
    if (count === 2) {
      signal = requestSignal;
      return new Promise(resolve => { resolveAbandoned = resolve; });
    }
    return Promise.resolve({ events: [ev('current', count === 1 ? 1 : 2, 'stdout', {})],
      next_offset: offset + 100, eof: true, generation: 'g1' });
  }, () => {});
  await pager.pump();
  const abandoned = pager.pump();
  await advance(60_001);
  assert.match(pager.snapshot.error ?? '', /タイムアウト/);
  assert.equal(signal?.aborted, true);
  await abandoned;
  await pager.pump();
  resolveAbandoned({ events: [ev('current', 99, 'stdout', {})], next_offset: 9900, eof: true, generation: 'stale' });
  await advance(0);
  assert.deepEqual(pager.snapshot.events.map(event => event.event_id), ['current_1', 'current_2']);
  assert.equal(pager.snapshot.nextOffset, 200);
  assert.equal(pager.snapshot.generation, 'g1');
  pager.dispose();
});
