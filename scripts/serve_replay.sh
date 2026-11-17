#!/usr/bin/env bash
# Shared Linux/macOS/WSL backend; never substitute an unsafe file reader.
set -euo pipefail
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$project_dir"
port="${1:-8390}"
trace_root="${2:-$project_dir/demo/traces}"
runner_root="${3:-$project_dir/demo/runner}"
python_bin="${4:-}"
from_gmo="${5:-}"
if ! [[ "$port" =~ ^[0-9]{1,5}$ ]] || ((10#$port < 1 || 10#$port > 65535)); then
    echo 'Port must be a number from 1 to 65535.' >&2
    exit 2
fi
if [[ ! -f "$project_dir/web-ui/dist/index.html" ]]; then
    echo 'Build the frontend first: cd web-ui && npm ci && npm run build' >&2
    exit 1
fi
case "$trace_root" in /*) ;; *) trace_root="$project_dir/$trace_root" ;; esac
case "$runner_root" in /*) ;; *) runner_root="$project_dir/$runner_root" ;; esac
case "$(uname -s)" in
    Darwin) cache_base="${XDG_CACHE_HOME:-$HOME/Library/Caches}" ;;
    Linux) cache_base="${XDG_CACHE_HOME:-$HOME/.cache}" ;;
    *) echo 'Use Linux or macOS. On Windows, run Start-Replay.ps1 with WSL/Ubuntu.' >&2; exit 1 ;;
esac
runtime_dir="$cache_base/capx-geniac-replay"
uv_bin=''
if command -v uv >/dev/null 2>&1; then
    uv_bin="$(command -v uv)"
elif [[ -x "$runtime_dir/uv" ]]; then
    uv_bin="$runtime_dir/uv"
fi
supported_python() {
    "$1" -c 'import sys; sys.exit(not ((3, 10) <= sys.version_info[:2] < (3, 13)))' >/dev/null 2>&1
}
if [[ -n "$python_bin" ]]; then
    case "$python_bin" in
        /*) ;;
        */*) python_bin="$project_dir/$python_bin" ;;
        *) python_bin="$(command -v "$python_bin" || true)" ;;
    esac
    if [[ -z "$python_bin" ]] || ! supported_python "$python_bin"; then
        echo '--python must point to a working Python 3.10-3.12 environment.' >&2
        exit 1
    fi
    if ! "$python_bin" -c 'import fastapi, uvicorn, numpy, PIL, imageio, imageio_ffmpeg' >/dev/null 2>&1; then
        echo 'The selected Python environment is missing dependencies. Install this repository with pip install -e ".[dev]" in that environment.' >&2
        exit 1
    fi
else
    python_bin="$runtime_dir/venv/bin/python"
    if [[ ! -x "$python_bin" ]]; then
        mkdir -p "$runtime_dir"
        base_python=''
        for candidate in python3.12 python3.11 python3.10 python3; do
            if command -v "$candidate" >/dev/null 2>&1 && supported_python "$candidate"; then
                base_python="$(command -v "$candidate")"
                break
            fi
        done
        if [[ -n "$uv_bin" ]]; then
            # uv also works when a distro Python omits ensurepip/python3-venv.
            "$uv_bin" venv --python "${base_python:-3.12}" "$runtime_dir/venv"
        elif [[ -n "$base_python" ]]; then
            if ! "$base_python" -m venv "$runtime_dir/venv"; then
                echo 'Cannot create a virtual environment. Install the venv module for your Python, or use --python with a prepared environment.' >&2
                exit 1
            fi
        else
            echo 'Install Python 3.10-3.12 (with venv), or uv, then run this launcher again.' >&2
            exit 1
        fi
    fi
    if ! supported_python "$python_bin"; then
        echo 'The cached Python is unsupported. Use --python with a Python 3.10-3.12 environment.' >&2
        exit 1
    fi
    if ! "$python_bin" -c 'import fastapi, uvicorn, numpy, PIL, imageio, imageio_ffmpeg' >/dev/null 2>&1; then
        if [[ -n "$uv_bin" ]]; then
            "$uv_bin" pip install --python "$python_bin" -e '.[dev]'
        else
            "$python_bin" -m pip install -e '.[dev]'
        fi
    fi
fi
# Check the real filesystem capabilities before copying files or starting HTTP.
"$python_bin" -c 'from capx_trace_viewer.platform_support import require_supported_backend; require_supported_backend()'
if [[ -n "$from_gmo" ]]; then
    # Copies new or changed runs from GMO into the trace root; stops the launch on failure.
    "$python_bin" scripts/fetch_gmo.py --dest "$trace_root"
fi
printf 'Replay viewer: http://127.0.0.1:%s/traces\n' "$port"
exec "$python_bin" -m capx_trace_viewer.server --viewer-only --host 127.0.0.1 --port "$port" \
    --trace-root "$trace_root" --runner-root "$runner_root"
