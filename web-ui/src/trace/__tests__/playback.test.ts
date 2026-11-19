import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEpisodeModel } from '../model';
import { cameraForVideo, cameraLabel, mainCameraOf } from '../cameras';
import { cameraVideos, canPlayExecutionVideo, chooseExecutionVideo, cueAt, episodeVideos, groupCues, playbackMap, trialVideos, validClip, videosForEpisode } from '../playback';
import { turnOf } from '../replay';
import type { RunnerMatch } from '../runner';
import { Rec } from './fixtures';
import { dataOf } from '../types';

function recording() {
 const r=new Rec();r.episodeStart();
 r.add('frame',{camera:'main',epoch:0,buffer_index:0,sim_step:0});
 const first=r.request('code_generator','first');first.sim_step=0;first.sim_epoch=0;
 const second=r.request('code_generator','second');second.sim_step=30;second.sim_epoch=0;
 const third=r.request('vdm','third');third.sim_step=30;third.sim_epoch=0;
 r.add('frame',{camera:'main',epoch:0,buffer_index:59,sim_step:59});
 return {r,first,second,third};
}
test('maps simulator frames, not wall-clock inference waits; preserves prompts sharing a video position',()=>{
 const {r}=recording();const m=playbackMap(buildEpisodeModel(r.events),'video_combined.mp4',2);
 assert.equal(m.reason,null);assert.deepEqual(m.prompts.map(c=>c.time),[0,1,1]);
 assert.equal(cueAt(m.prompts,.5)?.node.call?.id,'first');
 assert.equal(cueAt(m.prompts,1)?.node.call?.id,'third');
 assert.equal(cueAt(m.prompts,.1)?.node.call?.id,'first','backward seek must restore earlier prompt');
});

test('preserves evaluations beyond the last frame and unanchored model calls as unsynced records', () => {
  const { r } = recording();
  const summary = r.add('evaluator_result', { scope: 'episode', reward: 1, task_completed: true });
  summary.sim_step = 60;
  summary.sim_epoch = 0;
  const point = r.request('perception_vlm', 'point', 1, { call_kind: 'point' });
  const map = playbackMap(buildEpisodeModel(r.events), 'video_combined.mp4', 2);
  assert.equal(map.reason, null);
  assert.equal(map.all.some(cue => cue.node.primary === summary || cue.node.primary === point), false);
  assert.deepEqual(new Set(map.unsynced.map(node => node.primary)), new Set([summary, point]));
});

test('only a combined video with no positive duration is pending', () => {
  const { r } = recording();
  const model = buildEpisodeModel(r.events);
  for (const duration of [0, NaN]) {
    assert.equal(playbackMap(model, 'video_combined.mp4', duration).pending, true);
    assert.ok(!playbackMap(model, 'video_turn_01.mp4', duration).pending);
  }
  const unknown = playbackMap(model, 'video_combined.mp4', Infinity);
  assert.equal(unknown.pending, false);
  assert.match(unknown.reason ?? '', /動画の長さ/);
  assert.doesNotMatch(unknown.reason ?? '', /読み込み中/);
});

test('groups service calls and turn-anchored worker candidates without dropping co-located events',()=>{
 const {r,second}=recording();
 const member=r.request('code_generator','member',1,{call_kind:'ensemble_member',turn_index:1});
 const synthesis=r.request('code_generator','synthesis',1,{call_kind:'ensemble_synthesis',turn_index:1});
 synthesis.sim_step=30;synthesis.sim_epoch=0;
 const block=r.blockStart(null,'x=1',{turn_index:1});block.sim_step=30;block.sim_epoch=0;
 const api=r.apiStart(block,'segment');api.sim_step=30;api.sim_epoch=0;
 const service=r.serviceStart(api,'sam3','segment');service.sim_step=30;service.sim_epoch=0;
 const m=playbackMap(buildEpisodeModel(r.events),'video_combined.mp4',2);
 const group=groupCues(m.all).find(g=>g.time===1)!;
 assert.ok(group.cues.some(c=>c.node.primary===second));
 assert.ok(group.cues.some(c=>c.node.primary===service));
 assert.equal(group.cues.find(c=>c.node.primary===member)?.positionSource,'turn_synthesis');
 assert.deepEqual(group.cues.map(c=>c.node.seq),[...group.cues.map(c=>c.node.seq)].sort((a,b)=>a-b));
 assert.equal(turnOf(group.cues.find(c=>c.node.primary===service)!.node),1);
 r.request('code_generator','ambiguous-synthesis',1,{call_kind:'ensemble_synthesis',turn_index:1});
 assert.ok(!playbackMap(buildEpisodeModel(r.events),'video_combined.mp4',2).all.some(c=>c.node.primary===member));
});

