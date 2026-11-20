/** Renew only the open remote trial's lease. Cleanup lets the server's lease expire. */
import { useEffect, useState } from 'react';
import { ApiError, errorText, gmoApi, type GmoEpisodeSummary, type GmoLiveStatus } from './api';

export const REMOTE_LIVE_STATUS_MS = 2000;
export const REMOTE_LIVE_RENEW_MS = 10_000;

interface RemoteLiveState {
  key: string;
  status: GmoLiveStatus | null;
  error: string | null;
}

export function useRemoteLive(runId: string | null, episodeId: string | null, live: boolean,
  episodeStatus: string | null, videoPending: boolean) {
  // An incomplete local snapshot can belong to a writer that is still running.
  // Keep a lease through the final video copy, which can outlast episode_end.
  const active = live && !!runId && !!episodeId &&
    (episodeStatus === 'running' || episodeStatus === 'incomplete' || videoPending);
  const key = JSON.stringify([runId, episodeId]);
  const [state, setState] = useState<RemoteLiveState | null>(null);

  useEffect(() => {
    if (!active || !runId || !episodeId) return;
    const controller = new AbortController();
    const { signal } = controller;
    let timer: number | undefined;
    let discovered = false;
    let nextRenewAt = 0;
    let previous: GmoLiveStatus | null = null;
    setState({ key, status: null, error: null });

    const tick = async () => {
      const startedAt = Date.now();
      let again = true;
      try {
        if (!discovered) {
          let config;
          try { config = await gmoApi.config(signal); }
          catch (error) {
            if (error instanceof ApiError && error.status === 404) { again = false; return; }
            throw error;
          }
          if (signal.aborted) return;
          if (!config.enabled || !config.configured) { again = false; return; }
          // Ask only about this trial's run: the team listing can take minutes.
          const lookup = async (refresh: boolean) => {
            try { return await gmoApi.episode(runId, episodeId, refresh, signal); }
            catch (error) {
              // Not on GMO, or in more than one GMO location: nothing to follow.
              if (error instanceof ApiError && (error.status === 404 || error.status === 409)) return null;
              throw error;
            }
          };
          const followable = (row: GmoEpisodeSummary | null) => !!row && !row.conflict
            && (row.status === 'running' || !!row.episode?.video_copy_pending);
          let row = await lookup(false);
          if (signal.aborted) return;
          // A cached listing can predate a trial that started since; ask GMO
          // again before deciding that the open trial is not running there.
          if (!followable(row)) row = await lookup(true);
          if (signal.aborted) return;
          if (!followable(row)) {
            again = false;
            return;
          }
          discovered = true;
        }
        if (signal.aborted) return;
        const renew = Date.now() >= nextRenewAt;
        const status = renew ? await gmoApi.follow(runId, episodeId, signal) : await gmoApi.live(signal);
        if (signal.aborted) return;
        if (renew) nextRenewAt = Date.now() + REMOTE_LIVE_RENEW_MS;
        // Another open page can replace the single follower. Do not take it back.
        previous = status.run_id === runId && status.episode_id === episodeId ? status : {
          following: false, run_id: runId, episode_id: episodeId, last_ok_at: previous?.last_ok_at ?? null,
          last_error: null, interval_s: REMOTE_LIVE_STATUS_MS / 1000, copied_bytes: previous?.copied_bytes ?? 0,
          stopped_reason: 'replaced',
        };
        setState({ key, status: previous, error: null });
        if (!previous.following) {
          // A suspended browser can miss its renewals. Resume the same open
          // trial automatically, while leaving deliberate stops terminal.
          if (previous.stopped_reason === 'lease_expired') nextRenewAt = 0;
          else again = false;
        }
      } catch (error) {
        if (!signal.aborted) setState({ key, status: previous, error: errorText(error) });
      } finally {
        // One request at a time, including discovery and slow lease renewals.
        if (!signal.aborted && again) timer = window.setTimeout(() => void tick(),
          Math.max(0, REMOTE_LIVE_STATUS_MS - (Date.now() - startedAt)));
      }
    };
    void tick();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [key, runId, episodeId, active]);

  const current = active && state?.key === key ? state : null;
  return { status: current?.status ?? null, error: current?.error ?? null };
}
