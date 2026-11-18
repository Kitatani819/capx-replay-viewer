"""``--uds``: serving on a Unix domain socket that only its owner can connect to.

On a shared machine (a GMO compute node runs other teams' jobs) any local user can
connect to 127.0.0.1, so the loopback check of the trace and GMO APIs keeps nobody on
the node out. ``--uds PATH`` listens on a socket in a directory only this user can
enter instead. These tests cover the directory and socket permissions, a real server
answering through the socket (a request through it has no client address), and that the
TCP default and its client check are unchanged.
"""
from __future__ import annotations

import os
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx
import pytest
from fastapi import HTTPException, Request
from trace_viewer_testlib import REPO_ROOT, raw_get

from capx_trace_viewer import server
from capx_trace_viewer.gmo_api import GmoService, create_gmo_router
from capx_trace_viewer.platform_support import UnsupportedBackendPlatform
from capx_trace_viewer.server import SocketPathError, bind_private_unix_socket, create_app

pytestmark = pytest.mark.skipif(not hasattr(socket, "AF_UNIX"), reason="needs Unix domain sockets")

DEMO_RUN = "gmo_model_handover_s301_39328"
FORWARDED = "http://127.0.0.1:18390"  # what the browser opens through ssh -L 127.0.0.1:18390:<socket>


@pytest.fixture
def sock_dir():
    """A private directory with a short path (macOS limits socket paths to 103 bytes)."""
    path = Path(tempfile.mkdtemp(prefix="capx-uds-", dir="/tmp"))
    path.chmod(0o700)
    yield path
    path.chmod(0o700)
    shutil.rmtree(path, ignore_errors=True)


# ---------------------------------------------------------------------------
# directory and socket permissions
# ---------------------------------------------------------------------------


def test_socket_is_0600_in_a_0700_directory_whatever_the_umask(sock_dir):
    old = os.umask(0)
    try:
        sock, path = bind_private_unix_socket(sock_dir / "viewer.sock")
        try:
            assert os.umask(0) == 0  # the umask is restored
            assert path == sock_dir / "viewer.sock" and path.is_absolute()
            st = os.lstat(path)
            assert stat.S_ISSOCK(st.st_mode) and stat.S_IMODE(st.st_mode) == 0o600
            client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            client.connect(str(path))  # already listening
            client.close()
        finally:
            sock.close()
    finally:
        os.umask(old)


@pytest.mark.parametrize("mode", [0o755, 0o750, 0o711, 0o701, 0o770, 0o707, 0o777])
def test_directory_others_can_enter_is_refused(sock_dir, mode):
    sock_dir.chmod(mode)
    with pytest.raises(SocketPathError, match="must be 700"):
        bind_private_unix_socket(sock_dir / "viewer.sock")
    assert not os.path.lexists(sock_dir / "viewer.sock")


def test_setgid_bit_inherited_from_home_is_accepted(sock_dir):
    sock_dir.chmod(0o2700)
    if not sock_dir.stat().st_mode & stat.S_ISGID:
        pytest.skip("cannot set the setgid bit on this directory")
    sock, path = bind_private_unix_socket(sock_dir / "viewer.sock")
    sock.close()
    assert stat.S_IMODE(os.lstat(path).st_mode) == 0o600


def test_directory_of_another_user_is_refused(sock_dir, monkeypatch):
    real = os.geteuid()
    monkeypatch.setattr(os, "geteuid", lambda: real + 1)
    with pytest.raises(SocketPathError, match="must be owned by you"):
        bind_private_unix_socket(sock_dir / "viewer.sock")
    assert not os.path.lexists(sock_dir / "viewer.sock")


def test_missing_directory_or_file_parent_is_refused(sock_dir):
    with pytest.raises(SocketPathError, match="does not exist"):
        bind_private_unix_socket(sock_dir / "missing" / "viewer.sock")
    assert not (sock_dir / "missing").exists()  # never created with a guessed mode
    (sock_dir / "file").write_text("x")
    with pytest.raises(SocketPathError, match="not a directory"):
        bind_private_unix_socket(sock_dir / "file" / "viewer.sock")


