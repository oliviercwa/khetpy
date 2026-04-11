"""Profile ai_ab_v17 by playing N in-process self-play games.

Runs cProfile over many games of v17 vs v17, prints the top functions
by cumulative and tottime, and optionally saves a .prof file for
external visualization (snakeviz, py-spy, etc.).

Usage:
    python tools/profile_v17.py                     # 100 games, defaults
    python tools/profile_v17.py --games 10           # quick smoke test
    python tools/profile_v17.py --output profile.prof  # save raw profile

This bypasses worker.py / multiprocessing so cProfile sees the whole stack
in one process.  Ponder is disabled for clean single-threaded profiling.
"""
import argparse
import cProfile
import io
import os
import pstats
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

from game_v13 import init, do, terminal  # noqa: E402
from ai_ab_v17 import AB  # noqa: E402


def play_one_game(seed: int, max_moves: int = 50,
                  move_time: float = 0.18) -> tuple[int, int]:
    """Self-play one v17-vs-v17 game.  Returns (plies, total_nodes)."""
    s = init(seed)
    a1 = AB(1, t=move_time, ponder=False)
    a2 = AB(2, t=move_time, ponder=False)
    plies = 0
    while not terminal(s) and plies < max_moves:
        ai = a1 if s.turn == 1 else a2
        mv = ai.choose(s)
        if mv is None:
            break
        s = do(s, mv)
        plies += 1
    return plies, a1.total_nodes + a2.total_nodes


def run_profile(n_games: int = 100, max_moves: int = 50,
                move_time: float = 0.18,
                output: str | None = None,
                top_n: int = 40) -> None:
    print(f'=== cProfile: v17 self-play, {n_games} games, '
          f'up to {max_moves} plies @ {move_time}s/move ===')

    wall_start = time.perf_counter()
    prof = cProfile.Profile()
    prof.enable()

    total_plies = 0
    total_nodes = 0
    for i in range(n_games):
        plies, nodes = play_one_game(seed=i + 1, max_moves=max_moves,
                                     move_time=move_time)
        total_plies += plies
        total_nodes += nodes
        if (i + 1) % 10 == 0:
            elapsed = time.perf_counter() - wall_start
            print(f'  ... {i + 1}/{n_games} games done  '
                  f'({elapsed:.1f}s elapsed, {total_nodes:,} nodes)')

    prof.disable()
    wall_total = time.perf_counter() - wall_start

    print(f'\nCompleted {n_games} games: {total_plies} total plies, '
          f'{total_nodes:,} total nodes, {wall_total:.1f}s wall time.\n')

    # Top N by cumulative time.
    print(f'--- Top {top_n} by cumulative time ---')
    buf = io.StringIO()
    stats = pstats.Stats(prof, stream=buf).sort_stats('cumulative')
    stats.print_stats(top_n)
    print(buf.getvalue())

    # Top N by tottime.
    print(f'--- Top {top_n} by tottime (excluding callees) ---')
    buf = io.StringIO()
    stats = pstats.Stats(prof, stream=buf).sort_stats('tottime')
    stats.print_stats(top_n)
    print(buf.getvalue())

    # Save raw profile if requested.
    if output:
        prof.dump_stats(output)
        print(f'Raw profile saved to {output}')


def main():
    parser = argparse.ArgumentParser(
        description='Profile v17 AI over multiple self-play games.')
    parser.add_argument('--games', type=int, default=100,
                        help='Number of games to play (default: 100)')
    parser.add_argument('--moves', type=int, default=50,
                        help='Max plies per game (default: 50)')
    parser.add_argument('--time', type=float, default=0.18,
                        help='Move time budget in seconds (default: 0.18)')
    parser.add_argument('--output', type=str, default=None,
                        help='Save raw .prof file for snakeviz/py-spy')
    parser.add_argument('--top', type=int, default=40,
                        help='Number of top functions to show (default: 40)')
    args = parser.parse_args()
    run_profile(n_games=args.games, max_moves=args.moves,
                move_time=args.time, output=args.output, top_n=args.top)


if __name__ == '__main__':
    main()
