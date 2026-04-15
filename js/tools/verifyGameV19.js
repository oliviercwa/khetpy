// Probe 1: state-equivalence verifier for doMoveInPlace / undoMove.
//
// For every (position, legal move) pair in a fuzzed corpus:
//   1. `expected` = doMove(clone(s), m)          // v18 reference
//   2. `rec` = doMoveInPlace(s, m, 0)            // v19 under test
//   3. assert s field-equal to expected (board, scalars, pq)
//   4. assert s.idxH === initIdxH(expected), s.verH === initVerH(expected)
//   5. undoMove(s, rec)
//   6. assert s field-equal to the pre-move snapshot (incl. idxH/verH)
//   7. re-apply doMoveInPlace(s, m, 0) to advance the fuzzer
//
// First mismatch wins: we print the field, the move, and both states so the
// bug's identity is obvious from the log. Usage:
//
//   node js/tools/verifyGameV19.js               # default corpus
//   node js/tools/verifyGameV19.js --seeds 200   # 200 seeds
//   node js/tools/verifyGameV19.js --plies 300   # per-seed ply cap

const {
  initRandom, makeInitialPositions, stateFromInitialPositions,
  doMove, orderedMoves, moveBufs,
} = require('../game.js');
const {
  doMoveInPlace, undoMove, zobristInit, initIdxH, initVerH,
} = require('../gameV19.js');

// --- CLI ---
const argv = process.argv.slice(2);
const opts = { seeds: 50, plies: 400, startSeed: 0, verbose: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if      (a === '--seeds')      opts.seeds     = parseInt(argv[++i], 10);
  else if (a === '--plies')      opts.plies     = parseInt(argv[++i], 10);
  else if (a === '--start-seed') opts.startSeed = parseInt(argv[++i], 10);
  else if (a === '-v')           opts.verbose   = true;
  else if (a === '-h' || a === '--help') {
    console.log('Usage: node verifyGameV19.js [--seeds N] [--plies P] [--start-seed S] [-v]');
    process.exit(0);
  }
}

// --- Utilities ---

// Deep-ish clone including v19-only idxH/verH fields.
function cloneFull(s) {
  return {
    b: s.b.slice(),
    r1: s.r1, r2: s.r2,
    turn: s.turn, ply: s.ply, win: s.win,
    sph1: s.sph1, sph2: s.sph2,
    cd1s: s.cd1s, cd1p: s.cd1p, cd2s: s.cd2s, cd2p: s.cd2p,
    pq: s.pq ? s.pq.slice() : null,
    idxH: s.idxH | 0,
    verH: s.verH | 0,
  };
}

// Clone that matches what game.js's doMove expects (no idxH/verH required).
// doMove reads from the state but does not rely on idxH/verH, so cloneFull is
// safe to pass in too.
function cloneForDoMove(s) {
  return {
    b: s.b.slice(),
    r1: s.r1, r2: s.r2,
    turn: s.turn, ply: s.ply, win: s.win,
    sph1: s.sph1, sph2: s.sph2,
    cd1s: s.cd1s, cd1p: s.cd1p, cd2s: s.cd2s, cd2p: s.cd2p,
    pq: s.pq ? s.pq.slice() : null,
  };
}

const SCALAR_FIELDS = [
  'r1', 'r2', 'turn', 'ply', 'win',
  'sph1', 'sph2',
  'cd1s', 'cd1p', 'cd2s', 'cd2p',
];

function diffBoard(a, b) {
  for (let i = 0; i < 100; i++) {
    if (a[i] !== b[i]) return `b[${i}]: ${a[i]} vs ${b[i]}`;
  }
  return null;
}

function diffPq(a, b) {
  const aNull = a === null;
  const bNull = b === null;
  if (aNull && bNull) return null;
  if (aNull !== bNull) return `pq: ${aNull ? 'null' : JSON.stringify(a)} vs ${bNull ? 'null' : JSON.stringify(b)}`;
  if (a.length !== b.length) return `pq.length: ${a.length} vs ${b.length}`;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return `pq[${i}]: ${a[i]} vs ${b[i]}`;
  }
  return null;
}

// Compare scalar + board + pq fields only (no hashes).
function diffStateNoHash(actual, expected) {
  for (const f of SCALAR_FIELDS) {
    if (actual[f] !== expected[f]) return `${f}: ${actual[f]} vs ${expected[f]}`;
  }
  const bDiff = diffBoard(actual.b, expected.b);
  if (bDiff) return bDiff;
  return diffPq(actual.pq, expected.pq);
}

