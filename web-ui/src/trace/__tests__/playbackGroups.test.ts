import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEpisodeModel } from '../model';
import { playbackMap, primaryPlaybackCues } from '../playback';
import { Rec } from './fixtures';

test('collapsed candidates count recorded logical calls per frame and turn, excluding retries',()=>{
  const r=new Rec();r.episodeStart();
  r.add('frame',{camera:'main',epoch:0,buffer_index:0,sim_step:0});
  for(const [turn,count,step] of [[1,9,15],[2,3,15],[1,2,30]]) {
    for(let i=0;i<count;i++) {
      const id=`member-${turn}-${step}-${i}`;
      const request=r.request('code_generator',id,1,{call_kind:'ensemble_member',turn_index:turn});
      request.sim_step=step;request.sim_epoch=0;
      if(i===0){r.attemptError(request,503);const retry=r.request('code_generator',id,2,{call_kind:'ensemble_member',turn_index:turn});retry.sim_step=step;retry.sim_epoch=0;r.response(retry);}
    }
  }
  r.add('frame',{camera:'main',epoch:0,buffer_index:59,sim_step:59});
  const map=playbackMap(buildEpisodeModel(r.events),'video_combined.mp4',2);
  const main=primaryPlaybackCues(map.all);
  assert.deepEqual(main.map(c=>[c.time,c.node.call?.turnIndex,c.candidateCount]),[[.5,1,9],[.5,2,3],[1,1,2]]);
  assert.equal(map.all.length,14,'all recorded candidates remain individually available');
});
