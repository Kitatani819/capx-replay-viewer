/**
 * Replay details: 入出力, 候補, 統合結果. Existing diagnostic renderers are
 * reused inside these tabs; supplementary debug information stays available.
 * Tab contents fetch payload files lazily, only for the selected event. The
 * tab body is keyed by the selected event, so nothing a tab loaded for one
 * event (an array preview, a search) is shown for another; a render error in
 * one tab shows a notice instead of blanking the page.
 *
 * Events whose data the writer moved to an asset (line over 256 KB) get a
 * notice while that data is loading, when it failed, or when it was never
 * written (dataAsset.ts): the selected event's own, and in one line the other
 * events the panes read for this selection (later requests, the previous
 * request, nested service calls). The tabs get the loading states too, so a
 * pane that reads such an event says why its data is missing.
 *
 * Related: tabs/*.tsx, TraceViewerPage.tsx.
 */

import type { ReactNode } from 'react';
import { dataAssetRef, pendingAsset, type DataAssetState } from '../dataAsset';
import { LABELS } from '../labels';
import type { EpisodeModel, Selection, TNode } from '../model';
import type { EpisodeSummary, TraceEvent } from '../types';
import { Notice } from './common';
import { DataAssetInline, NO_ASSET_STATES } from './DataAssetState';
import { ErrorBoundary } from './ErrorBoundary';
import { InputOutputTab } from './tabs/InputOutputTab';
import { EnsembleTab } from './tabs/EnsembleTab';
import { ApiTurnModelTab } from './tabs/ApiTurnModelTab';
import type { EpisodeRef } from './ValueView';

export interface RangeFocus {
  eventId: string;
  path: string;
  start: number;
  end: number;
  token: number;
}

export interface TabProps {
  model: EpisodeModel;
  ep: EpisodeRef;
  /** The episode summary (with episode.json as `episode`); null until loaded. */
  summary: EpisodeSummary | null;
  selection: Selection;
  running: boolean;
  onSelect: (node: TNode, eventId?: string) => void;
  /** Opens the model-input tab of a request with a payload range marked. */
  onFocusRange: (eventId: string, path: string, start: number, end: number) => void;
  focus: RangeFocus | null;
  /** Loading state of data moved to assets, per event id (dataAsset.ts). */
  assetStates?: ReadonlyMap<string, DataAssetState>;
  /** Loads one event's data asset again, bypassing the file cache. */
  onRetryAsset?: (ev: TraceEvent) => void;
}

interface DetailTabsProps extends Omit<TabProps, 'selection'> {
  apiPythonMode?: boolean;
  selection: Selection | null;
  tab: number;
  onTab: (i: number) => void;
  /** An event id from the URL that the loaded events do not contain. */
  missingEventId?: string | null;
  /** Every event whose data asset the panes need for the selection (dataAssetTargets). */
  assetEvents?: TraceEvent[];
}

/**
 * Notice for the events of the selection whose data is in an asset and not (yet) merged:
 * loading, failed (with a retry), or never written. Nothing for loaded ones. `related` are
 * the other events the panes read for this selection; they get one line each in a
 * compact notice.
 */
