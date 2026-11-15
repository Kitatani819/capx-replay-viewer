import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildEpisodeModel, resolveSelection } from '../model';
import { ApiTurnModelTab } from '../components/tabs/ApiTurnModelTab';
import type { TabProps } from '../components/DetailTabs';
import { Rec } from './fixtures';

function props(r: Rec, id: string): TabProps {
  const model = buildEpisodeModel(r.events);
  return { model, ep: { runId: 'run', episodeId: 'ep' }, selection: resolveSelection(model, id)!,
    summary: null, running: false, onSelect: () => {}, onFocusRange: () => {}, focus: null };
}

test('API model I/O follows the recorded source response and its own HTTP input', () => {
  const r = new Rec(); r.episodeStart();
  const request = r.request('code_generator', 'generator', 1, { call_kind: 'ensemble_synthesis' });
  const response = r.response(request, 200, 'SOURCE_REPLY');
  const block = r.blockStart(response, 'goto_pose([0, 0, 1])');
  const api = r.apiStart(block, 'goto_pose');
  const retry = r.request('code_generator', 'generator', 2);
  r.response(retry, 200, 'LATER_RETRY_REPLY');
  const candidate = r.request('code_generator', 'candidate', 1, { call_kind: 'ensemble_member' });
  r.response(candidate, 200, 'SAME_TURN_CANDIDATE');
  const original = props(r, api.event_id);
  const html = renderToStaticMarkup(<ApiTurnModelTab {...original}/>);
  assert.match(html, /SOURCE_REPLY/);
  assert.doesNotMatch(html, /LATER_RETRY_REPLY|SAME_TURN_CANDIDATE/);
  assert.match(html, new RegExp(`data-api-model-input="${request.event_id}"`));
  assert.match(html, new RegExp(`data-api-model-output="${response.event_id}"`));
  assert.ok(html.indexOf('モデルに渡した入力') < html.indexOf('モデルが返した出力'));
  assert.equal(original.selection.eventId, api.event_id, 'the parent API selection remains unchanged');
});

test('a source response does not display an earlier response from the same HTTP attempt', () => {
  const r = new Rec(); r.episodeStart();
  const request = r.request('code_generator', 'generator');
  r.response(request, 200, 'EARLIER_RESPONSE');
  const source = r.response(request, 200, 'EXACT_SOURCE_RESPONSE');
  const block = r.blockStart(source);
  const html = renderToStaticMarkup(<ApiTurnModelTab {...props(r, block.event_id)}/>);
  assert.match(html, /EXACT_SOURCE_RESPONSE/);
  assert.doesNotMatch(html, /EARLIER_RESPONSE/);
});

test('missing API call_site does not borrow the parent block or a same-turn model call', () => {
  const r = new Rec(); r.episodeStart();
  const request = r.request('code_generator', 'generator');
  const response = r.response(request, 200, 'DO_NOT_GUESS_THIS_REPLY');
  const block = r.blockStart(response);
  const api = r.apiStart(block, 'goto_pose', {}, null, { call_site: null });
  const html = renderToStaticMarkup(<ApiTurnModelTab {...props(r, api.event_id)}/>);
  assert.match(html, /未記録/);
  assert.doesNotMatch(html, /DO_NOT_GUESS_THIS_REPLY/);
  assert.match(html, /data-api-model-input="unrecorded"/);
});

test('an unmatched source response is shown without substituting another HTTP input', () => {
  const r = new Rec(); r.episodeStart();
  const request = r.request('code_generator', 'generator');
  r.response(request, 200, 'KNOWN_ATTEMPT_REPLY');
  const source = r.add('model_response', { logical_call_id: 'generator', http_attempt: 99, content: 'UNMATCHED_SOURCE_REPLY' },
    { refs: { logical_call_id: 'generator', http_attempt: 99 } });
  const block = r.blockStart(source);
  const html = renderToStaticMarkup(<ApiTurnModelTab {...props(r, block.event_id)}/>);
  assert.match(html, /UNMATCHED_SOURCE_REPLY/);
  assert.match(html, /対応するHTTP要求は未記録/);
  assert.doesNotMatch(html, /KNOWN_ATTEMPT_REPLY/);
  assert.match(html, /data-api-model-input="unrecorded"/);
});
