/** Trial-level facts and their event anchors, before opening hundreds of log rows. */
import { useCallback, useMemo, useState } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { evalApi } from '../../evals/api';
import type { EvalDetail, EvalTrial } from '../../evals/api';
import { causeEvidence, causeHeadline, ruleSourceHref } from '../../evals/failureReasons';
import { TrialConditions } from '../../evals/TrialConditions';
import { ApiError, episodeFileUrl, traceApi, type EpisodeRef } from '../api';
import { fmtDuration } from '../format';
import { cameraForVideo, cameraLabel, mainCameraOf } from '../cameras';
import { episodeVideos } from '../playback';
import { useAsync, useEpisodeEvents, useFullText } from '../hooks';
import { useMissingEpisodeImport } from '../importEpisode';
import { buildEpisodeModel, camerasOf, textOf, type EpisodeModel } from '../model';
import { episodeVerdict, type TaskVerdict } from '../outcome';
import { comparisonUrl, trialEventUrl } from '../sideBySide';
import { baselineForEpisode, firstLine, lastRecordedFrame, trialSummaryFacts, type SummaryFrame } from '../trialSummary';
import type { EpisodeSummary, RunnerRecord } from '../types';
import { Badge } from './common';
import { TaskOutcomeBadge } from './TaskOutcomeBadge';
import '../trialSummary.css';

