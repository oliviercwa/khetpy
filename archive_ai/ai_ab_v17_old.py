import time
import threading
import random as _rand
from game_v13 import do, terminal, evalf, inb, place_legal


class _Timeout(Exception):
    pass


# ---- Zobrist hashing ----
# Pre-computed 64-bit random keys for every (square, piece-state) pair, plus
# side-to-move, reserves, ply, and win. hs() XORs the keys for occupied
# squares — a single dict lookup per piece, with no intermediate tuples —
# which is substantially cheaper than the v15 nested tuple-comprehension
# hash. Seeded deterministically so TT keys are stable across runs.
_PIECE_TYPES = ('pharaoh', 'sphinx', 'scarab', 'anubis', 'pyramid')
_zr = _rand.Random(0xC0FFEE)
_Z_PIECE: dict = {}
for _r in range(10):
    for _c in range(10):
        for _t in _PIECE_TYPES:
            for _o in (1, 2):
                for _d in (0, 90, 180, 270):
                    _Z_PIECE[(_r, _c, _t, _o, _d)] = _zr.getrandbits(64)
_Z_TURN = _zr.getrandbits(64)
_Z_RESERVE = {(pl, n): _zr.getrandbits(64) for pl in (1, 2) for n in range(16)}
_Z_PLY = [_zr.getrandbits(64) for _ in range(128)]
_Z_WIN = {
    None: 0,
    0: _zr.getrandbits(64),
    1: _zr.getrandbits(64),
    2: _zr.getrandbits(64),
}
# Swap cooldowns: per (player, target) x cooldown value (0..9 inclusive).
_Z_CD = {
    (pl, tgt, n): _zr.getrandbits(64)
    for pl in (1, 2)
    for tgt in ('sphinx', 'pharaoh')
    for n in range(10)
}
# Pyramid return queue entries: (return_ply, owner). return_ply can be up
# to TURN_LIMIT + PYRAMID_RETURN_DELAY, owner in {1,2}.
_Z_PQ = {
    (rp, owner): _zr.getrandbits(64)
    for rp in range(128)
    for owner in (1, 2)
}
del _r, _c, _t, _o, _d, _zr


def hs(s):
    """Zobrist-style state hash: board + turn + reserves + ply + win
    + swap cooldowns + pyramid return queue.

    Ply is included because evalf has a -ply*2 term (score is ply-dependent),
    so TT entries must not collide across plies. Cooldowns and the pyramid
    queue gate future legal moves and future reserves, so they must also be
    part of the hash or two genuinely different states collide.
    """
    h = 0
    b = s.b
    for r in range(10):
        row = b[r]
        for c in range(10):
            p = row[c]
            if p is not None:
                h ^= _Z_PIECE[(r, c, p.t, p.o, p.d)]
    if s.turn == 2:
        h ^= _Z_TURN
    h ^= _Z_RESERVE[(1, s.r[1])]
    h ^= _Z_RESERVE[(2, s.r[2])]
    h ^= _Z_PLY[s.ply]
    h ^= _Z_WIN[s.win]
    cd = s.cd
    for pl in (1, 2):
        for tgt in ('sphinx', 'pharaoh'):
            n = cd[pl][tgt]
            if n:
                h ^= _Z_CD[(pl, tgt, n)]
    for rp, owner in s.pq:
        h ^= _Z_PQ[(rp, owner)]
    return h


def ordered_moves(s):
    """Deterministic move generator matching the full rules in game.moves().

    TT cache reuse depends on stable ordering — we cannot use the base
    moves() because it calls random.shuffle. Generates rotates, slides,
    placements (anywhere legal per place_legal), and swap actions when
    cooldowns allow.
    """
    pl = s.turn
    acts = []
    has_scarab = False
    has_own_sphinx = False
    has_own_pharaoh = False
    for r in range(10):
        for c in range(10):
            p = s.b[r][c]
            if not p or p.o != pl:
                continue
            if p.t == 'scarab':
                has_scarab = True
            elif p.t == 'sphinx':
                has_own_sphinx = True
            elif p.t == 'pharaoh':
                has_own_pharaoh = True
            if p.t != 'pharaoh':
                acts.append(('r', r, c, 1))
                acts.append(('r', r, c, -1))
            if p.t in ('anubis', 'pyramid', 'scarab'):
                for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                    nr, nc = r + dr, c + dc
                    if inb(nr, nc) and not s.b[nr][nc]:
                        acts.append(('m', r, c, nr, nc))
    if s.r[pl] > 0:
        for r in range(10):
            for c in range(10):
                if place_legal(s, pl, r, c):
                    for d in (0, 90, 180, 270):
                        acts.append(('p', r, c, d))
    if has_scarab:
        if has_own_sphinx and s.cd[pl]['sphinx'] == 0:
            acts.append(('s', 'sphinx'))
        if has_own_pharaoh and s.cd[pl]['pharaoh'] == 0:
            acts.append(('s', 'pharaoh'))
    return acts


TT_MAX = 500_000  # Hard cap — clear when exceeded (simple replacement policy)
MOVE_CAP = 24     # Match v13's cap for comparable branching factor

# TT flags (negamax fail-soft)
EXACT = 0
LOWER = 1  # fail-high: value is a lower bound (true score >= v)
UPPER = 2  # fail-low:  value is an upper bound (true score <= v)


