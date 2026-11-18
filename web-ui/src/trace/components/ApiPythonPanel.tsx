/** Recorded API calls beside their executed Python, under the recording. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { apiCallSite, apiLineMatch } from '../apiPython';
import { apiDefinition } from '../apiDefinitions';
import { useFullText } from '../hooks';
import type { EpisodeModel, TNode } from '../model';
import type { PlaybackCue } from '../playback';
import { turnOf } from '../replay';
import { dataOf } from '../types';
import { CodeView } from './CodeView';
import { UnavailableEventData, type EventDataAccess } from './DataAssetState';
import { ValueView, type EpisodeRef } from './ValueView';
import './ApiPythonPanel.css';

export interface ApiPythonPanelProps extends EventDataAccess {
  model: EpisodeModel;
  ep: EpisodeRef;
  apiCues: PlaybackCue[];
  selectedKey: string | null;
  onSelect: (node: TNode) => void;
  turn?: number | null;
}

function apiName(node: TNode) {
  const data = dataOf(node.primary, 'api_call_start');
  return data.name ?? data.qualname ?? 'API名は未記録';
}

function recordedStatus(node: TNode) {
  if (!node.end) return '終了は未記録';
  return node.end.event_type === 'api_call_error' ? 'エラー記録あり · 原因未特定' : '終了（例外の記録なし）';
}

/** The definition and the execution evidence are deliberately separate sections. */
export function RecordedApiDetails({ node, ep, ...access }: { node: TNode; ep: EpisodeRef } & EventDataAccess) {
  const definition = apiDefinition(node);
  const start = dataOf(node.primary, 'api_call_start');
  const end = dataOf(node.end, 'api_call_end');
  const error = node.end?.event_type === 'api_call_error';
  const message = useFullText(ep, error ? end.message : null);
  const traceback = useFullText(ep, error ? end.traceback : null);
  return <div className="api-python-details-body">
    <section>
      <h4>API定義の説明</h4>
      {definition ? <>
        <p>{definition.descriptionJa}</p>
        <p>定義の原文（抜粋） <span lang="en">{definition.docstring}</span></p>
        <pre>{definition.signature}</pre>
        <a href={definition.sourceUrl} target="_blank" rel="noreferrer">{definition.sourceLabel}</a>
        <p className="api-python-muted">{definition.scopeNote}</p>
      </> : <p>説明未登録</p>}
    </section>
    <section data-api-recorded-evidence="">
      <h4>今回の実行ログ</h4>
      <p>{recordedStatus(node)}</p>
      <p className="api-python-muted">出典: {node.end?.event_type ?? 'api_call_start（終了イベントなし）'}。呼び出しの終了は、タスクの成功を意味しません。</p>
      <dl>
        <div><dt>記録されたAPI</dt><dd><code>{start.qualname ?? start.name ?? '未記録'}</code></dd></div>
        <div><dt>実装クラス</dt><dd><code>{start.api_class ?? '未記録'}</code></dd></div>
        <div><dt>sim_step</dt><dd>{node.primary.sim_step ?? '未記録'} → {node.end?.sim_step ?? '未記録'}</dd></div>
        <div><dt>呼び出し元</dt><dd><code>{start.call_site?.code_block_id ?? '未記録'}</code> / 行 {start.call_site?.line ?? '未記録'}</dd></div>
      </dl>
      <h4>記録された引数</h4>
      {start.args === undefined ? <UnavailableEventData ev={node.primary} {...access}/> : <ValueView ep={ep} value={start.args}/>}
      <h4>記録された結果</h4>
      {!node.end ? <p>未記録（終了イベントなし）</p> : error ? <p>エラー終了（戻り値なし）</p> : 'return' in end ? <ValueView ep={ep} value={end.return}/> : <UnavailableEventData ev={node.end} {...access}/>}
      <h4>記録されたエラー</h4>
      {error ? <>
        <p><strong>{end.error_type ?? '例外の種類は未記録'}</strong></p>
        <pre>{message.text ?? 'エラーの説明は未記録'}</pre>
        {message.partial && <p className="api-python-muted">{message.loading ? '全文を読み込み中…' : 'エラー文は先頭のみ取得できました。'}</p>}
        {(end.message_redacted || end.traceback_redacted) && <p className="api-python-muted">記録時に秘密情報がマスクされています。</p>}
        {(end.message_cut || end.traceback_cut) && <p className="api-python-muted">記録上限によって一部が省略されています。</p>}
        {end.cause && <><h4>連鎖した例外（記録）</h4><ValueView ep={ep} value={end.cause}/></>}
        <p>原因未特定：この記録から、ロボットや環境で起きた原因までは特定できません。</p>
        <details><summary>記録されたトレースバック</summary><pre>{traceback.text ?? '未記録'}</pre>{traceback.partial && <p>全文は未取得です。</p>}</details>
      </> : <p>{node.end ? '例外の記録なし' : '未記録（終了イベントなし）'}</p>}
    </section>
  </div>;
}

