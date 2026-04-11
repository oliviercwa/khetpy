"""v19 — v18 + improved eval + quiescence search (both kill-switchable).

Forked from ai_ab_v18.py. Adds two independent strength mechanisms that
can each be toggled off from the CLI for measurement:

  1. better_eval=True : use evalf_v19() at leaves instead of game.evalf.
     Fixes the opponent-pyramid asymmetry (game.evalf credits threatening
     an enemy pyramid +200 but forgets to penalize the opponent
     threatening ours), adds a pharaoh-safety term based on enemy-sphinx
     rotation distance to a pharaoh-hitting ray, and values reserves.

  2. quiescence=True : at depth 0, descend into _qs() instead of
     returning a static eval. _qs() only recurses into "loud" moves
     (moves whose laser fire captured at least one piece), curing the
     horizon effect around laser captures. QS never writes the TT.

Both flags default to True. With both off, v19 behaves identically to
v18 (sanity baseline).
"""
import time
import threading
from game_v13 import do, terminal, evalf as _evalf_game, inb, place_legal
from game import laser, VALS, P


class _Timeout(Exception):
    pass


def hs(s):
    """Stable state hash: board + turn + reserves + ply + win + cooldowns + pyramid queue."""
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


TT_MAX = 500_000
MOVE_CAP = 24
MAX_PLY = 32
QS_MAX_PLY = 3  # hard cap on quiescence depth below the main search leaf
QS_MOVE_CAP = 8  # max moves examined per QS node (TT/killer/history ordered)

# TT flags (negamax fail-soft)
EXACT = 0
LOWER = 1
UPPER = 2

# ---- evalf_v19 tuning constants ----
# Rotation distance d -> penalty for our pharaoh reachable in d 90-degree
# turns of the enemy sphinx. Distance 0 is already caught by the direct
# hit branch; distances >= 4 are ignored (no ray hits the pharaoh at all).
PHARAOH_SAFETY_BY_ROT = {1: -300, 2: -120, 3: -40}
RESERVE_VAL = 10  # half of VALS['pyramid']=20


def _sphinx_pos_dir(s, pl):
    """Return (r, c, d) for player pl's sphinx, or None."""
    pos = s.sph.get(pl)
    if pos is None:
        return None
    r, c = pos
    p = s.b[r][c]
    if not p:
        return None
    return r, c, p.d


def _laser_with_sphinx_rot(s, pl, new_d):
    """Call laser() as if player pl's sphinx were rotated to new_d.

    Shallow-mutates a single board cell, calls laser(), then restores.
    Avoids the full state-copy cost of do().
    """
    info = _sphinx_pos_dir(s, pl)
    if info is None:
        return []
    r, c, _ = info
    orig = s.b[r][c]
    # Build rotated sphinx piece (P is a NamedTuple -> immutable -> replace).
    s.b[r][c] = P(orig.t, orig.o, new_d)
    try:
        return laser(s, pl)
    finally:
        s.b[r][c] = orig


def _rotation_distance_to_pharaoh(s, shooter, target_pl):
    """Smallest number of 90-degree rotations from shooter's sphinx current
    orientation such that the resulting laser hits target_pl's pharaoh.

    Returns int in 0..3, or None if no orientation hits the pharaoh.
    """
    info = _sphinx_pos_dir(s, shooter)
    if info is None:
        return None
    _, _, cur_d = info
    best = None
    for steps in range(4):
        test_d = (cur_d + steps * 90) % 360
        hits = _laser_with_sphinx_rot(s, shooter, test_d)
        for _, _, p in hits:
            if p.t == 'pharaoh' and p.o == target_pl:
                if best is None or steps < best:
                    best = steps
                break
        if best == 0:
            break
    return best


def evalf_v19(s, pl):
    """Improved evaluation. Superset of game.evalf.

    Changes vs game.evalf:
      * Fixes the opponent-pyramid hit asymmetry (adds -200 branch).
      * Adds pharaoh-safety term via enemy-sphinx rotation distance.
      * Adds reserve value.
      * Preserves the -ply*2 penalty for TT-consistent depth bias.
    """
    if s.win is not None:
        return 0 if s.win == 0 else (100000 if s.win == pl else -100000)
    op = 3 - pl
    sc = 0
    for r in range(10):
        row = s.b[r]
        for c in range(10):
            p = row[c]
            if p:
                v = VALS[p.t]
                adv = r if pl == 1 else 9 - r
                v += adv * 2
                sc += v if p.o == pl else -v
    h = laser(s, pl)
    ho = laser(s, op)
    for _, _, p in h:
        if p.t == 'pharaoh':
            return 50000
        if p.t == 'anubis':
            sc += 500
        elif p.t == 'pyramid':
            sc += 200
    for _, _, p in ho:
        if p.t == 'pharaoh':
            return -50000
        if p.t == 'anubis':
            sc -= 500
        elif p.t == 'pyramid':  # NEW: fix asymmetry
            sc -= 200

    # Pharaoh safety: how many rotations away is the enemy sphinx from
    # spearing us? Symmetric: how many rotations away are we from
    # spearing them?
    d_def = _rotation_distance_to_pharaoh(s, op, pl)
    if d_def is not None and d_def in PHARAOH_SAFETY_BY_ROT:
        sc += PHARAOH_SAFETY_BY_ROT[d_def]
    d_off = _rotation_distance_to_pharaoh(s, pl, op)
    if d_off is not None and d_off in PHARAOH_SAFETY_BY_ROT:
        sc -= PHARAOH_SAFETY_BY_ROT[d_off]  # negate -> offensive bonus

    # Reserve value: latent material.
    sc += RESERVE_VAL * (s.r[pl] - s.r[op])

    sc -= s.ply * 2
    return sc


