"""Bounded source snapshots, integrity-checked reads and a synthetic SSH transport."""
from __future__ import annotations

import copy
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from capx_trace_recorder.code_changes import capture_code_changes
from capx_trace_recorder import code_changes
from capx_trace_recorder.payload import Redacted
from capx_trace_recorder.eval import git_revision, run_eval
from capx_trace_viewer import evals, gmo
from capx_trace_viewer.eval_api import EvalService
from capx_trace_viewer.server import create_app
from test_eval_api import record, remote_eval, write_record
from test_gmo_metadata import LocalPythonRunner
from trace_viewer_testlib import LOOPBACK_BASE_URL, raw_get


def git(repo, *args):
    return subprocess.check_output(["git", "-C", str(repo), *args], stderr=subprocess.DEVNULL).decode().strip()


@pytest.fixture
def source(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q")
    (repo / "method.py").write_text("value = 1\n")
    (repo / "settings.py").write_text("enabled = True\n")
    (repo / "secrets.py").write_text("sensitive = 'example'\n")
    (repo / "binary.py").write_bytes(b"before\0binary")
    (repo / "large.py").write_text("# before\n")
    (repo / "link.py").symlink_to("method.py")
    (repo / ".gitattributes").write_text("method.py diff=unsafe\n")
    git(repo, "add", ".")
    git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "synthetic baseline")
    root = tmp_path / "traces"
    baseline = record("ev-baseline")
    baseline["git"] = git_revision(repo)
    write_record(root, baseline)
    run = root / "ev-current"
    run.mkdir()
    return repo, root, run, baseline


def snapshot(source):
    repo, root, run, _baseline = source
    metadata = capture_code_changes(repo, root, "ev-baseline", git_revision(repo), run)
    assert metadata["status"] == "recorded", metadata
    data = (run / evals.CODE_CHANGES_FILE).read_bytes()
    artifact = evals.decode_code_changes(data, metadata)
    return metadata, artifact, data


def test_snapshot_records_tracked_working_tree_and_masks_known_credentials(source):
    repo, _root, _run, _baseline = source
    fake_token = "hf_" + "x" * 35
    (repo / "method.py").write_text("value = 2\n")
    (repo / "settings.py").write_text(f"enabled = False\napi_key = '{fake_token}'\n")
    (repo / "secrets.py").write_text("sensitive = 'not-recorded'\n")
    (repo / "binary.py").write_bytes(b"after\0binary")
    (repo / "large.py").write_text("# " + "large" * 10000 + "\n")
    (repo / "untracked.py").write_text("do_not_record = True\n")
    (repo / "link.py").unlink()
    marker = repo / "unexpected-helper"
    git(repo, "config", "diff.unsafe.command", f"touch {marker}")
    metadata, artifact, data = snapshot(source)
    assert {item["path"] for item in artifact["files"]} == {"method.py", "settings.py"}
    assert metadata["untracked_files"] == 1
    assert metadata["excluded_files"] == 4
    assert metadata["redacted"] is True
    assert fake_token.encode() not in data and b"not-recorded" not in data and b"do_not_record" not in data
    assert b"-value = 1" in data and b"+value = 2" in data
    assert len(data) <= evals.MAX_CODE_CHANGES_BYTES
    assert not marker.exists(), "Git external diff helper was invoked"


def test_known_credential_in_a_filename_is_excluded_from_the_file_list(source):
    repo, _root, _run, _baseline = source
    fake_token = "hf_" + "x" * 35
    name = fake_token + ".py"
    (repo / name).write_text("value = 2\n")
    git(repo, "add", "--", name)
    metadata, artifact, data = snapshot(source)
    assert metadata["excluded_files"] == 1 and artifact["files"] == []
    assert fake_token.encode() not in data