function ApiDetails({ node, ep, ...access }: { node: TNode; ep: EpisodeRef } & EventDataAccess) {
  const [open, setOpen] = useState(false);
  return <details className="api-python-details" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>詳細</summary>
    {open && <RecordedApiDetails node={node} ep={ep} {...access}/>}
  </details>;
}

function followSelectionInPane(pane: HTMLElement, selector: string) {
  const reveal = (previousHeight?: number) => {
    const item = pane.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
    if (!item) return;
    const offset = item.top - pane.getBoundingClientRect().top - pane.clientTop;
    // On shrink, keep following the selection only if the user could still see it.
    if (previousHeight !== undefined && (offset + item.height <= 0 || offset >= previousHeight)) return;
    if (offset < 0 || offset + item.height > pane.clientHeight) {
      pane.scrollTop += offset - Math.max(0, (pane.clientHeight - item.height) / 2);
    }
  };
  reveal();
  if (typeof ResizeObserver === 'undefined') return;
  let width = pane.clientWidth;
  let height = pane.clientHeight;
  const observer = new ResizeObserver(() => {
    if (pane.clientWidth !== width || height === 0) reveal();
    else if (pane.clientHeight < height) reveal(height);
    width = pane.clientWidth;
    height = pane.clientHeight;
  });
  observer.observe(pane);
  return observer;
}

