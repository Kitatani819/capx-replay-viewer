#!/usr/bin/env bash
# Linux/WSL backend: retain the upstream descriptor-relative safe file reader.
set -euo pipefail
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"
port="${1:-8390}"
trace_root="${2:-$project_dir/outputs/geniac_demo/traces}"
runner_root="${3:-$project_dir/outputs/geniac_demo/runner}"
runtime_dir="${XDG_CACHE_HOME:-$HOME/.cache}/capx-geniac-replay"
if command -v uv >/dev/null 2>&1; then
    uv_bin="$(command -v uv)"
elif [[ -x "$runtime_dir/uv" ]]; then
    uv_bin="$runtime_dir/uv"
else
    echo 'Install uv inside Linux/WSL: https://docs.astral.sh/uv/getting-started/installation/' >&2
    exit 1
fi
if [[ ! -x "$runtime_dir/venv/bin/python" ]]; then
    "$uv_bin" venv --python 3.12 "$runtime_dir/venv"
fi
python_bin="$runtime_dir/venv/bin/python"
if ! "$python_bin" -c 'import fastapi, uvicorn, numpy, PIL, imageio' >/dev/null 2>&1; then
    "$uv_bin" pip install --python "$python_bin" -e '.[dev]'
fi
if [[ "$trace_root" == "$project_dir/outputs/geniac_demo/traces" && ! -d "$trace_root" ]]; then
    "$python_bin" scripts/make_replay_demo.py
fi
printf 'Replay viewer: http://127.0.0.1:%s/traces\n' "$port"
exec "$python_bin" -m capx_trace_viewer.server --viewer-only --host 127.0.0.1 --port "$port" \
    --trace-root "$trace_root" --runner-root "$runner_root"
