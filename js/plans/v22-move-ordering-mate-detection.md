# v22/v23: laser-aware move ordering to replace the depth-1 scan

## Problem

v21 fixes the observed 1-ply-mate bug class but does it the brute-force way: at every `_search` node with `depth === 1 && fullLen > MOVE_CAP`, it iterates every `A_P` placement in the raw move list, does a `doMoveInPlace` / check `state.win` / `undoMove`, and returns MATE on a hit. The fix works — over 100 games v21 eliminates all 3 qualifying loss-pairs against v19 and goes 71-28-0 against v20 — but the cost is steep:

- `choose v21 nodes: avg/call` drops from v20's ~55k to ~10k in a v20-v21 A/B (200-game seed 1000 run).
- `Depth v21: avg` drops from v20's 3.5-4.5 to v21's 1.6-4.0 across different ply buckets.
- Think time per `nextMove` falls to 107ms (v19-v21) vs v20's 181ms — v21 is returning early from completed iterations because depth progression stalled, not because it found a mate.

Symptom interpretation: the scan runs at **every** pruned depth-1 node (~50% of depth-1 nodes have `fullLen > 24`) and at each hit costs ~40 doMove/undoMove × ~3μs = ~120μs. With ~10-50k depth-1 nodes per `choose()`, scan overhead reaches 1-5 seconds — far beyond the 230ms budget. The result is that the iterative-deepening loop can only complete depths 1-2 on most turns, and v21 routinely plays moves selected by a shallower search than v20 would.

v21 still wins the head-to-head because it now **avoids** placements whose children mate, even without ordering or evaluation changes. But against a future v24+ that fixes the same bug differently (or against itself), v21's shallow search would bleed ELO. The fix is correct, not cheap.

**Goal of this plan**: prototype two alternative fixes that change move ordering (not search behavior) so the mating move enters the top-`MOVE_CAP` naturally, preserving v20's full search depth and speed while keeping v21's defense against the bug class.

## Current understanding of the bug

From the investigation that produced v21:

