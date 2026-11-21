import { advance, findAll, net, propsOf, requests, resetBrowser, setLocation, type FakeElement } from './harness/browser';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from './harness/fakeReact';
import { buildEpisodeModel } from '../model';
import type { TextValue } from '../types';
import SideBySidePage, { SideBySideComparison, type TrialComparisonData } from '../SideBySidePage';
import { alignComparisonCalls, comparisonCalls } from '../sideBySide';
import { Breadcrumb } from '../../navigation/Breadcrumb';
import { breakdownDetail } from './failureBreakdownFixtures';
import { addEpisode, ev, makeRun, serve } from './pageServer';

function text(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (typeof node === 'object' && 'props' in node) return text((node as FakeElement).props.children);
  return '';
}
function events(ep: string, changed: boolean) {
  return [ev(ep, 1, 'api_call_start', { api_call_id: 'a', name: 'observe', turn_index: 0 }),
    ev(ep, 2, 'api_call_end', { api_call_id: 'a', return: true }),
    ev(ep, 3, 'api_call_start', { api_call_id: 'b', name: 'move', turn_index: 0, args: { z: changed ? 0.9 : 0.8 } }),
    ev(ep, 4, 'api_call_end', { api_call_id: 'b', return: true }),
  ];
}
function trial(ep: string, changed: boolean): TrialComparisonData {
  return { ref: { runId: 'eval', episodeId: ep }, summary: { episode_id: ep, task: 'cube', seed: 7, status: 'ended' },
    model: buildEpisodeModel(events(ep, changed)), records: [] };
}
test('the difference switch hides equal rows while retaining the first-difference mark', async () => {
  resetBrowser();
  const page = mount(SideBySideComparison, { baseline: trial('baseline', false), current: trial('current', true) });
  assert.equal(findAll(page.output, 'section').length, 2);
  assert.equal(findAll(page.output, 'button')[0].props['aria-checked'], false);
  (findAll(page.output, 'button')[0].props.onClick as () => void)();
  await advance(0);
  assert.equal(findAll(page.output, 'button')[0].props['aria-checked'], true);
  assert.equal(findAll(page.output, 'section').length, 1);
  assert.equal(findAll(page.output, 'section')[0].props['data-first-difference'], true);
  assert.match(text(page.output), /ここから違う/);
  assert.match(text(page.output), /基準「\{"z":0.8\}」 \/ 今回「\{"z":0.9\}」/);
  (findAll(page.output, 'button')[0].props.onClick as () => void)();
  await advance(0);
  assert.equal(findAll(page.output, 'section').length, 2);
  page.unmount();
});
test('the comparison route reads both requested episodes and falls back to run breadcrumbs without an evaluation', async () => {
  resetBrowser();
  const run = makeRun('eval');
  addEpisode(run, 'baseline', { task: 'cube', seed: 7, status: 'ended' }, events('baseline', false));
  addEpisode(run, 'current', { task: 'cube', seed: 7, status: 'ended' }, events('current', true));
  serve(run);
  setLocation('/traces/compare?run=eval&episode=current&baseline_run=eval&baseline_episode=baseline');
  const page = mount(SideBySidePage, {});
  await advance(100);
  const props = propsOf<Parameters<typeof SideBySideComparison>[0]>(page.output, SideBySideComparison);
  assert.equal(props.baseline.ref.episodeId, 'baseline');
  assert.equal(props.current.ref.episodeId, 'current');
  assert.equal(props.current.model.events.length, 4);
  const crumbs = propsOf<Parameters<typeof Breadcrumb>[0]>(page.output, Breadcrumb);
  assert.deepEqual(crumbs.items.map(item => item.label), ['評価一覧', '試行を選ぶ', 'eval', 'cube · seed 7', '基準と並べて比べる']);
  const breadcrumb = mount(Breadcrumb, crumbs);
  assert.equal(findAll(breadcrumb.output, 'nav')[0].props['aria-label'], '現在の場所');
  assert.deepEqual(findAll(breadcrumb.output, 'a').map(link => link.props.href), ['/evals?site=b300', '/traces?site=b300', '/traces?run=eval&site=b300', '/traces?run=eval&episode=current&site=b300']);
  const currentPage = findAll(breadcrumb.output, 'span').find(item => item.props['aria-current'] === 'page');
  assert.equal(text(currentPage), '基準と並べて比べる');
  assert.doesNotMatch(text(page.output), /← 試行の要約へ戻る|評価の一覧/);
  assert.equal(findAll(page.output, 'nav').length, 0, 'no separate back-link navigation remains');
  breadcrumb.unmount();
  page.unmount();
});
test('comparison breadcrumbs link through the current evaluation and current trial', async () => {
  resetBrowser();
  const run = makeRun('eval');
  addEpisode(run, 'baseline', { task: 'cube', seed: 7, status: 'ended' }, events('baseline', false));
  addEpisode(run, 'current', { task: 'cube', seed: 7, status: 'ended' }, events('current', true));
  serve(run);
  const traceHandler = net.handler;
  const detail = breakdownDetail();
  detail.eval = { ...detail.eval!, eval_id: 'eval', changed: '把持位置の修正' };
  net.handler = request => request.path === '/api/evals/eval' ? { json: detail } : traceHandler(request);
  setLocation('/traces/compare?run=eval&episode=current&baseline_run=eval&baseline_episode=baseline');
  const page = mount(SideBySidePage, {});
  await advance(100);
  const crumbs = propsOf<Parameters<typeof Breadcrumb>[0]>(page.output, Breadcrumb);
  assert.deepEqual(crumbs.items.map(item => item.label), ['評価一覧', '把持位置の修正', 'cube · seed 7', '基準と並べて比べる']);
  const breadcrumb = mount(Breadcrumb, crumbs);
  assert.deepEqual(findAll(breadcrumb.output, 'a').map(link => link.props.href), ['/evals?site=b300', '/evals/eval?site=b300', '/traces?run=eval&episode=current&site=b300']);
  assert.deepEqual(findAll(breadcrumb.output, 'span').filter(item => item.props['aria-current'] === 'page').map(text), ['基準と並べて比べる']);
  assert.doesNotMatch(text(page.output), /← 試行の要約へ戻る|評価の一覧/);
  breadcrumb.unmount();
  page.unmount();
});
test('missing baseline uses the existing GMO importer and resumes the comparison', async () => {
  resetBrowser();
  const run = makeRun('eval');
  addEpisode(run, 'current', { task: 'cube', seed: 7, status: 'ended' }, events('current', true));
  serve(run);
  const traceHandler = net.handler;
  let fetched = 0;
  net.handler = request => {
    if (request.path === '/api/gmo/config') return { json: { enabled: true, configured: true } };
    if (request.path === '/api/gmo/episode') return { json: { run_id: 'eval', episode_id: 'baseline', size_bytes: 500, conflict: false } };
    if (request.path === '/api/gmo/fetch') { fetched++; return { json: { job_id: 'import' } }; }
    if (request.path === '/api/gmo/jobs') {
      addEpisode(run, 'baseline', { task: 'cube', seed: 7, status: 'ended' }, events('baseline', false));
      return { json: [{ job_id: 'import', run_id: 'eval', episode_id: 'baseline', state: 'done' }] };
    }
    return traceHandler(request);
  };
  setLocation('/traces/compare?run=eval&episode=current&baseline_run=eval&baseline_episode=baseline');
  const page = mount(SideBySidePage, {});
  await advance(300);
  assert.equal(fetched, 1);
  assert.equal(propsOf<Parameters<typeof SideBySideComparison>[0]>(page.output, SideBySideComparison).baseline.ref.episodeId, 'baseline');
  page.unmount();
});
test('stored model request messages remain available without causing a behavioral difference', async () => {
  resetBrowser();
  const run = makeRun('eval');
  for (const [episodeId, instruction] of [['baseline', 'Move to z=0.8'], ['current', 'Move to z=0.9']]) {
    const request = ev(episodeId, 1, 'model_request', { role: 'code_generator', call_kind: 'initial_code', turn_index: 0,
      logical_call_id: 'logical', http_attempt: 1, n_messages: 1, payload_path: 'payloads/request.json' });
    const response = ev(episodeId, 2, 'model_response', { logical_call_id: 'logical', http_attempt: 1, http_status: 200, content: 'ok' }, { parent_event_id: request.event_id });
    const episode = addEpisode(run, episodeId, { task: 'cube', seed: 7, status: 'ended' }, [request, response]);
    episode.files.set('payloads/request.json', { json: { messages: [{ role: 'user', content: instruction }] } });
  }
  serve(run);
  setLocation('/traces/compare?run=eval&episode=current&baseline_run=eval&baseline_episode=baseline');
  const page = mount(SideBySidePage, {});
  await advance(150);
  const props = propsOf<Parameters<typeof SideBySideComparison>[0]>(page.output, SideBySideComparison);
  const baselineCalls = comparisonCalls(props.baseline.model, props.baseline.requestArguments);
  const currentCalls = comparisonCalls(props.current.model, props.current.requestArguments);
  assert.match(baselineCalls[0].arguments, /Move to z=0.8/);
  assert.match(currentCalls[0].arguments, /Move to z=0.9/);
  assert.equal(alignComparisonCalls(baselineCalls, currentCalls)[0].firstDifference, false);
  assert.equal(alignComparisonCalls(baselineCalls, currentCalls)[0].modelTextDifferent, true);
  page.unmount();
});

