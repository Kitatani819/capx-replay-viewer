/**
 * Descriptions and original excerpts from pinned CaP-X definitions.
 * Verified definitions match the class and qualified method recorded in the trace.
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
const reducedClass = 'FrankaControlApiReduced';
const skillClass = 'FrankaControlApiReducedSkillLibrary';
const reducedClasses = new Set([reducedClass, skillClass, 'FrankaControlApiReducedExampleless']);
const competitionSource = 'https://github.com/matsuolab/geniac_prize_2026_code/blob/ac680843fb60c464aa74c87a2815cb5917865be4/capx/integrations/franka/';
const reducedSource = `${competitionSource}control_reduced.py`;
const skillSource = `${competitionSource}control_reduced_skill_library.py`;
const reducedSourceLabel = `${reducedClass} · ac68084`;

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

const reducedDefinitions: Readonly<Record<string, ApiDefinition>> = {
  get_observation: {
    ...definitions.get_observation,
    sourceUrl: `${reducedSource}#L131-L146`,
    sourceLabel: reducedSourceLabel,
    scopeNote: handoverScope,
  },
  segment_sam3_text_prompt: {
    ...definitions.segment_sam3_text_prompt,
    sourceUrl: `${reducedSource}#L273-L310`,
    sourceLabel: reducedSourceLabel,
    scopeNote: handoverScope,
  },
  segment_sam3_point_prompt: {
    name: 'segment_sam3_point_prompt',
    summaryJa: 'RGB画像と指定したピクセル位置をSAM3に渡し、その点に対応する領域のマスクを取得します。',
    descriptionJa: 'RGB画像をPIL画像に変換し、sam3_point_prompt_fn に画像とXYピクセル座標を渡します。検出結果を返し、信頼度が0.05を超えるマスクを可視化します。',
    docstring: 'Run SAM3 segmentation on an RGB image, optionally conditioned on an image coordinate point prompt.',
    signature: 'segment_sam3_point_prompt(rgb: np.ndarray, point_coords: tuple[float, float]) -> list[dict[str, Any]]',
    sourceUrl: `${reducedSource}#L236-L271`,
    sourceLabel: reducedSourceLabel,
    scopeNote: handoverScope,
  },
  detect_object_owlvit: {
    name: 'detect_object_owlvit',
    summaryJa: 'RGB画像と対象を示す文章をOWL-ViTに渡し、対象の境界ボックス・ラベル・信頼度を取得します。',
    descriptionJa: 'owl_vit_det_fn にRGB画像と texts=[[text]] を渡し、ピクセル座標のボックス、ラベル、信頼度を含む検出結果のリストを返します。',
    docstring: 'Run OWL-ViT open-vocabulary detection on a single RGB image.',
    signature: 'detect_object_owlvit(rgb: np.ndarray, text: str) -> list[dict[str, Any]]',
    sourceUrl: `${reducedSource}#L155-L190`,
    sourceLabel: reducedSourceLabel,
    scopeNote: handoverScope,
  },
  segment_sam2: {
    name: 'segment_sam2',
    summaryJa: 'RGB画像と任意の境界ボックスをSAM2に渡し、対象領域のマスクを取得します。',
    descriptionJa: 'sam2_seg_fn に画像と box を渡して検出結果を返します。box はXYXYのピクセル座標で、省略時は画像全体が対象です。信頼度が0.05を超えるマスクを可視化します。',
    docstring: 'Run SAM2 segmentation on an RGB image, optionally conditioned on a box.',
    signature: 'segment_sam2(rgb: np.ndarray, box: list[float] | None = None) -> list[dict[str, Any]]',
    sourceUrl: `${reducedSource}#L192-L230`,
    sourceLabel: reducedSourceLabel,
    scopeNote: handoverScope,
  },
  point_prompt_molmo: {
    name: 'point_prompt_molmo',
    summaryJa: '画像と対象を示す文章をMolmoに渡し、対象のピクセル座標を取得します。',
    descriptionJa: 'RGB画像をPIL画像に変換し、molmo_point_fn に画像と objects=[text_prompt] を渡します。問い合わせた対象ごとのXY座標を辞書で返し、座標を解釈できなかった場合は None を含みます。',
    docstring: 'Use Molmo to point to a coordinate in the image based on a text prompt.',
    signature: 'point_prompt_molmo(image: np.ndarray, text_prompt: str) -> dict[str, tuple[int | None, int | None]]',
    sourceUrl: `${reducedSource}#L315-L339`,
    sourceLabel: reducedSourceLabel,
    scopeNote: handoverScope,
  },
  plan_grasp: {
    name: 'plan_grasp',
    summaryJa: '深度画像・カメラ内部行列・対象マスクをContact-GraspNetに渡し、把持候補の姿勢と信頼度を取得します。',
    descriptionJa: 'grasp_net_plan_fn でカメラ座標の把持候補を求めます。この実装は各候補の局所Z方向に0.12mの並進を加えた姿勢行列と信頼度を返します。ワールド座標への変換は呼び出し側で行います。',
    docstring: 'Plan grasp candidates using Contact-GraspNet for a single instance.',
    signature: 'plan_grasp(depth: np.ndarray, intrinsics: np.ndarray, segmentation: np.ndarray) -> tuple[np.ndarray, np.ndarray]',
    sourceUrl: `${reducedSource}#L363-L436`,
    sourceLabel: reducedSourceLabel,
    scopeNote: handoverScope,
  },
  get_oriented_bounding_box_from_3d_points: {
    name: 'get_oriented_bounding_box_from_3d_points',
    summaryJa: '3次元点群を囲む向き付きの境界ボックスを求め、中心・大きさ・回転行列を返します。',
    descriptionJa: '入力点群から向き付き境界ボックスを計算し、center、extent、R を持つ辞書を返します。座標は入力点群と同じ座標系です。',
    docstring: 'Get the oriented bounding box from 3D points.',
    signature: 'get_oriented_bounding_box_from_3d_points(points: np.ndarray) -> dict[str, Any]',
    sourceUrl: `${reducedSource}#L341-L358`,
    sourceLabel: reducedSourceLabel,
    scopeNote: handoverScope,
  },
  solve_ik: {
    name: 'solve_ik',
    summaryJa: '目標位置・姿勢から逆運動学を解き、Frankaアームの7関節の角度を返します。',
    descriptionJa: 'XYZ位置とWXYZクォータニオンにTCPオフセットを適用し、ik_solve_fn で関節角を求めます。実機モードでは姿勢を補正して1回計算し、それ以外では収束計算を行います。移動は move_to_joints で行います。',
    docstring: 'Solve inverse kinematics for the panda_hand link.',
    signature: 'solve_ik(position: np.ndarray, quaternion_wxyz: np.ndarray) -> np.ndarray',
    sourceUrl: `${reducedSource}#L441-L488`,
    sourceLabel: reducedSourceLabel,
    scopeNote: handoverScope,
  },
  move_to_joints: {
    name: 'move_to_joints',
    summaryJa: 'Frankaアームを指定した7関節の角度へ移動させ、移動処理が戻るまで待ちます。',
    descriptionJa: '指定された関節角を7要素のfloat64配列に変換し、環境の move_to_joints_blocking に渡します。',
    docstring: 'Move the robot to a given joint configuration in a blocking manner.',
    signature: 'move_to_joints(joints: np.ndarray) -> None',
    sourceUrl: `${reducedSource}#L492-L510`,
    sourceLabel: reducedSourceLabel,
    scopeNote: handoverScope,
  },
  open_gripper: {
    name: 'open_gripper',
    summaryJa: 'Frankaアームのグリッパーを全開にします。',
    descriptionJa: 'common.open_gripper を呼び、環境の _set_gripper に1.0を渡してからシミュレーションを30ステップ進めます。',
    docstring: 'Open gripper fully.',
    signature: 'open_gripper() -> None',
    sourceUrl: `${reducedSource}#L514-L522`,
    sourceLabel: reducedSourceLabel,
    scopeNote: handoverScope,
  },
  close_gripper: {
    name: 'close_gripper',
    summaryJa: 'Frankaアームのグリッパーを閉じる指令を出します。',
    descriptionJa: 'common.close_gripper を呼び、環境の _set_gripper に0.0を渡してからシミュレーションを30ステップ進めます。',
    docstring: 'Close gripper fully.',
    signature: 'close_gripper() -> None',
    sourceUrl: `${reducedSource}#L524-L532`,
    sourceLabel: reducedSourceLabel,
    scopeNote: handoverScope,
  },
  move_to_joints_both: {
    name: 'move_to_joints_both',
    summaryJa: 'アーム0とアーム1をそれぞれ指定した7関節の角度へ同時に移動させます。',
    descriptionJa: 'アーム0とアーム1の関節角を、環境の move_to_joints_blocking_both に渡し、両アームの移動処理が戻るまで待ちます。',
    docstring: 'Move the arms 0 and 1 to a given joint configuration in a blocking manner simultaneously.',
    signature: 'move_to_joints_both(joints0: np.ndarray, joints1: np.ndarray) -> None',
    sourceUrl: `${reducedSource}#L572-L583`,
    sourceLabel: reducedSourceLabel,
    scopeNote: handoverScope,
  },
  solve_ik_arm0: {
    name: 'solve_ik_arm0',
    summaryJa: 'アーム0の目標位置・姿勢から逆運動学を解き、7関節の角度を返します。',
    descriptionJa: 'アーム0基準のXYZ位置とWXYZクォータニオンにTCPオフセットを適用し、ik_solve_fn で逆運動学を解いて7関節の角度を返します。移動は move_to_joints_arm0 の呼び出しで行います。',
    docstring: 'Solve inverse kinematics for the panda_hand link for Arm 0 (robot0).',
    signature: 'solve_ik_arm0(position: np.ndarray, quaternion_wxyz: np.ndarray) -> np.ndarray',
    sourceUrl: `${reducedSource}#L643-L652`,
    sourceLabel: reducedSourceLabel,
    scopeNote: handoverScope,
  },
  solve_ik_arm1: {
    name: 'solve_ik_arm1',
    summaryJa: '目標をアーム0基準からアーム1基準へ変換して逆運動学を解き、7関節の角度を返します。',
    descriptionJa: 'XYZ位置とWXYZクォータニオンをアーム1の基準座標へ変換し、TCPオフセットを適用して ik_solve_fn で7関節の角度を求めます。移動は move_to_joints_arm1 の呼び出しで行います。',
    docstring: 'Solve inverse kinematics for the panda_hand link for Arm 1 (robot1).',
    signature: 'solve_ik_arm1(position: np.ndarray, quaternion_wxyz: np.ndarray) -> np.ndarray',
    sourceUrl: `${reducedSource}#L654-L667`,
    sourceLabel: reducedSourceLabel,
    scopeNote: handoverScope,
  },
  move_to_joints_arm0: {
    name: 'move_to_joints_arm0',
    summaryJa: 'アーム0を指定した7関節の角度へ移動させ、移動処理が戻るまで待ちます。',
    descriptionJa: '指定された関節角を7要素のfloat64配列に変換し、環境の move_to_joints_blocking に渡してアーム0を移動させます。',
    docstring: 'Move the robot arm 0 to a given joint configuration in a blocking manner.',
    signature: 'move_to_joints_arm0(joints: np.ndarray) -> None',
    sourceUrl: `${reducedSource}#L585-L594`,
    sourceLabel: reducedSourceLabel,
    scopeNote: handoverScope,
  },
  move_to_joints_arm1: {
    name: 'move_to_joints_arm1',
    summaryJa: 'アーム1を指定した7関節の角度へ移動させ、移動処理が戻るまで待ちます。',
    descriptionJa: '指定された関節角を7要素のfloat64配列に変換し、環境の move_to_joints_blocking_arm1 に渡してアーム1を移動させます。',
    docstring: 'Move the robot arm 1 to a given joint configuration in a blocking manner.',
    signature: 'move_to_joints_arm1(joints: np.ndarray) -> None',
    sourceUrl: `${reducedSource}#L596-L605`,
    sourceLabel: reducedSourceLabel,
    scopeNote: handoverScope,
  },
  open_gripper_arm0: {
    ...handoverDefinitions.open_gripper_arm0,
    descriptionJa: 'common.open_gripper を呼び、アーム0の _set_gripper に1.0を渡してからシミュレーションを30ステップ進めます。',
    sourceUrl: `${reducedSource}#L607-L614`,
    sourceLabel: reducedSourceLabel,
  },
  close_gripper_arm0: {
    ...handoverDefinitions.close_gripper_arm0,
    descriptionJa: 'common.close_gripper を呼び、アーム0の _set_gripper に0.0を渡してからシミュレーションを30ステップ進めます。',
    sourceUrl: `${reducedSource}#L616-L623`,
    sourceLabel: reducedSourceLabel,
  },
  open_gripper_arm1: {
    ...handoverDefinitions.open_gripper_arm1,
    descriptionJa: 'common.open_gripper_arm1 を呼び、環境の _set_gripper_arm1 に1.0を渡してからシミュレーションを30ステップ進めます。',
    sourceUrl: `${reducedSource}#L625-L632`,
    sourceLabel: reducedSourceLabel,
  },
  close_gripper_arm1: {
    ...handoverDefinitions.close_gripper_arm1,
    descriptionJa: 'common.close_gripper_arm1 を呼び、環境の _set_gripper_arm1 に0.0を渡してからシミュレーションを30ステップ進めます。',
    sourceUrl: `${reducedSource}#L634-L641`,
    sourceLabel: reducedSourceLabel,
  },
};

const skillDefinitions: Readonly<Record<string, ApiDefinition>> = {
  rotation_matrix_to_quaternion: {
    name: 'rotation_matrix_to_quaternion',
    summaryJa: '3×3の回転行列をWXYZ順のクォータニオンへ変換します。',
    descriptionJa: '回転行列のトレースと対角成分に応じて計算式を切り替え、[w, x, y, z] の4要素配列を返します。',
    docstring: 'Convert a 3x3 rotation matrix to a unit quaternion [w, x, y, z].',
    signature: 'rotation_matrix_to_quaternion(R: np.ndarray) -> np.ndarray',
    sourceUrl: `${skillSource}#L74-L113`,
    sourceLabel: `${skillClass} · ac68084`,
    scopeNote: handoverScope,
  },
  decompose_transform: {
    name: 'decompose_transform',
    summaryJa: '4×4の同次変換行列をXYZ位置とWXYZ順のクォータニオンに分解します。',
    descriptionJa: '行列の最終列から位置を取り出し、左上の3×3回転行列を rotation_matrix_to_quaternion で変換して、位置と姿勢の組を返します。',
    docstring: 'Decompose a 4x4 homogeneous transformation matrix into position and quaternion.',
    signature: 'decompose_transform(T: np.ndarray) -> tuple[np.ndarray, np.ndarray]',
    sourceUrl: `${skillSource}#L115-L131`,
    sourceLabel: `${skillClass} · ac68084`,
    scopeNote: handoverScope,
  },
  depth_to_point_cloud: {
    name: 'depth_to_point_cloud',
    summaryJa: '深度画像とカメラ内部行列から、各ピクセルのカメラ座標の3次元点を求めます。',
    descriptionJa: '焦点距離と主点から各ピクセルのXYZ座標を計算し、(H, W, 3) の配列を返します。ワールド座標への変換や無効な深度の除外は行いません。',
    docstring: 'Convert a depth image to a 3D point cloud in the Camera Frame.',
    signature: 'depth_to_point_cloud(depth_img: np.ndarray, intrinsics: np.ndarray) -> np.ndarray',
    sourceUrl: `${skillSource}#L138-L166`,
    sourceLabel: `${skillClass} · ac68084`,
    scopeNote: handoverScope,
  },
  mask_to_world_points: {
    name: 'mask_to_world_points',
    summaryJa: 'マスク内のピクセルを深度とカメラ行列で3次元化し、ワールド座標の点群へ変換します。',
    descriptionJa: 'マスクが正のピクセルを取り出し、正の深度とカメラ内部行列からカメラ座標の点群を求め、外部行列でワールド座標へ変換します。マスクが空なら空の点群を返します。',
    docstring: 'Convert specific pixels defined by a binary mask into 3D points in the World Frame.',
    signature: 'mask_to_world_points(mask: np.ndarray, depth: np.ndarray, intrinsics: np.ndarray, extrinsics: np.ndarray) -> np.ndarray',
    sourceUrl: `${skillSource}#L168-L218`,
    sourceLabel: `${skillClass} · ac68084`,
    scopeNote: handoverScope,
  },
  pixel_to_world_point: {
    name: 'pixel_to_world_point',
    summaryJa: '1ピクセルの位置と深度をカメラ行列で変換し、ワールド座標の3次元位置を求めます。',
    descriptionJa: 'uを列、vを行、zを深度としてカメラ座標の点を求め、4×4のカメラ外部行列 extrinsics を掛けてXYZ座標を返します。',
    docstring: 'Deproject a single pixel to a 3D world point.',
    signature: 'pixel_to_world_point(u: int, v: int, z: float, intrinsics: np.ndarray, extrinsics: np.ndarray) -> np.ndarray',
    sourceUrl: `${skillSource}#L220-L246`,
    sourceLabel: `${skillClass} · ac68084`,
    scopeNote: handoverScope,
  },
  transform_points: {
    name: 'transform_points',
    summaryJa: '3次元点群に4×4の同次変換行列を適用し、変換後の点群を返します。',
    descriptionJa: '(N, 3) または (H, W, 3) の点群を同次座標へ変換して行列を掛け、元の配列形状で返します。',
    docstring: 'Apply a 4x4 homogeneous transform to a set of 3D points.',
    signature: 'transform_points(points: np.ndarray, transform_matrix: np.ndarray) -> np.ndarray',
    sourceUrl: `${skillSource}#L253-L277`,
    sourceLabel: `${skillClass} · ac68084`,
    scopeNote: handoverScope,
  },
  interpolate_segment: {
    name: 'interpolate_segment',
    summaryJa: '2つの3次元位置を結ぶ直線上に、指定した間隔以下で経由点を生成します。',
    descriptionJa: '距離を step で割って切り上げた区間数で線形補間し、両端を含む点のリストを返します。2点の距離が1e-6未満なら始点だけを返します。',
    docstring: 'Generate waypoints along a line segment between two 3D points.',
    signature: 'interpolate_segment(p1: np.ndarray, p2: np.ndarray, step: float = 0.03) -> list[np.ndarray]',
    sourceUrl: `${skillSource}#L279-L299`,
    sourceLabel: `${skillClass} · ac68084`,
    scopeNote: handoverScope,
  },
  normalize_vector: {
    name: 'normalize_vector',
    summaryJa: 'ベクトルをその長さで割り、向きを保った単位ベクトルを求めます。',
    descriptionJa: 'ノルムが1e-6以上ならベクトルをノルムで割り、それより小さい場合は入力をそのまま返します。',
    docstring: 'Normalize a vector to unit length.',
    signature: 'normalize_vector(v: np.ndarray) -> np.ndarray',
    sourceUrl: `${skillSource}#L301-L314`,
    sourceLabel: `${skillClass} · ac68084`,
    scopeNote: handoverScope,
  },
  select_top_down_grasp: {
    name: 'select_top_down_grasp',
    summaryJa: '把持候補をワールド座標へ変換し、上から下を向く候補のうち信頼度が最大の姿勢を選びます。',
    descriptionJa: 'cam_to_world を掛けた候補の局所Z軸と下向き軸の内積が vertical_threshold を超えるものを比較します。最良の姿勢行列とスコアを返し、該当候補がなければ (None, -inf) を返します。',
    docstring: 'Selects the best grasp that aligns the gripper vertically (Top-Down).',
    signature: 'select_top_down_grasp(grasps: np.ndarray, scores: np.ndarray, cam_to_world: np.ndarray, vertical_threshold: float = 0.8) -> tuple',
    sourceUrl: `${skillSource}#L319-L364`,
    sourceLabel: `${skillClass} · ac68084`,
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
  if (typeof apiClass === 'string' && reducedClasses.has(apiClass) && qualname === `${reducedClass}.${name}` && Object.hasOwn(reducedDefinitions, name)) {
    return reducedDefinitions[name];
  }
  if (apiClass === skillClass && qualname === `${skillClass}.${name}` && Object.hasOwn(skillDefinitions, name)) {
    return skillDefinitions[name];
  }
  return Object.hasOwn(definitions, name) ? definitions[name] : null;
}