def _is_loud(child_state) -> bool:
    """A move is loud iff its laser fire captured at least one piece.

    Reads the `hit_count` attribute that game.do() now caches on every
    child state (non-breaking: defaults to 0 if missing).
    """
    return getattr(child_state, 'hit_count', 0) > 0


class AB:
    def __init__(self, pl, t=0.18, ponder=False,
                 better_eval=True, quiescence=True):
        self.pl = pl
        self.t = t
        self.nodes = 0
        self.total_nodes = 0
        self.last_depth = 0
        self.deadline = None
        self.tt = {}
        self.killers = [[None, None] for _ in range(MAX_PLY)]
        self.history = {}
        self.ponder_enabled = ponder
        self.better_eval = better_eval
        self.quiescence = quiescence
        self.stop_flag = threading.Event()
        self.ponder_thread = None

    # ---- Eval dispatch ----
    def _eval(self, state, pl):
        if self.better_eval:
            return evalf_v19(state, pl)
        return _evalf_game(state, pl)

    # ---- Public API ----
    def choose(self, s):
        start = time.perf_counter()
        # Quiescence leaves are more expensive per node and overruns show
        # up quickly; pull the margin tighter when QS is on.
        if self.quiescence:
            margin = 0.75 if self.ponder_enabled else 0.82
        else:
            margin = 0.80 if self.ponder_enabled else 0.90
        self.stop_ponder()
        self.deadline = start + self.t * margin
        self.nodes = 0
        self.last_depth = 0
        for k in self.killers:
            k[0] = None
            k[1] = None
        self.history = {}

        acts = ordered_moves(s)
        for a in acts:
            if do(s, a).win == self.pl:
                self.total_nodes += 1
                return a
        if not acts:
            return None

        root_key = hs(s)
        tt_entry = self.tt.get(root_key)
        if tt_entry:
            mv = tt_entry[3]
            if mv and mv in acts:
                acts.remove(mv)
                acts.insert(0, mv)
        acts = acts[:MOVE_CAP]
        best = acts[0]

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
                acts.remove(best)
                acts.insert(0, best)
                self._tt_store(root_key, depth, bv, EXACT, best)
            if bv > 40000:
                break

        self.total_nodes += self.nodes

        if self.ponder_enabled:
            ns = do(s, best)
            if not terminal(ns):
                self._start_ponder(ns)

        return best

    def stop_ponder(self):
        if self.ponder_thread and self.ponder_thread.is_alive():
            self.stop_flag.set()
            self.ponder_thread.join()
        self.ponder_thread = None
        self.stop_flag.clear()
        self.deadline = None

    # ---- Internal ----
    def _s(self, state, depth, alpha, beta, ply):
        self.nodes += 1
        if (self.nodes & 63) == 0:
            if self.stop_flag.is_set():
                raise _Timeout
            if self.deadline is not None and time.perf_counter() > self.deadline:
                raise _Timeout

        if terminal(state):
            return self._eval(state, state.turn)
        if depth == 0:
            if self.quiescence:
                return self._qs(state, alpha, beta, 0)
            return self._eval(state, state.turn)

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
            return self._eval(state, state.turn)

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

    # ---- Quiescence search ----
    def _qs(self, state, alpha, beta, qply):
        """Fail-soft quiescence. Only recurses on loud moves (captures).

        Does NOT write the TT — its values are not indexed by main-search
        depth and would corrupt depth-based probes.
        """
        self.nodes += 1
        # Tighter timeout granularity in QS: leaves are expensive and a
        # coarse 64-node check was letting us overrun the budget.
        if (self.nodes & 15) == 0:
            if self.stop_flag.is_set():
                raise _Timeout
            if self.deadline is not None and time.perf_counter() > self.deadline:
                raise _Timeout

        stand = self._eval(state, state.turn)
        if terminal(state) or qply >= QS_MAX_PLY:
            return stand
        if stand >= beta:
            return stand
        if stand > alpha:
            alpha = stand

        acts = ordered_moves(state)
        # Order by history so the most-promising moves come first, then
        # truncate. Skips the TT/killer dance — QS doesn't write the TT
        # anyway, and the sort is cheap for ~50 items.
        hist = self.history
        if hist:
            acts.sort(key=lambda m: hist.get(m, 0), reverse=True)
        acts = acts[:QS_MOVE_CAP]
        best_v = stand
        for a in acts:
            ns = do(state, a)
            if not _is_loud(ns):
                continue
            v = -self._qs(ns, -beta, -alpha, qply + 1)
            if v > best_v:
                best_v = v
            if v > alpha:
                alpha = v
                if alpha >= beta:
                    return best_v
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
