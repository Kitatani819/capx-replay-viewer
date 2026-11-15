import test from 'node:test';
import assert from 'node:assert/strict';
import { advance, findAll, popState, propsOf, resetBrowser, setLocation } from './harness/browser';
import { mount } from './harness/fakeReact';
import { buildEpisodeModel } from '../model';
import { VideoPlayback } from '../components/VideoPlayback';
import { MediaPane } from '../components/MediaPane';
import { TopBar } from '../components/TopBar';
import { DetailTabs } from '../components/DetailTabs';
import { Picker } from '../components/Picker';
import TraceViewerPage from '../TraceViewerPage';
import { Rec } from './fixtures';
import { addEpisode, ev, makeRun, serve } from './pageServer';

type PlayerProps=Parameters<typeof VideoPlayback>[0];
type MediaProps=Parameters<typeof MediaPane>[0];
type BarProps=Parameters<typeof TopBar>[0];
type DetailsProps=Parameters<typeof DetailTabs>[0];

function recording() {
  const r=new Rec();r.episodeStart();
  r.add('frame',{camera:'main',epoch:0,buffer_index:0,sim_step:0});
  const candidate=r.request('code_generator','candidate',1,{call_kind:'ensemble_member',turn_index:0});
  candidate.sim_step=0;candidate.sim_epoch=0;
  const sam=r.add('service_call_start',{service:'sam3',service_call_id:'sam',turn_index:0,request_summary:{text_prompt:'red cube'}});
  sam.sim_step=0;sam.sim_epoch=0;
  r.add('service_call_end',{service_call_id:'sam'},{parent:sam.event_id});
  const code=r.blockStart(null,'x=1',{turn_index:1});code.sim_step=30;code.sim_epoch=0;
  r.add('frame',{camera:'main',epoch:0,buffer_index:59,sim_step:59});
  const tail=r.add('trial_videos',{});
  const model=buildEpisodeModel(r.events);
  return {model,sam:model.nodeOfEvent.get(sam.event_id)!,code:model.nodeOfEvent.get(code.event_id)!,tail:model.nodeOfEvent.get(tail.event_id)!};
}

function player(props:PlayerProps) {
  const page=mount(VideoPlayback,props);
  const media={duration:2,currentTime:0,playbackRate:1,pauses:0,pause(){this.pauses++;},play(){return Promise.resolve();}};
  const video=()=>findAll(page.output,'video')[0];
  (video().props.ref as {current:unknown}).current=media;
  const metadata=async()=>{(video().props.onLoadedMetadata as Function)({currentTarget:media});await advance(0);};
  const current=()=>findAll(page.output,'button').filter(row=>row.props['data-current']===true);
  return {page,media,video,metadata,current};
}

test('archived replay initializes the parent with the current-position cue, never a local-only highlight',async()=>{
  resetBrowser();const rec=recording();const chosen:string[]=[];
  const props:PlayerProps={model:rec.model,videos:[{name:'video_combined.mp4',url:'/video'}],initialKey:null,
    allowInitialSelection:true,onSelect:node=>chosen.push(node.key)};
  const p=player(props);assert.equal(p.current().length,0);
  await p.metadata();assert.deepEqual(chosen,[rec.sam.key]);
  assert.equal(p.current().length,0,'the parent must accept the same selection before it is highlighted');
  p.page.update({...props,initialKey:rec.sam.key,allowInitialSelection:false});await advance(0);
  assert.equal(p.current()[0].props['data-replay-key'],rec.sam.key);
  p.page.unmount();
});

test('explicit mapped and non-mapped event URLs are not replaced by a playback default',async()=>{
  for(const mapped of [true,false]) {
    resetBrowser();const rec=recording();const chosen:string[]=[];
    const node=mapped?rec.code:rec.tail;
    const p=player({model:rec.model,videos:[{name:'video_combined.mp4',url:'/video'}],initialKey:node.key,
      allowInitialSelection:false,onSelect:n=>chosen.push(n.key)});
    await p.metadata();assert.deepEqual(chosen,[]);
    assert.equal(p.current().length,mapped?1:0);
    if(mapped){assert.equal(p.current()[0].props['data-replay-key'],rec.code.key);assert.equal(p.media.currentTime,1);}
    p.page.unmount();
  }
});