// Compare everything including idxH/verH (used for post-undo checks).
function diffStateFull(actual, expected) {
  const base = diffStateNoHash(actual, expected);
  if (base) return base;
  if (actual.idxH !== expected.idxH) return `idxH: ${actual.idxH} vs ${expected.idxH}`;
  if (actual.verH !== expected.verH) return `verH: ${actual.verH} vs ${expected.verH}`;
  return null;
}

function decodeMove(m) {
  const code = (m >>> 28) & 0xF;
  if (code === 1) return `ROT r=${(m>>>24)&0xF} c=${(m>>>20)&0xF} dir=${(m>>>19)&1}`;
  if (code === 2) return `MOV r=${(m>>>24)&0xF} c=${(m>>>20)&0xF} -> r=${(m>>>16)&0xF} c=${(m>>>12)&0xF}`;
  if (code === 3) return `PLC r=${(m>>>24)&0xF} c=${(m>>>20)&0xF} d=${(m>>>18)&3}`;
  if (code === 4) return `SWP tgt=${m&1}`;
  return `??? 0x${(m >>> 0).toString(16)}`;
}

function dumpState(label, s) {
  const parts = [];
  parts.push(`turn=${s.turn} ply=${s.ply} win=${s.win}`);
  parts.push(`r1=${s.r1} r2=${s.r2}`);
  parts.push(`sph1=${s.sph1} sph2=${s.sph2}`);
  parts.push(`cd=${s.cd1s}/${s.cd1p}/${s.cd2s}/${s.cd2p}`);
  parts.push(`pq=${s.pq ? JSON.stringify(s.pq) : 'null'}`);
  if (s.idxH !== undefined) parts.push(`idxH=${s.idxH} verH=${s.verH}`);
  console.log(`  ${label}: ${parts.join(' ')}`);
  // Dump non-empty board cells
  const cells = [];
  for (let i = 0; i < 100; i++) if (s.b[i] !== 0) cells.push(`${i}:${s.b[i]}`);
  console.log(`    b: ${cells.join(' ')}`);
}

