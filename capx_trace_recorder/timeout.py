"""Distinguish the runner's trial alarm from file-system timeouts."""

import sys


def is_trial_alarm(exc: BaseException | None) -> bool:
    """The runner raises its alarm without an OS error number.

    ``socket.timeout`` is an alias of ``TimeoutError`` since Python 3.10,
    and ``asyncio.TimeoutError`` is an alias since Python 3.11. Instances
    without errno count as alarms too.

    CaP-X ``capx/envs/tasks/base.py:19-24`` defines ``TrialTimeout`` as a
    ``BaseException``; ``capx/envs/runner.py:283-289`` raises it from SIGALRM.
    Inspect the already-loaded module instead of importing simulator dependencies
    while the recorder starts. Comparing the actual class also avoids treating
    unrelated exceptions with the same name as trial alarms.
    """
    if isinstance(exc, TimeoutError) and exc.errno is None:
        return True
    module = sys.modules.get("capx.envs.tasks.base")
    trial_timeout = getattr(module, "TrialTimeout", None)
    return isinstance(trial_timeout, type) and isinstance(exc, trial_timeout)
