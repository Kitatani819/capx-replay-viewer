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
rtx=''
rtx_config=''
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
  --from-gmo           Prefetch mine via gmo SSH alias, show outputs/gmo/traces,
                       and enable the GMO API (config file or CAPX_GMO_HOST/TRACES)
  --rtx [CONFIG]       Add an RTX tab with its own connection settings and
                       outputs/rtx/traces. Default: rtx.json beside the default
                       gmo.json (independent of CAPX_GMO_CONFIG). With --from-gmo,
                       prefetch mine for both sites. Missing config skips RTX.
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
        --rtx)
            rtx=1
            if [[ $# -gt 1 && "$2" != -* ]]; then
                [[ -n "$2" ]] || { echo 'Missing config path for --rtx.' >&2; exit 2; }
                rtx_config="$2"
                shift 2
            else
                shift
            fi ;;
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
if [[ -n "$rtx" ]]; then
    if [[ -z "$rtx_config" ]]; then
        case "$(uname -s)" in
            Darwin) rtx_config="$HOME/Library/Application Support/capx-geniac-replay/rtx.json" ;;
            *) rtx_config="${XDG_CONFIG_HOME:-$HOME/.config}/capx-geniac-replay/rtx.json" ;;
        esac
    fi
    case "$rtx_config" in
        '~') rtx_config="$HOME" ;;
        '~/'*) rtx_config="$HOME/${rtx_config#\~/}" ;;
    esac
    case "$rtx_config" in /*) ;; *) rtx_config="$project_dir/$rtx_config" ;; esac
    if [[ ! -f "$rtx_config" ]]; then
        printf 'RTX config not found: %s. Starting without the RTX site.\n' "$rtx_config" >&2
        rtx_config=''
    fi
fi
exec bash "$project_dir/scripts/serve_replay.sh" "$port" "$trace_root" "$runner_root" "$python_bin" "$from_gmo" "$uds" "$rtx_config"