export function DataAssetNotice({
  events,
  related = [],
  states,
  onRetry,
}: {
  events: TraceEvent[];
  related?: TraceEvent[];
  states: ReadonlyMap<string, DataAssetState>;
  onRetry?: (ev: TraceEvent) => void;
}) {
  const rows: ReactNode[] = [];
  for (const ev of events) {
    const ref = dataAssetRef(ev);
    if (!ref) continue;
    const st = states.get(ev.event_id);
    if (st?.status === 'loaded') continue;
    const where = `#${ev.seq} ${ev.event_type}`;
    if (!ref.path || !ref.written || st?.status === 'unwritten') {
      rows.push(
        <Notice key={ev.event_id} tone="amber">
          {where} の data は 256 KB を超えたため別ファイルに移されましたが、そのファイルは{LABELS.notRecorded}です
          {ref.reason ? `（${ref.reason}）` : ''}。行に残った短い項目だけを表示しています。
        </Notice>,
      );
    } else if (st?.status === 'failed') {
      rows.push(
        <Notice key={ev.event_id} tone="red">
          {where} の data（{ref.path}）を読み込めません: {st.error}。行に残った短い項目だけを表示しています。{' '}
          {onRetry && (
            <button type="button" onClick={() => onRetry(ev)} className="underline underline-offset-2">
              再読み込み
            </button>
          )}
        </Notice>,
      );
    } else {
      rows.push(
        <Notice key={ev.event_id} tone="gold">
          {where} の data は 256 KB を超えたため {ref.path} に保存されています。読み込み中…（読み込むまでは行に残った短い項目だけを表示します）
        </Notice>,
      );
    }
  }
  const own = new Set(events.map((e) => e.event_id));
  const others = related.filter((ev) => !own.has(ev.event_id) && pendingAsset(ev, states) !== null);
  if (others.length > 0) {
    const bad = others.some((ev) => pendingAsset(ev, states)?.kind !== 'loading');
    rows.push(
      <Notice key="related" tone={bad ? 'amber' : 'gold'}>
        <div>この選択で参照する別のイベントの data（256 KB を超えたため別ファイル）:</div>
        {others.map((ev) => (
          <div key={ev.event_id} className="pl-2">
            #{ev.seq} {ev.event_type}: <DataAssetInline ev={ev} states={states} onRetry={onRetry} />
          </div>
        ))}
      </Notice>,
    );
  }
  return rows.length ? <div className="space-y-1 mb-2">{rows}</div> : null;
}

export function DetailTabs({ tab, onTab, selection, apiPythonMode = false, missingEventId = null, assetStates = NO_ASSET_STATES, onRetryAsset, assetEvents = [], ...rest }: DetailTabsProps) {
  const eventId = selection?.eventId ?? null;
  let body: ReactNode;
  if (!selection) {
    body = (
      <div className="p-4 text-xs text-text-tertiary space-y-1">
        {missingEventId && <div className="text-amber-300">URL で指定されたイベント {missingEventId} は、このエピソードの記録にありません。</div>}
        <div>{apiPythonMode ? 'この位置ではAPIは選択されていません。左のAPI一覧から選択できます。' : '左のタイムラインでイベントを選択してください。'}</div>
      </div>
    );
  } else {
    const props: TabProps = { ...rest, selection, assetStates, onRetryAsset,
      onSelect: (node, eventId) => { onTab(0); rest.onSelect(node, eventId); } };
    switch (tab) {
      case 1:
        body = <EnsembleTab {...props} mode="candidates" onTurnSelect={rest.onSelect} />;
        break;
      case 2:
        body = <EnsembleTab {...props} mode="synthesis" onTurnSelect={rest.onSelect} />;
        break;
      default:
        body = apiPythonMode && ['api_call','code_block'].includes(selection.node.kind)
          ? <ApiTurnModelTab {...props} /> : <InputOutputTab {...props} />;
        break;
    }
  }
  return (
    <div className="replay-inspector bg-surface-raised">
      <div role="tablist" aria-label="処理の詳細" className="replay-tabs flex-shrink-0 flex items-end border-b border-surface-border overflow-x-auto">
        {LABELS.replayTabs.map((label, i) => (
          <button
            key={label}
            type="button"
            role="tab"
            aria-selected={tab === i}
            onClick={() => onTab(i)}
            className={`px-3 py-1.5 text-xs font-display whitespace-nowrap rounded-t-md border-b-2 transition-colors ${
              tab === i ? 'text-accent border-accent bg-surface' : 'text-text-tertiary border-transparent hover:text-text-primary'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" data-selected-event={eventId ?? undefined} className="replay-detail-body">
        {selection && <DataAssetNotice events={selection.node.events} related={assetEvents} states={assetStates} onRetry={onRetryAsset} />}
        <ErrorBoundary key={`${tab}|${eventId ?? ''}`} label={`「${LABELS.replayTabs[tab] ?? ''}」タブ`}>
          {body}
        </ErrorBoundary>
      </div>
    </div>
  );
}
