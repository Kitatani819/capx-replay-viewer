import test from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildEpisodeModel, resolveSelection } from '../model';
import { EnsembleTab } from '../components/tabs/EnsembleTab';
import type { TabProps } from '../components/DetailTabs';
import { Rec } from './fixtures';

function props(rec: Rec, id: string): TabProps {
  const model=buildEpisodeModel(rec.events);
  return {model,ep:{runId:'run',episodeId:'ep'},selection:resolveSelection(model,id)!,
    summary:null,running:false,onSelect:()=>{},onFocusRange:()=>{},focus:null};
}

test('focused candidate starts at the selected event and lists only the recorded candidates',()=>{
  const r=new Rec();r.episodeStart();
  const first=r.request('code_generator','first',1,{call_kind:'ensemble_member',turn_index:1,params:{temperature:.1}});
  r.response(first,200,'FIRST_MEMBER_REPLY');
  const second=r.request('code_generator','second',1,{call_kind:'ensemble_member',turn_index:1,params:{temperature:.7}});
  r.response(second,200,'SECOND_MEMBER_REPLY');
  const html=renderToStaticMarkup(<EnsembleTab {...props(r,second.event_id)} mode="candidates"/>);
  assert.equal((html.match(/data-candidate="/g)??[]).length,2);
  assert.match(html,/data-candidate-detail="2"/);
  assert.match(html,/SECOND_MEMBER_REPLY/);
  assert.doesNotMatch(html,/FIRST_MEMBER_REPLY/);
  assert.match(html,/temperature 0.1/);
  assert.match(html,/temperature 0.7/);
});

test('candidate chooser exposes errors and truncation while unfinished output remains visible',()=>{
  const r=new Rec();r.episodeStart();
  const failed=r.request('code_generator','failed',1,{call_kind:'ensemble_member',turn_index:1});
  r.attemptError(failed,503,'UPSTREAM_UNAVAILABLE');
  const truncated=r.request('code_generator','truncated',1,{call_kind:'ensemble_member',turn_index:1});
  r.response(truncated,200,'INCOMPLETE_REPLY',{finish_reason:'length'});
  const html=renderToStaticMarkup(<EnsembleTab {...props(r,truncated.event_id)} mode="candidates"/>);
  assert.match(html,/<option[^>]*data-candidate="1"[^>]*>[^<]*エラー/);
  assert.match(html,/<option[^>]*data-candidate="2"[^>]*>[^<]*途中打ち切り/);
  assert.match(html,/INCOMPLETE_REPLY/);
  assert.doesNotMatch(html,/UPSTREAM_UNAVAILABLE/);
});
