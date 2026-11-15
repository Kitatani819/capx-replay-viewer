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

/** Plain descriptions of recorded process types, never an inferred task outcome. */
export function processTitle(node: TNode): string {
  if (node.kind === 'service_call') return processLabel(node) === 'SAM3' ? '対象物を検出する' : 'カメラの観測を処理する';
  if (node.call?.callKind === 'ensemble_member') return '動かし方の候補を生成する';
  if (node.call?.callKind === 'ensemble_synthesis') return '候補をまとめて、次の動きを決める';
  if (node.call?.role === 'vdm') return '動作前後の変化を確認する';
  if (node.call?.role === 'code_generator') return 'ロボットを動かすコードを生成する';
  if (node.kind === 'code_block') return 'Pythonを実行する';
  if (node.kind === 'evaluator') return '実行の評価を確認する';
  if (node.kind === 'stdout') return 'コードの標準出力を読む';
  if (node.kind === 'stderr') return 'コードの標準エラーを読む';
  if (node.kind === 'api_call') return 'ロボットのAPIを呼び出す';
  return processLabel(node) || '記録を確認する';
}
