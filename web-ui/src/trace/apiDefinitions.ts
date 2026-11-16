/**
 * Descriptions and original excerpts from pinned CaP-X definitions.
 * The handover definitions match the class and qualified method recorded in the trace.
 */
import type { TNode } from './model';
import { dataOf } from './types';

export interface ApiDefinition {
  name: string;
  summaryJa: string;
  descriptionJa: string;
  /** Short original sentence from the definition's docstring. */
  docstring: string;
  signature: string;
  sourceUrl: string;
  sourceLabel: string;
  scopeNote: string;
}

const sourceRoot = 'https://github.com/matsuolab/geniac_prize_2026_code/blob/e26d1ea5f7f164511120c6395f126262a2c1c886/';
const scopeNote = 'CaP-Xの同名APIの参照定義です。この試行で使われた実装・バージョンとの一致は未確認です。今回の動作は下の実行ログで確認してください。';
const handoverClass = 'FrankaHandoverPrivilegedApi';
const handoverSource = 'https://github.com/matsuolab/geniac_prize_2026_code/blob/ac680843fb60c464aa74c87a2815cb5917865be4/capx/integrations/franka/handover_privileged.py';
const handoverSourceLabel = `${handoverClass} · ac68084`;
const handoverScope = '記録されたクラス名とメソッド名に対応する定義です。実行時の引数・結果・エラーは下の記録から表示します。';

const definitions: Readonly<Record<string, ApiDefinition>> = {
  goto_pose: {
    name: 'goto_pose',
    summaryJa: '逆運動学を使ってロボットの手先を指定した位置・姿勢へ移動します。',
    descriptionJa: '参照定義では、位置はメートル単位のXYZ、姿勢はWXYZ順の単位クォータニオンで指定します。z_approach は接近動作のオフセットです。内部で逆運動学を解いて関節移動を行い、戻り値はありません。',
    docstring: 'Go to pose using Inverse Kinematics.',
    signature: 'goto_pose(position: np.ndarray, quaternion_wxyz: np.ndarray, z_approach: float = 0.0) -> None',
    sourceUrl: `${sourceRoot}capx/integrations/franka/control.py#L417-L455`,
    sourceLabel: '参照実装 · FrankaControlApi · e26d1ea',
    scopeNote,
  },
  get_observation: {
    name: 'get_observation',
    summaryJa: '環境から現在のカメラ画像・深度画像とカメラ情報を取得します。',
    descriptionJa: '参照定義では、環境の観測を取得し、robot0_robotview のRGB画像・深度画像・カメラ内部行列・カメラ姿勢行列を含む辞書を返します。',
    docstring: 'Get the observation of the environment.',
    signature: 'get_observation() -> dict[str, Any]',
    sourceUrl: `${sourceRoot}capx/integrations/franka/control_reduced.py#L131-L146`,
    sourceLabel: '参照実装 · FrankaControlApiReduced · e26d1ea',
    scopeNote,
  },
  segment_sam3_text_prompt: {
    name: 'segment_sam3_text_prompt',
    summaryJa: 'RGB画像と対象を示す文章をSAM3に渡し、対象領域のマスクを取得します。',
    descriptionJa: '参照定義では、RGB画像と text_prompt を受け取り、SAM3の検出結果を返します。結果の各辞書には領域マスク、ピクセル単位の境界ボックス、信頼度が含まれる場合があります。',
    docstring: 'Run SAM3 segmentation on an RGB image conditioned on a text prompt.',
    signature: 'segment_sam3_text_prompt(rgb: np.ndarray, text_prompt: str) -> list[dict[str, Any]]',
    sourceUrl: `${sourceRoot}capx/integrations/franka/control_reduced.py#L273-L310`,
    sourceLabel: '参照実装 · FrankaControlApiReduced · e26d1ea',
    scopeNote,
  },
};

