/** Model I/O tied to an executed block's recorded source, not the nearest call. */
import { recordedModelForApi } from '../../apiPython';
import { useFullText } from '../../hooks';
import { turnOf } from '../../replay';
import { dataOf, type TraceEvent } from '../../types';
import type { TabProps } from '../DetailTabs';
import { Notice, NotRecorded } from '../common';
import type { EpisodeRef } from '../ValueView';
import { RecordedModelInput, RecordedModelOutput } from './InputOutputTab';

/** A response can be recorded while its request/HTTP attempt is missing. */
function UnmatchedResponse({ ep, response }: { ep: EpisodeRef; response: TraceEvent }) {
  const content = useFullText(ep, dataOf(response, 'model_response').content);
  return <>
    {content.text === null ? <NotRecorded reason="応答本文は未記録です"/> :
      <div className="replay-io-text"><pre>{content.text || '（空の応答）'}</pre></div>}
    {content.partial && <Notice tone="amber">{content.loading ? '全文を読み込み中…' : `全文は未取得です${content.error ? `: ${content.error}` : ''}`}</Notice>}
    <p className="replay-io-muted">出典: 実行Pythonが生成元として参照するモデル応答。対応するHTTP要求は未記録です。</p>
  </>;
}

export function ApiTurnModelTab(props: TabProps) {
  const source = recordedModelForApi(props.model, props.selection.node);
  const turn = source.block ? turnOf(source.block) : turnOf(props.selection.node);
  const { call, response } = source;
  // resolveSelection falls back to mainAttempt for unmatched responses. Here
  // that would present another attempt's prompt as the recorded source input.
  const attempt = call && response
    ? call.attempts.find(candidate => candidate.responses.some(item => item.event_id === response.event_id)) ?? null
    : null;
  const modelProps: TabProps | null = call && response && attempt ? {
    ...props,
    selection: {
      node: call.node,
      eventId: response.event_id,
      // Several recorded responses may share an attempt. Show exactly the
      // response named by source_model_event_id, not its first sibling.
      attempt: { ...attempt, responses: [response] },
    },
  } : null;
  const unavailable = source.reason ?? 'この実行Pythonの生成元となるモデル応答は未記録です。';
  return <div className="replay-io" data-api-turn-model={call?.id ?? 'unrecorded'} data-api-model-source={response?.event_id}>
    <header>
      <h2 className="replay-io-title">このPythonを生成したモデル</h2>
      <p className="replay-io-muted">ターン {turn ?? '未記録'}{call ? ` · ${call.callKind === 'ensemble_synthesis' ? '統合結果' : call.callKind === 'ensemble_member' ? '候補生成' : 'コード生成'}` : ''}</p>
      {call && response && <p className="replay-io-muted">実行Pythonに記録された生成元の入力と出力です。</p>}
    </header>
    <section className="replay-io-section" data-api-model-input={attempt?.request.event_id ?? 'unrecorded'}>
      <h3>モデルに渡した入力</h3>
      {modelProps ? <RecordedModelInput {...modelProps}/> : <NotRecorded reason={response ? 'この応答に対応するHTTP要求は未記録です。別の要求からは補いません。' : unavailable}/>}
    </section>
    <section className="replay-io-section" data-api-model-output={response?.event_id ?? 'unrecorded'}>
      <h3>モデルが返した出力</h3>
      {modelProps ? <RecordedModelOutput {...modelProps}/> : response ? <UnmatchedResponse ep={props.ep} response={response}/> : <NotRecorded reason={unavailable}/>}
    </section>
  </div>;
}
