/** Bidirectional, frame-based replay using the existing native video player. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { apiDefinition } from '../apiDefinitions';
import { useStoredState } from '../hooks';
import { enclosingBlock, nodeTitle, type EpisodeModel, type TNode } from '../model';
import { cameraVideos, chooseExecutionVideo, cueAt, groupCues, isPrimaryReplayNode, playbackMap, primaryPlaybackCues, type TrialVideo, type PlaybackCue } from '../playback';
import { processLabel, processTitle, recordedTurns, turnOf } from '../replay';
import { SmallButton } from './common';
import { ApiPythonPanel } from './ApiPythonPanel';
import type { EventDataAccess } from './DataAssetState';
import type { EpisodeRef } from './ValueView';

export interface ReplaySeek { key: string; token: number }

export function VideoPlayback({model, videos, onSelect, onClearSelection, seekRequest, initialKey, selectionFromPlayback = false, simple = false, logPanel, allowInitialSelection = false, liveMode = false, onInteract, ep, onApiPythonVisibleChange, assetStates, onRetryAsset}: EventDataAccess & {
  ep?: EpisodeRef;
  onApiPythonVisibleChange?: (visible: boolean) => void;
  /** A followed frame before the first API has no API selection in any pane. */
  onClearSelection?: () => void;
  logPanel?: ReactNode;
  /** The parent owns selection; only an archived trial without an event URL may initialize it. */
  allowInitialSelection?: boolean;
  liveMode?: boolean;
  onInteract?: () => void;
  /** The parent is displaying a selection that this player published. */
  selectionFromPlayback?: boolean;
  simple?: boolean; model: EpisodeModel; videos: TrialVideo[];
  onSelect: (node:TNode, openDetail?:boolean)=>void; seekRequest?: ReplaySeek | null; initialKey?: string | null;
}) {
  const combined = cameraVideos(videos);
  videos = combined.length ? combined : videos;
  const [name,setName]=useState('');
  const initialNode=model.allNodes.find(n=>n.key===initialKey);
  const initialBlock=initialNode ? enclosingBlock(model,initialNode) ?? initialNode.call?.producedBlocks[0] : undefined;
  const preferred=combined.length===0 && initialBlock ? chooseExecutionVideo(initialBlock,videos).video : undefined;
  const selectedRecording=videos.find(v=>v.name===name);
  const chosen=selectedRecording ?? preferred ?? videos[0];
  const [duration,setDuration]=useState(0);
  const [time,setTime]=useState(0);
  const [follow,setFollow]=useState(false);
  const [mediaError,setMediaError]=useState(false);
  const [playing,setPlaying]=useState(false);
  const [playError,setPlayError]=useState(false);
  const [belowVideo,setBelowVideo]=useStoredState<'list'|'process'>('capx.replay.belowVideo','list');
  const showLogs=Boolean(logPanel) && belowVideo!=='process';
  const [turn,setTurn]=useState<number|null>(null);
  const video=useRef<HTMLVideoElement>(null);
  const list=useRef<HTMLDivElement>(null);
  const lastCentered=useRef<string|null>(null);
  const selected=useRef<string|null>(null);
  const observedSelection=useRef(initialKey ?? null);
  // Updated synchronously with user intent so an effect from the previous
  // render cannot publish an old playback cue after a manual/URL selection.
  const following=useRef(false);
  const appliedSeek=useRef<number|null>(null);
  // Keep the target through seeked: a queued completion from an earlier seek
  // may arrive before the latest seek's seeking event. Explicit replay input
  // (or a native seek to a different position) releases this selection guard.
  const programmaticSeek=useRef<number|null>(null);
  const initialized=useRef(false);
  const map=useMemo(()=>playbackMap(model,chosen?.name??'',duration),[model,chosen?.name,duration]);
  const turns=useMemo(()=>recordedTurns(model),[model]);
  const mainCues=useMemo(()=>primaryPlaybackCues(map.all),[map]);
  const apiCues=useMemo(()=>map.all.filter(c=>c.node.kind==='api_call'),[map]);
  const apiMode=Boolean(ep && !simple);
  const apiPanelVisible=Boolean(chosen && ep && apiMode && !showLogs && !simple);
  const cues=apiMode ? apiCues : mainCues;
  const initialCues=apiMode && apiCues.length ? apiCues : mainCues;
  const withoutTime = useMemo(() => map.unsynced.filter(node => {
    return apiMode ? node.kind === 'api_call' || node.kind === 'code_block' : isPrimaryReplayNode(node);
  }).sort((a, b) => a.seq - b.seq), [map, apiMode]);
  useEffect(()=>{onApiPythonVisibleChange?.(apiPanelVisible);},[apiPanelVisible,onApiPythonVisibleChange]);
  useEffect(()=>()=>onApiPythonVisibleChange?.(false),[onApiPythonVisibleChange]);
  // A paused player must never invent a selected row from its initial time=0.
  // The same parent selection drives both the row and the right-hand inspector.
  const playbackCurrent=cueAt(cues,time);
  const visible=cues.filter(c=>turn===null || turnOf(c.node)===turn);
  const groups=groupCues(visible);
  const showProcessRows = !map.pending || mediaError;
  const visibleWithoutTime = !apiMode && showProcessRows
    ? withoutTime.filter(node => turn === null || turnOf(node) === turn) : [];
  useEffect(()=>{setDuration(0);setTime(0);setMediaError(false);setPlaying(false);setPlayError(false);following.current=false;setFollow(false);selected.current=null;appliedSeek.current=null;initialized.current=false;programmaticSeek.current=null;},[chosen?.url]);
  useEffect(()=>{
    if(liveMode){video.current?.pause();following.current=false;setFollow(false);selected.current=null;}
  },[liveMode]);
  const seek=(cue:PlaybackCue, alignTurn=turn!==null)=>{
    initialized.current=true;
    if(alignTurn)setTurn(turnOf(cue.node));
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
    // The parent also publishes player selections through the URL. Native media
    // events may run before this acknowledgement arrives.
    if (selectionFromPlayback && initialized.current) return;
    if(changed && incoming!==selected.current){
      video.current?.pause();following.current=false;setFollow(false);
      initialized.current=true;
      const cue=map.all.find(c=>c.node.key===incoming);
      if(cue)seek(cue);
      else selected.current=null; // Keep retrying if metadata or the cue arrives later.
      return;
    }
    // Retry a pending URL selection after metadata arrives. A row was already
    // selected if the player is waiting for the parent to acknowledge its key.
    if(follow || !initialKey || selected.current!==null)return;
    const cue=map.all.find(c=>c.node.key===initialKey);
    if(cue)seek(cue);
  },[initialKey,map,follow,selectionFromPlayback]);
  useEffect(()=>{
    if(!allowInitialSelection || liveMode || initialKey || initialized.current || !initialCues.length)return;
    const cue=cueAt(initialCues,time) ?? initialCues[0];seek(cue);onSelect(cue.node,true);
  },[allowInitialSelection,liveMode,initialKey,initialCues,time]);
  useEffect(()=>{
    if (liveMode || !following.current || !follow) return;
    if (!playbackCurrent) {
      // Only playback/seeking owns this reset. A manually selected unmapped API
      // is still inspectable while paused, and an unknown video map is not proof
      // that no API occurred. Accepting this null selection must not pause playback.
      if(apiMode && !map.reason && initialKey && onClearSelection) {
        selected.current=null;
        onClearSelection();
      }
      return;
    }
    if(selected.current===playbackCurrent.node.key)return;
    selected.current=playbackCurrent.node.key;
    if(turn!==null)setTurn(turnOf(playbackCurrent.node));
    onSelect(playbackCurrent.node);
  },[playbackCurrent,follow,onSelect,turn,liveMode,apiMode,map.reason,initialKey,onClearSelection]);
  useEffect(() => {
    if (showLogs || apiMode) {
      lastCentered.current = null;
      return;
    }
    const key = `${initialKey}|${turn}`;
    if (lastCentered.current === key) return;
    const pane = list.current;
    const row = pane?.querySelector<HTMLElement>('[data-current="true"]');
    if (!pane || !row) return;
    pane.scrollTop = row.offsetTop - (pane.clientHeight - row.clientHeight) / 2;
    lastCentered.current = key;
  }, [initialKey, map, turn, showLogs, apiMode, showProcessRows]);
  const jump=(cue:PlaybackCue, alignTurn=turn!==null, openDetail=true)=>{seek(cue,alignTurn);onSelect(cue.node,openDetail);};
  const selectRecordedNode=(node:TNode, openDetail=true)=>{
    const cue=map.all.find(c=>c.node.key===node.key);
    if(cue){jump(cue,turn!==null,openDetail);return;}
    video.current?.pause();following.current=false;setFollow(false);
    initialized.current=true;
    selected.current=node.key;onSelect(node,openDetail);
  };
  const resumeFollow = () => {
    onInteract?.();
    initialized.current = true;
    programmaticSeek.current = null;
    if (!following.current) selected.current = null;
    following.current = true;
    setFollow(true);
  };
  if(!chosen)return <div className="p-3 text-xs text-text-tertiary">この試行の動画は見つかりません。「記録フレーム」から保存画像を確認できます。</div>;
  const clock=(seconds:number)=>Number.isFinite(seconds)?`${Math.floor(seconds/60)}:${(seconds%60).toFixed(2).padStart(5,'0')}`:'0:00';
  // A range with centisecond steps can round the last selectable value.
  const sliderEnd = Number.isFinite(duration) && duration > 0 ? Math.max(.01, Number(duration.toFixed(2))) : 0;
  const syncMessage = mediaError ? '動画を読み込めません。' : map.reason && (map.pending ? map.reason : `同期情報なし · ${map.reason}`);
  const eventRow = (node: TNode, cue?: PlaybackCue) => {
    const active = node.key === initialKey;
    const description = apiDefinition(node)?.summaryJa;
    return <button key={node.key} data-current={active} data-replay-key={node.key} data-replay-event={node.primary.event_id}
      data-replay-sync={cue ? 'synced' : 'unmapped'} aria-pressed={active} onClick={() => cue ? jump(cue) : selectRecordedNode(node)}
      className="replay-event-row" title={`${nodeTitle(node)} · 記録順 #${node.seq}${cue?.positionSource === 'turn_synthesis' ? ' · 同じターンの統合位置を参照' : ''}`}>
      <span className="replay-event-time">{cue ? cue.time.toFixed(2) : '同期なし'}</span>
      <span className="replay-event-name">{processTitle(node)}
        {description && <small>{description}</small>}
        {cue?.positionSource === 'turn_synthesis' && <small>同じターンの統合位置を参照</small>}
      </span>
      <span className="replay-event-kind">{cue?.candidateCount !== undefined ? `候補生成（${cue.candidateCount}件）` : processLabel(node) || '記録'}</span>
    </button>;
  };
  return <div className={`replay-player flex flex-col${simple ? ' h-full min-h-0' : ''}${apiPanelVisible ? ' replay-api-python' : ''}`}>
    {syncMessage && <div role="status" className="replay-sync-warning">{syncMessage}</div>}
    <video key={chosen.url} ref={video} src={chosen.url} controls={simple} preload="metadata" aria-label="試行の録画" className={`replay-film ${simple ? 'h-full' : ''}`}
      onLoadedMetadata={e=>{setDuration(e.currentTarget.duration);e.currentTarget.playbackRate=0.5;}}
      onPlay={()=>{setPlaying(true);setPlayError(false);resumeFollow();}}
      onPause={e=>{setPlaying(false);setTime(e.currentTarget.currentTime);}}
      onSeeking={e=>{if(programmaticSeek.current===null || Math.abs(e.currentTarget.currentTime-programmaticSeek.current)>.01)resumeFollow();setTime(e.currentTarget.currentTime);}}
      onTimeUpdate={e=>setTime(e.currentTarget.currentTime)}
      onSeeked={e=>setTime(e.currentTarget.currentTime)}
      onEnded={()=>{setTime(duration);setPlaying(false);}} onError={()=>{setDuration(0);setMediaError(true);}}/>
    {!simple && <>
      <div className="replay-playbar">
        <button className="replay-play-button" disabled={mediaError} aria-label={playing?'一時停止':'再生'} onClick={()=>{
          const v=video.current;if(!v)return;if(v.paused){void v.play().catch(()=>setPlayError(true));}else v.pause();
        }}>{playing?'Ⅱ 一時停止':'▶ 再生'}</button>
        <input type="range" aria-label="動画の再生位置" min="0" max={sliderEnd} step="0.01"
          value={time >= duration ? sliderEnd : Math.min(time, sliderEnd)} disabled={!sliderEnd} onChange={e => {
            const v = video.current;
            if (!v) return;
            const requested = Number(e.target.value);
            resumeFollow();
            v.pause();
            v.currentTime = requested === sliderEnd ? duration : requested;
            setTime(v.currentTime);
          }}/>
        <span className="replay-time">{clock(time)} / {clock(duration)}</span>
      </div>
      {playError && <p role="status" className="replay-warning">再生できませんでした。もう一度「再生」を押してください。</p>}
      <div data-replay-log-panel="" className="replay-process-log">
        <div className="replay-log-heading">
          <span>この試行の流れ</span>
          <label>ターン <select aria-label="リプレイのターン" value={turn??'all'} onChange={e=>{
            const next=e.target.value==='all'?null:Number(e.target.value);setTurn(next);
            const matchesTurn = (node: TNode) => next === null || turnOf(node) === next;
            const cue=cues.find(c=>matchesTurn(c.node))
              ?? map.all.find(c=>c.node.kind==='code_block' && matchesTurn(c.node));
            if (cue) {
              // Changing the turn keeps the chosen inspector tab. Only a
              // direct process/API click opens that process's detail tab.
              jump(cue, next !== null, false);
              return;
            }
            const node = withoutTime.find(n => n.kind === 'api_call' && matchesTurn(n))
              ?? withoutTime.find(matchesTurn);
            if (node) {
              selectRecordedNode(node, false);
              return;
            }
            video.current?.pause();following.current=false;setFollow(false);
            const block = model.blocks.find(b => turnOf(b) === next);
            if (combined.length === 0 && block) {
              const recording = chooseExecutionVideo(block, videos).video;
              if (recording) setName(recording.name);
            }
          }}><option value="all">すべて</option>{turns.map(t=><option key={t} value={t}>{t}</option>)}</select></label>
        </div>
        <div className="replay-log-tools">
          {logPanel && <div role="group" aria-label="動画の下に出す内容" className="replay-content-switch">
            <button type="button" aria-pressed={showLogs} onClick={()=>setBelowVideo('list')}>一覧</button>
            <button type="button" aria-pressed={!showLogs} onClick={()=>setBelowVideo('process')}>{apiMode ? 'APIとPython' : '処理タイムライン'}</button>
          </div>}
          <details className="replay-playback-options"><summary>再生設定</summary><div>
            <SmallButton onClick={()=>{if(video.current){resumeFollow();video.current.pause();video.current.currentTime=Math.max(0,time-2);setTime(video.current.currentTime);}}}>2秒巻き戻す</SmallButton>
            <label>速度 <select aria-label="動画の再生速度" defaultValue="0.5" onChange={e=>{if(video.current)video.current.playbackRate=Number(e.target.value);}}>{[0.25,0.5,1,2].map(x=><option key={x} value={x}>{x}×</option>)}</select></label>
            {videos.length > 1 && <label>録画 <select aria-label="録画カメラ" value={chosen.name} onChange={e=>setName(e.target.value)}>{videos.map(v=><option key={v.url}>{v.name}</option>)}</select></label>}
            <label><input type="checkbox" checked={follow} onChange={e=>{if(e.target.checked)resumeFollow();else{selected.current=null;following.current=false;setFollow(false);}}}/> 再生位置に追従</label>
            <span className="text-xs">{map.reason ? '動画位置を特定できない処理も記録順に確認できます。' : 'フレーム記録から同期（間は補間）。同じ位置の処理は記録順です。'}</span>
          </div></details>
        </div>
        <div hidden={!showLogs}>{logPanel}</div>
        {apiPanelVisible && ep && <ApiPythonPanel model={model} ep={ep} apiCues={apiCues} selectedKey={initialKey??null} onSelect={selectRecordedNode} turn={turn} assetStates={assetStates} onRetryAsset={onRetryAsset}/>}
        <div ref={list} hidden={showLogs || apiMode} className="replay-event-list replay-process-scroll relative"
          role="region" aria-label="記録された処理" tabIndex={0}>
          {groups.map(g=><section key={g.time} data-replay-time={g.time}>
            {g.cues.map(c => eventRow(c.node, c))}
          </section>)}
          {visibleWithoutTime.length > 0 && <section aria-label="動画位置を特定できない処理">
            <p className="p-3 text-sm">動画位置を特定できない処理。{combined.length === 0 && !selectedRecording
              ? '選んだ処理を含む実行の録画があれば切り替えます。'
              : '選ぶと動画は現在位置で停止します。'}</p>
            {visibleWithoutTime.map(node => eventRow(node))}
          </section>}
          {showProcessRows && visible.length === 0 && visibleWithoutTime.length === 0 &&
            <p className="p-3 text-sm">この表示条件に該当する処理の記録はありません。</p>}
        </div>
      </div>
    </>}
  </div>;
}
