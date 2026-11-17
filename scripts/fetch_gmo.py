#!/usr/bin/env python3
"""Copy GMO trace runs into a local trace root (legacy command-line interface)."""
from __future__ import annotations

import sys
from pathlib import Path

# Also works when run directly from a checkout without an editable installation.
PROJECT_DIR = Path(__file__).resolve().parents[1]
if str(PROJECT_DIR) not in sys.path:
    sys.path.insert(0, str(PROJECT_DIR))

from capx_trace_viewer.gmo import (  # noqa: E402
    DEFAULT_DEST, DEFAULT_MAX_GB, FetchError, RemoteRun, check_runs, human,
    list_remote, main, parse_args, pending_bytes, rsync_run, ssh_command,
)

if __name__ == "__main__":
    sys.exit(main())