class AB:
    def __init__(self, pl, t=0.18, ponder=False):
        self.pl = pl
        self.t = t
        self.nodes = 0
        self.total_nodes = 0
        self.last_depth = 0  # Max ID depth completed during the last choose()
        self.deadline = None
        self.tt = {}
        self.ponder_enabled = ponder
        self.stop_flag = threading.Event()
        self.ponder_thread = None

    # ---- Public API ----
    def choose(self, s):
        # Start the clock BEFORE stop_ponder so the deadline accounts for
        # the time it takes the ponder thread to notice the stop flag and
        # release the GIL (can be 10-30ms with an active ponder thread).
        start = time.perf_counter()
        # Tighter margin when pondering: stop-overhead + in-process GIL
        # scheduling between main and ponder thread add noise.
        margin = 0.80 if self.ponder_enabled else 0.90
        self.stop_ponder()
        self.deadline = start + self.t * margin
        self.nodes = 0
        self.last_depth = 0

        acts = ordered_moves(s)
        # Immediate win
        for a in acts:
            if do(s, a).win == self.pl:
                self.total_nodes += 1
                return a
        if not acts:
            return None

        # TT move ordering at root
        root_key = hs(s)
        tt_entry = self.tt.get(root_key)
        if tt_entry:
            mv = tt_entry[3]
            if mv and mv in acts:
                acts.remove(mv)
                acts.insert(0, mv)
        acts = acts[:MOVE_CAP]
        best = acts[0]

        # Iterative deepening
        for depth in range(1, 9):
            if time.perf_counter() > self.deadline:
                break
            try:
                bv = -10**9
                bb = None
                alpha = -10**9
                beta = 10**9
                for a in acts:
                    v = -self._s(do(s, a), depth - 1, -beta, -alpha)
                    if v > bv:
                        bv = v
                        bb = a
                    if v > alpha:
                        alpha = v
            except _Timeout:
                break
            if bb:
                best = bb
                self.last_depth = depth
                # Reorder root for next iteration
                acts.remove(best)
                acts.insert(0, best)
                # Store root in TT
                self._tt_store(root_key, depth, bv, EXACT, best)
            if bv > 40000:
                break

        self.total_nodes += self.nodes

        # Ponder from the state after our chosen move
        if self.ponder_enabled:
            ns = do(s, best)
            if not terminal(ns):
                self._start_ponder(ns)

        return best

    def stop_ponder(self):
        """Stop any running ponder thread (called at start of each choose())."""
        if self.ponder_thread and self.ponder_thread.is_alive():
            self.stop_flag.set()
            self.ponder_thread.join()
        self.ponder_thread = None
        self.stop_flag.clear()
        self.deadline = None

    # ---- Internal ----
    def _s(self, state, depth, alpha, beta):
        """Negamax + alpha-beta + TT, returning score from state.turn's POV."""
        self.nodes += 1
        if (self.nodes & 63) == 0:
            if self.stop_flag.is_set():
                raise _Timeout
            if self.deadline is not None and time.perf_counter() > self.deadline:
                raise _Timeout

        if terminal(state) or depth == 0:
            return evalf(state, state.turn)

        orig_alpha = alpha
        key = hs(state)
        tt_entry = self.tt.get(key)
        tt_move = None
        if tt_entry:
            d, v, flag, mv = tt_entry
            if d >= depth:
                if flag == EXACT:
                    return v
                if flag == LOWER and v >= beta:
                    return v
                if flag == UPPER and v <= alpha:
                    return v
            tt_move = mv

        acts = ordered_moves(state)
        if not acts:
            return evalf(state, state.turn)
        if tt_move and tt_move in acts:
            acts.remove(tt_move)
            acts.insert(0, tt_move)
        acts = acts[:MOVE_CAP]

        best_v = -10**9
        best_move = None
        for a in acts:
            v = -self._s(do(state, a), depth - 1, -beta, -alpha)
            if v > best_v:
                best_v = v
                best_move = a
            if best_v > alpha:
                alpha = best_v
            if alpha >= beta:
                break

        if best_v <= orig_alpha:
            flag = UPPER
        elif best_v >= beta:
            flag = LOWER
        else:
            flag = EXACT
        self._tt_store(key, depth, best_v, flag, best_move)
        return best_v

    def _tt_store(self, key, depth, value, flag, move):
        prev = self.tt.get(key)
        if prev is None or prev[0] <= depth:
            if len(self.tt) >= TT_MAX:
                self.tt.clear()
            self.tt[key] = (depth, value, flag, move)

    # ---- Pondering ----
    def _start_ponder(self, state):
        self.stop_flag.clear()
        self.deadline = None
        t = threading.Thread(
            target=self._ponder_loop, args=(state,), daemon=True
        )
        self.ponder_thread = t
        t.start()

    def _ponder_loop(self, state):
        """Iterative-deepening search with no deadline; stops on flag set."""
        try:
            for depth in range(1, 9):
                if self.stop_flag.is_set():
                    return
                acts = ordered_moves(state)
                key = hs(state)
                tt_entry = self.tt.get(key)
                if tt_entry and tt_entry[3] and tt_entry[3] in acts:
                    mv = tt_entry[3]
                    acts.remove(mv)
                    acts.insert(0, mv)
                acts = acts[:MOVE_CAP]
                if not acts:
                    return
                bv = -10**9
                bb = None
                alpha = -10**9
                beta = 10**9
                for a in acts:
                    v = -self._s(do(state, a), depth - 1, -beta, -alpha)
                    if v > bv:
                        bv = v
                        bb = a
                    if v > alpha:
                        alpha = v
                if bb:
                    self._tt_store(key, depth, bv, EXACT, bb)
        except _Timeout:
            pass