interface BaselineSummary {
  ep: EpisodeRef;
  trial: EvalTrial;
  frame: SummaryFrame | null;
  model?: EpisodeModel;
}
interface CardProps {
  camera?: string | null;
  cameraOptions?: string[];
  onCameraChange?: (camera: string) => void;
  ep: EpisodeRef;
  model: EpisodeModel;
  summary: EpisodeSummary;
  verdict: TaskVerdict;
  baseline?: BaselineSummary | null;
  onJump?: (eventId: string) => void;
  firstErrorText?: string | null;
  observationText?: string | null;
  decisionText?: string | null;
  footer?: ReactNode;
}
export function TrialSummaryCard({ ep, model, camera: sharedCamera, cameraOptions, onCameraChange, summary, verdict, baseline, onJump, firstErrorText, observationText, decisionText, footer }: CardProps) {
  const facts = trialSummaryFacts(model, summary);
  const [localCamera, setLocalCamera] = useState<string | null>(null);
  const cameras = [...new Set([...camerasOf(model), ...(cameraOptions ?? []),
    ...episodeVideos(ep, model).map(video => cameraForVideo(model, video.name)).filter((name): name is string => name !== null)])];
  const baselineCameras = baseline?.model ? [...new Set([...camerasOf(baseline.model),
    ...episodeVideos(baseline.ep, baseline.model).map(video => cameraForVideo(baseline.model!, video.name)).filter((name): name is string => name !== null)])] : [];
  const camera = sharedCamera ?? localCamera ?? mainCameraOf(model);
  const currentFrame = lastRecordedFrame(model, camera);
  const baselineCamera = baseline?.model
    ? camera && baselineCameras.includes(camera) ? camera : mainCameraOf(baseline.model)
    : baseline?.frame?.camera ?? null;
  const baselineFrame = baseline?.model ? lastRecordedFrame(baseline.model, baselineCamera) : baseline?.frame;
  const baselineFallback = !!(camera && baselineCamera && camera !== baselineCamera);
  const currentFrameMissing = !!(camera && cameras.length > 1 && !currentFrame);
  const baselineFrameMissing = !!(baselineCamera && baselineCameras.length > 0 && !baselineFrame);
  const link = (eventId: string, children: ReactNode = 'ログで見る', target = ep) => <a
    href={trialEventUrl(target.runId, target.episodeId, eventId, target === ep ? camera : baselineCamera)}
    onClick={target === ep && onJump ? (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); onJump(eventId);
    } : undefined}>{children}</a>;
  const changed = baseline?.trial.verdict === 'success' && verdict === 'failure' ? '悪化（基準では成功）' :
    baseline?.trial.verdict === 'failure' && verdict === 'success' ? '改善' : null;
  const firstErrorMessage = firstLine(firstErrorText ?? textOf(facts.firstError?.value));
  const observation = observationText ?? facts.observation?.text;
  const answerLine = firstLine(decisionText ?? textOf(facts.decision?.value));
  // An answer whose first line is just the decision word would read "REGENERATE — REGENERATE".
  const answer = answerLine.trim().toUpperCase() === facts.decision?.text.toUpperCase() ? '' : answerLine;
  const endingEvent = summary.end_classification?.evidence.event_id;
  const ending = summary.end_classification;
  const cause = ending?.cause;
  const hasStats = !!summary.end_classification || facts.turnCount !== null || facts.durationSeconds !== null;
  const hasFacts = !!(facts.firstError || facts.observation && observation || facts.decision || currentFrame || baselineFrame || currentFrameMissing || baselineFrameMissing);
  const frame = (image: SummaryFrame, target: EpisodeRef, label: string) => <figure>
    <img src={episodeFileUrl(target, image.path)} alt={label} loading="lazy" />
    <figcaption>{label}{image.camera && <> · <span title={image.camera}>{cameraLabel(image.camera)}</span></>} · {link(image.event.event_id, 'ログで見る', target)}</figcaption>
  </figure>;
  return <section className="trial-summary" aria-label="試行の要約">
    <div className="trial-summary-heading">{(summary.task || typeof summary.seed === 'number') && <h2>{summary.task}{typeof summary.seed === 'number' && <>{summary.task ? ' · ' : ''}seed {summary.seed}</>}</h2>}
      {cameras.length > 1 && <label className="trial-summary-camera">カメラ <select aria-label="最後の画像のカメラ" title={camera ?? undefined} value={camera ?? ''}
        onChange={event => { setLocalCamera(event.target.value); onCameraChange?.(event.target.value); }}>
        {cameras.map(name => <option key={name} value={name} title={name}>{cameraLabel(name)}</option>)}
      </select></label>}
      <TaskOutcomeBadge verdict={verdict} />{changed && <Badge tone={changed === '改善' ? 'green' : 'amber'}>{changed}</Badge>}
    </div>
    {(hasStats || hasFacts || facts.flow.length > 0) && <div className="trial-summary-card">
      {hasStats && <dl className="trial-summary-stats">
        {ending && <div><dt>終わり方</dt><dd><strong>{causeHeadline(ending)}</strong>
          {cause && <div className="trial-summary-cause">
            <p>{cause.explanation}</p>
          </div>}
          {(cause || typeof endingEvent === 'string') && <details className="trial-summary-cause trial-summary-evidence">
            <summary>根拠を見る</summary>
            {causeEvidence(ending) && <p>根拠：{causeEvidence(ending)}</p>}
            {typeof endingEvent === 'string' && <p>{link(endingEvent)}</p>}
            {cause?.source && <p>規則：{ruleSourceHref(cause.source)
              ? <a href={ruleSourceHref(cause.source)} target="_blank" rel="noreferrer">{cause.source}</a> : cause.source}</p>}
            {!!cause?.missing_evidence?.length && <p>不足している記録：{cause.missing_evidence.join('、')}</p>}
          </details>}
        </dd></div>}
        {ending?.conditions && Object.keys(ending.conditions).length > 0 && <div><dt>評価条件</dt><dd><TrialConditions ending={ending} /></dd></div>}
        {facts.turnCount !== null && <div><dt>ターン</dt><dd>{facts.turnCount}（書き直し {facts.regenerationCount}回）</dd></div>}
        {facts.durationSeconds !== null && <div><dt>かかった時間</dt><dd>{fmtDuration(facts.durationSeconds)}</dd></div>}
      </dl>}
      {facts.flow.length > 0 && <p className="trial-summary-flow" aria-label="ターンの流れ">{facts.flow.map((turn, index) => <span key={turn.turn}>
        {index > 0 && <span aria-hidden="true"> → </span>}{link(turn.event.event_id, `ターン${turn.turn}：${turn.labels.join(' → ')}`)}
      </span>)}</p>}
      {hasFacts && <dl className="trial-summary-facts">
        {facts.firstError && <div><dt>最初のエラー</dt><dd>{facts.firstError.turn !== null && <>ターン{facts.firstError.turn} · </>}{facts.firstError.text}
          {firstErrorMessage && <p className="trial-summary-error">{firstErrorMessage}</p>}</dd><span>{link(facts.firstError.event.event_id)}</span></div>}
        {facts.observation && observation && <div><dt>最後の観察</dt><dd><small>実行前後の画像を見たモデル（VDM）の説明</small><p>{observation}</p></dd><span>{link(facts.observation.event.event_id)}</span></div>}
        {facts.decision && <div><dt>最後の判断</dt><dd><small>コードを書くモデルの答え</small><p>{facts.decision.text}{answer && <> — {answer}</>}</p></dd><span>{link(facts.decision.event.event_id)}</span></div>}
        {(currentFrame || baselineFrame || currentFrameMissing || baselineFrameMissing) && <div><dt>最後の画像</dt><dd className="trial-summary-frames">
          {currentFrame && frame(currentFrame, ep, '終了時（今回）')}{currentFrameMissing && <p>今回：このカメラの画像は記録されていません。</p>}{baselineFrame && baseline && frame(baselineFrame, baseline.ep, '終了時（基準）')}{baselineFrameMissing && <p>基準：このカメラの画像は記録されていません。</p>}
          {baselineFallback && <small className="trial-summary-camera-note">基準に同じカメラがないため、<span title={baselineCamera!}>{cameraLabel(baselineCamera!)}</span>を表示しています。</small>}
        </dd></div>}
      </dl>}
    </div>}
    {(baseline || footer) && <div className="trial-summary-actions">
      {baseline && <a className="trial-summary-compare" href={comparisonUrl(ep.runId, ep.episodeId, baseline.ep.runId, baseline.ep.episodeId, camera)}>基準と並べて見る</a>}
      {footer}
    </div>}
  </section>;
}

