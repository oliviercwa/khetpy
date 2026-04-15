"""Shared translation layer between the JS-style tournament API and the
internal game representation used by game.py.

Coordinate systems
------------------
JS spec  : Cell n  →  line = (n // 10 + 1) counted from the BOTTOM,
                       col  = (n % 10  + 1) counted from the left.
           Cell 0 is the bottom-left corner; Cell 99 is the top-right corner.
           Special: −1 = player-1 reserve, −2 = player-2 reserve.

Internal : 10×10 grid b[row][col] where row 0 is the TOP (player-1 home row)
           and row 9 is the bottom (player-2 home row).

Mapping  : internal_row = 9 − (cell // 10)
           internal_col = cell % 10
           cell         = (9 − row) * 10 + col

Action tuples (internal)
------------------------
('r', r, c, dd)        rotate piece at (r,c) by +1 (CW) or -1 (CCW) quarter-turns
('m', r, c, nr, nc)    move piece from (r,c) to (nr,nc)
('p', r, c, d)         place pyramid from reserve at (r,c) with direction d
('s', target)          scarab exchange with 'sphinx' or 'pharaoh'

Pyramid / scarab orientation mapping
--------------------------------------
JS orientation 0 / 9 / 90 / 99  correspond to the four board corners:
  0  = bottom-left  → internal d = 0
  9  = bottom-right → internal d = 90
  90 = top-left     → internal d = 270
  99 = top-right    → internal d = 180

Scarab orientation (JS 0 or 9) describes which column a northward beam
coming from the bottom row would be deflected toward:
  0 → column 0 (left)  → internal d = 90
  9 → column 9 (right) → internal d = 0
"""

import game as _game
from game import P, S


# ---------------------------------------------------------------------------
# Coordinate helpers
# ---------------------------------------------------------------------------

