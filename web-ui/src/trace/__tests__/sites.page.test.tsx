import { advance, currentParams, findAll, net, propsOf, resetBrowser, setLocation } from './harness/browser';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from './harness/fakeReact';
import { apiRoot, currentSiteName, rememberSite, SITE_STORAGE_KEY, siteHref, siteSwitchTarget, type Site } from '../../navigation/site';
import { SiteTabs, SiteTabsControl } from '../../navigation/SiteTabs';
import { Breadcrumb } from '../../navigation/Breadcrumb';
import { EvalDetailPage, EvalListPage, EvalListTable } from '../../evals/EvalPages';
import { FailureBreakdown } from '../../evals/FailureBreakdown';
import TraceViewerPage from '../TraceViewerPage';
import { evalApi } from '../../evals/api';
import { episodeArrayImageUrl, episodeFileUrl, gmoApi, traceApi } from '../api';
import { comparisonUrl, trialEventUrl } from '../sideBySide';
import { useUrlParams } from '../hooks';
import { breakdownDetail } from './failureBreakdownFixtures';

const sites: Site[] = [{ name: 'b300', label: 'B300', primary: true }, { name: 'rtx', label: 'RTX', primary: false }];

test('site API root defaults to primary and restores session selection into shareable URLs', () => {
  resetBrowser();
  assert.equal(apiRoot(), '/api');
  setLocation('/evals/ev?site=rtx#trial');
  assert.equal(apiRoot(), '/api/sites/rtx');
  assert.equal(window.sessionStorage.getItem(SITE_STORAGE_KEY), 'rtx');
  setLocation('/evals/other?refresh=1#seed');
  assert.equal(currentSiteName(), 'rtx');
  assert.equal(window.location.search, '?refresh=1&site=rtx');
  assert.equal(window.location.hash, '#seed');
  setLocation('/evals?site=b300');
  assert.equal(apiRoot(), '/api');
  assert.equal(window.location.search, '?site=b300');
  setLocation('/traces');
  assert.equal(currentSiteName(), 'b300');
});

test('site selection handles blocked storage and rejects malformed names', () => {
  resetBrowser();
  const descriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage')!;
  Object.defineProperty(window, 'sessionStorage', { configurable: true, get: () => { throw new Error('blocked'); } });
  try {
    setLocation('/evals?site=rtx');
    assert.equal(apiRoot(), '/api/sites/rtx');
    setLocation('/evals?site=../private');
    assert.equal(currentSiteName(), 'b300');
    assert.equal(currentParams().get('site'), 'b300');
  } finally { Object.defineProperty(window, 'sessionStorage', descriptor); }
});

test('another browser tab has its own remembered site', () => {
  resetBrowser(); setLocation('/evals?site=rtx'); currentSiteName();
  const descriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage')!;
  const separate = new Map<string, string>();
  Object.defineProperty(window, 'sessionStorage', { configurable: true, value: {
    getItem: (key: string) => separate.get(key) ?? null,
    setItem: (key: string, value: string) => separate.set(key, value),
  } });
  try {
    setLocation('/evals');
    assert.equal(currentSiteName(), 'b300');
  } finally { Object.defineProperty(window, 'sessionStorage', descriptor); }
  setLocation('/evals');
  assert.equal(currentSiteName(), 'rtx');
  assert.equal(currentParams().get('site'), 'rtx');
});

test('site tabs disappear for one site and link to another site without carrying detail IDs', () => {
  resetBrowser();
  setLocation('/evals/current?site=rtx');
  const single = mount(SiteTabsControl, { sites: sites.slice(0, 1), pathname: '/evals', current: 'b300' });
  assert.equal(single.output, null); single.unmount();
  const tabs = mount(SiteTabsControl, { sites, pathname: '/evals/current', current: 'rtx' });
  const links = findAll(tabs.output, 'a');
  assert.deepEqual(links.map(link => [link.props.children, link.props.href, link.props['aria-current']]),
    [['B300', '/evals?site=b300', undefined], ['RTX', '/evals?site=rtx', 'page']]);
  assert.equal(siteSwitchTarget(sites[1], '/evals'), '/evals?site=rtx');
  setLocation('/traces?run=current&episode=trial&site=rtx');
  assert.equal(siteSwitchTarget(sites[0], '/traces'), '/evals?site=b300');
  assert.equal(siteSwitchTarget(sites[1], '/traces/compare'), '/evals?site=rtx');
  (links[0].props.onClick as () => void)();
  setLocation(String(links[0].props.href));
  assert.equal(apiRoot(), '/api');
  tabs.unmount();
});

test('a removed remembered site recovers to the primary evaluation list and fresh data', async () => {
  resetBrowser(); rememberSite('rtx'); setLocation('/evals/old-evaluation');
  net.handler = req => req.path === '/api/sites' ? { json: sites.slice(0, 1) }
    : req.path === '/api/evals' ? { json: { evals: [] } } : null;
  const tabs = mount(SiteTabs, {});
  await advance(10);
  assert.equal(window.location.pathname, '/evals');
  assert.equal(window.location.search, '');
  assert.equal(window.sessionStorage.getItem(SITE_STORAGE_KEY), 'b300');
  assert.equal(apiRoot(), '/api');
  tabs.unmount();
  const list = mount(EvalListPage, {});
  await advance(10);
  assert.ok(net.log.some(req => req.path === '/api/evals'));
  list.unmount();
});

