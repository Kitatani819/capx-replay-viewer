import { advance, currentParams, findAll, net, propsOf, resetBrowser, setLocation, type FakeElement } from './harness/browser';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from './harness/fakeReact';
import TraceViewerPage from '../TraceViewerPage';
import { TrialSummary, TrialSummaryCard } from '../components/TrialSummary';
import { buildEpisodeModel } from '../model';
import type { EvalDetail, EvalTrial } from '../../evals/api';
import type { EpisodeSummary } from '../types';
import { addEpisode, ev, makeRun, serve } from './pageServer';

const ep = { runId: 'current', episodeId: 'trial' };
const summary: EpisodeSummary = { episode_id: 'trial', status: 'ended', task: 'cube', condition: 'C', seed: 7 };
function text(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return node && typeof node === 'object' && 'props' in node ? text((node as FakeElement).props.children) : '';
}

test('summary event link selects that event, with ordinary anchor modifier behavior', () => {
  resetBrowser();
  let selected: string | null = null;
  const error = ev('trial', 1, 'api_call_error', { name: 'move', message: 'failed' }, { status: 'error' });
  const page = mount(TrialSummaryCard, { ep, model: buildEpisodeModel([error]), summary, verdict: 'failure' as const, onJump: (id: string) => { selected = id; } });
  const link = findAll(page.output, 'a').find(anchor => text(anchor) === 'ログで見る');
  assert.ok(link);
  assert.equal(link!.props.href, '/traces?run=current&episode=trial&event=trial_1');
  let prevented = false;
  const click = link!.props.onClick as (event: { button: number; ctrlKey?: boolean; preventDefault: () => void }) => void;
  click({ button: 0, ctrlKey: true, preventDefault: () => { prevented = true; } });
  assert.equal(selected, null);
  click({ button: 0, preventDefault: () => { prevented = true; } });
  assert.equal(selected, 'trial_1');
  assert.equal(prevented, true);
  page.unmount();
});

test('trial page shows summary for trace only, and its jump updates event and detailed view', async () => {
  resetBrowser();
  const run = makeRun('current');
  addEpisode(run, 'trial', summary, [ev('trial', 1, 'episode_start', { task: 'cube' }), ev('trial', 2, 'episode_end', {})]);
  serve(run); setLocation('/traces?run=current&episode=trial&view=simple');
  const page = mount(TraceViewerPage, {}); await advance(100);
  const props = propsOf<Parameters<typeof TrialSummary>[0]>(page.output, TrialSummary);
  props.onJump('trial_2'); await advance(0);
  assert.equal(currentParams().get('event'), 'trial_2');
  assert.equal(currentParams().get('view'), 'details');
  page.unmount();
  setLocation('/traces?legacy_run=old&legacy_trial=cube/C/trial');
  const legacy = mount(TraceViewerPage, {}); await advance(50);
  assert.equal(findAll(legacy.output, TrialSummary).length, 0);
  legacy.unmount();
});

test('paired baseline uses existing per-episode GMO import and then its last frame', async () => {
  resetBrowser();
  const baseline = makeRun('baseline'); serve(baseline); const traceHandler = net.handler;
  const trial: EvalTrial = { episode_id: 'base_trial', task: 'cube', condition: 'C', seed: 7, attempt: 0, verdict: 'success', status: 'ended', trace_complete: true, local_state: 'remote' };
  const detail = { baseline: { eval_id: 'baseline' }, trials: [], baseline_trials: [trial] } as unknown as EvalDetail;
  let complete = false;
  net.handler = req => {
    if (req.path === '/api/evals/current') return { json: detail };
    if (req.path === '/api/gmo/config') return { json: { enabled: true, configured: true } };
    if (req.path === '/api/gmo/episodes') return { json: [{ run_id: 'baseline', episode_id: 'base_trial', size_bytes: 2048, conflict: false }] };
    if (req.path === '/api/gmo/fetch') return { json: { job_id: 'base_job' } };
    if (req.path === '/api/gmo/jobs') return { json: [{ job_id: 'base_job', run_id: 'baseline', episode_id: 'base_trial', state: complete ? 'done' : 'running' }] };
    return traceHandler(req);
  };
  const page = mount(TrialSummary, { ep, summary, model: buildEpisodeModel([]), runnerRecords: [], onJump: () => {} });
  await advance(100);
  let props = propsOf<Parameters<typeof TrialSummaryCard>[0]>(page.output, TrialSummaryCard);
  assert.equal(props.baseline?.trial.episode_id, 'base_trial');
  assert.equal(props.baseline?.frame, null);
  assert.match(text(props.footer), /GMOから取り込み中/);
  complete = true;
  addEpisode(baseline, 'base_trial', { ...summary, episode_id: 'base_trial' }, [ev('base_trial', 1, 'frame', {}, { artifacts: [{ path: 'frames/base.png', mime: 'image/png' }] })]);
  await advance(1500);
  props = propsOf<Parameters<typeof TrialSummaryCard>[0]>(page.output, TrialSummaryCard);
  assert.equal(props.baseline?.frame?.path, 'frames/base.png');
  assert.equal(net.log.filter(req => req.path === '/api/gmo/fetch').length, 1);
  assert.ok(!net.log.some(req => req.path.includes('unrelated')));
  page.unmount();
});
