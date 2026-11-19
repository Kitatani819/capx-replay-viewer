import type { EvalRecord } from '../evals/api';
import { trialEventUrl } from '../trace/sideBySide';
import './breadcrumb.css';

export interface BreadcrumbItem { label: string; href?: string }

/** Shared by the evaluation list, comparison and trial screens. */
export function Breadcrumb({ items }: { items: readonly BreadcrumbItem[] }) {
  return <nav className="breadcrumb" aria-label="現在の場所">
    <ol>{items.map((item, index) => <li key={index}>
      {index > 0 && <span className="breadcrumb-separator" aria-hidden="true">›</span>}
      {index === items.length - 1
        ? <span aria-current="page">{item.label}</span>
        : <a href={item.href}>{item.label}</a>}
    </li>)}</ol>
  </nav>;
}

/** Keep the title identical everywhere an evaluation appears. */
export function evaluationTitle(record: EvalRecord): string {
  return record.baseline_eval_id ? record.changed : `${record.changed || '評価'}（基準）`;
}

export function trialBreadcrumbs({ runId, episodeId, evaluation, task, seed, compare = false }: {
  runId: string | null;
  episodeId: string | null;
  evaluation: EvalRecord | null | undefined;
  task?: string | null;
  seed?: number | null;
  compare?: boolean;
}): BreadcrumbItem[] {
  const items: BreadcrumbItem[] = evaluation
    ? [{ label: '評価一覧', href: '/evals' }, { label: evaluationTitle(evaluation), href: `/evals/${encodeURIComponent(evaluation.eval_id)}` }]
    : [{ label: '試行を選ぶ', href: '/traces' }];
  if (!evaluation && runId) items.push({ label: runId, href: `/traces?${new URLSearchParams({ run: runId })}` });
  if (runId && episodeId) items.push({
    label: `${task || episodeId}${typeof seed === 'number' ? ` · seed ${seed}` : ''}`,
    href: trialEventUrl(runId, episodeId),
  });
  if (compare) items.push({ label: '基準と並べて比べる' });
  else if (evaluation && !episodeId) items.push({ label: '試行を選ぶ' });
  items[items.length - 1] = { label: items[items.length - 1].label };
  return items;
}