@pytest.mark.parametrize("filter_option", ["clean", "process"])
def test_git_status_and_diff_do_not_run_content_filters_or_fsmonitor(source, filter_option):
    repo, _root, _run, _baseline = source
    marker = repo / "filter-helper-was-run"
    fsmarker = repo / "fsmonitor-was-run"
    (repo / ".gitattributes").write_text("*.py filter=unsafe\nmethod.py diff=unsafe\n")
    git(repo, "config", f"filter.unsafe.{filter_option}", f"sh -c 'touch {marker}; cat'")
    git(repo, "config", "filter.unsafe.required", "true")
    git(repo, "config", "core.fsmonitor", f"sh -c 'touch {fsmarker}'")
    (repo / "method.py").write_text("value = 2\n")
    revision = git_revision(repo)
    assert revision is not None and revision["dirty"] is True
    _metadata, artifact, _data = snapshot(source)
    assert "method.py" in {item["path"] for item in artifact["files"]}
    assert not marker.exists() and not fsmarker.exists()


def test_redaction_expansion_never_turns_the_remaining_read_limit_negative(source, monkeypatch):
    repo, _root, _run, _baseline = source
    (repo / "method.py").write_text("value = 2\n")
    (repo / "settings.py").write_text("enabled = False\n")
    (repo / "third.py").write_text("value = 3\n")
    git(repo, "add", "third.py")
    sizes = iter([30000, 40000, 4])
    monkeypatch.setattr(code_changes, "redact", lambda *_args: Redacted("x" * next(sizes), True, False))
    metadata, artifact, _data = snapshot(source)
    assert [item["path"] for item in artifact["files"]] == ["method.py", "third.py"]
    assert metadata["excluded_files"] == 1
    with pytest.raises(OSError):
        code_changes._git(repo, ["diff"], -1, {})


@pytest.mark.parametrize("cause", ["missing", "ambiguous", "dirty", "git_missing", "object_missing"])
def test_unreproducible_baseline_has_a_reason_and_no_artifact(source, cause):
    repo, root, run, baseline = source
    if cause == "missing":
        (root / "ev-baseline" / "eval.json").unlink()
    elif cause == "ambiguous":
        write_record(root.parent / "other-traces", baseline)
    elif cause == "dirty":
        baseline["git"].update(dirty=True, diff_sha256="b" * 64)
        write_record(root, baseline)
    elif cause == "git_missing":
        baseline["git"] = None
        write_record(root, baseline)
    else:
        baseline["git"]["commit"] = "a" * 40
        write_record(root, baseline)
    result = capture_code_changes(repo, root, "ev-baseline", git_revision(repo), run)
    assert result["status"] == {"missing": "baseline_missing", "ambiguous": "baseline_ambiguous",
                                "dirty": "baseline_dirty", "git_missing": "baseline_git_missing",
                                "object_missing": "git_unavailable"}[cause]
    evals.validate_code_change_metadata(result)
    assert not (run / evals.CODE_CHANGES_FILE).exists()


def test_wrapper_keeps_snapshot_from_start_and_records_it_in_eval_metadata(source):
    repo, root, _run, _baseline = source
    (repo / "method.py").write_text("value = 2\n")
    result = run_eval([sys.executable, "-c", f"from pathlib import Path; Path({str(repo / 'method.py')!r}).write_text('value = 3\\n')"],
                      trace_root=root, baseline="ev-baseline", changed="synthetic change", repo=repo)
    assert result == 0
    created = next(path for path in root.glob("ev-*/eval.json") if path.parent.name not in {"ev-current", "ev-baseline"})
    value = json.loads(created.read_text())
    evals.validate_eval_record(value)
    patch = evals.decode_code_changes((created.parent / evals.CODE_CHANGES_FILE).read_bytes(), value["code_changes"])
    assert "+value = 2" in patch["files"][0]["diff"]
    assert "value = 3" not in patch["files"][0]["diff"]


def _current(source):
    metadata, artifact, data = snapshot(source)
    repo, root, run, _baseline = source
    value = record("ev-current", baseline="ev-baseline")
    value["git"] = git_revision(repo)
    value["code_changes"] = metadata
    write_record(root, value)
    return value, artifact, data