- The bug class is **placements whose laser-redirect mate is invisible to positional scoring**. `scoreAndTopK` in [moveOrderingV19.js:99-149](../moveOrderingV19.js#L99-L149) ranks placements by Manhattan distance to opponent pharaoh, sphinx alignment, forward direction, and own-half bias. None of these features reflect that the placement, combined with the mover's own laser, directly captures the opponent pharaoh.
- Mating placements are almost always **adjacent to or on the current laser path** of the mover's sphinx — the placed pyramid changes what the beam hits or reflects into. So a signal of the form "is this placement near the mover's own laser path?" would catch almost all mating placements without an expensive doMove/undo.
- The raw move list at mid-game is typically 30-80 moves. Non-placements fill ~8-15 slots; placements fill ~20-60. `MOVE_CAP = 24`. So placements that rank below the top ~10-15 get pruned. A fix that promotes all "laser-near" placements to the top slots should close the hole.

## Options

### Option (a) — SHIPPED as v21 (depth-1 terminal-pre-scan)

For reference. See [js/aiV21.js](../aiV21.js). Correct but expensive.

### Option (b) — unconditionally include all A_P moves near the laser path

In the interior move ordering, after scoring placements, **also** keep any placement that lands on a cell reachable from the mover's laser path (or within N cells of a path cell), regardless of its positional score. These moves either enter the search's top-`MOVE_CAP` alongside the scored top placements, or — if the combined set exceeds `MOVE_CAP` — the laser-near ones displace the weakest positional picks.

**Key technical question**: how do we identify laser-near cells cheaply?

`laser(s, pl, outHits)` at [game.js:106-160](../game.js#L106-L160) walks the beam and returns hit cells — pieces that stopped or interacted with the beam. It does NOT return path cells (empty squares the beam passed through). The bug class needs path cells: a pyramid dropped on a path cell changes the beam direction, and that's the mating case.

Two ways to get path cells:

1. **Add `laserPath(s, pl, outPath)`** — a new helper in [game.js](../game.js) that walks the same beam and writes every visited cell (empty or piece) into `outPath`. Share the logic with `laser()` via a private inner function that takes a callback (or a mode flag). Cost: one extra helper, ~30 lines, no hot-path impact because only interior-move-ordering calls it.
2. **Approximate with hit cells only** — use `laser()`'s existing hit cells and declare "laser-near" to mean "within 2 chebyshev steps of any hit cell". Misses placements that redirect the beam from an empty path cell, which is probably the majority of the bug class. Probably not enough.

**Recommendation**: build `laserPath()` and use it.

**Implementation sketch**:

```js
// In stagedInteriorMovesV19 (or a v22 variant), after building _placeBuf:
const pathCount = laserPath(state, mover, _laserPathBuf);
// Mark all cells within 1 chebyshev of any path cell.
_laserNear.fill(0);
for (let i = 0; i < pathCount; i++) {
  const cell = _laserPathBuf[i];
  const cr = (cell / 10) | 0, cc = cell - cr * 10;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const nr = cr + dr, nc = cc + dc;
      if (nr >= 0 && nr < 10 && nc >= 0 && nc < 10) {
        _laserNear[nr * 10 + nc] = 1;
      }
    }
  }
}
// In scoreAndTopK or a wrapping function: boost score of any
// placement whose destination cell is laser-near by a large bonus
// (e.g. +100) so it ranks above positional picks. Cap total output
// at MOVE_CAP as usual.
```

**Cost estimate**: `laserPath()` is ~30 steps per call. `_laserNear` fill is 10×10 = 100 cells × ~9 neighbors each = ~300 writes. Total per depth-1 node: ~400 ops, ~2-4μs. At 50k depth-1 nodes, ~100-200ms — still significant but much less than v21's ~1-5s. And this cost pays for itself by enabling ALL depths to see the mating move, not just depth 1.

**Caveat — applies at every depth, not just 1**. Option (b) changes move ordering at every interior node. That means it helps detect mate-in-1 at depth=1 AND pre-position placements at depth>1 that could lead to deeper mates. But the cost is also incurred at every depth, not just depth=1. Will need to gate on "this is an interior node where placements are actually being pruned" — same `fullLen > MOVE_CAP` check — to avoid wasting work on shallow nodes.

### Option (c) — raise `MOVE_CAP` when opponent pharaoh is laser-reachable

Simplest possible fix: at interior nodes where the mover could conceivably win via a laser tactic, expand the move list from top-24 to top-`MOVE_CAP_TACTICAL` (say 48 or all moves). "Conceivably" is cheap to detect: if the opponent pharaoh is on, adjacent to, or one-redirect away from the mover's laser path, any nearby placement is potentially tactical.

**Implementation sketch**:

```js
// In stagedInteriorMovesV19 (or a v23 variant), before computing `limit`:
const pathCount = laserPath(state, mover, _laserPathBuf);
let oppPhNear = false;
for (let i = 0; i < pathCount; i++) {
  const cell = _laserPathBuf[i];
  if (cell === oppPhCell) { oppPhNear = true; break; }
  const cr = (cell / 10) | 0, cc = cell - cr * 10;
  const opr = (oppPhCell / 10) | 0, opc = oppPhCell - opr * 10;
  if (Math.abs(cr - opr) + Math.abs(cc - opc) <= 2) {
    oppPhNear = true;
    break;
  }
}
const effectiveCap = oppPhNear ? MOVE_CAP_TACTICAL : MOVE_CAP;
```

Then `limit = Math.min(nOrdered, effectiveCap)` and the rest of the search proceeds as usual.

**Cost estimate**: `laserPath()` + the pharaoh-proximity check ~40 ops per call, ~0.5-1μs per depth-1 node. At 50k nodes, ~25-50ms. Very cheap. But when the gate fires, the search at that node does ~2x more work (twice as many moves), and those moves propagate recursively — so the subtree cost multiplies. Expected overall overhead: 5-15% depending on gate firing rate.

**Caveat — bluntness**. Every move above the top-24 gets explored, not just the mating ones. The extra search cost buys correctness but nothing else. Option (b)'s targeted promotion is cleaner.

**Caveat — depth ≤ 2 only?** At deep interior nodes (depth ≥ 3), the subtree blowup from raising the cap is multiplicative: depth 3 with 48 moves is ~2x depth 3 with 24, etc. Consider gating on `depth <= 2` so the extra moves only fire at leaves and their parents.

## Evaluation plan

### Step 1 — build `laserPath()` helper

Add `laserPath(s, pl, outPath)` to [js/game.js](../game.js) alongside `laser()`. Walk the same beam but write every visited cell (including empty pass-throughs) into `outPath`. Return count. Export from the module. This helper is shared by v22 and v23.

Smoke test: a 10-line unit test that sets up one trivial position and verifies `laserPath` returns the expected cells. Keep it inline as a standalone `node -e '...'` one-liner, not a new test file.

### Step 2 — fork v21 → v22 implementing option (b)

Copy v21 to [js/aiV22.js](../aiV22.js). Replace the depth-1 scan at [aiV21.js:244-265](../aiV21.js#L244-L265) with a modified call path that:

1. Computes `laserPath` once per interior node (gated on `fullLen > MOVE_CAP`).
2. Builds a `_laserNear[100]` Uint8Array marking cells within 1 Chebyshev step of any path cell.
3. Passes `_laserNear` into a v22 variant of `stagedInteriorMovesV19` — either by exporting a new function `stagedInteriorMovesV22` in [moveOrderingV19.js](../moveOrderingV19.js) or by inlining the needed logic in aiV22.js to avoid cross-version changes. Prefer the inlined variant for isolation.
4. In the placement-scoring step, add a large bonus (e.g. +100) to any placement whose destination is in `_laserNear`, so those placements rank above positional picks.
5. No other changes — the depth-1 scan is removed. Correctness relies entirely on move ordering now.

Register v22 in [index.js](../index.js) with its own TT.

### Step 3 — fork v21 → v23 implementing option (c)

Copy v21 to [js/aiV23.js](../aiV23.js). Same removal of the depth-1 scan. Add the `oppPhNear` check before computing `limit`:

```js
const MOVE_CAP_TACTICAL = 48;  // or all of fullLen, tbd
let effectiveCap = MOVE_CAP;
if (depth <= 2 && fullLen > MOVE_CAP) {
  // reuse laserPath helper from step 1
  // ...set effectiveCap = MOVE_CAP_TACTICAL if oppPhNear
}
const limit = nOrdered < effectiveCap ? nOrdered : effectiveCap;
```

Register v23 in [index.js](../index.js) with its own TT.

### Step 4 — A/B tournament

Run the existing uber harness with the four versions. Four comparisons, 200 games each, fresh seeds to avoid the seed-0 bias from earlier runs:

```sh
# Correctness: v22 and v23 should eliminate the same qualifying pairs as v21.
node js/uber.js --workers 4 --games 200 --seed 3000 --a v19 --b v22 --log-losses v22 --log-losses-file losses-v19v22.log
node js/uber.js --workers 4 --games 200 --seed 3000 --a v19 --b v23 --log-losses v23 --log-losses-file losses-v19v23.log

# Depth/speed recovery: v22 and v23 should score close to v20 in node count
# and avg depth, unlike v21.
node js/uber.js --workers 4 --games 200 --seed 4000 --a v20 --b v22
node js/uber.js --workers 4 --games 200 --seed 4000 --a v20 --b v23

# Head-to-head between the two fix approaches.
node js/uber.js --workers 4 --games 200 --seed 5000 --a v22 --b v23

# Sanity vs the existing v21.
node js/uber.js --workers 4 --games 200 --seed 6000 --a v21 --b v22
node js/uber.js --workers 4 --games 200 --seed 6000 --a v21 --b v23
```

### Step 5 — metrics to collect

For each run, from the tournament report:

- **Correctness**: `Logged N qualifying pairs` count. Goal: 0 for runs 1-2 (v19 vs vXX with v22/v23 as the tracked loser). Non-zero means the ordering fix missed some bug-class cases; fall back to option (a) or combine (a)+(b).
- **Depth recovery**: `Depth vXX: avg` for v22/v23 vs v20's baseline. Goal: within 0.3 of v20's avg depth across all ply buckets (not 1.6-4.0 like v21).
- **Node count**: `choose vXX nodes: avg/call`. Goal: within 20% of v20's (~55k), not v21's ~10k.
- **Win rate**: `Final: vXX N [P%]`. Strict goal: v22/v23 ≥ v21 against v19 and v20. Weak goal: v22/v23 ≥ v20 in head-to-head (i.e. the fix adds ELO net of its cost).
- **Wall time**: `Wall: Ns`. Goal: within 15% of the v19-v20 baseline (~88s for 100 games). Above 15% means the fix is too expensive and should be tightened.
- **v22 vs v23 head-to-head**: whichever wins the direct A/B is the preferred fix. If draw, prefer v22 (option b — more targeted, less multiplicative cost).

### Step 6 — decision matrix

| Scenario | Decision |
|---|---|
| Both fix the bug class AND recover depth AND win ≥ v20 | Ship the winner of v22-v23 direct A/B. Retire v21. |
| One fixes cleanly, the other regresses | Ship the clean one. Retire v21. |
| Both reduce qualifying pairs but don't zero them | Ship the combined v22/v23 + v21's scan as a fallback only-when-fullLen-much-greater-than-MOVE_CAP. Accept residual cost. |
| Both regress vs v21 in win rate | Keep v21. The scan's correctness guarantee matters more than the depth loss. File a v24 plan with a different approach (e.g. rework `scoreAndTopK` to include laser-redirect detection natively). |
| Both introduce a different bug class (games diverge from v20 on non-tactical positions) | Investigate divergences. Likely a move-ordering bug in the new scoring; fix before shipping. |

## Do NOT touch

- [js/aiV20.js](../aiV20.js), [js/aiV21.js](../aiV21.js), [js/aiV19.js](../aiV19.js), [js/aiV18.js](../aiV18.js). v22/v23 are new files.
- [js/moveOrderingV19.js](../moveOrderingV19.js)'s existing functions. Any shared helper (e.g. `stagedInteriorMovesV22`) should be additive, not a modification of existing exports, so v19/v20/v21 remain byte-identical.
- The tournament / uber harness. v22 and v23 register via [index.js](../index.js) like v21 did.
- The root immediate-win scan in `choose()`. Already correct.
- Ponder. v22/v23 inherit v20's ponder verbatim, same as v21.
- Transposition table layout. Each version gets its own TT instance.

## Risks and unknowns

- **`laserPath` might not catch all mating placements**. A placement 3+ cells from the path could still mate if it redirects a nearby piece's laser interaction. Verify against the 3 original qualifying pairs (seeds 24/27/+1 from the first run) before trusting the heuristic. If any of them isn't caught by "within 1 Chebyshev of laser path", widen to 2 Chebyshev and measure again.
- **Option (b)'s placement bonus interferes with normal ordering**. Adding +100 to laser-near placements might push them above legitimate tactical captures and rotations, hurting non-mate positions. Start with a smaller bonus (+20) and increase if qualifying pairs persist.
- **Option (c)'s multiplicative cost at depth ≥ 2 may dwarf option (a)'s overhead**. If the gate fires on 20% of nodes and each fire doubles the effective branching factor, effective cost grows ~1.2× per ply. Gate hard on `depth <= 1` if the 200-game sample shows this. Even `depth === 1` alone would cover the observed bug class.
- **Both fixes leave mate-in-2 unhandled**. The observed bug class is 1-ply, but mate-in-2 via a mispruned quiet move + tactical response is plausible and would not be caught by either fix. Out of scope for this plan; file a follow-up if the A/B suggests it matters.
- **v22 may expose a brand-new bug class**. Any change to move ordering can reshape the search tree in surprising ways. The v22-vs-v20 run is the first place a regression would show up; treat any win-rate loss against v20 as a blocker.

## Out of scope

- Rewriting `scoreAndTopK` to natively include laser tactics. Bigger project; do it only if v22/v23 both fail.
- Extending the fix to rotations or moves that can mate. Bug class observed so far is placements only.
- A learned move-ordering model. Not within Khet's scope.
- Replacing `MOVE_CAP` with a depth-dependent cap. Considered under option (c) but kept for a later plan if needed.
- Removing or changing ponder behavior. Orthogonal.

## Expected timeline

Prototyping both versions: ~2 hours. A/B tournament runs: ~20 minutes each for 4 comparisons = ~1.5 hours. Analysis and decision: ~30 minutes. Total: one focused afternoon.

## Verification checklist

Before shipping whichever of v22/v23 wins:

1. `node js/tournament.js --games 4 --seed 0 --a vXX --b vXX` — self-play smoke, no crashes.
2. `node js/uber.js --workers 2 --games 20 --seed 0 --a v20 --b vXX` — shallow-game behavioral equivalence. On games where `fullLen <= MOVE_CAP` always holds, vXX and v20 should produce identical move sequences.
3. Zero qualifying pairs in `losses-v19vXX.log` from run 1 at 200 games.
4. `Depth vXX: avg` within 0.3 of v20's across all buckets in run 2.
5. `Wall` within 15% of v19-v20 baseline in run 2.
6. Win rate vs v20 ≥ 50% in run 2.