test('conflicting frame anchors and MP4-only traces never enable synchronization',()=>{
 const {r}=recording();r.add('frame',{camera:'main',epoch:0,buffer_index:0,sim_step:20});
 assert.ok(playbackMap(buildEpisodeModel(r.events),'video_combined.mp4',2).reason);
 assert.ok(playbackMap(buildEpisodeModel([]),'video_combined.mp4',2).reason);
});
test('refuses synchronization for resets, mismatched length and unrecorded cameras',()=>{
 const {r}=recording();let m=buildEpisodeModel(r.events);
 assert.ok(playbackMap(m,'video_combined.mp4',10).reason);
 assert.ok(playbackMap(m,'video_combined_wrist.mp4',2).reason);
 r.add('env_reset',{});m=buildEpisodeModel(r.events);
 assert.ok(playbackMap(m,'video_combined.mp4',2).reason);
});
test('refuses partial recording and nonzero epochs rather than stretching it over a full video',()=>{
 const {r}=recording();dataOf(r.events.find(e=>e.event_type==='frame'), 'frame').buffer_index=12;
 assert.ok(playbackMap(buildEpisodeModel(r.events),'video_combined.mp4',2).reason);
 dataOf(r.events.find(e=>e.event_type==='frame'), 'frame').buffer_index=0;
 dataOf(r.events.find(e=>e.event_type==='frame'), 'frame').epoch=1;
 assert.ok(playbackMap(buildEpisodeModel(r.events),'video_combined.mp4',2).reason);
});
function match():RunnerMatch {
 return {record:{task:'task',condition:'C',artifacts:{trial_dir:'/tmp/runs/run/task/C/trial_1',videos:['/tmp/runs/run/task/C/trial_1/video_combined.mp4']}},isFinal:true,unverified:false,attempt:null,finalAttempt:null,attemptId:1,candidates:1,problem:null};
}
test('video lookup preserves registered root identity, never guesses from seed',()=>{
 const m=match();assert.match(trialVideos('run',m,['/other','/tmp/runs'])[0].url,/root=1$/);
 assert.deepEqual(trialVideos('run',m,['/different']),[]);
 assert.deepEqual(trialVideos('other-run',m,['/tmp/runs']),[]);
});
test('runner artifact lookup accepts safe combined camera MP4s, including trials without a bare combined video',()=>{
 const m=match();m.record!.artifacts={trial_dir:'/tmp/runs/run/task/C/trial_1',videos:[
  '/tmp/runs/run/task/C/trial_1/video_combined_ego.mp4',
  '/tmp/runs/run/task/C/trial_1/video_combined_left_wrist.mp4',
  '/tmp/runs/run/task/C/trial_1/video_combined_right-wrist.mp4',
  '/tmp/runs/run/task/C/trial_1/video_turn_01.mp4',
  '/tmp/runs/run/task/C/trial_1/video_combined_.mp4',
  '/tmp/runs/run/task/C/trial_1/video_combined_../secret.mp4',
  '/tmp/runs/run/task/C/trial_1/video_combined_ego.extra.mp4',
  '/tmp/runs/run/task/C/trial_1/video_combined_頭.mp4',
  '/tmp/runs/run/task/C/trial_1/video_combined.mp4']};
 const names=['video_combined_ego.mp4','video_combined_left_wrist.mp4','video_combined_right-wrist.mp4','video_combined.mp4'];
 assert.deepEqual(trialVideos('run',m,['/tmp/runs']).map(v=>v.name),names);
 (m.record!.artifacts as {videos:string[]}).videos.pop();
 assert.deepEqual(trialVideos('run',m,['/tmp/runs']).map(v=>v.name),names.slice(0,-1));
});
test('earlier and unverified attempts never receive the final attempt video',()=>{
 assert.deepEqual(trialVideos('run',{...match(),isFinal:false},['/tmp/runs']),[]);
 assert.deepEqual(trialVideos('run',{...match(),unverified:true},['/tmp/runs']),[]);
});
test('rejects outside and traversal video paths',()=>{
 const m=match();m.record!.artifacts={trial_dir:'/tmp/runs/run/task/C/trial_1',videos:['/outside/video_combined.mp4','/tmp/runs/run/task/C/trial_1/../video_combined.mp4']};
 assert.deepEqual(trialVideos('run',m,['/tmp/runs']),[]);
});
test('upstream episode videos use only written, declared files and retain turn indexes',()=>{
 const r=new Rec();r.episodeStart();r.episodeEnd();
 r.add('trial_videos',{}, {artifacts:[
  {path:'videos/video_turn_00.mp4',mime:'video/mp4',written:true,turn_index:0},
  {path:'videos/video_combined.mp4',mime:'video/mp4',written:true,turn_index:null},
  {path:'videos/video_turn_01.mp4',mime:'video/mp4',written:false,turn_index:1},
  {path:'videos/../secret.mp4',mime:'video/mp4',written:true},
 ]});
 const videos=episodeVideos({runId:'r',episodeId:'e',generation:'gen'},buildEpisodeModel(r.events));
 assert.deepEqual(videos.map(v=>[v.name,v.turnIndex??null]),[['video_turn_00.mp4',0],['video_combined.mp4',null]]);
 assert.match(videos[0].url,/\/episodes\/e\/file\/videos\/video_turn_00\.mp4/);
 assert.match(videos[0].url,/g=gen/);
});
test('turn lookup uses recorded block indexes across missing events and regeneration',()=>{
 const r=new Rec();r.episodeStart();r.blockStart(null,'a',{block_index:0});
 r.request('code_generator','regeneration');r.blockStart(null,'b',{block_index:2});
 const model=buildEpisodeModel(r.events);
 const videos=[0,1,2].map(i=>({name:`video_turn_0${i}.mp4`,url:`/turn/${i}`,turnIndex:i}));
 assert.equal(chooseExecutionVideo(model.blocks[0],videos).video?.turnIndex,0);
 assert.equal(chooseExecutionVideo(model.blocks[1],videos).video?.turnIndex,2);
 assert.equal(chooseExecutionVideo(model.blocks[1],videos.filter(v=>v.turnIndex!==2)).video,undefined);
 assert.equal(chooseExecutionVideo(model.blocks[1],[...videos.filter(v=>v.turnIndex!==2),{name:'video_combined_main.mp4',url:'/episodes/e/file/combined'}]).video?.name,'video_combined_main.mp4');
 assert.equal(chooseExecutionVideo(model.blocks[1],[...videos.filter(v=>v.turnIndex!==2),
  {name:'video_combined_wrist.mp4',url:'/wrist'},{name:'video_combined_main.mp4',url:'/main'}]).video?.name,'video_combined_main.mp4');
 const unknown=new Rec();unknown.episodeStart();unknown.blockStart(null,'c',{block_index:null});
 assert.equal(chooseExecutionVideo(buildEpisodeModel(unknown.events).blocks[0],videos).video,undefined);
 assert.deepEqual(cameraVideos([...videos,{name:'video_combined_main.mp4',url:'/combined'}]).map(v=>v.name),['video_combined_main.mp4']);
 assert.ok(playbackMap(model,'video_combined_main.mp4',2).reason);
 assert.equal(canPlayExecutionVideo({name:'video_combined_main.mp4',url:'/episodes/e',source:'episode'},false,null),true);
 assert.equal(canPlayExecutionVideo({name:'video_combined.mp4',url:'/legacy',source:'runner'},false,null),false);
 assert.equal(validClip({start:1,end:1}),null);
 assert.equal(validClip({start:2,end:1}),null);
 assert.equal(canPlayExecutionVideo({name:'video_combined.mp4',url:'/episodes/e',source:'episode'},false,validClip({start:1,end:1})),true);
});
test('a runner record with no usable MP4 falls back to copied episode video',()=>{
 const r=new Rec();r.episodeStart();r.episodeEnd();r.add('trial_videos',{}, {artifacts:[{path:'videos/video_combined_wrist.mp4',mime:'video/mp4',written:true,turn_index:null}]});
 const model=buildEpisodeModel(r.events);
 const ep={runId:'run',episodeId:'ep',generation:'new'};
 assert.deepEqual(videosForEpisode(ep,model,{...match(),isFinal:false},['/tmp/runs']).map(v=>v.name),['video_combined_wrist.mp4']);
 assert.match(videosForEpisode(ep,model,{...match(),isFinal:false},['/tmp/runs'])[0].url,/g=new/);
 assert.equal(videosForEpisode(ep,model,match(),['/tmp/runs'])[0].name,'video_combined.mp4');
});
test('a stale turn falls back to the copied combined video',()=>{
 const r=new Rec();r.episodeStart();r.blockStart(null,'turn1',{block_index:1});r.episodeEnd();
 r.add('trial_videos',{}, {artifacts:[
  {path:'videos/video_turn_01.mp4',mime:'video/mp4',written:false,reason:'stale',turn_index:1},
  {path:'videos/video_combined.mp4',mime:'video/mp4',written:true,turn_index:null}]});
 const model=buildEpisodeModel(r.events);
 assert.equal(chooseExecutionVideo(model.blocks[0],episodeVideos({runId:'r',episodeId:'e'},model)).video?.name,'video_combined.mp4');
});

