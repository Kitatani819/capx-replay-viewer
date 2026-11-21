import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { Breadcrumb, evaluationTitle, trialBreadcrumbs } from '../../navigation/Breadcrumb';
import type { EvalRecord } from '../../evals/api';

const evaluation: EvalRecord = {
  schema: 'capx-eval/1', eval_id: 'changed run', status: 'completed', by: 'alice', changed: '把持位置の修正',
  baseline_eval_id: 'baseline', eval_set: null, git: null, started_at: '', heartbeat_at: '', ended_at: null, summary: null,
};

test('shared breadcrumb uses real ancestor links and plain current-page text in the named navigation', () => {
  const html = renderToStaticMarkup(<Breadcrumb items={[
    { label: '評価一覧', href: '/evals' },
    { label: '把持位置の修正', href: '/evals/changed%20run' },
    { label: 'cube · seed 7' },
  ]} />);
  assert.match(html, /<nav[^>]*aria-label="現在の場所"/);
  assert.match(html, /<a[^>]*href="\/evals\?site=b300"[^>]*>評価一覧<\/a>/);
  assert.match(html, /<a[^>]*href="\/evals\/changed%20run\?site=b300"[^>]*>把持位置の修正<\/a>/);
  assert.match(html, /<span[^>]*aria-current="page"[^>]*>cube · seed 7<\/span>/);
  assert.equal((html.match(/aria-current="page"/g) ?? []).length, 1);
  assert.equal((html.match(/<a /g) ?? []).length, 2);
});

test('single breadcrumb marks the evaluation list as the current page', () => {
  const html = renderToStaticMarkup(<Breadcrumb items={[{ label: '評価一覧' }]} />);
  assert.match(html, /aria-current="page"[^>]*>評価一覧<\/span>/);
  assert.doesNotMatch(html, /<a /);
});

test('trial breadcrumb shares the evaluation list title and links to the evaluation comparison', () => {
  const items = trialBreadcrumbs({ runId: 'changed run', episodeId: 'episode / 7', evaluation, task: 'cube', seed: 7 });
  assert.deepEqual(items, [
    { label: '評価一覧', href: '/evals' },
    { label: evaluationTitle(evaluation), href: '/evals/changed%20run' },
    { label: 'cube · seed 7' },
  ]);
  const baseline = { ...evaluation, baseline_eval_id: null, changed: '' };
  assert.equal(evaluationTitle(baseline), '評価（基準）');
  assert.equal(evaluationTitle({ ...baseline, changed: '公式条件での基準' }), '公式条件での基準');
  assert.equal(trialBreadcrumbs({ runId: baseline.eval_id, episodeId: 'base', evaluation: baseline, task: 'cube', seed: 0 })[1].label, '評価（基準）');
});

test('side-by-side breadcrumb runs through the current evaluation and a linked current trial', () => {
  const items = trialBreadcrumbs({ runId: 'changed run', episodeId: 'episode / 7', evaluation, task: 'cube', seed: 7, compare: true });
  assert.equal(items[1].href, '/evals/changed%20run');
  assert.equal(items[2].label, 'cube · seed 7');
  const trialUrl = new URL(items[2].href!, 'http://localhost');
  assert.equal(trialUrl.pathname, '/traces');
  assert.equal(trialUrl.searchParams.get('run'), 'changed run');
  assert.equal(trialUrl.searchParams.get('episode'), 'episode / 7');
  assert.deepEqual(items[3], { label: '基準と並べて比べる' });
  const html = renderToStaticMarkup(<Breadcrumb items={items} />);
  assert.match(html, /aria-current="page"[^>]*>基準と並べて比べる<\/span>/);
});

test('trial without an evaluation links through the picker and run, including encoded run ids', () => {
  const items = trialBreadcrumbs({ runId: 'run / old', episodeId: 'trial', evaluation: null, task: 'cube', seed: 0 });
  assert.deepEqual(items[0], { label: '評価一覧', href: '/evals' });
  assert.deepEqual(items[1], { label: '試行を選ぶ', href: '/traces' });
  assert.equal(items[2].label, 'run / old');
  assert.equal(new URL(items[2].href!, 'http://localhost').searchParams.get('run'), 'run / old');
  assert.deepEqual(items[3], { label: 'cube · seed 0' });
  // Only the root links to the evaluation list; no evaluation is invented for the run.
  assert.equal(items.filter(item => item.href?.startsWith('/evals')).length, 1);
});

test('a trial whose run looks like an evaluation ID shows the evaluation trail while the record loads', () => {
  const items = trialBreadcrumbs({ runId: 'ev-20261119T052637Z-5e53', episodeId: 'ep', evaluation: undefined, task: 'cube', seed: 7 });
  assert.deepEqual(items, [
    { label: '評価一覧', href: '/evals' },
    { label: 'ev-20261119T052637Z-5e53', href: '/evals/ev-20261119T052637Z-5e53' },
    { label: 'cube · seed 7' },
  ]);
  const other = trialBreadcrumbs({ runId: 'my-run', episodeId: 'ep', evaluation: undefined, task: 'cube', seed: 7 });
  assert.deepEqual(other.slice(0, 2).map(item => item.label), ['評価一覧', '試行を選ぶ']);
});
