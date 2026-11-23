/** Local run copies are disposable only after the server verifies their remote originals. */
import { useEffect, useRef, useState } from 'react';
import { currentSiteName, remoteName } from '../navigation/site';
import { ApiError, errorText, gmoApi, type GmoLocalCopy } from '../trace/api';
import { useAsync, useInterval } from '../trace/hooks';

export function localCopySize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), 4);
  return `${(bytes / 1000 ** unit).toFixed(1)} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`;
}

export function localCopyReason(reason: string | null | undefined): string {
  const remote = remoteName();
  switch (reason) {
    case 'busy': return '実行中か取り込み中のため消せません';
    case 'not_on_remote': return `${remote} に元の記録がないため消せません（消すと戻せません）`;
    case 'unknown': return `${remote} の一覧を確認できないため、今は消せません`;
    case 'invalid_id': return '記録の ID が不正なため消せません';
    case 'missing': return '手元の写しが見つかりません。一覧を更新してください';
    case 'unsafe_path': return '保存先を安全に確認できないため消せません';
    case 'changed': return '記録か設定が変わったため消せません。一覧を更新してください';
    case 'io_error': return '手元の写しを消せませんでした。保存先を確認してください';
    default: return '手元の写しを消せませんでした。一覧を更新して、もう一度お試しください';
  }
}

function deletionError(error: unknown): string {
  if (error instanceof ApiError && error.body && typeof error.body === 'object') {
    const detail = (error.body as { detail?: unknown }).detail;
    if (detail && typeof detail === 'object') {
      const { reason, message } = detail as { reason?: unknown; message?: unknown };
      if (typeof reason === 'string' && ['busy', 'not_on_remote', 'unknown'].includes(reason)) return localCopyReason(reason);
      if (typeof message === 'string' && /[ぁ-んァ-ヶ一-龯]/.test(message)) return message;
      if (typeof reason === 'string') return localCopyReason(reason);
    }
  }
  return `手元の写しを消せませんでした：${errorText(error)}`;
}

function startedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ja-JP', { hour12: false });
}

/** Kept in the list page's hook tree so availability, refreshes and notices share its lifecycle. */
export function useLocalCopies(enabled: boolean, onDeleted: () => void) {
  const site = currentSiteName();
  const copies = useAsync(enabled ? signal => gmoApi.localCopies(signal) : null, [enabled, site]);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<GmoLocalCopy | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const cancel = useRef<HTMLButtonElement | null>(null);
  const previous = useRef<HTMLButtonElement | null>(null);
  const restoreFocus = useRef<HTMLButtonElement | null>(null);
  useInterval(copies.poll, 30_000, enabled);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (selected) cancel.current?.focus();
    else if (!deleting && restoreFocus.current) {
      restoreFocus.current.focus();
      restoreFocus.current = null;
    }
  }, [selected, deleting]);
  const dismiss = () => {
    if (request.current) return;
    restoreFocus.current = previous.current;
    setSelected(null);
  };
  const remove = async () => {
    if (!selected || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setDeleting(true); setFailure(null); setNotice(null);
    try {
      const result = await gmoApi.deleteLocalCopy(selected.run_id, controller.signal);
      if (controller.signal.aborted) return;
      restoreFocus.current = trigger.current;
      setSelected(null);
      setNotice(`${localCopySize(result.freed_bytes)} を空けました`);
      copies.reload(); onDeleted();
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      setFailure(deletionError(error));
      copies.reload();
    } finally {
      if (request.current === controller) {
        request.current = null;
        setDeleting(false);
      }
    }
  };
  if (!enabled) return { control: null, panel: null };
  return {
    control: <button type="button" ref={trigger} aria-expanded={open} aria-controls="eval-local-copies" disabled={deleting} onClick={() => {
      setOpen(!open);
      if (open) setSelected(null);
      else copies.reload();
    }}>手元の写し {copies.data ? localCopySize(copies.data.total_bytes) : '…'}</button>,
    panel: <>
      {notice && <p role="status" className="eval-local-success">{notice}</p>}
      {open && <section id="eval-local-copies" className="eval-local-copies" aria-labelledby="eval-local-copies-title" aria-busy={deleting}>
        <div className="eval-local-heading"><h2 id="eval-local-copies-title">手元の写し</h2><button type="button" disabled={deleting} onClick={() => { setOpen(false); setSelected(null); trigger.current?.focus(); }}>閉じる</button></div>
        <p className="eval-local-note">{remoteName()} から取り込んだ記録です。容量の大きい順に表示しています。</p>
        {copies.loading && !copies.data && <p role="status">手元の写しを読み込み中…</p>}
        {copies.error && <p role="alert" className="eval-error">手元の写しを読み込めません：{copies.error}</p>}
        {failure && <p role="alert" className="eval-error">{failure}</p>}
        {selected && <div className="eval-local-confirm" role="alertdialog" aria-labelledby="eval-local-confirm-title" aria-describedby="eval-local-confirm-text" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); dismiss(); } }}>
          <h3 id="eval-local-confirm-title">手元の写しを消しますか</h3>
          <p id="eval-local-confirm-text">{selected.run_id} の手元の写し（{localCopySize(selected.size_bytes)}）を消します。{remoteName()} 上の記録は消えません。自動では取り込み直さず、試行を開いたときにその試行だけ取り込みます。</p>
          <div className="eval-local-actions"><button type="button" className="eval-local-delete" disabled={deleting} onClick={() => { void remove(); }}>{deleting ? '消しています…' : '消す'}</button><button type="button" ref={cancel} disabled={deleting} onClick={dismiss}>やめる</button></div>
        </div>}
        {copies.data && (copies.data.runs.length ? <ul className="eval-local-runs" aria-label="手元の記録">
          {[...copies.data.runs].sort((a, b) => b.size_bytes - a.size_bytes || a.run_id.localeCompare(b.run_id)).map(run => <li key={run.run_id}>
            <div className="eval-local-run"><strong>{run.run_id}</strong>{run.is_eval && run.started_at && <time dateTime={run.started_at}>{startedAt(run.started_at)}</time>}</div>
            <div className="eval-local-count">{run.episode_count} 試行</div><div className="eval-local-size">{localCopySize(run.size_bytes)}</div>
            <div className="eval-local-action">{run.deletable ? <button type="button" className="eval-local-delete" disabled={deleting || selected !== null} aria-label={`${run.run_id} の手元の写しを消す`} onClick={event => { previous.current = event.currentTarget; setFailure(null); setNotice(null); setSelected(run); }}>消す</button> : <span>{localCopyReason(run.reason)}</span>}</div>
          </li>)}
        </ul> : <p>手元の写しはありません。</p>)}
      </section>}
    </>,
  };
}
