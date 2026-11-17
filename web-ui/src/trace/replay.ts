/** Recorded turn identity and replay navigation. Never join calls by wall time. */
import { nodeTitle, type EpisodeModel, type LogicalCall, type TNode } from './model';
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

export function isVdmComparison(call: LogicalCall | null | undefined): boolean {
  return call?.role === 'vdm' && (call.callKind === 'image_diff' || call.callKind === 'video_diff');
}

interface ServiceOperation {
  title: string;
  resultTitle: string;
  masks?: boolean;
  inputFields?: ReadonlyArray<{ name: string; label: string }>;
}

const serviceNames = new Map([
  ['sam3', 'SAM3'], ['sam2', 'SAM2'], ['owlvit', 'OWL-ViT'], ['molmo', 'Molmo'],
  ['graspnet', 'GraspNet'], ['pyroki', 'PyRoKi'], ['curobo', 'cuRobo'],
]);
const sam3Segmentation: ServiceOperation = { title: '対象物を検出する', resultTitle: '返った検出結果', masks: true };
const pointSegmentation: ServiceOperation = { title: '指定した点から対象物の範囲を求める', resultTitle: '返った検出結果', masks: true };
const inverseKinematics: ServiceOperation = {
  title: '手先の目標姿勢から関節位置を計算する',
  inputFields: [
    { name: 'target_pose_wxyz_xyz', label: '手先の目標姿勢（向き WXYZ・位置 XYZ）' },
    { name: 'prev_cfg', label: '基準にする関節位置' },
  ],
  resultTitle: '計算された関節位置',
};
const trajectoryPlanning: ServiceOperation = {
  title: '手先の移動経路を計画する',
  inputFields: [
    { name: 'start_pose_wxyz_xyz', label: '手先の開始姿勢（向き WXYZ・位置 XYZ）' },
    { name: 'end_pose_wxyz_xyz', label: '手先の目標姿勢（向き WXYZ・位置 XYZ）' },
  ],
  resultTitle: '軌道上の関節位置',
};

const serviceOperations = new Map<string, ServiceOperation>([
  ['sam3.sam3_seg_fn', sam3Segmentation],
  ['sam3.segment', sam3Segmentation],
  ['sam3.sam3_point_prompt_fn', pointSegmentation],
  ['sam2.sam2_seg_fn', { title: '画像内の物体の範囲を求める', resultTitle: '返った検出結果', masks: true }],
  ['sam2.sam2_point_prompt_fn', pointSegmentation],
  ['owlvit.owl_vit_det_fn', { title: '画像内の対象物を検出する', resultTitle: '検出した位置・ラベル・スコア' }],
  ['molmo.molmo_point_fn', { title: '画像内の対象物を点で示す', resultTitle: '返った画像内の座標' }],
  ['graspnet.grasp_net_plan_fn', { title: '深度画像からつかみ方の候補を計算する', resultTitle: '把持姿勢・スコア・接触点' }],
  ['graspnet.grasp_net_plan_point_clouds_fn', { title: '点群からつかみ方の候補を計算する', resultTitle: '把持姿勢・スコア・接触点' }],
  ['pyroki.ik_solve_fn', inverseKinematics],
  ['curobo.ik_solve_fn', inverseKinematics],
  ['pyroki.trajopt_plan_fn', trajectoryPlanning],
  ['curobo.trajopt_plan_fn', trajectoryPlanning],
]);

export function serviceOperation(node: TNode): ServiceOperation & { name: string } {
  const start = dataOf(node.primary, 'service_call_start');
  const end = dataOf(node.end, 'service_call_end');
  const recordedName = [start.service, end.service].find(value => typeof value === 'string' && value.trim())?.trim() ?? '';
  const functionName = [start.function, end.function].find(value => typeof value === 'string' && value.trim())?.trim() ?? '';
  const service = recordedName.toLowerCase();
  const name = (serviceNames.get(service) ?? recordedName) || 'サービス';
  const operation = serviceOperations.get(`${service}.${functionName}`);
  return operation ? { name, ...operation } : {
    name,
    title: functionName ? `${functionName} を呼び出す` : `${name}を呼び出す`,
    resultTitle: '記録された出力',
  };
}

export function processLabel(node: TNode): string {
  if (node.kind === 'service_call') return serviceOperation(node).name.toUpperCase();
  if (node.call?.callKind === 'ensemble_member') return '候補生成';
  if (node.call?.callKind === 'ensemble_synthesis') return '統合';
  if (node.call?.role === 'vdm') return 'VDM';
  if (node.call?.role === 'perception_vlm') return '知覚モデル';
  if (node.call?.role === 'code_generator') return node.call.callKind === 'multi_turn_decision' ? '継続判断' : 'コード生成';
  if (node.kind === 'api_call') return 'API';
  if (node.kind === 'code_block') return 'Python実行';
  if (node.kind === 'evaluator') return '評価器';
  return node.kind === 'stdout' ? '標準出力' : node.kind === 'stderr' ? '標準エラー' : '';
}

/** Plain descriptions of recorded process types, never an inferred task outcome. */
export function processTitle(node: TNode): string {
  if (node.kind === 'service_call') return serviceOperation(node).title;
  if (node.call?.callKind === 'ensemble_member') return '動かし方の候補を生成する';
  if (node.call?.callKind === 'ensemble_synthesis') return '候補を統合する';
  if (node.call?.role === 'vdm') {
    if (node.call.callKind === 'initial_scene_description') return '初期シーンを説明する';
    return isVdmComparison(node.call) ? '動作前後の変化を確認する' : 'VDMに説明を求める';
  }
  if (node.call?.role === 'perception_vlm') return node.call.callKind === 'point' ? '画像内の対象物の位置をモデルに尋ねる' : '知覚モデルを呼び出す';
  if (node.call?.role === 'code_generator' && node.call.callKind === 'multi_turn_decision') return 'タスクの継続・終了をモデルに尋ねる';
  if (node.call?.role === 'code_generator') return 'ロボットを動かすコードを生成する';
  if (node.kind === 'code_block') return dataOf(node.primary, 'code_block_start').code_source === 'oracle' ? 'Oracleの既定コードを実行する' : 'Pythonを実行する';
  if (node.kind === 'evaluator') {
    const scope = dataOf(node.primary, 'evaluator_result').scope;
    if (scope === 'episode') return '試行全体の評価';
    if (scope === 'code_block') return 'Python実行の評価';
    return '実行の評価';
  }
  if (node.kind === 'stdout') return 'コードの標準出力を読む';
  if (node.kind === 'stderr') return 'コードの標準エラーを読む';
  if (node.kind === 'api_call') return nodeTitle(node);
  return processLabel(node) || '記録を確認する';
}
