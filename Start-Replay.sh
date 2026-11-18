#!/usr/bin/env bash
# Linux/macOS entry point. Compatible with macOS's bundled Bash 3.2.
set -euo pipefail
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
port=8390
port_set=''
uds=''
trace_root=''
runner_root=''
python_bin=''
from_gmo=''
usage() {
    cat <<'USAGE'
Usage: bash Start-Replay.sh [options]
  --port NUMBER        Local port (default: 8390)
  --uds PATH           Listen on this Unix domain socket instead of a port. Use it on
                       shared machines such as GMO compute nodes, where other users can
                       connect to 127.0.0.1. The directory must be yours with mode 700.
  --trace-root PATH    Parent of recorded runs/episodes
  --runner-root PATH   Parent of legacy recorded runs
  --python PATH        Use a prepared Python 3.10-3.12 environment
  --from-gmo           Prefetch configured mine recordings, show outputs/gmo/traces,
                       and enable the GMO API (config file or CAPX_GMO_HOST/TRACES)
  --help               Show this help

Build once with: cd web-ui && npm ci && npm run build
Without custom roots or --from-gmo, the bundled GMO recording in demo/ is shown.
Relative data/Python paths are resolved from this repository.
The server listens on 127.0.0.1 only (or only on the --uds socket). Stop it with Ctrl+C.
USAGE
}
while [[ $# -gt 0 ]]; do
    case "$1" in
        --help|-h) usage; exit 0 ;;
        --from-gmo) from_gmo=1; shift ;;
        --port|--uds|--trace-root|--runner-root|--python)
            [[ $# -ge 2 && -n "$2" ]] || { printf 'Missing value for %s\n' "$1" >&2; exit 2; }
            case "$1" in
                --port) port="$2"; port_set=1 ;;
                --uds) uds="$2" ;;
                --trace-root) trace_root="$2" ;;
                --runner-root) runner_root="$2" ;;
                --python) python_bin="$2" ;;
            esac
            shift 2 ;;
        *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
    esac
done
if [[ -n "$uds" && -n "$port_set" ]]; then
    echo '--uds cannot be combined with --port.' >&2
    exit 2
fi
if [[ -n "$from_gmo" ]]; then
    default_root="$project_dir/outputs/gmo"
else
    default_root="$project_dir/demo"
fi
trace_root="${trace_root:-$default_root/traces}"
runner_root="${runner_root:-$default_root/runner}"
exec bash "$project_dir/scripts/serve_replay.sh" "$port" "$trace_root" "$runner_root" "$python_bin" "$from_gmo" "$uds"