test('Live interrupts playback following; explicit replay interaction may leave Live without feedback loops',async()=>{
  resetBrowser();const rec=recording();const chosen:string[]=[];let interactions=0;
  const props:PlayerProps={model:rec.model,videos:[{name:'video_combined.mp4',url:'/video'}],initialKey:rec.sam.key,
    onSelect:n=>chosen.push(n.key),onInteract:()=>interactions++};
  const p=player(props);await p.metadata();
  p.media.currentTime=1;(p.video().props.onPlay as Function)();
  (p.video().props.onTimeUpdate as Function)({currentTarget:p.media});await advance(0);
  assert.equal(chosen.at(-1),rec.code.key);assert.equal(interactions,1);
  p.page.update({...props,initialKey:rec.tail.key,liveMode:true});await advance(0);
  const count=chosen.length;
  p.media.currentTime=0;(p.video().props.onTimeUpdate as Function)({currentTarget:p.media});await advance(0);
  assert.equal(chosen.length,count,'Live owns the selected event, even if timeupdate arrives');
  assert.equal(p.current().length,0,'non-mapped Live tail cannot highlight an unrelated video cue');
  assert.ok(p.media.pauses>0);p.page.unmount();
});

test('external mapped and unmapped URL changes interrupt active playback without mistaking its own updates',async()=>{
  for(const mapped of [true,false]) {
    resetBrowser();const rec=recording();const chosen:string[]=[];
    const props:PlayerProps={model:rec.model,videos:[{name:'video_combined.mp4',url:'/video'}],initialKey:rec.sam.key,onSelect:n=>chosen.push(n.key)};
    const p=player(props);await p.metadata();
    const beforePlay=p.media.pauses;
    p.media.currentTime=1;(p.video().props.onPlay as Function)();
    (p.video().props.onTimeUpdate as Function)({currentTarget:p.media});await advance(0);
    assert.equal(chosen.at(-1),rec.code.key);
    p.page.update({...props,initialKey:rec.code.key});await advance(0);
    assert.equal(p.media.pauses,beforePlay,'accepting a playback-driven selection must not stop playback');
    const incoming=mapped?rec.sam:rec.tail;
    p.page.update({...props,initialKey:incoming.key});await advance(0);
    assert.ok(p.media.pauses>beforePlay,'history/URL selection pauses the player');
    assert.equal(p.media.currentTime,mapped?0:1);
    assert.equal(p.current().length,mapped?1:0);
    const count=chosen.length;
    p.media.currentTime=.5;(p.video().props.onTimeUpdate as Function)({currentTarget:p.media});await advance(0);
    assert.equal(chosen.length,count,'a late timeupdate cannot overwrite the external event');
    p.page.unmount();
  }
});

test('external event selection follows an active turn filter while an all-turns choice stays all',async()=>{
  resetBrowser();const rec=recording();
  const props:PlayerProps={model:rec.model,videos:[{name:'video_combined.mp4',url:'/video'}],initialKey:rec.sam.key,onSelect:()=>{}};
  const p=player(props);await p.metadata();
  const select=()=>findAll(p.page.output,'select').find(el=>el.props['aria-label']==='リプレイのターン')!;
  (select().props.onChange as Function)({target:{value:'1'}});await advance(0);
  assert.equal(select().props.value,1);
  (select().props.onChange as Function)({target:{value:'all'}});await advance(0);
  assert.equal(select().props.value,'all','the first cue must not silently re-enable the turn filter');
  (select().props.onChange as Function)({target:{value:'1'}});await advance(0);
  p.page.update({...props,initialKey:rec.code.key});await advance(0);
  p.page.update({...props,initialKey:rec.sam.key});await advance(0);
  assert.equal(select().props.value,0);
  assert.equal(p.current()[0].props['data-replay-key'],rec.sam.key);
  p.page.unmount();
});

