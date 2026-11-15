import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildEpisodeModel, resolveSelection } from '../model';
import { EnsembleTab } from '../components/tabs/EnsembleTab';
import { InputOutputTab, RecordedModelOutput } from '../components/tabs/InputOutputTab';
import { DebugTab } from '../components/tabs/DebugTab';
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
  r.stream(block,'stdout','SECOND_STDOUT_RECORD');
  r.stream(block,'stderr','EXECUTED_STDERR');
  r.blockEnd(block,0,0);
  const perception = renderToStaticMarkup(<InputOutputTab {...props(r,service.event_id)}/>);
  const execution = renderToStaticMarkup(<InputOutputTab {...props(r,block.event_id)}/>);
  assert.match(perception,/red cube/);
  assert.match(perception,/assets\/camera.png/);
  assert.match(perception,/assets\/mask.npz/);
  assert.match(execution,/EXECUTED_CODE/);
  assert.match(execution,/EXECUTED_STDOUT/);
  assert.match(execution,/SECOND_STDOUT_RECORD/);
  assert.match(execution,/EXECUTED_STDERR/);
  assert.match(execution,/成功メッセージはコード自身の申告/);
});

test('the focused service view deduplicates image references and honors failed artifact writes', () => {
  const r = new Rec(); r.episodeStart();
  const block = r.blockStart(null); const api = r.apiStart(block,'perceive');
  const service = r.serviceStart(api,'sam3','segment');
  service.data = {...service.data as Record<string,unknown>, request_summary:{text_prompt:'red cube', image:{image:{path:'assets/input.png',written:true}}}};
  service.artifacts = [{path:'assets/input.png',label:'perception_input',written:true}];
  const end = r.serviceEnd(service,{response_summary:{mask:{path:'assets/mask.png',written:true}}});
  end.artifacts = [{path:'assets/mask.png',label:'perception_output',written:false,reason:'disk_full'}];
  const html = renderToStaticMarkup(<InputOutputTab {...props(r,service.event_id)}/>);
  assert.equal((html.match(/<img /g) ?? []).length,1);
  assert.match(html,/SAM3の入出力/);
  assert.match(html,/disk_full/);
  assert.doesNotMatch(html,/<img[^>]*mask.png/);
  assert.doesNotMatch(html,/shape=|リクエストの要約|HTTP 試行/);
});

test('focused model output stays with the selected attempt and does not link another attempt execution', () => {
  const r = new Rec(); r.episodeStart();
  const failed = r.request('code_generator','retry',1); r.attemptError(failed,503,'RETRY_FAILED');
  const retry = r.request('code_generator','retry',2); const response = r.response(retry,200,'FINAL_REPLY');
  r.blockStart(response,'EXECUTED_AFTER_RETRY');
  const first = renderToStaticMarkup(<RecordedModelOutput {...props(r,failed.event_id)}/>);
  assert.match(first,/RETRY_FAILED/);
  assert.doesNotMatch(first,/FINAL_REPLY|実行されたPythonへ/);
  const second = renderToStaticMarkup(<RecordedModelOutput {...props(r,retry.event_id)}/>);
  assert.match(second,/FINAL_REPLY/);
  assert.match(second,/実行されたPythonへ/);
});

test('focused model output labels interrupted stream content as partial', () => {
  const r = new Rec(); r.episodeStart();
  const request = r.request('code_generator','stream',1,{stream:true});
  r.logicalError(request,'GeneratorExit','stopped',{streamed:true,partial_content:'PARTIAL_RESPONSE'});
  const html = renderToStaticMarkup(<RecordedModelOutput {...props(r,request.event_id)}/>);
  assert.match(html,/中断までに受信した回答（部分出力）/);
  assert.match(html,/PARTIAL_RESPONSE/);
});

test('generic events keep diagnostic banners and raw data inside the record disclosure', () => {
  const r = new Rec(); r.episodeStart();
  const event = r.add('trial_videos',{videos:[],private_debug_value:'RAW_RECORD_ONLY'});
  const p = props(r,event.event_id);
  const focused = renderToStaticMarkup(<InputOutputTab {...p}/>);
  assert.match(focused,/録画の保存記録/);
  assert.match(focused,/記録の詳細/);
  assert.doesNotMatch(focused,/replay-debug-banner|イベントの生データ|RAW_RECORD_ONLY/);
  const diagnostic = renderToStaticMarkup(<DebugTab {...p}/>);
  assert.equal((diagnostic.match(/replay-debug-banner/g)??[]).length,1);
  assert.equal((diagnostic.match(/イベントの生データを表示/g)??[]).length,1);
});

test('warning messages and evaluator provenance remain visible outside diagnostic details', () => {
  const r = new Rec(); r.episodeStart();
  const warning = r.add('trace_warning',{code:'queue_full',message:'WARNING_STILL_VISIBLE',message_redacted:true});
  const evaluator = r.add('evaluator_result',{scope:'episode',reward:0.5,task_completed:false,source:'RECORDED_EVALUATOR'});
  const warningHtml = renderToStaticMarkup(<InputOutputTab {...props(r,warning.event_id)}/>);
  assert.match(warningHtml,/WARNING_STILL_VISIBLE/);
  assert.match(warningHtml,/秘密情報はマスク/);
  const resultHtml = renderToStaticMarkup(<InputOutputTab {...props(r,evaluator.event_id)}/>);
  assert.match(resultHtml,/reward: 0.5/);
  assert.match(resultHtml,/task_completed: false/);
  assert.match(resultHtml,/evaluator_result（ハーネスの評価）/);
  assert.match(resultHtml,/RECORDED_EVALUATOR/);
});
