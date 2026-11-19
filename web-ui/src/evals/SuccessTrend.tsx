import { useState } from 'react';
import { evaluationTitle } from '../navigation/Breadcrumb';
import type { EvalListEntry } from './api';
import { successTrend, trendTasks } from './trendModel';

function date(value: string): string {
  return new Date(value).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function SuccessTrend({ entries }: { entries: EvalListEntry[] }) {
  const [selection, setSelection] = useState('');
  const tasks = trendTasks(entries);
  const task = tasks.includes(selection) ? selection : null;
  const points = successTrend(entries, task);
  const excluded = entries.filter(entry => !entry.eval || !Number.isFinite(Date.parse(entry.eval.started_at))).length;
  const x = (index: number) => points.length === 1 ? 466 : 54 + index / (points.length - 1) * 824;
  const y = (fraction: number) => 210 - fraction * 180;
  // A missing denominator breaks the line rather than becoming a zero-percent result.
  const segments: string[] = [];
  let segment: string[] = [];
  points.forEach((point, index) => {
    if (point.fraction === null) { if (segment.length > 1) segments.push(segment.join(' ')); segment = []; }
    else segment.push(`${x(index)},${y(point.fraction)}`);
  });
  if (segment.length > 1) segments.push(segment.join(' '));

  return <section className="eval-trend" aria-labelledby="eval-trend-heading">
    <div className="eval-trend-heading"><h2 id="eval-trend-heading">成功率の推移</h2>
      <label>課題 <select value={task ?? ''} onChange={event => setSelection(event.target.value)} aria-label="推移に表示する課題">
        <option value="">全課題</option>{tasks.map(name => <option value={name} key={name}>{name}</option>)}
      </select></label>
    </div>
    <p className="eval-trend-note">成功数 / 記録された試行数。未判定・実行中の試行や再試行も分母に含みます。未実行・記録のない試行数は補完しません。</p>
    <p className="eval-trend-note">左から評価開始日時順です（横の間隔は経過時間を表しません）。評価ごとに課題・seed・モデル・設定が異なる場合があります。</p>
    {task !== null && <p className="eval-trend-note">{task} の課題別集計がある評価を表示しています。未判定・記録欠損の件数は評価全体の値です。</p>}
    {excluded > 0 && <p className="eval-trend-note">評価または開始日時を読み取れない {excluded}件はグラフに含めていません。</p>}
    {points.some(point => point.fraction !== null) ? <>
      <div className="eval-trend-scroll"><svg viewBox="0 0 920 260" role="img" aria-label={`成功率の推移：${task ?? '全課題'}、評価開始日時順。成功数と分母は下の表でも確認できます。`}>
        {[0, .5, 1].map(value => <g key={value}><line x1="54" y1={y(value)} x2="878" y2={y(value)} className="eval-trend-grid" /><text x="42" y={y(value) + 5} textAnchor="end">{value * 100}%</text></g>)}
        {segments.map((line, index) => <polyline points={line} key={index} className="eval-trend-line" fill="none" />)}
        {points.map((point, index) => point.fraction === null ? null : <a key={point.entry.eval_id} href={`/evals/${encodeURIComponent(point.entry.eval_id)}`} aria-label={`${date(point.entry.eval!.started_at)} ${evaluationTitle(point.entry.eval!)}：${Math.round(point.fraction * 100)}%、${point.counts!.success}/${point.counts!.trials}、${point.state}`}>
          <title>{`${date(point.entry.eval!.started_at)} ${evaluationTitle(point.entry.eval!)}\n${Math.round(point.fraction * 100)}%（${point.counts!.success}/${point.counts!.trials}）\n${point.state}`}</title>
          <circle cx={x(index)} cy={y(point.fraction)} r="7" className={point.provisional ? 'eval-trend-point eval-trend-provisional' : 'eval-trend-point'} />
        </a>)}
        {points.length > 0 && <><text x={x(0)} y="240" textAnchor={points.length === 1 ? 'middle' : 'start'}>{date(points[0].entry.eval!.started_at)}</text>
          {points.length > 1 && <text x={x(points.length - 1)} y="240" textAnchor="end">{date(points[points.length - 1].entry.eval!.started_at)}</text>}</>}
      </svg></div>
      <p className="eval-trend-note">● 完了・判定済み・記録欠損なし　○ 実行中・中断・未判定・記録欠損などあり。点を開くと評価の詳細に移ります。</p>
    </> : <p className="eval-empty">成功率を計算できる試行の記録がまだありません。</p>}
    {points.length > 0 && <details className="eval-trend-details"><summary>成功数・分母・状態を見る（{points.length}評価）</summary>
      <div className="eval-table-scroll"><table aria-label="成功率の推移の数値"><thead><tr><th>開始日時</th><th>評価</th><th>成功数 / 記録試行数</th><th>状態</th></tr></thead>
        <tbody>{points.map(point => <tr key={point.entry.eval_id}><td><time dateTime={point.entry.eval!.started_at}>{date(point.entry.eval!.started_at)}</time></td>
          <td><a href={`/evals/${encodeURIComponent(point.entry.eval_id)}`}>{evaluationTitle(point.entry.eval!)}</a></td>
          <td>{point.counts ? `${point.counts.success}/${point.counts.trials}` : '集計未記録'}{point.fraction !== null && `（${Math.round(point.fraction * 100)}%）`}</td><td>{point.state}</td></tr>)}</tbody>
      </table></div>
    </details>}
  </section>;
}
