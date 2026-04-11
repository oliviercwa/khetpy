# AI Versions

Changelog for the `ai_ab_v*.py` alpha-beta AIs. Each version is a distinct
file so older versions stay runnable for head-to-head comparison via
`cli.py --p1 vXX --p2 vYY`.

All versions share [game.py](../game.py) as the engine (via the
[game_v13.py](../game_v13.py) shim for back-compat).

---

## v13 — Baseline minimax

**File:** [ai_ab_v13.py](../ai_ab_v13.py)

Minimal alpha-beta with iterative deepening. Used as the baseline against
which every later version is measured.

- **Search:** min/max alpha-beta, iterative deepening depths 1–8
- **Move generation:** `game.moves()` — shuffled, capped at 16 root / 10 internal
- **Scoring:** `game.evalf()` — material + forward-advance bonus + laser-threat heuristics
- **Time management:** 90% margin on `self.t`; timeout checks every 256 nodes
- **No transposition table. No pondering. No TT move ordering.**

Branches aggressively in the engine move list but has no memory between
searches within a game.

---

## v15 — Negamax + transposition table + pondering

**File:** [ai_ab_v15.py](../ai_ab_v15.py)

Full rewrite of the search around negamax with a fail-soft transposition
table, keeping v13's scoring semantics unchanged.

### Search changes vs v13

- **Negamax** instead of separate min/max branches — halves the code and
  makes alpha-beta bounds tighter via score negation.
- **Fail-soft TT** with EXACT / LOWER / UPPER flags. Cut-offs on lower bounds
  at `v >= beta`, upper bounds at `v <= alpha`, exact matches at any depth.
- **TT move ordering** at both root and internal nodes — the previous
  iteration's best move is tried first, which dramatically improves cutoff
  quality.
- **Deterministic `ordered_moves()`** (no `random.shuffle`) — the v13 base
  `moves()` shuffles every call, which would poison TT reuse across
  iterations. v15 ports the generator without the shuffle.
- **Root reordering between iterations** — the iteration-N best move
  becomes iteration-(N+1)'s first move.
- **MOVE_CAP=24** at every node (matches v13's branching factor for fair
  comparison).

### Transposition table

- Python `dict` keyed by `hs(s)` — tuple-based hash of board, turn,
  reserves, ply, and win flag. **Ply is included** because `evalf` has a
  `-ply*2` term; omitting it would let TT entries return stale values.
- Simple replacement policy: when `len(tt) >= 500_000`, clear and refill.
- Prefer deeper entries on store (`prev[0] <= depth`).

### Pondering

Optional (`ponder=True`). After `choose()` picks a move, a background
thread keeps searching from the post-move state with **no deadline**,
stopping only when `stop_flag` is set. The next `choose()` stops the
ponder thread first, then uses the TT entries it produced to jump-start
its own search.

- Tighter 80% time margin when pondering (was 90%) — accounts for GIL
  contention and the 10–30ms it takes the ponder thread to notice the
  stop flag.
- Workers run in separate processes so ponder truly uses idle CPU
  instead of stealing cycles via the GIL.

### Measured impact


#### No Pondering
'''
Final: V13 334 - V15 666 - Draws 0
Avg moves: 4.1
Avg v13: 6,712 (1,648/move)
Avg v15: 10,478 (2,573/move)
Depth  v13: min=1 avg=3.06 max=8
Depth  v15: min=2 avg=3.39 max=8
Think  v13: min=0.5ms avg=161.3ms max=182.9ms  (violations: 5)
Think  v15: min=2.1ms avg=162.6ms max=169.1ms  (violations: 0)
TT     v13: no TT activity
TT     v15: probes=1,409,707 hit=23.0% cutoff=12.2% move_used=10.8% peak=42,371

Win length distribution:
moves  | v13 won | v15 won |  Total
-------+---------+---------+-------
0      |       0 |       0 |      0
1      |     261 |     261 |    522
2      |       0 |      17 |     17
3      |      21 |      92 |    113
4      |       5 |      46 |     51
5      |      20 |      41 |     61
6-10   |      14 |     158 |    172
11-20  |       8 |      34 |     42
21-50  |       4 |      13 |     17
51-100 |       1 |       4 |      5
>100   |       0 |       0 |      0

Budget: 180ms/move
'''

