"""Regression coverage for bounded and stable event reads."""
from __future__ import annotations

import errno
import json
import os
from collections import OrderedDict
from pathlib import Path

import pytest

from capx_trace_viewer import reader
from capx_trace_viewer.end_reason import classify_trial_end


@pytest.mark.parametrize("terminated", [False, True])
def test_oversized_event_line_has_bounded_scan(tmp_path: Path, monkeypatch, terminated):
    path = tmp_path / "events.jsonl"
    path.write_bytes(b'{"pad":"' + b"x" * 30_000 + (b'"}\n' if terminated else b""))
    monkeypatch.setattr(reader, "MAX_LINE_BYTES", 1000)
    monkeypatch.setattr(reader, "MAX_LINE_SCAN_BYTES", 4096, raising=False)
    monkeypatch.setattr(reader, "GENERATION_LINE_BYTES", 1000)
    monkeypatch.setattr(reader, "_SCAN_CHUNK", 256)
    original = os.pread
    reads = []

    def counted(fd, count, offset):
        data = original(fd, count, offset)
        reads.append(len(data))
        return data

    monkeypatch.setattr(os, "pread", counted)
    cache = reader.EventsPageCache()
    for _ in range(2):
        reads.clear()
        with pytest.raises(OSError, match="event line exceeds") as error:
            cache.get(path, max_bytes=100)
        assert error.value.errno == errno.EFBIG
        assert sum(reads) <= 1000 + 100 + 4096
        with path.open("ab") as output:
            output.write(b"x")


@pytest.mark.parametrize("prefix", [b'"x":NaN,', b""])
def test_overflowing_event_numbers_are_valid_json_strings(tmp_path: Path, prefix):
    path = tmp_path / "events.jsonl"
    path.write_bytes(b"{" + prefix + b'"data":{"positive":1e400,"nested":[-1e400,1.25]}}\n')
    page = reader.read_events_page(path)
    body = json.loads(
        page.to_json_bytes(), parse_constant=lambda value: pytest.fail(f"invalid JSON constant {value}"),
    )
    assert body["events"][0]["data"] == {"positive": "inf", "nested": ["-inf", 1.25]}
    if prefix:
        assert body["events"][0]["x"] == "nan"


def test_classification_survives_event_truncation_between_pages(tmp_path: Path, monkeypatch):
    directory = tmp_path / "trial"
    directory.mkdir()
    metadata = {"status": "ended", "trace_complete": True, "end_reason": "completed",
                "task": "cube", "condition": "M1", "seed": 1, "attempt_index": 1,
                "harness_summary": {"task_completed": False}}
    (directory / "episode.json").write_text(json.dumps(metadata))
    path = directory / "events.jsonl"
    lines = b'{"event_type":"episode_end","data":{"harness_summary":{"task_completed":true}}}\n{}\n'
    path.write_bytes(lines)
    summary = reader.episode_summary("run", directory)
    expected = classify_trial_end(summary)
    original = reader.read_events_page
    calls = []

    def read_then_truncate(fd, offset=0, *args, **kwargs):
        page = original(fd, offset, max_events=1)
        calls.append(offset)
        if len(calls) == 1:
            path.write_bytes(b"")
        return page

    monkeypatch.setattr(reader, "read_events_page", read_then_truncate)
    monkeypatch.setattr(reader, "_end_classifications", OrderedDict())
    with reader.Dir.open_root(directory) as opened:
        assert reader.trial_end_classification_at(opened, summary) == expected
        assert not reader._end_classifications
        monkeypatch.setattr(reader, "read_events_page", original)
        path.write_bytes(lines)
        assert reader.trial_end_classification_at(opened, summary)["verdict"] == "success"
    assert calls == [0]
