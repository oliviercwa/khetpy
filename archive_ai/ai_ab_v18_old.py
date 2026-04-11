"""v18 — v15 + killer-move heuristic + history heuristic.

Forked from ai_ab_v15.py (NOT from v17). Keeps v15's tuple-based hs(),
TT, negamax, pondering, and time management unchanged. The only search
changes are in move ordering:

  Order inside _s():
    1. TT move (unchanged from v15)
    2. Killer moves for this search ply (new)
    3. Remaining moves sorted by history heuristic score (new)

Both tables are reset at the start of every choose() for determinism
and to keep node counts comparable across runs. Killers are indexed by
*search ply* (distance from root), not by game ply — they represent
"moves that caused cutoffs at this level of the search tree in recent
iterations."
"""
import time
import threading
from game_v13 import do, terminal, evalf, inb, place_legal


class _Timeout(Exception):
    pass


def hs(s):
    """Stable state hash: board + turn + reserves + ply + win + cooldowns + pyramid queue.

    Includes ply because evalf has a -ply*2 term (score depends on ply).
    Cooldowns and the pyramid queue gate future legal moves, so they must
    also be part of the hash or two genuinely different states collide.
    """
    return hash((
        tuple(
            tuple((p.t, p.o, p.d) if p else None for p in row)
            for row in s.b
        ),
        s.turn, s.r[1], s.r[2], s.ply, s.win,
        s.cd[1]['sphinx'], s.cd[1]['pharaoh'],
        s.cd[2]['sphinx'], s.cd[2]['pharaoh'],
        tuple(sorted(s.pq)),
    ))


def ordered_moves(s):
    """Deterministic move generator matching the full rules in game.moves()."""
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
MAX_PLY = 32      # Upper bound on search ply for killer-move table sizing

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
        # Killer moves: 2 slots per search ply. Stores recent moves that
        # caused beta cutoffs at each ply; tried right after the TT move.
        self.killers = [[None, None] for _ in range(MAX_PLY)]
        # History heuristic: move -> score. Incremented by depth*depth
        # every time the move causes a cutoff. Used to sort the tail of
        # the move list after TT + killers.
        self.history = {}
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
        # Reset killers + history per move for determinism across games
        # and so node counts stay comparable to v15 (no cross-move bleed).
        for k in self.killers:
            k[0] = None
            k[1] = None
        self.history = {}

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
                    v = -self._s(do(s, a), depth - 1, -beta, -alpha, 1)
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
    def _s(self, state, depth, alpha, beta, ply):
        """Negamax + alpha-beta + TT + killers + history.

        `ply` is the current distance from the root (0 = root children).
        Returns score from state.turn's POV.
        """
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

        # ---- Move ordering: TT move, then killers, then history-sorted rest ----
        # Reorder in-place on `acts`. Cheap for MOVE_CAP=24.
        if ply < MAX_PLY:
            k1, k2 = self.killers[ply]
        else:
            k1 = k2 = None
        ordered = []
        remaining = acts
        if tt_move is not None and tt_move in remaining:
            ordered.append(tt_move)
            remaining = [m for m in remaining if m != tt_move]
        if k1 is not None and k1 != tt_move and k1 in remaining:
            ordered.append(k1)
            remaining = [m for m in remaining if m != k1]
        if k2 is not None and k2 != tt_move and k2 != k1 and k2 in remaining:
            ordered.append(k2)
            remaining = [m for m in remaining if m != k2]
        if remaining:
            hist = self.history
            # Sort descending by history score (default 0 for unseen moves).
            remaining.sort(key=lambda m: hist.get(m, 0), reverse=True)
            ordered.extend(remaining)
        acts = ordered[:MOVE_CAP]

        best_v = -10**9
        best_move = None
        for a in acts:
            v = -self._s(do(state, a), depth - 1, -beta, -alpha, ply + 1)
            if v > best_v:
                best_v = v
                best_move = a
            if best_v > alpha:
                alpha = best_v
            if alpha >= beta:
                # Beta cutoff: record killer + history credit.
                if ply < MAX_PLY:
                    slot = self.killers[ply]
                    if slot[0] != a:
                        slot[1] = slot[0]
                        slot[0] = a
                self.history[a] = self.history.get(a, 0) + depth * depth
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
                    v = -self._s(do(state, a), depth - 1, -beta, -alpha, 1)
                    if v > bv:
                        bv = v
                        bb = a
                    if v > alpha:
                        alpha = v
                if bb:
                    self._tt_store(key, depth, bv, EXACT, bb)
        except _Timeout:
            pass