/** Fetch just the paired baseline, importing it with the existing per-episode flow. */
export function TrialSummary({ ep, model, camera, cameraOptions, onCameraChange, summary, evaluation: suppliedEvaluation, runnerRecords, onJump }: {
  ep: EpisodeRef; model: EpisodeModel; summary: EpisodeSummary; runnerRecords: RunnerRecord[]; onJump: (eventId: string) => void;
  camera?: string | null;
  cameraOptions?: string[];
  onCameraChange?: (camera: string) => void;
  evaluation?: EvalDetail | null;
}) {
  const evaluation = useAsync(suppliedEvaluation === undefined ? signal => evalApi.detail(ep.runId, signal) : null, [ep.runId, suppliedEvaluation !== undefined]);
  const detail = suppliedEvaluation === undefined ? evaluation.data : suppliedEvaluation;
  const baselineTrial = baselineForEpisode(detail, summary);
  const baselineRun = detail?.baseline?.eval_id ?? null;
  const baselineId = baselineTrial?.episode_id ?? null;
  const key = JSON.stringify([baselineRun, baselineId]);
  const [missingKey, setMissingKey] = useState<string | null>(null);
  const baselineSummary = useAsync(baselineRun && baselineId ? async signal => {
    try {
      const result = await traceApi.episode(baselineRun, baselineId, signal);
      if (!signal.aborted) setMissingKey(null);
      return result;
    } catch (error) {
      if (!signal.aborted && error instanceof ApiError && error.status === 404) setMissingKey(key);
      throw error;
    }
  } : null, [baselineRun, baselineId]);
  const baselineEvents = useEpisodeEvents(baselineSummary.data ? baselineRun : null, baselineSummary.data ? baselineId : null, false);
  const ready = useCallback(() => { baselineSummary.reload(); baselineEvents.refresh(); }, [baselineSummary.reload, baselineEvents.refresh]);
  const importing = useMissingEpisodeImport(baselineRun, baselineId, missingKey === key && !!baselineRun && !!baselineId && !baselineSummary.data, ready, baselineSummary);
  const baselineModel = useMemo(() => buildEpisodeModel(baselineEvents.events), [baselineEvents.events]);
  const baseline = baselineRun && baselineId && baselineTrial ? {
    ep: { runId: baselineRun, episodeId: baselineId, generation: baselineEvents.generation }, trial: baselineTrial,
    frame: lastRecordedFrame(baselineModel), model: baselineModel,
  } : null;
  const facts = useMemo(() => trialSummaryFacts(model, summary), [model, summary]);
  const firstError = useFullText(ep, facts.firstError?.value);
  const observation = useFullText(ep, facts.observation?.value);
  const decision = useFullText(ep, facts.decision?.value);
  return <TrialSummaryCard ep={ep} model={model} cameraOptions={cameraOptions} camera={camera} onCameraChange={onCameraChange} summary={summary} verdict={episodeVerdict(summary, runnerRecords)} baseline={baseline}
    onJump={onJump} firstErrorText={firstError.text} observationText={observation.text} decisionText={decision.text}
    footer={importing && <p role={importing.busy ? 'status' : 'alert'}>基準の試行：{importing.message}
      {importing.retry && <button type="button" onClick={importing.retry}>もう一度読み込む</button>}</p>} />;
}
