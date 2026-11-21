"""Read optional runner display names without exposing private data to errors."""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path
from typing import Any

from capx_trace_recorder.timeout import is_trial_alarm

MAX_NAMES_BYTES = 64 * 1024


def _invalid_constant(value: str) -> None:
    raise ValueError("Invalid JSON constant")


def validate_names(value: Any) -> dict[str, str]:
    """Keep only bounded, nonempty string pairs from a JSON object."""
    if not isinstance(value, dict):
        return {}
    names = {}
    for key, name in value.items():
        if not isinstance(key, str) or not isinstance(name, str):
            continue
        key, name = key.strip(), name.strip()
        if 1 <= len(key) <= 200 and 1 <= len(name) <= 200:
            names[key] = name
    return names


def read_names(root: Path) -> dict[str, str]:
    """Read root/names.json; unsuitable or unreadable files mean no names."""
    try:
        path = Path(root) / "names.json"
        before = path.lstat()
        if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_NAMES_BYTES:
            return {}
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
                     | getattr(os, "O_NONBLOCK", 0))
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_size > MAX_NAMES_BYTES
                    or (info.st_dev, info.st_ino) != (before.st_dev, before.st_ino)):
                return {}
            with os.fdopen(fd, "rb", closefd=False) as stream:
                raw = stream.read(MAX_NAMES_BYTES + 1)
        finally:
            os.close(fd)
        if len(raw) > MAX_NAMES_BYTES:
            return {}
        return validate_names(json.loads(raw, parse_constant=_invalid_constant))
    except (OSError, ValueError, UnicodeError, RecursionError) as exc:
        if is_trial_alarm(exc):
            raise
        return {}
