/** Readable recorded I/O. Complete diagnostic renderers remain in one disclosure. */
import { useState, type ReactNode } from 'react';
import { episodeArrayImageUrl, episodeFileUrl, fetchJsonFile, traceApi } from '../../api';
import { useAsync, useFullText } from '../../hooks';
import { arrayBudgetOf, callOutcome, enclosingBlock, logicalErrorsOfAttempt, mainAttempt, nodeTitle, okResponse, requestImageCounts, textOf, type TNode } from '../../model';
import { parsePayload, type PayloadPart } from '../../payload';
import { dataOf, type Artifact, type TextValue, type TraceEvent } from '../../types';
import type { TabProps } from '../DetailTabs';
import { CodeView } from '../CodeView';
import { Notice, NotRecorded, Spinner } from '../common';
import { TraceImage } from '../TraceImage';
import { arrayImageLayout, isDrawnAsImage, type EpisodeRef } from '../ValueView';
import { ApiLogTab } from './ApiLogTab';
import { DebugTab } from './DebugTab';
import { InputDiffTab } from './InputDiffTab';
import { ModelInputTab } from './ModelInputTab';
import { ModelOutputTab } from './ModelOutputTab';
import './ReplayInputOutput.css';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="replay-io-section"><h3>{title}</h3>{children}</section>;
}

