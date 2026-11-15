/**
 * Episodes without a trace (docs/trace-format.md 9.4): runner trial
 * directories written before the recorder existed, read through the legacy
 * endpoints of capx_trace_viewer/trace_api.py. Shows code.py, stdout/stderr parsed
 * from summary.txt, the videos, visual_feedback_*.png labelled
 * 「ハーネス保存画像（送信を検証していない）」 and trial_record.json.
 * Some trial directories also store sent codegen/VDM messages and state logs in
 * the model-input tab. Older trials still show 「未記録」.
 *
 * The same run id can exist under two runner roots, so every call carries the
 * root index that /legacy/runs reported.
 *
 * Related: Picker.tsx, api.ts (legacy endpoints).
 */

import { useRef, useState, type ReactNode } from 'react';
import { fetchText, traceApi } from '../api';
import { fmtBytes, fmtNum, fmtWall } from '../format';
import { useAsync } from '../hooks';
import { LABELS } from '../labels';
import { ErrorText, KV, Notice, NotRecorded, Spinner } from './common';
import { CodeView } from './CodeView';
import { TextView } from './TextView';
import { TraceImage } from './TraceImage';
import { LegacyEnsemble } from './LegacyEnsemble';
import { legacyEnsembleTurn } from '../legacyEnsemble';
import { RawJson } from './tabs/ModelInputTab';
import { LegacyResponses } from './LegacyResponses';
import './LegacyReplay.css';

export interface LegacyTrialRef {
  root: number | null;
  task: string;
  condition: string;
  trialDir: string;
  note?: string;
  taskVerdict?: 'success' | 'failure' | 'unknown';
}

export interface LegacyRunRef {
  runId: string;
  root: number | null;
  detail: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Runs of GET /legacy/runs: {roots, runs: [{run_id, root_index, n_trials, description, last_modified}]}. */
export function legacyRunsOf(data: unknown): LegacyRunRef[] {
  const list = isObj(data) && Array.isArray(data.runs) ? data.runs : [];
  const out: LegacyRunRef[] = [];
  for (const r of list) {
    if (!isObj(r)) continue;
    const id = str(r.run_id);
    if (!id) continue;
    const lm = num(r.last_modified);
    const parts = [
      r.n_trials !== undefined ? `${String(r.n_trials)} trials` : null,
      str(r.description),
      lm !== null ? fmtWall(lm) : null,
    ].filter(Boolean);
    out.push({ runId: id, root: num(r.root_index), detail: parts.join(' · ') });
  }
  return out;
}

/** Roots of GET /legacy/runs. */
export function legacyRootsOf(data: unknown): { index: number; path: string; exists: boolean }[] {
  const list = isObj(data) && Array.isArray(data.roots) ? data.roots : [];
  return list.filter(isObj).map((r) => ({ index: num(r.index) ?? -1, path: str(r.path) ?? '?', exists: r.exists === true }));
}

/** Trials of GET /legacy/runs/{run_id}: {trials: [{task, condition, trial_dir, sandbox_rc, reward, task_completed, record}]}. */
export function legacyTrialsOf(data: unknown, root: number | null): LegacyTrialRef[] {
  if (!isObj(data) || !Array.isArray(data.trials)) return [];
  const out: LegacyTrialRef[] = [];
  for (const t of data.trials) {
    if (!isObj(t)) continue;
    const task = str(t.task);
    const condition = str(t.condition);
    const dir = str(t.trial_dir);
    if (!task || !condition || !dir) continue;
    const rec = isObj(t.record) ? t.record : null;
    const outcome = rec && isObj(rec.outcome) ? rec.outcome : null;
    const note = [
      rec && rec.seed !== undefined ? `seed ${String(rec.seed)}` : null,
      outcome && outcome.task_success !== undefined ? `task_success=${String(outcome.task_success)}` : null,
      outcome && typeof outcome.termination_reason === 'string' ? outcome.termination_reason : null,
      rec && Array.isArray(rec.attempt_statuses) ? `attempts: ${(rec.attempt_statuses as unknown[]).join(',')}` : null,
      !rec ? 'runner の記録なし' : null,
    ]
      .filter(Boolean)
      .join(' · ');
    const success = outcome ? outcome.task_success : t.task_completed;
    const taskVerdict = success === true || success === 1 ? 'success' : success === false || success === 0 ? 'failure' : 'unknown';
    out.push({ taskVerdict, root: num(data.root_index) ?? root, task, condition, trialDir: dir, note: note || undefined });
  }
  return out;
}

interface FileRef {
  path: string;
  bytes: number | null;
  mime: string | null;
}

function filesOf(v: unknown): FileRef[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isObj).map((f) => ({ path: str(f.path) ?? '', bytes: num(f.bytes), mime: str(f.mime) })).filter((f) => f.path);
}

