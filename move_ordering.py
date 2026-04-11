"""Tactical move ordering for Khet AI.

Two public APIs:
  score_moves()            — root-level scoring (all moves, full prior)
  staged_interior_moves()  — interior-node staged generation with
                             placement quota, class priority, killers,
                             and history heuristic.

Designed to be imported by ai_ab_v17.
"""

# =========================================================================
# Root scoring (unchanged from Phase 1)
# =========================================================================

PRIOR_1 = {  # own_turns_left == 1 (N-2: the killing move)
    ("pyramid", "place"): 1000, ("pyramid", "move"):  120,
    ("sphinx",  "rotate"):  80, ("pyramid", "rotate"):  35,
    ("scarab",  "move"):    20, ("scarab",  "swap"):    12,
    ("anubis",  "move"):     5, ("scarab",  "rotate"):   2,
    ("anubis",  "rotate"):   0,
}
PRIOR_2 = {  # own_turns_left == 2 (N-4)
    ("pyramid", "place"): 1000, ("sphinx",  "rotate"): 430,
    ("scarab",  "swap"):   170, ("pyramid", "move"):    75,
    ("pyramid", "rotate"):  45, ("scarab",  "move"):    40,
    ("anubis",  "move"):    18, ("scarab",  "rotate"):   8,
    ("anubis",  "rotate"):   0,
}
PRIOR_3 = {  # own_turns_left == 3 (N-6)
    ("pyramid", "place"): 1000, ("pyramid", "move"):   110,
    ("scarab",  "swap"):    95, ("sphinx",  "rotate"):  90,
    ("scarab",  "move"):    50, ("pyramid", "rotate"):  40,
    ("anubis",  "move"):    22, ("anubis",  "rotate"):   4,
    ("scarab",  "rotate"):   0,
}
PRIOR_4P = {  # own_turns_left >= 4
    ("pyramid", "place"): 260, ("pyramid", "move"):  220,
    ("sphinx",  "rotate"):150, ("pyramid", "rotate"):  90,
    ("scarab",  "move"):   85, ("scarab",  "swap"):    60,
    ("anubis",  "move"):   40, ("anubis",  "rotate"):  15,
    ("scarab",  "rotate"): 10,
}

PRIOR_SCALE = 2.5
_TT_BONUS = 2_000_000


def _action_key(s, a):
    code = a[0]
    if code == 'r': return (s.b[a[1]][a[2]].t, 'rotate')
    if code == 'm': return (s.b[a[1]][a[2]].t, 'move')
    if code == 'p': return ('pyramid', 'place')
    if code == 's': return ('scarab', 'swap')
    return None


def _phase_weight(s):
    non_royal = 0
    for r in range(10):
        for c in range(10):
            p = s.b[r][c]
            if p and p.t not in ('pharaoh', 'sphinx'):
                non_royal += 1
    total_reserve = s.r[s.turn] + s.r[3 - s.turn]
    return 1.0 if (non_royal <= 12 or total_reserve <= 5) else 0.35


def _empirical_prior(s, a, own_turns_left):
    key = _action_key(s, a)
    if key is None:
        return 0.0
    if own_turns_left <= 1:   base = float(PRIOR_1.get(key, 0))
    elif own_turns_left == 2: base = float(PRIOR_2.get(key, 0))
    elif own_turns_left == 3: base = float(PRIOR_3.get(key, 0))
    else:                     base = float(PRIOR_4P.get(key, 0))
    pl = s.turn
    if key[1] == 'place':
        if s.r[pl] == 0: return 0.0
        if own_turns_left <= 3: base *= 1.20
    if s.r[pl] == 0:
        if   key == ('pyramid', 'move'):   base *= 1.25
        elif key == ('sphinx',  'rotate'): base *= 1.15
        elif key == ('scarab',  'move'):   base *= 1.15
        elif key == ('scarab',  'swap'):   base *= 1.10
    if a[0] == 's' and a[1] == 'sphinx':
        base *= 0.75
        if own_turns_left == 1: base *= 0.50
    return base * PRIOR_SCALE


def score_moves(s, acts, depth, tt_move=None):
    """Root-level move scoring.  Returns new sorted list (best first)."""
    own_turns_left = (depth + 1) // 2
    pw = _phase_weight(s)
    scored = []
    for a in acts:
        sc = 0.0
        if tt_move is not None and a == tt_move:
            sc += _TT_BONUS
        sc += pw * _empirical_prior(s, a, own_turns_left)
        scored.append((sc, a))
    scored.sort(key=lambda x: -x[0])
    return [a for _, a in scored]


# =========================================================================
# Interior-node staged generation
# =========================================================================