#### With Pondering
'''
Final: V13 319 - V15 681 - Draws 0
Avg moves: 3.9
Avg v13: 6,056 (1,537/move)
Avg v15: 9,012 (2,287/move)
Depth  v13: min=1 avg=3.06 max=8
Depth  v15: min=2 avg=3.28 max=8
Think  v13: min=0.5ms avg=161.5ms max=183.9ms  (violations: 10)
Think  v15: min=13.7ms avg=163.0ms max=184.9ms  (violations: 38)
TT     v13: no TT activity
TT     v15: probes=2,588,809 hit=27.2% cutoff=16.1% move_used=11.2% peak=87,684

Win length distribution:
moves  | v13 won | v15 won |  Total
-------+---------+---------+-------
0      |       0 |       0 |      0
1      |     261 |     261 |    522
2      |       0 |      17 |     17
3      |      21 |     101 |    122
4      |       3 |      43 |     46
5      |      17 |      37 |     54
6-10   |      10 |     175 |    185
11-20  |       4 |      33 |     37
21-50  |       2 |       9 |     11
51-100 |       1 |       5 |      6
>100   |       0 |       0 |      0
'''

---

## v16 — v15 + full-root search + mate-only early break

**File:** [ai_ab_v16.py](../ai_ab_v16.py)

Forked from v15. Three targeted search fixes plus one shared-eval bug fix
aimed at two concrete pathologies diagnosed from `trace.log`:

1. v15 under-uses its budget on positions where a shallow search sees an
   apparent pharaoh-threat.
2. v15 picks moves that walk into 1- and 2-move kills because the
   defensive response is never searched at the root.

### Changes vs v15

- **Full root search (no `MOVE_CAP` at the root).** v15 capped the root
  move list to 24 in `ordered_moves()` scan order (rotates → slides →
  placements → swaps) with no threat-aware preference. A correct
  defensive move can easily fall outside the first 24 and never be
  considered. v16 searches all legal root moves; the interior
  `MOVE_CAP=24` in `_s()` is unchanged.
- **Mate-only early break.** v15's `if bv > 40000: break` in the ID loop
  caught `evalf`'s static `+50000` "my laser aims at enemy pharaoh"
  heuristic, which is a defensible one-ply threat, not a forced mate.
  v16 raises the threshold to `bv >= 90000` — only true wins
  (`evalf` returns ±100000 on terminal states) terminate the ID loop.
  This closes the "30.8ms at depth=3" budget leak observed in v15 and
  forces v16 to keep verifying shallow threats deeper.
- **ID ceiling raised 9 → 13.** Harmless — the deadline still bounds
  actual depth. Only matters on forced lines where v15 currently
  completes depth 8 early with unused time.

### Shared eval fix (in `game.py`, affects all engines)

- **Symmetric pyramid-hit penalty.** `evalf` scored `+200` for "own
  laser hits opponent pyramid" but had **no penalty** for the opponent
  case. v16 adds `elif p.t == 'pyramid': sc -= 200` to the `ho` loop.
  This is the bug previously patched locally in `evalf_v19`; v16
  promotes the fix into the shared `game.py` so every engine benefits.

### Measured impact

100-game tournament, v15 vs v16 @ 0.18s/move, swapped pairing:

```
Final: V15 432 - V16 568 - Draws 0
Avg moves: 6.1
Avg v15: 11,984 (1,950/move)
Avg v16: 12,118 (1,972/move)
Depth  v15: min=2 avg=3.27 max=8
Depth  v16: min=1 avg=2.03 max=5
Think  v15: min=2.5ms avg=153.2ms max=187.9ms  (violations: 78)
Think  v16: min=11.5ms avg=164.8ms max=183.3ms  (violations: 16)
TT     v15: probes=3,964,980 hit=31.1% cutoff=18.7% move_used=12.3% peak=96,806
TT     v16: probes=3,685,985 hit=25.1% cutoff=12.2% move_used=12.9% peak=101,001
Ponder v15: p_nodes=15,154,665 p_stores=1,826,154 p_hit_on_stored=168,502 (9.2% of stores) p_cutoff_on_stored=76,325 (4.2% of stores)
Ponder v16: p_nodes=14,764,334 p_stores=1,779,776 p_hit_on_stored=105,297 (5.9% of stores) p_cutoff_on_stored=95,304 (5.4% of stores)

Win length distribution:
moves  | v15 won | v16 won |  Total
-------+---------+---------+-------
0      |       0 |       0 |      0
1      |     261 |     261 |    522
2      |       0 |       0 |      0
3      |      64 |      23 |     87
4      |      34 |      49 |     83
5      |      15 |      32 |     47
6-10   |      38 |     111 |    149
11-20  |      12 |      46 |     58
21-50  |       5 |      31 |     36
51-100 |       3 |      15 |     18
>100   |       0 |       0 |      0
```

