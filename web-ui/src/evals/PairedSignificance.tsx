import type { EvalDetail } from './api';
import { pairedResult, pText, significanceLabel } from './significance';

export function PairedSignificance({ detail }: { detail: EvalDetail }) {
  if (!detail.baseline) return null;
  const result = pairedResult(detail.trials, detail.baseline_trials);
  const provisional = detail.eval?.status === 'running' || detail.baseline.status === 'running';
  const change = result.paired ? (result.improved - result.worsened) / result.paired * 100 : null;
  return <section className="eval-significance" aria-label="差とぶれの確認">
    <h2>差はたまたまでしょうか</h2>
    <p className="eval-significance-result">{significanceLabel(result, provisional)}</p>
    {result.paired > 0 ? <>
      <p>同じタスク・条件・seed の判定済み {result.paired}組で比較しました。改善 {result.improved}組、悪化 {result.worsened}組、同じ結果 {result.bothSuccess + result.bothFailure}組です。対応した組の成功率の差は {change! > 0 ? '+' : ''}{change!.toFixed(1)}ポイントです。</p>
      <p>{result.p! <= .05 && !provisional ? '今回の対応した組では、偶然のぶれだけでは説明しにくい差です。ほかの seed や課題でも同じ効果が出るかは別に確認が必要です。' : '差がないと分かったわけではありません。小さい差や少ない試行では、改善・悪化を見分けられないことがあります。'}</p>
      <details><summary>検定の見方（p値 {pText(result.p!)}）</summary>
        <p>結果が変わった {result.improved + result.worsened}組の向きについて、両側の正確な符号検定を使います（正確な McNemar 検定と同じ計算）。改善と悪化が同じ確率で出る場合に、これ以上片寄る確率を p値とし、1回の比較で5%以下を目安にしています。p値は「改善が偶然である確率」ではありません。</p>
        <p>各組が独立という前提があります。複数の比較を繰り返すと、偶然でも差が出やすくなります。条件の違いがあれば、どの変更が効いたかまではこの検定から決められません。</p>
      </details>
    </> : <p>両方の評価に、タスク・seed が記録され、条件も一致し、成功か失敗が分かる組が必要です。</p>}
    <p className="eval-significance-exclusions">除外：片側だけの組 {result.unmatched}、未判定・実行中の組 {result.unjudged}、タスク・seed が未記録の試行 {result.unidentified}。再試行は最後の記録だけを使い、古い試行 {result.omittedRetries}件を除きました。</p>
    {(detail.repeat_references ?? []).map(reference => {
      const original = reference.side === 'current' ? detail.trials : detail.baseline_trials;
      const repeat = pairedResult(original, reference.trials);
      if (!repeat.paired) return null;
      return <p className="eval-repeat-reference" key={`${reference.side}-${reference.eval.eval_id}`}>{reference.side === 'current' ? '今回' : '基準'}と同じコード・記録条件の再実行 <a href={`/evals/${encodeURIComponent(reference.eval.eval_id)}`}>{reference.eval.eval_id}</a> では、対応した {repeat.paired}組中 {repeat.improved + repeat.worsened}組（{((repeat.improved + repeat.worsened) / repeat.paired * 100).toFixed(1)}%）で結果が変わりました。観測されたぶれの参考で、今回の差の判定には加えていません。</p>;
    })}
    {!(detail.repeat_references?.length) && <p className="eval-significance-exclusions">同じコードと実効条件を確認できる再実行の記録は見つかりません。設定が不足する古い記録は、ぶれの参考に使いません。</p>}
  </section>;
}
