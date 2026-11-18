import test from 'node:test';
import assert from 'node:assert/strict';
import { advance, findAll, popState, propsOf, resetBrowser, setLocation } from './harness/browser';
import { mount } from './harness/fakeReact';
import { buildEpisodeModel } from '../model';
import { VideoPlayback } from '../components/VideoPlayback';
import { ApiPythonPanel } from '../components/ApiPythonPanel';
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

function watchProcessScroll(p: ReturnType<typeof player>): number[] {
  const list = findAll(p.page.output, 'div').find(el => el.props['aria-label'] === '記録された処理');
  if (!list) throw new Error('missing process list');
  const positions: number[] = [];
  (list.props.ref as { current: unknown }).current = {
    set scrollTop(value: number) { positions.push(value); },
    querySelector: (selector: string) => selector === '[data-current="true"]' && p.current().length > 0
      ? { offsetTop: 90, clientHeight: 20 } : null,
    clientHeight: 100,
  };
  return positions;
}

async function changeSelect(p: ReturnType<typeof player>, label: string, value: string) {
  const select = findAll(p.page.output, 'select').find(el => el.props['aria-label'] === label);
  if (!select) throw new Error(`missing select: ${label}`);
  (select.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
  await advance(0);
}

test('the legacy process list centers on selection, turn and visibility changes while preserving manual scroll on trace updates', async () => {
  resetBrowser();
  const rec = recording();
  const p = player({ model: rec.model, videos: [{ name: 'video_combined.mp4', url: '/video' }],
    initialKey: rec.sam.key, logPanel: 'recorded logs', onSelect: () => {} });
  const positions = watchProcessScroll(p);
  const toggleLogs = async (label: string) => {
    const button = findAll(p.page.output, 'button').find(el => el.props.children === label);
    if (!button) throw new Error(`missing button: ${label}`);
    (button.props.onClick as () => void)();
    await advance(0);
  };
  try {
    await p.metadata();
    assert.deepEqual(positions, [50]);

    const warning = { ...rec.tail.primary, event_id: 'extra-warning', seq: rec.tail.seq + 1, event_type: 'trace_warning' };
    const model = buildEpisodeModel([...rec.model.events, warning]);
    p.page.update({ ...p.page.props, model });
    await advance(0);
    assert.equal(positions.length, 1, 'a trace update with the same selection leaves the list where the user scrolled');

    p.page.update({ ...p.page.props, initialKey: rec.code.key });
    await advance(0);
    assert.equal(positions.length, 2);
    await changeSelect(p, 'リプレイのターン', '1');
    assert.equal(positions.length, 3);
    await toggleLogs('詳細ログ');
    assert.equal(positions.length, 3);
    await toggleLogs('処理タイムライン');
    assert.equal(positions.length, 4);
  } finally {
    p.page.unmount();
  }
});

test('a selected process row that appears after video metadata is centered once', async () => {
  resetBrowser();
  const rec = recording();
  const p = player({ model: rec.model, videos: [{ name: 'video_combined.mp4', url: '/video' }], onSelect: () => {} });
  const positions = watchProcessScroll(p);
  try {
    p.page.update({ ...p.page.props, initialKey: rec.sam.key });
    await advance(0);
    assert.equal(p.current().length, 0);
    assert.equal(positions.length, 0);
    await p.metadata();
    assert.equal(p.current()[0].props['data-replay-key'], rec.sam.key);
    assert.deepEqual(positions, [50]);
  } finally {
    p.page.unmount();
  }
});

function turnRecording() {
  const rec = new Rec();
  rec.episodeStart();
  rec.blockStart(null, 'x = 0', { block_index: 0, turn_index: 0 });
  rec.blockStart(null, 'x = 1', { block_index: 1, turn_index: 1 });
  const videos = [0, 1].map(turnIndex => ({ name: `video_turn_0${turnIndex}.mp4`, url: `/turn${turnIndex}`, turnIndex }));
  return { model: buildEpisodeModel(rec.events), videos };
}

test('selecting a turn with a recorded process keeps automatic recording selection available', async () => {
  resetBrowser();
  const { model, videos } = turnRecording();
  const [first, second] = model.blocks;
  const selections: string[] = [];
  const p = player({ model, videos, initialKey: first.key, onSelect: node => selections.push(node.key) });
  try {
    await p.metadata();
    await changeSelect(p, 'リプレイのターン', '1');
    assert.deepEqual(selections, [second.key]);
    p.page.update({ ...p.page.props, initialKey: second.key });
    await advance(0);
    assert.equal(p.video().props.src, '/turn1');

    // A selection from a detail link or URL goes through the same parent prop.
    p.page.update({ ...p.page.props, initialKey: first.key });
    await advance(0);
    assert.equal(p.video().props.src, '/turn0');
  } finally {
    p.page.unmount();
  }
});

test('selecting a turn without an API selects its recorded Python block', async () => {
  resetBrowser();
  const { model, videos } = turnRecording();
  const selections: string[] = [];
  const p = player({ model, videos, ep: { runId: 'run', episodeId: 'ep' }, initialKey: model.blocks[0].key,
    onSelect: node => selections.push(node.key) });
  try {
    await changeSelect(p, 'リプレイのターン', '1');
    assert.deepEqual(selections, [model.blocks[1].key]);
    p.page.update({ ...p.page.props, initialKey: selections[0] });
    await advance(0);
    assert.equal(p.video().props.src, '/turn1');
  } finally {
    p.page.unmount();
  }
});

test('the process list waits for combined video metadata and shows unsynced rows for an unknown duration', async () => {
  resetBrowser();
  const { model } = recording();
  const p = player({ model, videos: [{ name: 'video_combined.mp4', url: '/video' }], onSelect: () => {} });
  const status = () => findAll(p.page.output, 'div').find(el => el.props.role === 'status')?.props.children;
  const unsyncedRows = () => findAll(p.page.output, 'button').filter(el => el.props['data-replay-sync'] === 'unmapped');
  const hasEmptyMessage = () => findAll(p.page.output, 'p').some(el => el.props.children === 'この表示条件に該当する処理の記録はありません。');
  try {
    assert.equal(status(), '動画を読み込み中です。');
    assert.equal(unsyncedRows().length, 0);
    p.media.duration = NaN;
    await p.metadata();
    assert.equal(status(), '動画を読み込み中です。');
    assert.equal(unsyncedRows().length, 0);
    assert.equal(hasEmptyMessage(), false);

    p.media.duration = Infinity;
    await p.metadata();
    assert.match(String(status()), /同期情報なし.*動画の長さ/);
    assert.doesNotMatch(String(status()), /読み込み中/);
    assert.ok(unsyncedRows().length > 0);
  } finally {
    p.page.unmount();
  }
});

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

test('picking another trial opens its default API/Python view and clears the previous selection and seek',async()=>{
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
  assert.equal(media.ep.episodeId,'e2');
  const pane = mount(MediaPane, { ...media, videos: [{ name: 'video_combined.mp4', url: '/video' }] });
  const video = mount(VideoPlayback, propsOf<PlayerProps>(pane.output, VideoPlayback));
  assert.equal(findAll(video.output, 'select').some(element => element.props['aria-label'] === '表示する処理'), false);
  assert.equal(findAll(video.output, ApiPythonPanel).length, 1);
  video.unmount(); pane.unmount();
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
