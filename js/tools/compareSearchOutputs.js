// Probe 2: v18 vs v19 fixed-depth search-output diff.
//
// v19's stated invariant (aiV19.js:7-8): "move order and values are
// bit-identical to v18 for the moves that alpha-beta actually explores."
// If that holds, at any given root depth D, v18 and v19 must pick the same
// root move with the same root score. Any disagreement at matched depth is
// a correctness bug — NOT just v19 searching deeper thanks to make/unmake.
//
// This tool drives the shipped v18 and v19 internal _search methods at a
// *fixed* depth (bypassing iterative-deepening and time budgets), then
// compares (move, score) pairs at every depth from 1..maxDepth on a corpus
// of mid-game positions.
//
// Usage:
//   node js/tools/compareSearchOutputs.js --positions 100 --depth 4

const {
  initRandom, makeInitialPositions, stateFromInitialPositions,
  doMove, orderedMoves, moveBufs,
} = require('../game.js');
const { doMoveInPlace, undoMove, zobristInit } = require('../gameV19.js');
const aiV18 = require('../aiV18.js');
const aiV19 = require('../aiV19.js');

// --- CLI ---
const argv = process.argv.slice(2);
const opts = {
  positions: 100,
  maxDepth: 4,
  startSeed: 0,
  minPly: 4,
  maxPly: 60,
  verbose: false,
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if      (a === '--positions')  opts.positions = parseInt(argv[++i], 10);
  else if (a === '--depth')      opts.maxDepth  = parseInt(argv[++i], 10);
  else if (a === '--start-seed') opts.startSeed = parseInt(argv[++i], 10);
  else if (a === '--min-ply')    opts.minPly    = parseInt(argv[++i], 10);
  else if (a === '--max-ply')    opts.maxPly    = parseInt(argv[++i], 10);
  else if (a === '-v')           opts.verbose   = true;
  else if (a === '-h' || a === '--help') {
    console.log('Usage: node compareSearchOutputs.js [--positions N] [--depth D] [--start-seed S] [--min-ply P] [--max-ply P] [-v]');
    process.exit(0);
  }
}

const INF = 1000000000;

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

function decodeMove(m) {
  const code = (m >>> 28) & 0xF;
  if (code === 1) return `ROT r=${(m>>>24)&0xF} c=${(m>>>20)&0xF} dir=${(m>>>19)&1}`;
  if (code === 2) return `MOV r=${(m>>>24)&0xF} c=${(m>>>20)&0xF} -> r=${(m>>>16)&0xF} c=${(m>>>12)&0xF}`;
  if (code === 3) return `PLC r=${(m>>>24)&0xF} c=${(m>>>20)&0xF} d=${(m>>>18)&3}`;
  if (code === 4) return `SWP tgt=${m&1}`;
  return `??? 0x${(m >>> 0).toString(16)}`;
}

// --- Fixed-depth drivers ---
//
// Mirror the root loop in each AI's choose() but without time checks and
// with an explicit depth parameter. Each driver is purely additive — it
// never mutates the shipped AI module.

// v18 driver: clone-based. Uses doMove from game.js.
function searchFixedV18(s, maxDepth) {
  aiV18.clearTT();
  const ai = new aiV18.AB(s.turn, 1e9);
  ai.deadline = Number.POSITIVE_INFINITY;
  ai.nodes = 0;
  ai.lastDepth = 0;
  ai.killers.fill(0);
  ai.history.clear();

  const root = cloneForDoMove(s);
  const { count } = orderedMoves(root, 0);
  if (count === 0) return { perDepth: [], reason: 'no-moves' };

  // Snapshot root move list so we iterate in a stable order independent
  // of whatever scratchBufs[1..] re-ordering the interior search does.
  const rootMoves = new Int32Array(count);
  const rootBuf = moveBufs[0];
  for (let i = 0; i < count; i++) rootMoves[i] = rootBuf[i];

  const perDepth = [];
  for (let depth = 1; depth <= maxDepth; depth++) {
    let bv = -INF, bb = 0, alpha = -INF;
    const beta = INF;
    for (let i = 0; i < count; i++) {
      const a = rootMoves[i];
      const ns = doMove(root, a);
      const v = -ai._search(ns, depth - 1, -beta, -alpha, 1, 1);
      if (v > bv) { bv = v; bb = a; }
      if (v > alpha) alpha = v;
    }
    perDepth.push({ depth, move: bb, score: bv });
  }
  return { perDepth, nodes: ai.nodes };
}

