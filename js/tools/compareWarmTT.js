// Probe 2b: v18 vs v19 comparison WITH WARM TT (in-game semantics).
//
// In the tournament, clearTT() is called once at game start and the TT
// persists across moves within a game. Probe 2 (compareSearchOutputs.js)
// tested v18 vs v19 in isolation with a freshly-cleared TT per position,
// which is not a tournament-faithful reproduction.
//
// Probe 2b plays a scripted game forward (positions produced by v18 as
// the reference) and at each ply runs BOTH v18 and v19 from that position
// USING THEIR PERSISTENT TTs from prior moves in the same game. Each side
// has its own TT that warms up move by move. At each ply we record the
// chosen move and its lastDepth for both, and compare.
//
// To keep depths matched (so disagreements are not "one reached deeper"),
// we drive both AIs via the fixed-depth root loop from compareSearchOutputs
// rather than their time-budgeted choose().
//
// Usage:
//   node js/tools/compareWarmTT.js --games 5 --depth 4 --start-seed 200

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
  games: 5,
  maxDepth: 4,
  startSeed: 200,
  maxPly: 80,
  verbose: false,
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if      (a === '--games')      opts.games     = parseInt(argv[++i], 10);
  else if (a === '--depth')      opts.maxDepth  = parseInt(argv[++i], 10);
  else if (a === '--start-seed') opts.startSeed = parseInt(argv[++i], 10);
  else if (a === '--max-ply')    opts.maxPly    = parseInt(argv[++i], 10);
  else if (a === '-v')           opts.verbose   = true;
  else if (a === '-h' || a === '--help') {
    console.log('Usage: node compareWarmTT.js [--games N] [--depth D] [--start-seed S] [--max-ply P] [-v]');
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

function decodeMove(m) {
  const code = (m >>> 28) & 0xF;
  if (code === 1) return `ROT r=${(m>>>24)&0xF} c=${(m>>>20)&0xF} dir=${(m>>>19)&1}`;
  if (code === 2) return `MOV r=${(m>>>24)&0xF} c=${(m>>>20)&0xF} -> r=${(m>>>16)&0xF} c=${(m>>>12)&0xF}`;
  if (code === 3) return `PLC r=${(m>>>24)&0xF} c=${(m>>>20)&0xF} d=${(m>>>18)&3}`;
  if (code === 4) return `SWP tgt=${m&1}`;
  return `??? 0x${(m >>> 0).toString(16)}`;
}

// Reusable AI instance that keeps its killers/history fresh per call (just
// like choose() does) but KEEPS the module TT warm.
function runFixedDepthV18(ai, s, maxDepth) {
  ai.nodes = 0;
  ai.lastDepth = 0;
  ai.killers.fill(0);
  ai.history.clear();
  ai.deadline = Number.POSITIVE_INFINITY;

  const root = cloneForDoMove(s);
  const { count } = orderedMoves(root, 0);
  if (count === 0) return { move: 0, score: 0, perDepth: [] };

  const rootMoves = new Int32Array(count);
  const rootBuf = moveBufs[0];
  for (let i = 0; i < count; i++) rootMoves[i] = rootBuf[i];

  const perDepth = [];
  let finalBest = 0, finalScore = 0;
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
    finalBest = bb; finalScore = bv;
  }
  return { move: finalBest, score: finalScore, perDepth };
}

function runFixedDepthV19(ai, s, maxDepth) {
  ai.nodes = 0;
  ai.lastDepth = 0;
  ai.killers.fill(0);
  ai.history.clear();
  ai.deadline = Number.POSITIVE_INFINITY;

  const root = cloneForDoMove(s);
  zobristInit(root);
  const { count } = orderedMoves(root, 0);
  if (count === 0) return { move: 0, score: 0, perDepth: [] };

  const rootMoves = new Int32Array(count);
  const rootBuf = moveBufs[0];
  for (let i = 0; i < count; i++) rootMoves[i] = rootBuf[i];

  const perDepth = [];
  let finalBest = 0, finalScore = 0;
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
    finalBest = bb; finalScore = bv;
  }
  return { move: finalBest, score: finalScore, perDepth };
}

