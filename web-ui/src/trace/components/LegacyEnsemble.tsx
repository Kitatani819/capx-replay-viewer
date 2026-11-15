import { useRef } from 'react';
import { fetchJsonFile, fetchText } from '../api';
import { useAsync } from '../hooks';
import { legacyEnsembleTurn, legacyOutputDecision, matchingLegacyExecution, parseLegacyCandidates, parseLegacySynthesis } from '../legacyEnsemble';
import { legacyResponses } from '../legacyResponses';
import { Badge, ErrorText, Notice, NotRecorded, SectionTitle, Spinner } from './common';
import { TextView } from './TextView';
import { RawJson } from './tabs/ModelInputTab';

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
  const members = parseLegacyCandidates(candidates.data ?? '');
  const final = synthesis.data ? parseLegacySynthesis(synthesis.data) : null;
  const execution = final ? matchingLegacyExecution(final.output, legacyResponses(responses.data)) : null;
  // An exact code match also identifies the saved prompt's response row, without
  // assuming that a regeneration filename is an all_responses array index.
  const showCommon = () => { if (common.current) { common.current.open = true; common.current.scrollIntoView({ block: 'nearest' }); } };
  return <div className="space-y-4" data-legacy-ensemble>
    <SectionTitle>{mode === 'synthesis' ? '同じターンの統合結果' : '記録された並列候補'}</SectionTitle>
    <label className="text-sm">生成ターン <select aria-label="アンサンブル生成ターン" value={selected?.turn ?? ''}
      onChange={e => onIndex(Number(e.target.value))} className="bg-surface-sunken ml-2">
      {turns.map(t => <option key={t.turn} value={t.turn}>{t.turn === 0 ? '初回' : `修正 ${t.turn}`}</option>)}
    </select></label>
    {mode !== 'synthesis' && <><details ref={common} className="space-y-2" data-ensemble-common>
      <summary className="cursor-pointer text-sm">共通入力の参照（ハーネス保存プロンプト）</summary>
      <Notice>実行コードとの一致から対応付けた保存プロンプトです。実際に各候補へ送信したメッセージ・画像一式との同一性は未確認です。</Notice>
      {execution?.prompt != null ? <RawJson value={execution.prompt} /> : <NotRecorded reason="共通入力を一意に対応付ける記録がありません" />}
    </details>
    <section className="space-y-2">
      <SectionTitle>候補一覧 · {members.length}件</SectionTitle>
      <p className="text-xs text-text-tertiary">出典: {candidatePath} · 記録順。参照設定は9件、表示件数は保存ログに従います。</p>
      <Notice>Successは生成要求の結果です。ロボットのタスク成功を示しません。finish_reason・途中打ち切り・統合に採用された候補は、このログには未保存です。</Notice>
      {candidates.loading && <Spinner />}{candidates.error && <ErrorText>{candidates.error}</ErrorText>}
      {!candidates.loading && !members.length && <NotRecorded reason="候補の区切りを読み取れませんでした。元ログを確認してください" />}
      {members.map(member => <details key={`${selected?.turn}-${member.index}`} className="border border-surface-border rounded p-2" data-legacy-candidate={member.index}>
        <summary className="cursor-pointer text-sm">候補 {member.index + 1} · {member.model} · temperature={member.temperature} · {member.success ? '生成成功' : '生成エラー'}</summary>
        <button type="button" onClick={showCommon} className="text-xs text-accent underline my-2">共通入力を参照</button>
        <p className="text-xs text-text-tertiary mb-2">途中打ち切り: 未記録 · 統合への採用: 未確認</p>
        <TextView text={member.response || '（空の回答）'} />
      </details>)}
      {candidateUrl && <a className="text-xs text-accent underline" href={candidateUrl} target="_blank" rel="noreferrer">候補の元ログを開く</a>}
    </section></>}
    {mode !== 'candidates' && <section className="space-y-2" data-legacy-synthesis>
      <SectionTitle>統合に実際に渡された入力</SectionTitle>
      <NotRecorded reason="統合の送信payloadは未保存です。候補から再構成した入力を実記録として表示しません。" />
      <SectionTitle>統合処理の最終回答</SectionTitle>
      <p className="text-xs text-text-tertiary">出典: {synthesisPath} · フォールバックの有無は未記録です。</p>
      {synthesis.loading && <Spinner />}{synthesis.error && <ErrorText>{synthesis.error}</ErrorText>}
      {final ? <>
        <Badge tone="violet">{legacyOutputDecision(final.output)}</Badge>
        {execution && <button type="button" className="block text-sm text-accent underline" onClick={() => onCode(execution.index)}>一致する実行コードを開く（block {execution.codes.map(c => c.block).join(', ')}）</button>}
        <TextView text={final.output} />
        {final.reasoning && <details><summary className="text-sm cursor-pointer">統合ログのreasoning</summary><TextView text={final.reasoning} /></details>}
      </> : !synthesis.loading && <NotRecorded reason="統合の回答を読み取れるログがありません" />}
      {synthesisUrl && <a className="text-xs text-accent underline" href={synthesisUrl} target="_blank" rel="noreferrer">統合の元ログを開く</a>}
    </section>}
  </div>;
}
