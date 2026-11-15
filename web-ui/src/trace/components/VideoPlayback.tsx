/** Bidirectional, frame-based replay using the existing native video player. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { enclosingBlock, nodeTitle, type EpisodeModel, type TNode } from '../model';
import { cameraVideos, chooseExecutionVideo, cueAt, groupCues, playbackMap, primaryPlaybackCues, type TrialVideo, type PlaybackCue } from '../playback';
import { processLabel, processTitle, recordedTurns, turnOf } from '../replay';
import { SmallButton } from './common';

export interface ReplaySeek { key: string; token: number }
export function VideoPlayback({model, videos, onSelect, seekRequest, initialKey, simple = false, logPanel, allowInitialSelection = false, liveMode = false, onInteract}: {
  logPanel?: ReactNode;
  /** The parent owns selection; only an archived trial without an event URL may initialize it. */
  allowInitialSelection?: boolean;
  liveMode?: boolean;
  onInteract?: () => void;
  simple?: boolean; model: EpisodeModel; videos: TrialVideo[];
  onSelect: (node:TNode, openDetail?:boolean)=>void; seekRequest?: ReplaySeek | null; initialKey?: string | null;
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
  const [mediaError,setMediaError]=useState(false);
  const [mode,setMode]=useState<'main'|'all'|'prompts'|'actions'>('main');
  const [playing,setPlaying]=useState(false);
  const [playError,setPlayError]=useState(false);
  const [showLogs,setShowLogs]=useState(false);
  const [turn,setTurn]=useState<number|null>(null);
  const video=useRef<HTMLVideoElement>(null);
  const list=useRef<HTMLDivElement>(null);
  const selected=useRef<string|null>(null);
  const observedSelection=useRef(initialKey ?? null);
  // Updated synchronously with user intent so an effect from the previous
  // render cannot publish an old playback cue after a manual/URL selection.
  const following=useRef(false);
  const appliedSeek=useRef<number|null>(null);
  const programmaticSeek=useRef<number|null>(null);
  const initialized=useRef(false);
  const map=useMemo(()=>playbackMap(model,chosen?.name??'',duration),[model,chosen?.name,duration]);
  const turns=useMemo(()=>recordedTurns(model),[model]);
  const mainCues=useMemo(()=>primaryPlaybackCues(map.all),[map]);
  const cues=mode==='main' ? mainCues : map[mode];
  // A paused player must never invent a selected row from its initial time=0.
  // The same parent selection drives both the row and the right-hand inspector.
  const current=map.all.find(c=>c.node.key===initialKey) ?? null;
  const playbackCurrent=cueAt(cues,time);
  const visible=cues.filter(c=>turn===null || turnOf(c.node)===turn);
  const groups=groupCues(visible);
  useEffect(()=>{setDuration(0);setTime(0);setMediaError(false);setPlaying(false);setPlayError(false);following.current=false;setFollow(false);selected.current=null;appliedSeek.current=null;initialized.current=false;programmaticSeek.current=null;},[chosen?.url]);
  useEffect(()=>{
    if(liveMode){video.current?.pause();following.current=false;setFollow(false);selected.current=null;}
  },[liveMode]);
  const seek=(cue:PlaybackCue, alignTurn=turn!==null)=>{
    initialized.current=true;
    if(alignTurn)setTurn(turnOf(cue.node));
    if(!cues.some(c=>c.node.key===cue.node.key))setMode('all');
    selected.current=cue.node.key;
    following.current=false;
    setFollow(false);setTime(cue.time);
    if(video.current){video.current.pause();programmaticSeek.current=cue.time;video.current.currentTime=Math.min(cue.time,duration);}
  };
  // Only manual selections send this token. Playback-driven selections never
  // seek themselves: otherwise timeupdate would repeatedly pause the player.
  useEffect(()=>{
    if(!seekRequest || appliedSeek.current===seekRequest.token)return;
    const cue=map.all.find(c=>c.node.key===seekRequest.key);
    if(!cue){video.current?.pause();following.current=false;setFollow(false);return;}
    appliedSeek.current=seekRequest.token;
    setTurn(turnOf(cue.node));seek(cue);
  },[seekRequest,map]);
  // A URL, Live update or detail link can change the parent selection. Resolve
  // it exactly, waiting for metadata; non-mapped events deliberately select no row.
  useEffect(()=>{
    const incoming=initialKey ?? null;
    const changed=observedSelection.current!==incoming;
    observedSelection.current=incoming;
    if(changed && incoming!==selected.current){
      video.current?.pause();following.current=false;setFollow(false);
      initialized.current=true;
      const cue=map.all.find(c=>c.node.key===incoming);
      if(cue)seek(cue);
      else selected.current=null; // Keep retrying if metadata or the cue arrives later.
      return;
    }
    if(follow || !initialKey || selected.current===initialKey)return;
    const cue=map.all.find(c=>c.node.key===initialKey);
    if(cue)seek(cue);
  },[initialKey,map,follow]);
  useEffect(()=>{
    if(!allowInitialSelection || liveMode || initialKey || initialized.current || !mainCues.length)return;
    const cue=cueAt(mainCues,time) ?? mainCues[0];seek(cue);onSelect(cue.node,true);
  },[allowInitialSelection,liveMode,initialKey,map,time]);
  useEffect(()=>{
    if (liveMode || !following.current || !follow || !playbackCurrent || selected.current===playbackCurrent.node.key) return;
    selected.current=playbackCurrent.node.key;
    if(turn!==null)setTurn(turnOf(playbackCurrent.node));
    onSelect(playbackCurrent.node);
  },[playbackCurrent,follow,onSelect,turn,liveMode]);
  useEffect(()=>{
    const row=list.current?.querySelector<HTMLElement>('[data-current="true"]');
    if(row && list.current) list.current.scrollTop=row.offsetTop-list.current.clientHeight/2+row.clientHeight/2;
  },[current?.node.key]);
  const jump=(cue:PlaybackCue, alignTurn=turn!==null)=>{seek(cue,alignTurn);onSelect(cue.node,true);};
  const resumeFollow=()=>{onInteract?.();initialized.current=true;programmaticSeek.current=null;selected.current=null;following.current=true;setFollow(true);};
  if(!chosen)return <div className="p-3 text-xs text-text-tertiary">この試行の動画は見つかりません。「記録フレーム」から保存画像を確認できます。</div>;
  const clock=(seconds:number)=>Number.isFinite(seconds)?`${Math.floor(seconds/60)}:${(seconds%60).toFixed(2).padStart(5,'0')}`:'0:00';
  return <div className="replay-player h-full min-h-0 flex flex-col">
    {(map.reason || mediaError) && <div role="status" className="replay-sync-warning">同期情報なし · {mediaError?'動画を読み込めません。':map.reason}</div>}
    <video key={chosen.url} ref={video} src={chosen.url} controls={simple} preload="metadata" aria-label="試行の録画" className={`replay-film ${simple ? 'h-full' : ''}`}
      onLoadedMetadata={e=>{setDuration(e.currentTarget.duration);e.currentTarget.playbackRate=0.5;}}
      onPlay={()=>{setPlaying(true);setPlayError(false);resumeFollow();}}
      onPause={e=>{setPlaying(false);setTime(e.currentTarget.currentTime);}}
      onSeeking={e=>{if(programmaticSeek.current===null || Math.abs(e.currentTarget.currentTime-programmaticSeek.current)>.01)resumeFollow();setTime(e.currentTarget.currentTime);}}
      onTimeUpdate={e=>setTime(e.currentTarget.currentTime)}
      onSeeked={e=>{setTime(e.currentTarget.currentTime);programmaticSeek.current=null;}}
      onEnded={()=>{setTime(duration);setPlaying(false);}} onError={()=>{setDuration(0);setMediaError(true);}}/>
    {!simple && <>
      <div className="replay-playbar">
        <button className="replay-play-button" disabled={mediaError} aria-label={playing?'一時停止':'再生'} onClick={()=>{
          const v=video.current;if(!v)return;if(v.paused){void v.play().catch(()=>setPlayError(true));}else v.pause();
        }}>{playing?'Ⅱ 一時停止':'▶ 再生'}</button>
        <input type="range" aria-label="動画の再生位置" min="0" max={duration||0} step="0.01" value={Math.min(time,duration)} disabled={!duration} onChange={e=>{
          const v=video.current;if(!v)return;resumeFollow();v.pause();v.currentTime=Number(e.target.value);setTime(v.currentTime);
        }}/>
        <span className="replay-time">{clock(time)} / {clock(duration)}</span>
      </div>
      {playError && <p role="status" className="replay-warning">再生できませんでした。もう一度「再生」を押してください。</p>}
      <div data-replay-log-panel="" className="replay-process-log flex-1 min-h-0 flex flex-col">
        <div className="replay-log-heading">
          <span>この試行の流れ</span>
          <label>ターン <select aria-label="リプレイのターン" value={turn??'all'} onChange={e=>{
            const next=e.target.value==='all'?null:Number(e.target.value);setTurn(next);
            const cue=cues.find(c=>next===null || turnOf(c.node)===next);
            if(cue)jump(cue,next!==null);
            else {
              video.current?.pause();following.current=false;setFollow(false);
              const block=model.blocks.find(b=>turnOf(b)===next);
              if(combined.length===0 && block){const v=chooseExecutionVideo(block,videos).video;if(v)setName(v.name);}
              const node=model.allNodes.find(n=>next!==null && turnOf(n)===next);if(node)onSelect(node);
            }
          }}><option value="all">すべて</option>{turns.map(t=><option key={t} value={t}>{t}</option>)}</select></label>
        </div>
        <div hidden={!showLogs} className="flex-1 min-h-0">{logPanel}</div>
        <div ref={list} hidden={showLogs} className="replay-event-list relative flex-1 min-w-0 overflow-y-auto" aria-label="動画に対応するイベント">
          {groups.map(g=><section key={g.time} data-replay-time={g.time}>
            {g.cues.map(c=><button key={c.node.key} data-current={current?.node.key===c.node.key} data-replay-key={c.node.key} data-replay-event={c.node.primary.event_id} aria-pressed={current?.node.key===c.node.key} onClick={()=>jump(c)} className="replay-event-row" title={`${nodeTitle(c.node)} · 記録順 #${c.node.seq}${c.positionSource==='turn_synthesis'?' · 同じターンの統合位置を参照':''}`}>
              <span className="replay-event-time">{c.time.toFixed(2)}</span>
              <span className="replay-event-name">{processTitle(c.node)}{c.positionSource==='turn_synthesis'&&<small>同じターンの統合位置を参照</small>}</span>
              <span className="replay-event-kind">{c.candidateCount!==undefined ? `候補生成（${c.candidateCount}件）` : processLabel(c.node) || (c.node.kind==='api_call'?'API':'記録')}</span>
            </button>)}
          </section>)}
          {!map.reason && visible.length===0 && <p className="p-3 text-sm">対応する処理は未記録です。「詳細ログ」から記録を確認できます。</p>}
          {map.reason && <p className="p-3 text-sm">処理の対応位置は未確認です。「詳細ログ」で保存済みの記録を確認できます。</p>}
        </div>
        <div className="replay-log-footer">
          {logPanel && <button className="replay-text-button" onClick={()=>setShowLogs(!showLogs)}>{showLogs?'処理タイムライン':'詳細ログ'}</button>}
          {!showLogs && <select aria-label="表示する処理" value={mode} onChange={e=>setMode(e.target.value as typeof mode)}>
            <option value="main">主要な処理</option><option value="all">すべての処理</option><option value="prompts">モデル呼び出し</option><option value="actions">コード・API</option>
          </select>}
          <details className="replay-playback-options"><summary>再生設定</summary><div>
            <SmallButton onClick={()=>{if(video.current){resumeFollow();video.current.pause();video.current.currentTime=Math.max(0,time-2);setTime(video.current.currentTime);}}}>2秒巻き戻す</SmallButton>
            <label>速度 <select aria-label="動画の再生速度" defaultValue="0.5" onChange={e=>{if(video.current)video.current.playbackRate=Number(e.target.value);}}>{[0.25,0.5,1,2].map(x=><option key={x} value={x}>{x}×</option>)}</select></label>
            {videos.length > 1 && <label>録画 <select aria-label="録画カメラ" value={chosen.name} onChange={e=>setName(e.target.value)}>{videos.map(v=><option key={v.url}>{v.name}</option>)}</select></label>}
            <label><input type="checkbox" checked={follow} onChange={e=>{if(e.target.checked)resumeFollow();else{selected.current=null;following.current=false;setFollow(false);}}}/> 再生位置に追従</label>
            <span className="text-xs">{map.reason?'MP4のみ再生できます。':'フレーム記録から同期（間は補間）。同じ位置の処理は記録順です。'}</span>
          </div></details>
        </div>
      </div>
    </>}
  </div>;
}
