import { useState } from 'react';
import { episodeFileUrl, fetchJsonFile, fetchText } from '../../api';
import { candidateStatus, candidateTemperature, ensembleForTurn, inlineAnswer, inputFingerprint, responseKind, synthesisMembership, type EnsembleEvidence } from '../../ensemble';
import { useAsync } from '../../hooks';
import { mainAttempt, type LogicalCall } from '../../model';
import { recordedTurns, turnOf } from '../../replay';
import { dataOf } from '../../types';
import type { TabProps } from '../DetailTabs';
import { Badge, EventLink, Notice, SectionTitle, SmallButton } from '../common';
import { ModelInputTab } from './ModelInputTab';
import { ModelOutputTab } from './ModelOutputTab';

export function EnsembleTab({ mode = 'all', onTurnSelect, ...props }: TabProps & {
  mode?: 'all' | 'candidates' | 'synthesis';
  onTurnSelect?: TabProps['onSelect'];
}) {
  const [turn,setTurn] = useState<number|null>(turnOf(props.selection.node));
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
  return <div className="space-y-4" data-ensemble-turn={turn??'unknown'} data-ensemble-mode={mode}>
    <label className="text-sm">選んだターン <select aria-label="アンサンブルのターン" value={turn??''} onChange={e=>{
      const next=e.target.value===''?null:Number(e.target.value);setTurn(next);
      const target=ensembleForTurn(props.model,next);const call=target.members[0]??target.syntheses[0];if(call)(onTurnSelect ?? props.onSelect)(call.node);
    }} className="bg-surface-sunken ml-2"><option value="">未記録</option>{recordedTurns(props.model).map(t=><option key={t} value={t}>{t}</option>)}</select></label>
    {mode !== 'synthesis' && <p className="text-xs text-text-tertiary">候補 {members.length}件（記録された論理呼び出し数）· 公式の同一モデル参照設定は9件。HTTP再試行は各候補内に表示します。</p>}
    {mode !== 'synthesis' && members.length===0 && <Notice>このターンの候補は未記録です。件数や回答を補完しません。</Notice>}
    {turn===null && <Notice>turn_index がないため、時刻の近さで候補を関連付けていません。</Notice>}
    {loaded.loading && <p className="text-xs">共通入力と統合への対応を確認中…</p>}
    {(loaded.error || [...evidence.values()].some(e=>e.error)) && <Notice tone="amber">保存ファイルの一部を読み込めません。<SmallButton onClick={loaded.reload}>再読み込み</SmallButton></Notice>}
    {mode !== 'synthesis' && <>
    <SectionTitle>候補への入力（同一内容は一度だけ表示）</SectionTitle>
    {groups.map((g,i)=><details key={g.calls[0].id} id={inputId(g.calls[0])} className="border border-surface-border rounded p-2">
      <summary className="cursor-pointer text-sm">入力 {i+1} · 候補 {g.calls.map(c=>members.indexOf(c)+1).join(', ')}{g.key.startsWith('unrecorded:')?' · 同一性未確認':' · 保存された messages/input の一致'}</summary>
      <ModelInputTab {...forCall(g.calls[0])}/>
    </details>)}
    <SectionTitle>並列生成した候補</SectionTitle>
    {members.map((call,i)=><details key={call.id} data-candidate={i+1} className="border border-surface-border rounded p-2">
      <summary className="cursor-pointer text-sm">候補 {i+1} · {call.model??'モデル未記録'} · temperature {candidateTemperature(call)??'未記録'} · {candidateStatus(call)}</summary>
      <div className="space-y-2 mt-2">
        <EventLink onClick={()=>{const el=document.getElementById(inputId(call)) as HTMLDetailsElement|null;if(el){el.open=true;el.scrollIntoView({block:'nearest'});}}}>共通入力を開く</EventLink>
        <p className="text-xs font-mono">出典: {call.id} · request {mainAttempt(call)?.request.event_id}</p>
        {syntheses.map(s=><p key={s.id} className="text-xs">統合 #{s.node.seq}: {synthesisMembership(call,members,evidence,evidence.get(s.id)?.payload)}</p>)}
        <ModelOutputTab {...forCall(call,true)}/>
      </div>
    </details>)}
    </>}
    {mode !== 'candidates' && <>
    <SectionTitle>統合（候補一覧とは別の呼び出し）</SectionTitle>
    {syntheses.length===0 && <Notice>統合呼び出しは未記録です。候補から統合結果やフォールバックを推定しません。</Notice>}
    {syntheses.map(call=><section key={call.id} data-synthesis={call.id} className="border border-accent/40 rounded p-3 space-y-3">
      <p className="text-xs font-mono">出典: {call.id} · request {mainAttempt(call)?.request.event_id}</p>
      <Badge tone="violet">{responseKind(evidence.get(call.id)?.answer??null,(evidence.get(call.id)?.answerComplete??false) && candidateStatus(call)==='回答あり',call.parsed.some(p=>(dataOf(p,'model_output_parsed').code_blocks?.length??0)>0))}</Badge>
      <span className="text-xs">{candidateStatus(call)}</span>
      <details><summary className="cursor-pointer text-sm">統合時に実際に渡された入力</summary><ModelInputTab {...forCall(call)}/></details>
      <p className="text-xs text-text-tertiary">候補の採用表示は保存された統合入力の候補区間との全文一致です。モデルが回答のどの部分を採用したかは示しません。同じターンに複数の統合がある場合も個別に照合します。</p>
      {members.length > 0 && <details><summary className="cursor-pointer text-xs">統合入力に含まれた候補の確認</summary>
        {members.map((member, index) => <p key={member.id} className="text-xs">候補 {index + 1}: {synthesisMembership(member,members,evidence,evidence.get(call.id)?.payload)}</p>)}
      </details>}
      <SectionTitle>統合後の回答</SectionTitle>
      <ModelOutputTab {...forCall(call,true)}/>
      {call.producedBlocks.length===0 && <p className="text-xs text-text-tertiary">この統合回答に source_model_event_id で結び付くPython実行はありません。</p>}
      {call.producedBlocks.map(b=><SmallButton key={b.key} onClick={()=>props.onSelect(b)}>実行されたPythonへ（#{b.seq}）</SmallButton>)}
    </section>)}
    </>}
  </div>;
}