test('compact rows expand both complete sides and preserve event links', async () => {
  resetBrowser();
  const fullArguments = `prompt ${'long argument '.repeat(30)}END_ARGUMENT`;
  const fullResult = `result ${'long result '.repeat(30)}END_RESULT`;
  const makeTrial = (ep: string): TrialComparisonData => ({ ...trial(ep, false), model: buildEpisodeModel([
    ev(ep, 1, 'api_call_start', { api_call_id: 'a', name: 'inspect', args: fullArguments, turn_index: 0 }),
    ev(ep, 2, 'api_call_end', { api_call_id: 'a', return: fullResult }),
  ]) });
  const page = mount(SideBySideComparison, { baseline: makeTrial('baseline'), current: makeTrial('current') });
  const rowButton = () => findAll(page.output, 'button').find(button => button.props.className === 'comparison-row-toggle')!;
  assert.equal(rowButton().props['aria-expanded'], false);
  assert.equal(findAll(page.output, 'pre').length, 0);
  assert.ok(!text(page.output).includes('END_ARGUMENT'));
  assert.ok(!text(page.output).includes('END_RESULT'));
  assert.match(text(rowButton()), /prompt long argument/);
  assert.match(text(rowButton()), /…/);
  assert.equal(findAll(rowButton(), 'span').filter(span => span.props.className === 'comparison-call').length, 2);
  (rowButton().props.onClick as () => void)();
  await advance(0);
  assert.equal(rowButton().props['aria-expanded'], true);
  assert.equal(findAll(page.output, 'div').find(div => div.props.id === rowButton().props['aria-controls'])?.props.hidden, false);
  assert.equal(findAll(page.output, 'pre').filter(pre => text(pre) === fullArguments).length, 2);
  assert.equal(findAll(page.output, 'pre').filter(pre => text(pre) === fullResult).length, 2);
  for (const ep of ['baseline', 'current']) {
    assert.ok(findAll(page.output, 'a').some(link => link.props.href === `/traces?run=eval&episode=${ep}&event=${ep}_1&site=b300`));
  }
  (rowButton().props.onClick as () => void)();
  await advance(0);
  assert.equal(rowButton().props['aria-expanded'], false);
  assert.equal(findAll(page.output, 'pre').length, 0);
  page.unmount();
});

