/**
 * Reference documentation, not an identification of the implementation executed
 * by a trace. Descriptions are paraphrases of the pinned CaP-X definitions below.
 * Keep the source URL and scope warning visible wherever a definition is shown.
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

/** Exact registered API name only; a familiar suffix is not evidence of identity. */
export function apiDefinition(node: TNode): ApiDefinition | null {
  if (node.kind !== 'api_call') return null;
  const name = dataOf(node.primary, 'api_call_start').name;
  return typeof name === 'string' && Object.hasOwn(definitions, name) ? definitions[name] : null;
}