# Non-placement move class indices
_PYR_MOV  = 0
_PYR_ROT  = 1
_SPH_ROT  = 2
_SCR_MOV  = 3
_SCR_ROT  = 4
_SCR_SWP  = 5
_ANB_MOV  = 6
_ANB_ROT  = 7
_NUM_CLS  = 8

# Class priority orders by own_turns_left bucket
_ORD_1  = (_PYR_MOV, _SPH_ROT, _SCR_SWP, _SCR_MOV,
           _PYR_ROT, _ANB_MOV, _ANB_ROT, _SCR_ROT)
_ORD_2  = (_SPH_ROT, _SCR_SWP, _PYR_MOV, _SCR_MOV,
           _PYR_ROT, _ANB_MOV, _ANB_ROT, _SCR_ROT)
_ORD_3P = (_PYR_MOV, _SCR_MOV, _SCR_SWP, _SPH_ROT,
           _PYR_ROT, _ANB_MOV, _ANB_ROT, _SCR_ROT)

# Placement quota by own_turns_left
_QUOTA = {1: 6, 2: 4}  # default 2 for >= 3


def staged_interior_moves(s, all_moves, depth, tt_move, killers, history,
                          opp_pharaoh=None, debug_info=None):
    """Staged move generation for interior nodes.

    Phases:
      0  TT move
      1  Killer moves (non-placement)
      2  Non-placement classes in depth-dependent priority order
      3  Top-K placements (cheap static ranking)
      4  Remaining placements

    Args:
        s:            game state
        all_moves:    full legal move list from ordered_moves()
        depth:        remaining search depth
        tt_move:      TT best move or None
        killers:      (k0, k1) tuple for this search ply
        history:      dict mapping action tuple -> int score
        opp_pharaoh:  (r, c) of opponent pharaoh, from ordered_moves cache
        debug_info:   if dict, populated with diagnostic data (otl==2 only)

    Returns:
        Ordered move list.  Caller applies MOVE_CAP.
    """
    otl = (depth + 1) // 2
    pl = s.turn

    # --- Partition into placements vs class buckets ---
    placements = []
    cls = [[] for _ in range(_NUM_CLS)]

    for m in all_moves:
        c0 = m[0]
        if c0 == 'p':
            placements.append(m)
        elif c0 == 's':
            cls[_SCR_SWP].append(m)
        else:
            pt = s.b[m[1]][m[2]].t
            if c0 == 'r':
                if   pt == 'pyramid': cls[_PYR_ROT].append(m)
                elif pt == 'sphinx':  cls[_SPH_ROT].append(m)
                elif pt == 'scarab':  cls[_SCR_ROT].append(m)
                else:                 cls[_ANB_ROT].append(m)
            else:  # 'm'
                if   pt == 'pyramid': cls[_PYR_MOV].append(m)
                elif pt == 'scarab':  cls[_SCR_MOV].append(m)
                else:                 cls[_ANB_MOV].append(m)

    # --- Debug: record class counts ---
    if debug_info is not None:
        debug_info['counts'] = {
            'sphinx_rotate': len(cls[_SPH_ROT]),
            'scarab_swap': len(cls[_SCR_SWP]),
            'pyramid_move': len(cls[_PYR_MOV]),
            'pyramid_rotate': len(cls[_PYR_ROT]),
            'scarab_move': len(cls[_SCR_MOV]),
            'scarab_rotate': len(cls[_SCR_ROT]),
            'anubis_move': len(cls[_ANB_MOV]),
            'anubis_rotate': len(cls[_ANB_ROT]),
            'pyramid_place': len(placements),
        }
        debug_info['tt_move'] = tt_move
        debug_info['killers'] = [k for k in killers if k is not None]
        debug_info['placement_K'] = _QUOTA.get(otl, 2)

    result = []
    skip = set()

    # --- Phase 0: TT move ---
    if tt_move is not None:
        # Check legality by scanning the correct partition.
        if tt_move[0] == 'p':
            tt_legal = tt_move in placements
        elif tt_move[0] == 's':
            tt_legal = tt_move in cls[_SCR_SWP]
        else:
            pt = s.b[tt_move[1]][tt_move[2]]
            if pt is None:
                tt_legal = False
            else:
                ci = _classify_piece(pt.t, tt_move[0])
                tt_legal = tt_move in cls[ci]
        if tt_legal:
            result.append(tt_move)
            skip.add(tt_move)

    # --- Phase 1: Killers (non-placement only) ---
    k0, k1 = killers
    for k in (k0, k1):
        if k is None or k in skip or k[0] == 'p':
            continue
        # Quick legality: check in the right class bucket.
        if k[0] == 's':
            if k in cls[_SCR_SWP]:
                result.append(k)
                skip.add(k)
        else:
            pc = s.b[k[1]][k[2]]
            if pc is not None and pc.o == pl:
                ci = _classify_piece(pc.t, k[0])
                if k in cls[ci]:
                    result.append(k)
                    skip.add(k)

    # --- Phase 2: Non-placement classes in priority order ---
    if otl <= 1:    order = _ORD_1
    elif otl == 2:  order = _ORD_2
    else:           order = _ORD_3P

    for ci in order:
        bucket = cls[ci]
        if not bucket:
            continue
        # Intra-class history ordering (only when meaningful).
        if history and len(bucket) > 1:
            bucket.sort(key=lambda m: -history.get(m, 0))
        for m in bucket:
            if m not in skip:
                result.append(m)

    # --- Phase 3 + 5: Placements ---
    if placements:
        K = _QUOTA.get(otl, 2)
        # Rank placements by cheap static heuristic.
        _rank_placements_inplace(placements, s, pl, opp_pharaoh)
        # Top K
        added = 0
        cutoff = len(placements)
        for i, m in enumerate(placements):
            if m not in skip:
                result.append(m)
                added += 1
                if added >= K:
                    cutoff = i + 1
                    break
        # Remaining placements (deferred — low priority).
        for i in range(cutoff, len(placements)):
            m = placements[i]
            if m not in skip:
                result.append(m)

    # --- Debug: record top ordered moves and phase boundaries ---
    if debug_info is not None:
        debug_info['top_moves'] = []
        for i, m in enumerate(result[:8]):
            debug_info['top_moves'].append({
                'rank': i,
                'move': m,
                'family': _move_family(s, m),
            })
        # Record index where placements start in result.
        first_place_idx = None
        for i, m in enumerate(result):
            if m[0] == 'p':
                first_place_idx = i
                break
        debug_info['first_placement_rank'] = first_place_idx

    return result


