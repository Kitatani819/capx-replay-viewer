"""Check the filesystem capabilities required by the read-only trace backend.

Linux and macOS provide these POSIX operations. Never replace descriptor-relative
opens with path-based reads: that would weaken the reader's symlink protection.
"""
from __future__ import annotations

import os


class UnsupportedBackendPlatform(RuntimeError):
    """The interpreter cannot safely serve trace files on this platform."""


def missing_reader_capabilities() -> list[str]:
    missing = []
    for function, support, label in (
        (os.open, "supports_dir_fd", "os.open(dir_fd=...)"),
        (os.stat, "supports_dir_fd", "os.stat(dir_fd=...)"),
        (os.stat, "supports_follow_symlinks", "os.stat(follow_symlinks=False)"),
        (os.listdir, "supports_fd", "os.listdir(directory_fd)"),
    ):
        if function not in getattr(os, support, set()):
            missing.append(label)
    if not callable(getattr(os, "pread", None)):
        missing.append("os.pread")
    for flag in ("O_NOFOLLOW", "O_DIRECTORY", "O_NONBLOCK", "O_NOCTTY"):
        if not getattr(os, flag, 0):
            missing.append(f"os.{flag}")
    return missing


def require_supported_backend() -> None:
    missing = missing_reader_capabilities()
    if missing:
        raise UnsupportedBackendPlatform(
            "The replay backend requires POSIX filesystem support available on Linux and macOS. "
            "On Windows, use WSL/Ubuntu with Start-Replay.ps1; native Windows Python is not supported. "
            "Missing capabilities: " + ", ".join(missing)
        )
