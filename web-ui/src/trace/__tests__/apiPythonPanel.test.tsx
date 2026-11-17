import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildEpisodeModel } from '../model';
import { ApiPythonPanel, RecordedApiDetails } from '../components/ApiPythonPanel';
import { Rec } from './fixtures';

const ep = { runId: 'run', episodeId: 'ep' };

test('API/Python panel shows same-time calls separately and full code with the recorded line marked', () => {
  const r = new Rec(); r.episodeStart();
  const source = ['observation = get_observation()', 'target = [0, 0, 1]', 'goto_pose(target)',
    ...Array.from({ length: 37 }, (_, i) => `step_${i} = ${i}`)].join('\n');
  const block = r.blockStart(null, source);
  const before = r.apiStart(block, 'get_observation', {}, null, { call_site: { code_block_id: block.event_id, line: 1 } });
  const chosen = r.apiStart(block, 'goto_pose', { position: [0, 0, 1] });
  const model = buildEpisodeModel(r.events);
  const apiCues = [before, chosen].map(event => ({ node: model.nodeOfEvent.get(event.event_id)!, time: 1.25 }));
  const html = renderToStaticMarkup(<ApiPythonPanel model={model} ep={ep} apiCues={apiCues}
    selectedKey={apiCues[1].node.key} onSelect={() => {}}/>);
  assert.match(html, new RegExp(`data-api-event="${before.event_id}" data-api-selected="false"`));
  assert.match(html, new RegExp(`data-api-event="${chosen.event_id}" data-api-selected="true"`));
  assert.equal((html.match(/1.25s/g) ?? []).length, 2);
  assert.match(html, /data-api-line="3"/);
  assert.match(html, /data-code-line="3" data-code-highlighted="true"/);
  assert.equal((html.match(/data-code-highlighted="true"/g) ?? []).length, 1);
  assert.match(html, /step_36/);
  assert.doesNotMatch(html, /残り \d+ 行を表示/);
  assert.match(html, /定義の出典は「詳細」/);
});

test('missing call_site and recording time stay explicit without displaying a parent block as a proven match', () => {
  const r = new Rec(); r.episodeStart();
  const block = r.blockStart(null, 'UNPROVEN_PARENT_CODE');
  const event = r.apiStart(block, 'unregistered_api', {}, null, { call_site: null });
  const model = buildEpisodeModel(r.events);
  const html = renderToStaticMarkup(<ApiPythonPanel model={model} ep={ep} apiCues={[]}
    selectedKey={model.nodeOfEvent.get(event.event_id)!.key} onSelect={() => {}}/>);
  assert.match(html, /同期情報なし/);
  assert.match(html, /code_block_id は未記録/);
  assert.match(html, /説明未登録/);
  assert.doesNotMatch(html, /UNPROVEN_PARENT_CODE|data-code-highlighted="true"/);
  assert.match(html, /最初のコードブロック/);
});

test('out-of-range call lines show full recorded code but never mark a guessed line', () => {
  const r = new Rec(); r.episodeStart();
  const block = r.blockStart(null, 'goto_pose(target)');
  const event = r.apiStart(block, 'goto_pose'); // fixture records line 3, only one source line exists
  const model = buildEpisodeModel(r.events);
  const html = renderToStaticMarkup(<ApiPythonPanel model={model} ep={ep} apiCues={[]}
    selectedKey={model.nodeOfEvent.get(event.event_id)!.key} onSelect={() => {}}/>);
  assert.match(html, /Pythonの範囲外/);
  assert.match(html, /goto_pose/);
  assert.doesNotMatch(html, /data-code-highlighted="true"/);
});

test('API details distinguish the reference definition, recorded arguments and return, and unproven error cause', () => {
  const r = new Rec(); r.episodeStart();
  const block = r.blockStart(null, 'goto_pose(target)');
  const success = r.apiStart(block, 'goto_pose', { position: 'RECORDED_TARGET' });
  r.apiEnd(success, { observed: 'RECORDED_RESULT' });
  const failure = r.apiStart(block, 'goto_pose', { position: 'SECOND_TARGET' });
  r.apiError(failure, 'RuntimeError', 'RECORDED_FAILURE');
  const model = buildEpisodeModel(r.events);
  const successful = renderToStaticMarkup(<RecordedApiDetails ep={ep} node={model.nodeOfEvent.get(success.event_id)!}/>);
  assert.match(successful, /RECORDED_TARGET/);
  assert.match(successful, /RECORDED_RESULT/);
  assert.match(successful, /Go to pose using Inverse Kinematics/);
  assert.match(successful, /github.com\/matsuolab\/geniac_prize_2026_code\/blob\/e26d1ea/);
  assert.match(successful, /実装・バージョンとの一致は未確認/);
  assert.match(successful, /タスクの成功を意味しません/);
  const failed = renderToStaticMarkup(<RecordedApiDetails ep={ep} node={model.nodeOfEvent.get(failure.event_id)!}/>);
  assert.match(failed, /RuntimeError/);
  assert.match(failed, /RECORDED_FAILURE/);
  assert.match(failed, /原因未特定/);
  assert.match(failed, /エラー終了（戻り値なし）/);
  assert.doesNotMatch(failed, /RECORDED_RESULT/);
});
