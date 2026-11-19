import test from 'node:test';
import assert from 'node:assert/strict';
import { advance, findAll, propsOf, resetBrowser } from './harness/browser';
import { mount } from './harness/fakeReact';
import { buildEpisodeModel } from '../model';
import { VideoPlayback } from '../components/VideoPlayback';
import { ApiPythonPanel } from '../components/ApiPythonPanel';
import { Rec } from './fixtures';

function recording(count=3) {
  const r=new Rec();r.episodeStart();
  const cameras=['ego','left_wrist','right_wrist'].slice(0,count);
  for(const camera of cameras)r.add('frame',{camera,epoch:0,buffer_index:0,sim_step:0});
  const block=r.blockStart(null,'APIS.move()',{turn_index:0});block.sim_step=0;block.sim_epoch=0;
  const first=r.apiStart(block,'move');first.sim_step=0;first.sim_epoch=0;
  const second=r.apiStart(block,'observe');second.sim_step=30;second.sim_epoch=0;
  for(const camera of cameras)r.add('frame',{camera,epoch:0,buffer_index:59,sim_step:59});
  const model=buildEpisodeModel(r.events);
  return {model,second:model.nodeOfEvent.get(second.event_id)!,videos:cameras.map(camera=>({name:`video_combined_${camera}.mp4`,url:`/${camera}.mp4`}))};
}

function media() {
  return {duration:2,currentTime:0,playbackRate:.5,readyState:2,paused:true,ended:false,error:null as unknown,
    plays:0,pauses:0,pause(){this.paused=true;this.pauses++;},play(){this.paused=false;this.plays++;return Promise.resolve();}};
}

async function multiPlayer() {
  resetBrowser();const rec=recording();const selections:string[]=[];const cameras:string[]=[];
  const page=mount(VideoPlayback,{model:rec.model,videos:rec.videos,initialKey:rec.second.key,
    ep:{runId:'r',episodeId:'e'},onSelect:(node:{key:string})=>selections.push(node.key),onCameraChange:(camera:string)=>cameras.push(camera)});
  const elements=new Map<string,ReturnType<typeof media>>();
  for(const element of findAll(page.output,'video')) {
    const m=media();elements.set(String(element.props['data-camera']),m);
    (element.props.ref as Function)(m);
  }
  const main=()=>findAll(page.output,'video').find(v=>v.props['data-main-camera']==='true')!;
  const mainMedia=()=>elements.get(String(main().props['data-camera']))!;
  (main().props.onLoadedMetadata as Function)({currentTarget:mainMedia()});await advance(0);
  const button=(label:string)=>findAll(page.output,'button').find(v=>v.props['aria-label']===label || v.props.children===label)!;
  return {page,rec,elements,main,mainMedia,button,selections,cameras};
}

test('three labelled camera videos share the clock, rate, play/pause and correct drift',async()=>{
  const p=await multiPlayer();
  try {
    assert.equal(findAll(p.page.output,'video').length,3);
    assert.deepEqual(findAll(p.page.output,'span').filter(v=>v.props.className==='replay-camera-label').map(v=>[v.props.children,v.props.title]),
      [['頭','ego'],['左手首','left_wrist'],['右手首','right_wrist']]);
    for(const v of findAll(p.page.output,'video')){assert.equal(v.props.muted,true);assert.equal(v.props.playsInline,true);assert.equal(v.props.controls,false);}
    const main=p.mainMedia();main.currentTime=.7;main.playbackRate=2;main.paused=false;
    (p.main().props.onPlay as Function)();await advance(0);
    for(const [camera,m] of p.elements)if(camera!=='ego'){assert.equal(m.currentTime,.7);assert.equal(m.playbackRate,2);assert.equal(m.paused,false);}
    p.elements.get('left_wrist')!.currentTime=.3;
    p.elements.get('right_wrist')!.currentTime=.65;
    (p.main().props.onTimeUpdate as Function)({currentTarget:main});await advance(0);
    assert.equal(p.elements.get('left_wrist')!.currentTime,.7);
    assert.equal(p.elements.get('right_wrist')!.currentTime,.65,'drift below .1 seconds is left alone');
    main.currentTime=1.1;main.paused=true;
    (p.main().props.onSeeked as Function)({currentTarget:main});await advance(0);
    for(const m of p.elements.values()){assert.equal(m.currentTime,1.1);assert.equal(m.paused,true);}
    main.playbackRate=.25;(p.main().props.onRateChange as Function)();
    for(const m of p.elements.values())assert.equal(m.playbackRate,.25);
  }finally{p.page.unmount();}
});

