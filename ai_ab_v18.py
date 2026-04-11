"""v18: v17 + root-only short-horizon interleaved ordering.

Fork of v17.  Same search semantics, same interior-node ordering.
Only change: at root, interleave sphinx_rotate and pyramid_place
(up to 2 each) before other classes, to recover 4-move wins without
sacrificing the 3-move bucket.

Interior nodes, evaluation, staged generation: unchanged from v17.
"""
import time
import random
import threading
from game_v13 import do, terminal, evalf, inb
from move_ordering import score_moves, staged_interior_moves, _move_family

# --- OTL-2 diagnostic logging (opt-in) ---
DEBUG_OTL2_LOG = False
DEBUG_OTL2_SAMPLE_RATE = 0.05  # sample 5% of eligible nodes

# v18 root debug (opt-in, set by worker)
DEBUG_V18_ROOT = False

# Worker identity — set by worker.py via enable_otl2 command.
_otl2_worker_id = None


class _Timeout(Exception):
    pass


MAX_PLY = 16  # Killer table size; covers ID ceiling of 14 + slack.


def hs(s):
    """Stable state hash."""
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


def _interleave_root(s, acts, tt_move):
    """Short-horizon root ordering: interleave sphinx_rotate + pyramid_place.

    Takes acts already ranked by score_moves() (intra-class order preserved).
    Returns reordered list:
      TT move, interleave(sphinx_rot[:2], pyr_place[:2]),
      scarab_swap, pyramid_move, other non-placements,
      remaining sphinx_rot, remaining placements.
    """
    result = []
    skip = set()

    # Phase 0: TT move
    if tt_move is not None:
        for a in acts:
            if a == tt_move:
                result.append(a)
                skip.add(a)
                break

    # Partition into classes (acts are ranked by score_moves prior)
    sphinx_rot = []
    pyr_place = []
    scr_swap = []
    pyr_move = []
    other_nonplace = []

    for a in acts:
        if a in skip:
            continue
        c0 = a[0]
        if c0 == 'r' and s.b[a[1]][a[2]].t == 'sphinx':
            sphinx_rot.append(a)
        elif c0 == 'p':
            pyr_place.append(a)
        elif c0 == 's':
            scr_swap.append(a)
        elif c0 == 'm' and s.b[a[1]][a[2]].t == 'pyramid':
            pyr_move.append(a)
        else:
            other_nonplace.append(a)

    # Interleave: up to 2 sphinx_rotate, up to 2 pyramid_place
    SR = min(2, len(sphinx_rot))
    PP = min(2, len(pyr_place))
    for i in range(max(SR, PP)):
        if i < SR:
            result.append(sphinx_rot[i])
        if i < PP:
            result.append(pyr_place[i])

    # scarab_swap, then pyramid_move
    result.extend(scr_swap)
    result.extend(pyr_move)

    # remaining non-placements (anubis moves/rotates, scarab moves/rotates,
    # pyramid rotates, etc.)
    result.extend(other_nonplace)

    # remaining sphinx_rotates beyond the first 2
    for a in sphinx_rot[SR:]:
        result.append(a)

    # remaining placements beyond the first 2
    for a in pyr_place[PP:]:
        result.append(a)

    return result


def ordered_moves(s):
    """Deterministic move generator (v16 order: rotates, slides, placements, swaps).

    Returns (acts, opp_pharaoh_pos).  opp_pharaoh_pos is (r,c) or None,
    cached during the board scan to avoid redundant find() calls in
    place_legal and placement ranking.
    """
    pl = s.turn
    acts = []
    has_scarab = False
    own_pharaoh = None
    opp_pharaoh = None
    # Sphinx positions are cached in s.sph; grab them once.
    sph1 = s.sph[1]
    sph2 = s.sph[2]

    for r in range(10):
        for c in range(10):
            p = s.b[r][c]
            if not p:
                continue
            if p.o != pl:
                if p.t == 'pharaoh':
                    opp_pharaoh = (r, c)
                continue
            pt = p.t
            if pt == 'scarab':
                has_scarab = True
            elif pt == 'pharaoh':
                own_pharaoh = (r, c)
            if pt != 'pharaoh':
                acts.append(('r', r, c, 1))
                acts.append(('r', r, c, -1))
            if pt in ('anubis', 'pyramid', 'scarab'):
                for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                    nr, nc = r + dr, c + dc
                    if inb(nr, nc) and not s.b[nr][nc]:
                        acts.append(('m', r, c, nr, nc))

    # Placements — inline place_legal with pre-computed blocked set to
    # avoid per-cell abs() adjacency checks and find() calls.
    if s.r[pl] > 0:
        blocked = set()
        for cell in (own_pharaoh, sph1, sph2):
            if cell:
                cr, cc = cell
                for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                    nr, nc = cr + dr, cc + dc
                    if 0 <= nr < 10 and 0 <= nc < 10:
                        blocked.add((nr, nc))
        for r in range(10):
            for c in range(10):
                if s.b[r][c] is not None or (r, c) in blocked:
                    continue
                acts.append(('p', r, c, 0))
                acts.append(('p', r, c, 90))
                acts.append(('p', r, c, 180))
                acts.append(('p', r, c, 270))

    # Swaps
    if has_scarab:
        has_own_sphinx = s.sph.get(pl) is not None
        if has_own_sphinx and s.cd[pl]['sphinx'] == 0:
            acts.append(('s', 'sphinx'))
        if own_pharaoh and s.cd[pl]['pharaoh'] == 0:
            acts.append(('s', 'pharaoh'))

    return acts, opp_pharaoh


