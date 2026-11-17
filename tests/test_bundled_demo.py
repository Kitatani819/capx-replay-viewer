"""The launcher's default demo: a GMO recording with personal details removed."""
from __future__ import annotations

import gzip
import re
from pathlib import Path

from capx_trace_viewer import reader

DEMO = Path(__file__).resolve().parents[1] / "demo"
RUN = "gmo_model_handover_s301_39328"
# Account names, home paths and GMO host names must never ship with the demo.
PERSONAL = re.compile(rb"user_\d{5}|group_[0-9a-f]{6}|/home/|gmo-gpu\.io|aic-gb3a")
TEXT_SUFFIXES = {".json", ".jsonl", ".txt", ".py", ".sh"}


def test_launchers_default_to_the_bundled_demo():
    root = DEMO.parent
    for script in ("Start-Replay.sh", "scripts/serve_replay.sh"):
        text = (root / script).read_text(encoding="utf-8")
        assert "demo/traces" in text and "demo/runner" in text, script
        assert "make_replay_demo" not in text, script
    ps1 = (root / "Start-Replay.ps1").read_text(encoding="utf-8")
    assert "'demo/traces'" in ps1 and "'demo/runner'" in ps1


def test_bundled_demo_is_a_complete_recording():
    runs = {run["run_id"]: run for run in reader.list_runs(DEMO / "traces")}
    assert set(runs) == {RUN}
    counts = runs[RUN]["status_counts"]
    assert counts["ended"] == 1 and sum(counts.values()) == 1
    (episode_dir,) = [p for p in (DEMO / "traces" / RUN).iterdir() if p.is_dir()]
    summary = reader.episode_summary(RUN, episode_dir)
    assert summary["status"] == "ended" and summary["trace_complete"] is True
    assert summary["gaps"] == []
    trials = list((DEMO / "runner" / RUN / "two_arm_handover").glob("*/trial_*"))
    assert len(trials) == 1 and (trials[0] / "video_combined.mp4").is_file()


def test_bundled_demo_has_no_personal_details():
    hits = []
    for path in sorted(DEMO.rglob("*")):
        if not path.is_file():
            continue
        if path.suffix in TEXT_SUFFIXES:
            data = path.read_bytes()
        elif path.suffix == ".gz":
            data = gzip.decompress(path.read_bytes())
        else:
            continue
        hits.extend(f"{path.relative_to(DEMO)}: {m.group().decode()}" for m in PERSONAL.finditer(data))
    assert hits == []
