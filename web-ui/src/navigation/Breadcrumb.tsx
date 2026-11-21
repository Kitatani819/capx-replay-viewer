import type { EvalRecord } from '../evals/api';
import { trialEventUrl } from '../trace/sideBySide';
import './breadcrumb.css';
import { siteHref } from './site';

export interface BreadcrumbItem { label: string; href?: string }

/** Shared by the evaluation list, comparison and trial screens. */
export function Breadcrumb({ items }: { items: readonly BreadcrumbItem[] }) {
  return <nav className="breadcrumb" aria-label="現在の場所">
    <ol>{items.map((item, index) => <li key={index}>
      {index > 0 && <span className="breadcrumb-separator" aria-hidden="true">›</span>}
      {index === items.length - 1
        ? <span aria-current="page">{item.label}</span>
        : <a href={item.href ? siteHref(item.href) : undefined}>{item.label}</a>}
    </li>)}</ol>
  </nav>;
}

/** Keep the title identical everywhere an evaluation appears. */
// The evaluation wrapper's ID format (capx_trace_recorder.eval): ev-YYYYMMDDThhmmssZ-xxxx.
const EVAL_ID = /^ev-\d{8}T\d{6}Z-[0-9a-f]{4}$/;

export function evaluationTitle(record: EvalRecord): string {
  if (record.baseline_eval_id) return record.changed;
  // A baseline whose own name already says so does not get a second 「（基準）」.
  return record.changed?.includes('基準') ? record.changed : `${record.changed || '評価'}（基準）`;
}

export function trialBreadcrumbs({ runId, episodeId, evaluation, task, seed, compare = false }: {
  runId: string | null;
  episodeId: string | null;
  evaluation: EvalRecord | null | undefined;
  task?: string | null;
  seed?: number | null;
  compare?: boolean;
}): BreadcrumbItem[] {
  // While the evaluation record is still loading, a run named like an evaluation ID already
  // shows the evaluation trail (with the ID as its title), so the trail does not jump.
  const looksLikeEval = !evaluation && !!runId && EVAL_ID.test(runId);
  const items: BreadcrumbItem[] = evaluation
    ? [{ label: '評価一覧', href: '/evals' }, { label: evaluationTitle(evaluation), href: `/evals/${encodeURIComponent(evaluation.eval_id)}` }]
    : looksLikeEval
      ? [{ label: '評価一覧', href: '/evals' }, { label: runId!, href: `/evals/${encodeURIComponent(runId!)}` }]
      // Every trail starts at the evaluation list, so the trial list can always get back to it.
      : [{ label: '評価一覧', href: '/evals' }, { label: '試行を選ぶ', href: '/traces' }];
  if (!evaluation && !looksLikeEval && runId) items.push({ label: runId, href: `/traces?${new URLSearchParams({ run: runId })}` });
  if (runId && episodeId) items.push({
    label: `${task || episodeId}${typeof seed === 'number' ? ` · seed ${seed}` : ''}`,
    href: trialEventUrl(runId, episodeId),
  });
  if (compare) items.push({ label: '基準と並べて比べる' });
  else if (evaluation && !episodeId) items.push({ label: '試行を選ぶ' });
  items[items.length - 1] = { label: items[items.length - 1].label };
  return items;
}