**Interpretation:** v16 wins +14 games (57–43) despite completing
*shallower* average depth (2.39 vs 3.70). Two reasons:

1. Removing the root cap widens the branching factor at the root, so
   each ID iteration at the same depth does strictly more work.
2. The mate-only early break forces v16 to keep searching past shallow
   threats that v15 was breaking on. v15's higher avg depth is partly
   inflated by early breaks at depth 3 — it wasn't actually evaluating
   deeper in general, it was just *exiting* earlier on illusory wins.

Nodes/move dropped slightly (3,303 vs 3,500) because v16 spends its
time more often on wider shallow searches instead of narrow early-exit
ones. Max think time (168.2ms) stays within the 180ms budget. No
violations.

### Running the comparison

```bash
python cli.py --games 100 --p1 v15 --p2 v16 --time 0.18 --swap
```

---

## v17 — v16 + staged tactical move ordering

**File:** [ai_ab_v17.py](../ai_ab_v17.py)
**Ordering module:** [move_ordering.py](../move_ordering.py)

Clean fork of v16. Same search semantics (uncapped root, ID 1–14,
mate-only early break at `bv >= 90000`) with two move-ordering changes:

- **Root:** empirical prior scoring via `move_ordering.score_moves()`.
- **Interior nodes:** staged generation via
  `move_ordering.staged_interior_moves()` with placement quota,
  class-priority ordering, killer moves, and history heuristic.

### Motivation

v16's move ordering is simple: TT move first, then whatever
`ordered_moves()` emits (rotates → slides → placements → swaps),
truncated to `MOVE_CAP=24`. Two problems:

1. **Placement flooding.** With reserves > 0, placements generate
   4 orientations × many squares (200–300 candidates). In v16 they come
   last and rarely make the 24-move cut. Yet endgame statistics show
   90.8% of winning last moves are pyramid placements.
2. **No depth-dependent priority.** The same ordering applies whether
   the search is 1 ply from the horizon (where the killing move matters)
   or 6 plies deep (where positional setup moves matter). Different
   depths need different move categories first.

### Architecture: `move_ordering.py`

A separate module with two public APIs:

- **`score_moves(s, acts, depth, tt_move)`** — root-level scoring.
  Applies depth-dependent empirical prior tables (`PRIOR_1` through
  `PRIOR_4P`) scaled by a phase weight (endgame vs midgame), plus a
  large TT-move bonus. Returns all moves sorted best-first. Used only
  at the root where we search every legal move uncapped.

- **`staged_interior_moves(s, all_moves, depth, tt_move, killers,
  history, opp_pharaoh)`** — staged generation for interior nodes.
  Phases:
  1. TT move (if legal)
  2. Killer moves (non-placement only, 2-slot per ply)
  3. Non-placement classes in depth-dependent priority order
  4. Top-K placements (cheap static ranking by pharaoh distance,
     zone, sphinx corridor, orientation)
  5. Remaining placements (low priority)

  The caller applies `MOVE_CAP=24` after staging.

### Key design decisions

- **Placement quota by depth.** `K=6` for `own_turns_left ≤ 1` (the
  killing move), `K=4` for `==2`, `K=2` for `≥ 3`. This admits a few
  high-quality placements without flooding the cap.

- **Class-priority ordering varies by depth bucket.** Three priority
  orders tuned from endgame statistics:
  - `otl=1`: pyramid moves → sphinx rotates → scarab swaps → ...
  - `otl=2`: sphinx rotates → scarab swaps → pyramid moves → ...
  - `otl≥3`: pyramid moves → scarab moves → scarab swaps → ...

- **History heuristic for intra-class tiebreaking only.** On beta cutoff:
  `history[move] += depth * depth`. Within each class bucket, moves are
  sorted by descending history score. This avoids the failure mode of
  global history sort (promoting irrelevant moves across positions).

- **Killers are non-placement only.** Placement moves are too
  position-specific to transfer between sibling nodes.

