/** Import only the missing episode named in the URL; never a whole run. */
import { useEffect, useState } from 'react';
import { ApiError, errorText, gmoApi } from './api';
import { fmtBytes } from './format';

export interface EpisodeImportState { busy: boolean; message: string; retry?: () => void }
function waitForPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { window.clearTimeout(timer); reject(new Error('aborted')); };
    const timer = window.setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 1000);
    signal.addEventListener('abort', abort, { once: true });
  });
}
export function useMissingEpisodeImport(runId: string | null, episodeId: string | null, missing: boolean, onReady: () => void,
  load: { loading: boolean; error: string | null }): EpisodeImportState | null {
  const key = JSON.stringify([runId, episodeId]);
  const [state, setState] = useState<{ key: string; value: EpisodeImportState; imported?: boolean } | null>(null);
  useEffect(() => {
    if (!missing || !runId || !episodeId) return;
    const controller = new AbortController();
    const signal = controller.signal;
    const update = (busy: boolean, message: string) => {
      if (!signal.aborted) setState({ key, value: { busy, message } });
    };
    const start = async () => {
      update(true, '手元にないため、GMO の記録を確認中…');
      try {
        let config;
        try { config = await gmoApi.config(signal); }
        catch (error) {
          if (error instanceof ApiError && error.status === 404) {
            update(false, '手元にありません。GMO連携を有効にすると自動で取り込みます');
            return;
          }
          throw error;
        }
        if (signal.aborted) return;
        if (!config.enabled || !config.configured) {
          update(false, '手元にありません。GMO連携を有効にすると自動で取り込みます');
          return;
        }
        const rows = await gmoApi.episodes('all', false, signal);
        if (signal.aborted) return;
        const matches = rows.filter(row => row.run_id === runId && row.episode_id === episodeId);
        if (matches.length === 0) { update(false, 'この試行は手元にも GMO にも見つかりません。'); return; }
        if (matches.length > 1 || matches.some(row => row.conflict)) {
          update(false, '同じ run ID が GMO の複数の場所にあるため取り込めません。'); return;
        }
        const row = matches[0];
        if (row.size_bytes >= 1024 ** 3) { update(false, '1 GiB の上限を超えるため、この試行は自動で取り込めません。'); return; }
        update(true, `GMOから取り込み中（${fmtBytes(row.size_bytes)}）`);
        let jobId: string;
        try { jobId = (await gmoApi.fetch(runId, episodeId, signal)).job_id; }
        catch (error) {
          if (!(error instanceof ApiError) || error.status !== 409) throw error;
          const jobs = (await gmoApi.jobs(signal)).filter(job => job.run_id === runId && job.episode_id === episodeId);
          const existing = jobs.find(job => job.state === 'queued' || job.state === 'running') ?? jobs[0];
          if (!existing) throw error;
          jobId = existing.job_id;
        }
        while (!signal.aborted) {
          const jobs = await gmoApi.jobs(signal);
          if (signal.aborted) return;
          const job = jobs.find(item => item.job_id === jobId);
          if (!job) throw new Error('取り込み状況が見つかりません。');
          if (job.state === 'failed') throw new Error(job.error || '取り込みに失敗しました。');
          if (job.state === 'done') {
            setState({ key, value: { busy: true, message: '取り込んだ試行を読み込み中…' }, imported: true });
            onReady();
            return;
          }
          await waitForPoll(signal);
        }
      } catch (error) {
        if (!signal.aborted) update(false, `GMOから取り込めません：${errorText(error)}`);
      }
    };
    void start();
    return () => controller.abort();
  }, [key, missing, runId, episodeId, onReady]);
  if (!missing || state?.key !== key) return null;
  if (state.imported && !load.loading) return {
    busy: false,
    message: `取り込みは完了しましたが、試行を読み込めません：${load.error ?? '試行が見つかりません。'}`,
    retry: onReady,
  };
  return state.value;
}