def cell_to_rc(cell):
    """Convert a JS Cell integer to (row, col) in internal board coordinates."""
    return (9 - cell // 10, cell % 10)


def rc_to_cell(r, c):
    """Convert internal (row, col) to a JS Cell integer."""
    return (9 - r) * 10 + c


# ---------------------------------------------------------------------------
# Orientation helpers
# ---------------------------------------------------------------------------

# Pyramid: JS corner-cell → internal direction
ORIENT_TO_DIR = {0: 0, 9: 90, 90: 270, 99: 180}
DIR_TO_ORIENT = {0: 0, 90: 9, 270: 90, 180: 99}


def scarab_orient_to_dir(orientation):
    """JS scarab orientation (0 or 9) → internal direction."""
    return 90 if orientation == 0 else 0


def scarab_dir_to_orient(d):
    """Internal scarab direction → JS scarab orientation (0 or 9)."""
    # d=90 or d=270 both deflect left → 0; d=0 or d=180 deflect right → 9
    return 0 if (d // 90) % 2 == 1 else 9


# ---------------------------------------------------------------------------
# Game-state reconstruction
# ---------------------------------------------------------------------------

def state_from_initial_positions(initial_positions):
    """Build a full game.S from the JS-style initialPositions dict.

    initial_positions = {
        'sphinx':  Cell,
        'pharaoh': Cell,
        'scarab':  {'position': Cell, 'orientation': 0 | 9}
    }

    Anubis positions are derived deterministically (same logic as game.init):
      • anubis #1 at (row 4, pharaoh_col),  facing south  d=180
      • anubis #2 at (row 2, 9−sphinx_col), facing south  d=180
    Player-2 pieces are the point-symmetric mirror of player-1's pieces
    (row→9−row, col→9−col, direction→(d+180)%360), except pharaohs which
    both stay at d=180.
    """
    s = S()

    # ---- player-1 sphinx ----
    sph_r, sc = cell_to_rc(initial_positions['sphinx'])
    sph_dir = 90 if (9 - sc) > sc else 270
    s.b[sph_r][sc] = P('sphinx', 1, sph_dir)

    # ---- player-1 pharaoh ----
    ph_r, pc = cell_to_rc(initial_positions['pharaoh'])
    s.b[ph_r][pc] = P('pharaoh', 1, 180)

    # ---- player-1 anubis ----
    s.b[4][pc] = P('anubis', 1, 180)          # anubis #1: own pharaoh column
    s.b[2][9 - sc] = P('anubis', 1, 180)      # anubis #2: opponent sphinx col

    # ---- player-1 scarab ----
    sc_info = initial_positions['scarab']
    sc_r, scc = cell_to_rc(sc_info['position'])
    scarab_d = scarab_orient_to_dir(sc_info['orientation'])
    s.b[sc_r][scc] = P('scarab', 1, scarab_d)

    # ---- player-2 (point-symmetric mirror) ----
    s.b[9 - sph_r][9 - sc] = P('sphinx', 2, (sph_dir + 180) % 360)
    s.b[9 - ph_r][9 - pc]  = P('pharaoh', 2, 180)         # pharaoh always 180
    s.b[5][9 - pc]          = P('anubis', 2, 0)            # mirror of anubis #1
    s.b[7][sc]              = P('anubis', 2, 0)            # mirror of anubis #2
    s.b[9 - sc_r][9 - scc]  = P('scarab', 2, (scarab_d + 180) % 360)

    # ---- metadata ----
    s.sph = {1: (sph_r, sc), 2: (9 - sph_r, 9 - sc)}
    s.r   = {1: 7, 2: 7}
    s.turn = 1
    s.ply  = 0
    return s


def make_initial_positions(s):
    """Extract JS-style initialPositions from a live game.S.

    Returns player-1's sphinx, pharaoh, and scarab positions only
    (the spec only requires the first player's layout).
    """
    sph = s.sph[1]
    ph  = _game.find(s, 'pharaoh', 1)
    sc  = _game.find(s, 'scarab',  1)
    return {
        'sphinx':  rc_to_cell(*sph),
        'pharaoh': rc_to_cell(ph[0], ph[1]),
        'scarab':  {
            'position':    rc_to_cell(sc[0], sc[1]),
            'orientation': scarab_dir_to_orient(sc[2].d),
        },
    }


# ---------------------------------------------------------------------------
# Action translation
# ---------------------------------------------------------------------------

def action_to_internal(action_dict, s):
    """Convert a JS-style Action dict → internal action tuple.

    s is the game state BEFORE the action is applied (needed to resolve
    EXCHANGE: find which piece type is at the result cell).
    """
    act  = action_dict['action']
    cell = action_dict['cell']
    res  = action_dict['result']

    if act == 'ROTATE':
        r, c = cell_to_rc(cell)
        dd   = 1 if res == 'CLOCKWISE' else -1
        return ('r', r, c, dd)

    if act == 'MOVE':
        r,  c  = cell_to_rc(cell)
        nr, nc = cell_to_rc(res)
        return ('m', r, c, nr, nc)

    if act == 'PLACE':
        nr, nc = cell_to_rc(res['destination'])
        d      = ORIENT_TO_DIR[res['orientation']]
        return ('p', nr, nc, d)

    if act == 'EXCHANGE':
        tr, tc = cell_to_rc(res)
        p = s.b[tr][tc]
        target = p.t  # 'sphinx' or 'pharaoh'
        return ('s', target)

    raise ValueError(f'Unknown action type: {act!r}')


def internal_to_action(action_tuple, s_before, player):
    """Convert an internal action tuple → JS-style Action dict.

    s_before is the game state BEFORE the action is applied (needed to look
    up piece positions for EXCHANGE).
    """
    t = action_tuple[0]

    if t == 'r':
        _, r, c, dd = action_tuple
        return {
            'action': 'ROTATE',
            'cell':   rc_to_cell(r, c),
            'result': 'CLOCKWISE' if dd == 1 else 'ANTICLOCKWISE',
        }

    if t == 'm':
        _, r, c, nr, nc = action_tuple
        return {
            'action': 'MOVE',
            'cell':   rc_to_cell(r, c),
            'result': rc_to_cell(nr, nc),
        }

    if t == 'p':
        _, r, c, d = action_tuple
        reserve_cell = -1 if player == 1 else -2
        return {
            'action': 'PLACE',
            'cell':   reserve_cell,
            'result': {
                'destination': rc_to_cell(r, c),
                'orientation': DIR_TO_ORIENT[d],
            },
        }

    if t == 's':
        _, target = action_tuple
        sc_info = _game.find(s_before, 'scarab', player)
        tg_info = _game.find(s_before, target,   player)
        return {
            'action': 'EXCHANGE',
            'cell':   rc_to_cell(sc_info[0], sc_info[1]),
            'result': rc_to_cell(tg_info[0], tg_info[1]),
        }

    raise ValueError(f'Unknown internal action type: {t!r}')