- **Cheap static placement ranking** — no per-move simulation. Scores
  by Manhattan distance to opponent pharaoh, opponent-half zone bonus,
  sphinx corridor bonus, and forward-facing orientation bonus. Uses
  decorated-sort-undecorate with negated scores for a single C-level
  ascending sort.

### Performance optimizations

- **Inlined `place_legal` in `ordered_moves()`.** The original
  `place_legal → _pharaoh_pos → find` performed a full 10×10 board scan
  per candidate cell (~38k `find()` calls per profiled game). v17 caches
  pharaoh and sphinx positions during the single board scan and
  pre-computes a `blocked` set of adjacent cells. Result: `find()`
  dropped from 0.087s to 0.001s.

- **`ordered_moves()` returns `(acts, opp_pharaoh)`.** The opponent
  pharaoh position, found during the board scan, is passed through to
  `staged_interior_moves` for placement ranking — no redundant search.

- **Inlined `abs()` in placement ranking.** Replaced `abs(dr)` with
  `(dr if dr >= 0 else -dr)` to eliminate 493k function-call overhead.

### Changes vs v16 (search)

- `_s()` takes an extra `ply` parameter for killer table indexing.
- Beta cutoff records killers (non-placement, 2-slot shift) and
  history (`depth * depth` increment).
- Both tables cleared per `choose()`.
- Ponder loop uses `staged_interior_moves` instead of simple TT
  front-insert.

### Measured impact (no pondering)

2000-game tournament, v16 vs v17 @ 0.18s/move, swapped pairing:

```
Final: V16 849 - V17 1102 - Draws 49
Avg moves: 11.0
Avg v16: 39,176 (3,572/move)
Avg v17: 37,077 (3,381/move)
Depth  v16: min=1 avg=2.59 max=13
Depth  v17: min=2 avg=3.26 max=13
Think  v16: min=1.4ms avg=157.4ms max=164.5ms  (violations: 0)
Think  v17: min=1.2ms avg=160.4ms max=164.7ms  (violations: 0)

Win length distribution:
moves  | v16 won | v17 won |  Total
-------+---------+---------+-------
0      |       0 |       0 |      0
1      |     555 |     555 |   1110
2      |       0 |       0 |      0
3      |       1 |      73 |     74
4      |      27 |       1 |     28
5      |      53 |     148 |    201
6-10   |      87 |     135 |    222
11-20  |      56 |      88 |    144
21-50  |      43 |      42 |     85
51-100 |      27 |      60 |     87
>100   |       0 |       0 |      0
```

**Interpretation:** v17 wins 56.5% of decisive games. Key signals:

- **3-move bucket completely reversed:** v17=73, v16=1. The staged
  ordering puts killing placements and sphinx rotates first at shallow
  depth, letting v17 find short mates that v16 misses.
- **5-move bucket nearly 3:1:** v17=148, v16=53. Same mechanism at
  slightly deeper search.
- **Depth advantage:** v17 averages 3.26 vs v16's 2.59 despite similar
  node throughput (37k vs 39k). Better ordering → more cutoffs → deeper
  search per node budget.
- **Long games (51-100) favor v17 2:1.** The depth advantage compounds
  in positional play.
- **Zero timing violations** on both sides.

### Running the comparison

```bash
python cli.py --games 50 --workers 10 --p1 v16 --p2 v17 --time 0.18 --swap
```

### Failed experiments

Three prior v17 attempts failed before the staged ordering approach:

**1. Ply-gated v15/v16 hybrid** — Lost 524-475. Phase-gated the v15/v16
knobs by `state.ply` (aggressive before ply 6, deep after). The
`bv > 40000` early break at low ply poisoned the TT with overconfident
scores. Ply-gating is the wrong axis.

**2. Killer + history heuristic (global sort)** — Tied 492-493. Applied
killer moves and history-sorted move ordering globally (not staged).
3-move bucket collapsed from 43 to 4. The history table promotes moves
that caused cutoffs in unrelated positions — harmful in laser chess where
kills are highly positional.

**3. Killer only (no history)** — Tied 495-487. 3-move bucket collapsed
from 29 to 0. Same problem: killers from sibling nodes are almost never
relevant to the current position.

The staged approach succeeds where these failed by (a) limiting killers
and history to intra-class tiebreaking rather than global reordering,
and (b) using depth-dependent class priority instead of a single static
order.

### Ponder flag

