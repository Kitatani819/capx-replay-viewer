import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { Timeline } from '../components/Timeline';
import { buildEpisodeModel } from '../model';
import { Rec } from './fixtures';

// VirtualList measures after mounting in the browser, not during server rendering.
const consoleError = console.error;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('useLayoutEffect does nothing on the server')) return;
  consoleError(...args);
};

test('collapsed markup hides arguments and thumbnails; selecting the API preserves its existing details', () => {
  const r = new Rec();
  r.episodeStart();
  const block = r.blockStart(null, 'move()');
  const api = r.apiStart(block, 'move', { target: 'argument-only-marker' });
  r.add('frame', { camera: 'front', buffer_index: 0, for_event_id: api.event_id, reason: 'keyframe' },
    { parent: api.event_id, artifacts: [{ kind: 'image', path: 'frames/before.png', written: true }] });
  r.apiEnd(api, 'return-only-marker');
  r.blockEnd(block, 0, 0);
  const model = buildEpisodeModel(r.events);
  const node = model.allNodes.find(n => n.primary.event_id === api.event_id)!;
  const render = (selected: boolean) => renderToStaticMarkup(<Timeline
    model={model} ep={{ runId: 'run', episodeId: 'ep' }} running={false}
    selectedKey={selected ? node.key : null} selectedEventId={selected ? api.event_id : null}
    onSelect={() => {}} scrollToken={0} showTaskText={false}
  />);
  const collapsed = render(false);
  assert.match(collapsed, /<button[^>]*data-timeline-event="[^"]+"[^>]*aria-expanded="false"/);
  assert.match(collapsed, /role="switch" aria-checked="false"/);
  assert.doesNotMatch(collapsed, /argument-only-marker|return-only-marker|<img/);
  const selected = render(true);
  assert.match(selected, /argument-only-marker/);
  assert.match(selected, /return-only-marker/);
  assert.match(selected, /行 3/);
  assert.match(selected, /aria-expanded="true"/);
  assert.match(selected, /frames%2Fbefore.png|frames\/before.png/);
});

test('an episode exception stays visible while collapsed even when its status is ok', () => {
  const r = new Rec();
  r.episodeStart();
  const end = r.episodeEnd({ end_reason: 'exception', exception: { type: 'RuntimeError', message: 'episode exception marker' } });
  const model = buildEpisodeModel(r.events);
  assert.equal(end.status, 'ok');
  const html = renderToStaticMarkup(<Timeline model={model} ep={{ runId: 'run', episodeId: 'ep' }}
    running={false} selectedKey={null} selectedEventId={null} onSelect={() => {}} scrollToken={0} showTaskText={false} />);
  assert.match(html, /data-timeline-event="[^"]+"[^>]*aria-expanded="false"/);
  assert.match(html, /text-red-300[^>]*>RuntimeError: episode exception marker/);
  assert.doesNotMatch(html, /end_reason=exception/);
});

test('an opened API card shows the definition first and keeps argument values in a closed toggle', () => {
  const r = new Rec();
  r.episodeStart();
  const block = r.blockStart(null, 'goto_pose(p, q)');
  const known = r.apiStart(block, 'goto_pose', { position: [0.1, 0.2, 0.3], quaternion_wxyz: [1, 0, 0, 0] });
  r.apiEnd(known, null);
  const unknown = r.apiStart(block, 'custom_move', { target: 'value-marker', '<truncated>': 'node_limit' });
  r.apiError(unknown, 'RuntimeError', 'error-marker');
  r.blockEnd(block, 0, 0);
  const model = buildEpisodeModel(r.events);
  const render = (event: { event_id: string }) => {
    const node = model.allNodes.find(n => n.primary.event_id === event.event_id)!;
    return renderToStaticMarkup(<Timeline model={model} ep={{ runId: 'run', episodeId: 'ep' }} running={false}
      selectedKey={node.key} selectedEventId={event.event_id} onSelect={() => {}} scrollToken={0} showTaskText={false} />);
  };
  const html = render(known);
  const signature = html.indexOf('goto_pose(position: np.ndarray, quaternion_wxyz: np.ndarray, z_approach: float = 0.0) -&gt; None');
  const toggle = html.indexOf('<details class="text-[11px]" data-api-values="">');
  assert.ok(signature > 0 && toggle > signature, 'definition comes before the closed toggle');
  assert.match(html, /<summary[^>]*>引数と戻り値<\/summary>/);
  assert.match(html.slice(toggle), /position = \[0\.1, 0\.2, 0\.3\]/);
  assert.match(html.slice(toggle), /quaternion_wxyz = \[1, 0, 0, 0\]/);
  const other = render(unknown);
  assert.match(other, /data-api-signature="">custom_move\(target\)<span[^>]*>定義は未登録（記録された引数名）/);
  assert.match(other, /target = &quot;value-marker&quot;/);
  assert.match(other, /…（記録上限のため、ほかの引数は省略）/);
  // The error stays visible outside the folded values.
  assert.match(other, /<\/details><div class="text-\[11px\] font-mono text-red-300[^>]*>✕ RuntimeError: error-marker/);
});
