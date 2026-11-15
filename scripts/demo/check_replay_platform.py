"""Start a local viewer, run the browser acceptance flow, and always stop it.

CI uses a generated synthetic fixture only. The public launcher receives the
same Python interpreter as this script, independent of the host Python PATH.
"""
from __future__ import annotations

import argparse
import json
import platform
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

from check_replay_layout import check


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixture', type=Path, default=Path('outputs/ci-demo'))
    parser.add_argument('--out', type=Path, default=Path('outputs/ci-checks'))
    parser.add_argument('--port', type=int, default=8390)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    fixture = args.fixture.resolve()
    output = args.out.resolve()
    output.mkdir(parents=True, exist_ok=True)
    (output / 'platform.json').write_text(json.dumps({
        'system': platform.system(), 'release': platform.release(),
        'machine': platform.machine(), 'python': platform.python_version(),
    }, indent=2), encoding='utf-8')
    base_url = f'http://127.0.0.1:{args.port}'
    command = ['bash', str(root / 'Start-Replay.sh'), '--python', sys.executable,
               '--port', str(args.port),
               '--trace-root', str(fixture / 'traces'),
               '--runner-root', str(fixture / 'runner')]
    with (output / 'server.log').open('w', encoding='utf-8') as log:
        server = subprocess.Popen(command, cwd=root, stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 30
            while True:
                if server.poll() is not None:
                    raise RuntimeError(f'Viewer exited with {server.returncode}; see {output / "server.log"}')
                try:
                    with urlopen(base_url + '/api/traces/config', timeout=1) as response:
                        config = json.load(response)
                    if config.get('viewer_only') and Path(config['trace_root']).resolve() == fixture / 'traces':
                        break
                except (URLError, TimeoutError, OSError):
                    pass
                if time.monotonic() >= deadline:
                    raise TimeoutError(f'Viewer did not become ready; see {output / "server.log"}')
                time.sleep(.2)
            check(base_url, fixture, output)
        finally:
            server.terminate()
            try:
                server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=5)


if __name__ == '__main__':
    main()
