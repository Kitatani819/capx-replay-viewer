import { advance, currentParams, findAll, net, popState, propsOf, resetBrowser, setLocation, type FakeElement } from './harness/browser';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from './harness/fakeReact';
import TraceViewerPage from '../TraceViewerPage';
import { TopBar } from '../components/TopBar';
import { Breadcrumb } from '../../navigation/Breadcrumb';
import type { EvalDetail, EvalRecord, EvalTrial } from '../../evals/api';
import { addEpisode, ev, makeRun, serve } from './pageServer';

type CrumbProps = Parameters<typeof Breadcrumb>[0];
type BarProps = Parameters<typeof TopBar>[0];

function text(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return node && typeof node === 'object' && 'props' in node ? text((node as FakeElement).props.children) : '';
}

function record(id: string, baseline: string | null): EvalRecord {
  return { schema: 'capx-eval/1', eval_id: id, status: 'completed', by: 'alice', changed: baseline ? '把持位置の修正' : '',
    baseline_eval_id: baseline, eval_set: null, git: null, started_at: '', heartbeat_at: '', ended_at: null, summary: null };
}
function trial(id: string, seed = 7): EvalTrial {
  return { episode_id: id, task: 'cube', condition: 'C', seed, attempt: 1, verdict: 'success', status: 'ended', trace_complete: true, local_state: 'local' };
}
function detail(): EvalDetail {
  return { eval_id: 'current', eval: record('current', 'baseline'), baseline: record('baseline', null), error: null,
    location: 'local', display_status: null, summary: null, baseline_summary: null, baseline_error: null,
    trials: [trial('trial')], baseline_trials: [trial('base_trial')], differences: [] };
}
function setup(evaluation: EvalDetail | null = detail()) {
  resetBrowser();
  const run = makeRun('current');
  const key = { task: 'cube', condition: 'C', seed: 7 };
  addEpisode(run, 'trial', { ...key, status: 'ended', trace_complete: true }, [
    ev('trial', 1, 'episode_start', key), ev('trial', 2, 'episode_end', {}),
  ]);
  serve(run);
  const traceHandler = net.handler;
  net.handler = req => req.path === '/api/evals/current'
    ? evaluation ? { json: evaluation } : { status: 404, json: { detail: 'evaluation not found' } }
    : traceHandler(req);
  setLocation('/traces?run=current&episode=trial&event=trial_2');
  return { run };
}

test('trial breadcrumb links back to its evaluation, preserving an event deep link and exposing top-bar comparison', async () => {
  setup();
  const page = mount(TraceViewerPage, {}); await advance(100);
  const crumbs = propsOf<CrumbProps>(page.output, Breadcrumb);
  assert.deepEqual(crumbs.items, [
    { label: '評価一覧', href: '/evals' },
    { label: '把持位置の修正', href: '/evals/current' },
    { label: 'cube · seed 7' },
  ]);
  const navigation = mount(Breadcrumb, crumbs);
  assert.equal(findAll(navigation.output, 'nav')[0].props['aria-label'], '現在の場所');
  assert.equal(findAll(navigation.output, 'a').find(a => text(a) === '把持位置の修正')?.props.href, '/evals/current?site=b300');
  assert.equal(findAll(navigation.output, 'span').filter(span => span.props['aria-current'] === 'page').length, 1);
  navigation.unmount();
  const bar = mount(TopBar, propsOf<BarProps>(page.output, TopBar));
  const compare = findAll(bar.output, 'a').find(a => text(a) === '基準と並べて比べる');
  assert.ok(compare);
  assert.equal(compare!.props.href, '/traces/compare?run=current&episode=trial&baseline_run=baseline&baseline_episode=base_trial&site=b300');
  assert.equal(findAll(bar.output, 'a').filter(a => a.props.href === '/evals?site=b300').length, 0);
  assert.ok(findAll(bar.output, 'button').some(button => text(button).startsWith('別の試行を選ぶ')));
  assert.doesNotMatch(text(bar.output), /試行 7 を変更/);
  assert.equal(currentParams().get('event'), 'trial_2');
  bar.unmount(); page.unmount();
});