test('model text switch is off by default and works with the different-rows filter', async () => {
  resetBrowser();
  const makeTrial = (ep: string): TrialComparisonData => {
    const request = ev(ep, 1, 'model_request', { role: 'vdm', call_kind: 'initial_scene_description', turn_index: 0,
      logical_call_id: 'logical', http_attempt: 1, prompt: `private prompt ${ep}` });
    const response = ev(ep, 2, 'model_response', { logical_call_id: 'logical', http_attempt: 1, http_status: 200,
      content: `generated description ${ep}` }, { parent_event_id: request.event_id });
    return { ...trial(ep, false), model: buildEpisodeModel([request, response]) };
  };
  const page = mount(SideBySideComparison, { baseline: makeTrial('baseline'), current: makeTrial('current') });
  const switches = () => findAll(page.output, 'button').filter(button => button.props.role === 'switch');
  assert.equal(switches().length, 2);
  assert.equal(switches()[1].props['aria-checked'], false);
  assert.match(text(switches()[1]), /モデルの文章の違いも表示/);
  assert.match(text(page.output), /API の呼び出しと判断は同じです（モデルの文章だけが違います）/);
  assert.equal(findAll(page.output, 'section').length, 1);
  assert.match(text(findAll(page.output, 'section')[0]), /同じ/);
  assert.ok(!text(page.output).includes('private prompt'));
  assert.ok(!text(page.output).includes('generated description'));
  assert.ok(!text(page.output).includes('ここから違う'));
  (switches()[0].props.onClick as () => void)();
  await advance(0);
  assert.equal(findAll(page.output, 'section').length, 0);
  (switches()[1].props.onClick as () => void)();
  await advance(0);
  assert.equal(switches()[1].props['aria-checked'], true);
  assert.equal(findAll(page.output, 'section').length, 1);
  assert.match(text(findAll(page.output, 'section')[0]), /違い/);
  assert.ok(!text(page.output).includes('ここから違う'));
  assert.match(text(page.output), /API の呼び出しと判断は同じです（モデルの文章だけが違います）/);
  (switches()[1].props.onClick as () => void)();
  await advance(0);
  assert.equal(findAll(page.output, 'section').length, 0);
  page.unmount();
});

test('equal calls show the all-same banner', () => {
  resetBrowser();
  const page = mount(SideBySideComparison, { baseline: trial('baseline', false), current: trial('current', false) });
  const status = findAll(page.output, 'p').find(item => item.props.role === 'status');
  assert.equal(text(status), 'API の呼び出しと判断は同じです');
  assert.ok(!text(page.output).includes('ここから違う'));
  page.unmount();
});

