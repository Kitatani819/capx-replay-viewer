import { useRef, useState } from 'react';
import { fetchJsonFile, fetchText } from '../api';
import { useAsync } from '../hooks';
import { legacyEnsembleTurn, legacyOutputDecision, matchingLegacyExecution, parseLegacyCandidates, parseLegacySynthesis } from '../legacyEnsemble';
import { legacyResponses } from '../legacyResponses';
import { Badge, ErrorText, Notice, NotRecorded, Spinner } from './common';
import { TextView } from './TextView';
import { RawJson } from './tabs/ModelInputTab';
import './Ensemble.css';

export function LegacyEnsemble({ paths, url, responsesUrl, index, onIndex, onCode, mode = 'all' }: {
  paths: string[]; url: (path: string) => string; responsesUrl?: string;
  index: number; onIndex: (index: number) => void; onCode: (index: number) => void;
  mode?: 'all' | 'candidates' | 'synthesis';
}) {
  const turns = paths.flatMap(path => {
    const turn = legacyEnsembleTurn(path);
    return turn === null ? [] : [{ turn, path }];
  }).sort((a, b) => a.turn - b.turn);
  const selected = turns.find(t => t.turn === index) ?? turns[0];
  const candidatePath = selected?.path;
  const synthesisPath = candidatePath?.replace('ensemble_candidates', 'ensemble_synthesis');
  const candidateUrl = candidatePath ? url(candidatePath) : null;
  const synthesisUrl = synthesisPath && paths.includes(synthesisPath) ? url(synthesisPath) : null;
  const candidates = useAsync(() => candidateUrl ? fetchText(candidateUrl) : Promise.resolve(null), [candidateUrl]);
  const synthesis = useAsync(() => synthesisUrl ? fetchText(synthesisUrl) : Promise.resolve(null), [synthesisUrl]);
  const responses = useAsync(() => responsesUrl ? fetchJsonFile(responsesUrl) : Promise.resolve(null), [responsesUrl]);
  const common = useRef<HTMLDetailsElement>(null);
  const [candidateSelection,setCandidateSelection] = useState<{url:string;index:number}|null>(null);
  const members = parseLegacyCandidates(candidates.data ?? '');
  // Candidate numbers are local to this recording and turn.
  const member = members.find(m=>candidateSelection?.url===candidateUrl && m.index===candidateSelection.index) ?? members[0];
  const final = synthesis.data ? parseLegacySynthesis(synthesis.data) : null;
  const execution = final ? matchingLegacyExecution(final.output, legacyResponses(responses.data)) : null;
  // An exact code match also identifies the saved prompt's response row, without
  // assuming that a regeneration filename is an all_responses array index.
  const showCommon = () => { if (common.current) { common.current.open = true; common.current.scrollIntoView({ block: 'nearest' }); } };
  return <div className="ensemble-detail space-y-5" data-legacy-ensemble>
    <div className="ensemble-heading flex flex-wrap items-center justify-between gap-3">
    <h2 className="text-lg font-medium">{mode === 'synthesis' ? '統合後の回答' : `${members.length}件の候補を比べる`}</h2>
    <label className="text-sm text-text-secondary">ターン <select aria-label="アンサンブル生成ターン" value={selected?.turn ?? ''}
      onChange={e => {setCandidateSelection(null);onIndex(Number(e.target.value));}} className="bg-surface-sunken rounded px-2 py-1 ml-2">
      {turns.map(t => <option key={t.turn} value={t.turn}>{t.turn === 0 ? '初回' : `修正 ${t.turn}`}</option>)}
    </select></label>
    </div>
    {mode !== 'synthesis' && <><details ref={common} className="ensemble-common space-y-3" data-ensemble-common>
      <summary className="cursor-pointer text-sm text-text-secondary">共通の入力を見る（保存プロンプト）</summary>
      <Notice>実行コードとの一致から対応付けた保存プロンプトです。実際に各候補へ送信したメッセージ・画像一式との同一性は未確認です。</Notice>
      {execution?.prompt != null ? <RawJson value={execution.prompt} /> : <NotRecorded reason="共通入力を一意に対応付ける記録がありません" />}
    </details>
    <section className="space-y-4">
      {candidates.loading && <Spinner />}{candidates.error && <ErrorText>{candidates.error}</ErrorText>}
      {!candidates.loading && !members.length && <NotRecorded reason="候補の区切りを読み取れませんでした。元ログを確認してください" />}
      {member && <div key={`${candidateUrl}-${member.index}`} data-candidate-detail={member.index+1} className="space-y-4">
        <div className="ensemble-candidate-picker bg-surface-sunken rounded px-3 py-3">
          <select aria-label="候補を選択" value={member.index} onChange={e=>candidateUrl && setCandidateSelection({url:candidateUrl,index:Number(e.target.value)})} className="max-w-full bg-surface rounded px-2 py-2 text-sm">
            {members.map(m=><option key={m.index} value={m.index} data-legacy-candidate={m.index}>候補 {m.index+1} / {members.length} · temperature {m.temperature} · {m.success?'生成成功':'生成エラー'}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">返った回答</h3>
          <button type="button" onClick={showCommon} className="text-xs text-accent underline">この候補の入力を見る</button>
        </div>
        <p className="text-xs text-text-secondary">{member.success?'生成成功':'生成エラー'} · temperature {member.temperature} · 途中打ち切りは未記録</p>
        <div className="ensemble-response"><TextView text={member.response || '（空の回答）'} foldLines={40} /></div>
        <p className="text-xs text-text-tertiary">出典：候補生成の応答。生成成功はロボットのタスク成功を示しません。</p>
        <details className="ensemble-record border-t border-surface-border pt-3 space-y-3">
          <summary className="cursor-pointer text-sm text-text-secondary">記録の詳細</summary>
          <p className="text-xs text-text-tertiary">モデル: {member.model} · 記録順。参照設定は9件、表示件数は保存ログに従います。</p>
          <p className="text-xs text-text-tertiary">finish_reason・途中打ち切り・統合に採用された候補は、このログには未保存です。</p>
          <p className="text-xs text-text-tertiary break-all">出典: {candidatePath}</p>
          {candidateUrl && <a className="text-xs text-accent underline" href={candidateUrl} target="_blank" rel="noreferrer">候補の元ログを開く</a>}
        </details>
      </div>}
    </section></>}
    {mode !== 'candidates' && <section className="ensemble-synthesis space-y-4" data-legacy-synthesis>
      {synthesis.loading && <Spinner />}{synthesis.error && <ErrorText>{synthesis.error}</ErrorText>}
      {final && <Badge tone="violet">{legacyOutputDecision(final.output)}</Badge>}
      <details className="ensemble-common space-y-3">
        <summary className="cursor-pointer text-sm text-text-secondary">統合に実際に渡された入力（未保存）</summary>
        <NotRecorded reason="統合の送信payloadは未保存です。候補から再構成した入力を実記録として表示しません。" />
      </details>
      {final ? <>
        <div className="ensemble-response"><TextView text={final.output} foldLines={40}/></div>
        {execution && <button type="button" className="block text-sm text-accent underline" onClick={() => onCode(execution.index)}>一致する実行コードを開く（block {execution.codes.map(c => c.block).join(', ')}）</button>}
      </> : !synthesis.loading && <NotRecorded reason="統合の回答を読み取れるログがありません" />}
      <p className="text-xs text-text-tertiary">出典：統合モデルの応答</p>
      <details className="ensemble-membership space-y-2"><summary className="cursor-pointer text-sm text-text-secondary">統合入力に含まれた候補を確認</summary>
        <NotRecorded reason="統合に送信された候補を確認できる記録はありません。候補ログから採用を推定しません。" />
      </details>
      <details className="ensemble-record border-t border-surface-border pt-3 space-y-3">
        <summary className="cursor-pointer text-sm text-text-secondary">記録の詳細</summary>
        <p className="text-xs text-text-tertiary break-all">出典: {synthesisPath} · フォールバックの有無は未記録です。</p>
        {final?.model && <p className="text-xs text-text-tertiary">モデル: {final.model}</p>}
        {final?.reasoning && <details><summary className="text-sm cursor-pointer">統合ログのreasoning</summary><TextView text={final.reasoning} /></details>}
        {synthesisUrl && <a className="text-xs text-accent underline" href={synthesisUrl} target="_blank" rel="noreferrer">統合の元ログを開く</a>}
      </details>
    </section>}
  </div>;
}
