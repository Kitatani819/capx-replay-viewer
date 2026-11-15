import { fetchJsonFile } from '../api';
import { useAsync } from '../hooks';
import { legacyDecision, legacyResponses } from '../legacyResponses';
import { CodeView } from './CodeView';
import { TextView } from './TextView';
import { Badge, ErrorText, Notice, NotRecorded, SectionTitle, Spinner } from './common';
import { RawJson } from './tabs/ModelInputTab';

/** Preserve the limits of old harness logs; never turn response rows into candidates. */
export function LegacyResponses({ url, index, onIndex, ensemble = false, candidatesOnly = false }: {
  url: string; index: number; onIndex: (index: number) => void; ensemble?: boolean; candidatesOnly?: boolean;
}) {
  const res = useAsync(() => fetchJsonFile(url), [url]);
  if (res.loading) return <Spinner />;
  if (res.error) return <ErrorText>{res.error}</ErrorText>;
  const rows = legacyResponses(res.data);
  const row = rows.find(r => r.index === index) ?? rows[0];
  return <div className="space-y-3" data-legacy-responses>
    {ensemble && <>
      <SectionTitle>{candidatesOnly ? '並列候補の記録なし' : '統合結果への対応は未確認'}</SectionTitle>
      <Notice tone="amber">この形式の all_responses.json には候補ごとの temperature・回答・エラー・途中打ち切り、統合時の実際の入力がありません。候補数と採用候補は未確認です。保存された最終応答を並列候補として数えません。</Notice>
      <Notice>最終応答が統合結果かフォールバックかも、このログだけでは確認できません。</Notice>
    </>}
    {!candidatesOnly && <><SectionTitle>保存された最終応答（解析後）</SectionTitle>
    <p className="text-xs text-text-tertiary">出典: all_responses.json · {rows.length}件はログ順の応答です。生の回答全文・送信payload・実行時刻は別途必要です。</p>
    {!row ? <NotRecorded reason="all_responses.json に読み取れる応答がありません" /> : <>
      <label className="text-sm">応答 <select aria-label="保存応答" value={row.index} onChange={e => onIndex(Number(e.target.value))} className="bg-surface-sunken ml-2">
        {rows.map(r => <option key={r.index} value={r.index}>記録 {r.index + 1} · {legacyDecision(r)}</option>)}
      </select></label>
      <div><Badge tone="violet">{legacyDecision(row)}</Badge></div>
      {row.codes.map((c, i) => <div key={i}>
        <p className="text-xs text-text-tertiary">実行コード: block {c.block ?? '未記録'}（code_blocks / block_idx）</p>
        <CodeView code={c.code} />
      </div>)}
      {row.reasoning && <details><summary className="text-sm cursor-pointer">ログに保存された reasoning</summary><TextView text={row.reasoning} /></details>}
      {row.prompt !== null ? <details><summary className="text-sm cursor-pointer">ハーネス保存プロンプト</summary>
        <Notice>initial_prompt / multi_turn_prompt の保存値です。候補生成・統合へ実際に送信した入力との同一性は未確認です。</Notice>
        <RawJson value={row.prompt} />
      </details> : <NotRecorded reason="この応答のプロンプトは未保存です" />}
    </>}</>}
  </div>;
}