test('site discovery always reads primary registry and all requested page headers contain tabs', async () => {
  resetBrowser(); setLocation('/evals?site=rtx');
  net.handler = req => req.path === '/api/sites' ? { json: sites } : null;
  const tabs = mount(SiteTabs, {});
  await advance(10);
  assert.equal(net.log[0].path, '/api/sites');
  assert.deepEqual(propsOf<Parameters<typeof SiteTabsControl>[0]>(tabs.output, SiteTabsControl).sites, sites);
  tabs.unmount();
  const list = mount(EvalListPage, {});
  assert.equal(findAll(list.output, SiteTabs).length, 1); list.unmount();
  const detail = mount(EvalDetailPage, { evalId: 'current' });
  assert.equal(findAll(detail.output, SiteTabs).length, 1); detail.unmount();
  setLocation('/traces?run=current&episode=trial&site=rtx');
  const trial = mount(TraceViewerPage, {});
  assert.equal(findAll(trial.output, SiteTabs).length, 1); trial.unmount();
});

test('trace, evaluation, GMO, legacy, file, image and video requests use the selected site', async () => {
  resetBrowser(); setLocation('/traces?site=rtx');
  net.handler = () => ({ json: {} });
  const calls = [traceApi.config(), traceApi.runs(), traceApi.run('run'), traceApi.episode('run', 'trial'),
    traceApi.events('run', 'trial', 0), traceApi.legacyRuns(), traceApi.legacyRun('old', 0),
    traceApi.legacyTrial('old', 'task', 'condition', 'trial', 0), evalApi.list(), evalApi.detail('evaluation'),
    evalApi.codeChanges('evaluation'), gmoApi.config(), gmoApi.saveConfig({ host: 'test', port: null, identity_file: null, shared_root: '', submission_root: '', mine: [], team: [], interval_s: 0 }),
    gmoApi.follow('run', 'trial')];
  await advance(10); await Promise.all(calls);
  assert.ok(net.log.every(req => req.path.startsWith('/api/sites/rtx/')));
  assert.equal(episodeFileUrl({ runId: 'run', episodeId: 'trial', generation: 'g' }, 'video.mp4'),
    '/api/sites/rtx/traces/runs/run/episodes/trial/file/video.mp4?g=g');
  assert.equal(episodeArrayImageUrl({ runId: 'run', episodeId: 'trial' }, 'mask.npz', 'mask'),
    '/api/sites/rtx/traces/runs/run/episodes/trial/array-image/mask.npz?name=mask');
  assert.equal(traceApi.legacyFileUrl('run', 'task', 'condition', 'trial', 'video.mp4', 0),
    '/api/sites/rtx/traces/legacy/file/run/task/condition/trial/video.mp4?root=0');
});

test('query edits, breadcrumbs, failure links, evaluation links and comparisons stay on the current site', () => {
  resetBrowser(); rememberSite('rtx'); setLocation('/traces?run=run&episode=trial');
  const hook = mount(() => useUrlParams(), {});
  const [, setParams] = hook.output as ReturnType<typeof useUrlParams>;
  setParams({ event: 'ev', camera: 'front' }, true);
  assert.equal(currentParams().get('site'), 'rtx');
  assert.equal(currentParams().get('event'), 'ev'); hook.unmount();
  assert.equal(siteHref('/evals/current#trials'), '/evals/current?site=rtx#trials');
  assert.match(trialEventUrl('run', 'trial', 'event'), /&site=rtx$/);
  assert.match(comparisonUrl('run', 'trial', 'base', 'trial'), /&site=rtx$/);
  const breadcrumb = mount(Breadcrumb, { items: [{ label: '一覧', href: '/evals' }, { label: '現在' }] });
  assert.equal(findAll(breadcrumb.output, 'a')[0].props.href, '/evals?site=rtx'); breadcrumb.unmount();
  const detail = breakdownDetail(true);
  const list = mount(EvalListTable, { entries: [{ eval_id: detail.eval_id, eval: detail.eval, location: 'local' as const,
    error: null, display_status: null, summary: null, baseline_summary: null }] });
  assert.ok(findAll(list.output, 'a').every(link => String(link.props.href).includes('site=rtx'))); list.unmount();
  const failures = mount(FailureBreakdown, { detail });
  const failureLinks = findAll(failures.output, 'a');
  assert.ok(failureLinks.length > 0);
  assert.ok(failureLinks.every(link => String(link.props.href).includes('site=rtx'))); failures.unmount();
});

test('messages name the current remote machine: GMO for B300, the site label elsewhere', async () => {
  const { configureSites, remoteName } = await import('../../navigation/site');
  const { remoteListingText } = await import('../remoteListing');
  resetBrowser();
  configureSites(sites);
  const status = { fetched_at: '2026-11-20T12:00:00Z', refreshing: false, error: null };
  assert.equal(remoteName(), 'GMO');
  assert.match(remoteListingText(status), /^GMO の一覧：/);
  setLocation('/evals?site=rtx');
  assert.equal(remoteName(), 'RTX');
  assert.match(remoteListingText(status), /^RTX の一覧：/);
});
