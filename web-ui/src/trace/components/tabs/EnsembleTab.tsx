import { useState } from 'react';
import { episodeFileUrl, fetchJsonFile, fetchText } from '../../api';
import { candidateStatus, candidateTemperature, ensembleForTurn, inlineAnswer, inputFingerprint, responseKind, synthesisMembership, type EnsembleEvidence } from '../../ensemble';
import { useAsync } from '../../hooks';
import { attemptNumber, mainAttempt, type LogicalCall } from '../../model';
import { recordedTurns, turnOf } from '../../replay';
import { dataOf } from '../../types';
import type { TabProps } from '../DetailTabs';
import { Badge, EventLink, Notice, SmallButton } from '../common';
import { RecordedModelInput, RecordedModelOutput } from './InputOutputTab';
import { ModelInputTab } from './ModelInputTab';
import { ModelOutputTab } from './ModelOutputTab';
import '../Ensemble.css';

export function EnsembleTab({ mode = 'all', onTurnSelect, ...props }: TabProps & {
  mode?: 'all' | 'candidates' | 'synthesis';
  onTurnSelect?: TabProps['onSelect'];
}) {
  const [turn,setTurn] = useState<number|null>(turnOf(props.selection.node));
  const [candidateId,setCandidateId] = useState<string|null>(props.selection.node.call?.id ?? null);
  const {members,syntheses} = ensembleForTurn(props.model,turn);
  const calls = [...members,...syntheses];
  const signature = calls.map(c=>`${c.id}:${c.node.events.map(e=>`${e.event_id}:${JSON.stringify(e.data)}`).join(',')}`).join('|');
  const loaded = useAsync(async()=>{
    const entries = await Promise.all(calls.map(async call => {
      const req = mainAttempt(call)?.request;
      const artifact = req?.artifacts?.find(a=>a.label==='payload');
      const path = artifact?.written===false ? null : dataOf(req,'model_request').payload_path ?? artifact?.path;
      const inline = inlineAnswer(call);
      const parts = await Promise.allSettled([
        path ? fetchJsonFile(episodeFileUrl(props.ep,path)) : Promise.resolve(null),
        inline.asset ? fetchText(episodeFileUrl(props.ep,inline.asset)) : Promise.resolve(inline.text),
      ]);
      const [input,output] = parts;
      const evidence: EnsembleEvidence = {
        payload: input.status==='fulfilled' ? input.value : null,
        answer: output.status==='fulfilled' ? output.value : inline.text,
        answerComplete: output.status==='fulfilled' && (inline.asset!==null || inline.complete),
        error: parts.some(p=>p.status==='rejected') ? '保存ファイルを読み込めません。確認できた範囲を表示します。' : null,
      };
      return [call.id,evidence] as const;
    }));
    return new Map(entries);
  },[props.ep.runId,props.ep.episodeId,props.ep.generation,signature]);
  const evidence = loaded.data ?? new Map<string,EnsembleEvidence>();
  const groups: {key:string; calls:LogicalCall[]}[] = [];
  for (const member of members) {
    const key = inputFingerprint(evidence.get(member.id)?.payload) ?? `unrecorded:${member.id}`;
    const group = groups.find(g=>g.key===key);
    if(group)group.calls.push(member);else groups.push({key,calls:[member]});
  }
  const forCall = (call:LogicalCall, selectedAttempt=false):TabProps => {
    const attempt = selectedAttempt && props.selection.node.call?.id===call.id ? props.selection.attempt ?? mainAttempt(call) : mainAttempt(call);
    return {...props,focus:null,selection:{node:call.node,eventId:attempt?.request.event_id ?? call.node.primary.event_id,attempt}};
  };
  const inputId = (call:LogicalCall)=>`ensemble-input-${groups.find(g=>g.calls.includes(call))?.calls[0].node.seq}`;
  const selectedMember = members.find(call=>call.id===candidateId) ?? members[0];
  const showInput = (call:LogicalCall) => {
    const el=document.getElementById(inputId(call)) as HTMLDetailsElement|null;
    if(el){
      el.open=true;
      // The shared-input section is also collapsed so unavailable or differing
      // candidate inputs do not turn the initial view into a list of payloads.
      const parent=el.parentElement?.closest('details');if(parent)parent.open=true;
      el.scrollIntoView({block:'nearest'});
    }
  };
  return <div className="ensemble-detail space-y-5" data-ensemble-turn={turn??'unknown'} data-ensemble-mode={mode}>
    <div className="ensemble-heading flex flex-wrap items-center justify-between gap-3">
    <h2 className="text-lg font-medium">{mode==='synthesis'?'統合後の回答':`${members.length}件の候補を比べる`}</h2>
    <label className="text-sm text-text-secondary">ターン <select aria-label="アンサンブルのターン" value={turn??''} onChange={e=>{
      const next=e.target.value===''?null:Number(e.target.value);setTurn(next);setCandidateId(null);
      const target=ensembleForTurn(props.model,next);const call=target.members[0]??target.syntheses[0];if(call)(onTurnSelect ?? props.onSelect)(call.node);
    }} className="bg-surface-sunken rounded px-2 py-1 ml-2"><option value="">未記録</option>{recordedTurns(props.model).map(t=><option key={t} value={t}>{t}</option>)}</select></label>
    </div>
    {mode !== 'synthesis' && members.length===0 && <Notice>このターンの候補は未記録です。件数や回答を補完しません。</Notice>}
    {turn===null && <Notice>turn_index がないため、時刻の近さで候補を関連付けていません。</Notice>}
    {loaded.loading && <p className="text-xs">共通入力と統合への対応を確認中…</p>}
    {(loaded.error || [...evidence.values()].some(e=>e.error)) && <Notice tone="amber">保存ファイルの一部を読み込めません。<SmallButton onClick={loaded.reload}>再読み込み</SmallButton></Notice>}
    {mode !== 'synthesis' && <>
    {members.length>0 && <details className="ensemble-common space-y-3" data-ensemble-common>
    <summary className="cursor-pointer text-sm text-text-secondary">共通の入力を見る</summary>
    <p className="text-xs text-text-tertiary">保存された入力が同じ候補は、まとめて表示します。</p>
    {groups.map((g,i)=><details key={g.calls[0].id} id={inputId(g.calls[0])} className="space-y-2" open={groups.length===1}>
      <summary className="cursor-pointer text-sm">入力 {i+1} · 候補 {g.calls.map(c=>members.indexOf(c)+1).join(', ')}{g.key.startsWith('unrecorded:')?' · 同一性未確認':' · 入力の一致を確認'}</summary>
      <RecordedModelInput {...forCall(g.calls[0])}/>
      <details className="space-y-2"><summary className="cursor-pointer text-xs text-text-secondary">送信記録の詳細</summary><ModelInputTab {...forCall(g.calls[0])}/></details>
    </details>)}
    </details>}
    {selectedMember && <section key={selectedMember.id} data-candidate-detail={members.indexOf(selectedMember)+1} className="space-y-4">
      <div className="ensemble-candidate-picker flex flex-wrap items-center justify-between gap-3 bg-surface-sunken rounded px-3 py-3">
        <label className="min-w-0 flex-1"><span className="sr-only">表示する候補</span><select aria-label="候補を選択" value={selectedMember.id} onChange={e=>setCandidateId(e.target.value)} className="max-w-full bg-surface rounded px-2 py-2 text-sm">
          {members.map((call,i)=><option key={call.id} data-candidate={i+1} value={call.id}>候補 {i+1} / {members.length} · temperature {candidateTemperature(call)??'未記録'} · {candidateStatus(call)}</option>)}
        </select></label>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">返った回答</h3>
        <EventLink onClick={()=>showInput(selectedMember)}>この候補の入力を見る</EventLink>
      </div>
      <p className="text-xs text-text-secondary">{candidateStatus(selectedMember)} · temperature {candidateTemperature(selectedMember)??'未記録'}</p>
      <FocusedResponse {...forCall(selectedMember,true)} call={selectedMember}/>
      <details className="ensemble-record border-t border-surface-border pt-3 space-y-3">
        <summary className="cursor-pointer text-sm text-text-secondary">記録の詳細</summary>
        <p className="text-xs text-text-tertiary">モデル: {selectedMember.model??'未記録'} · 記録された候補は{members.length}件。公式の同一モデル参照設定は9件です。HTTP再試行は候補件数に含みません。</p>
        <p className="text-xs font-mono break-all">出典: {selectedMember.id} · request {mainAttempt(selectedMember)?.request.event_id}</p>
        {syntheses.map(s=><p key={s.id} className="text-xs">統合 #{s.node.seq}: {synthesisMembership(selectedMember,members,evidence,evidence.get(s.id)?.payload)}</p>)}
        <ModelOutputTab {...forCall(selectedMember,true)}/>
      </details>
    </section>}
    </>}
    {mode !== 'candidates' && <>
    {syntheses.length===0 && <Notice>統合呼び出しは未記録です。候補から統合結果やフォールバックを推定しません。</Notice>}
    {syntheses.map(call=><section key={call.id} data-synthesis={call.id} className="ensemble-synthesis space-y-4">
      {syntheses.length>1 && <h3 className="text-sm font-medium">統合 #{call.node.seq}</h3>}
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="violet">{responseKind(evidence.get(call.id)?.answer??inlineAnswer(call).text,(evidence.get(call.id)?.answerComplete??inlineAnswer(call).complete) && candidateStatus(call)==='回答あり',call.parsed.some(p=>(dataOf(p,'model_output_parsed').code_blocks?.length??0)>0))}</Badge>
        {candidateStatus(call)!=='回答あり' && <span className="text-xs">{candidateStatus(call)}</span>}
      </div>
      <details className="ensemble-common space-y-3"><summary className="cursor-pointer text-sm text-text-secondary">統合時に実際に渡された入力</summary><RecordedModelInput {...forCall(call)}/></details>
      <FocusedResponse {...forCall(call,true)} call={call}/>
      {members.length > 0 && <details className="ensemble-membership space-y-2"><summary className="cursor-pointer text-sm text-text-secondary">統合入力に含まれた候補を確認</summary>
        <p className="text-xs text-text-tertiary">保存された統合入力の候補区間と全文を照合します。回答のどの部分を採用したかは示しません。</p>
        {members.map((member, index) => <p key={member.id} className="text-xs">候補 {index + 1}: {synthesisMembership(member,members,evidence,evidence.get(call.id)?.payload)}</p>)}
      </details>}
      <details className="ensemble-record border-t border-surface-border pt-3 space-y-3">
        <summary className="cursor-pointer text-sm text-text-secondary">記録の詳細</summary>
        <p className="text-xs font-mono">出典: {call.id} · request {mainAttempt(call)?.request.event_id}</p>
        {call.producedBlocks.length===0 && <p className="text-xs text-text-tertiary">この統合回答に source_model_event_id で結び付くPython実行はありません。</p>}
        <ModelInputTab {...forCall(call)}/>
        <ModelOutputTab {...forCall(call,true)}/>
      </details>
    </section>)}
    </>}
  </div>;
}

/** Explicitly label a selected retry while sharing the recorded-output view. */
function FocusedResponse(props: TabProps & {call:LogicalCall}) {
  const attempt=props.selection.attempt ?? mainAttempt(props.call);
  return <div className="ensemble-response space-y-2">
    {props.call.attempts.length>1 && attempt && <p className="text-xs text-text-secondary">HTTP試行 {attemptNumber(props.call,attempt)} / {props.call.attempts.length} の応答</p>}
    <RecordedModelOutput {...props}/>
  </div>;
}
