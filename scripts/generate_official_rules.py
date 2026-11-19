"""Refresh the small rule snapshot from a public competition checkout (PyYAML needed)."""
from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path


def generate(checkout: Path) -> dict:
    import yaml

    relative = 'taskpacks/original/pack.yaml'
    lines = (checkout / relative).read_text(encoding='utf-8').splitlines()
    pack = yaml.safe_load('\n'.join(lines))
    defaults = pack['limits']
    locations = {}
    task_id = None
    for number, line in enumerate(lines, 1):
        if line.startswith('- task_id: '):
            task_id = line.split(': ', 1)[1]
        elif line.startswith('  trial_steplimit:') and task_id:
            locations[task_id] = number
    default_line = next(n for n, line in enumerate(lines, 1)
                        if line.startswith('  trial_steplimit:'))
    commit = subprocess.check_output(['git', '-C', str(checkout), 'rev-parse', '--short=7', 'HEAD'],
                                     text=True).strip()
    return {
        'repository': 'matsuolab/geniac_prize_2026_code',
        'commit': commit,
        'source': relative,
        'trial_time_s_scope': 'job_budget_per_trial',
        'per_trial_time_limit_s': None,
        'default_trial_steplimit': defaults['trial_steplimit'],
        'trial_time_s': defaults['trial_time_s'],
        'tasks': {
            task['task_id']: {
                'trial_steplimit': task.get('trial_steplimit', defaults['trial_steplimit']),
                'trial_time_s': defaults['trial_time_s'],
                'source': f"{relative}:{locations.get(task['task_id'], default_line)}",
            }
            for task in pack['tasks']
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('checkout', type=Path)
    parser.add_argument('--output', type=Path,
                        default=Path(__file__).resolve().parents[1] / 'capx_trace_viewer/official_rules.json')
    args = parser.parse_args()
    rules = generate(args.checkout)
    # One row per task keeps the generated table readable and compact.
    prefix = json.dumps({key: value for key, value in rules.items() if key != 'tasks'}, indent=2)
    rows = [f'    {json.dumps(task)}: {json.dumps(rule, ensure_ascii=False)}'
            for task, rule in rules['tasks'].items()]
    args.output.write_text(prefix[:-2] + ',\n  "tasks": {\n' + ',\n'.join(rows) + '\n  }\n}\n',
                           encoding='utf-8')


if __name__ == '__main__':
    main()
