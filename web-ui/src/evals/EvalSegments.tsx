import type { EvalRecord } from './api';

function timestamp(value: string | null): string {
  if (!value) return '終了日時不明';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '日時不明' : date.toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}
export function EvalSegments({ record }: { record: EvalRecord }) {
  const segments = record.segments ?? [];
  if (segments.length < 2) return null;
  const used = segments.reduce((sum, segment) => sum + (segment.budget?.used_s ?? 0), 0);
  const limit = segments.find(segment => segment.budget)?.budget?.limit_s;
  return <section className="eval-segments" aria-label="分割した評価の履歴">
    <p>{segments.length}回に分けて実行した評価です。完了したタスク・条件・seed の組を再実行せず、同じ評価IDに追加しています。成功率は各組の最後の試行で数えます。</p>
    {limit !== undefined && <p>評価予算：累積 {used.toFixed(1)}秒 / {limit.toFixed(1)}秒。ジョブ間の待ち時間を除き、予算の上限を引き継ぎます。</p>}
    <details><summary>各回の開始・終了と完了数</summary><ol>{segments.map(segment => <li key={segment.index}>
      {segment.index}回目：{timestamp(segment.started_at)} ～ {segment.status === 'running' ? '実行中' : timestamp(segment.ended_at)}
      （{segment.status === 'completed' ? '完了' : segment.status === 'running' ? '実行中' : '中断'}、開始前に完了 {segment.completed_before}組{segment.completed_after !== null ? `、終了後 ${segment.completed_after}組` : ''}）
      {segment.stop_verified && '。再開前に監督プロセスとワーカー群の停止を確認しました。終了時刻や終了信号は記録されていません。'}
    </li>)}</ol></details>
    <p>公式は1つの連続したジョブで評価します。分割した評価は実行時間の累積予算を守りますが、途中に待機や再起動があるため、同じ実行条件とは限りません。</p>
  </section>;
}
