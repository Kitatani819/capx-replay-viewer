"""Only a small, regular private-data file can supply runner display names."""

import json
import errno
import os

import pytest


def test_validate_names_strips_and_filters_entries():
    from capx_trace_recorder.names import validate_names

    assert validate_names({
        " user_00099_test ": " 山田太郎 ",
        "x" * 200: "名" * 200,
        " " * 201 + "trimmed": " " * 201 + "trimmed" + " " * 201,
        "empty": " \t", " ": "empty key", 5: "non-string key",
        "integer": 1, "boolean": True, "nested": {"name": "山田太郎"},
        "x" * 201: "long key", "long": "名" * 201,
    }) == {"user_00099_test": "山田太郎", "x" * 200: "名" * 200, "trimmed": "trimmed"}


@pytest.mark.parametrize("value", [None, [], "name", 2])
def test_validate_names_requires_an_object(value):
    from capx_trace_recorder.names import validate_names

    assert validate_names(value) == {}


def test_read_names_accepts_exact_size_limit(tmp_path):
    from capx_trace_recorder.names import MAX_NAMES_BYTES, read_names

    payload = json.dumps({"user_00099_test": "山田太郎"}).encode("utf-8")
    path = tmp_path / "names.json"
    path.write_bytes(payload + b" " * (MAX_NAMES_BYTES - len(payload)))
    assert read_names(tmp_path) == {"user_00099_test": "山田太郎"}
    with path.open("ab") as stream:
        stream.write(b" ")
    assert read_names(tmp_path) == {}


@pytest.mark.parametrize("encoding", ["utf-8", "utf-8-sig", "utf-16", "utf-32"])
def test_read_names_uses_the_remote_scanners_json_encoding_rules(tmp_path, encoding):
    from capx_trace_recorder.names import read_names

    value = {"user_00099_test": "山田太郎"}
    (tmp_path / "names.json").write_bytes(json.dumps(value, ensure_ascii=False).encode(encoding))
    assert read_names(tmp_path) == value


@pytest.mark.parametrize("payload", [b"{bad", b"\xff", b"[]", b"null", b"[" * 2000 + b"]" * 2000,
                                    b'{"user_00099_test": "fake", "bad": NaN}'])
def test_read_names_invalid_content_is_optional(tmp_path, payload):
    from capx_trace_recorder.names import read_names

    (tmp_path / "names.json").write_bytes(payload)
    assert read_names(tmp_path) == {}


def test_unreadable_names_are_optional(tmp_path, monkeypatch):
    from capx_trace_recorder.names import read_names

    path = tmp_path / "names.json"
    path.write_text(json.dumps({"user_00099_test": "山田太郎"}), encoding="utf-8")
    original = os.open

    def denied(name, *args, **kwargs):
        if os.fsdecode(name).endswith("names.json"):
            raise PermissionError("synthetic unreadable file")
        return original(name, *args, **kwargs)

    monkeypatch.setattr(os, "open", denied)
    assert read_names(tmp_path) == {}


@pytest.mark.parametrize("error", [TimeoutError("trial alarm"), TimeoutError(errno.ETIMEDOUT, "file timeout")])
def test_read_names_preserves_trial_alarms_but_ignores_file_timeouts(tmp_path, monkeypatch, error):
    from capx_trace_recorder.names import read_names

    (tmp_path / "names.json").write_text("{}", encoding="utf-8")

    def timeout(*args, **kwargs):
        raise error

    monkeypatch.setattr(os, "open", timeout)
    if error.errno is None:
        with pytest.raises(TimeoutError, match="trial alarm"):
            read_names(tmp_path)
    else:
        assert read_names(tmp_path) == {}
