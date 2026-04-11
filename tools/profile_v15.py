"""Profile ai_ab_v15 by playing a single in-process self-play game.

Runs cProfile over ~50 plies of v15 vs v15 at the usual 0.18s/move budget,
prints the top 30 functions by cumulative and tottime, then does a direct
micro-benchmark comparing v15's and v17's hs() (hash) functions.

Usage:
    python tools/profile_v15.py

This bypasses worker.py / multiprocessing so cProfile sees the whole stack
in one process. Results are representative of per-AI work only (no IPC).
"""
import cProfile
import io
import os
import pstats
import sys
import timeit

# Allow running from repo root or tools/
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from game_v13 import init, do, terminal  # noqa: E402
from ai_ab_v15 import AB as AB15, hs as hs15  # noqa: E402
from archive_ai.ai_ab_v17_old import hs as hs17  # noqa: E402


def play_one_game(max_moves: int = 50, move_time: float = 0.18,
                  seed: int = 1) -> tuple[int, int]:
    """Self-play one v15-vs-v15 game. Returns (plies, total_nodes)."""
    s = init(seed)
    a1 = AB15(1, t=move_time)
    a2 = AB15(2, t=move_time)
    plies = 0
    while not terminal(s) and plies < max_moves:
        ai = a1 if s.turn == 1 else a2
        mv = ai.choose(s)
        if mv is None:
            break
        s = do(s, mv)
        plies += 1
    return plies, a1.total_nodes + a2.total_nodes


def run_profile() -> None:
    print('=== cProfile: v15 self-play, up to 50 plies @ 0.18s/move ===')
    prof = cProfile.Profile()
    prof.enable()
    plies, total_nodes = play_one_game()
    prof.disable()

    print(f'Played {plies} plies, {total_nodes:,} total nodes searched.\n')

    # Top 30 by cumulative time (shows the call-chain hot path).
    print('--- Top 30 by cumulative time ---')
    buf = io.StringIO()
    stats = pstats.Stats(prof, stream=buf).sort_stats('cumulative')
    stats.print_stats(30)
    print(buf.getvalue())

    # Top 30 by tottime (shows functions that spend the most time
    # executing their own code, excluding callees — the real hotspots).
    print('--- Top 30 by tottime (excluding callees) ---')
    buf = io.StringIO()
    stats = pstats.Stats(prof, stream=buf).sort_stats('tottime')
    stats.print_stats(30)
    print(buf.getvalue())


def run_hash_benchmark() -> None:
    print('=== Hash microbenchmark (hs) ===')
    s = init(1)
    # Warm up — first call pays module import + dict sizing.
    hs15(s); hs17(s)
    n = 200_000
    t15 = timeit.timeit(lambda: hs15(s), number=n)
    t17 = timeit.timeit(lambda: hs17(s), number=n)
    print(f'v15 hs: {t15*1e6/n:.3f} us/call  ({n:,} iters, total {t15:.3f}s)')
    print(f'v17 hs: {t17*1e6/n:.3f} us/call  ({n:,} iters, total {t17:.3f}s)')
    ratio = t15 / t17 if t17 > 0 else float('inf')
    print(f'v15/v17 ratio: {ratio:.2f}x  '
          f'({"v17 faster" if ratio > 1 else "v15 faster"})')


if __name__ == '__main__':
    run_profile()
    run_hash_benchmark()
