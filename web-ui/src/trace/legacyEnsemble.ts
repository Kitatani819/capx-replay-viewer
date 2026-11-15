import type { LegacyResponse } from './legacyResponses';

export interface LegacyCandidate {
  index: number;
  model: string;
  temperature: string;
  success: boolean;
  response: string;
}

/** The harness writes completion order, not candidate IDs or request payloads. */
export function parseLegacyCandidates(text: string): LegacyCandidate[] {
  const input = text.replace(/\r\n/g, '\n');
  const header = /^={60}\nModel: ([^\n]+)\nTemperature: ([^\n]+)\nSuccess: (True|False)\n={60}\n/gm;
  const matches = [...input.matchAll(header)];
  return matches.map((m, index) => ({
    index, model: m[1], temperature: m[2], success: m[3] === 'True',
    response: input.slice(m.index! + m[0].length, matches[index + 1]?.index ?? input.length).trim(),
  }));
}

export function parseLegacySynthesis(text: string): { model: string | null; reasoning: string | null; output: string } | null {
  const input = text.replace(/\r\n/g, '\n');
  const outputs = [...input.matchAll(/^={60}\nOUTPUT\n={60}\n/gm)];
  if (outputs.length !== 1) return null;
  const marker = outputs[0];
  const before = input.slice(0, marker.index);
  const reasoning = before.match(/^={60}\nREASONING\n={60}\n([\s\S]*)/m)?.[1].trim() ?? null;
  return { model: input.match(/^Model: (.+)$/m)?.[1] ?? null, reasoning, output: input.slice(marker.index! + marker[0].length).trim() };
}

export function legacyOutputDecision(output: string): string {
  if (/^REGENERATE\b/.test(output.trimStart())) return 'REGENERATE（修正）';
  if (/^FINISH\b/.test(output.trimStart())) return 'FINISH（終了・モデルの主張）';
  if (/```python\s*\n/.test(output)) return 'Pythonコード';
  return '判断形式は未確認';
}

/** Only link code when all fenced blocks match a unique saved execution record. */
export function matchingLegacyExecution(output: string, rows: LegacyResponse[]): LegacyResponse | null {
  const codes = [...output.replace(/\r\n/g, '\n').matchAll(/```python\s*\n([\s\S]*?)```/g)].map(m => m[1].trim());
  if (!codes.length) return null;
  const matches = rows.filter(row => row.codes.length === codes.length && row.codes.every((c, i) =>
    c.block !== null && c.code.replace(/\r\n/g, '\n').trim() === codes[i]));
  return matches.length === 1 ? matches[0] : null;
}

export function legacyEnsembleTurn(path: string): number | null {
  const m = /^ensemble_candidates(?:_regen_(\d+))?\.txt$/.exec(path);
  return m ? Number(m[1] ?? 0) : null;
}