`--ponder` enables pondering for every active engine that supports it
(v15, v16, v17, plus archived v17_old/v18_old/v19_old). v13 has no ponder
path and silently ignores the flag. To measure whether pondering actually
helps, run the same matchup twice with and without `--ponder` and compare
win rates — the A/B delta is the only measurement that accounts for
ponder competing with the opponent for wall-clock CPU.

---

## ARCHIVE

The following versions have been archived and renamed with an `_old` suffix.
They remain runnable via `--p1 vXX_old` / `--p2 vXX_old` but are no longer
part of the active development line.

- **v17_old** — Zobrist hashing ([ai_ab_v17_old.py](../ai_ab_v17_old.py))
- **v18_old** — killer moves + history heuristic ([ai_ab_v18_old.py](../ai_ab_v18_old.py))
- **v19_old** — better eval + quiescence ([ai_ab_v19_old.py](../ai_ab_v19_old.py))

---

## v17_old — Zobrist hashing

**File:** [ai_ab_v17_old.py](../ai_ab_v17_old.py)

Identical to v15 except for the state-hash function `hs()`. Everything
else (negamax, TT flags, pondering, move ordering, move cap) is
byte-for-byte unchanged.

### Motivation

Profiling showed v15's `hs()` at ~0.9s cumulative in a 2s bench — the
second-biggest hotspot after the core search — because it builds a
nested tuple (`tuple(tuple((p.t, p.o, p.d) if p else None for p in row) for row in s.b)`)
every call. That's 100 piece-tuples + 10 row-tuples + 1 outer tuple per
hash, then Python's built-in `hash()` on top.

### Zobrist implementation

- Precompute 64-bit random keys (`random.getrandbits(64)`) for every
  `(row, col, piece_type, owner, orientation)` tuple — 10×10×5×2×4 = 4000
  keys — plus separate keys for turn, each reserve count, each ply, and
  each win state.
- Seeded deterministically with `Random(0xC0FFEE)` so TT lookups are
  stable across runs within a process.
- `hs(s)` walks the board once and XORs a single dict lookup per
  occupied square. No intermediate tuples, no recursive hashing.
- Semantics preserved: ply is still mixed in (evalf has `-ply*2`), so TT
  value-correctness matches v15.

### Performance notes

Zobrist `hs()` is ~2× cheaper per call, but the overall speedup is more
modest because `hs()` is only ~9% of total CPU. Under a 0.18s/move
budget the measured node-rate difference is in the noise (~5,675 vs
~5,818 nodes/move over 20 swapped games) — expected to compound more
visibly at longer time controls where the search spends a larger
fraction of time inside the TT lookup path.

### Correctness verification

Diagnosed "V15 20-0 V17 in 7 moves" as a **harness artifact**, not a v17
bug:

1. `game.init(seed)` builds a fixed board regardless of seed.
2. Neither `ai_ab_v15` nor `ai_ab_v17` uses randomness in search.
3. Therefore every game is bit-identical → p1's forced 7-ply tactical
   win fires every time.

Fix landed in `cli.py`: `--swap` flag (alternate sides) and `--opening N`
flag (play N random plies before AI takes over). With both enabled, v15
and v17 score within noise over 10-game pilots, and game lengths range
from 5 to 96 moves — confirming genuine diversity.

---

## Version selection matrix (active engines)

| Feature | v13 | v15 | v16 | v17 |
|---|---|---|---|---|
| Search | min/max αβ | negamax αβ | negamax αβ | negamax αβ |
| Transposition table | ❌ | ✅ fail-soft | ✅ fail-soft | ✅ fail-soft |
| TT move ordering | ❌ | ✅ | ✅ | ✅ |
| Deterministic move gen | ❌ (shuffled) | ✅ | ✅ | ✅ |
| Pondering | ❌ | ✅ optional | ✅ optional | ✅ optional |
| Root move cap | 16 | 24 | uncapped | uncapped |
| Root move scoring | — | — | TT front-insert | empirical prior |
| Interior move ordering | — | — | TT front-insert | staged (class-priority + killers + history) |
| Placement quota | — | — | — | K=2–6 by depth |
| ID depth ceiling | 8 | 9 | 14 | 14 |
| Early-break threshold | — | `>40000` | `>=90000` | `>=90000` |
| TT instrumentation counters | ❌ | ✅ | ✅ | ✅ |
| Supported by `worker.py` | ✅ | ✅ | ✅ | ✅ |

