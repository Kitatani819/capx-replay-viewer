import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildEpisodeModel, resolveSelection } from '../model';
import { processTitle } from '../replay';
import { EnsembleTab } from '../components/tabs/EnsembleTab';
import { InputOutputTab, RecordedModelOutput } from '../components/tabs/InputOutputTab';
import { ApiTurnModelTab } from '../components/tabs/ApiTurnModelTab';
import { ApiLogTab } from '../components/tabs/ApiLogTab';
import { DebugTab } from '../components/tabs/DebugTab';
import type { TabProps } from '../components/DetailTabs';
import { Rec } from './fixtures';

function props(r: Rec, id: string): TabProps {
  const model = buildEpisodeModel(r.events);
  return { model, ep: { runId: 'run', episodeId: 'ep' }, selection: resolveSelection(model,id)!,
    summary: null, running: false, onSelect: () => {}, onFocusRange: () => {}, focus: null };
}

test('Oracle parsing and execution have an explicit source without a spurious missing model', () => {
  const r = new Rec();
  r.episodeStart();
  const parsed = r.add('model_output_parsed', { parser: '_extract_code', model_event_id: null, code_source: 'oracle' });
  const block = r.blockStart(null, 'get_hammer_pose()', { code_source: 'oracle' });
  const api = r.apiStart(block, 'get_hammer_pose');
  const missing = r.add('model_output_parsed', { model_event_id: 'missing-response', code_source: 'model' });
  const parsedProps = props(r, parsed.event_id);
  const apiProps = props(r, api.event_id);
  assert.equal(parsedProps.selection.node.orphan, null);
  assert.match(renderToStaticMarkup(<InputOutputTab {...parsedProps}/>), /Oracleコードの取り出し/);
  assert.match(props(r, missing.event_id).selection.node.orphan ?? '', /対応するモデル呼び出しがありません/);
  const html = renderToStaticMarkup(<ApiTurnModelTab {...apiProps}/>);
  assert.match(html, /Oracleの既定コード/);
  assert.doesNotMatch(html, /このPythonを生成したモデル|未記録/);
  assert.equal(processTitle(apiProps.selection.node), 'get_hammer_pose');
});

test('VDM initial scene descriptions and before/after comparisons have different headings', () => {
  const r = new Rec();
  r.episodeStart();
  const scene = r.request('vdm', 'scene', 1, { call_kind: 'initial_scene_description' });
  r.response(scene, 200, 'scene description');
  const diff = r.request('vdm', 'diff', 1, { call_kind: 'image_diff' });
  r.response(diff, 200, 'change description');
  const sceneProps = props(r, scene.event_id);
  assert.equal(processTitle(sceneProps.selection.node), '初期シーンを説明する');
  const sceneHtml = renderToStaticMarkup(<InputOutputTab {...sceneProps}/>);
  assert.match(sceneHtml, /VDMの初期シーン説明.*返ったシーンの説明/);
  assert.doesNotMatch(sceneHtml, /返った差分の説明/);
  assert.match(renderToStaticMarkup(<InputOutputTab {...props(r, diff.event_id)}/>), /VDMの比較と説明.*返った差分の説明/);
});

test('pointing and FINISH responses have no Python execution guidance', () => {
  const r = new Rec();
  r.episodeStart();
  const pointing = r.request('perception_vlm', 'point', 1, { call_kind: 'point' });
  r.response(pointing, 200, 'x=55 y=46');
  const synthesis = r.request('code_generator', 'synthesis', 1, { call_kind: 'ensemble_synthesis' });
  r.parsed(r.response(synthesis, 200, 'FINISH'), { decision: 'finish', model_said_finish: true, code_blocks: [] });
  const pointProps = props(r, pointing.event_id);
  const pointHtml = renderToStaticMarkup(<InputOutputTab {...pointProps}/>);
  assert.equal(processTitle(pointProps.selection.node), '画像内の対象物の位置をモデルに尋ねる');
  assert.match(pointHtml, /位置推定の回答.*x=55 y=46/);
  const finishHtml = renderToStaticMarkup(<EnsembleTab {...props(r, synthesis.event_id)} mode="synthesis"/>);
  assert.match(finishHtml, /FINISH/);
  for (const html of [pointHtml, finishHtml]) assert.doesNotMatch(html, /実行されたコードはPython実行で|実行されたPythonへ/);
});