// v19 driver: make/unmake. Uses doMoveInPlace/undoMove from gameV19.js.
function searchFixedV19(s, maxDepth) {
  aiV19.clearTT();
  const ai = new aiV19.AB(s.turn, 1e9);
  ai.deadline = Number.POSITIVE_INFINITY;
  ai.nodes = 0;
  ai.lastDepth = 0;
  ai.killers.fill(0);
  ai.history.clear();

  const root = cloneForDoMove(s);
  zobristInit(root);
  const { count } = orderedMoves(root, 0);
  if (count === 0) return { perDepth: [], reason: 'no-moves' };

  const rootMoves = new Int32Array(count);
  const rootBuf = moveBufs[0];
  for (let i = 0; i < count; i++) rootMoves[i] = rootBuf[i];

  const perDepth = [];
  for (let depth = 1; depth <= maxDepth; depth++) {
    let bv = -INF, bb = 0, alpha = -INF;
    const beta = INF;
    for (let i = 0; i < count; i++) {
      const a = rootMoves[i];
      const rec = doMoveInPlace(root, a, 0);
      let v;
      try {
        v = -ai._search(root, depth - 1, -beta, -alpha, 1, 1);
      } finally {
        undoMove(root, rec);
      }
      if (v > bv) { bv = v; bb = a; }
      if (v > alpha) alpha = v;
    }
    perDepth.push({ depth, move: bb, score: bv });
  }
  return { perDepth, nodes: ai.nodes };
}

// --- Corpus ---

function buildCorpus(n) {
  const corpus = [];
  let seed = opts.startSeed;
  while (corpus.length < n) {
    const s0 = initRandom(seed);
    const ip = makeInitialPositions(s0);
    let s = stateFromInitialPositions(ip);
    const rng = mulberry32(seed ^ 0x12345678);
    const targetPly = opts.minPly + ((rng() * (opts.maxPly - opts.minPly)) | 0);
    while (s.ply < targetPly && s.win === 0) {
      const { count } = orderedMoves(s, 0);
      if (count === 0) break;
      const buf = moveBufs[0];
      const idx = (rng() * count) | 0;
      s = doMove(s, buf[idx]);
    }
    seed++;
    if (s.win !== 0) continue;
    corpus.push(s);
  }
  return corpus;
}

// --- Main ---

console.log(`compareSearchOutputs: positions=${opts.positions} depth=1..${opts.maxDepth} ply=[${opts.minPly},${opts.maxPly}]`);
const corpus = buildCorpus(opts.positions);
console.log(`corpus built: ${corpus.length} positions`);

let totalPerDepth = new Array(opts.maxDepth + 1).fill(0);
let mismatchPerDepth = new Array(opts.maxDepth + 1).fill(0);
let scoreMismatchPerDepth = new Array(opts.maxDepth + 1).fill(0);
const firstFailures = [];

const t0 = Date.now();
for (let i = 0; i < corpus.length; i++) {
  const s = corpus[i];
  const a = searchFixedV18(s, opts.maxDepth);
  const b = searchFixedV19(s, opts.maxDepth);

  const len = Math.min(a.perDepth.length, b.perDepth.length);
  for (let d = 0; d < len; d++) {
    const depth = a.perDepth[d].depth;
    totalPerDepth[depth]++;
    const moveDiff  = a.perDepth[d].move  !== b.perDepth[d].move;
    const scoreDiff = a.perDepth[d].score !== b.perDepth[d].score;
    if (scoreDiff) scoreMismatchPerDepth[depth]++;
    if (moveDiff) {
      mismatchPerDepth[depth]++;
      if (firstFailures.length < 10) {
        firstFailures.push({
          pos: i, ply: s.ply, turn: s.turn, depth,
          v18Move: a.perDepth[d].move, v18Score: a.perDepth[d].score,
          v19Move: b.perDepth[d].move, v19Score: b.perDepth[d].score,
          state: s,
        });
      }
    }
  }
}
const dt = (Date.now() - t0) / 1000;

console.log('');
console.log(`Ran ${corpus.length} positions × depths 1..${opts.maxDepth} in ${dt.toFixed(1)}s`);
console.log('');
console.log('Per-depth comparison:');
console.log('  depth | total | move-mismatch | score-mismatch');
console.log('  ------+-------+---------------+---------------');
for (let d = 1; d <= opts.maxDepth; d++) {
  const t = totalPerDepth[d];
  const mm = mismatchPerDepth[d];
  const sm = scoreMismatchPerDepth[d];
  const mmPct = t > 0 ? ((100 * mm / t).toFixed(1) + '%').padStart(7) : '   n/a ';
  const smPct = t > 0 ? ((100 * sm / t).toFixed(1) + '%').padStart(7) : '   n/a ';
  console.log(`  ${String(d).padStart(5)} | ${String(t).padStart(5)} | ${String(mm).padStart(6)} ${mmPct} | ${String(sm).padStart(6)} ${smPct}`);
}

if (firstFailures.length > 0) {
  console.log('');
  console.log(`First ${firstFailures.length} move-mismatches:`);
  for (const f of firstFailures) {
    console.log(
      `  pos=${f.pos} ply=${f.ply} turn=${f.turn} depth=${f.depth}: ` +
      `v18=${decodeMove(f.v18Move)} score=${f.v18Score}  |  ` +
      `v19=${decodeMove(f.v19Move)} score=${f.v19Score}`
    );
  }
  process.exit(2);
}

console.log('');
console.log('OK: all (position × depth) pairs match between v18 and v19.');