test('non-evaluation trial uses picker/run ancestors and hides the baseline action', async () => {
  setup(null);
  const page = mount(TraceViewerPage, {}); await advance(100);
  const crumbs = propsOf<CrumbProps>(page.output, Breadcrumb);
  assert.deepEqual(crumbs.items, [
    { label: '試行を選ぶ', href: '/traces' },
    { label: 'current', href: '/traces?run=current' },
    { label: 'cube · seed 7' },
  ]);
  const bar = mount(TopBar, propsOf<BarProps>(page.output, TopBar));
  assert.ok(!findAll(bar.output, 'a').some(a => text(a) === '基準と並べて比べる'));
  bar.unmount(); page.unmount();
});

test('trial with a different task/seed baseline does not offer an unrelated comparison', async () => {
  const evaluation = detail(); evaluation.baseline_trials = [trial('other_seed', 8)];
  setup(evaluation);
  const page = mount(TraceViewerPage, {}); await advance(100);
  assert.ok(!propsOf<BarProps>(page.output, TopBar).compareHref);
  page.unmount();
});

test('simple trial view shares its breadcrumb and baseline comparison action', async () => {
  setup(); setLocation('/traces?run=current&episode=trial&view=simple');
  const page = mount(TraceViewerPage, {}); await advance(100);
  assert.equal(propsOf<CrumbProps>(page.output, Breadcrumb).items[1].href, '/evals/current');
  assert.ok(findAll(page.output, 'a').some(a => text(a) === '基準と並べて比べる'));
  assert.ok(!findAll(page.output, 'a').some(a => a.props.href === '/evals?site=b300'));
  assert.ok(findAll(page.output, 'button').some(button => text(button).startsWith('別の試行を選ぶ')));
  page.unmount();
});

test('legacy trial uses the shared picker/run breadcrumb and does not invent an evaluation', async () => {
  resetBrowser(); setLocation('/traces?legacy_run=old&legacy_trial=cube/C/trial_7');
  const page = mount(TraceViewerPage, {}); await advance(100);
  const items = propsOf<CrumbProps>(page.output, Breadcrumb).items;
  assert.deepEqual(items[0], { label: '試行を選ぶ', href: '/traces' });
  assert.equal(items[1].label, 'old');
  assert.equal(new URL(items[1].href!, 'http://localhost').searchParams.get('legacy_run'), 'old');
  assert.match(items[2].label, /cube/);
  assert.match(items[2].label, /trial_7/);
  assert.ok(!items.some(item => item.href?.startsWith('/evals')));
  page.unmount();
});

test('picker screen has one shared current-page crumb', async () => {
  resetBrowser(); const page = mount(TraceViewerPage, {}); await advance(100);
  assert.deepEqual(propsOf<CrumbProps>(page.output, Breadcrumb).items, [{ label: '試行を選ぶ' }]);
  page.unmount();
});

test('switching runs drops the previous evaluation title and baseline action while metadata is pending', async () => {
  setup(); const initialHandler = net.handler;
  const other = makeRun('other');
  addEpisode(other, 'other_trial', { status: 'ended', task: 'drawer', seed: 0 }, [ev('other_trial', 1, 'episode_start', { task: 'drawer', seed: 0 })]);
  serve(other); const otherHandler = net.handler;
  net.handler = req => req.path === '/api/evals/other'
    ? { status: 404, json: { detail: 'evaluation not found' }, latency: 500 }
    : initialHandler(req) ?? otherHandler(req);
  const page = mount(TraceViewerPage, {}); await advance(100);
  assert.equal(propsOf<CrumbProps>(page.output, Breadcrumb).items[1].label, '把持位置の修正');
  assert.ok(propsOf<BarProps>(page.output, TopBar).compareHref);
  popState('/traces?run=other&episode=other_trial'); await advance(100);
  const pendingItems = propsOf<CrumbProps>(page.output, Breadcrumb).items;
  assert.ok(!pendingItems.some(item => item.label === '把持位置の修正'));
  assert.ok(!propsOf<BarProps>(page.output, TopBar).compareHref);
  await advance(500);
  const items = propsOf<CrumbProps>(page.output, Breadcrumb).items;
  assert.equal(items[1].label, 'other');
  assert.deepEqual(items[2], { label: 'drawer · seed 0' });
  page.unmount();
});