test('swapping the main camera retains playback position, speed, play state and selected API',async()=>{
  for(const playing of [false,true]) {
    const p=await multiPlayer();
    try {
      const old=p.mainMedia();old.currentTime=1.4;old.playbackRate=2;old.paused=!playing;
      const before=p.selections.length;
      (p.button('左手首をメインにする').props.onClick as Function)();await advance(0);
      assert.equal(p.main().props['data-camera'],'left_wrist');
      assert.equal(p.mainMedia().currentTime,1.4);
      assert.equal(p.mainMedia().playbackRate,2);
      assert.equal(p.mainMedia().paused,!playing);
      // A metadata event already queued while this was a thumbnail must not
      // reset the transferred speed when delivered after the role change.
      (p.main().props.onLoadedMetadata as Function)({currentTarget:p.mainMedia()});await advance(0);
      assert.equal(p.mainMedia().playbackRate,2);
      assert.equal(p.mainMedia().currentTime,1.4);
      assert.equal(propsOf<Parameters<typeof ApiPythonPanel>[0]>(p.page.output,ApiPythonPanel).selectedKey,p.rec.second.key);
      assert.equal(p.selections.length,before,'a camera change must not choose an API');
      assert.deepEqual(p.cameras,['left_wrist']);
    }finally{p.page.unmount();}
  }
});

test('the all/single camera switch saves its choice and the single layout has a labelled camera select',async()=>{
  const p=await multiPlayer();
  try {
    (p.button('1台').props.onClick as Function)();await advance(0);
    assert.equal(window.localStorage.getItem('capx.replay.cameraLayout'),'"single"');
    assert.equal(findAll(p.page.output,'div').filter(v=>v.props.className==='replay-camera-view' && v.props.hidden===true).length,2);
    const select=findAll(p.page.output,'select').find(v=>v.props['aria-label']==='録画カメラ')!;
    assert.ok(select);
    (select.props.onChange as Function)({target:{value:'video_combined_right_wrist.mp4'}});await advance(0);
    assert.equal(p.main().props['data-camera'],'right_wrist');
    (p.button('全カメラ').props.onClick as Function)();await advance(0);
    assert.equal(window.localStorage.getItem('capx.replay.cameraLayout'),'"all"');
    assert.equal(findAll(p.page.output,'div').filter(v=>v.props.className==='replay-camera-view' && v.props.hidden===true).length,0);
  }finally{p.page.unmount();}
});

test('an external shared camera change keeps the current position and selected API',async()=>{
  const p=await multiPlayer();
  try {
    p.mainMedia().currentTime=1.4;
    p.page.update({...p.page.props,...{camera:'right_wrist'}});await advance(0);
    assert.equal(p.main().props['data-camera'],'right_wrist');
    assert.equal(p.mainMedia().currentTime,1.4);
    assert.equal(propsOf<Parameters<typeof ApiPythonPanel>[0]>(p.page.output,ApiPythonPanel).selectedKey,p.rec.second.key);
    assert.deepEqual(p.selections,[]);
  }finally{p.page.unmount();}
});

test('a camera that is still loading restores its clock after metadata, and a failed camera shows the read error',async()=>{
  for(const failed of [false,true]) {
    const p=await multiPlayer();
    try {
      p.mainMedia().currentTime=1.4;
      const target=p.elements.get('left_wrist')!;target.readyState=0;
      target.error=failed?{code:4}:null;
      (p.button('左手首をメインにする').props.onClick as Function)();await advance(0);
      if(failed) {
        assert.equal(findAll(p.page.output,'div').find(v=>v.props.role==='status')!.props.children,'動画を読み込めません。');
      }else {
        assert.equal(p.elements.get('ego')!.currentTime,1.4,'an unloaded replacement must not rewind the old clock');
        target.readyState=2;
        (p.main().props.onLoadedMetadata as Function)({currentTarget:target});await advance(0);
        assert.equal(target.currentTime,1.4);
        assert.equal(propsOf<Parameters<typeof ApiPythonPanel>[0]>(p.page.output,ApiPythonPanel).selectedKey,p.rec.second.key);
      }
    }finally{p.page.unmount();}
  }
});

test('a single camera keeps the original player without camera controls or a strip',async()=>{
  resetBrowser();const rec=recording(1);
  const page=mount(VideoPlayback,{model:rec.model,videos:rec.videos,onSelect:()=>{}});
  try {
    assert.equal(findAll(page.output,'video').length,1);
    assert.equal(findAll(page.output,'div').filter(v=>v.props['aria-label']==='カメラの表示').length,0);
    assert.equal(findAll(page.output,'div').filter(v=>v.props.className==='replay-camera-stage').length,0);
    assert.equal(findAll(page.output,'select').some(v=>v.props['aria-label']==='録画カメラ'),false);
    const video=findAll(page.output,'video')[0];assert.equal(video.props['aria-label'],'試行の録画');assert.equal(video.props.preload,'metadata');
  }finally{page.unmount();}
});

test('camera layout remains usable when localStorage throws',async()=>{
  resetBrowser();const storage=window.localStorage;
  Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem(){throw Error('unavailable');},setItem(){throw Error('unavailable');}}});
  const rec=recording();const page=mount(VideoPlayback,{model:rec.model,videos:rec.videos,onSelect:()=>{}});
  try {
    const button=findAll(page.output,'button').find(v=>v.props.children==='1台')!;
    (button.props.onClick as Function)();await advance(0);
    assert.ok(findAll(page.output,'select').some(v=>v.props['aria-label']==='録画カメラ'));
  }finally{page.unmount();Object.defineProperty(window,'localStorage',{configurable:true,value:storage});}
});
