import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildEpisodeModel, resolveSelection } from '../model';
import { EnsembleTab } from '../components/tabs/EnsembleTab';
import { InputOutputTab } from '../components/tabs/InputOutputTab';
import type { TabProps } from '../components/DetailTabs';
import { Rec } from './fixtures';

function props(r: Rec, id: string): TabProps {
  const model = buildEpisodeModel(r.events);
  return { model, ep: { runId: 'run', episodeId: 'ep' }, selection: resolveSelection(model,id)!,
    summary: null, running: false, onSelect: () => {}, onFocusRange: () => {}, focus: null };
}

test('candidate and synthesis tabs render separate records for only the selected turn', () => {
  const r = new Rec(); r.episodeStart();
  const member = r.request('code_generator','member',1,{call_kind:'ensemble_member',turn_index:1});
  r.response(member,200,'CANDIDATE_ANSWER');
  const synthesis = r.request('code_generator','synthesis',1,{call_kind:'ensemble_synthesis',turn_index:1});
  r.response(synthesis,200,'SYNTHESIS_ANSWER');
  const other = r.request('code_generator','other',1,{call_kind:'ensemble_member',turn_index:2});
  r.response(other,200,'OTHER_TURN');
  const p = props(r,member.event_id);
  const candidates = renderToStaticMarkup(<EnsembleTab {...p} mode="candidates"/>);
  const result = renderToStaticMarkup(<EnsembleTab {...p} mode="synthesis"/>);
  assert.match(candidates,/CANDIDATE_ANSWER/);
  assert.doesNotMatch(candidates,/SYNTHESIS_ANSWER|OTHER_TURN|data-synthesis=/);
  assert.match(result,/SYNTHESIS_ANSWER/);
  assert.doesNotMatch(result,/CANDIDATE_ANSWER|OTHER_TURN|data-candidate=/);
  assert.match(result,/統合時に実際に渡された入力/);
});

test('recorded service I/O and Python execution use their own artifacts and streams', () => {
  const r = new Rec(); r.episodeStart();
  const block = r.blockStart(null,'block',{code:'print("EXECUTED_CODE")'});
  const api = r.apiStart(block,'get_object_pose',{});
  const service = r.serviceStart(api,'sam3','segment');
  service.data = {...(service.data as Record<string,unknown>),request_summary:{text_prompt:'red cube'}};
  service.artifacts = [{path:'assets/camera.png',mime:'image/png',label:'perception_input',written:true}];
  r.serviceEnd(service,{response_summary:{masks:{path:'assets/mask.npz'}}});
  r.apiEnd(api);
  r.stream(block,'stdout','EXECUTED_STDOUT');
  r.stream(block,'stderr','EXECUTED_STDERR');
  r.blockEnd(block,0,0);
  const perception = renderToStaticMarkup(<InputOutputTab {...props(r,service.event_id)}/>);
  const execution = renderToStaticMarkup(<InputOutputTab {...props(r,block.event_id)}/>);
  assert.match(perception,/red cube/);
  assert.match(perception,/assets\/camera.png/);
  assert.match(perception,/assets\/mask.npz/);
  assert.match(execution,/EXECUTED_CODE/);
  assert.match(execution,/EXECUTED_STDOUT/);
  assert.match(execution,/EXECUTED_STDERR/);
  assert.match(execution,/成功メッセージはコード自身の申告/);
});
