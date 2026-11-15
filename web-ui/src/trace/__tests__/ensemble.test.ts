import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEpisodeModel, resolveSelection } from '../model';
import { candidateStatus, candidateTemperature, ensembleForTurn, inputFingerprint, responseKind, synthesisMembership, type EnsembleEvidence } from '../ensemble';
import { dataAssetTargets } from '../dataAsset';
import { Rec } from './fixtures';

test('uses recorded turn and logical call identities, preserving failed, cut and retried candidates',()=>{
  const r=new Rec();r.episodeStart();
  const a=r.request('code_generator','a',1,{call_kind:'ensemble_member',turn_index:1,params:{temperature:.1}});
  r.attemptError(a,503);
  const retry=r.request('code_generator','a',2,{call_kind:'ensemble_member',turn_index:1,params:{temperature:.1}});r.response(retry);
  const b=r.request('code_generator','b',1,{call_kind:'ensemble_member',turn_index:1});r.response(b,200,'partial',{finish_reason:'length'});
  const c=r.request('code_generator','c',1,{call_kind:'ensemble_member',turn_index:1});r.logicalError(c,'GeneratorExit','stopped',{partial_content:'part'});
  const err=r.request('code_generator','err',1,{call_kind:'ensemble_member',turn_index:1});r.logicalError(err,'TimeoutError','timeout');
  r.request('code_generator','s',1,{call_kind:'ensemble_synthesis',turn_index:1});
  r.request('code_generator','other-turn',1,{call_kind:'ensemble_member',turn_index:2});
  r.request('code_generator','unknown',1,{call_kind:'ensemble_member',turn_index:null});
  const model=buildEpisodeModel(r.events), result=ensembleForTurn(model,1);
  assert.equal(result.members.length,4);assert.equal(result.syntheses.length,1);
  assert.deepEqual(result.members.map(candidateStatus),['回答あり','途中打ち切り（トークン上限）','途中打ち切り（ストリーム中断）','エラー']);
  assert.equal(candidateTemperature(result.members[0]),.1);
  assert.equal(ensembleForTurn(model,null).members.length,0);
});

test('shares only identical messages, including images and logs; temperature is per candidate',()=>{
  const messages=[{role:'user',content:[{type:'text',text:'log'}, {type:'image_url',image_url:{$asset:'a.png'}}]}];
  assert.equal(inputFingerprint({messages,temperature:.1}),inputFingerprint({temperature:.9,messages}));
  assert.notEqual(inputFingerprint({messages}),inputFingerprint({messages:[{role:'user',content:'different log'}]}));
  assert.notEqual(inputFingerprint({messages}),inputFingerprint({messages:[{role:'user',content:[{type:'image_url',image_url:{$asset:'b.png'}}]}]}));
  assert.equal(inputFingerprint({}),null);
});

test('synthesis membership requires whole response, matching temperature and unique identity',()=>{
  const r=new Rec();r.episodeStart();
  r.request('code_generator','a',1,{call_kind:'ensemble_member',turn_index:1,params:{temperature:.1}});
  r.request('code_generator','b',1,{call_kind:'ensemble_member',turn_index:1,params:{temperature:.2}});
  const members=ensembleForTurn(buildEpisodeModel(r.events),1).members;
  const ev:EnsembleEvidence={payload:null,answer:'print(1)',answerComplete:true,error:null};
  const evidence=new Map([['a',ev],['b',{...ev,answer:'print(2)'}]]);
  const payload={messages:[{role:'user',content:'<candidate_solutions>\n--- Candidate (temp=0.1) ---\nprint(1)\n</candidate_solutions>'}]};
  assert.equal(synthesisMembership(members[0],members,evidence,payload),'統合入力に全文一致（送信を確認）');
  assert.equal(synthesisMembership(members[1],members,evidence,payload),'統合入力に全文一致なし');
  evidence.set('a',{...ev,answer:'print',answerComplete:false});
  assert.match(synthesisMembership(members[0],members,evidence,payload),/未確認/);
  evidence.set('a',ev);
  assert.match(synthesisMembership(members[0],members,evidence,null),/未確認/);
  const duplicate={...members[0],id:'duplicate'};evidence.set('duplicate',ev);
  assert.match(synthesisMembership(members[0],[...members,duplicate],evidence,payload),/同文候補/);
});

test('distinguishes model decisions from code strings and does not infer FINISH from an empty answer',()=>{
  assert.equal(responseKind('```python\nprint("FINISH")\n```'),'Pythonコード');
  assert.equal(responseKind('Reasoning first\n**REGENERATE**\n```python\nx=1\n```'),'REGENERATE（修正）');
  assert.equal(responseKind('FINISH. No need to REGENERATE.'),'FINISH（終了・モデルの主張）');
  assert.match(responseKind(''),/未判定/);assert.match(responseKind('FINISH',false),/未確認/);
});

test('loads oversize data for every candidate and synthesis of the selected turn only',()=>{
  const r=new Rec();r.episodeStart();
  const a=r.request('code_generator','a',1,{call_kind:'ensemble_member',turn_index:1});
  const b=r.request('code_generator','b',1,{call_kind:'ensemble_member',turn_index:1,oversize:true,data_asset:'b.json.gz',data_asset_written:true});
  const c=r.request('code_generator','c',1,{call_kind:'ensemble_synthesis',turn_index:1,oversize:true,data_asset:'c.json.gz',data_asset_written:true});
  r.request('code_generator','d',1,{call_kind:'ensemble_member',turn_index:2,oversize:true,data_asset:'d.json.gz',data_asset_written:true});
  const model=buildEpisodeModel(r.events);
  const targets=dataAssetTargets(model,resolveSelection(model,a.event_id));
  assert.ok(targets.some(e=>e.event_id===b.event_id));assert.ok(targets.some(e=>e.event_id===c.event_id));
  assert.ok(!targets.some(e=>(e.data as {data_asset?:string}).data_asset==='d.json.gz'));
});