export function ApiPythonPanel({ model, ep, apiCues, selectedKey, onSelect, turn = null, assetStates, onRetryAsset }: ApiPythonPanelProps) {
  const selected = model.allNodes.find(node => node.key === selectedKey) ?? null;
  const api = selected?.kind === 'api_call' ? selected : null;
  const site = api ? apiCallSite(model, api) : null;
  const block = selected?.kind === 'code_block' ? selected : site?.block ?? null;
  const code = useFullText(ep, block ? dataOf(block.primary, 'code_block_start').code : null);
  const marked = site ? apiLineMatch(site, code.text, code.partial) : { line: null, reason: null };
  const definition = api ? apiDefinition(api) : null;
  const blocks = [...model.blocks].sort((a, b) => a.seq - b.seq);
  const blockIndex = block ? blocks.findIndex(candidate => candidate.key === block.key) : -1;
  const apis = model.allNodes.filter(node => node.kind === 'api_call' && (turn === null || turnOf(node) === turn)).sort((a, b) => a.seq - b.seq);
  const times = new Map(apiCues.map(cue => [cue.node.key, cue.time]));
  const apiList = useRef<HTMLDivElement>(null);
  const codeScroll = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ key: string; text: string; top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const listPane = apiList.current;
    const codePane = codeScroll.current;
    if (!listPane || !codePane) return;
    if (marked.line === null) codePane.scrollTop = 0;
    const listObserver = followSelectionInPane(listPane, '[data-api-selected="true"]');
    const codeObserver = followSelectionInPane(codePane, '[data-code-highlighted="true"]');
    return () => {
      listObserver?.disconnect();
      codeObserver?.disconnect();
    };
  }, [selectedKey, turn, block?.key, marked.line, code.text]);

  useEffect(() => {
    if (!hover) return;
    const dismiss = () => setHover(null);
    window.addEventListener('scroll', dismiss, { passive: true });
    return () => window.removeEventListener('scroll', dismiss);
  }, [hover]);

  const preview = (node: TNode, target: HTMLButtonElement) => {
    const box = target.getBoundingClientRect();
    setHover({ key: node.key, text: apiDefinition(node)?.summaryJa ?? '説明未登録',
      left: Math.max(12, Math.min(box.left, (window.innerWidth || 1024) - 370)),
      top: Math.max(12, Math.min(box.bottom + 6, (window.innerHeight || 768) - 110)) });
  };

  return <div className="api-python-panel" data-api-python-panel="">
    <section className="api-python-list-section" aria-label="時刻とAPIの一覧">
      <div className="api-python-list-heading"><span>動画時刻</span><span>API（記録順）</span></div>
      <div ref={apiList} className="api-python-list" role="region" aria-label="API呼び出し" tabIndex={0}
        onScroll={() => setHover(null)}>
        {apis.map(node => {
          const time = times.get(node.key);
          return <button key={node.key} type="button" className="api-python-row"
            data-api-event={node.primary.event_id} data-api-selected={node.key === selectedKey}
            aria-pressed={node.key === selectedKey} aria-describedby={hover?.key === node.key ? 'api-role-preview' : undefined}
            onMouseEnter={event => preview(node, event.currentTarget)} onMouseLeave={() => setHover(null)}
            onFocus={event => preview(node, event.currentTarget)} onBlur={() => setHover(null)}
            onClick={() => onSelect(node)}>
            <span className="api-python-time">{time === undefined ? '同期なし' : `${time.toFixed(2)}s`}</span>
            <span className="api-python-name"><code>{apiName(node)}</code><small>#{node.seq}{node.failed ? ' · エラー' : ''}{time === undefined ? ' · 同期情報なし' : ''}</small></span>
          </button>;
        })}
        {apis.length === 0 && <p className="api-python-empty">この範囲のAPI呼び出しは未記録です。</p>}
      </div>
    </section>
    <section className="api-python-code-section" aria-label="実行されたPython" data-api-code-block={block?.key ?? undefined} data-api-line={marked.line ?? undefined}>
      <header className="api-python-code-heading">
        <strong>実行されたPython{blockIndex >= 0 ? ` · ${blockIndex + 1} / ${blocks.length}` : ''}</strong>
        <nav aria-label="実行コードの前後移動">
          <button type="button" disabled={blockIndex <= 0} onClick={() => onSelect(blocks[blockIndex - 1])} aria-label="前のコードブロック">← 前</button>
          <button type="button" disabled={blocks.length === 0 || blockIndex >= blocks.length - 1} onClick={() => onSelect(blocks[blockIndex + 1])} aria-label={blockIndex < 0 ? '最初のコードブロック' : '次のコードブロック'}>{blockIndex < 0 ? '最初' : '次'} →</button>
        </nav>
      </header>
      <div className="api-python-selected-description" data-api-description="">
        {api ? <><strong>{apiName(api)}{marked.line ? ` · ${marked.line}行目` : ''}</strong><p>{definition?.summaryJa ?? '説明未登録'}</p>{definition && <small className="api-python-muted">定義の出典は「詳細」</small>}</> : <p>APIを選ぶと、役割と呼び出し行を確認できます。</p>}
      </div>
      <div ref={codeScroll} className="api-python-code-body" role="region" aria-label="Pythonコードと記録" tabIndex={0}>
        {api && <ApiDetails key={api.key} node={api} ep={ep} assetStates={assetStates} onRetryAsset={onRetryAsset}/>}
        {site?.reason && <p className="api-python-missing">{site.reason}</p>}
        {!site?.reason && marked.reason && <p className="api-python-missing">{marked.reason}</p>}
        {block ? <>
          <p className="api-python-code-provenance">出典: code_block_start の実行コード · ターン {turnOf(block) ?? '未記録'}</p>
          {code.text === null ? <p className="api-python-empty">実行コードは未記録です。</p> : <CodeView code={code.text} markLine={marked.line} className="api-python-code"/>}
          {code.partial && <p className="api-python-missing">{code.loading ? 'コード全文を読み込み中…' : `コード全文は未取得です${code.error ? `: ${code.error}` : ''}`}</p>}
        </> : <p className="api-python-empty">対応する実行コードは未記録です。</p>}
      </div>
    </section>
    {hover && <div id="api-role-preview" role="tooltip" className="api-python-tooltip" style={{ left: hover.left, top: hover.top }}>{hover.text}</div>}
  </div>;
}
