import time
import threading
import ai_api
import game as _game
from game_v13 import do, terminal, evalf, inb, place_legal

# ---------------------------------------------------------------------------
# Module-level functional API (setup / next_move)
# ---------------------------------------------------------------------------

_state  = None
_player = None
_ai     = None


def setup(initial_positions, is_first_player, t=0.18, ponder=False):
    """Initialise the AI for a new game.  Returns True."""
    global _state, _player, _ai
    _player = 1 if is_first_player else 2
    _state  = ai_api.state_from_initial_positions(initial_positions)
    _ai     = AB(_player, t=t, ponder=ponder)
    return True


def next_move(opponent_action):
    """Apply opponent's last action (JS dict or None) and return our move as a JS dict."""
    global _state
    if opponent_action is not None:
        internal_opp = ai_api.action_to_internal(opponent_action, _state)
        _state = _game.do(_state, internal_opp)
    move    = _ai.choose(_state)
    js_move = ai_api.internal_to_action(move, _state, _player)
    _state  = _game.do(_state, move)
    return js_move


class _Timeout(Exception):
    pass


def hs(s):
    """Stable state hash: board + turn + reserves + ply + win + cooldowns + pyramid queue.

    Includes ply because evalf has a -ply*2 term (score depends on ply).
    Includes cd and pq because they now affect legal moves (swap gating)
    and future state (pyramid returns). Omitting them would let two
    distinct game states collide in the TT and corrupt cached values.
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
        # TT instrumentation (cumulative, read by harness via getattr)
        self.tt_probes = 0
        self.tt_hits = 0
        self.tt_cutoffs = 0
        self.tt_move_used = 0
        self.tt_peak = 0
        # Ponder instrumentation — see ai_ab_v15.py for the full rationale.
        self._in_ponder = False
        self.ponder_keys = set()
        self.ponder_nodes = 0
        self.ponder_stores = 0
        self.ponder_hit_on_stored = 0
        self.ponder_cutoff_on_stored = 0

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
        # v16: search *all* legal moves at the root. Missing a defensive
        # resource here is how easy kills slip through. Interior nodes
        # still cap via MOVE_CAP in _s().
        best = acts[0]

        # Iterative deepening (ceiling raised; deadline still bounds it)
        for depth in range(1, 14):
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
            # v16: only break on a *proven* game-ending score. The old
            # 40000 cutoff caught evalf's +50000 "my laser aims at their
            # pharaoh" heuristic, which is a defensible one-ply threat,
            # not a forced mate. 90000 only catches true wins (evalf
            # returns ±100000 for terminal states).
            if bv >= 90000:
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
        if self._in_ponder:
            self.ponder_nodes += 1
        if (self.nodes & 7) == 0:
            if self.stop_flag.is_set():
                raise _Timeout
            if self.deadline is not None and time.perf_counter() > self.deadline:
                raise _Timeout

        if terminal(state) or depth == 0:
            return evalf(state, state.turn)

        orig_alpha = alpha
        key = hs(state)
        self.tt_probes += 1
        tt_entry = self.tt.get(key)
        tt_move = None
        if tt_entry:
            self.tt_hits += 1
            key_from_ponder = not self._in_ponder and key in self.ponder_keys
            if key_from_ponder:
                self.ponder_hit_on_stored += 1
            d, v, flag, mv = tt_entry
            if d >= depth:
                if flag == EXACT:
                    self.tt_cutoffs += 1
                    if key_from_ponder:
                        self.ponder_cutoff_on_stored += 1
                    return v
                if flag == LOWER and v >= beta:
                    self.tt_cutoffs += 1
                    if key_from_ponder:
                        self.ponder_cutoff_on_stored += 1
                    return v
                if flag == UPPER and v <= alpha:
                    self.tt_cutoffs += 1
                    if key_from_ponder:
                        self.ponder_cutoff_on_stored += 1
                    return v
            tt_move = mv

        acts = ordered_moves(state)
        if not acts:
            return evalf(state, state.turn)
        if tt_move and tt_move in acts:
            self.tt_move_used += 1
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
                self.ponder_keys.clear()
            self.tt[key] = (depth, value, flag, move)
            if len(self.tt) > self.tt_peak:
                self.tt_peak = len(self.tt)
            if self._in_ponder:
                self.ponder_keys.add(key)
                self.ponder_stores += 1
            else:
                self.ponder_keys.discard(key)

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
        self._in_ponder = True
        try:
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
        finally:
            self._in_ponder = False
