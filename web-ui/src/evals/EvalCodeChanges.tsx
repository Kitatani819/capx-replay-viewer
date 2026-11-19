import { useState } from 'react';
import { useAsync } from '../trace/hooks';
import { evalApi, type CodeChangeMetadata, type EvalRecord } from './api';

const REASONS: Record<CodeChangeMetadata['status'], string> = {
  recorded: '',
  no_baseline: '基準の評価が指定されていないため、コード差分はありません。',
  baseline_missing: '評価開始時に基準の評価記録が見つからず、コード差分を保存できませんでした。',
  baseline_ambiguous: '評価開始時に同じ基準の評価IDが複数あり、コード差分を保存できませんでした。',
  baseline_git_missing: '基準のコミットが記録されていないため、コード差分を保存できませんでした。',
  baseline_dirty: '基準に未コミットの変更があるか、その有無が不明です。基準のコードを再現できず、差分を保存していません。',
  current_git_missing: '今回のコミットを読み取れず、コード差分を保存できませんでした。',
  git_unavailable: '基準のコミットがこのリポジトリにない、Gitを利用できない、または安全な読み取りの上限を超えたため、コード差分を保存できませんでした。',
  write_failed: 'コード差分ファイルを保存できませんでした。',
};

export function EvalCodeChanges({ record }: { record: EvalRecord }) {
  const [open, setOpen] = useState(false);
  const metadata = record.code_changes;
  const result = useAsync(open && metadata?.status === 'recorded' ? signal => evalApi.codeChanges(record.eval_id, signal) : null,
    [record.eval_id, metadata?.sha256, open]);
  return <details className="eval-code-changes" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>変更したコード{metadata?.status === 'recorded' ? `（${metadata.files}ファイル）` : ''}</summary>
    {!metadata ? <p>この評価にはコード差分が記録されていません。</p> : metadata.status !== 'recorded' ? <p>{REASONS[metadata.status]}</p> : <>
      <p>基準 {metadata.baseline_commit?.slice(0, 7)} → 今回 {metadata.current_commit?.slice(0, 7)} と、評価開始時点のGit管理対象の変更です。評価中の変更は含みません。</p>
      <p className="eval-code-note">コードとして扱えるテキストだけを保存しています。機密ファイル・バイナリ・巨大な差分などは除外します。Git未管理のファイルの内容は保存しません。</p>
      {(metadata.excluded_files > 0 || metadata.untracked_files > 0 || metadata.redacted) && <p className="eval-note">除外 {metadata.excluded_files}ファイル・Git未管理 {metadata.untracked_files}ファイル{metadata.redacted ? '・秘密情報のマスクあり' : ''}。保存された差分だけでは変更の全体を再現できない場合があります。</p>}
      {result.loading && !result.data && <p role="status">差分を読み込み中…</p>}
      {(result.error || result.data?.error) && <p role="alert" className="eval-error">{result.error || result.data?.error} <button onClick={result.reload}>再読み込み</button></p>}
      {result.data?.artifact && <>{result.data.location === 'gmo' && <p className="eval-code-note">GMO上の記録を表示しています。</p>}
        {result.data.artifact.files.length === 0 ? <p>保存対象のコード差分はありません。</p> : <ul className="eval-code-files">{result.data.artifact.files.map(file => <li key={file.path}>
          <details><summary>{file.path}</summary><pre aria-label={`${file.path} の差分`}><code>{file.diff}</code></pre></details>
        </li>)}</ul>}
      </>}
    </>}
  </details>;
}
