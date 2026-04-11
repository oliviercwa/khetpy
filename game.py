import random
from dataclasses import dataclass, field
from typing import List, NamedTuple, Optional

DIRS = {0: (-1, 0), 90: (0, 1), 180: (1, 0), 270: (0, -1)}
VALS = {'pharaoh': 1000, 'sphinx': 50, 'scarab': 40, 'anubis': 30, 'pyramid': 20}
PYR = {0: {270: 0, 180: 90}, 90: {0: 90, 270: 180},
       180: {0: 270, 90: 180}, 270: {90: 0, 180: 270}}

PYRAMID_RETURN_DELAY = 2
SWAP_COOLDOWN = 4
TURN_LIMIT = 100


class P(NamedTuple):
    """Piece. Immutable — rotation produces a new P.
    Fields: t=type, o=owner (1 or 2), d=direction (0/90/180/270).
    """
    t: str
    o: int
    d: int


@dataclass
class S:
    b: List[List[Optional[P]]] = field(
        default_factory=lambda: [[None] * 10 for _ in range(10)]
    )
    r: dict = field(default_factory=lambda: {1: 7, 2: 7})
    turn: int = 1
    ply: int = 0
    win: Optional[int] = None
    # Cached sphinx (row, col) per player.
    sph: dict = field(default_factory=lambda: {1: None, 2: None})
    # Swap cooldowns: cd[player]['sphinx'|'pharaoh']. 0 means available.
    cd: dict = field(default_factory=lambda: {
        1: {'sphinx': 0, 'pharaoh': 0},
        2: {'sphinx': 0, 'pharaoh': 0},
    })
    # Destroyed-pyramid return queue: list of (return_ply, owner).
    # When ns.ply >= return_ply, the pyramid is added to the opponent's reserve.
    pq: list = field(default_factory=list)


def inb(r, c):
    return 0 <= r < 10 and 0 <= c < 10


def find(s, t, o):
    for r in range(10):
        for c in range(10):
            p = s.b[r][c]
            if p and p.t == t and p.o == o:
                return r, c, p
    return None


def _pharaoh_pos(s, pl):
    f = find(s, 'pharaoh', pl)
    return (f[0], f[1]) if f else None


def init(seed=None):
    """Randomized point-symmetric initial layout per the rules doc."""
    if seed is not None:
        random.seed(seed)
    s = S()
    # Sphinx: row 0 / 9, random column. Laser is HORIZONTAL, facing the
    # side with the most available cells (per the rules). 90=east, 270=west.
    sc = random.randrange(10)
    sph_dir = 90 if (9 - sc) > sc else 270
    s.b[0][sc] = P('sphinx', 1, sph_dir)
    s.b[9][9 - sc] = P('sphinx', 2, (sph_dir + 180) % 360)

    # Pharaoh: row 2 / 7, random column (not edges, not sphinx columns,
    # and not the opponent-sphinx column which Anubis #2 will occupy on row 2).
    pc_forbidden = {0, 9, sc, 9 - sc}
    pc = random.choice([c for c in range(10) if c not in pc_forbidden])
    s.b[2][pc] = P('pharaoh', 1, 180)
    s.b[7][9 - pc] = P('pharaoh', 2, 180)

    # Anubis #1: own pharaoh column. P1 faces down, P2 faces up.
    s.b[4][pc] = P('anubis', 1, 180)
    s.b[5][9 - pc] = P('anubis', 2, 0)

    # Anubis #2: opponent's sphinx column, row 2 / 7, facing the opponent
    # (P1 faces south, P2 faces north) per the rules.
    s.b[2][9 - sc] = P('anubis', 1, 180)
    s.b[7][sc] = P('anubis', 2, 0)

    # Scarab: row 3 / 6, random empty column (point-symmetric).
    scc_choices = [
        c for c in range(10)
        if s.b[3][c] is None and s.b[6][9 - c] is None
    ]
    scc = random.choice(scc_choices)
    scarab_dir = random.choice((0, 90, 180, 270))
    s.b[3][scc] = P('scarab', 1, scarab_dir)
    s.b[6][9 - scc] = P('scarab', 2, (scarab_dir + 180) % 360)

    s.sph = {1: (0, sc), 2: (9, 9 - sc)}
    # 0 pyramids on board, 7 in reserve per player (S default).
    return s