test('expanded model, API and service text assets load complete text only when opened', async () => {
  resetBrowser();
  const run = makeRun('stored-text');
  const fullTexts: string[] = [];
  const makeTrial = (ep: string): TrialComparisonData => {
    const descriptor = (kind: string) => ({ preview: `${kind} preview`, asset: `assets/full-${kind}.txt.gz`, truncated: true, length: 100 });
    const request = ev(ep, 1, 'model_request', { role: 'vdm', call_kind: 'initial_scene_description', turn_index: 0,
      logical_call_id: 'logical', http_attempt: 1 });
    const recorded = [request,
      ev(ep, 2, 'model_response', { logical_call_id: 'logical', http_attempt: 1, http_status: 200, content: descriptor('model') }, { parent_event_id: request.event_id }),
      ev(ep, 3, 'api_call_start', { api_call_id: 'a', name: 'inspect', turn_index: 0 }),
      ev(ep, 4, 'api_call_end', { api_call_id: 'a', message: descriptor('api') }, { status: 'error' }),
      ev(ep, 5, 'service_call_start', { service_call_id: 's', service: 'solver', function: 'inspect', turn_index: 0 }),
      ev(ep, 6, 'service_call_end', { service_call_id: 's', message: descriptor('service') }, { status: 'error' }),
    ];
    const episode = addEpisode(run, ep, { task: 'cube', seed: 7, status: 'ended' }, recorded);
    for (const kind of ['model', 'api', 'service']) {
      const full = `Complete ${kind} stored output for ${ep}, including text beyond its preview.`;
      episode.files.set(`assets/full-${kind}.txt.gz`, { text: full });
      fullTexts.push(full);
    }
    return { ref: { runId: run.runId, episodeId: ep }, summary: episode.summary, model: buildEpisodeModel(recorded), records: [] };
  };
  const baseline = makeTrial('baseline'), current = makeTrial('current');
  serve(run);
  const page = mount(SideBySideComparison, { baseline, current });
  await advance(20);
  const reads = () => requests(/\/file\/assets\/full-/);
  assert.equal(reads().sent, 0);
  for (const button of findAll(page.output, 'button').filter(item => item.props.className === 'comparison-row-toggle')) {
    (button.props.onClick as () => void)();
  }
  await advance(0);
  // The page harness does not render child components; mount the disclosed text renderers explicitly.
  const disclosed = findAll(page.output, 'dd').map(dd => dd.props.children as FakeElement).filter(child => typeof child.type === 'function');
  assert.equal(disclosed.length, 6, 'both sides disclose model, API and service stored text');
  const children = disclosed.map(child => mount(child.type as (props: { trial: TrialComparisonData; value: TextValue }) => unknown,
    child.props as { trial: TrialComparisonData; value: TextValue }));
  await advance(20);
  assert.equal(reads().sent, 6);
  assert.deepEqual(children.map(child => text(child.output)).sort(), fullTexts.sort());
  children.forEach(child => child.unmount());
  page.unmount();
});

test('the comparison route loads code-block data assets before exposing full code and results', async () => {
  resetBrowser();
  const run = makeRun('stored-code');
  for (const ep of ['baseline', 'current']) {
    const recorded = [
      ev(ep, 1, 'code_block_start', { code_block_id: 'block', turn_index: 0, oversize: true,
        data_asset: 'assets/code-start.json.gz', data_asset_written: true }),
      ev(ep, 2, 'code_block_end', { code_block_id: 'block', oversize: true,
        data_asset: 'assets/code-end.json.gz', data_asset_written: true }),
    ];
    const episode = addEpisode(run, ep, { task: 'cube', seed: 7, status: 'ended' }, recorded);
    episode.files.set('assets/code-start.json.gz', { json: { code_block_id: 'block', turn_index: 0, code: `print("complete ${ep} code")` } });
    episode.files.set('assets/code-end.json.gz', { json: { code_block_id: 'block', sandbox_rc: 0, stdout_len: 45, stderr_len: 0 } });
  }
  serve(run);
  setLocation('/traces/compare?run=stored-code&episode=current&baseline_run=stored-code&baseline_episode=baseline');
  const page = mount(SideBySidePage, {});
  await advance(150);
  const comparison = propsOf<Parameters<typeof SideBySideComparison>[0]>(page.output, SideBySideComparison);
  assert.equal(requests(/\/file\/assets\/code-(?:start|end)\.json\.gz$/).sent, 4);
  for (const [side, ep] of [[comparison.baseline, 'baseline'], [comparison.current, 'current']] as const) {
    const calls = comparisonCalls(side.model);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, 'code');
    assert.equal(calls[0].arguments, `print("complete ${ep} code")`);
    assert.match(calls[0].returned, /"stdout_len": 45/);
  }
  page.unmount();
});
