#!/usr/bin/env bash
# Linux/macOS entry point. Compatible with macOS's bundled Bash 3.2.
set -euo pipefail
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
port=8390
trace_root="$project_dir/demo/traces"
runner_root="$project_dir/demo/runner"
python_bin=''
usage() {
    cat <<'USAGE'
Usage: bash Start-Replay.sh [options]
  --port NUMBER        Local port (default: 8390)
  --trace-root PATH    Parent of recorded runs/episodes
  --runner-root PATH   Parent of legacy recorded runs
  --python PATH        Use a prepared Python 3.10-3.12 environment
  --help               Show this help

Build once with: cd web-ui && npm ci && npm run build
Without custom roots, the bundled GMO recording in demo/ is shown.
Relative data/Python paths are resolved from this repository.
The server listens on 127.0.0.1 only. Stop it with Ctrl+C.
USAGE
}
while [[ $# -gt 0 ]]; do
    case "$1" in
        --help|-h) usage; exit 0 ;;
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
exec bash "$project_dir/scripts/serve_replay.sh" "$port" "$trace_root" "$runner_root" "$python_bin"
