import test from 'node:test';
import assert from 'node:assert/strict';
import { advance, findAll, propsOf, resetBrowser, type FakeElement } from './harness/browser';
import { mount, type Mounted } from './harness/fakeReact';
import { Timeline } from '../components/Timeline';
import { VirtualList } from '../components/VirtualList';
import { buildEpisodeModel, type TNode } from '../model';
import { Rec } from './fixtures';

type Props = Parameters<typeof Timeline>[0];
interface Row { node: TNode; depth: number; context: boolean }
interface ListProps {
  items: Row[];
  renderItem: (row: Row) => FakeElement;
  scrollToKey: string | null;
}
const STORAGE_KEY = 'capx.timeline.allDetails';

function recording() {
  const r = new Rec();
  r.episodeStart();
  const block = r.blockStart(null, [
    'unique_code_marker = solve_ik()',
    ...Array.from({ length: 10 }, (_, index) => `step_${index} = ${index}`),
    'deep_code_marker = True',
  ].join('\n'));
  const api = r.apiStart(block, 'solve_ik', { target: 'unique-argument' });
  const service = r.serviceStart(api, 'planner', 'solve');
  r.serviceEnd(service, { endpoint: 'https://example.invalid/solver', error_type: 'SolverError', message: 'unique-service-error' }, 'service_call_error');
  const nested = r.apiStart(block, 'nested_api', {}, api);
  r.apiEnd(nested);
  r.apiEnd(api, 'unique-return');
  const failed = r.apiStart(block, 'failed_move');
  r.apiError(failed, 'RuntimeError', 'traceback detail\nIK did not converge');
  r.blockEnd(block, 0, 0);
  r.episodeEnd();
  const model = buildEpisodeModel(r.events);
  const node = (id: string) => model.allNodes.find(n => n.primary.event_id === id)!;
  return { model, block: node(block.event_id), api: node(api.event_id), service: node(service.event_id),
    nested: node(nested.event_id), failed: node(failed.event_id) };
}

function timeline(rec: ReturnType<typeof recording>, overrides: Partial<Props> = {}) {
  let page: Mounted<Props>;
  const chosen: string[] = [];
  let cleared = 0;
  const props: Props = {
    model: rec.model, ep: { runId: 'run', episodeId: 'ep' }, running: false,
    selectedKey: null, selectedEventId: null, scrollToken: 0, showTaskText: false,
    onSelect: node => {
      chosen.push(node.key);
      page.update({ ...page.props, selectedKey: node.key, selectedEventId: node.primary.event_id });
    },
    onClearSelection: () => {
      cleared++;
      page.update({ ...page.props, selectedKey: null, selectedEventId: null });
    },
    ...overrides,
  };
  page = mount(Timeline, props);
  const list = () => propsOf<ListProps>(page.output, VirtualList);
  const card = (key: string) => {
    const row = list().items.find(item => item.node.key === key)!;
    assert.ok(row, `visible row ${key}`);
    const boundary = list().renderItem(row);
    const element = boundary.props.children as FakeElement;
    const component = element.type as (props: Record<string, unknown>) => unknown;
    const rendered = mount(component, element.props);
    const button = findAll(rendered.output, 'button').find(el => el.props['data-timeline-event'] !== undefined)!;
    assert.ok(button, 'the event header is a native button');
    return { ...rendered, button, row };
  };
  const click = async (key: string) => {
    const rendered = card(key);
    (rendered.button.props.onClick as () => void)();
    rendered.unmount();
    await advance(0);
  };
  const allSwitch = () => findAll(page.output, 'button').find(el => el.props.role === 'switch')!;
  const search = async (value: string) => {
    const input = findAll(page.output, 'input').find(el => el.props.type === 'search')!;
    (input.props.onChange as (event: unknown) => void)({ target: { value } });
    await advance(0);
  };
  const filter = async (label: string) => {
    const chip = namedElements(page.output, 'FilterChip').find(element => text(element) === label)!;
    assert.ok(chip, `filter ${label}`);
    (chip.props.onClick as () => void)();
    await advance(0);
  };
  return { page, list, card, click, allSwitch, search, filter, chosen, cleared: () => cleared };
}

function namedElements(value: unknown, name: string): FakeElement[] {
  if (Array.isArray(value)) return value.flatMap(child => namedElements(child, name));
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const element = value as FakeElement;
  const current = typeof element.type === 'function' && element.type.name === name ? [element] : [];
  return [...current, ...namedElements(element.props.children, name)];
}