// --- Main ---

console.log(`compareWarmTT: games=${opts.games} depth=${opts.maxDepth} start-seed=${opts.startSeed}`);

let totalComparisons = 0;
let totalMismatchesByDepth = new Array(opts.maxDepth + 1).fill(0);
let totalByDepth = new Array(opts.maxDepth + 1).fill(0);
let totalMoveMismatches = 0;
const firstFailures = [];

const t0 = Date.now();
for (let g = 0; g < opts.games; g++) {
  const seed = opts.startSeed + g;
  const s0 = initRandom(seed);
  const ip = makeInitialPositions(s0);
  let s = stateFromInitialPositions(ip);

  // Fresh AI instances per game, each with its own cleared TT (mirrors
  // index.js:42 which clearTT()s inside setup()).
  aiV18.clearTT();
  aiV19.clearTT();
  const ai18 = new aiV18.AB(1, 1e9);
  const ai19 = new aiV19.AB(1, 1e9);

  let plyInGame = 0;
  while (s.win === 0 && s.ply < opts.maxPly) {
    ai18.pl = s.turn;
    ai19.pl = s.turn;

    const r18 = runFixedDepthV18(ai18, s, opts.maxDepth);
    const r19 = runFixedDepthV19(ai19, s, opts.maxDepth);

    // Compare per-depth results
    for (let d = 0; d < r18.perDepth.length; d++) {
      const depth = r18.perDepth[d].depth;
      totalByDepth[depth]++;
      totalComparisons++;
      const moveDiff = r18.perDepth[d].move !== r19.perDepth[d].move;
      if (moveDiff) {
        totalMismatchesByDepth[depth]++;
        totalMoveMismatches++;
        if (firstFailures.length < 20) {
          firstFailures.push({
            seed, plyInGame, ply: s.ply, turn: s.turn, depth,
            v18Move: r18.perDepth[d].move, v18Score: r18.perDepth[d].score,
            v19Move: r19.perDepth[d].move, v19Score: r19.perDepth[d].score,
          });
        }
      }
    }

    // Advance the game via v18's choice (v18 is our reference). If v19
    // agreed we could equivalently use its choice; if they disagreed the
    // next move is the first divergent position and we still want to
    // continue.
    s = doMove(s, r18.move);
    plyInGame++;
  }
  if (opts.verbose) console.log(`  seed=${seed}: played ${plyInGame} plies, winner=${s.win}`);
}

const dt = (Date.now() - t0) / 1000;
console.log('');
console.log(`Ran ${totalComparisons} (ply × depth) comparisons in ${dt.toFixed(1)}s`);
console.log('');
console.log('Per-depth comparison (warm TT):');
console.log('  depth | total | move-mismatch');
console.log('  ------+-------+---------------');
for (let d = 1; d <= opts.maxDepth; d++) {
  const t = totalByDepth[d];
  const mm = totalMismatchesByDepth[d];
  const pct = t > 0 ? ((100 * mm / t).toFixed(1) + '%').padStart(7) : '   n/a ';
  console.log(`  ${String(d).padStart(5)} | ${String(t).padStart(5)} | ${String(mm).padStart(6)} ${pct}`);
}

if (firstFailures.length > 0) {
  console.log('');
  console.log(`First ${firstFailures.length} move-mismatches:`);
  for (const f of firstFailures) {
    console.log(
      `  seed=${f.seed} pig=${f.plyInGame} ply=${f.ply} turn=${f.turn} d=${f.depth}: ` +
      `v18=${decodeMove(f.v18Move)} sc=${f.v18Score}  |  ` +
      `v19=${decodeMove(f.v19Move)} sc=${f.v19Score}`
    );
  }
  process.exit(2);
}

console.log('');
console.log('OK: warm-TT comparison matches at all sampled (ply × depth) points.');