---

## Running comparisons

All versions ship through the same worker protocol, so any pair can be
matched up on the CLI:

```bash
# Deterministic engines need side-swap to be compared meaningfully.
python cli.py --games 100 --p1 v16 --p2 v17 --time 0.18 --swap
python cli.py --games 100 --p1 v15 --p2 v17 --time 0.18 --swap --debug-tt
```

Use a longer time budget (`--time 0.5`) to let TT-heavy versions
exercise more of their depth advantage.

---

## v17 postmortem (100-game run @ 0.18s/move)

Measured result with `--games 100 --swap --opening 4`:

```
Final: V15 49 - V17 51 - Draws 0
Avg moves: 5.7
Avg v15: 16,910 (2,982/move)
Avg v17: 16,903 (2,981/move)
Depth  v15: min=2 avg=3.22 max=8
Depth  v17: min=2 avg=3.24 max=8
Think  v15: min=1.5ms avg=160.8ms max=168.1ms
Think  v17: min=1.5ms avg=160.7ms max=168.0ms
```

**Interpretation:** Zobrist hashing produced a real but tiny node-rate
gain, far below the ~1.5× hash-call speedup suggested by isolated
benchmarks. The extra nodes did not translate into wins — within the
statistical noise for a 100-game sample, v15 and v17 are equivalent.

### Why it didn't help (profile data)

`python tools/profile_v15.py` run over 7 plies of v15 self-play
(~54k nodes, 0.977s of CPU). Top of tottime table:

| ncalls | tottime | cumtime | function |
|---|---|---|---|
| 144,741 | 0.201s (20.6%) | 0.286s | `game.laser` |
| 45,197 | 0.151s (15.5%) | 0.325s | `game.evalf` |
| 7,593 | 0.104s (10.6%) | 0.155s | `ai_ab_v15.ordered_moves` |
| 99,121 + 991,210 | 0.136s (13.9%) | — | `hs` inner genexprs (tuple build) |
| 54,703 | 0.079s (8.1%) | 0.273s | `game.do` |
| 872,109 | 0.072s (7.4%) | — | `set.add` (from `laser`'s `seen`) |
| 54,208 | 0.060s (6.1%) | 0.970s | `ai_ab_v15._s` (recursive) |
| 9,011 | 0.013s (1.3%) | 0.152s | `ai_ab_v15.hs` (self only) |

Hash microbenchmark (200k calls on the start position):

| version | per-call | ratio |
|---|---|---|
| v15 `hs` (nested tuples) | 3.463 µs | 1.00× |
| v17 `hs` (Zobrist XOR) | 2.369 µs | **1.46× faster** |

Zobrist is genuinely faster in isolation — but `hs()` is only ~14% of
total CPU (tuple construction + Python-level hash call combined), so a
1.46× hash speedup produces at most a ~4% overall gain, and in practice
less because TT probe cost is only half of `hs`'s call sites. The
observed +1.7% nodes matches this model closely.

### The real hotspots

`laser()` (20.6%) + `evalf()` (15.5%) = **36% of CPU**. Both are
recomputed from scratch at every leaf node, and `laser()` is called 3×
per leaf evaluation (twice by `evalf` for own/opponent rays, once by
`do` after every move). Neither has any incremental state.

`ordered_moves()` (10.6%) is a full 10×10 board scan on every `_s()`
invocation.

**All five top functions are double-loops over a Python nested list.**
The architectural problem is not one specific hot spot — it's the
absence of incremental state across moves.

---

## Next-gain assessment

Ranked by expected impact, given the profile above:

| Idea | Expected gain | Risk / cost | Rationale |
|---|---|---|---|
| **Killer moves + history heuristic** | Medium (10–25% nodes) | **Low** | Pure AI-file change, no `game.py` touch. Better move ordering → more cutoffs → fewer `_s` calls → fewer `evalf`/`laser`/`do` calls. Directly attacks the hottest path by calling it less. |
| **Incremental piece list + material eval** | High (20–40%) | Medium | Eliminates the 10×10 scans in `ordered_moves` and the material portion of `evalf`. Requires extending `S` with a piece list maintained inside `do()`. |
| **Shrink `laser()`** — replace `seen` set with max-bounce counter; inline `DIRS` lookup | Medium (5–15%) | Low | `set.add` alone is 7.4% of CPU. Laser rays bounce at most ~8 times in practice — a counter is enough to prevent infinite loops. |
| **Cache `laser()` result per state** inside `evalf` | Small (3–5%) | Low | `evalf` calls `laser` twice on the same state (own and opponent). If we restructured to share the ray computation, we save 1 of every 3 laser calls. |
| **Principal Variation Search (PVS)** | Low-medium (5–15% nodes) | Low | Replace plain negamax with PVS in `_s()`. Compounds with TT move ordering; largest gain on well-ordered trees. |
| **Quiescence search** | Unknown | Medium | Laser games have huge eval swings when a laser is about to fire — static eval at depth 0 is noisy. **But:** profile shows `evalf`/`laser` already dominate; extending search until "quiet" would make leaf-node work more expensive, so this only helps if it also reduces horizon-effect blunders by a wide margin. Needs an incremental eval to be affordable. |
| **Incremental Zobrist updates** in `do()` | Small (~5%) | Medium | Only worth doing if `hs()` is still in the top-5 after other fixes. Currently low priority. |
| **Aspiration windows** in ID root | Low (3–10%) | Low | Cheap to add once PVS is in place. |
| **Flat `bytearray` board** | Medium-high | **High** | Big rewrite of `game.py`. Deferred — touches v13 compatibility. |

### Recommended next version: **v18 — TBD**

v17 already implements killer moves + history heuristic (the previous
recommendation) as part of staged interior ordering. The next gain likely
comes from one of: incremental piece list + material eval, PVS, or
shrinking `laser()` overhead.

### Tools

- `tools/profile_v15.py` — cProfile harness over an in-process v15
  self-play game (bypasses IPC for clean attribution) + v15-vs-v17
  `hs()` microbenchmark. Run with `python tools/profile_v15.py`.

---

## v19_old — v18 + improved eval + quiescence search (both kill-switchable)

**File:** [ai_ab_v19_old.py](../ai_ab_v19_old.py)

Forked from v18. Adds two independent strength mechanisms, each
toggleable from the CLI (`--v19-eval on|off`, `--v19-qs on|off`) so
their contributions can be measured in isolation. With both flags off,
v19 is a byte-equivalent clone of v18 (used as a sanity baseline).

### Motivation

The v18 tournament log showed many 3–5 move games. Investigation
confirmed these are random-opening artifacts (swap-pairing already
cancels them out), but it surfaced three real eval weaknesses in
`game.evalf`:

1. **Pyramid asymmetry** (bug). The own-laser branch credits threatening
   an enemy pyramid (+200) but the opponent-laser branch has no pyramid
   penalty — v18 literally sees offensive pyramid threats without the
   defensive counterpart. See [game.py:205-216](../game.py#L205-L216).
2. **No pharaoh safety.** `evalf` doesn't know "enemy sphinx is one
   rotation away from a pharaoh-killing ray." Short games are positions
   where that rotation-distance = 1; the AI has no incentive to avoid
   entering them.
3. **No reserve value.** `s.r[pl]` is ignored, so pyramids-in-reserve
   are worth zero.

And one structural weakness:

4. **Horizon effect at laser fire.** Leaf eval at depth 0 is noisy
   precisely because the next ply can fire a laser that swings eval by
   hundreds. Textbook case for quiescence search.

### Eval upgrade (`evalf_v19`)

Local to `ai_ab_v19.py`; `game.py::evalf` is unchanged so older versions
behave identically. Changes:

- **Fix pyramid asymmetry:** add `elif p.t == 'pyramid': sc -= 200` to
  the opponent-hit loop.
- **Pharaoh safety term:** for each of the 4 rotations of the enemy
  sphinx, temporarily substitute that orientation and call `laser()`.
  The smallest number of 90° rotations that produce a pharaoh-hitting
  ray is the rotation distance. Penalty table:
  `{1: -300, 2: -120, 3: -40}`. Symmetric bonus for our own rotation
  reach toward the enemy pharaoh. Up to 8 extra `laser()` calls per
  leaf — expensive enough that the kill-switch is essential.
- **Reserve value:** `sc += 10 * (s.r[pl] - s.r[op])`. Latent material.
- `sc -= s.ply * 2` preserved for TT value consistency.

Helper: `_laser_with_sphinx_rot(s, pl, new_d)` shallow-mutates one
board cell, calls `laser()`, restores — cheaper than `do()` because it
skips the full state copy.

### Quiescence search (`_qs`)

Fail-soft quiescence with stand-pat at every node. At main-search depth
0, `_s()` descends into `_qs()` instead of returning the static eval.
QS only recurses on **loud moves** — moves whose laser fire captured at
least one piece.

- **Loudness detection:** `ai_ab_v19._is_loud(ns)` reads `ns.hit_count`,
  a new non-breaking field set inside `game.do()` to the number of
  pieces destroyed by the laser on that move. Defaults to 0, so older
  AIs that don't read it are unaffected. See [game.py](../game.py).
- **QS move cap:** `QS_MOVE_CAP = 8`. Without a cap, QS called `do()`
  on all ~50 candidate moves per node just to filter for loudness,
  blowing the time budget. With the cap, QS only examines the 8 most
  history-promising moves per node.
- **QS depth cap:** `QS_MAX_PLY = 3`. Prevents pathological capture
  chains from dominating the budget.
- **Tighter time margin** when QS is on: 0.82 (vs 0.90 for v18) so
  the variable QS cost doesn't push us over 0.18s/move.
- **Timeout granularity:** `(self.nodes & 15) == 0` inside `_qs`, vs
  `& 63` in main search — QS leaves are expensive enough that a coarse
  check was letting us overrun.
- **TT is NOT written from QS.** QS values are not depth-indexed; mixing
  them into the main TT would corrupt depth-based probes.

### Kill-switch wiring

`AB.__init__` takes `better_eval: bool` and `quiescence: bool` (both
default True). CLI passes them via new reset fields; `worker.py::_build_ai`
forwards them to the v19 constructor. Older versions ignore the fields.

### Smoke test results (6 games each, v18 vs v19 at 0.18s/move)

| Mode | Result | v19 nodes/move | v19 depth avg | v19 max time |
|---|---|---|---|---|
| `--v19-eval off --v19-qs off` (sanity) | V19 4-2 | 7,332 | 4.13 | 163.3ms ✓ |
| `--v19-eval on  --v19-qs off` (eval only) | 3-3 | 4,392 | 4.05 | 164.6ms ✓ |
| `--v19-eval off --v19-qs on`  (QS only)  | V19 2-4 | 3,245 | 3.28 | 150.0ms ✓ |
| `--v19-eval on  --v19-qs on`  (both)     | V19 2-4 | 3,414 | 3.37 | 149.7ms ✓ |

Sanity mode confirms the fork is clean (near-identical to v18). All
modes stay under the 180ms budget after the QS optimizations. The
smoke samples are too small to conclude strength — all results within
6-game noise. A 100-game tournament comparison in each mode is the
next step.

### Running the four-mode comparison

```bash
python cli.py --games 100 --p1 v18 --p2 v19 --time 0.18 --swap --opening 4 --v19-eval off --v19-qs off  # sanity
python cli.py --games 100 --p1 v18 --p2 v19 --time 0.18 --swap --opening 4 --v19-eval on  --v19-qs off  # eval only
python cli.py --games 100 --p1 v18 --p2 v19 --time 0.18 --swap --opening 4 --v19-eval off --v19-qs on   # QS only
python cli.py --games 100 --p1 v18 --p2 v19 --time 0.18 --swap --opening 4 --v19-eval on  --v19-qs on   # both
```

---

### New: per-move depth logging

`cli.py` now prints, per game, the min/avg/max iterative-deepening
depth completed by each side, and a tournament-wide summary per label.
This makes it possible to tell whether a change actually deepens the
search (the metric we care about) rather than just shifting node
counts. Example from a 4-game `v15 vs v17` pilot:

### Results

#### Running 100 games: V18 vs V19
python cli.py --games 100 --p1 v18 --p2 v19 --time 0.18 --swap --opening 4 --v19-eval on --v19-qs off
Running 100 games: V18 vs V19
Time: 0.18s/move  (measured wall-clock at controller, incl. IPC)
Workers: 2 processes (each AI fully isolated — no GIL/GC contention)
v13 = baseline
v15 = v13 + TT + negamax
v17 = v15 + Zobrist hashing
v18 = v15 + killer moves + history heuristic
v19 = v18 + better eval (on) + quiescence (off)





```
Depth  v15: min=2 avg=3.95 max=6
Depth  v17: min=2 avg=4.00 max=7
```