TT_MAX = 500_000
MOVE_CAP = 24

EXACT = 0
LOWER = 1
UPPER = 2


class AB:
    def __init__(self, pl, t=0.18, ponder=False):
        self.pl = pl
        self.t = t
        self.nodes = 0
        self.total_nodes = 0
        self.last_depth = 0
        self.deadline = None
        self.tt = {}
        self.ponder_enabled = ponder
        self.stop_flag = threading.Event()
        self.ponder_thread = None
        # TT instrumentation
        self.tt_probes = 0
        self.tt_hits = 0
        self.tt_cutoffs = 0
        self.tt_move_used = 0
        self.tt_peak = 0
        # Ponder instrumentation
        self._in_ponder = False
        self.ponder_keys = set()
        self.ponder_nodes = 0
        self.ponder_stores = 0
        self.ponder_hit_on_stored = 0
        self.ponder_cutoff_on_stored = 0
        # Killer + history tables (reset per choose).
        self.killers = [[None, None] for _ in range(MAX_PLY)]
        self.history = {}
        # OTL-2 diagnostic buffer (events returned to controller).
        self._game_id = 0
        self._otl2_buf = []  # list of dicts, flushed by controller

    # ---- Public API ----
    def choose(self, s):
        start = time.perf_counter()
        margin = 0.80 if self.ponder_enabled else 0.90
        self.stop_ponder()
        self.deadline = start + self.t * margin
        self.nodes = 0
        self.last_depth = 0
        # Reset move-ordering tables.
        for slot in self.killers:
            slot[0] = slot[1] = None
        self.history.clear()
        self._game_id += 1

        acts, _ = ordered_moves(s)
        # Immediate win
        for a in acts:
            if do(s, a).win == self.pl:
                self.total_nodes += 1
                return a
        if not acts:
            return None

        # Root ordering via empirical prior + TT.
        root_key = hs(s)
        tt_entry = self.tt.get(root_key)
        root_tt_move = None
        if tt_entry:
            mv = tt_entry[3]
            if mv and mv in acts:
                root_tt_move = mv
        acts = score_moves(s, acts, 14, root_tt_move)
        if root_tt_move:
            self.tt_move_used += 1

        # v18: interleave sphinx_rotate + pyramid_place at root.
        acts = _interleave_root(s, acts, root_tt_move)

        best = acts[0]

        # Iterative deepening
        for depth in range(1, 14):
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
            if bv >= 90000:
                break

        self.total_nodes += self.nodes

        # OTL-2 root logger: capture root decision for short-game analysis.
        if DEBUG_OTL2_LOG and not self._in_ponder:
            # Classify moves by family for counts.
            n_sph_rot = sum(1 for a in acts if a[0] == 'r'
                            and s.b[a[1]][a[2]].t == 'sphinx')
            n_pyr_place = sum(1 for a in acts if a[0] == 'p')
            n_pyr_move = sum(1 for a in acts if a[0] == 'm'
                             and s.b[a[1]][a[2]].t == 'pyramid')
            n_scr_swap = sum(1 for a in acts if a[0] == 's')
            top6 = []
            for i, a in enumerate(acts[:6]):
                top6.append({'rank': i, 'move': str(a),
                             'family': _move_family(s, a)})
            best_family = _move_family(s, best) if best else None
            best_rank = 0  # best is always acts[0] after ID reorder
            self._otl2_buf.append({
                'worker_id': _otl2_worker_id,
                'game_id': self._game_id,
                'node': 'root',
                'ply': s.ply,
                'side': s.turn,
                'remaining_ply': self.last_depth,
                'reserve': s.r[s.turn],
                'counts': {
                    'sphinx_rotate': n_sph_rot,
                    'pyramid_place': n_pyr_place,
                    'pyramid_move': n_pyr_move,
                    'scarab_swap': n_scr_swap,
                },
                'placement_K': None,
                'first_placement_rank': None,
                'top_moves': top6,
                'best_move': str(best),
                'best_family': best_family,
                'best_rank': best_rank,
                'cutoff_phase': 'root',
                'n_searched': len(acts),
            })

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
        """Negamax + alpha-beta + TT with staged move ordering."""
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

        full_acts, opp_pharaoh = ordered_moves(state)
        if not full_acts:
            return evalf(state, state.turn)

        # Staged interior ordering.
        killers = self.killers[ply] if ply < MAX_PLY else (None, None)

        # OTL-2 debug: Stage A — cheap pre-search eligibility.
        otl = (depth + 1) // 2
        dbg = None
        if (DEBUG_OTL2_LOG and otl == 2 and ply > 0
                and not self._in_ponder
                and random.random() < DEBUG_OTL2_SAMPLE_RATE):
            dbg = {}

        acts = staged_interior_moves(
            state, full_acts, depth, tt_move, killers, self.history,
            opp_pharaoh,
            debug_info=dbg,
        )

        # OTL-2 debug: filter — require sphinx_rotate + pyramid_place +
        # (pyramid_move or scarab_swap).
        if dbg is not None:
            c = dbg.get('counts', {})
            if (c.get('sphinx_rotate', 0) == 0
                    or c.get('pyramid_place', 0) == 0
                    or (c.get('pyramid_move', 0) == 0
                        and c.get('scarab_swap', 0) == 0)):
                dbg = None

        # Track TT move usage (staged_interior_moves puts it first if legal).
        if tt_move is not None and acts and acts[0] == tt_move:
            self.tt_move_used += 1
        acts = acts[:MOVE_CAP]

        best_v = -10**9
        best_move = None
        cutoff_idx = -1
        for idx, a in enumerate(acts):
            v = -self._s(do(state, a), depth - 1, -beta, -alpha, ply + 1)
            if v > best_v:
                best_v = v
                best_move = a
            if best_v > alpha:
                alpha = best_v
            if alpha >= beta:
                cutoff_idx = idx
                # Record killer (non-placement only) and history.
                if a[0] != 'p' and ply < MAX_PLY:
                    slot = self.killers[ply]
                    if slot[0] != a:
                        slot[1] = slot[0]
                        slot[0] = a
                self.history[a] = self.history.get(a, 0) + depth * depth
                break

        # OTL-2 debug: build record and buffer (filtering at game end).
        if dbg is not None:
            first_p = dbg.get('first_placement_rank')
            best_family = _move_family(state, best_move) if best_move else None
            best_rank = None
            if best_move is not None:
                for i, a in enumerate(acts):
                    if a == best_move:
                        best_rank = i
                        break
            if cutoff_idx < 0:
                cutoff_phase = 'no_cutoff'
            elif first_p is None:
                cutoff_phase = 'no_placements'
            elif cutoff_idx < first_p:
                cutoff_phase = 'before_early'
            else:
                K = dbg.get('placement_K', 4)
                if cutoff_idx < first_p + K:
                    cutoff_phase = 'during_late'
                else:
                    cutoff_phase = 'after_early_before_late'
            c = dbg.get('counts', {})
            self._otl2_buf.append({
                'worker_id': _otl2_worker_id,
                'game_id': self._game_id,
                'ply': state.ply,
                'side': state.turn,
                'remaining_ply': depth,
                'reserve': state.r[state.turn],
                'counts': {
                    'sphinx_rotate': c.get('sphinx_rotate', 0),
                    'pyramid_place': c.get('pyramid_place', 0),
                    'pyramid_move': c.get('pyramid_move', 0),
                    'scarab_swap': c.get('scarab_swap', 0),
                },
                'placement_K': dbg.get('placement_K'),
                'first_placement_rank': first_p,
                'top_moves': [
                    {'rank': e['rank'], 'move': str(e['move']),
                     'family': e['family']}
                    for e in dbg.get('top_moves', [])[:6]
                ],
                'best_move': str(best_move),
                'best_family': best_family,
                'best_rank': best_rank,
                'cutoff_phase': cutoff_phase,
                'n_searched': (cutoff_idx + 1) if cutoff_idx >= 0 else len(acts),
            })

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
        """Iterative-deepening ponder with staged ordering."""
        self._in_ponder = True
        try:
            try:
                for depth in range(1, 9):
                    if self.stop_flag.is_set():
                        return
                    acts, opp_ph = ordered_moves(state)
                    key = hs(state)
                    tt_entry = self.tt.get(key)
                    tt_move = tt_entry[3] if tt_entry else None
                    killers = (None, None)
                    acts = staged_interior_moves(
                        state, acts, depth, tt_move, killers, self.history,
                        opp_ph,
                    )
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
        finally:
            self._in_ponder = False
