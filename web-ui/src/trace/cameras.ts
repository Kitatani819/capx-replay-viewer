/** Camera identity shared by replay, recorded frames and trial comparisons. */
import type { EpisodeModel } from './model';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

function bufferCameras(model: EpisodeModel): string[] {
  const frames = object(object(model.episodeStart?.data).frames);
  return Array.isArray(frames.cameras) ? frames.cameras.filter((camera): camera is string => typeof camera === 'string' && camera.length > 0) : [];
}

/** Match the recorder's sanitize_id, including its leading-character rule. */
function sanitizeCamera(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 200);
  return !safe ? 'x' : /^[A-Za-z0-9]/.test(safe) ? safe : `x${safe.slice(1)}`;
}

/** Buffer order is recorded; dictionary cameras retain their first frame order. */
export function mainCameraOf(model: EpisodeModel): string | null {
  const declared = bufferCameras(model)[0];
  return declared && model.framesByCamera.has(declared) ? declared
    : model.framesByCamera.keys().next().value ?? declared ?? null;
}

/** Combined filenames have a recorded meaning; unknown camera names are not guessed. */
export function cameraForVideo(model: EpisodeModel, name: string): string | null {
  const match = /^video_combined(?:_([\w-]+))?\.mp4$/.exec(name);
  if (!match) return null;
  const buffers = bufferCameras(model);
  if (match[1] === undefined) return buffers[0] ?? mainCameraOf(model);
  if (match[1] === 'wrist') {
    const wrist = buffers[1] ?? ['robot0_eye_in_hand', 'wrist'].find(camera => model.framesByCamera.has(camera));
    if (wrist) return wrist;
  }
  const camera = sanitizeCamera(match[1]);
  return model.framesByCamera.has(camera) ? camera : null;
}

const CAMERA_LABELS: Record<string, string> = {
  agentview: '正面',
  robot0_robotview: 'ロボット視点',
  robot0_eye_in_hand: '手先',
  ego: '頭',
  head: '頭',
  left_wrist: '左手首',
  right_wrist: '右手首',
};

export function cameraLabel(camera: string): string {
  return CAMERA_LABELS[camera] ?? camera;
}
