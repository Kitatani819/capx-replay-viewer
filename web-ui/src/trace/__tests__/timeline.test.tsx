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

test('an opened API card shows its recorded signature and doc above the closed value toggle', () => {
  const r = new Rec(); r.episodeStart();
  const block = r.blockStart(null, 'grasp_widget(label)');
  const api = r.apiStart(block, 'grasp_widget', { label: 'recorded-label' }, null, {
    signature: '(label: str, *, safe: bool = True) -> bool',
    doc: 'Grasp the requested widget safely.',
  });
  r.apiEnd(api, 'recorded-result');
  const model = buildEpisodeModel(r.events);
  const node = model.nodeOfEvent.get(api.event_id)!;
  const html = renderToStaticMarkup(<Timeline model={model} ep={{ runId: 'run', episodeId: 'ep' }} running={false}
    selectedKey={node.key} selectedEventId={api.event_id} onSelect={() => {}} scrollToken={0} showTaskText={false} />);
  assert.match(html, /data-api-signature="" title="Grasp the requested widget safely\.">grasp_widget\(label: str, \*, safe: bool = True\) -&gt; bool<\/div>/);
  assert.match(html, /class="text-\[10px\] text-text-muted truncate" data-api-doc="" title="Grasp the requested widget safely\.">Grasp the requested widget safely\.<\/div>/);
  assert.doesNotMatch(html, /定義は未登録/);
  const toggle = html.match(/<details[^>]*data-api-values=""[^>]*>[\s\S]*?<\/details>/)?.[0] ?? '';
  assert.ok(toggle, 'the recorded values remain in their own toggle');
  assert.doesNotMatch(toggle, /<details[^>]*\bopen(?:=|\s|>)/);
  assert.match(toggle, /引数と戻り値/);
  assert.match(toggle, /label = &quot;recorded-label&quot;/);
  assert.match(toggle, /→ &quot;recorded-result&quot;/);
  assert.ok(html.indexOf('data-api-doc') < html.indexOf('data-api-values'));
});

test('a recorded signature overrides the reference signature and retains its Japanese summary title', () => {
  const r = new Rec(); r.episodeStart();
  const block = r.blockStart(null, 'goto_pose(target)');
  const api = r.apiStart(block, 'goto_pose', { target: 'widget' }, null, {
    signature: '(target: str) -> bool', doc: 'Move to the widget target.',
  });
  const model = buildEpisodeModel(r.events);
  const node = model.nodeOfEvent.get(api.event_id)!;
  const html = renderToStaticMarkup(<Timeline model={model} ep={{ runId: 'run', episodeId: 'ep' }} running={false}
    selectedKey={node.key} selectedEventId={api.event_id} onSelect={() => {}} scrollToken={0} showTaskText={false} />);
  assert.match(html, /data-api-signature="" title="逆運動学を使ってロボットの手先を指定した位置・姿勢へ移動します。">goto_pose\(target: str\) -&gt; bool<\/div>/);
  assert.match(html, /data-api-doc="" title="Move to the widget target\.">Move to the widget target\./);
  assert.doesNotMatch(html, /goto_pose\(position: np\.ndarray/);
});

test('parallel reasoning candidates fold into one closed row that opens for a selected candidate', () => {
  const r = new Rec();
  r.episodeStart();
  const members = ['a', 'b', 'c'].map(id => {
    const request = r.request('code_generator', id, 1, { call_kind: 'ensemble_member', turn_index: 0 });
    r.response(request);
    return request;
  });
  r.response(r.request('code_generator', 'synth', 1, { call_kind: 'ensemble_synthesis', turn_index: 0 }));
  r.response(r.request('code_generator', 'single', 1, { call_kind: 'ensemble_member', turn_index: 1 }));
  const model = buildEpisodeModel(r.events);
  const render = (selected: { event_id: string } | null) => {
    const node = selected ? model.allNodes.find(n => n.primary.event_id === selected.event_id)! : null;
    return renderToStaticMarkup(<Timeline model={model} ep={{ runId: 'run', episodeId: 'ep' }} running={false}
      selectedKey={node?.key ?? null} selectedEventId={selected?.event_id ?? null} onSelect={() => {}} scrollToken={0} showTaskText={false} />);
  };
  const closed = render(null);
  assert.match(closed, /data-timeline-group="" aria-expanded="false"/);
  assert.match(closed, /パラレルリーズニング：候補 3 件/);
  assert.match(closed, /#\d+–#\d+/);
  assert.doesNotMatch(closed, /パラレルリーズニング：候補 [123]\/3/);
  assert.equal(closed.match(/data-timeline-group=/g)?.length, 1, 'a lone candidate is not grouped');
  assert.match(closed, /パラレルリーズニング：統合/);
  assert.match(closed, /パラレルリーズニング：候補 1\/1/);
  assert.match(closed, /最長 [^<]+<\/span><span[^>]*>ok<\/span>/);
  const open = render(members[1]);
  assert.match(open, /data-timeline-group="" aria-expanded="true"/);
  for (const label of ['1/3', '2/3', '3/3']) assert.match(open, new RegExp(`パラレルリーズニング：候補 ${label}`));
  // The header carries no event id, so a candidate's id still names exactly one row.
  assert.equal(open.match(new RegExp(`data-timeline-event="${members[0].event_id}"`, 'g'))?.length, 1);
});

test('the candidate row counts failures and stopped streams apart', () => {
  const r = new Rec();
  r.episodeStart();
  r.response(r.request('code_generator', 'ok', 1, { call_kind: 'ensemble_member', turn_index: 0 }));
  const stopped = r.request('code_generator', 'stopped', 1, { call_kind: 'ensemble_member', turn_index: 0 });
  r.logicalError(stopped, 'GeneratorExit', 'stopped', { partial_content: 'part' });
  const failed = r.request('code_generator', 'failed', 1, { call_kind: 'ensemble_member', turn_index: 0 });
  r.logicalError(failed, 'RuntimeError', 'boom');
  const model = buildEpisodeModel(r.events);
  const html = renderToStaticMarkup(<Timeline model={model} ep={{ runId: 'run', episodeId: 'ep' }} running={false}
    selectedKey={null} selectedEventId={null} onSelect={() => {}} scrollToken={0} showTaskText={false} />);
  assert.match(html, />失敗 1<\/span>/);
  assert.match(html, />中断 1<\/span>/);
  assert.doesNotMatch(html, />ok<\/span><span[^>]*>#\d+–/);
});
