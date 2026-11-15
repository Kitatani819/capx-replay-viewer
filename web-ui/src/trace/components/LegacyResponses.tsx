import { fetchJsonFile } from '../api';
import { useAsync } from '../hooks';
import { legacyDecision, legacyResponses } from '../legacyResponses';
import { CodeView } from './CodeView';
import { TextView } from './TextView';
import { ErrorText, NotRecorded, Spinner } from './common';
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
  return <div className="replay-legacy-content replay-legacy-responses" data-legacy-responses>
    {ensemble && <>
      <p className="replay-legacy-eyebrow">保存されたモデル応答</p>
      <h2>{candidatesOnly ? '候補の記録がありません' : '統合との対応は未確認です'}</h2>
      <p className="replay-legacy-note">{candidatesOnly
        ? '候補ごとの回答・temperature・エラー・途中打ち切りは未保存です。最終応答を並列候補として数えません。'
        : '保存された最終応答を表示します。統合結果かフォールバックかは、この記録だけでは確認できません。'}</p>
      <p className="replay-legacy-source">候補数・採用候補・統合時に実際に渡された入力は未確認です。</p>
    </>}
    {!candidatesOnly && <>
      {!row ? <NotRecorded reason="all_responses.json に読み取れる応答がありません" /> : <>
        <div className="replay-legacy-response-select"><label htmlFor="legacy-saved-response">保存された応答</label>
          <select id="legacy-saved-response" aria-label="保存応答" value={row.index} onChange={e => onIndex(Number(e.target.value))}>
            {rows.map(r => <option key={r.index} value={r.index}>記録 {r.index + 1} / {rows.length} · {legacyDecision(r)}</option>)}
          </select>
        </div>
        <p className="replay-legacy-decision">{legacyDecision(row)}</p>
        {row.prompt !== null ? <details className="replay-legacy-fold"><summary>ハーネス保存プロンプト</summary>
          <p className="replay-legacy-note">initial_prompt / multi_turn_prompt の保存値です。候補生成・統合へ実際に送信した入力との同一性は未確認です。</p>
          <RawJson value={row.prompt} />
        </details> : <p className="replay-legacy-note">この応答のプロンプトは未保存です。</p>}
        {row.codes.map((c, i) => <section key={i}>
          <h3>{row.codes.length > 1 ? `実行コード ${i + 1}` : '実行コード'}</h3>
          <CodeView code={c.code} />
          <p className="replay-legacy-source">出典: all_responses.json · code_blocks / block_idx · block {c.block ?? '未記録'}</p>
        </section>)}
        {row.reasoning && <details className="replay-legacy-fold"><summary>ログに保存された reasoning</summary><TextView text={row.reasoning} mono={false} /></details>}
      </>}
      <p className="replay-legacy-source">出典: all_responses.json · ログ順の解析後の応答です。生の回答全文・送信payload・実行時刻は別途必要です。</p>
    </>}
  </div>;
}
