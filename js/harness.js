// Tournament runner — pits two fresh AB instances against each other through
// the JS tournament API (setup / nextMove). Mirrors the play() loop from
// cli.py but runs in a single process (no multiprocessing).
//
// Usage:
//   node harness.js --games 4 --seed 0 --time 0.18
//   node harness.js -g 10 --verbose

const {
  initRandom, makeInitialPositions, stateFromInitialPositions,
  doMove, actionToInternal, internalToAction, terminal,
  orderedMoves, moveBufs,
} = require('./game.js');
const { AB, clearTT } = require('./aiV18.js');
const { performance } = require('perf_hooks');

// --- CLI parsing ---
function parseArgs(argv) {
  const opts = {
    games: 4,
    seed: 0,
    time: 0.18,
    verbose: false,
    maxPly: 200,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--games' || a === '-g') opts.games = parseInt(argv[++i], 10);
    else if (a === '--seed' || a === '-s') opts.seed = parseInt(argv[++i], 10);
    else if (a === '--time' || a === '-t') opts.time = parseFloat(argv[++i]);
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a === '--max-ply') opts.maxPly = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node harness.js [--games N] [--seed S] [--time T] [--verbose]');
      process.exit(0);
    }
  }
  return opts;
}

// --- Startup assertions ---
function runAssertions() {
  const s = initRandom(42);

  // 1. Every legal move round-trips through the JS action format.
  const { count } = orderedMoves(s, 0);
  const buf = moveBufs[0].slice(0, count);
  for (let i = 0; i < count; i++) {
    const m = buf[i];
    const js = internalToAction(m, s, s.turn);
    const back = actionToInternal(js, s);
    if (back !== m) {
      throw new Error(`action round-trip failed for move ${m.toString(16)}: got ${back.toString(16)}`);
    }
  }

  // 2. makeInitialPositions ∘ stateFromInitialPositions round-trips the board.
  const ip = makeInitialPositions(s);
  const rebuilt = stateFromInitialPositions(ip);
  for (let i = 0; i < 100; i++) {
    if (rebuilt.b[i] !== s.b[i]) {
      throw new Error(`state round-trip mismatch at cell ${i}: ${rebuilt.b[i]} vs ${s.b[i]}`);
    }
  }
  if (rebuilt.sph1 !== s.sph1 || rebuilt.sph2 !== s.sph2) {
    throw new Error('sphinx tracking mismatch after round-trip');
  }

  console.log(`startup assertions passed (${count} root moves round-tripped)`);
}

// --- Tournament loop ---
function playGame(gameIdx, seed, moveTime, maxPly, verbose) {
  clearTT();
  const s0 = initRandom(seed);
  const initialPositions = makeInitialPositions(s0);

  const ai1 = new AB(1, moveTime);
  const ai2 = new AB(2, moveTime);

  // Each AI tracks its own state, seeded from initialPositions.
  let state1 = stateFromInitialPositions(initialPositions);
  let state2 = stateFromInitialPositions(initialPositions);
  let canonical = stateFromInitialPositions(initialPositions);

  let lastAction = { 1: null, 2: null };
  const stats = {
    plies: 0,
    totalNodes1: 0, totalNodes2: 0,
    totalTime1: 0, totalTime2: 0,
    maxTime1: 0, maxTime2: 0,
    maxDepth1: 0, maxDepth2: 0,
    sumDepth1: 0, sumDepth2: 0,
    moves1: 0, moves2: 0,
    winner: 0,
    reason: 'ongoing',
  };

  while (!terminal(canonical) && stats.plies < maxPly) {
    const pid = canonical.turn;
    const ai = pid === 1 ? ai1 : ai2;
    const opp = 3 - pid;
    const oppAct = lastAction[opp];

    // Apply opponent's last action to this AI's private state.
    const myState = pid === 1 ? state1 : state2;
    let workingState = myState;
    if (oppAct !== null) {
      workingState = doMove(workingState, actionToInternal(oppAct, workingState));
    }

    const t0 = performance.now();
    const move = ai.choose(workingState);
    const dt = performance.now() - t0;

    // Translate to JS action, then apply on canonical and AI's own state.
    const jsAction = internalToAction(move, workingState, pid);
    const internalForMe = actionToInternal(jsAction, workingState);
    const newMyState = doMove(workingState, internalForMe);
    if (pid === 1) state1 = newMyState;
    else           state2 = newMyState;

    const internalForCanon = actionToInternal(jsAction, canonical);
    canonical = doMove(canonical, internalForCanon);
    lastAction[pid] = jsAction;

    // Stats
    if (pid === 1) {
      stats.moves1++;
      stats.totalNodes1 += ai.nodes;
      stats.totalTime1  += dt;
      if (dt > stats.maxTime1) stats.maxTime1 = dt;
      if (ai.lastDepth > stats.maxDepth1) stats.maxDepth1 = ai.lastDepth;
      stats.sumDepth1 += ai.lastDepth;
    } else {
      stats.moves2++;
      stats.totalNodes2 += ai.nodes;
      stats.totalTime2  += dt;
      if (dt > stats.maxTime2) stats.maxTime2 = dt;
      if (ai.lastDepth > stats.maxDepth2) stats.maxDepth2 = ai.lastDepth;
      stats.sumDepth2 += ai.lastDepth;
    }
    stats.plies++;

    if (verbose) {
      console.log(
        `  g${gameIdx} p${stats.plies.toString().padStart(3)} P${pid} ` +
        `${JSON.stringify(jsAction).padEnd(60)} ` +
        `d=${ai.lastDepth} n=${ai.nodes} ${dt.toFixed(1)}ms`
      );
    }
  }

  if (canonical.win === 1)      { stats.winner = 1; stats.reason = 'P1 captured P2 pharaoh'; }
  else if (canonical.win === 2) { stats.winner = 2; stats.reason = 'P2 captured P1 pharaoh'; }
  else if (canonical.win === -1) { stats.winner = 0; stats.reason = 'draw (simultaneous or material)'; }
  else if (stats.plies >= maxPly) { stats.winner = 0; stats.reason = 'ply cap'; }

  return stats;
}