def test_existing_path_is_never_replaced(sock_dir):
    regular = sock_dir / "viewer.sock"
    regular.write_text("keep")
    with pytest.raises(SocketPathError, match="already exists"):
        bind_private_unix_socket(regular)
    assert regular.read_text() == "keep"
    # A socket left by another viewer (possibly on another node sharing $HOME) stays too.
    other, path = bind_private_unix_socket(sock_dir / "other.sock")
    other.close()
    with pytest.raises(SocketPathError, match="already exists"):
        bind_private_unix_socket(path)
    assert stat.S_ISSOCK(os.lstat(path).st_mode)


def test_too_long_path_is_a_clear_error(sock_dir):
    with pytest.raises(SocketPathError, match="Cannot listen"):
        bind_private_unix_socket(sock_dir / ("s" * 200))


# ---------------------------------------------------------------------------
# the gates accept requests without a client address only on a --uds server
# ---------------------------------------------------------------------------


def test_trace_api_accepts_requests_without_a_client_only_on_a_socket(tmp_path):
    uds_app = create_app(trace_root=tmp_path, frontend_dist=tmp_path / "no-dist", unix_socket=True)
    assert raw_get(uds_app, "/api/traces/config", client=None)[0] == 200  # type: ignore[arg-type]
    status, body, _ = raw_get(uds_app, "/api/traces/config", client=None,  # type: ignore[arg-type]
                              headers=[(b"host", b"rebind.attacker.example:18390")])
    assert status == 403 and b"Host header" in body
    status, _, _ = raw_get(uds_app, "/api/traces/config", client=None,  # type: ignore[arg-type]
                           headers=[(b"host", b"127.0.0.1:18390"), (b"origin", b"https://attacker.example")])
    assert status == 403
    assert raw_get(uds_app, "/api/traces/config", client=("10.0.0.5", 40000))[0] == 403
    tcp_app = create_app(trace_root=tmp_path, frontend_dist=tmp_path / "no-dist")
    assert raw_get(tcp_app, "/api/traces/config", client=None)[0] == 403  # type: ignore[arg-type]


def test_eval_api_accepts_requests_without_a_client_only_on_a_socket(tmp_path):
    uds_app = create_app(trace_root=tmp_path, frontend_dist=tmp_path / "no-dist", unix_socket=True)
    assert raw_get(uds_app, "/api/evals", client=None)[0] == 200  # type: ignore[arg-type]
    status, _, _ = raw_get(uds_app, "/api/evals", client=None,  # type: ignore[arg-type]
                           headers=[(b"host", b"rebind.attacker.example:18390")])
    assert status == 403
    assert raw_get(uds_app, "/api/evals", client=("10.0.0.5", 40000))[0] == 403
    tcp_app = create_app(trace_root=tmp_path, frontend_dist=tmp_path / "no-dist")
    assert raw_get(tcp_app, "/api/evals", client=None)[0] == 403  # type: ignore[arg-type]


@pytest.mark.parametrize("unix_socket", [True, False])
def test_gmo_gate_accepts_requests_without_a_client_only_on_a_socket(tmp_path, unix_socket):
    service = GmoService(tmp_path)
    gate = create_gmo_router(service, unix_socket=unix_socket).dependencies[0].dependency
    scope = {"type": "http", "method": "GET", "path": "/api/gmo/config", "query_string": b"",
             "client": None, "headers": [(b"host", b"127.0.0.1:18390"), (b"x-capx-request", b"gmo")]}
    try:
        if unix_socket:
            gate(Request(scope))
        else:
            with pytest.raises(HTTPException) as error:
                gate(Request(scope))
            assert error.value.status_code == 403
        scope["headers"][0] = (b"host", b"rebind.attacker.example")
        with pytest.raises(HTTPException):
            gate(Request(scope))
    finally:
        service.close()


# ---------------------------------------------------------------------------
# a real server on a socket
# ---------------------------------------------------------------------------