const handoverDefinitions: Readonly<Record<string, ApiDefinition>> = {
  get_hammer_pose: {
    name: 'get_hammer_pose',
    summaryJa: '環境の観測からハンマーの柄の中央の位置と姿勢を取得します。',
    descriptionJa: '環境の観測に含まれる hammer_poses の handle から、XYZ位置とWXYZクォータニオンを返します。定義にはクォータニオンの信頼性について注意があります。',
    docstring: 'Get the pose of the middle of the hammer handle.',
    signature: 'get_hammer_pose() -> tuple[np.ndarray, np.ndarray]',
    sourceUrl: `${handoverSource}#L80-L93`,
    sourceLabel: handoverSourceLabel,
    scopeNote: handoverScope,
  },
  goto_pose_arm0: {
    name: 'goto_pose_arm0',
    summaryJa: '逆運動学を使ってアーム0の手先を指定した位置・姿勢へ移動します。',
    descriptionJa: 'アーム0の基準座標で指定された位置と姿勢から関節角を求め、環境の move_to_joints_blocking でアーム0を移動させます。z_approach で高さ方向にずらした位置から接近できます。',
    docstring: 'Go to pose using Inverse Kinematics for Arm 0 (robot0).',
    signature: 'goto_pose_arm0(position: np.ndarray, quaternion_wxyz: np.ndarray, z_approach: float = 0.0) -> None',
    sourceUrl: `${handoverSource}#L95-L149`,
    sourceLabel: handoverSourceLabel,
    scopeNote: handoverScope,
  },
  goto_pose_arm1: {
    name: 'goto_pose_arm1',
    summaryJa: '目標をアーム0基準からアーム1基準に変換し、逆運動学でアーム1の手先を移動します。',
    descriptionJa: '位置と姿勢をアーム1の基準座標に変換して関節角を求め、環境の move_to_joints_blocking_arm1 でアーム1を移動させます。z_approach で高さ方向にずらした位置から接近できます。',
    docstring: 'Go to pose using Inverse Kinematics for Arm 1 (robot1).',
    signature: 'goto_pose_arm1(position: np.ndarray, quaternion_wxyz: np.ndarray, z_approach: float = 0.0) -> None',
    sourceUrl: `${handoverSource}#L171-L252`,
    sourceLabel: handoverSourceLabel,
    scopeNote: handoverScope,
  },
  open_gripper_arm0: {
    name: 'open_gripper_arm0',
    summaryJa: 'アーム0のグリッパーを全開にします。',
    descriptionJa: '環境の _set_gripper に開く指令を渡し、シミュレーションを進めます。',
    docstring: 'Open gripper fully for Arm 0 (robot0).',
    signature: 'open_gripper_arm0() -> None',
    sourceUrl: `${handoverSource}#L151-L159`,
    sourceLabel: handoverSourceLabel,
    scopeNote: handoverScope,
  },
  close_gripper_arm0: {
    name: 'close_gripper_arm0',
    summaryJa: 'アーム0のグリッパーを閉じる指令を出します。',
    descriptionJa: '環境の _set_gripper に閉じる指令を渡し、シミュレーションを進めます。',
    docstring: 'Close gripper fully for Arm 0 (robot0).',
    signature: 'close_gripper_arm0() -> None',
    sourceUrl: `${handoverSource}#L161-L169`,
    sourceLabel: handoverSourceLabel,
    scopeNote: handoverScope,
  },
  open_gripper_arm1: {
    name: 'open_gripper_arm1',
    summaryJa: 'アーム1のグリッパーを全開にします。',
    descriptionJa: '環境の _set_gripper_arm1 に開く指令を渡し、シミュレーションを進めます。',
    docstring: 'Open gripper fully for Arm 1 (robot1).',
    signature: 'open_gripper_arm1() -> None',
    sourceUrl: `${handoverSource}#L254-L264`,
    sourceLabel: handoverSourceLabel,
    scopeNote: handoverScope,
  },
  close_gripper_arm1: {
    name: 'close_gripper_arm1',
    summaryJa: 'アーム1のグリッパーを閉じる指令を出します。',
    descriptionJa: '環境の _set_gripper_arm1 に閉じる指令を渡し、シミュレーションを進めます。',
    docstring: 'Close gripper fully for Arm 1 (robot1).',
    signature: 'close_gripper_arm1() -> None',
    sourceUrl: `${handoverSource}#L266-L276`,
    sourceLabel: handoverSourceLabel,
    scopeNote: handoverScope,
  },
};

export function apiDefinition(node: TNode): ApiDefinition | null {
  if (node.kind !== 'api_call') return null;
  const { name, api_class: apiClass, qualname } = dataOf(node.primary, 'api_call_start');
  if (typeof name !== 'string') return null;
  if (apiClass === handoverClass && qualname === `${handoverClass}.${name}` && Object.hasOwn(handoverDefinitions, name)) {
    return handoverDefinitions[name];
  }
  return Object.hasOwn(definitions, name) ? definitions[name] : null;
}
