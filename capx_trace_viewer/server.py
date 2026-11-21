"""FastAPI server for local CaP-X traces and optional GMO imports."""
from __future__ import annotations

import argparse
import os
import re
import shlex
import signal
import socket
import stat
import sys
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Sequence

import uvicorn
from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from capx_trace_viewer.trace_api import create_trace_router, trace_access_gate
from capx_trace_viewer.eval_api import create_eval_router
from capx_trace_viewer.platform_support import UnsupportedBackendPlatform, require_supported_backend

_CWD = Path.cwd()
_DEFAULT_FRONTEND_DIST = Path(__file__).resolve().parents[1] / 'web-ui' / 'dist'
_DEFAULT_RUNNER_ROOTS = ('outputs/runner',)
_VIEWER_ONLY_MISSING = ('api/', 'ws/', 'viser-proxy')


def default_trace_root() -> Path:
    raw = os.environ.get('CAPX_TRACE_DIR', '').strip()
    if not raw:
        return _CWD / 'outputs' / 'traces'
    path = Path(os.path.expanduser(raw))
    return Path(os.path.abspath(_CWD / path))


def _package_version() -> str:
    try:
        return version('capx-trace-viewer')
    except PackageNotFoundError:
        return '0.0.0'


def _cli_path(value: str | Path) -> Path:
    return Path(os.path.abspath(os.path.expanduser(str(value))))


@dataclass(frozen=True)
class Site:
    """One additional remote connection and its local records."""

    name: str
    label: str
    config_path: Path
    trace_root: Path

    def __post_init__(self) -> None:
        if re.fullmatch(r'[a-z0-9-]{1,32}', self.name) is None:
            raise ValueError('site names must match [a-z0-9-]{1,32}')
        if not self.label.strip():
            raise ValueError('site labels must not be empty')
        object.__setattr__(self, 'config_path', _cli_path(self.config_path))
        object.__setattr__(self, 'trace_root', _cli_path(self.trace_root))


def parse_site(value: str) -> Site:
    """Parse ``--site NAME=LABEL,CONFIG,TRACE_ROOT`` without changing global settings."""
    try:
        name, rest = value.split('=', 1)
        label, config, root = rest.split(',', 2)
        if not config.strip() or not root.strip():
            raise ValueError('config and trace root must not be empty')
        return Site(name=name, label=label, config_path=Path(config), trace_root=Path(root))
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            f'invalid site {value!r}: expected NAME=LABEL,CONFIG,TRACE_ROOT; {exc}'
        ) from None


def _validate_sites(sites: Sequence[Site]) -> None:
    names = {'b300'}
    for site in sites:
        if site.name in names:
            raise ValueError(f'duplicate site name: {site.name}')
        names.add(site.name)


def _safe_dist_file(dist_root: Path, path: str) -> Path | None:
    if not path:
        return None
    try:
        candidate = (dist_root / path).resolve()
        if not candidate.is_relative_to(dist_root):
            return None
        st = candidate.stat()
    except (OSError, RuntimeError, ValueError):
        return None
    return candidate if stat.S_ISREG(st.st_mode) else None


def _frontend_file_response(path: Path) -> FileResponse:
    headers = {'Cache-Control': 'no-store'} if path.suffix.lower() == '.html' else None
    return FileResponse(path, headers=headers)


class SocketPathError(Exception):
    """The ``--uds`` path cannot be used without letting other users connect."""


