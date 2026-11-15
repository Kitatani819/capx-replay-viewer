/** Bidirectional, frame-based replay using the existing native video player. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { enclosingBlock, nodeTitle, type EpisodeModel, type TNode } from '../model';
import { cameraVideos, chooseExecutionVideo, cueAt, groupCues, playbackMap, type TrialVideo, type PlaybackCue } from '../playback';
import { processLabel, recordedTurns, turnOf } from '../replay';
import { SmallButton } from './common';

export interface ReplaySeek { key: string; token: number }
export function VideoPlayback({model, videos, onSelect, seekRequest, initialKey, simple = false, logPanel}: {
  logPanel?: ReactNode;
  simple?: boolean; model: EpisodeModel; videos: TrialVideo[];
  onSelect: (node:TNode)=>void; seekRequest?: ReplaySeek | null; initialKey?: string | null;
}) {
  const combined = cameraVideos(videos);
  videos = combined.length ? combined : videos;
  const [name,setName]=useState('');
  const initialNode=model.allNodes.find(n=>n.key===initialKey);
  const initialBlock=initialNode ? enclosingBlock(model,initialNode) ?? initialNode.call?.producedBlocks[0] : undefined;
  const preferred=combined.length===0 && initialBlock ? chooseExecutionVideo(initialBlock,videos).video : undefined;
  const chosen=videos.find(v=>v.name===name) ?? preferred ?? videos[0];
  const [duration,setDuration]=useState(0);
  const [time,setTime]=useState(0);
  const [follow,setFollow]=useState(false);
  const [manualKey,setManualKey]=useState<string|null>(null);
  const [mediaError,setMediaError]=useState(false);
  const [mode,setMode]=useState<'all'|'prompts'|'actions'>('all');
  const [showLogs,setShowLogs]=useState(false);
  const [turn,setTurn]=useState<number|null>(null);
  const video=useRef<HTMLVideoElement>(null);
  const list=useRef<HTMLDivElement>(null);
  const selected=useRef<string|null>(null);
  const appliedSeek=useRef<number|null>(null);
  const programmaticSeek=useRef<number|null>(null);
  const initialized=useRef(false);
  const map=useMemo(()=>playbackMap(model,chosen?.name??'',duration),[model,chosen?.name,duration]);
  const turns=useMemo(()=>recordedTurns(model),[model]);
  const cues=map[mode];
  const current=(!follow && manualKey ? map.all.find(c=>c.node.key===manualKey) : null) ?? cueAt(cues,time);
  const visible=cues.filter(c=>turn===null || turnOf(c.node)===turn);
  const groups=groupCues(visible);
  useEffect(()=>{setDuration(0);setTime(0);setMediaError(false);setManualKey(null);setFollow(false);selected.current=null;appliedSeek.current=null;initialized.current=false;},[chosen?.url]);
  const seek=(cue:PlaybackCue)=>{
    initialized.current=true;
    selected.current=cue.node.key;
    setFollow(false);setManualKey(cue.node.key);setTime(cue.time);
    if(video.current){video.current.pause();programmaticSeek.current=cue.time;video.current.currentTime=Math.min(cue.time,duration);}
  };
  // Only manual selections send this token. Playback-driven selections never
  // seek themselves: otherwise timeupdate would repeatedly pause the player.
  useEffect(()=>{
    if(!seekRequest || appliedSeek.current===seekRequest.token)return;
    const cue=map.all.find(c=>c.node.key===seekRequest.key);
    if(!cue){video.current?.pause();setFollow(false);return;}
    appliedSeek.current=seekRequest.token;
    setMode('all');setTurn(turnOf(cue.node));seek(cue);
  },[seekRequest,map]);
  // Respect the selected execution / shared event URL when entering replay.
  // Once the user plays or seeks, only the regular playback flow owns selection.
  useEffect(()=>{
    if(initialized.current || !initialKey)return;
    const cue=map.all.find(c=>c.node.key===initialKey);
    if(cue)seek(cue);
  },[initialKey,map]);
  useEffect(()=>{
    if (!follow || !current || selected.current===current.node.key) return;
    selected.current=current.node.key;
    if(turn!==null)setTurn(turnOf(current.node));
    onSelect(current.node);
  },[current,follow,onSelect,turn]);
  useEffect(()=>{
    const row=list.current?.querySelector<HTMLElement>('[data-current="true"]');
    if(row && list.current) list.current.scrollTop=row.offsetTop-list.current.clientHeight/2+row.clientHeight/2;
  },[current?.node.key]);
  const jump=(cue:PlaybackCue)=>{seek(cue);onSelect(cue.node);};
  const resumeFollow=()=>{initialized.current=true;programmaticSeek.current=null;selected.current=null;setManualKey(null);setFollow(true);};
  if(!chosen)return <div className="p-3 text-xs text-text-tertiary">この試行の動画は見つかりません。「記録フレーム」から保存画像を確認できます。</div>;
  return <div className="h-full min-h-0 flex flex-col p-2 gap-2">
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {videos.length > 1 && <select aria-label="録画カメラ" value={chosen.name} onChange={e=>setName(e.target.value)} className="bg-surface-sunken">{videos.map(v=><option key={v.url}>{v.name}</option>)}</select>}
      <label>ターン <select aria-label="リプレイのターン" value={turn??'all'} onChange={e=>{
        const next=e.target.value==='all'?null:Number(e.target.value);setTurn(next);setMode('all');
        const cue=map.all.find(c=>next===null || turnOf(c.node)===next);
        if(cue)jump(cue);
        else {
          video.current?.pause();setFollow(false);
          const block=model.blocks.find(b=>turnOf(b)===next);
          if(combined.length===0 && block){const v=chooseExecutionVideo(block,videos).video;if(v)setName(v.name);}
          const node=model.allNodes.find(n=>next!==null && turnOf(n)===next);if(node)onSelect(node);
        }
      }} className="bg-surface-sunken"><option value="all">すべて</option>{turns.map(t=><option key={t} value={t}>{t}</option>)}</select></label>
      <SmallButton onClick={()=>{if(video.current){resumeFollow();video.current.pause();video.current.currentTime=Math.max(0,time-2);setTime(video.current.currentTime);}}}>2秒巻き戻す</SmallButton>
      <label><input type="checkbox" checked={follow} onChange={e=>{selected.current=null;setFollow(e.target.checked);}}/> 再生位置に追従</label>
      <select aria-label="動画の再生速度" defaultValue="0.5" onChange={e=>{if(video.current)video.current.playbackRate=Number(e.target.value);}} className="bg-surface-sunken">{[0.25,0.5,1,2].map(x=><option key={x} value={x}>{x}×</option>)}</select>
    </div>
    {(map.reason || mediaError) && <div role="status" className="text-xs text-amber-200">同期情報なし · {mediaError?'動画を読み込めません。':map.reason}</div>}
    <div className="flex flex-col flex-1 min-h-0 gap-2">
      <video key={chosen.url} ref={video} src={chosen.url} controls preload="metadata" aria-label="試行の録画" className={`w-full min-w-0 ${simple ? 'h-full' : 'h-[52%] flex-shrink-0'} object-contain bg-black rounded`}
        onLoadedMetadata={e=>{setDuration(e.currentTarget.duration);e.currentTarget.playbackRate=0.5;}}
        onPlay={resumeFollow}
        onPause={e=>setTime(e.currentTarget.currentTime)}
        onSeeking={e=>{if(programmaticSeek.current===null || Math.abs(e.currentTarget.currentTime-programmaticSeek.current)>.01)resumeFollow();setTime(e.currentTarget.currentTime);}}
        onTimeUpdate={e=>setTime(e.currentTarget.currentTime)}
        onSeeked={e=>{setTime(e.currentTarget.currentTime);programmaticSeek.current=null;}}
        onEnded={()=>setTime(duration)} onError={()=>{setDuration(0);setMediaError(true);}}/>
      {!simple && <div data-replay-log-panel="" className="flex-1 min-h-0 flex flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-surface-border pb-2 text-xs">
          <SmallButton active={!showLogs} onClick={()=>setShowLogs(false)}>処理タイムライン</SmallButton>
          {logPanel && <SmallButton active={showLogs} onClick={()=>setShowLogs(true)}>詳細ログ</SmallButton>}
          {!showLogs && <><SmallButton active={mode==='all'} onClick={()=>setMode('all')}>すべて</SmallButton>
            <SmallButton active={mode==='prompts'} onClick={()=>setMode('prompts')}>プロンプト</SmallButton>
            <SmallButton active={mode==='actions'} onClick={()=>setMode('actions')}>コード・API</SmallButton></>}
        </div>
        <div hidden={!showLogs} className="flex-1 min-h-0">{logPanel}</div>
        <div ref={list} hidden={showLogs} className="relative flex-1 min-w-0 overflow-y-auto" aria-label="動画に対応するイベント">
        {groups.map(g=><section key={g.time} data-replay-time={g.time} className="border-b border-surface-border py-1">
          <h3 className="text-[11px] px-2 py-1 font-mono text-text-tertiary">{g.time.toFixed(2)}s · {g.cues.length}件（記録順）</h3>
          {g.cues.map(c=><button key={c.node.key} data-current={current?.node.key===c.node.key} data-replay-key={c.node.key} data-replay-event={c.node.primary.event_id} aria-pressed={current?.node.key===c.node.key} onClick={()=>jump(c)} className={`flex items-center gap-3 w-full text-left px-2 py-2 text-xs border-l-2 transition-colors ${current?.node.key===c.node.key?'border-accent bg-accent/10':'border-transparent hover:bg-surface-raised'}`}>
            <strong className="w-24 shrink-0 truncate">{processLabel(c.node) || (c.node.kind==='api_call' ? 'API実行' : '処理')}</strong><span className="min-w-0 truncate flex-1" title={nodeTitle(c.node)}>{nodeTitle(c.node)}</span><span className="text-text-tertiary shrink-0">#{c.node.seq} · T{turnOf(c.node)??'?'}{c.positionSource==='turn_synthesis'?' · 統合位置を参照':''}</span>
          </button>)}
        </section>)}
        {!map.reason && visible.length===0 && <p className="text-xs p-2">対応するイベントは未記録です。「詳細ログ」から記録を確認できます。</p>}
        {map.reason && <p className="text-xs p-2">この動画に対応する処理位置は未確認です。「詳細ログ」から保存済みの処理を選べます。</p>}
      </div></div>}
    </div>
    <p className="text-[11px] text-text-tertiary">{map.reason?'MP4 はこの画面内で再生できます。':'フレーム記録から同期（間は補間）。同じ位置の処理は個別に選択できます。再生・手動シークで追従を再開します。'}</p>
  </div>;
}