function cameraRecording(cameras: string[], buffers?: string[]) {
 const r=new Rec();r.episodeStart(buffers ? {frames:{cameras:buffers}} : {});
 for(const camera of cameras)r.add('frame',{camera,epoch:0,buffer_index:0,sim_step:0});
 const request=r.request('code_generator','shared');request.sim_step=30;request.sim_epoch=0;
 for(const camera of cameras)r.add('frame',{camera,epoch:0,buffer_index:59,sim_step:59});
 return r;
}

test('combined videos map to recorded main/wrist buffers, single cameras and arbitrary dictionary keys',()=>{
 const libero=buildEpisodeModel(cameraRecording(['robot0_eye_in_hand','agentview'],['agentview','robot0_eye_in_hand']).events);
 assert.equal(mainCameraOf(libero),'agentview','recorded buffer order takes precedence over frame order');
 assert.equal(cameraForVideo(libero,'video_combined.mp4'),'agentview');
 assert.equal(cameraForVideo(libero,'video_combined_wrist.mp4'),'robot0_eye_in_hand');
 const custom=buildEpisodeModel(cameraRecording(['front_custom','hand_custom'],['front_custom','hand_custom']).events);
 assert.equal(cameraForVideo(custom,'video_combined_wrist.mp4'),'hand_custom');
 const dictionary=buildEpisodeModel(cameraRecording(['ego','left_wrist','sensor-7','xhead'],['main']).events);
 assert.equal(mainCameraOf(dictionary),'ego','dictionary cameras use first recorded frame order, never a fixed key');
 for(const camera of ['ego','left_wrist','sensor-7'])assert.equal(cameraForVideo(dictionary,`video_combined_${camera}.mp4`),camera);
 assert.equal(cameraForVideo(dictionary,'video_combined_-head.mp4'),'xhead','dictionary keys use recorder sanitization');
 const single=buildEpisodeModel(cameraRecording(['robot0_robotview']).events);
 assert.equal(cameraForVideo(single,'video_combined.mp4'),'robot0_robotview');
 const legacyWrist=buildEpisodeModel(cameraRecording(['agentview','robot0_eye_in_hand']).events);
 assert.equal(cameraForVideo(legacyWrist,'video_combined_wrist.mp4'),'robot0_eye_in_hand');
 for(const name of ['video_combined_unknown.mp4','video_turn_00.mp4','video_combined_../ego.mp4'])assert.equal(cameraForVideo(dictionary,name),null);
 assert.equal(cameraForVideo(buildEpisodeModel([]),'video_combined.mp4'),null);
});

