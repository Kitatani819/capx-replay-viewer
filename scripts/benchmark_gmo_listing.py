#!/usr/bin/env python3
"""Compare legacy per-file stats with the read-only GMO listing on synthetic data.

Run from the repository root:
    python scripts/benchmark_gmo_listing.py --frames 72000
    python scripts/benchmark_gmo_listing.py --frames 72000 --stat-latency-ms 0.1

The optional latency models metadata RPC cost; it is not a real GMO measurement.
All generated files are private temporary local data and are removed on exit.
"""
from __future__ import annotations

import argparse
import json
import shlex
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from capx_trace_viewer import gmo  # noqa: E402


class BenchmarkRunner:
    def __init__(self, latency_ms: float, legacy: bool = False):
        self.latency_ms = latency_ms
        self.legacy = legacy
        self.stats = 0

    def run(self, command, *, timeout, input=None):
        argv = shlex.split(command[-1])
        code = argv[2]
        if self.legacy:
            # Use the former exact stats implementation, retained in the lister
            # for auto-import's exact transfer manifest, for the old listing cost.
            code = code.replace("cheap, fingerprint, directories = cheap_stats(",
                                "cheap, fingerprint, directories = legacy_stats(")
            config_line = "config = json.loads(sys.stdin.read() if sys.argv[1] == '-' else sys.argv[1])"
            code = code.replace(config_line, """
def legacy_stats(directory, run, previous=None):
    count, size, newest, digest, files = stats(directory)
    return (count, size, newest, digest, False), digest, []
""" + config_line)
        # Route explicit DirEntry.stat calls through the counter too. Both are
        # lstat-equivalent here (regular entries and follow_symlinks=False).
        code = code.replace("entry.stat(follow_symlinks=False)", "os.lstat(entry.path)")
        preamble = f"""
import os, time
_benchmark_stats = 0
_original_stat, _original_lstat = os.stat, os.lstat
def _count_stats(fn):
    def wrapped(*args, **kwargs):
        global _benchmark_stats
        _benchmark_stats += 1
        if {self.latency_ms!r}:
            time.sleep({self.latency_ms!r} / 1000)
        return fn(*args, **kwargs)
    return wrapped
os.stat, os.lstat = _count_stats(_original_stat), _count_stats(_original_lstat)
"""
        code = code.replace("print(json.dumps({'episodes': out, 'evals': evals}, ensure_ascii=True))",
                            "print(json.dumps({'episodes': out, 'evals': evals, '_benchmark_stats': _benchmark_stats}, ensure_ascii=True))")
        proc = subprocess.run([sys.executable, "-c", preamble + code, *argv[3:]],
                              capture_output=True, text=True, timeout=max(timeout, 300), input=input)
        if proc.returncode == 0:
            self.stats = json.loads(proc.stdout)["_benchmark_stats"]
        return proc


def measure(runner, settings, repeats, previous=None, eval_only=False):
    times, calls = [], []
    listing = None
    for _ in range(repeats):
        start = time.perf_counter()
        listing = (gmo.list_remote_evals(runner, settings) if eval_only else
                   gmo.list_remote_episodes(runner, settings, previous=previous))
        times.append(time.perf_counter() - start)
        calls.append(runner.stats)
    return listing, statistics.median(times), int(statistics.median(calls))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frames", type=int, default=72000)
    parser.add_argument("--episodes", type=int, default=24)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--stat-latency-ms", type=float, default=0)
    args = parser.parse_args()
    if min(args.frames, args.episodes, args.repeats) <= 0 or args.stat_latency_ms < 0:
        parser.error("counts must be positive and latency must be nonnegative")
    with tempfile.TemporaryDirectory(prefix="capx-listing-benchmark-") as temp:
        root = Path(temp) / "traces"
        run = root / "synthetic_evaluation"
        run.mkdir(parents=True)
        (run / "run.json").write_text("{}")
        (run / "eval.json").write_text("{}")
        for index in range(args.episodes):
            episode = run / f"episode_{index}"
            frames = episode / "frames"
            frames.mkdir(parents=True)
            (episode / "episode.json").write_text('{"status":"ended"}')
            (episode / "events.jsonl").write_text('{"seq":1}\n')
            for frame in range(index, args.frames, args.episodes):
                (frames / f"{frame:08}.png").touch()
        settings = gmo.GmoSettings(host="benchmark", mine=(str(root),), shared_root="")
        _old, before, old_stats = measure(BenchmarkRunner(args.stat_latency_ms, legacy=True), settings, args.repeats)
        listing, after, new_stats = measure(BenchmarkRunner(args.stat_latency_ms), settings, args.repeats)
        _cached, cached, cached_stats = measure(BenchmarkRunner(args.stat_latency_ms), settings, args.repeats, previous=listing)
        _evals, eval_time, eval_stats = measure(BenchmarkRunner(args.stat_latency_ms), settings, args.repeats, eval_only=True)
        print(f"Synthetic local tree: {args.frames:,} frames / {args.episodes} episodes; median of {args.repeats}")
        print(f"Injected metadata latency: {args.stat_latency_ms:g} ms/call")
        print(f"Before (per-file stats): {before:.4f} s, {old_stats:,} stat/lstat calls")
        print(f"After (cheap cold listing): {after:.4f} s, {new_stats:,} stat/lstat calls ({before / after:.1f}x faster)")
        print(f"After (unchanged fingerprints): {cached:.4f} s, {cached_stats:,} stat/lstat calls")
        print(f"Eval records only: {eval_time:.4f} s, {eval_stats:,} stat/lstat calls")


if __name__ == "__main__":
    main()