test('an API return stored in an event data file shows its actual load state', () => {
  const r = new Rec();
  r.episodeStart();
  const api = r.apiStart(r.blockStart(null), 'summarize_workspace');
  const end = r.apiEnd(api);
  end.data = { api_call_id: api.event_id, oversize: true, data_asset: 'assets/result.json.gz', data_asset_written: true };
  const p = props(r, api.event_id);
  for (const state of [{ status: 'loading' }, { status: 'failed', error: 'FILE_UNAVAILABLE' }] as const) {
    const html = renderToStaticMarkup(<ApiLogTab {...p} assetStates={new Map([[end.event_id, state]])}/>);
    assert.match(html, state.status === 'loading' ? /戻り値.*読み込み中/ : /戻り値.*読み込めません.*FILE_UNAVAILABLE/);
    assert.doesNotMatch(html, /未記録/);
  }
  end.data = { api_call_id: api.event_id, return: { n_objects: 36 }, data_asset_loaded: true };
  assert.match(renderToStaticMarkup(<ApiLogTab {...props(r, api.event_id)}/>), /戻り値.*n_objects.*36/);
});

test('the service details preserve a recorded degraded state and HTTP error', () => {
  const r = new Rec();
  r.episodeStart();
  const service = r.serviceStart(r.apiStart(r.blockStart(null), 'segment'), 'sam3', 'sam3_seg_fn');
  r.serviceEnd(service, { response_summary: [], http_attempts: [{ status: null, error: 'ReadTimeout' }] }).status = 'degraded';
  const html = renderToStaticMarkup(<ApiLogTab {...props(r, service.event_id)}/>);
  assert.match(html, /状態.*通信失敗あり（degraded）/);
  assert.match(html, /ReadTimeout/);
  assert.doesNotMatch(html, />ok</);
});

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