test('camera labels are Japanese with unknown raw names preserved',()=>{
 assert.deepEqual(['agentview','robot0_robotview','robot0_eye_in_hand','ego','head','left_wrist','right_wrist','sensor-7'].map(cameraLabel),
  ['正面','ロボット視点','手先','頭','頭','左手首','右手首','sensor-7']);
});

test('two and three camera videos synchronize from their own camera anchors',()=>{
 for(const cameras of [['agentview','robot0_eye_in_hand'],['ego','left_wrist','right_wrist']]){
  const r=cameraRecording(cameras,cameras.length===2?cameras:['main']);
  const model=buildEpisodeModel(r.events);
  const names=cameras.length===2?['video_combined.mp4','video_combined_wrist.mp4']:cameras.map(camera=>`video_combined_${camera}.mp4`);
  for(const name of names){
   const map=playbackMap(model,name,2);
   assert.equal(map.reason,null,name);assert.equal(map.prompts[0].time,1,name);
  }
  // Another camera's different mapping does not invalidate an explicit match.
  const last=r.events.find(e=>e.event_type==='frame' && dataOf(e,'frame').camera===cameras.at(-1) && dataOf(e,'frame').buffer_index===59)!;
  dataOf(last,'frame').sim_step=118;
  assert.equal(playbackMap(buildEpisodeModel(r.events),names[0],2).prompts[0].time,1);
  assert.equal(playbackMap(buildEpisodeModel(r.events),names.at(-1)!,2).prompts[0].time,.5);
 }
});