/** Text children only: title/aria-label and other hidden metadata are excluded. */
function text(value: unknown): string {
  if (value === null || value === undefined || typeof value === 'boolean') return '';
  if (Array.isArray(value)) return value.map(text).join('');
  if (typeof value === 'object' && 'props' in value) return text((value as FakeElement).props.children);
  return typeof value === 'object' ? '' : String(value);
}

function renderedText(value: unknown): string {
  if (Array.isArray(value)) return value.map(renderedText).join('');
  if (value && typeof value === 'object' && 'props' in value) {
    const element = value as FakeElement;
    if (typeof element.type === 'function') {
      const rendered = mount(element.type as (props: Record<string, unknown>) => unknown, element.props);
      try { return renderedText(rendered.output); } finally { rendered.unmount(); }
    }
    return renderedText(element.props.children);
  }
  return text(value);
}

function expanded(view: ReturnType<typeof timeline>, key: string): boolean {
  const card = view.card(key);
  const value = card.button.props['aria-expanded'];
  assert.equal(card.button.props.type, 'button');
  assert.notEqual(card.button.props.tabIndex, -1, 'every row is keyboard focusable');
  card.unmount();
  return value === true;
}

test('events start collapsed and a row button selects, expands, then collapses its selected event', async () => {
  resetBrowser();
  const rec = recording(); const view = timeline(rec);
  assert.equal(expanded(view, rec.api.key), false);
  assert.equal(expanded(view, rec.block.key), false);
  assert.equal(view.allSwitch().props['aria-checked'], false);
  const card = view.card(rec.api.key);
  assert.match(text(card.output), /API.*solve_ik.*行 3/);
  assert.doesNotMatch(text(card.output), /unique-argument|unique-return/);
  card.unmount();
  await view.click(rec.api.key);
  assert.deepEqual(view.chosen, [rec.api.key]);
  assert.equal(expanded(view, rec.api.key), true);
  await view.click(rec.api.key);
  assert.equal(expanded(view, rec.api.key), false);
  assert.equal(view.cleared(), 1);
  assert.equal(view.page.props.selectedKey, null);
  view.page.unmount();
});

test('external event selection expands the event and reveals its nested ancestors immediately', async () => {
  resetBrowser();
  const rec = recording(); const view = timeline(rec, { selectedKey: rec.service.key, selectedEventId: rec.service.primary.event_id });
  assert.equal(expanded(view, rec.api.key), true);
  assert.equal(expanded(view, rec.service.key), true);
  assert.equal(view.list().scrollToKey, rec.service.key);
  await view.click(rec.service.key);
  assert.equal(expanded(view, rec.service.key), false);
  view.page.update({ ...view.page.props, selectedKey: rec.service.key, selectedEventId: rec.service.primary.event_id, scrollToken: 1 });
  assert.equal(expanded(view, rec.service.key), true, 'selecting the same event externally opens it again');
  (view.allSwitch().props.onClick as () => void)(); await advance(0);
  (view.allSwitch().props.onClick as () => void)(); await advance(0);
  assert.equal(expanded(view, rec.service.key), true, 'turning all details off keeps the selection expanded');
  view.page.unmount();
});

test('global details switch expands all rows and remembers its setting across viewers and trials', async () => {
  resetBrowser();
  const rec = recording(); const view = timeline(rec);
  assert.match(text(view.allSwitch()), /詳細をすべて表示/);
  (view.allSwitch().props.onClick as () => void)(); await advance(0);
  assert.equal(view.allSwitch().props['aria-checked'], true);
  for (const row of view.list().items) assert.equal(expanded(view, row.node.key), true);
  assert.equal(window.localStorage.getItem(STORAGE_KEY), 'true');
  view.page.unmount();
  const restored = timeline(recording(), { ep: { runId: 'other-run', episodeId: 'other-episode' } });
  assert.equal(restored.allSwitch().props['aria-checked'], true);
  (restored.allSwitch().props.onClick as () => void)(); await advance(0);
  assert.equal(restored.allSwitch().props['aria-checked'], false);
  assert.equal(expanded(restored, rec.api.key), false);
  assert.equal(window.localStorage.getItem(STORAGE_KEY), 'false');
  restored.page.unmount();
  const off = timeline(rec);
  assert.equal(off.allSwitch().props['aria-checked'], false);
  off.page.unmount();
});