// Tiny deterministic RNG so move selection is reproducible per seed.
function mulberry32(seed) {
  let a = (seed | 0) >>> 0;
  return function() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Verifier core ---

function reportFailure(ctx) {
  console.log('');
  console.log('=== FIRST MISMATCH ===');
  console.log(`seed=${ctx.seed} ply=${ctx.plyInGame} stage=${ctx.stage}`);
  console.log(`field: ${ctx.field}`);
  console.log(`move: ${decodeMove(ctx.move)}  (raw=0x${(ctx.move >>> 0).toString(16)})`);
  dumpState('before   ', ctx.before);
  if (ctx.expected) dumpState('expected ', ctx.expected);
  if (ctx.actual)   dumpState('actual   ', ctx.actual);
  console.log('=======================');
}

function verifyAndAdvance(s, m, ctx) {
  const before = cloneFull(s);
  const expected = doMove(cloneForDoMove(s), m);

  const rec = doMoveInPlace(s, m, 0);

  // Post-move field check (no hashes — expected has none).
  const postMismatch = diffStateNoHash(s, expected);
  if (postMismatch) {
    ctx.stage = 'post-move';
    ctx.field = postMismatch;
    ctx.before = before;
    ctx.expected = expected;
    ctx.actual = cloneFull(s);
    ctx.move = m;
    return false;
  }

  // Post-move hash check: v19's incremental must equal a from-scratch initIdxH/initVerH
  // on the reference post-move state.
  const expIdxH = initIdxH(expected);
  if (s.idxH !== expIdxH) {
    ctx.stage = 'post-move';
    ctx.field = `idxH: ${s.idxH} vs ${expIdxH}`;
    ctx.before = before;
    ctx.expected = expected;
    ctx.actual = cloneFull(s);
    ctx.move = m;
    return false;
  }
  const expVerH = initVerH(expected);
  if (s.verH !== expVerH) {
    ctx.stage = 'post-move';
    ctx.field = `verH: ${s.verH} vs ${expVerH}`;
    ctx.before = before;
    ctx.expected = expected;
    ctx.actual = cloneFull(s);
    ctx.move = m;
    return false;
  }

  // Undo and verify restoration against the snapshot (INCLUDING hashes).
  undoMove(s, rec);
  const undoMismatch = diffStateFull(s, before);
  if (undoMismatch) {
    ctx.stage = 'post-undo';
    ctx.field = undoMismatch;
    ctx.before = before;
    ctx.expected = null;
    ctx.actual = cloneFull(s);
    ctx.move = m;
    return false;
  }

  // Re-apply to advance (record discarded — we don't undo the advance).
  doMoveInPlace(s, m, 0);
  return true;
}

// Exhaustive-at-ply fuzzer: at each ply, verify do/undo on EVERY legal
// move (this is what alpha-beta actually asks of the primitive), then pick
// one move at random to advance the game.
function runSeed(seed) {
  const s0 = initRandom(seed);
  const ip = makeInitialPositions(s0);
  let s = stateFromInitialPositions(ip);
  zobristInit(s);

  const rng = mulberry32(seed ^ 0xDEADBEEF);
  const ctx = { seed, plyInGame: 0 };
  let steps = 0;

  // Local copy of the move list so we don't alias moveBufs[0] while we
  // iterate (defensive — doMove/doMoveInPlace don't touch it today).
  const localMoves = new Int32Array(500);

  while (s.win === 0 && s.ply < opts.plies) {
    const { count } = orderedMoves(s, 0);
    if (count === 0) break;
    const buf = moveBufs[0];
    for (let i = 0; i < count; i++) localMoves[i] = buf[i];

    ctx.plyInGame = s.ply;

    // Verify do/undo roundtrip on every legal move without advancing.
    const beforeSnap = cloneFull(s);
    for (let i = 0; i < count; i++) {
      const m = localMoves[i];
      const expected = doMove(cloneForDoMove(s), m);
      const rec = doMoveInPlace(s, m, 0);

      const postMismatch = diffStateNoHash(s, expected);
      if (postMismatch) {
        ctx.stage = 'post-move (roundtrip)';
        ctx.field = postMismatch;
        ctx.before = beforeSnap;
        ctx.expected = expected;
        ctx.actual = cloneFull(s);
        ctx.move = m;
        reportFailure(ctx);
        return { ok: false, steps };
      }
      const expIdxH = initIdxH(expected);
      if (s.idxH !== expIdxH) {
        ctx.stage = 'post-move (roundtrip)';
        ctx.field = `idxH: ${s.idxH} vs ${expIdxH}`;
        ctx.before = beforeSnap;
        ctx.expected = expected;
        ctx.actual = cloneFull(s);
        ctx.move = m;
        reportFailure(ctx);
        return { ok: false, steps };
      }
      const expVerH = initVerH(expected);
      if (s.verH !== expVerH) {
        ctx.stage = 'post-move (roundtrip)';
        ctx.field = `verH: ${s.verH} vs ${expVerH}`;
        ctx.before = beforeSnap;
        ctx.expected = expected;
        ctx.actual = cloneFull(s);
        ctx.move = m;
        reportFailure(ctx);
        return { ok: false, steps };
      }

      undoMove(s, rec);
      const undoMismatch = diffStateFull(s, beforeSnap);
      if (undoMismatch) {
        ctx.stage = 'post-undo (roundtrip)';
        ctx.field = undoMismatch;
        ctx.before = beforeSnap;
        ctx.expected = null;
        ctx.actual = cloneFull(s);
        ctx.move = m;
        reportFailure(ctx);
        return { ok: false, steps };
      }
      steps++;
    }

    // Advance on one random move.
    const idx = (rng() * count) | 0;
    const advance = localMoves[idx];
    doMoveInPlace(s, advance, 0);
  }
  return { ok: true, steps };
}

// --- Main ---

console.log(`verifyGameV19: seeds=${opts.seeds} start=${opts.startSeed} plies<=${opts.plies}`);
const t0 = Date.now();
let totalSteps = 0;
for (let i = 0; i < opts.seeds; i++) {
  const seed = opts.startSeed + i;
  const { ok, steps } = runSeed(seed);
  totalSteps += steps;
  if (!ok) {
    console.log(`FAIL at seed=${seed} after ${steps} verified steps (${totalSteps} total)`);
    process.exit(1);
  }
  if (opts.verbose) console.log(`seed=${seed}: OK (${steps} steps)`);
}
const dt = (Date.now() - t0) / 1000;
console.log(`OK: ${totalSteps} moves verified across ${opts.seeds} seeds in ${dt.toFixed(2)}s`);
