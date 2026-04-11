# game_v13.py — compatibility shim. Real implementation lives in game.py.
# Previously a byte-identical copy of game.py; collapsed to one source of truth.
from game import (  # noqa: F401
    DIRS, VALS, PYR, P, S, SWAP_COOLDOWN, PYRAMID_RETURN_DELAY, TURN_LIMIT,
    inb, find, init, laser, moves, do, terminal, evalf, place_legal,
)
