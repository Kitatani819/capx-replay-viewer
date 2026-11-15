/** Ensemble evidence comes from recorded turns, requests and replies, not a vote guess. */
import { callOutcome, mainAttempt, resolveText, type EpisodeModel, type LogicalCall } from './model';
import { dataOf } from './types';
import { parsePayload } from './payload';

export function ensembleForTurn(model: EpisodeModel, turn: number | null) {
  const calls = turn === null ? [] : model.calls.filter(c => c.role === 'code_generator' && c.turnIndex === turn);
  return {members: calls.filter(c => c.callKind === 'ensemble_member'), syntheses: calls.filter(c => c.callKind === 'ensemble_synthesis')};
}

export function candidateTemperature(call: LogicalCall): number | null {
  const t = dataOf(mainAttempt(call)?.request, 'model_request').params?.temperature;
  return typeof t === 'number' && Number.isFinite(t) ? t : null;
}

export function candidateStatus(call: LogicalCall): string {
  const outcome = callOutcome(call);
  if (outcome.stopped) return '途中打ち切り（ストリーム中断）';
  if (outcome.state === 'failed') return 'エラー';
  if (outcome.state === 'open') return '終了記録なし';
  return dataOf(outcome.httpAnswer, 'model_response').finish_reason === 'length' ? '途中打ち切り（トークン上限）' : '回答あり';
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stable(v)]));
  return value;
}
/** Parameters differ per candidate. Only equal recorded messages/input are shared. */
export function inputFingerprint(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (!Array.isArray(p.messages) && p.input === undefined) return null;
  return JSON.stringify(stable({messages:p.messages, input:p.input}));
}

export function responseKind(text: string | null, complete = true, parsedCode = false): string {
  if (text === null || !complete) return '未確認（回答が未記録・不完全）';
  const outsideCode = text.replace(/```[\s\S]*?```/g, '');
  const decision = /^[\s*#>_]*(REGENERATE|FINISH)[*_]*(?![A-Za-z0-9_])/m.exec(outsideCode)?.[1];
  if (decision === 'REGENERATE') return 'REGENERATE（修正）';
  if (decision === 'FINISH') return 'FINISH（終了・モデルの主張）';
  if (parsedCode || /```(?:python|py)?\s*\n[\s\S]+?```/i.test(text)) return 'Pythonコード';
  return '未判定（元の回答を確認）';
}

export interface EnsembleEvidence { payload: unknown | null; answer: string | null; answerComplete: boolean; error: string | null }
export function inlineAnswer(call: LogicalCall): {text: string | null; complete: boolean; asset: string | null} {
  const value = resolveText(dataOf(callOutcome(call).httpAnswer, 'model_response').content);
  return {text: value.text, complete: value.text !== null && !value.truncated, asset: value.asset};
}

/** Match whole candidate sections in the *actual* synthesis request. A substring,
 * temperature alone, missing payload, or duplicate reply cannot prove identity. */
export function synthesisMembership(call: LogicalCall, members: LogicalCall[], evidence: ReadonlyMap<string, EnsembleEvidence>, payload: unknown): string {
  if (!payload) return '未確認（統合入力なし）';
  const ev = evidence.get(call.id);
  const temp = candidateTemperature(call);
  if (!ev?.answerComplete || !ev.answer || temp === null) return '未確認（候補の全文・temperature不足）';
  const text = parsePayload(payload).messages.filter(m=>m.role==='user').flatMap(m=>m.parts.filter(p=>p.kind==='text').map(p=>p.text ?? '')).join('\n');
  if (text.split('<candidate_solutions>').length!==2 || text.split('</candidate_solutions>').length!==2) return '未確認（候補区間を一意に識別できません）';
  const section = /<candidate_solutions>\s*([\s\S]*?)\s*<\/candidate_solutions>/.exec(text)?.[1];
  if (!section) return '未確認（候補区間を識別できません）';
  const headers = [...section.matchAll(/^--- Candidate \((?:(.*), )?temp=([^)]*)\) ---\r?\n/gm)];
  const matches = headers.filter((h,i) => {
    const content = section.slice(h.index!+h[0].length, headers[i+1]?.index ?? section.length).trim();
    return h[2].trim()!=='' && Number(h[2]) === temp && (!h[1] || h[1] === call.model) && content === ev.answer!.trim();
  });
  if (!matches.length) return '統合入力に全文一致なし';
  const duplicates = members.filter(m => candidateTemperature(m)===temp && (!matches[0][1] || m.model===call.model) && evidence.get(m.id)?.answerComplete && evidence.get(m.id)?.answer?.trim()===ev.answer!.trim());
  return duplicates.length===1 && matches.length===1 ? '統合入力に全文一致（送信を確認）' : '同文候補あり（個別の採用は未確認）';
}
