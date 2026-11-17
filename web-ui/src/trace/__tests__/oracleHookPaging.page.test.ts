import test from 'node:test';
import assert from 'node:assert/strict';
import TraceViewerPage from '../TraceViewerPage';
import { TopBar, UnusedHookNotice } from '../components/TopBar';
import { advance, findAll, net, propsOf, requests, resetBrowser, setLocation } from './harness/browser';
import { mount } from './harness/fakeReact';
import { addEpisode, ev, makeRun, serve } from './pageServer';

const legacyHook = {
  hook: 'H5/H6',
  target: 'capx.utils.launch_utils',
  reason: '_build_multi_turn_decision_prompt_legacy: not found',
};
const config_flags = { use_oracle_code: true, multi_turn: false };
const pageSize = 3;
const bytesPerEvent = 100;

function setup(source: 'startup' | 'during' | 'model startup', view: 'simple' | 'details') {
  resetBrowser();
  setLocation(`/traces?view=${view}&run=r1&episode=e1`);
  const run = makeRun();
  const startup = source !== 'during';
  const config = source === 'model startup' ? { use_oracle_code: false, multi_turn: true } : config_flags;
  const start = ev('e1', 1, 'episode_start', {
    config_flags: config,
    tracer: { hooks_failed: startup ? [legacyHook] : [] },
  });
  const middle = Array.from({ length: 9 }, (_, index) => {
    const seq = index + 2;
    return !startup && seq === 2 ? ev('e1', seq, 'trace_warning', {
      code: 'hook_install_failed', hook: legacyHook.hook, target: legacyHook.target,
      message: legacyHook.reason, during_episode: true,
    }) : ev('e1', seq, 'env_reset', {});
  });
  const result = {
    trace_complete: false,
    gaps: [{ code: 'hook_install_failed', count: 1, first_seq: startup ? start.seq : 2 }],
    dropped_events: 0,
    late_events: 0,
    n_warnings: startup ? 0 : 1,
  };
  const events = [start, ...middle, ev('e1', 11, 'episode_end', result)];
  const episode = addEpisode(run, 'e1', {
    ...result, run_id: 'r1', status: 'ended_with_gaps', episode: { config_flags: config },
    ...(source === 'model startup' && { startup_hook_failures: { seq: start.seq, failures: [legacyHook] } }),
  }, events);

  serve(run);
  const handler = net.handler;
  net.handler = (request) => {
    if (!request.path.endsWith('/events')) return handler(request);
    const from = Math.floor(Number(request.query.get('after_offset') ?? '0') / bytesPerEvent);
    const page = events.slice(from, from + pageSize);
    const next = from + page.length;
    return { latency: 20, json: {
      events: page, next_offset: next * bytesPerEvent, eof: next === events.length,
      torn_tail: false, corrupt_lines: 0, generation: episode.generation,
    } };
  };
  return events.length;
}

/** Include text in children and tooltips of the shallow render. */
function renderedText(node: unknown, seen = new Set<object>()): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (!node || typeof node !== 'object' || seen.has(node)) return '';
  seen.add(node);
  return Object.entries(node)
    .filter(([key]) => key !== 'model' && key !== 'summary')
    .map(([, value]) => renderedText(value, seen))
    .join(' ');
}

type BarProps = Parameters<typeof TopBar>[0];

function topBarText(props: BarProps): string {
  const bar = mount(TopBar, props);
  try {
    return renderedText(bar.output);
  } finally {
    bar.unmount();
  }
}

for (const source of ['startup', 'during', 'model startup'] as const) {
  test(`${source} hook warning in the simple header during paging and after EOF`, async () => {
    setup(source, 'simple');
    const page = mount(TraceViewerPage, {});
    try {
      for (let ms = 5; ms <= 150; ms += 5) {
        await advance(5);
        const [header] = findAll(page.output, 'header');
        assert.ok(header, `expected a simple header at ${ms} ms`);
        const reachedEof = requests(/\/events$/).list.some(request => request.doneAt !== null && request.query.get('after_offset') === '900');
        if (source === 'during' && reachedEof) assert.match(renderedText(header), /記録に欠落があります/);
        else assert.doesNotMatch(renderedText(header), /記録に欠落があります/, `simple header at ${ms} ms`);
      }
      const offsets = requests(/\/events$/).list.filter(request => request.doneAt !== null)
        .map(request => Number(request.query.get('after_offset') ?? '0'));
      assert.deepEqual(offsets, [0, 300, 600, 900]);
      if (source === 'during') assert.equal(findAll(page.output, UnusedHookNotice).length, 0);
      else assert.equal(propsOf<{ count: number }>(page.output, UnusedHookNotice).count, 1);
    } finally {
      page.unmount();
    }
  });

  test(`${source} hook warning is resolved in the details header after the last page`, async () => {
    const total = setup(source, 'details');
    const page = mount(TraceViewerPage, {});
    const pendingCounts = new Set<number>();
    try {
      for (let ms = 5; ms <= 150; ms += 5) {
        await advance(5);
        const props = propsOf<BarProps>(page.output, TopBar);
        const { count, eof } = props.reader;
        const text = topBarText(props);
        const context = `details header with ${count}/${total} events at ${ms} ms`;
        if (!eof || source !== 'during') assert.doesNotMatch(text, /記録に欠落|フック導入失敗|記録の警告 \d+/, context);
        if (props.summary && !eof) {
          assert.match(text, /記録の警告を確認中/, context);
          pendingCounts.add(count);
        }
        if (eof) {
          assert.equal(count, total);
          if (source === 'during') {
            assert.match(text, /記録に欠落があります/, context);
            assert.match(text, /フック導入失敗×1/, context);
            assert.doesNotMatch(text, /未使用フックの警告/, context);
          } else {
            assert.match(text, /未使用フックの警告/, context);
          }
          assert.deepEqual([...pendingCounts].filter(count => count > 0), [3, 6, 9]);
          return;
        }
      }
      throw new Error('events.jsonl did not reach EOF');
    } finally {
      page.unmount();
    }
  });
}