function main() {
  const opts = parseArgs(process.argv);
  runAssertions();

  console.log(`\nRunning ${opts.games} games, seed=${opts.seed}, time=${opts.time}s per move`);
  console.log('='.repeat(78));

  const results = [];
  let w1 = 0, w2 = 0, draws = 0;

  for (let g = 0; g < opts.games; g++) {
    const seed = opts.seed + g;
    const t0 = performance.now();
    const stats = playGame(g + 1, seed, opts.time, opts.maxPly, opts.verbose);
    const wall = (performance.now() - t0) / 1000;

    if (stats.winner === 1)      w1++;
    else if (stats.winner === 2) w2++;
    else                         draws++;

    results.push(stats);

    const avgT1 = stats.moves1 > 0 ? (stats.totalTime1 / stats.moves1).toFixed(1) : '0.0';
    const avgT2 = stats.moves2 > 0 ? (stats.totalTime2 / stats.moves2).toFixed(1) : '0.0';
    const avgD1 = stats.moves1 > 0 ? (stats.sumDepth1 / stats.moves1).toFixed(1) : '0.0';
    const avgD2 = stats.moves2 > 0 ? (stats.sumDepth2 / stats.moves2).toFixed(1) : '0.0';
    const wStr = stats.winner === 0 ? 'DRAW' : `P${stats.winner}`;
    console.log(
      `game ${(g + 1).toString().padStart(2)}  seed=${seed}  ` +
      `plies=${stats.plies.toString().padStart(3)}  ` +
      `${wStr.padEnd(5)} (${stats.reason})  ` +
      `[P1 d=${avgD1}/${stats.maxDepth1} ${avgT1}ms | P2 d=${avgD2}/${stats.maxDepth2} ${avgT2}ms]  ` +
      `wall=${wall.toFixed(1)}s`
    );
  }

  console.log('='.repeat(78));
  console.log(`P1 wins: ${w1}   P2 wins: ${w2}   draws: ${draws}`);

  // Overall aggregates
  let totalMoves = 0, totalNodes = 0, totalTime = 0;
  let maxOverallTime = 0;
  for (const r of results) {
    totalMoves += r.moves1 + r.moves2;
    totalNodes += r.totalNodes1 + r.totalNodes2;
    totalTime  += r.totalTime1 + r.totalTime2;
    if (r.maxTime1 > maxOverallTime) maxOverallTime = r.maxTime1;
    if (r.maxTime2 > maxOverallTime) maxOverallTime = r.maxTime2;
  }
  if (totalMoves > 0) {
    const nps = (totalNodes / (totalTime / 1000)).toFixed(0);
    console.log(`total moves=${totalMoves}  nodes=${totalNodes}  nps=${nps}  max move time=${maxOverallTime.toFixed(1)}ms`);
  }
}

main();