# Class names for debug logging.
_CLS_NAMES = {
    _PYR_MOV: 'pyramid_move', _PYR_ROT: 'pyramid_rotate',
    _SPH_ROT: 'sphinx_rotate', _SCR_MOV: 'scarab_move',
    _SCR_ROT: 'scarab_rotate', _SCR_SWP: 'scarab_swap',
    _ANB_MOV: 'anubis_move', _ANB_ROT: 'anubis_rotate',
}


def _move_family(s, m):
    """Classify a move into a human-readable family string."""
    c0 = m[0]
    if c0 == 'p':
        return 'pyramid_place'
    if c0 == 's':
        return 'scarab_swap'
    pt = s.b[m[1]][m[2]]
    if pt is None:
        return 'unknown'
    if c0 == 'r':
        ci = _classify_piece(pt.t, 'r')
    else:
        ci = _classify_piece(pt.t, 'm')
    return _CLS_NAMES.get(ci, 'unknown')


def _classify_piece(pt, code):
    """Map (piece_type, action_code) to class index."""
    if code == 'r':
        if pt == 'pyramid': return _PYR_ROT
        if pt == 'sphinx':  return _SPH_ROT
        if pt == 'scarab':  return _SCR_ROT
        return _ANB_ROT
    # code == 'm'
    if pt == 'pyramid': return _PYR_MOV
    if pt == 'scarab':  return _SCR_MOV
    return _ANB_MOV


def _rank_placements_inplace(placements, s, pl, opp_pharaoh=None):
    """Sort placements in-place by cheap static heuristic.

    Uses only: opponent pharaoh position (pre-cached), own sphinx
    position, board zone, orientation.  No per-move simulation.

    Uses decorate-sort-undecorate with C-level sorted() — faster than
    Python-level top-K selection for n=200-300.
    """
    opr, opc = opp_pharaoh if opp_pharaoh else (5, 5)
    sph = s.sph.get(pl)
    spr = sph[0] if sph else -1
    spc = sph[1] if sph else -1
    fwd_d = 180 if pl == 1 else 0
    opp_half = pl == 1  # True if opponent half means r >= 5

    # Score all placements, then sort by descending score.
    # Uses negated scores in decorated tuples for a single ascending sort.
    decorated = []
    _ap = decorated.append
    for m in placements:
        r, c, d = m[1], m[2], m[3]
        dr = r - opr
        dc = c - opc
        dist = (dr if dr >= 0 else -dr) + (dc if dc >= 0 else -dc)
        sc = (18 - dist) * 3 if dist < 18 else 0
        if (opp_half and r >= 5) or (not opp_half and r <= 4):
            sc += 10
        if r == spr or c == spc:
            sc += 8
        if d == fwd_d:
            sc += 5
        elif d == 90 or d == 270:
            sc += 2
        _ap((-sc, m))
    decorated.sort()
    placements[:] = [m for _, m in decorated]
