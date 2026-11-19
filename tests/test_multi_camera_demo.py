"""Generated LIBERO/R1Pro-style recordings share camera buffer coordinates."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

from trace_viewer_testlib import load_demo_module


@pytest.mark.parametrize(("count", "cameras", "names"), [
    (2, ["agentview", "robot0_eye_in_hand"], ["video_combined.mp4", "video_combined_wrist.mp4"]),
    (3, ["ego", "left_wrist", "right_wrist"], ["video_combined_ego.mp4", "video_combined_left_wrist.mp4", "video_combined_right_wrist.mp4"]),
])
def test_multi_camera_recording_layout(tmp_path, count, cameras, names):
    load_demo_module()
    script = Path(__file__).resolve().parents[1] / "scripts" / "make_replay_demo.py"
    spec = importlib.util.spec_from_file_location("make_replay_demo", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    root = tmp_path / "demo"
    manifest = module.build(root, camera_count=count)
    assert manifest["cameras"] == cameras
    assert manifest["videos"] == names
    episode = root / "traces" / manifest["run"] / manifest["episode"]
    assert sorted(p.name for p in (episode / "videos").iterdir()) == sorted(names)
    assert sorted(p.name for p in (episode / "frames").iterdir()) == sorted(cameras)
    events = [json.loads(line) for line in (episode / "events.jsonl").read_text().splitlines()]
    hook = next(e for e in events if e["event_type"] == "episode_start")["data"]["frames"]
    assert hook["cameras"] == (cameras if count == 2 else ["main"])
    assert hook["buffers"] == (["_frame_buffer", "_wrist_frame_buffer"] if count == 2 else ["_frame_buffer"])
    anchors = {}
    for camera in cameras:
        frames = [e for e in events if e["event_type"] == "frame" and e["data"]["camera"] == camera]
        anchors[camera] = [(e["data"]["epoch"], e["data"]["buffer_index"], e["data"]["sim_step"]) for e in frames]
        assert anchors[camera][0] == (0, 0, 0)
        assert anchors[camera][-1] == (0, manifest["video_frames"] - 1, 120)
        for event in frames:
            artifact = event["artifacts"][0]
            assert artifact["written"] is True
            assert (episode / artifact["path"]).is_file()
    assert all(value == anchors[cameras[0]] for value in anchors.values())
    artifacts = next(e for e in events if e["event_type"] == "trial_videos")["artifacts"]
    assert [a["path"] for a in artifacts] == [f"videos/{name}" for name in names]
    assert all(a["written"] is True and a["mime"] == "video/mp4" for a in artifacts)
    import imageio.v2 as imageio

    legacy = manifest["legacy"]
    legacy_dir = root / "runner" / legacy["run"] / legacy["task"] / legacy["condition"] / legacy["trial"]
    for name in names:
        assert (legacy_dir / name).read_bytes() == (episode / "videos" / name).read_bytes()
        with imageio.get_reader(episode / "videos" / name, format="FFMPEG") as reader:
            assert reader.get_meta_data()["fps"] == 30
            assert reader.count_frames() == manifest["video_frames"]


def test_multi_camera_option_rejects_unsupported_count(tmp_path):
    load_demo_module()
    script = Path(__file__).resolve().parents[1] / "scripts" / "make_replay_demo.py"
    spec = importlib.util.spec_from_file_location("make_replay_demo", script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    with pytest.raises(ValueError, match="camera_count"):
        module.build(tmp_path / "invalid", camera_count=4)
    assert not (tmp_path / "invalid").exists()