function Disclosure({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <details className="replay-io-disclosure" onToggle={e => setOpen(e.currentTarget.open)}><summary>{title}</summary>{open && <div className="replay-io-disclosure-body">{children}</div>}</details>;
}

function RecordedText({ ep, value, code = false, empty = '未記録' }: { ep: EpisodeRef; value: TextValue | null | undefined; code?: boolean; empty?: string }) {
  const full = useFullText(ep, value);
  const [expanded, setExpanded] = useState(false);
  const long = (full.text?.length ?? 0) > 1800 || (full.text?.split('\n').length ?? 0) > 22;
  return <div className="replay-io-text">
    {full.text == null ? <p className="replay-io-muted">{empty}</p> : full.text === '' ? <p className="replay-io-muted">（空）</p> : <>
      <div className={!code && !expanded && long ? 'replay-io-text-folded' : ''}>{code ? <CodeView code={full.text} maxLines={22}/> : <pre>{full.text}</pre>}</div>
      {!code && long && <button type="button" className="replay-io-link" onClick={() => setExpanded(!expanded)}>{expanded ? '短く表示' : '全文を表示'}</button>}
    </>}
    {full.partial && <Notice tone="amber">{full.loading ? '全文を読み込み中…' : `先頭のみ表示しています。全文は未取得です${full.error ? `: ${full.error}` : ''}`}</Notice>}
  </div>;
}

function PayloadPartView({ part, ep }: { part: PayloadPart; ep: EpisodeRef }) {
  if (part.kind === 'text') return <RecordedText ep={ep} value={part.text}/>;
  if (part.kind === 'other') return <pre className="replay-io-raw">{JSON.stringify(part.raw, null, 2)}</pre>;
  const media = part.media;
  if (media?.externalUrl) return <p className="replay-io-muted">外部URL（自動取得しません）: {media.externalUrl}</p>;
  if (!media?.asset) return <NotRecorded reason={media?.reason ?? '送信した画像・動画の保存先がありません'}/>;
  return <TraceImage src={episodeFileUrl(ep, media.asset)} alt="モデルに送信した画像" provenance="model_input" compact video={media.isVideo} className="replay-io-image"/>;
}

/** Also used by candidates/synthesis; displays stored payload, never reconstructs it. */
export function RecordedModelInput(props: TabProps) {
  const call = props.selection.node.call;
  const attempt = call ? props.selection.attempt ?? mainAttempt(call) : null;
  const request = attempt?.request;
  const data = dataOf(request, 'model_request');
  const artifact = request?.artifacts?.find(a => a.label === 'payload');
  const path = artifact?.written === false ? null : data.payload_path ?? artifact?.path;
  const url = path ? episodeFileUrl(props.ep, path) : null;
  const payload = useAsync(url ? () => fetchJsonFile<unknown>(url) : null, [url]);
  const parsed = payload.data === null ? null : parsePayload(payload.data);
  const vdm = call?.role === 'vdm';
  const media = parsed?.messages.flatMap(m => m.parts).filter(p => p.kind === 'media') ?? [];
  const counts = requestImageCounts(data);
  const latestUser = parsed?.messages.findLastIndex(message => message.role === 'user') ?? -1;
  const inputMessage = (message: NonNullable<typeof parsed>['messages'][number]) => <Section key={message.index} title={`${message.role} の指示・入力`}>{message.parts.filter(p => !vdm || p.kind !== 'media').map(part => <PayloadPartView key={part.path} part={part} ep={props.ep}/>)}</Section>;
  return <div className="replay-io-model-input" data-playback-input={parsed ? '' : undefined}>
    {!request && <NotRecorded reason="この呼び出しの要求が記録されていません"/>}
    {request && !path && <NotRecorded reason={artifact?.written === false ? `入力の保存に失敗しました: ${artifact.reason ?? '理由不明'}` : '送信したプロンプトの保存先がありません'}/>}
    {payload.loading && <Spinner label="記録した入力を読み込み中"/>}
    {payload.error && <Notice tone="amber">入力を読み込めません: {payload.error} <button type="button" className="replay-io-link" onClick={payload.reload}>再読み込み</button></Notice>}
    {data.reconstruction?.verified === false && <Notice tone="amber">送信本文との一致を確認できません: {data.reconstruction.reason ?? '理由未記録'}</Notice>}
    {data.endpoint?.known_proxy && <p className="replay-io-muted">プロキシ宛てに送信した入力です。プロキシ内部での変更は記録されません。</p>}
    {props.model.warnings.filter(w => dataOf(w, 'trace_warning').related_event_id === request?.event_id).map(w => <Notice key={w.event_id} tone="amber">記録の警告: {textOf(dataOf(w, 'trace_warning').message)}</Notice>)}
    {(!parsed || parsed.container === 'none') && (data.images?.length ?? 0) > 0 && <Section title="記録された送信画像・動画"><div className="replay-io-images">{[...(data.images ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map((image, i) => <figure key={i}><figcaption>送信順 {i + 1}</figcaption>{image.url && !image.asset ? <p className="replay-io-muted">外部URL（自動取得しません）: {image.url}</p> : image.asset && image.written !== false ? <TraceImage src={episodeFileUrl(props.ep, image.asset)} alt="モデルに送信した画像" provenance="model_input" compact video={image.kind === 'video' || image.mime?.startsWith('video/')} className="replay-io-image"/> : <NotRecorded reason={image.reason ?? '送信画像は保存されていません'}/>}</figure>)}</div></Section>}
    {vdm && media.length > 0 && <Section title="比較に使った画像・動画"><div className="replay-io-images">{media.map((part, i) => <figure key={part.path}><figcaption>送信順 {i + 1}</figcaption><PayloadPartView ep={props.ep} part={part}/></figure>)}</div><p className="replay-io-muted">出典: VDMに送信した入力。前後の対応は下の指示文で確認できます。</p></Section>}
    {parsed?.container === 'none' && <><Notice>messages / input を読み取れないため、保存された本文を表示します。</Notice><pre className="replay-io-raw">{JSON.stringify(payload.data, null, 2)}</pre></>}
    {latestUser > 0 && <Disclosure title={`システム指示・過去のやり取り（${latestUser}件、送信順）`}>{parsed?.messages.slice(0, latestUser).map(inputMessage)}</Disclosure>}
    {parsed?.messages.slice(Math.max(0, latestUser)).map(inputMessage)}
    {counts.noImage === true && <p className="replay-io-muted">この呼び出しは画像入力なし</p>}
    {counts.noImage === null && media.length === 0 && <p className="replay-io-muted">画像入力の有無は未記録です。</p>}
    {parsed && <p className="replay-io-muted">出典: 保存された送信入力（画像のファイル化・秘密情報のマスク済み）。</p>}
  </div>;
}

function ModelError({ event, ep }: { event: TraceEvent; ep: EpisodeRef }) {
  const error = dataOf(event, 'model_error');
  return <div><Notice tone="amber">{error.error_type ?? '呼び出しエラー'}{error.http_status ? `（HTTP ${error.http_status}）` : ''}<RecordedText ep={ep} value={error.message}/>{error.message_redacted && <p>秘密情報はマスクされています。</p>}</Notice>{error.partial_content != null && <Section title="中断までに受信した回答（部分出力）"><RecordedText ep={ep} value={error.partial_content}/></Section>}</div>;
}

export function RecordedModelOutput(props: TabProps) {
  const call = props.selection.node.call;
  if (!call) return <NotRecorded/>;
  const attempt = props.selection.attempt ?? mainAttempt(call);
  const response = attempt?.responses[0];
  const data = dataOf(response, 'model_response');
  const outcome = callOutcome(call);
  const errors = [...(attempt?.errors ?? []), ...(attempt ? logicalErrorsOfAttempt(call, attempt) : call.logicalErrors)];
  return <div className="replay-io-model-output">
    {outcome.state === 'failed' && <Notice tone="amber">{outcome.stopped ? 'この呼び出しは途中で中断されました。' : 'この呼び出しは失敗しました。'}{response ? '応答は受信していますが、正常完了した回答ではありません。' : ''}</Notice>}
    {response ? <RecordedText ep={props.ep} value={data.content} empty="応答本文が未記録です"/> : errors.length === 0 && <NotRecorded reason={outcome.state === 'open' ? '応答はまだ記録されていません' : '選んだHTTP試行の応答がありません'}/>}
    {[...new Map(errors.map(event => [event.event_id, event])).values()].map(event => <ModelError key={event.event_id} event={event} ep={props.ep}/>)}
    <p className="replay-io-muted">{call.role === 'vdm' ? '出典: VDMの見立て（モデル応答）。評価結果とは別の記録です。' : '出典: モデルが返した回答。実行されたコードはPython実行で確認できます。'}</p>
    {response && response === okResponse(call) && call.producedBlocks.map(block => <button key={block.key} type="button" className="replay-io-link" onClick={() => props.onSelect(block)}>実行されたPythonへ（#{dataOf(block.primary, 'code_block_start').block_index ?? block.seq}）</button>)}
  </div>;
}

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null; }
function recordedInstructions(value: unknown, depth = 0): TextValue[] {
  if (depth > 10) return [];
  if (Array.isArray(value)) return value.flatMap(v => recordedInstructions(v, depth + 1));
  const obj = object(value);
  if (!obj) return [];
  return Object.entries(obj).flatMap(([key, v]) => /^(text_prompt|prompt|text_query|query|instruction|text)$/i.test(key) && (typeof v === 'string' || object(v)) ? [v as TextValue] : recordedInstructions(v, depth + 1));
}
function summaryArtifacts(value: unknown, label: string, depth = 0): Artifact[] {
  if (depth > 12 || !value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(v => summaryArtifacts(v, label, depth + 1));
  const obj = value as ObjectValue;
  const path = typeof obj.npz === 'string' ? obj.npz : typeof obj.path === 'string' ? obj.path : null;
  if (path && /\.(png|jpe?g|webp|npy|npz)$/i.test(path)) return [{ path, label, written: obj.written !== false, reason: typeof obj.reason === 'string' ? obj.reason : undefined }];
  return Object.values(obj).flatMap(v => summaryArtifacts(v, label, depth + 1));
}

function ArrayImage({ ep, path }: { ep: EpisodeRef; path: string }) {
  const arrays = useAsync(signal => traceApi.array(ep.runId, ep.episodeId, path, undefined, signal), [ep.runId, ep.episodeId, ep.generation, path]);
  const [name, setName] = useState('');
  const [index, setIndex] = useState(0);
  const entries = Object.entries(arrays.data?.arrays ?? {}).filter(([, value]) => isDrawnAsImage(value, arrayImageLayout(value)));
  const selected = entries.find(([key]) => key === name) ?? entries[0];
  const layout = selected ? arrayImageLayout(selected[1]) : null;
  if (arrays.loading) return <Spinner label="検出結果を読み込み中"/>;
  if (arrays.error) return <Notice tone="amber">検出結果を読み込めません。<button type="button" className="replay-io-link" onClick={arrays.reload}>再読み込み</button></Notice>;
  if (!selected) return <p className="replay-io-muted">画像として表示できる配列はありません。<a href={episodeFileUrl(ep, path)} target="_blank" rel="noreferrer">記録ファイルを開く</a></p>;
  return <div>
    {entries.length > 1 && <label className="replay-io-select">検出結果 <select aria-label="表示する検出結果" value={selected[0]} onChange={e => { setName(e.target.value); setIndex(0); }}>{entries.map(([key], i) => <option key={key} value={key}>{i + 1}: {key}</option>)}</select></label>}
    <TraceImage src={episodeArrayImageUrl(ep, path, selected[0], index)} alt={`検出結果 ${selected[0]}`} provenance="perception" compact className="replay-io-image"/>
    {layout && layout.count > 1 && <label className="replay-io-select">マスク <select aria-label="表示するマスク" value={index} onChange={e => setIndex(Number(e.target.value))}>{Array.from({ length: layout.count }, (_, i) => <option key={i} value={i}>{i + 1} / {layout.count}</option>)}</select></label>}
  </div>;
}
function ArtifactImage({ ep, artifact }: { ep: EpisodeRef; artifact: Artifact }) {
  if (artifact.written === false || !artifact.path) return <NotRecorded reason={artifact.reason ?? '画像が保存されていません'}/>;
  if (/\.(npy|npz)$/i.test(artifact.path)) return <div data-recorded-array={artifact.path}><ArrayImage key={artifact.path} ep={ep} path={artifact.path}/></div>;
  if ((artifact.mime ?? '').startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(artifact.path)) return <TraceImage src={episodeFileUrl(ep, artifact.path)} alt={artifact.label === 'perception_input' ? '知覚サービスの入力画像' : '知覚サービスの検出結果'} provenance="perception" compact className="replay-io-image"/>;
  return <a href={episodeFileUrl(ep, artifact.path)} target="_blank" rel="noreferrer">記録ファイルを開く</a>;
}
function ServiceIO(props: TabProps) {
  const node = props.selection.node;
  const start = dataOf(node.primary, 'service_call_start');
  const end = dataOf(node.end, 'service_call_end');
  const instructions = recordedInstructions(start.request_summary);
  const all = node.events.flatMap(event => event.artifacts ?? []);
  const artifacts = (label: string, summary: unknown) => {
    const recorded = all.filter(a => a.label === label);
    // Artifacts are authoritative about failed writes; summaries are only fallback references.
    return [...new Map([...summaryArtifacts(summary, label), ...recorded].map(a => [a.path, a])).values()];
  };
  const inputs = artifacts('perception_input', start.request_summary);
  const outputs = artifacts('perception_output', end.response_summary);
  return <>
    {node.degraded && <Notice tone="amber">通信の失敗後に代替値が返されています。{end.degraded_reason}</Notice>}
    {node.failed && <Notice tone="red">サービス呼び出しが失敗しました。<RecordedText ep={props.ep} value={end.message}/></Notice>}
    {node.open && <Notice>終了イベントがありません。処理の完了は確認できません。</Notice>}
    <Section title="対象物の指示">{instructions.length ? instructions.map((value, i) => <RecordedText key={i} ep={props.ep} value={value}/>) : <NotRecorded reason="対象物の指示は未記録です"/>}</Section>
    <div className="replay-io-images"><Section title="渡した画像">{inputs.length ? inputs.map((artifact, i) => <ArtifactImage key={i} ep={props.ep} artifact={artifact}/>) : <NotRecorded reason="入力画像は保存されていません"/>}</Section><Section title="返った検出結果">{outputs.length ? outputs.map((artifact, i) => <ArtifactImage key={i} ep={props.ep} artifact={artifact}/>) : <NotRecorded reason="検出マスク・出力画像は保存されていません"/>}</Section></div>
    <p className="replay-io-muted">出典: {start.service ?? '知覚サービス'}の入力・出力の記録。画像を押すと拡大できます。</p>
  </>;
}

function ExecutionIO(props: TabProps & { block: TNode }) {
  const { block } = props;
  const end = dataOf(block.end, 'code_block_end');
  const out = block.children.filter(c => c.kind === 'stdout');
  const err = block.children.filter(c => c.kind === 'stderr');
  return <>
    <Section title="実際に実行したPython"><RecordedText ep={props.ep} value={dataOf(block.primary, 'code_block_start').code} code/></Section>
    <Section title="標準出力">{out.length ? out.map(c => <RecordedText key={c.key} ep={props.ep} value={dataOf(c.primary, 'stdout').text}/>) : <p className="replay-io-muted">標準出力のイベントは未記録です</p>}</Section>
    <Section title="標準エラー">{err.length ? err.map(c => <RecordedText key={c.key} ep={props.ep} value={dataOf(c.primary, 'stderr').text}/>) : <p className="replay-io-muted">標準エラーのイベントは未記録です</p>}</Section>
    <p className="replay-io-muted">出典: 実行コードの標準出力・標準エラー。成功メッセージはコード自身の申告です。</p>
    {(end.reward != null || end.task_completed != null) && <Section title="取得できた評価結果"><p>reward: {end.reward ?? '未記録'} ／ task_completed: {end.task_completed == null ? '未記録' : String(end.task_completed)}</p><p className="replay-io-muted">出典: code_block_end（ハーネスの評価）</p></Section>}
    {end.exception && <Notice tone="red">実行時の例外: {end.exception.type}<RecordedText ep={props.ep} value={end.exception.message}/></Notice>}
    {block.open && <Notice>実行の終了イベントがありません。</Notice>}
    <p className="replay-io-muted">フレーム対応が記録されている場合、ログを選ぶと左の録画が対応位置で停止します。</p>
  </>;
}

export function InputOutputTab(props: TabProps) {
  const node = props.selection.node;
  const call = node.kind === 'model_call' ? node.call : null;
  const block = node.kind === 'code_block' ? node : ['stdout', 'stderr'].includes(node.kind) ? enclosingBlock(props.model, node) : null;
  const service = dataOf(node.primary, 'service_call_start').service;
  const title = node.kind === 'service_call' ? `${service?.toLowerCase() === 'sam3' ? 'SAM3' : service ?? '知覚サービス'}の入出力` : node.kind === 'code_block' ? 'Pythonの実行' : call?.role === 'vdm' ? 'VDMの比較と説明' : call ? 'モデルへの入力と回答' : nodeTitle(node);
  return <div className="replay-io" data-process-io={node.kind}>
    <h2 className="replay-io-title">{title}</h2>
    {node.orphan && <Notice tone="amber">{node.orphan}</Notice>}
    {arrayBudgetOf(node) > 0 && <Notice tone="amber">配列の記録上限に達したため、一部の画像・配列は保存されていません（array_budget）。</Notice>}
    {call && call.attempts.length > 1 && <label className="replay-io-select">HTTP試行 <select aria-label="入出力のHTTP試行" value={(props.selection.attempt ?? mainAttempt(call))?.request.event_id ?? ''} onChange={e => props.onSelect(node, e.target.value)}>{call.attempts.map((attempt, index) => <option key={attempt.request.event_id} value={attempt.request.event_id}>{index + 1} / {call.attempts.length}{attempt.errors.length > 0 ? ' · エラー' : attempt.responses.length > 0 ? ' · 応答あり' : ' · 応答未記録'}</option>)}</select></label>}
    {call ? <><RecordedModelInput {...props}/><Section title={call.role === 'vdm' ? '返った差分の説明' : '返った回答'}><RecordedModelOutput {...props}/></Section></> : node.kind === 'service_call' ? <ServiceIO {...props}/> : block ? <ExecutionIO {...props} block={block}/> : node.kind === 'api_call' || ['stdout', 'stderr'].includes(node.kind) ? <ApiLogTab {...props}/> : <DebugTab {...props}/>}
    <Disclosure title="記録の詳細">{call ? <><ModelInputTab {...props}/><ModelOutputTab {...props}/><InputDiffTab {...props}/></> : <ApiLogTab {...props}/>}<DebugTab {...props}/></Disclosure>
  </div>;
}