test('missing or unusable mapped camera frames may borrow only identical anchors across the remaining cameras',()=>{
 for(const cameras of [['left_wrist','right_wrist'],['ego','left_wrist','right_wrist']]){
  const r=cameraRecording(cameras,['missing_main']);
  let model=buildEpisodeModel(r.events);
  assert.equal(cameraForVideo(model,'video_combined.mp4'),'missing_main');
  assert.equal(playbackMap(model,'video_combined.mp4',2).prompts[0].time,1);
  r.add('frame',{camera:'missing_main',epoch:0,buffer_index:0,sim_step:null});
  assert.equal(playbackMap(buildEpisodeModel(r.events),'video_combined.mp4',2).reason,null);
  const last=r.events.find(e=>e.event_type==='frame' && dataOf(e,'frame').camera===cameras.at(-1) && dataOf(e,'frame').buffer_index===59)!;
  dataOf(last,'frame').sim_step=58;
  model=buildEpisodeModel(r.events);
  assert.match(playbackMap(model,'video_combined.mp4',2).reason??'',/一意に対応/);
 }
 const wrist=cameraRecording(['agentview'],['agentview','hand_custom']);
 assert.equal(playbackMap(buildEpisodeModel(wrist.events),'video_combined_wrist.mp4',2).reason,null);
});

test('multiple cameras retain epoch, reset, duplicate, monotonicity, duration and partial-anchor safeguards',()=>{
 const cameras=['ego','left_wrist','right_wrist'];
 for(const failure of ['epoch','reset','duplicate','monotonic','duration','partial']){
  const r=cameraRecording(cameras,['main']);
  const frames=r.events.filter(e=>e.event_type==='frame' && dataOf(e,'frame').camera==='ego');
  if(failure==='epoch')dataOf(frames[0],'frame').epoch=1;
  if(failure==='reset')r.add('env_reset',{});
  if(failure==='duplicate')r.add('frame',{camera:'ego',epoch:0,buffer_index:0,sim_step:3});
  if(failure==='monotonic')dataOf(frames[1],'frame').sim_step=-1;
  if(failure==='partial')dataOf(frames[0],'frame').buffer_index=3;
  assert.ok(playbackMap(buildEpisodeModel(r.events),'video_combined_ego.mp4',failure==='duration'?4:2).reason,failure);
 }
 // A partially recorded selected camera is never replaced by a better one.
 const partial=cameraRecording(['agentview','robot0_eye_in_hand'],['agentview','robot0_eye_in_hand']);
 partial.events=partial.events.filter(e=>!(e.event_type==='frame' && dataOf(e,'frame').camera==='robot0_eye_in_hand' && dataOf(e,'frame').buffer_index===59));
 assert.match(playbackMap(buildEpisodeModel(partial.events),'video_combined_wrist.mp4',2).reason??'',/フレーム記録が不足/);
});