test('page defers archived selection to the mapped player and preserves explicit tail URLs',async()=>{
  for(const explicit of [false,true]) {
    resetBrowser();const run=makeRun();
    addEpisode(run,'e1',{status:'ended',trace_complete:true},[
      ev('e1',1,'episode_start',{}),ev('e1',2,'code_block_start',{code_block_id:'e1_2',code:'x=1'}),
      ev('e1',3,'trial_videos',{}),
    ]);serve(run);setLocation(`/traces?view=details&run=r1&episode=e1${explicit?'&event=e1_3':''}`);
    const page=mount(TraceViewerPage,{});await advance(1000);
    const media=propsOf<MediaProps>(page.output,MediaPane);
    assert.equal(media.allowReplayInitialSelection,!explicit);
    assert.equal(media.selection?.eventId??null,explicit?'e1_3':null);
    if(!explicit){media.onPlaybackSelect!(media.model.blocks[0],true);await advance(0);assert.equal(propsOf<DetailsProps>(page.output,DetailTabs).selection?.eventId,'e1_2');}
    page.unmount();
  }
});

test('running page keeps Live tail ownership until replay interaction, and can resume Live',async()=>{
  resetBrowser();const run=makeRun();
  const episode=addEpisode(run,'e1',{status:'running'},[ev('e1',1,'episode_start',{}),ev('e1',2,'trace_warning',{message:'latest'})]);
  serve(run);setLocation('/traces?view=details&run=r1&episode=e1');
  const page=mount(TraceViewerPage,{});await advance(1000);
  assert.equal(propsOf<BarProps>(page.output,TopBar).live,true);
  assert.equal(propsOf<MediaProps>(page.output,MediaPane).replayLive,true);
  assert.equal(propsOf<MediaProps>(page.output,MediaPane).allowReplayInitialSelection,false);
  assert.equal(propsOf<DetailsProps>(page.output,DetailTabs).selection?.eventId,'e1_2');
  propsOf<MediaProps>(page.output,MediaPane).onReplayInteract!();await advance(0);
  assert.equal(propsOf<BarProps>(page.output,TopBar).live,false);
  episode.events.push(ev('e1',3,'trace_warning',{message:'new tail'}));
  propsOf<BarProps>(page.output,TopBar).onLive(true);await advance(1500);
  assert.equal(propsOf<DetailsProps>(page.output,DetailTabs).selection?.eventId,'e1_3');
  assert.equal(propsOf<MediaProps>(page.output,MediaPane).replayLive,true);
  page.unmount();
});

test('picking another trial discards a previous trial manual seek before choosing its default',async()=>{
  resetBrowser();const run=makeRun();
  for(const id of ['e1','e2'])addEpisode(run,id,{status:'ended'},[
    ev(id,1,'episode_start',{}),ev(id,2,'code_block_start',{code_block_id:`${id}_2`,code:'x=1'}),
  ]);
  serve(run);setLocation('/traces?view=details&run=r1&episode=e1&event=e1_2');
  const page=mount(TraceViewerPage,{});await advance(1000);
  const detail=propsOf<DetailsProps>(page.output,DetailTabs);
  detail.onSelect(detail.model.blocks[0]);await advance(0);
  assert.ok(propsOf<MediaProps>(page.output,MediaPane).seekRequest);
  propsOf<BarProps>(page.output,TopBar).onOpenPicker();await advance(0);
  propsOf<Parameters<typeof Picker>[0]>(page.output,Picker).onPick('r1','e2');await advance(1000);
  const media=propsOf<MediaProps>(page.output,MediaPane);
  assert.equal(media.seekRequest,null);
  assert.equal(media.selection,null);
  assert.equal(media.allowReplayInitialSelection,true);
  page.unmount();
});

test('history navigation to an explicit event leaves Live and preserves that URL selection',async()=>{
  resetBrowser();const run=makeRun();
  const episode=addEpisode(run,'e1',{status:'running'},[
    ev('e1',1,'episode_start',{}),ev('e1',2,'trace_warning',{message:'tail'}),
  ]);
  serve(run);setLocation('/traces?view=details&run=r1&episode=e1');
  const page=mount(TraceViewerPage,{});await advance(1000);
  assert.equal(propsOf<BarProps>(page.output,TopBar).live,true);
  popState('/traces?view=details&run=r1&episode=e1&event=e1_1');await advance(0);
  assert.equal(propsOf<BarProps>(page.output,TopBar).live,false);
  assert.equal(propsOf<DetailsProps>(page.output,DetailTabs).selection?.eventId,'e1_1');
  episode.events.push(ev('e1',3,'trace_warning',{message:'new tail'}));await advance(1500);
  assert.equal(propsOf<DetailsProps>(page.output,DetailTabs).selection?.eventId,'e1_1');
  page.unmount();
});