def bind_private_unix_socket(path: str | Path) -> tuple[socket.socket, Path]:
    """Bind a Unix domain socket that only this user can connect to.

    On a shared machine (a GMO compute node runs other teams' jobs), any local user can
    connect to a TCP port on 127.0.0.1, so ``--uds`` listens on a socket file instead. Its
    directory must already exist, be owned by this user and have mode 700 (a setgid bit
    inherited from ``$HOME`` is fine), and the socket is created with mode 0600. An
    existing file at the path is never replaced: on a ``$HOME`` shared between nodes it
    may be the socket of a viewer on another node.

    Linux POSIX ACLs are covered by the mode check: with an ACL, the group bits of the
    mode are the ACL mask, so a directory of mode 700 grants named users nothing. A macOS
    ACL that the owner adds to the directory is not checked.

    Returns the listening socket and its absolute path.
    """
    sock_path = _cli_path(path)
    parent = sock_path.parent
    quoted = shlex.quote(str(parent))
    try:
        st = os.stat(parent)
    except FileNotFoundError:
        raise SocketPathError(f'The socket directory {parent} does not exist. '
                              f'Create it with: mkdir -p {quoted} && chmod 700 {quoted}') from None
    except OSError as exc:
        raise SocketPathError(f'Cannot check the socket directory {parent}: {exc.strerror}') from None
    if not stat.S_ISDIR(st.st_mode):
        raise SocketPathError(f'{parent} is not a directory')
    if st.st_uid != os.geteuid():
        raise SocketPathError(f'The socket directory {parent} must be owned by you '
                              f'(uid {os.geteuid()}), not uid {st.st_uid}')
    mode = st.st_mode & 0o777
    if mode != 0o700:
        raise SocketPathError(f'The socket directory {parent} has mode {mode:03o}; it must be 700 '
                              f'so that only you can reach the socket. Run: chmod 700 {quoted}')
    if os.path.lexists(sock_path):
        raise SocketPathError(f'{sock_path} already exists. If no viewer is using it, remove it '
                              f'(rm {shlex.quote(str(sock_path))}) or choose another name')
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    old_umask = os.umask(0o177)  # the socket file is 0600 from the moment it exists
    try:
        sock.bind(str(sock_path))
    except OSError as exc:
        sock.close()
        raise SocketPathError(f'Cannot listen on {sock_path}: {exc.strerror or exc}') from None
    finally:
        os.umask(old_umask)
    try:
        os.chmod(sock_path, 0o600)
        sock.listen(2048)  # connections made before the app starts wait instead of failing
    except OSError as exc:
        sock.close()
        _remove_socket_file(sock_path)
        raise SocketPathError(f'Cannot listen on {sock_path}: {exc.strerror}') from None
    return sock, sock_path


def _remove_socket_file(path: Path) -> None:
    try:
        if stat.S_ISSOCK(os.lstat(path).st_mode):
            os.unlink(path)
    except OSError:
        pass


