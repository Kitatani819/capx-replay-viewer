/** all_responses.json stores sequential, parsed final responses, not ensemble members. */
export interface LegacyResponse {
  index: number;
  decision: string | null;
  codes: { block: number | null; code: string }[];
  reasoning: string | null;
  prompt: unknown;
}

export function legacyResponses(value: unknown): LegacyResponse[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return [];
    const r = row as Record<string, unknown>;
    const blocks = Array.isArray(r.block_idx) ? r.block_idx : [];
    return [{
      index,
      decision: typeof r.decision === 'string' ? r.decision : null,
      codes: (Array.isArray(r.code_blocks) ? r.code_blocks : []).flatMap((code, i) =>
        typeof code === 'string' ? [{code, block: Number.isInteger(blocks[i]) && blocks[i] >= 0 ? blocks[i] as number : null}] : []),
      reasoning: typeof r.reasoning === 'string' ? r.reasoning : null,
      prompt: r.initial_prompt ?? r.multi_turn_prompt ?? null,
    }];
  });
}

export function legacyDecision(row: LegacyResponse): string {
  switch (row.decision?.toLowerCase()) {
    case 'finish': return 'FINISH（終了・モデルの主張）';
    case 'regenerate': return 'REGENERATE（修正）';
    case 'initial': return row.codes.length ? 'Pythonコード（初回）' : '初回（コード未記録）';
    default: return row.decision ?? '判断は未記録';
  }
}