test('blocked localStorage reads and writes leave row toggles and the global switch usable', async () => {
  resetBrowser();
  const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
  try {
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => { throw new Error('storage blocked'); } });
    const rec = recording(); const view = timeline(rec);
    assert.equal(view.allSwitch().props['aria-checked'], false);
    (view.allSwitch().props.onClick as () => void)(); await advance(0);
    assert.equal(view.allSwitch().props['aria-checked'], true);
    (view.allSwitch().props.onClick as () => void)(); await advance(0);
    await view.click(rec.api.key);
    assert.equal(expanded(view, rec.api.key), true);
    view.page.unmount();
  } finally { Object.defineProperty(window, 'localStorage', descriptor); }
  const storage = window.localStorage;
  const setItem = storage.setItem;
  try {
    storage.setItem = () => { throw new Error('storage full'); };
    const view = timeline(recording());
    (view.allSwitch().props.onClick as () => void)(); await advance(0);
    assert.equal(view.allSwitch().props['aria-checked'], true);
    view.page.unmount();
  } finally { storage.setItem = setItem; }
});

test('a collapsed failed event keeps its one-line error visible in the error colour', () => {
  resetBrowser();
  const rec = recording(); const view = timeline(rec);
  assert.equal(expanded(view, rec.failed.key), false);
  const card = view.card(rec.failed.key);
  const error = findAll(card.output, 'div').find(el => text(el).includes('IK did not converge') && String(el.props.className).includes('text-red-300'));
  assert.ok(error, 'collapsed error summary is visible and red');
  assert.ok(!text(error).includes('\n'), 'error summary fits on one line');
  card.unmount(); view.page.unmount();
});

test('a collapsed API counts hidden service and API calls; expansion reveals indented collapsed children', async () => {
  resetBrowser();
  const rec = recording(); const view = timeline(rec);
  const parent = view.card(rec.api.key);
  assert.match(text(parent.button), /＋中の呼び出し 2件/);
  parent.unmount();
  assert.equal(view.list().items.some(row => row.node.key === rec.service.key), false);
  assert.equal(view.list().items.some(row => row.node.key === rec.nested.key), false);
  await view.click(rec.api.key);
  const child = view.card(rec.service.key);
  const parentAgain = view.card(rec.api.key);
  assert.ok(child.row.depth > parentAgain.row.depth);
  parentAgain.unmount();
  assert.equal(child.button.props['aria-expanded'], false);
  child.unmount();
  assert.equal(expanded(view, rec.nested.key), false);
  const openParent = view.card(rec.api.key);
  assert.doesNotMatch(text(openParent.button), /＋中の呼び出し/);
  openParent.unmount(); view.page.unmount();
});

test('searching details expands matches and ancestors without permanently opening rows', async () => {
  resetBrowser();
  const rec = recording(); const view = timeline(rec);
  await view.search('unique_code_marker');
  assert.equal(expanded(view, rec.block.key), true);
  const codeMatch = view.card(rec.block.key);
  assert.match(renderedText(codeMatch.output), /unique_code_marker/);
  codeMatch.unmount();
  assert.equal(view.list().items.some(row => row.node.key === rec.failed.key), false);
  await view.search('deep_code_marker');
  const deepMatch = view.card(rec.block.key);
  const excerpt = findAll(deepMatch.output, 'div').find(element => element.props['aria-label'] === '検索一致');
  assert.ok(excerpt, 'a code hit beyond the six-line preview has a visible excerpt');
  assert.match(text(excerpt), /deep_code_marker = True/, 'excerpts preserve the original code case');
  deepMatch.unmount();
  await view.search('unique-service-error');
  assert.equal(expanded(view, rec.api.key), true);
  assert.equal(expanded(view, rec.service.key), true);
  const serviceMatch = view.card(rec.service.key);
  assert.match(renderedText(serviceMatch.output), /unique-service-error/);
  serviceMatch.unmount();
  await view.search('');
  assert.equal(expanded(view, rec.api.key), false, 'search expansion does not permanently open the event');
  view.page.unmount();
});

test('service and failure filters reveal matching nested calls through their parent rows', async () => {
  resetBrowser();
  const rec = recording(); const view = timeline(rec);
  await view.filter('サービス呼び出し');
  assert.equal(expanded(view, rec.api.key), true);
  assert.equal(expanded(view, rec.service.key), false);
  assert.equal(view.list().items.some(row => row.node.key === rec.failed.key), false);
  assert.equal(view.list().items.some(row => row.node.key === rec.nested.key), false);
  await view.filter('サービス呼び出し');
  await view.filter('失敗のみ');
  assert.equal(expanded(view, rec.failed.key), false);
  assert.equal(view.list().items.some(row => row.node.key === rec.service.key), true);
  assert.equal(view.list().items.some(row => row.node.key === rec.nested.key), false);
  view.page.unmount();
});