def create_app(*, viewer_only: bool = True, trace_root: str | Path | None = None,
               expose_traces: bool = False, runner_roots: Sequence[str | Path] | None = None,
               frontend_dist: str | Path | None = None, gmo: bool = False,
               unix_socket: bool = False, sites: Sequence[Site] = ()) -> FastAPI:
    """``unix_socket``: the app is served on a ``--uds`` socket, whose requests carry no
    client address; the trace and GMO APIs then accept requests without one."""
    if not viewer_only:
        raise ValueError('The standalone server supports viewer-only mode')
    _validate_sites(sites)
    require_supported_backend()
    app = FastAPI(title='CaP-X Trace Viewer', version=_package_version(),
                  docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(CORSMiddleware,
                       allow_origins=['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3000'],
                       allow_credentials=True, allow_methods=['*'], allow_headers=['*'])
    trace_dir = _cli_path(trace_root) if trace_root is not None else default_trace_root()
    roots = [_cli_path(r) for r in runner_roots] if runner_roots else [_CWD / r for r in _DEFAULT_RUNNER_ROOTS]
    dist = _cli_path(frontend_dist) if frontend_dist is not None else _DEFAULT_FRONTEND_DIST
    app.state.viewer_only = True
    app.state.trace_root = trace_dir
    app.state.gmo_services = {}

    async def gmo_not_found(path: str = ''):
        return JSONResponse({'detail': 'Not Found'}, status_code=404)

    def mount_site(name: str, root: Path, prefix: str, *, enabled: bool,
                   config_path: Path | None = None, runner_paths: Sequence[Path] = ()) -> None:
        app.include_router(create_trace_router(root, viewer_only=True, expose=expose_traces,
                                               runner_roots=runner_paths, unix_socket=unix_socket,
                                               prefix=f'{prefix}/traces'))
        service = None
        if enabled:
            from capx_trace_viewer.gmo_api import GmoService, create_gmo_router
            service = GmoService(root, config_path=config_path)
            app.state.gmo_services[name] = service
            if name == 'b300':
                app.state.gmo_service = service  # compatibility with single-site embedders
            app.include_router(create_gmo_router(service, unix_socket=unix_socket, prefix=f'{prefix}/gmo'))
            app.router.add_event_handler('startup', service.start_auto)
            app.router.add_event_handler('shutdown', service.close)
        app.include_router(create_eval_router(root, expose=expose_traces, gmo_service=service,
                                              unix_socket=unix_socket, prefix=f'{prefix}/evals'))
        for suffix in ('', '/{path:path}'):
            app.add_api_route(f'{prefix}/gmo{suffix}', gmo_not_found,
                              methods=['GET', 'PUT', 'POST', 'DELETE', 'PATCH'])

    mount_site('b300', trace_dir, '/api', enabled=gmo, runner_paths=roots)
    for site in sites:
        mount_site(site.name, site.trace_root, f'/api/sites/{site.name}', enabled=True,
                   config_path=site.config_path, runner_paths=[site.trace_root.parent / 'runner'])
    site_info = [{'name': 'b300', 'label': 'B300', 'primary': True}]
    site_info.extend({'name': site.name, 'label': site.label, 'primary': False} for site in sites)

    @app.get('/api/sites', dependencies=[Depends(trace_access_gate(expose=expose_traces, unix_socket=unix_socket))])
    async def list_sites():
        return JSONResponse(site_info)

    @app.get('/')
    async def redirect_to_traces():
        return RedirectResponse('/traces', status_code=307)

    if not (dist / 'index.html').is_file():
        @app.get('/traces')
        async def frontend_missing():
            return Response('Frontend dist is missing or has no index.html. Build the frontend (cd web-ui && npm ci && npm run build) or pass --frontend-dist. The trace API is served at /api/traces.\n',
                            status_code=503, media_type='text/plain')
        @app.get('/{path:path}')
        async def frontend_missing_file(path: str):
            if path.startswith(_VIEWER_ONLY_MISSING):
                return JSONResponse({'detail': 'not available in --viewer-only mode'}, status_code=404)
            return Response('Frontend dist is missing or has no index.html. Build the frontend or pass --frontend-dist.\n',
                            status_code=503, media_type='text/plain')
        return app

    if (dist / 'assets').is_dir():
        app.mount('/assets', StaticFiles(directory=dist / 'assets'), name='assets')
    dist_root = dist.resolve()

    @app.get('/{path:path}')
    async def serve_viewer_routes(path: str):
        if path.startswith(_VIEWER_ONLY_MISSING):
            return JSONResponse({'detail': 'not available in --viewer-only mode'}, status_code=404)
        file_path = _safe_dist_file(dist_root, path)
        return _frontend_file_response(file_path or dist / 'index.html')

    return app


def _exit_on_sigterm(signum, frame) -> None:
    raise SystemExit(128 + signum)


def _serve_unix_socket(app: FastAPI, sock: socket.socket, sock_path: Path) -> None:
    """Serve on a socket bound by ``bind_private_unix_socket``. uvicorn's own ``uds=``
    would make the file 0666, so it is not used. ``proxy_headers`` is off: no address from
    ``X-Forwarded-For`` replaces the missing peer address."""
    print(f'Replay viewer: unix socket {sock_path} (mode 600). Forward it from your PC with '
          f'ssh -N -L 127.0.0.1:18390:{sock_path} ... and open http://127.0.0.1:18390/traces',
          file=sys.stderr)
    uvicorn.Server(uvicorn.Config(app, proxy_headers=False)).run(sockets=[sock])


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description='CaP-X read-only trace viewer')
    parser.add_argument('--viewer-only', action='store_true', help='Accepted for compatibility; viewer-only is always on')
    parser.add_argument('--trace-root')
    parser.add_argument('--runner-root', nargs='+', action='append', default=[])
    parser.add_argument('--host', help='TCP address to listen on (default: 127.0.0.1)')
    parser.add_argument('--port', type=int, help='TCP port to listen on (default: 8290)')
    parser.add_argument('--uds', metavar='PATH',
                        help='Listen on this Unix domain socket instead of TCP (mode 600). Its directory must be '
                             'yours with mode 700. Use this on shared machines such as GMO compute nodes, where '
                             'other users can connect to 127.0.0.1')
    parser.add_argument('--expose-traces', action='store_true')
    parser.add_argument('--gmo', action='store_true', help='Enable the loopback-only GMO import API')
    parser.add_argument('--site', type=parse_site, action='append', default=[], metavar='NAME=LABEL,CONFIG,TRACE_ROOT',
                        help='Add a remote site with its own settings and local traces (repeatable)')
    parser.add_argument('--site-fields', nargs=4, action='append', default=[],
                        metavar=('NAME', 'LABEL', 'CONFIG', 'TRACE_ROOT'),
                        help='Add a remote site using separate fields, including paths containing commas (repeatable)')
    parser.add_argument('--frontend-dist', help='Directory containing the built frontend index.html and assets')
    args = parser.parse_args(argv)
    try:
        args.site.extend(Site(name, label, Path(config), Path(root))
                         for name, label, config, root in args.site_fields)
        _validate_sites(args.site)
    except ValueError as exc:
        parser.error(str(exc))
    if args.uds is not None and (args.host is not None or args.port is not None):
        parser.error('--uds cannot be combined with --host or --port')
    dist = _cli_path(args.frontend_dist) if args.frontend_dist is not None else _DEFAULT_FRONTEND_DIST
    roots = [root for group in args.runner_root for root in group]
    sock = sock_path = previous_sigterm = None
    if args.uds is not None:
        # SIGTERM (Slurm ends jobs with it) exits through SystemExit from here on, so the
        # finally below removes the socket even while the app is still being created.
        # uvicorn >= 0.29 restores this handler and re-raises SIGTERM after a graceful
        # shutdown; older versions return normally.
        try:
            previous_sigterm = signal.signal(signal.SIGTERM, _exit_on_sigterm)
        except ValueError:  # not the main thread; uvicorn does not handle signals there either
            pass
    try:
        if args.uds is not None:
            try:
                sock, sock_path = bind_private_unix_socket(args.uds)
            except SocketPathError as exc:
                parser.error(str(exc))
        try:
            app = create_app(trace_root=args.trace_root, runner_roots=roots or None,
                             expose_traces=args.expose_traces, frontend_dist=args.frontend_dist,
                             gmo=args.gmo, unix_socket=sock is not None, sites=args.site)
        except UnsupportedBackendPlatform as exc:
            parser.error(str(exc))
        if args.gmo:
            from capx_trace_viewer.gmo import prefetch_mine
            # Connection problems are reported in one line; local records stay
            # available even when GMO cannot be reached at startup.
            for service in app.state.gmo_services.values():
                prefetch_mine(service.dest, config_path=service.config_path)
        if not (dist / 'index.html').is_file():
            print(f'Frontend dist is missing or has no index.html: {dist}', file=sys.stderr)
        if sock is not None:
            try:
                _serve_unix_socket(app, sock, sock_path)
            except KeyboardInterrupt:
                pass
            return
        if os.environ.get('SLURM_JOB_ID'):
            print('Warning: this is a Slurm job. On a shared compute node, other users can connect to '
                  '127.0.0.1 and read the traces; use --uds PATH (in a mode 700 directory) instead.',
                  file=sys.stderr)
        uvicorn.run(app, host='127.0.0.1' if args.host is None else args.host,
                    port=8290 if args.port is None else args.port)
    finally:
        if sock is not None:
            sock.close()
            _remove_socket_file(sock_path)
        if previous_sigterm is not None:
            signal.signal(signal.SIGTERM, previous_sigterm)


if __name__ == '__main__':
    main()
