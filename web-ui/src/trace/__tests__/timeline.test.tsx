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
