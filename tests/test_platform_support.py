"""Unsupported backends fail before serving; supported POSIX features are retained."""
from types import SimpleNamespace

import pytest

from capx_trace_viewer import platform_support, server


def supported_os():
    file_open, file_stat, list_directory = object(), object(), object()
    return SimpleNamespace(
        open=file_open, stat=file_stat, listdir=list_directory,
        supports_dir_fd={file_open, file_stat}, supports_follow_symlinks={file_stat},
        supports_fd={list_directory}, pread=lambda *_: b"",
        O_NOFOLLOW=1, O_DIRECTORY=2, O_NONBLOCK=4, O_NOCTTY=8,
    )


def test_posix_capabilities_allow_backend_without_os_name_checks(monkeypatch):
    monkeypatch.setattr(platform_support, "os", supported_os())
    assert platform_support.missing_reader_capabilities() == []
    platform_support.require_supported_backend()


@pytest.mark.parametrize("missing", ["dir_fd", "follow_symlinks", "listdir_fd", "pread", "O_NOFOLLOW", "O_DIRECTORY", "O_NONBLOCK", "O_NOCTTY"])
def test_missing_safety_capability_is_not_silently_replaced(monkeypatch, missing):
    fake_os = supported_os()
    if missing == "dir_fd":
        fake_os.supports_dir_fd = set()
    elif missing == "follow_symlinks":
        fake_os.supports_follow_symlinks = set()
    elif missing == "listdir_fd":
        fake_os.supports_fd = set()
    else:
        setattr(fake_os, missing, None)
    monkeypatch.setattr(platform_support, "os", fake_os)
    assert platform_support.missing_reader_capabilities()
    with pytest.raises(platform_support.UnsupportedBackendPlatform, match="WSL/Ubuntu.*Missing capabilities"):
        platform_support.require_supported_backend()


def unsupported():
    raise platform_support.UnsupportedBackendPlatform("Use Linux, macOS or Windows WSL/Ubuntu")


def test_app_refuses_unsupported_backend_before_router_creation(monkeypatch):
    monkeypatch.setattr(server, "require_supported_backend", unsupported)
    monkeypatch.setattr(server, "create_trace_router", lambda *_args, **_kwargs: pytest.fail("router must not be created"))
    with pytest.raises(platform_support.UnsupportedBackendPlatform, match="WSL/Ubuntu"):
        server.create_app()


def test_cli_reports_actionable_platform_error_without_starting_server(monkeypatch, capsys):
    monkeypatch.setattr(server, "require_supported_backend", unsupported)
    monkeypatch.setattr(server.sys, "argv", ["capx-trace-viewer", "--viewer-only"])
    monkeypatch.setattr(server.uvicorn, "run", lambda *_args, **_kwargs: pytest.fail("server must not start"))
    with pytest.raises(SystemExit) as exc:
        server.main()
    assert exc.value.code == 2
    error = capsys.readouterr().err
    assert "WSL/Ubuntu" in error
    assert "Traceback" not in error