export function LegacyPromptNotice({ modelInputRecorded }: { modelInputRecorded: boolean }) {
  return (
    <p className="replay-legacy-note">
      以下はハーネスが保存した文字列です。送信した payload とは区別してください。
      {modelInputRecorded && '送信した payload は上の messages.json に記録されています。'}
    </p>
  );
}

export function LegacyTrialView({ runId, trial }: { runId: string; trial: LegacyTrialRef }) {
  const res = useAsync(
    (s) => traceApi.legacyTrial(runId, trial.task, trial.condition, trial.trialDir, trial.root, s),
    [runId, trial.task, trial.condition, trial.trialDir, trial.root],
  );
  const [tab, setTab] = useState(0);
  const [ioSection, setIoSection] = useState(0);
  const [responseIndex, setResponseIndex] = useState(0);
  const [ensembleIndex, setEnsembleIndex] = useState(0);
  const [videoPath, setVideoPath] = useState('');
  const [selectedFeedback, setSelectedFeedback] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  if (res.loading && !res.data) return <div className="p-6"><Spinner label="読み込み中" /></div>;
  if (res.error) return <div className="p-6"><ErrorText>{res.error}</ErrorText></div>;
  const data = isObj(res.data) ? res.data : null;
  if (!data) return null;

  const url = (rel: string) => traceApi.legacyFileUrl(runId, trial.task, trial.condition, trial.trialDir, rel, trial.root);
  const code = isObj(data.code) ? data.code : null;
  const summary = isObj(data.summary) ? data.summary : null;
  const videos = filesOf(data.videos);
  const chosenVideo = videos.find(v => v.path === videoPath) ?? videos.find(v => v.path === 'video_combined.mp4') ?? videos[0];
  const images = filesOf(data.harness_images);
  const prompts = filesOf(data.harness_prompts);
  const other = filesOf(data.other_files);
  const responses = other.find((f) => f.path === 'all_responses.json');
  const feedback = other.filter((f) => /^differencing_feedback_\d+\.txt$/.test(f.path));
  const record = isObj(data.trial_record) ? data.trial_record : null;
  const provenance = record && isObj(record.viewer_import) ? record.viewer_import : null;
  const stateFiles = other.filter((f) => /^(state_snapshots\.jsonl|api_events\.jsonl|audit_events\.jsonl|state_prompt_usage\.jsonl|(?:codegen|vdm)_turn_\d+_(?:messages|images)\.json)$/.test(f.path));
  const ensembleTurns = other.flatMap(f => {
    const turn = legacyEnsembleTurn(f.path);
    return turn === null ? [] : [turn];
  }).sort((a, b) => a - b);
  const hasInputRecords = data.model_input_recorded === true || images.length > 0 || prompts.length > 0 || !!responses;
  const hasCodeRecords = !!responses || typeof code?.text === 'string';
  const hasAnyRecords = hasInputRecords || hasCodeRecords || !!summary || feedback.length > 0 || ensembleTurns.length > 0;
  const selectRecord = (section: number, feedbackPath: string | null = null) => {
    videoRef.current?.pause();
    setTab(0); setIoSection(section); setSelectedFeedback(feedbackPath);
  };
  const selectEnsemble = (turn: number, nextTab: number) => {
    videoRef.current?.pause();
    setEnsembleIndex(turn); setTab(nextTab);
  };
  const feedbackIndex = feedback.findIndex(f => f.path === selectedFeedback);
  const activeRecord = tab === 0 ? selectedFeedback ?? `section-${ioSection}` : `ensemble-${ensembleIndex}`;
  const recordButton = (id: string, name: string, kind: string, onClick: () => void, file?: string) => (
    <button type="button" key={id} data-legacy-log-file={file} data-legacy-log-record={id}
      className="replay-legacy-row" aria-pressed={activeRecord === id} onClick={onClick}>
      <span className="replay-legacy-row-name">{name}</span><span className="replay-legacy-row-kind">{kind}</span>
    </button>
  );

  let body: ReactNode = null;
  if (tab === 0 && ioSection === 0) {
    body = <div className="replay-legacy-content">
      <p className="replay-legacy-eyebrow">モデル入力</p><h2>入力と保存画像</h2>
      {data.model_input_recorded === true ? <section>
        <h3>送信したメッセージと STATE</h3>
        {stateFiles.map(p => <details className="replay-legacy-fold" key={p.path}>
          <summary>{p.path}</summary><LazyText title="記録された入力" url={url(p.path)} />
        </details>)}
      </section> : <NotRecorded reason="この trial に送信 payload を確認できるトレースはありません。" />}
      {images.length > 0 && <section>
        <h3>保存されたカメラ画像</h3>
        <p className="replay-legacy-source">{LABELS.legacyHarnessImage}</p>
        <div className="replay-legacy-images">{images.map((im, i) => <figure key={im.path}>
          <TraceImage src={url(im.path)} alt={im.path} provenance="legacy_harness" compact className="replay-legacy-image" />
          <figcaption>保存画像 {i + 1}</figcaption>
        </figure>)}</div>
      </section>}
      <section><h3>保存されたプロンプト</h3>
        <LegacyPromptNotice modelInputRecorded={data.model_input_recorded === true} />
        {responses && <button type="button" className="replay-legacy-link" onClick={() => selectRecord(1)}>各回答のプロンプトを開く →</button>}
        {prompts.length === 0 && !responses && <p className="replay-legacy-note">保存されたプロンプト文字列はありません。</p>}
        {prompts.map(p => <details className="replay-legacy-fold" key={p.path}>
          <summary>{p.path}</summary><LazyText title="ハーネス保存プロンプト" url={url(p.path)} />
        </details>)}
      </section>
    </div>;
  } else if (tab === 0 && ioSection === 1) {
    body = selectedFeedback ? <div className="replay-legacy-content">
      <p className="replay-legacy-eyebrow">VDM · 記録 {feedbackIndex + 1}</p><h2>動作後の変化を確認する</h2>
      <p className="replay-legacy-note">比較に使った画像と実際の送信入力は、この差分ログからは確認できません。</p>
      {feedback.filter(f => f.path === selectedFeedback).map(f => <section key={f.path} data-legacy-vdm={f.path}>
        <h3>返った説明</h3><LazyText title="VDMの見立て（評価結果とは別）" url={url(f.path)} mono={false} />
        <p className="replay-legacy-source">出典: {f.path}</p>
      </section>)}
    </div> : <div className="replay-legacy-content">
      <p className="replay-legacy-eyebrow">Python・モデル応答</p><h2>回答と実行されたコード</h2>
      {responses && <LegacyResponses url={url(responses.path)} index={responseIndex} onIndex={setResponseIndex} />}
      {code && typeof code.text === 'string' ? responses ? (
        <details className="replay-legacy-fold"><summary>実行コードの全体を見る{code.truncated ? '（先頭のみ）' : ''}</summary>
          <p className="replay-legacy-source">出典: code.py</p><CodeView code={code.text} />
        </details>
      ) : <section><h3>実行コード{code.truncated ? '（先頭のみ）' : ''}</h3><CodeView code={code.text} /><p className="replay-legacy-source">出典: code.py</p></section>
      : !responses && <NotRecorded reason="code.py がありません" />}
      {summary && <button type="button" className="replay-legacy-link" onClick={() => selectRecord(2)}>標準出力・標準エラーを見る →</button>}
    </div>;
  } else if (tab === 0 && ioSection === 2) {
    body = <div className="replay-legacy-content">
      <p className="replay-legacy-eyebrow">Python実行・評価</p><h2>実行の出力を確認する</h2>
      <p className="replay-legacy-note">最後のブロックの標準出力と、全ターンの標準エラーです。ブロックごとの記録ではありません。</p>
      {!summary && <NotRecorded reason="summary.txt がありません" />}
      {summary && !summary.parsed && <>
        <Notice tone="amber">summary.txt の形式を読み取れませんでした。全文をそのまま表示します。</Notice>
        {typeof summary.raw === 'string' && <TextView text={summary.raw} />}
      </>}
      {summary?.parsed === true && <>
        {summary.ambiguous_split === true && <Notice tone="amber">stdout と stderr の境目が一意に決まりません（stdout に区切りの文字列が含まれています）。</Notice>}
        <section><h3>標準出力</h3><p className="replay-legacy-source">実行コードの申告 · summary.txt</p>
          {typeof summary.stdout === 'string' ? <TextView text={summary.stdout || '（空）'} /> : <NotRecorded reason="標準出力なし" />}
        </section>
        <section><h3>標準エラー</h3><p className="replay-legacy-source">Python実行の記録 · summary.txt</p>
          {typeof summary.stderr === 'string' ? <TextView text={summary.stderr || '（空）'} tone="stderr" /> : <NotRecorded reason="標準エラーなし" />}
        </section>
        <section><h3>試行全体の評価</h3><p className="replay-legacy-source">評価・ハーネスの記録 · summary.txt</p>
          <KV rows={[
            ['タスク完了', String(summary.task_completed ?? '未記録')], ['reward', fmtNum(summary.reward)],
            ['terminated / truncated', `${String(summary.terminated ?? '—')} / ${String(summary.truncated ?? '—')}`],
          ]} />
        </section>
      </>}
    </div>;
  } else if (tab === 1 || tab === 2) {
    body = ensembleTurns.length > 0
      ? <LegacyEnsemble paths={other.map(f => f.path)} url={url} responsesUrl={responses ? url(responses.path) : undefined}
          index={ensembleIndex} onIndex={setEnsembleIndex} mode={tab === 1 ? 'candidates' : 'synthesis'}
          onCode={index => { setResponseIndex(index); selectRecord(1); }} />
      : responses
      ? <LegacyResponses url={url(responses.path)} index={responseIndex} onIndex={setResponseIndex} ensemble candidatesOnly={tab === 1} />
      : <NotRecorded reason="アンサンブルの候補と統合を対応付けるトレースがありません" />;
  }

  return <div data-legacy-replay className="replay-legacy-layout">
    <div data-legacy-media className="replay-legacy-left">
      <div className="replay-legacy-media">
        <div className="replay-legacy-media-heading">
          <span>ロボットの録画</span>
          {videos.length > 1 && <select aria-label="録画ファイル" value={chosenVideo?.path ?? ''} onChange={e => { videoRef.current?.pause(); setVideoPath(e.target.value); }}>
            {videos.map(v => <option key={v.path} value={v.path}>{v.path === 'video_combined.mp4' ? '試行全体' : v.path.replace(/^video_turn_(\d+)\.mp4$/, 'ターン $1')}</option>)}
          </select>}
        </div>
        {chosenVideo ? <video key={chosenVideo.path} ref={videoRef} src={url(chosenVideo.path)} aria-label="試行の録画" controls preload="metadata" className="replay-legacy-video" />
          : <div className="replay-legacy-video-missing">録画は保存されていません</div>}
        <p className="replay-legacy-sync"><strong>同期情報なし</strong><span>{videos.length ? '対応するフレーム情報がないため、録画と記録を個別に確認できます。' : '録画とフレーム対応表が見つかりません。'}</span></p>
        {typeof provenance?.notice === 'string' && <p className="replay-legacy-provenance">{provenance.notice}</p>}
      </div>
      <section data-legacy-log aria-label="保存された処理ログ" className="replay-legacy-log">
        <div className="replay-legacy-log-heading"><h2>保存された記録</h2><span>選ぶと録画を停止</span></div>
        <div className="replay-legacy-rows">
          {hasInputRecords && recordButton('section-0', '入力とカメラ画像を見る', '入力', () => selectRecord(0))}
          {hasCodeRecords && recordButton('section-1', '回答と実行コードを見る', 'Python', () => selectRecord(1))}
          {summary && recordButton('section-2', '実行の出力と評価を確認する', '実行ログ', () => selectRecord(2))}
          {feedback.map((f, i) => recordButton(f.path, `動作後の変化を確認する · ${i + 1}`, 'VDM', () => selectRecord(1, f.path), f.path))}
          {ensembleTurns.map(turn => recordButton(`ensemble-${turn}`, `${turn === 0 ? '初回' : `修正 ${turn}`}の候補と統合を読む`, 'アンサンブル', () => selectEnsemble(turn, 1)))}
          {!hasAnyRecords && <p className="replay-legacy-note">この試行に処理ログは保存されていません。</p>}
        </div>
      </section>
    </div>
    <div data-legacy-details className="replay-legacy-details">
      <div role="tablist" aria-label="処理の詳細" className="replay-legacy-tabs">
        {['入出力', '候補', '統合結果'].map((label, i) => <button key={label} type="button" role="tab"
          aria-selected={tab === i} onClick={() => setTab(i)}>{label}</button>)}
      </div>
      <div role="tabpanel" className="replay-legacy-detail-body" key={`${tab}-${ioSection}-${selectedFeedback ?? ''}`}>
        {body}
        <details className="replay-legacy-metadata"><summary>記録の詳細</summary>
          <KV rows={[
            ['run', runId], ['task', trial.task], ['condition', trial.condition], ['trial', trial.trialDir],
            ['ディレクトリ名の値', `sandbox_rc=${String(data.sandbox_rc ?? '—')} · reward=${fmtNum(data.reward)} · task_completed=${String(data.task_completed ?? '—')}`],
          ]} />
          <p className="replay-legacy-note">以下は記録情報です。モデルに渡した入力とは区別しています。</p>
          {data.trial_record != null && <details className="replay-legacy-fold"><summary>trial_record.json</summary><RawJson value={data.trial_record} /></details>}
          {summary?.parsed === true && <details className="replay-legacy-fold"><summary>評価の補足</summary><KV rows={[
            ['sandbox_rc', String(summary.sandbox_rc ?? '—')],
            ['code blocks / regenerations / finishes', `${String(summary.num_code_blocks ?? '—')} / ${String(summary.num_regenerations ?? '—')} / ${String(summary.num_finishes ?? '—')}`],
          ]} /></details>}
          {other.length > 0 && <details className="replay-legacy-fold"><summary>元ファイルを開く</summary><ul className="replay-legacy-files">{other.map(f => <li key={f.path}>
            <a href={url(f.path)} target="_blank" rel="noreferrer">{f.path}</a><span>{fmtBytes(f.bytes)}</span>
          </li>)}</ul></details>}
        </details>
      </div>
    </div>
  </div>;
}

function LazyText({ title, url, mono = true }: { title: string; url: string; mono?: boolean }) {
  const res = useAsync(() => fetchText(url), [url]);
  return <div>
    <p className="replay-legacy-source">{title}</p>
    {res.loading && <Spinner />}{res.error && <ErrorText>{res.error}</ErrorText>}
    {res.data !== null && <TextView text={res.data} mono={mono} />}
  </div>;
}
