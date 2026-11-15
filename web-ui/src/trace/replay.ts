/** Recorded turn identity and replay navigation. Never join calls by wall time. */
import type { EpisodeModel, TNode } from './model';
import { dataOf } from './types';

export function turnOf(node: TNode): number | null {
  const seen = new Set<TNode>();
  for (let n: TNode | null = node; n && !seen.has(n); n = n.parent) {
    seen.add(n);
    const turn = n.call?.turnIndex ?? n.primary.refs?.turn_index ??
      (n.primary.data as {turn_index?: unknown} | undefined)?.turn_index;
    if (typeof turn === 'number' && Number.isInteger(turn) && turn >= 0) return turn;
  }
  return null;
}

export function recordedTurns(model: EpisodeModel): number[] {
  return [...new Set(model.allNodes.map(turnOf).filter((t): t is number => t !== null))].sort((a,b) => a-b);
}

/** Initial detail destination. Playback may retain a tab the user chose explicitly. */
export function replayTab(node: TNode): number {
  if (node.call?.callKind === 'ensemble_member') return 1;
  if (node.call?.callKind === 'ensemble_synthesis') return 2;
  return 0;
}

export function processLabel(node: TNode): string {
  if (node.kind === 'service_call') return `${dataOf(node.primary, 'service_call_start').service ?? '知覚サービス'}`.toUpperCase();
  if (node.call?.callKind === 'ensemble_member') return '候補生成';
  if (node.call?.callKind === 'ensemble_synthesis') return '統合';
  if (node.call?.role === 'vdm') return 'VDM';
  if (node.call?.role === 'code_generator') return 'コード生成';
  if (node.kind === 'code_block') return 'Python実行';
  if (node.kind === 'evaluator') return '評価器';
  return node.kind === 'stdout' ? '標準出力' : node.kind === 'stderr' ? '標準エラー' : '';
}
