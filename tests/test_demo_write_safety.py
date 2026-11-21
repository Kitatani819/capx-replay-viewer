"""Synthetic root logs must never overwrite unrelated files."""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from trace_viewer_testlib import load_demo_module


def stub_episodes(module, monkeypatch):
    def episode(run_dir, now):
        return SimpleNamespace(episode_id="synthetic", events=[], dir=run_dir)

    monkeypatch.setattr(module, "build_episode_a", episode)
    monkeypatch.setattr(module, "build_episode_b", lambda *args: (episode(*args), None))
    monkeypatch.setattr(module, "build_episode_c", episode)
    monkeypatch.setattr(module, "write_run_files", lambda *args: None)


@pytest.mark.parametrize("link", ["file", "hardlink", "symlink", "directory_symlink"])
def test_demo_preserves_existing_unscoped_targets(tmp_path, monkeypatch, link):
    module = load_demo_module()
    stub_episodes(module, monkeypatch)
    root = tmp_path / "traces"
    unscoped = root / "_unscoped"
    outside = tmp_path / "outside"
    outside.mkdir()
    protected = outside / "record.json"
    protected.write_text("existing record\n")
    if link == "directory_symlink":
        root.mkdir()
        unscoped.symlink_to(outside, target_is_directory=True)
        protected = outside / "unscoped.412301.jsonl"
        protected.write_text("existing record\n")
    else:
        unscoped.mkdir(parents=True)
        destination = unscoped / "unscoped.412301.jsonl"
        if link == "symlink":
            destination.symlink_to(protected)
        elif link == "hardlink":
            destination.hardlink_to(protected)
        else:
            destination.write_text("existing record\n")
            protected = destination
    result = module.main(["--out", str(root)])
    assert result == (2 if link == "directory_symlink" else 0)
    assert protected.read_text() == "existing record\n"