def _start(sock: Path, tmp_path: Path, *extra: str) -> subprocess.Popen:
    dist = tmp_path / "dist"
    dist.mkdir(exist_ok=True)
    (dist / "index.html").write_text("viewer")
    env = {k: v for k, v in os.environ.items() if not k.startswith(("CAPX_GMO_", "SLURM_"))}
    env["CAPX_GMO_CONFIG"] = str(tmp_path / "config" / "gmo.json")
    command = [sys.executable, "-m", "capx_trace_viewer.server", "--viewer-only", "--uds", str(sock),
               "--trace-root", str(REPO_ROOT / "demo" / "traces"),
               "--runner-root", str(REPO_ROOT / "demo" / "runner"), "--frontend-dist", str(dist), *extra]
    proc = subprocess.Popen(command, cwd=REPO_ROOT, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True)
    deadline = time.monotonic() + 30
    with _client(sock) as client:
        while True:
            if proc.poll() is not None:
                pytest.fail(f"server exited with {proc.returncode}: {proc.stdout.read()}")
            try:
                client.get("/api/traces/config")
                return proc
            except httpx.TransportError:
                if time.monotonic() > deadline:
                    proc.kill()
                    pytest.fail(f"server did not answer on {sock}: {proc.communicate()[0]}")
                time.sleep(0.05)


def _client(sock: Path) -> httpx.Client:
    return httpx.Client(transport=httpx.HTTPTransport(uds=str(sock)), base_url=FORWARDED, timeout=10)


def _stop(proc: subprocess.Popen, sig: int = signal.SIGTERM) -> tuple[int, str]:
    if proc.poll() is None:
        proc.send_signal(sig)
    try:
        output, _ = proc.communicate(timeout=20)
    except subprocess.TimeoutExpired:
        proc.kill()
        output, _ = proc.communicate()
    return proc.returncode, output


def test_server_answers_through_the_socket(sock_dir, tmp_path):
    sock = sock_dir / "viewer.sock"
    proc = _start(sock, tmp_path, "--gmo")
    try:
        assert stat.S_IMODE(os.lstat(sock).st_mode) == 0o600
        with _client(sock) as client:
            runs = client.get("/api/traces/runs")
            assert runs.status_code == 200
            assert DEMO_RUN in {run["run_id"] for run in runs.json()["runs"]}
            assert client.get("/api/traces/legacy/runs").status_code == 200
            assert client.get("/traces").text == "viewer"
            # A DNS-rebinding page or another site is still refused through the socket.
            assert client.get("/api/traces/runs", headers={"Host": "rebind.attacker.example"}).status_code == 403
            assert client.get("/api/traces/runs", headers={"Origin": "https://attacker.example"}).status_code == 403
            # X-Forwarded-For does not replace the missing client address.
            assert client.get("/api/traces/runs", headers={"X-Forwarded-For": "192.0.2.1"}).status_code == 200
            gmo = client.get("/api/gmo/config", headers={"X-CapX-Request": "gmo"})
            assert gmo.status_code == 200 and gmo.json()["enabled"] is True
            assert client.get("/api/gmo/config").status_code == 403
            assert client.put("/api/gmo/config", json={},
                              headers={"X-CapX-Request": "gmo", "Origin": "https://attacker.example"}).status_code == 403
    finally:
        returncode, output = _stop(proc)
    # uvicorn >= 0.29 re-raises SIGTERM after shutting down (143); 0.27-0.28 exit with 0.
    assert returncode in (0, 128 + signal.SIGTERM), output
    assert f"unix socket {sock}" in output
    assert not os.path.lexists(sock)  # removed on SIGTERM (Slurm ends jobs with it)


def test_ctrl_c_removes_the_socket(sock_dir, tmp_path):
    sock = sock_dir / "viewer.sock"
    proc = _start(sock, tmp_path)
    returncode, output = _stop(proc, signal.SIGINT)
    assert returncode == 0, output
    assert not os.path.lexists(sock)


def test_unsafe_directory_refuses_to_start(sock_dir, tmp_path):
    sock_dir.chmod(0o755)
    result = subprocess.run([sys.executable, "-m", "capx_trace_viewer.server", "--uds", str(sock_dir / "v.sock"),
                             "--trace-root", str(tmp_path)], cwd=REPO_ROOT, capture_output=True, text=True,
                            timeout=60)
    assert result.returncode == 2
    assert "must be 700" in result.stderr and f"chmod 700 {sock_dir}" in result.stderr
    assert not os.path.lexists(sock_dir / "v.sock")


# ---------------------------------------------------------------------------
# the command line: TCP stays the default
# ---------------------------------------------------------------------------


