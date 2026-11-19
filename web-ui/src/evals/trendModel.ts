/** Plot the API's recorded counts without inventing missing trial outcomes. */
import type { EvalCounts, EvalListEntry } from './api';

export interface TrendPoint {
  entry: EvalListEntry;
  counts: EvalCounts | null;
  fraction: number | null;
  provisional: boolean;
  state: string;
}

export function trendTasks(entries: EvalListEntry[]): string[] {
  return [...new Set(entries.flatMap(entry => Object.keys((entry.summary ?? entry.eval?.summary)?.by_task ?? {})))].sort();
}

export function successTrend(entries: EvalListEntry[], task: string | null = null): TrendPoint[] {
  return entries.filter(entry => entry.eval && Number.isFinite(Date.parse(entry.eval.started_at)))
    .sort((a, b) => Date.parse(a.eval!.started_at) - Date.parse(b.eval!.started_at) || a.eval_id.localeCompare(b.eval_id))
    .flatMap(entry => {
      const summary = entry.summary ?? entry.eval!.summary;
      if (task !== null && !summary?.by_task?.[task]) return [];
      const counts = (task === null ? summary : summary?.by_task?.[task]) ?? null;
      const state = [entry.eval!.status === 'running' ? (entry.display_status === 'interrupted' ? '中断の可能性' : '実行中') : entry.eval!.status === 'interrupted' ? '中断' : '完了'];
      if (!summary) state.push('集計未記録');
      else {
        const scope = task === null ? '' : '評価全体で';
        if (summary.unknown > 0) state.push(`${scope}未判定 ${summary.unknown}件`);
        if (summary.incomplete > 0) state.push(`${scope}記録欠損 ${summary.incomplete}件`);
      }
      if (entry.error) state.push('読み取りエラーあり');
      return [{ entry, counts, fraction: counts && counts.trials > 0 ? counts.success / counts.trials : null,
        provisional: entry.eval!.status !== 'completed' || !summary || summary.unknown > 0 || summary.incomplete > 0 || !!entry.error,
        state: state.join('・') }];
    });
}