def laser(s, pl):
    pos = s.sph.get(pl)
    if pos is None:
        return []
    r, c = pos
    p = s.b[r][c]
    if not p:
        return []
    d = p.d
    dr, dc = DIRS[d]
    nr = r + dr; nc = c + dc
    hit = []
    seen = set()
    while 0 <= nr < 10 and 0 <= nc < 10:
        key = (nr, nc, d)
        if key in seen:
            break
        seen.add(key)
        q = s.b[nr][nc]
        if not q:
            nr += dr; nc += dc
            continue
        inc = (d + 180) % 360
        qt = q.t
        if qt == 'sphinx':
            break
        if qt == 'pharaoh':
            hit.append((nr, nc, q))
            break
        if qt == 'anubis':
            if (q.d - inc) % 360 == 180:
                break
            hit.append((nr, nc, q))
            nr += dr; nc += dc
            continue
        if qt == 'pyramid':
            nd = PYR[q.d].get(inc)
            if nd is not None:
                d = nd
                dr, dc = DIRS[d]
                nr += dr; nc += dc
                continue
            hit.append((nr, nc, q))
            nr += dr; nc += dc
            continue
        if qt == 'scarab':
            if (q.d // 90) % 2 == 0:
                d = {0: 270, 90: 180, 180: 90, 270: 0}[inc]
            else:
                d = {0: 90, 90: 0, 180: 270, 270: 180}[inc]
            dr, dc = DIRS[d]
            nr += dr; nc += dc
            continue
    return hit


def _sphinx_cells(s):
    return [s.sph[1], s.sph[2]]


def place_legal(s, pl, r, c):
    if s.b[r][c] is not None:
        return False
    pp = _pharaoh_pos(s, pl)
    if pp is not None and abs(pp[0] - r) + abs(pp[1] - c) == 1:
        return False
    for cell in _sphinx_cells(s):
        if cell is None:
            continue
        sr, sccol = cell
        if abs(sr - r) + abs(sccol - c) == 1:
            return False
    return True


def moves(s):
    """Enumerate all legal actions for the active player (no truncation)."""
    pl = s.turn
    acts = []
    for r in range(10):
        for c in range(10):
            p = s.b[r][c]
            if not p or p.o != pl:
                continue
            if p.t != 'pharaoh':
                acts.append(('r', r, c, 1))
                acts.append(('r', r, c, -1))
            if p.t in ('anubis', 'pyramid', 'scarab'):
                for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                    nr, nc = r + dr, c + dc
                    if 0 <= nr < 10 and 0 <= nc < 10 and not s.b[nr][nc]:
                        acts.append(('m', r, c, nr, nc))
    if s.r[pl] > 0:
        for r in range(10):
            for c in range(10):
                if place_legal(s, pl, r, c):
                    for d in (0, 90, 180, 270):
                        acts.append(('p', r, c, d))
    # Swap: Scarab exchanges with own Sphinx or Pharaoh if cooldown is 0.
    if find(s, 'scarab', pl) is not None:
        if s.cd[pl]['sphinx'] == 0 and find(s, 'sphinx', pl) is not None:
            acts.append(('s', 'sphinx'))
        if s.cd[pl]['pharaoh'] == 0 and find(s, 'pharaoh', pl) is not None:
            acts.append(('s', 'pharaoh'))
    random.shuffle(acts)
    return acts


def _copy_cd(cd):
    return {1: dict(cd[1]), 2: dict(cd[2])}


def do(s, a):
    ns = S()
    ns.b = [row[:] for row in s.b]
    ns.r = s.r.copy()
    ns.turn = 3 - s.turn
    ns.ply = s.ply + 1
    ns.win = None
    ns.sph = dict(s.sph)
    ns.cd = _copy_cd(s.cd)
    ns.pq = list(s.pq)

    t = a[0]
    fire_laser = True

    if t == 'r':
        _, r, c, dd = a
        p = ns.b[r][c]
        ns.b[r][c] = P(p.t, p.o, (p.d + (90 if dd == 1 else -90)) % 360)
    elif t == 'm':
        _, r, c, nr, nc = a
        ns.b[nr][nc] = ns.b[r][c]
        ns.b[r][c] = None
    elif t == 'p':
        _, r, c, dd = a
        ns.b[r][c] = P('pyramid', s.turn, dd)
        ns.r[s.turn] -= 1
    elif t == 's':
        _, target = a
        sf = find(ns, 'scarab', s.turn)
        tf = find(ns, target, s.turn)
        if sf and tf:
            sr, sc, sp = sf
            tr, tc, tp = tf
            ns.b[sr][sc] = tp
            ns.b[tr][tc] = sp
            if target == 'sphinx':
                # Sphinx moved; update cached position. Skip laser this turn.
                ns.sph[s.turn] = (sr, sc)
                ns.cd[s.turn]['sphinx'] = SWAP_COOLDOWN
                fire_laser = False
            else:
                ns.cd[s.turn]['pharaoh'] = SWAP_COOLDOWN

    # Fire laser for the acting player (unless suppressed by sphinx swap).
    pharaoh_losers = []
    ns.hit_count = 0  # Non-breaking: used by ai_ab_v19 quiescence for loudness.
    if fire_laser:
        hit = laser(ns, s.turn)
        for hr, hc, hp in hit:
            cur = ns.b[hr][hc]
            if not (cur and cur.t == hp.t and cur.o == hp.o):
                continue
            ns.hit_count += 1
            if hp.t == 'pharaoh':
                pharaoh_losers.append(hp.o)
                ns.b[hr][hc] = None
            else:
                ns.b[hr][hc] = None
                if hp.t == 'pyramid':
                    ns.pq.append((ns.ply + PYRAMID_RETURN_DELAY, hp.o))
        if pharaoh_losers:
            losers = set(pharaoh_losers)
            if len(losers) == 2:
                ns.win = 0  # Both Pharaohs destroyed simultaneously — draw.
            else:
                ns.win = 3 - next(iter(losers))

    # Decrement all swap cooldowns after the turn's action + laser.
    for pl in (1, 2):
        for k in ('sphinx', 'pharaoh'):
            if ns.cd[pl][k] > 0:
                ns.cd[pl][k] -= 1

    # Process pyramid return queue — returns go to OPPONENT of the owner.
    if ns.pq:
        remaining = []
        for rp, owner in ns.pq:
            if rp <= ns.ply:
                ns.r[3 - owner] += 1
            else:
                remaining.append((rp, owner))
        ns.pq = remaining

    # Turn limit with material tiebreak.
    if ns.ply >= TURN_LIMIT and ns.win is None:
        m1 = m2 = 0
        for row in ns.b:
            for p in row:
                if p:
                    v = VALS[p.t]
                    if p.o == 1:
                        m1 += v
                    else:
                        m2 += v
        if m1 > m2:
            ns.win = 1
        elif m2 > m1:
            ns.win = 2
        else:
            ns.win = 0

    return ns


def terminal(s):
    return s.win is not None


def evalf(s, pl):
    if s.win is not None:
        if s.win == 0:
            return 0
        return 100000 if s.win == pl else -100000
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
        elif p.t == 'pyramid':
            sc -= 200
    sc -= s.ply * 2
    return sc