test('PyRoKi inverse kinematics shows the recorded target pose and joint positions', () => {
  const r = new Rec();
  r.episodeStart();
  const api = r.apiStart(r.blockStart(null), 'goto_pose_arm0');
  const service = r.serviceStart(api, 'pyroki', 'ik_solve_fn');
  service.data = {
    ...service.data as Record<string, unknown>,
    request_summary: {
      target_pose_wxyz_xyz: { type: 'ndarray', shape: [7], dtype: 'float64', values: [0, 1, 0, 0, 0.81, 0, 0.207] },
      prev_cfg: null,
    },
  };
  r.serviceEnd(service, {
    response_summary: { type: 'ndarray', shape: [8], dtype: 'float32', values: [-0.013, 1.341, 0.047, -0.469, -0.047, 1.816, 0.794, 0.02] },
  });
  const p = props(r, service.event_id);
  const html = renderToStaticMarkup(<InputOutputTab {...p}/>);
  assert.equal(processTitle(p.selection.node), '手先の目標姿勢から関節位置を計算する');
  assert.match(html, /手先の目標姿勢.*\[0, 1, 0, 0, 0\.81, 0, 0\.207\]/);
  assert.match(html, /基準にする関節位置.*指定なし/);
  assert.match(html, /計算された関節位置.*\[-0\.013, 1\.341,/);
  assert.doesNotMatch(html, /対象物の指示|渡した画像|返った検出結果|未記録/);
});

test('service rows show the recorded operation and its data for detection, pointing, and motion planning', () => {
  const r = new Rec();
  r.episodeStart();
  const api = r.apiStart(r.blockStart(null), 'run_services');
  const cases = [
    ['owlvit', 'owl_vit_det_fn', '画像内の対象物を検出する', '検出した位置・ラベル・スコア', [{ label: 'hammer', box: [1, 2, 3, 4] }], 'hammer'],
    ['molmo', 'molmo_point_fn', '画像内の対象物を点で示す', '返った画像内の座標', { cube: [141, 118] }, '[141, 118]'],
    ['graspnet', 'grasp_net_plan_fn', '深度画像からつかみ方の候補を計算する', '把持姿勢・スコア・接触点', [[], [0.93], []], '0.93'],
    ['graspnet', 'grasp_net_plan_point_clouds_fn', '点群からつかみ方の候補を計算する', '把持姿勢・スコア・接触点', [[], [0.76], []], '0.76'],
    ['curobo', 'trajopt_plan_fn', '手先の移動経路を計画する', '軌道上の関節位置', [[0.12, 0.43]], '[0.12, 0.43]'],
  ] as const;
  for (const [name, fn, title, result, response, value] of cases) {
    const service = r.serviceStart(api, name, fn);
    r.serviceEnd(service, { response_summary: response });
    const p = props(r, service.event_id);
    const html = renderToStaticMarkup(<InputOutputTab {...p}/>);
    assert.equal(processTitle(p.selection.node), title);
    assert.ok(html.includes(result) && html.includes(value), `${name}.${fn} displays ${result} with ${value}`);
    assert.doesNotMatch(html, /対象物の指示|渡した画像|返った検出結果/);
  }
});

test('a segmentation point prompt shows its coordinates and mask without a missing text prompt', () => {
  const r = new Rec();
  r.episodeStart();
  const api = r.apiStart(r.blockStart(null), 'segment_sam2_point_prompt');
  const service = r.serviceStart(api, 'sam2', 'sam2_point_prompt_fn');
  service.data = { ...service.data as Record<string, unknown>, request_summary: { point_coords: [41, 28] } };
  service.artifacts = [{ path: 'assets/camera.png', mime: 'image/png', label: 'perception_input', written: true }];
  r.serviceEnd(service, { response_summary: { mask: { npz: 'assets/mask.npz' } } });
  const p = props(r, service.event_id);
  const html = renderToStaticMarkup(<InputOutputTab {...p}/>);
  assert.equal(processTitle(p.selection.node), '指定した点から対象物の範囲を求める');
  assert.match(html, /指定した点の座標.*\[41, 28\]/);
  assert.match(html, /assets\/camera\.png/);
  assert.match(html, /data-recorded-array="assets\/mask\.npz"/);
  assert.doesNotMatch(html, /対象物の指示|未記録/);
});

test('an unknown service function displays recorded inputs and output files without inferring segmentation', () => {
  const r = new Rec();
  r.episodeStart();
  const api = r.apiStart(r.blockStart(null), 'custom_call');
  const service = r.serviceStart(api, 'sam3', 'calibrate');
  service.data = { ...service.data as Record<string, unknown>, request_summary: { gain: 2.15 } };
  r.serviceEnd(service).artifacts = [{ path: 'assets/calibration.npz', label: 'perception_output', written: true }];
  const p = props(r, service.event_id);
  const html = renderToStaticMarkup(<InputOutputTab {...p}/>);
  assert.equal(processTitle(p.selection.node), 'calibrate を呼び出す');
  assert.match(html, /記録された入力.*gain.*2\.15/);
  assert.match(html, /記録された出力.*assets\/calibration\.npz/);
  assert.doesNotMatch(html, /対象物の指示|渡した画像|data-recorded-array|未記録/);
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
  assert.match(second,/出典は保存されたモデル応答です。/);
  assert.match(second,/実行されたPythonへ/);
});

test('model output names the query_model return value for ordinary and VDM calls', () => {
  const r = new Rec();
  for (const role of ['code_generator', 'vdm']) {
    const req = r.request(role, `returned-${role}`);
    r.response(req, 200, 'REPLY', { source: 'query_model_return_value', body_captured: false });
    const html = renderToStaticMarkup(<RecordedModelOutput {...props(r, req.event_id)}/>);
    assert.match(html, /出典は query_model の戻り値です（HTTP 応答本文は保存していません）。/);
    assert.doesNotMatch(html, /出典は保存されたモデル応答です。/);
    if (role === 'vdm') assert.match(html, /VDMの見立て.*評価結果とは別の記録/);
  }
  const vdm = r.request('vdm', 'captured-vdm');
  r.response(vdm);
  const html = renderToStaticMarkup(<RecordedModelOutput {...props(r, vdm.event_id)}/>);
  assert.match(html, /出典: VDMの見立て（モデル応答）。評価結果とは別の記録です。/);
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
