// probe_ponder.js — diagnostic: does a warm TT from ponder actually make
// v20's choose() faster or deeper at the ponder→choose handoff?
//
// Protocol:
//   1. Replay a few moves from a known seed using top-ordered moves to
//      reach Sprev (opponent = P1 to move). This is the ponder root.
//   2. Pick M = top-ordered P1 move at Sprev (the move ponder would
//      explore first). S = doMove(Sprev, M) is the choose() root — our
//      test agent plays as P2.
//   3. Cold: clearTT, fresh AB, choose(S). Record (lastDepth, nodes, ms).
//   4. Warm: clearTT, fresh AB, ponderStart(Sprev), wait 180ms for slices,
//      ponderStop, buildResumeHint(M), choose(S, hint). Record same.
//   5. Print side-by-side.
//
// If warm ≈ cold across positions, the ponder→choose handoff is broken.
// If warm is clearly better, the handoff works and the harness is what's
// starving ponder during real games.

const {
  initRandom, makeInitialPositions, stateFromInitialPositions,
  doMove, orderedMoves, moveBufs, terminal,
} = require('./game.js');
const v20 = require('./aiV20.js');

const TEST_PLAYER    = 2;
const SEARCH_TIME    = 0.18;
const PONDER_WAIT_MS = 180;

function replay(seed, nMoves) {
  const s0 = initRandom(seed);
  const ip = makeInitialPositions(s0);
  let s = stateFromInitialPositions(ip);
  for (let i = 0; i < nMoves; i++) {
    if (terminal(s)) return s;
    const { count } = orderedMoves(s, 0);
    if (count === 0) return s;
    const move = moveBufs[0][0];
    s = doMove(s, move);
  }
  return s;
}

async function probeOne(seed, nMoves) {
  const Sprev = replay(seed, nMoves);
  if (terminal(Sprev)) {
    console.log(`seed=${seed} N=${nMoves}  skipped (terminal)`);
    return;
  }
  if (Sprev.turn !== 1) {
    console.log(`seed=${seed} N=${nMoves}  skipped (Sprev.turn=${Sprev.turn}, need 1)`);
    return;
  }
  const { count } = orderedMoves(Sprev, 0);
  if (count === 0) {
    console.log(`seed=${seed} N=${nMoves}  skipped (no moves)`);
    return;
  }
  const M = moveBufs[0][0];
  const S = doMove(Sprev, M);

  // --- Cold ---
  v20.clearTT();
  const aiCold = new v20.AB(TEST_PLAYER, SEARCH_TIME);
  const t0c = Date.now();
  aiCold.choose(S);
  const dtC = Date.now() - t0c;
  const dC  = aiCold.lastDepth;
  const nC  = aiCold.nodes;

  // --- Warm ---
  v20.clearTT();
  const aiWarm = new v20.AB(TEST_PLAYER, SEARCH_TIME);
  aiWarm.ponderStart(Sprev);
  await new Promise((r) => setTimeout(r, PONDER_WAIT_MS));
  const slices = aiWarm.ponderSlices;
  const pMaxD  = aiWarm.ponderMaxDepth;
  aiWarm.ponderStop();
  const hint = aiWarm.buildResumeHint(M);
  const t0w = Date.now();
  aiWarm.choose(S, hint);
  const dtW = Date.now() - t0w;
  const dW  = aiWarm.lastDepth;
  const nW  = aiWarm.nodes;

  const dn = nC === 0 ? 'n/a' : (((nW - nC) / nC) * 100).toFixed(1) + '%';
  console.log(
    `seed=${seed} N=${nMoves}  ` +
    `COLD d=${dC} n=${nC.toString().padStart(6)} ${dtC.toString().padStart(4)}ms  |  ` +
    `WARM d=${dW} n=${nW.toString().padStart(6)} ${dtW.toString().padStart(4)}ms  ` +
    `Δnodes=${dn.toString().padStart(7)}  (pSlices=${slices} pMaxD=${pMaxD} hint=${hint ? 'Y' : 'N'})`
  );
}

(async () => {
  console.log('Cold vs warm choose() A/B — TEST_PLAYER=P2, wait=180ms');
  for (const seed of [0, 1, 2, 3, 4]) {
    for (const n of [0, 2, 4, 6, 8, 10]) {
      await probeOne(seed, n);
    }
    console.log('');
  }
})();
