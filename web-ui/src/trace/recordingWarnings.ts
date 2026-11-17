import type { EpisodeModel } from './model';
import { dataOf, type EpisodeEndData, type EpisodeSummary, type Gap, type StartupHookFailures, type TraceEvent } from './types';

export const LEGACY_PROMPT_HOOK_REASON = '_build_multi_turn_decision_prompt_legacy: not found';
export const UNUSED_HOOK_STATUS = '終了（未使用フックの警告あり）';

function isMissingLegacyPromptHook(failure: unknown): boolean {
  if (!failure || typeof failure !== 'object') return false;
  const { hook, target, reason } = failure as Record<string, unknown>;
  return hook === 'H5/H6' && target === 'capx.utils.launch_utils' && reason === LEGACY_PROMPT_HOOK_REASON;
}

function withoutUnusedStartupHooks(gaps: Gap[], startup: StartupHookFailures, laterFailures: TraceEvent[] = []) {
  const hooksFailed = startup.failures.filter(failure => !isMissingLegacyPromptHook(failure));
  const count = startup.failures.length - hooksFailed.length;
  const hookGaps = gaps.filter(gap => gap.code === 'hook_install_failed');
  const gap = hookGaps[0];
  if (count === 0 || hookGaps.length !== 1 || gap.count !== startup.failures.length + laterFailures.length ||
      (gap.first_seq != null && gap.first_seq !== startup.seq)) return null;

  const remaining = gap.count - count;
  const firstSeq = hooksFailed.length ? startup.seq : laterFailures.reduce((first, event) => Math.min(first, event.seq), Infinity);
  return { count, hooksFailed, gaps: gaps.flatMap(g => g !== gap ? [g] : remaining > 0 ? [{ ...g, count: remaining, first_seq: firstSeq }] : []) };
}

function otherLossReported(report: EpisodeSummary | EpisodeEndData | null | undefined): boolean {
  return Boolean(report?.dropped_events || report?.late_events || report?.n_warnings);
}

/** The picker has the startup evidence, but cannot account for failures from later events. */
export function summaryRecordingWarnings(summary: EpisodeSummary) {
  const gaps = summary.gaps ?? [];
  const startup = summary.startup_hook_failures;
  const adjusted = summary.status === 'ended_with_gaps' && summary.trace_complete === false &&
    startup && Array.isArray(startup.failures) && !summary.episode_json_error
    ? withoutUnusedStartupHooks(gaps, startup) : null;
  return {
    gaps: adjusted?.gaps ?? gaps,
    onlyUnused: adjusted !== null && adjusted.gaps.length === 0 && !otherLossReported(summary),
  };
}

/** The episode summary can arrive before the events that identify the failed hook. */
export function awaitingOracleHookEvidence(summary: EpisodeSummary | null, reader: { eof: boolean; error?: string | null }): boolean {
  if (reader.eof || reader.error || summary?.status !== 'ended_with_gaps' || summary.trace_complete !== false) return false;
  if (summary.startup_hook_failures) return summaryRecordingWarnings(summary).onlyUnused;
  const config = summary.episode?.config_flags;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  const flags = config as Record<string, unknown>;
  return !summary.dropped_events && !summary.late_events &&
    summary.gaps?.length === 1 && summary.gaps[0]?.code === 'hook_install_failed' && summary.gaps[0].count === 1 &&
    flags.use_oracle_code === true && (flags.multi_turn === false || flags.use_legacy_multi_turn_decision_prompt === false);
}

/** Reconcile the original gap count with the startup failures and subsequent warning events. */
export function episodeRecordingWarnings(model: EpisodeModel | null, summary?: EpisodeSummary | null) {
  const startEvent = model?.episodeStart;
  const start = dataOf(startEvent, 'episode_start');
  const end = dataOf(model?.episodeEnd, 'episode_end');
  const failed = Array.isArray(start.tracer?.hooks_failed) ? start.tracer.hooks_failed : [];
  const gaps = summary?.gaps ?? end.gaps ?? [];
  const original = { gaps, hooksFailed: failed, count: 0, onlyUnused: false };
  if (!model?.episodeEnd || !startEvent || !failed.length || summary?.status === 'incomplete' || summary?.status === 'unscoped' ||
    (summary && (summary.episode_id !== startEvent.episode_id || (summary.run_id != null && summary.run_id !== startEvent.run_id)))) return original;

  const startup = { seq: startEvent.seq, failures: failed };
  const laterFailures = model.warnings.filter(event => {
    const warning = dataOf(event, 'trace_warning');
    return warning.code === 'hook_install_failed' && event.seq > startEvent.seq &&
      warning.counts_as_gap !== false && warning.writer_generated !== true;
  });
  const endSeq = model.episodeEnd.seq;
  const beforeEnd = laterFailures.filter(event => event.seq < endSeq);
  const adjusted = withoutUnusedStartupHooks(gaps, startup, summary?.gaps ? laterFailures : beforeEnd);
  if (!adjusted || (summary?.gaps && end.gaps && !withoutUnusedStartupHooks(end.gaps, startup, beforeEnd))) return original;
  return {
    ...adjusted,
    onlyUnused: adjusted.gaps.length === 0 && model.warnings.length === 0 &&
      !otherLossReported(summary) && !otherLossReported(end) &&
      (!summary?.episode_json_error || summary.episode_json_error === 'missing'),
  };
}