@pytest.mark.parametrize("damage", [None, "hash", "oversize", "symlink", "path"])
def test_local_api_only_exposes_valid_bounded_artifacts(source, damage):
    value, artifact, _data = _current(source)
    _repo, root, run, _baseline = source
    path = run / evals.CODE_CHANGES_FILE
    if damage == "hash":
        path.write_text("{}")
    elif damage == "oversize":
        path.write_bytes(b"x" * (evals.MAX_CODE_CHANGES_BYTES + 1))
    elif damage == "symlink":
        saved = run.parent / "outside"
        path.rename(saved)
        path.symlink_to(saved)
    elif damage == "path":
        artifact["files"] = [{"path": "../escape.py", "diff": "synthetic"}]
        data = json.dumps(artifact).encode()
        path.write_bytes(data)
        value["code_changes"].update(files=1, sha256=hashlib.sha256(data).hexdigest(), size_bytes=len(data))
        write_record(root, value)
    app = create_app(trace_root=root)
    with TestClient(app, base_url=LOOPBACK_BASE_URL, client=("127.0.0.1", 50000)) as client:
        response = client.get("/api/evals/ev-current/code-changes")
        assert response.status_code == 200
        result = response.json()
        assert bool(result["error"]) == bool(damage)
        assert result["artifact"] == (None if damage else artifact)
        assert client.get("/api/evals/missing/code-changes").status_code == 404
        assert client.get("/api/evals/ev-current/code-changes", headers={"Origin": "https://invalid.example"}).status_code == 403
    status, _, _ = raw_get(app, "/api/evals/ev-current/code-changes", client=("192.0.2.2", 12345))
    assert status == 403


def test_remote_read_and_fetch_manifest_include_only_fixed_bounded_code_artifact(source, tmp_path, monkeypatch):
    value, artifact, data = _current(source)
    _repo, root, run, _baseline = source
    episode = run / "trial"
    episode.mkdir()
    (episode / "episode.json").write_text("{}")
    settings = gmo.GmoSettings(host="alias", mine=(str(root),))
    runner = LocalPythonRunner()
    listing = gmo.list_remote_episodes(runner, settings, include_files=True)
    row = next(row for row in listing["evals"] if row["run_id"] == "ev-current")
    assert gmo.read_remote_code_changes(runner, settings, row) == data
    manifest = next(row for row in listing["episodes"] if row["run_id"] == "ev-current")
    assert evals.CODE_CHANGES_FILE in {item[0] for item in manifest["files"]}
    gmo.episode_manifest(manifest, {"files": manifest["files"]})
    monkeypatch.setattr(gmo, "load_settings", lambda: SimpleNamespace(configured=True))
    service = EvalService(tmp_path / "local", SimpleNamespace(remote_listing=lambda: {"evals": [remote_eval(value)], "episodes": []},
                                                             read_code_changes=lambda _id: data))
    result = service.code_changes("ev-current")
    assert result["artifact"] == artifact and result["location"] == "gmo"
    for damage in ("oversize", "symlink"):
        path = run / evals.CODE_CHANGES_FILE
        path.unlink()
        if damage == "oversize":
            path.write_bytes(b"x" * (evals.MAX_CODE_CHANGES_BYTES + 1))
        else:
            path.symlink_to(root / "ev-baseline" / "eval.json")
        with pytest.raises(gmo.FetchError):
            gmo.read_remote_code_changes(runner, settings, row)
    with pytest.raises(gmo.FetchError):
        gmo.read_remote_code_changes(runner, settings, {**row, "conflict": True})


def test_code_metadata_rejects_artifact_paths_and_extra_payload(source):
    metadata, artifact, _data = snapshot(source)
    for key, value in (("artifact", "../secret"), ("files", 101), ("sha256", "invalid"), ("size_bytes", 999999)):
        invalid = {**metadata, key: value}
        with pytest.raises(evals.EvalValidationError):
            evals.validate_code_change_metadata(invalid)
    invalid = copy.deepcopy(artifact)
    invalid["command"] = "not allowed"
    with pytest.raises(evals.EvalValidationError):
        evals.validate_code_change_artifact(invalid, metadata)