@pytest.fixture
def no_serve(monkeypatch):
    calls: list[dict] = []
    monkeypatch.setattr(server.uvicorn, "run", lambda app, **kwargs: calls.append({"app": app, **kwargs}))
    monkeypatch.delenv("SLURM_JOB_ID", raising=False)
    return calls


def test_tcp_default_is_unchanged(tmp_path, no_serve, capsys):
    server.main(["--viewer-only", "--trace-root", str(tmp_path), "--frontend-dist", str(tmp_path / "no-dist")])
    (call,) = no_serve
    assert call["host"] == "127.0.0.1" and call["port"] == 8290 and set(call) == {"app", "host", "port"}
    # The TCP server still refuses a request without a loopback client address.
    assert raw_get(call["app"], "/api/traces/config", client=None)[0] == 403  # type: ignore[arg-type]
    assert raw_get(call["app"], "/api/traces/config")[0] == 200
    assert "Slurm" not in capsys.readouterr().err
    server.main(["--host", "127.0.0.2", "--port", "8390", "--trace-root", str(tmp_path)])
    assert (no_serve[1]["host"], no_serve[1]["port"]) == ("127.0.0.2", 8390)


def test_tcp_in_a_slurm_job_warns_about_other_users(tmp_path, no_serve, monkeypatch, capsys):
    monkeypatch.setenv("SLURM_JOB_ID", "12345")
    server.main(["--trace-root", str(tmp_path)])
    assert len(no_serve) == 1
    err = capsys.readouterr().err
    assert "other users can connect to 127.0.0.1" in err and "--uds" in err


@pytest.mark.parametrize("extra", [["--port", "8390"], ["--host", "127.0.0.1"]])
def test_uds_cannot_be_combined_with_tcp_options(sock_dir, no_serve, extra, capsys):
    with pytest.raises(SystemExit) as exc:
        server.main(["--uds", str(sock_dir / "v.sock"), *extra])
    assert exc.value.code == 2 and "cannot be combined" in capsys.readouterr().err
    assert no_serve == [] and not os.path.lexists(sock_dir / "v.sock")


def test_sigterm_while_the_app_is_created_removes_the_socket(sock_dir, tmp_path):
    """The SIGTERM handler is in place before the socket exists, not only while serving."""
    sock = sock_dir / "v.sock"
    code = (
        "import os, signal, sys\n"
        "from capx_trace_viewer import server\n"
        "def slow_create_app(**kwargs):\n"
        "    os.kill(os.getpid(), signal.SIGTERM)\n"
        "    raise AssertionError('SIGTERM did not stop startup')\n"
        "server.create_app = slow_create_app\n"
        "server.main(sys.argv[1:])\n"
    )
    result = subprocess.run([sys.executable, "-c", code, "--uds", str(sock), "--trace-root", str(tmp_path)],
                            cwd=REPO_ROOT, capture_output=True, text=True, timeout=60)
    assert result.returncode == 128 + signal.SIGTERM, result.stderr
    assert not os.path.lexists(sock)


def test_launcher_refuses_uds_with_port(sock_dir):
    result = subprocess.run(["bash", str(REPO_ROOT / "Start-Replay.sh"), "--uds", str(sock_dir / "v.sock"),
                             "--port", "8390"], capture_output=True, text=True, timeout=60)
    assert result.returncode == 2 and "--uds cannot be combined with --port" in result.stderr
    usage = subprocess.run(["bash", str(REPO_ROOT / "Start-Replay.sh"), "--help"], capture_output=True,
                           text=True, timeout=60).stdout
    assert "--uds PATH" in usage


def test_socket_is_removed_when_the_app_cannot_start(sock_dir, tmp_path, no_serve, monkeypatch, capsys):
    def unsupported(**_kwargs):
        raise UnsupportedBackendPlatform("unsupported for the test")

    monkeypatch.setattr(server, "create_app", unsupported)
    with pytest.raises(SystemExit) as exc:
        server.main(["--uds", str(sock_dir / "v.sock"), "--trace-root", str(tmp_path)])
    assert exc.value.code == 2 and "unsupported for the test" in capsys.readouterr().err
    assert not os.path.lexists(sock_dir / "v.sock")
