#!/usr/bin/env bash
# Linux/macOS entry point. Compatible with macOS's bundled Bash 3.2.
set -euo pipefail
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
port=8390
trace_root=''
runner_root=''
python_bin=''
from_gmo=''
usage() {
    cat <<'USAGE'
Usage: bash Start-Replay.sh [options]
  --port NUMBER        Local port (default: 8390)
  --trace-root PATH    Parent of recorded runs/episodes
  --runner-root PATH   Parent of legacy recorded runs
  --python PATH        Use a prepared Python 3.10-3.12 environment
  --from-gmo           Copy new recordings from GMO first (scripts/fetch_gmo.py,
                       settings in CAPX_GMO_HOST, CAPX_GMO_TRACES, CAPX_GMO_SSH)
                       and show outputs/gmo/traces
  --help               Show this help

Build once with: cd web-ui && npm ci && npm run build
Without custom roots or --from-gmo, the bundled GMO recording in demo/ is shown.
Relative data/Python paths are resolved from this repository.
The server listens on 127.0.0.1 only. Stop it with Ctrl+C.
USAGE
}
while [[ $# -gt 0 ]]; do
    case "$1" in
        --help|-h) usage; exit 0 ;;
        --from-gmo) from_gmo=1; shift ;;
        --port|--trace-root|--runner-root|--python)
            [[ $# -ge 2 && -n "$2" ]] || { printf 'Missing value for %s\n' "$1" >&2; exit 2; }
            case "$1" in
                --port) port="$2" ;;
                --trace-root) trace_root="$2" ;;
                --runner-root) runner_root="$2" ;;
                --python) python_bin="$2" ;;
            esac
            shift 2 ;;
        *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
    esac
done
if [[ -n "$from_gmo" ]]; then
    default_root="$project_dir/outputs/gmo"
else
    default_root="$project_dir/demo"
fi
trace_root="${trace_root:-$default_root/traces}"
runner_root="${runner_root:-$default_root/runner}"
exec bash "$project_dir/scripts/serve_replay.sh" "$port" "$trace_root" "$runner_root" "$python_bin" "$from_gmo"
