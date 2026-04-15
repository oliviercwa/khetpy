// Async tournament harness that drives two Agent instances through the
// spec-compliant setup/nextMove API. Plays PAIRED games: for each seed S,
// once with labelA as P1 and once with labelB as P1, so each starting
// position is contested twice with the sides swapped. Reports aggregate
// stats in a version-centric format (not side-centric).
//
// The AI code itself is not instrumented — this harness only reads
// ai.nodes / ai.lastDepth and wraps wall time around nextMove(), keeping
// the AB hot path pristine.
//
// Usage:
//   node tournament.js --games 10 --seed 0 --a v18 --b v19
//   node tournament.js --games 500 --turn-time-ms 250 --search-time-ms 180
//   node tournament.js --games 4 --verbose
//
// --games must be even (each pair counts for 2). Odd inputs are rounded
// down and a warning is printed.

const {
  initRandom, makeInitialPositions, stateFromInitialPositions,
  doMove, actionToInternal, internalToAction, terminal, boardToString,
} = require('./game.js');
const { Agent } = require('./index.js');
const { performance } = require('perf_hooks');
const fs = require('fs');

// ---------- CLI ----------

function parseArgs(argv) {
  const opts = {
    games:          10,
    seed:           0,
    turnTimeMs:     250,
    searchTimeMs:   230,
    a:              'v19',
    b:              'v19',
    maxPly:         200,
    verbose:        false,
    ponderWindowMs: 0,
    logLosses:      null,
    logLossesFile:  'losses.log',
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if      (a === '--games'          || a === '-g') opts.games          = parseInt(argv[++i], 10);
    else if (a === '--seed'           || a === '-s') opts.seed           = parseInt(argv[++i], 10);
    else if (a === '--turn-time-ms')                 opts.turnTimeMs     = parseFloat(argv[++i]);
    else if (a === '--search-time-ms')               opts.searchTimeMs   = parseFloat(argv[++i]);
    else if (a === '--ponder-window-ms')             opts.ponderWindowMs = parseFloat(argv[++i]);
    else if (a === '--a')                            opts.a              = argv[++i];
    else if (a === '--b')                            opts.b              = argv[++i];
    else if (a === '--max-ply')                      opts.maxPly         = parseInt(argv[++i], 10);
    else if (a === '--verbose'        || a === '-v') opts.verbose        = true;
    else if (a === '--log-losses')                   opts.logLosses      = argv[++i];
    else if (a === '--log-losses-file')              opts.logLossesFile  = argv[++i];
    else if (a === '--help'           || a === '-h') {
      console.log(
        'Usage: node tournament.js [--games N] [--seed S] [--a v18|v19] [--b v18|v19]\n' +
        '                          [--turn-time-ms MS] [--search-time-ms MS]\n' +
        '                          [--max-ply N] [--verbose]\n' +
        '\n' +
        '--games must be even; each pair plays the same seed twice with sides swapped.'
      );
      process.exit(0);
    }
    else {
      console.error(`unknown flag ${a}`);
      process.exit(1);
    }
  }
  if (opts.games % 2 !== 0) {
    console.warn(`--games must be even; rounding ${opts.games} down to ${opts.games - 1}`);
    opts.games -= 1;
  }
  return opts;
}

// ---------- Per-game play ----------

// Returns a pure result record. Does not mutate any external state.
// perPlayer[pid] = { version, moves, sumTime, minTime, maxTime,
//                    sumDepth, minDepth, maxDepth, sumNodes, violations }
async function playGame(seed, p1Version, p2Version, opts) {
  const s0 = initRandom(seed);
  const initialPositions = makeInitialPositions(s0);

  const agent1 = new Agent({ version: p1Version, searchTimeMs: opts.searchTimeMs });
  const agent2 = new Agent({ version: p2Version, searchTimeMs: opts.searchTimeMs });
  await agent1.setup(initialPositions, true);
  await agent2.setup(initialPositions, false);

  let canonical  = stateFromInitialPositions(initialPositions);
  let lastAction = null;
  let plies      = 0;
  const moveHistory  = [];
  const depthHistory = [];
  const nodesHistory = [];
  const timeHistory  = [];

  const perPlayer = {
    1: emptyPlayer(p1Version),
    2: emptyPlayer(p2Version),
  };

  // Track cumulative ponder-slice / ponder-node counts so we can report
  // per-turn deltas. For a non-pondering agent these stay at 0, which is
  // correct (no ponder).
  const priorSlices          = { 1: 0, 2: 0 };
  const priorMaxDepth        = { 1: 0, 2: 0 };
  const priorPonderNodes     = { 1: 0, 2: 0 };
  const priorTtProbes        = { 1: 0, 2: 0 };
  const priorTtHits          = { 1: 0, 2: 0 };
  const priorPonderTtProbes  = { 1: 0, 2: 0 };
  const priorPonderTtHits    = { 1: 0, 2: 0 };

  while (!terminal(canonical) && plies < opts.maxPly) {
    const pid = canonical.turn;
    const agent = pid === 1 ? agent1 : agent2;

    const t0 = performance.now();
    const action = await agent.nextMove(lastAction);
    const dt = performance.now() - t0;

    const depth = agent.lastDepth;
    const nodes = agent.nodes;

    // Slices that ran for THIS agent since its previous turn (i.e. the
    // ponder work that was available when the current nextMove began).
    // nextMove's ponderStop is synchronous and doesn't advance slice count,
    // and the new ponderStart only schedules — so the read here reflects
    // the idle-window ponder of the just-finished turn's predecessor.
    const sNow = agent.ponderSlices;
    const dNow = agent.ponderMaxDepth;
    const slicesThisTurn = sNow - priorSlices[pid];
    priorSlices[pid] = sNow;
    priorMaxDepth[pid] = dNow;

    const pp = perPlayer[pid];
    pp.moves++;
    pp.sumTime  += dt;
    if (dt < pp.minTime) pp.minTime = dt;
    if (dt > pp.maxTime) pp.maxTime = dt;
    pp.sumDepth += depth;
    if (depth < pp.minDepth) pp.minDepth = depth;
    if (depth > pp.maxDepth) pp.maxDepth = depth;
    pp.sumNodes += nodes;
    if (dt > opts.turnTimeMs) pp.violations++;

    // Ponder stats (only meaningful for ponder-enabled agents — non-ponder
    // agents contribute 0 to sums and to min/max).
    pp.sumPonderSlices += slicesThisTurn;
    if (slicesThisTurn < pp.minPonderSlices) pp.minPonderSlices = slicesThisTurn;
    if (slicesThisTurn > pp.maxPonderSlices) pp.maxPonderSlices = slicesThisTurn;
    pp.ponderMovesWithSlices += slicesThisTurn > 0 ? 1 : 0;
    if (dNow > pp.maxPonderMaxDepth) pp.maxPonderMaxDepth = dNow;

    // Per-session observability — populated by v20's buildResumeHint and
    // _ponderSlice. For non-ponder agents these getters all return 0/-1/false
    // so the aggregates naturally collapse to zero and the report omits
    // ponder lines for that side.
    //
    // ponderNodes is cumulative-per-game (ponderStart deliberately does NOT
    // reset it), so we compute a per-turn delta the same way we do for
    // slices. The delta represents all ponder-side nodes that accumulated
    // between this agent's previous turn and the current one.
    const pNodesNow       = agent.ponderNodes;
    const ponderNodesThis = pNodesNow - priorPonderNodes[pid];
    priorPonderNodes[pid] = pNodesNow;
    const exploredDepth   = agent.ponderLastExploredDepth;
    const inFlight        = agent.ponderLastInFlight;
    const rootIdx         = agent.ponderLastRootIdx;

    pp.sumPonderNodes         += ponderNodesThis;
    pp.sumPonderExploredDepth += exploredDepth;
    if (rootIdx < 0)               pp.noneTurns++;
    else if (inFlight)             pp.inFlightTurns++;
    else if (exploredDepth > 0)    pp.coveredTurns++;
    else                           pp.noneTurns++;  // rootIdx >= 0 but depth 0 = not yet started

    // TT probe/hit deltas. ttProbes/ttHits are cumulative on the AB
    // instance; ponderTtProbes/ponderTtHits are the ponder-attributed
    // subset (captured via the same delta-in-slice pattern as
    // ponderNodes). choose's share is total minus ponder's share.
    const ttProbesNow       = agent.ttProbes;
    const ttHitsNow         = agent.ttHits;
    const ponderTtProbesNow = agent.ponderTtProbes;
    const ponderTtHitsNow   = agent.ponderTtHits;

    const ttProbesThis       = ttProbesNow       - priorTtProbes[pid];
    const ttHitsThis         = ttHitsNow         - priorTtHits[pid];
    const ponderTtProbesThis = ponderTtProbesNow - priorPonderTtProbes[pid];
    const ponderTtHitsThis   = ponderTtHitsNow   - priorPonderTtHits[pid];

    priorTtProbes[pid]       = ttProbesNow;
    priorTtHits[pid]         = ttHitsNow;
    priorPonderTtProbes[pid] = ponderTtProbesNow;
    priorPonderTtHits[pid]   = ponderTtHitsNow;

    pp.sumChooseTtProbes += ttProbesThis - ponderTtProbesThis;
    pp.sumChooseTtHits   += ttHitsThis   - ponderTtHitsThis;
    pp.sumPonderTtProbes += ponderTtProbesThis;
    pp.sumPonderTtHits   += ponderTtHitsThis;

    const mInt = actionToInternal(action, canonical);
    moveHistory.push(mInt);
    depthHistory.push(depth);
    nodesHistory.push(nodes);
    timeHistory.push(dt);
    canonical = doMove(canonical, mInt);
    lastAction = action;
    plies++;

    // Yield to the event loop between turns so any ponder slices the
    // returning AI scheduled via setImmediate get a chance to run. In a
    // real tournament, the opponent's thinking takes ~180-250ms on a
    // separate container while OUR process is idle; in this in-process
    // harness we simulate that window with a setTimeout wait of the
    // configured length (default 0 = just one setImmediate yield).
    if (opts.ponderWindowMs > 0) {
      await new Promise((r) => setTimeout(r, opts.ponderWindowMs));
    } else {
      await new Promise((r) => setImmediate(r));
    }
  }

  let winner = 0;
  let reason = 'ongoing';
  if      (canonical.win === 1)  { winner = 1; reason = 'P1 captured P2 pharaoh'; }
  else if (canonical.win === 2)  { winner = 2; reason = 'P2 captured P1 pharaoh'; }
  else if (canonical.win === -1) { winner = 0; reason = 'draw (simultaneous or material)'; }
  else if (plies >= opts.maxPly) { winner = 0; reason = 'ply cap'; }

  // Fill rate is captured here (end of game, before the next game's setup
  // calls clearTT and wipes the table). Two agents of the same version
  // share the same module-level TT, so fillP1 and fillP2 are equal when
  // p1Version === p2Version.
  perPlayer[1].maxTtFill = agent1.ttFillCount;
  perPlayer[2].maxTtFill = agent2.ttFillCount;

  return {
    seed, plies, winner, reason, perPlayer,
    ttInfoP1: agent1.ttInfo, ttInfoP2: agent2.ttInfo,
    moveHistory,
    depthHistory,
    nodesHistory,
    timeHistory,
    initialPositions,
    p1Version, p2Version,
  };
}

function emptyPlayer(version) {
  return {
    version,
    moves: 0,
    sumTime: 0, minTime: Infinity, maxTime: 0,
    sumDepth: 0, minDepth: Infinity, maxDepth: 0,
    sumNodes: 0,
    violations: 0,
    sumPonderSlices: 0, minPonderSlices: Infinity, maxPonderSlices: 0,
    ponderMovesWithSlices: 0,
    maxPonderMaxDepth: 0,
    sumPonderNodes: 0,
    sumPonderExploredDepth: 0,
    coveredTurns: 0, inFlightTurns: 0, noneTurns: 0,
    sumChooseTtProbes: 0, sumChooseTtHits: 0,
    sumPonderTtProbes: 0, sumPonderTtHits: 0,
  };
}

// ---------- Loss logging ----------

let _pairCounter = 0;

// Pair-level filter: returns true if, on this same-seed pair, the "loser"
// version failed to win either game — i.e. the opposing version either
// (a) won both games, or (b) won one and drew the other. A pair where
// each version wins one (or both draw) does NOT qualify.
//
// gA has vA as P1, gB has vB as P1 (see playPair).
function pairQualifies(gA, gB, vA, vB, loserVer) {
  if (loserVer !== vA && loserVer !== vB) return false;
  const dominantIsA = vA !== loserVer;
  const domWonA = dominantIsA ? gA.winner === 1 : gA.winner === 2;
  const domWonB = dominantIsA ? gB.winner === 2 : gB.winner === 1;
  const drawA = gA.winner === 0;
  const drawB = gB.winner === 0;
  if (domWonA && domWonB) return true;
  if (domWonA && drawB)   return true;
  if (drawA && domWonB)   return true;
  return false;
}

function _outcomeStr(game) {
  if (game.winner === 0) return 'draw';
  const w = game.winner === 1 ? game.p1Version : game.p2Version;
  return `${w} wins`;
}

function _fmtActShort(act) {
  if (act.action === 'ROTATE')   return `R${act.cell}${act.result === 'CLOCKWISE' ? '+' : '-'}`;
  if (act.action === 'MOVE')     return `M${act.cell}-${act.result}`;
  if (act.action === 'PLACE')    return `P${act.result.destination}@${act.result.orientation}`;
  if (act.action === 'EXCHANGE') return `X${act.cell}<>${act.result}`;
  return '?';
}

function _fmtNodesShort(n) {
  if (n < 1000)    return String(n);
  if (n < 1000000) return (n / 1000).toFixed(0) + 'k';
  return (n / 1000000).toFixed(1) + 'm';
}

function _fmtPlyCell(i, game, sBefore, colW) {
  if (i >= game.moveHistory.length) return ' '.repeat(colW);
  const mInt = game.moveHistory[i];
  const pid  = sBefore.turn;
  const ver  = pid === 1 ? game.p1Version : game.p2Version;
  const act  = internalToAction(mInt, sBefore, pid);
  const d    = game.depthHistory ? game.depthHistory[i] : 0;
  const n    = _fmtNodesShort(game.nodesHistory ? game.nodesHistory[i] : 0);
  const t    = game.timeHistory ? `${game.timeHistory[i].toFixed(0)}ms` : '?';
  const mv   = _fmtActShort(act);
  const plyStr = `${String(i + 1).padStart(3)}.`;
  const row = `${plyStr} P${pid} ${ver} d=${String(d).padStart(2)} n=${n.padStart(5)} t=${t.padStart(6)} ${mv}`;
  return row.padEnd(colW);
}

// Append both games of a qualifying pair to the log, grouped under one
// pair header with a side-by-side move table. gA has vA as P1; gB has vB
// as P1. The caller has already filtered via pairQualifies.
function appendPairBlock(path, gA, gB, vA, vB, loserVer) {
  _pairCounter++;
  const dominantVer = vA === loserVer ? vB : vA;
  const seed = gA.seed;

  // domStarts: dominant plays P1.  domNotStarts: loser plays P1.
  const domStarts    = dominantVer === vA ? gA : gB;
  const domNotStarts = dominantVer === vA ? gB : gA;

  const colW = 42;
  const hdrLine = '='.repeat(colW * 2 + 3);
  const divLine = '-'.repeat(colW) + '-+-' + '-'.repeat(colW);

  const lines = [];
  lines.push(hdrLine);
  lines.push(
    `=== Pair #${_pairCounter} | seed=${seed} | ` +
    `${dominantVer} dominates ${loserVer} | ` +
    `game1=${_outcomeStr(domStarts)} game2=${_outcomeStr(domNotStarts)} ===`
  );
  lines.push(hdrLine);
  lines.push('');

  // Shared initial board (both games start from the same seed).
  lines.push('Initial board (shared by both games):');
  lines.push(boardToString(stateFromInitialPositions(domStarts.initialPositions)));
  lines.push('');

  // Side-by-side move table.
  const hdrL = `Game 1: ${dominantVer} starts — ${_outcomeStr(domStarts)} (${domStarts.plies} plies)`;
  const hdrR = `Game 2: ${loserVer} starts — ${_outcomeStr(domNotStarts)} (${domNotStarts.plies} plies)`;
  lines.push(hdrL.padEnd(colW) + ' | ' + hdrR.padEnd(colW));
  lines.push(divLine);

  let sL = stateFromInitialPositions(domStarts.initialPositions);
  let sR = stateFromInitialPositions(domNotStarts.initialPositions);
  const nPlies = Math.max(domStarts.moveHistory.length, domNotStarts.moveHistory.length);
  for (let i = 0; i < nPlies; i++) {
    const left  = _fmtPlyCell(i, domStarts,    sL, colW);
    const right = _fmtPlyCell(i, domNotStarts, sR, colW);
    lines.push(left + ' | ' + right);
    if (i < domStarts.moveHistory.length)    sL = doMove(sL, domStarts.moveHistory[i]);
    if (i < domNotStarts.moveHistory.length) sR = doMove(sR, domNotStarts.moveHistory[i]);
  }
  lines.push('');

  lines.push(`Final board — Game 1 (${dominantVer} starts):`);
  lines.push(boardToString(sL));
  lines.push('');
  lines.push(`Final board — Game 2 (${loserVer} starts):`);
  lines.push(boardToString(sR));
  lines.push('');
  lines.push('');

  fs.appendFileSync(path, lines.join('\n'));
}

// Play one paired match on a given seed. Returns [gameA, gameB] where
// gameA has vA as P1 and gameB has vB as P1. Each game is tagged with
// _aIsP1 so the aggregator can route stats to the correct side even
// when labelA === labelB (self-play).
async function playPair(seed, vA, vB, opts) {
  const gA = await playGame(seed, vA, vB, opts);
  gA._aIsP1 = true;
  const gB = await playGame(seed, vB, vA, opts);
  gB._aIsP1 = false;
  return [gA, gB];
}

// ---------- Aggregation ----------

function emptyVersionAgg() {
  return {
    wins: 0,
    winsByBucket: new Array(11).fill(0),
    moves: 0,
    sumTime: 0, minTime: Infinity, maxTime: 0,
    sumDepth: 0, minDepth: Infinity, maxDepth: 0,
    sumNodes: 0,
    violations: 0,
    sumPonderSlices: 0, minPonderSlices: Infinity, maxPonderSlices: 0,
    ponderMovesWithSlices: 0,
    maxPonderMaxDepth: 0,
    sumPonderNodes: 0,
    sumPonderExploredDepth: 0,
    coveredTurns: 0, inFlightTurns: 0, noneTurns: 0,
    sumChooseTtProbes: 0, sumChooseTtHits: 0,
    sumPonderTtProbes: 0, sumPonderTtHits: 0,
    maxTtFill: 0,
    sumDepthByBucket: new Array(11).fill(0),
    movesByBucket:    new Array(11).fill(0),
  };
}

function emptyAgg(labelA, labelB) {
  return {
    totalGames: 0,
    totalPlies: 0,
    draws: 0,
    labelA, labelB,
    ttInfoA: null,
    ttInfoB: null,
    aStats: emptyVersionAgg(),
    bStats: emptyVersionAgg(),
    drawsByBucket: new Array(11).fill(0),
  };
}

function mergePerPlayer(dst, pp) {
  dst.moves     += pp.moves;
  dst.sumTime   += pp.sumTime;
  if (pp.minTime < dst.minTime) dst.minTime = pp.minTime;
  if (pp.maxTime > dst.maxTime) dst.maxTime = pp.maxTime;
  dst.sumDepth  += pp.sumDepth;
  if (pp.minDepth < dst.minDepth) dst.minDepth = pp.minDepth;
  if (pp.maxDepth > dst.maxDepth) dst.maxDepth = pp.maxDepth;
  dst.sumNodes  += pp.sumNodes;
  dst.violations += pp.violations;
  dst.sumPonderSlices += pp.sumPonderSlices;
  if (pp.minPonderSlices < dst.minPonderSlices) dst.minPonderSlices = pp.minPonderSlices;
  if (pp.maxPonderSlices > dst.maxPonderSlices) dst.maxPonderSlices = pp.maxPonderSlices;
  dst.ponderMovesWithSlices += pp.ponderMovesWithSlices;
  if (pp.maxPonderMaxDepth > dst.maxPonderMaxDepth) dst.maxPonderMaxDepth = pp.maxPonderMaxDepth;
  dst.sumPonderNodes         += pp.sumPonderNodes;
  dst.sumPonderExploredDepth += pp.sumPonderExploredDepth;
  dst.coveredTurns  += pp.coveredTurns;
  dst.inFlightTurns += pp.inFlightTurns;
  dst.noneTurns     += pp.noneTurns;
  dst.sumChooseTtProbes += pp.sumChooseTtProbes;
  dst.sumChooseTtHits   += pp.sumChooseTtHits;
  dst.sumPonderTtProbes += pp.sumPonderTtProbes;
  dst.sumPonderTtHits   += pp.sumPonderTtHits;
  if (pp.maxTtFill > dst.maxTtFill) dst.maxTtFill = pp.maxTtFill;
}

// Map a ply count to its histogram bucket. Buckets:
//   0-5 : one per ply  |  6: 6-10  |  7: 11-20  |  8: 21-50
//   9: 51-100            |  10: >100
function plyBucket(n) {
  if (n <= 0) return 0;
  if (n <= 5) return n;
  if (n <= 10) return 6;
  if (n <= 20) return 7;
  if (n <= 50) return 8;
  if (n <= 100) return 9;
  return 10;
}

function addGameToAgg(agg, game) {
  agg.totalGames++;
  agg.totalPlies += game.plies;

  const aPid = game._aIsP1 ? 1 : 2;
  const bPid = game._aIsP1 ? 2 : 1;
  const b = plyBucket(game.plies);
  agg.aStats.sumDepthByBucket[b] += game.perPlayer[aPid].sumDepth;
  agg.aStats.movesByBucket[b]    += game.perPlayer[aPid].moves;
  agg.bStats.sumDepthByBucket[b] += game.perPlayer[bPid].sumDepth;
  agg.bStats.movesByBucket[b]    += game.perPlayer[bPid].moves;
  mergePerPlayer(agg.aStats, game.perPlayer[aPid]);
  mergePerPlayer(agg.bStats, game.perPlayer[bPid]);

  if (agg.ttInfoA == null) agg.ttInfoA = aPid === 1 ? game.ttInfoP1 : game.ttInfoP2;
  if (agg.ttInfoB == null) agg.ttInfoB = bPid === 1 ? game.ttInfoP1 : game.ttInfoP2;

  if (game.winner === 0) {
    agg.draws++;
    agg.drawsByBucket[b]++;
  } else if (game.winner === aPid) {
    agg.aStats.wins++;
    agg.aStats.winsByBucket[b]++;
  } else {
    agg.bStats.wins++;
    agg.bStats.winsByBucket[b]++;
  }
}

function mergeAgg(dst, src) {
  dst.totalGames += src.totalGames;
  dst.totalPlies += src.totalPlies;
  dst.draws      += src.draws;
  dst.aStats.wins += src.aStats.wins;
  dst.bStats.wins += src.bStats.wins;
  for (let i = 0; i < 11; i++) {
    dst.aStats.winsByBucket[i]     += src.aStats.winsByBucket[i];
    dst.bStats.winsByBucket[i]     += src.bStats.winsByBucket[i];
    dst.aStats.sumDepthByBucket[i] += src.aStats.sumDepthByBucket[i];
    dst.aStats.movesByBucket[i]    += src.aStats.movesByBucket[i];
    dst.bStats.sumDepthByBucket[i] += src.bStats.sumDepthByBucket[i];
    dst.bStats.movesByBucket[i]    += src.bStats.movesByBucket[i];
    dst.drawsByBucket[i]           += src.drawsByBucket[i];
  }
  mergePerPlayer(dst.aStats, src.aStats);
  mergePerPlayer(dst.bStats, src.bStats);
  if (dst.ttInfoA == null) dst.ttInfoA = src.ttInfoA;
  if (dst.ttInfoB == null) dst.ttInfoB = src.ttInfoB;
}

// ---------- Reporting ----------

function fmtInt(n) {
  // US-style thousands separator without pulling in Intl unnecessarily.
  const s = Math.round(n).toString();
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtDepth(v) {
  return v === Infinity ? 'n/a' : v.toString();
}

function fmtMs(v) {
  return v === Infinity ? 'n/a' : `${v.toFixed(1)}ms`;
}

function printReport(agg) {
  const { totalGames, totalPlies, draws, labelA, labelB, aStats, bStats, ttInfoA, ttInfoB } = agg;

  // Disambiguate visually on self-play so the reader can tell the rows
  // apart — otherwise "v20 vs v20" would print two identical column
  // headers.
  const showA = labelA === labelB ? `${labelA}#A` : labelA;
  const showB = labelA === labelB ? `${labelB}#B` : labelB;

  const pct = (n) => totalGames > 0 ? ((n / totalGames) * 100).toFixed(1) : '0.0';
  const avgMoves = totalGames > 0 ? (totalPlies / totalGames).toFixed(1) : '0.0';

  const nodesPerGame = (v) => totalGames > 0 ? v.sumNodes / totalGames : 0;

  console.log(
    `Final: ${showA} ${aStats.wins} [${pct(aStats.wins)}%] - ` +
    `${showB} ${bStats.wins} [${pct(bStats.wins)}%] - ` +
    `Draws ${draws} [${pct(draws)}%]`
  );
  console.log(`Avg moves: ${avgMoves}`);
  console.log(`Nodes ${showA}: ${fmtInt(nodesPerGame(aStats))}/game`);
  console.log(`Nodes ${showB}: ${fmtInt(nodesPerGame(bStats))}/game`);

  const avgDepth = (v) => v.moves > 0 ? (v.sumDepth / v.moves).toFixed(2) : 'n/a';
  console.log(
    `Depth  ${showA}: min=${fmtDepth(aStats.minDepth)} avg=${avgDepth(aStats)} max=${fmtDepth(aStats.maxDepth)}`
  );
  console.log(
    `Depth  ${showB}: min=${fmtDepth(bStats.minDepth)} avg=${avgDepth(bStats)} max=${fmtDepth(bStats.maxDepth)}`
  );

  const avgTime = (v) => v.moves > 0 ? (v.sumTime / v.moves).toFixed(1) : '0.0';
  console.log(
    `Think  ${showA}: min=${fmtMs(aStats.minTime)} avg=${avgTime(aStats)}ms max=${fmtMs(aStats.maxTime)}  (violations: ${aStats.violations})`
  );
  console.log(
    `Think  ${showB}: min=${fmtMs(bStats.minTime)} avg=${avgTime(bStats)}ms max=${fmtMs(bStats.maxTime)}  (violations: ${bStats.violations})`
  );

  // Ponder diagnostic — only print for sides that actually pondered.
  const fmtPonder = (label, v) => {
    if (v.sumPonderSlices === 0 && v.maxPonderMaxDepth === 0 && v.sumPonderNodes === 0) return null;
    const lines = [];
    const avgSlices = v.moves > 0 ? (v.sumPonderSlices / v.moves).toFixed(1) : '0.0';
    const minS = v.minPonderSlices === Infinity ? 0 : v.minPonderSlices;
    const pctActive = v.moves > 0 ? ((v.ponderMovesWithSlices / v.moves) * 100).toFixed(0) : '0';
    lines.push(
      `Ponder ${label}: slices/turn avg=${avgSlices} min=${minS} max=${v.maxPonderSlices}  ` +
      `active=${pctActive}% of turns  peakDepth=${v.maxPonderMaxDepth}`
    );
    const avgNodes = v.moves > 0 ? (v.sumPonderNodes / v.moves) : 0;
    lines.push(
      `Ponder ${label} nodes:    avg/turn ${fmtInt(avgNodes)}  total ${fmtInt(v.sumPonderNodes)}`
    );
    const avgExp = v.moves > 0 ? (v.sumPonderExploredDepth / v.moves).toFixed(2) : '0.00';
    const pctCov = (n) => v.moves > 0 ? ((n / v.moves) * 100).toFixed(0) : '0';
    lines.push(
      `Ponder ${label} coverage: opp avg explored d=${avgExp}  ` +
      `none=${pctCov(v.noneTurns)}%  covered=${pctCov(v.coveredTurns)}%  inFlight=${pctCov(v.inFlightTurns)}%`
    );
    return lines.join('\n');
  };
  const la = fmtPonder(showA, aStats);
  const lb = fmtPonder(showB, bStats);
  if (la) console.log(la);
  if (lb) console.log(lb);

  const fmtTtSize = (label, info, filled) => {
    if (!info) return null;
    const mb = (info.bytes / (1024 * 1024)).toFixed(1);
    let line = `TT ${label}: ${fmtInt(info.entries)} entries, ${mb} MB`;
    if (filled != null) {
      const pct = ((filled / info.entries) * 100).toFixed(1);
      line += `, ${pct}% filled (${fmtInt(filled)} slots)`;
    }
    return line;
  };
  const ta = fmtTtSize(showA, ttInfoA, aStats.maxTtFill);
  const tb = fmtTtSize(showB, ttInfoB, bStats.maxTtFill);
  if (ta) console.log(ta);
  if (tb) console.log(tb);

  // TT hit-rate breakdown. choose's slice is always printed (non-ponder
  // versions get a clean baseline). ponder's slice only prints for sides
  // that actually pondered (sumPonderTtProbes > 0).
  const fmtTt = (label, v) => {
    const lines = [];
    const avgChooseNodes = v.moves > 0 ? (v.sumNodes / v.moves) : 0;
    lines.push(`choose ${label} nodes:    avg/call ${fmtInt(avgChooseNodes)}`);
    if (v.sumPonderTtProbes > 0) {
      const avgPonderNodes = v.moves > 0 ? (v.sumPonderNodes / v.moves) : 0;
      lines.push(`ponder ${label} nodes:    avg/call ${fmtInt(avgPonderNodes)}`);
    }
    const cP = v.sumChooseTtProbes, cH = v.sumChooseTtHits;
    if (cP > 0) {
      const pct = ((cH / cP) * 100).toFixed(1);
      lines.push(`choose ${label} TT hits:  ${pct}%  (${fmtInt(cH)} hits / ${fmtInt(cP)} probes)`);
    }
    const pP = v.sumPonderTtProbes, pH = v.sumPonderTtHits;
    if (pP > 0) {
      const pct = ((pH / pP) * 100).toFixed(1);
      lines.push(`ponder ${label} TT hits:  ${pct}%  (${fmtInt(pH)} hits / ${fmtInt(pP)} probes)`);
    }
    return lines.join('\n');
  };
  console.log(fmtTt(showA, aStats));
  console.log(fmtTt(showB, bStats));

  printWinDistribution(agg);
}

function printWinDistribution(agg) {
  const { labelA, labelB, aStats, bStats, drawsByBucket } = agg;
  const showA = labelA === labelB ? `${labelA}#A` : labelA;
  const showB = labelA === labelB ? `${labelB}#B` : labelB;

  const labels = ['0', '1', '2', '3', '4', '5', '6-10', '11-20', '21-50', '51-100', '>100'];
  const labA  = `${showA} won`;
  const labB  = `${showB} won`;
  const dlabA = `d ${showA}`;
  const dlabB = `d ${showB}`;
  const colW = Math.max(7, labA.length, labB.length);
  const drwW = Math.max(5, 'Draws'.length);
  const depW = Math.max(5, dlabA.length, dlabB.length);
  const totW = Math.max(6, 'Total'.length + 1);

  const header =
    `${'moves'.padEnd(6)} | ${labA.padStart(colW)} | ${labB.padStart(colW)} | ` +
    `${'Draws'.padStart(drwW)} | ${dlabA.padStart(depW)} | ${dlabB.padStart(depW)} | ` +
    `${'Total'.padStart(totW)}`;
  // Build the separator by mapping each header cell to dashes (spaces and
  // text both become '-') and each '|' to '+'. Keeps the column widths in
  // sync automatically if labels change.
  const sep = header.replace(/./g, (c) => (c === '|' ? '+' : '-'));

  const fmtDep = (sum, n) => n > 0 ? (sum / n).toFixed(2) : 'n/a';

  console.log('');
  console.log('Win length distribution:');
  console.log(header);
  console.log(sep);
  for (let i = 0; i < 11; i++) {
    const a = aStats.winsByBucket[i];
    const b = bStats.winsByBucket[i];
    const d = drawsByBucket[i];
    const dA = fmtDep(aStats.sumDepthByBucket[i], aStats.movesByBucket[i]);
    const dB = fmtDep(bStats.sumDepthByBucket[i], bStats.movesByBucket[i]);
    const t = a + b + d;
    console.log(
      `${labels[i].padEnd(6)} | ${String(a).padStart(colW)} | ${String(b).padStart(colW)} | ` +
      `${String(d).padStart(drwW)} | ${dA.padStart(depW)} | ${dB.padStart(depW)} | ` +
      `${String(t).padStart(totW)}`
    );
  }
}

// ---------- Main (single-process) ----------

async function main() {
  const opts = parseArgs(process.argv);

  console.log(
    `Tournament: ${opts.a} vs ${opts.b}, ${opts.games} games (${opts.games / 2} pairs), ` +
    `seed=${opts.seed}, search=${opts.searchTimeMs}ms, turn-limit=${opts.turnTimeMs}ms`
  );

  if (opts.logLosses) fs.writeFileSync(opts.logLossesFile, '');

  const agg = emptyAgg(opts.a, opts.b);
  const nPairs = opts.games / 2;

  const wallT0 = performance.now();
  for (let p = 0; p < nPairs; p++) {
    const seed = opts.seed + p;
    const [gA, gB] = await playPair(seed, opts.a, opts.b, opts);
    addGameToAgg(agg, gA);
    addGameToAgg(agg, gB);
    if (opts.logLosses && pairQualifies(gA, gB, opts.a, opts.b, opts.logLosses)) {
      appendPairBlock(opts.logLossesFile, gA, gB, opts.a, opts.b, opts.logLosses);
    }
  }
  const wallSec = (performance.now() - wallT0) / 1000;

  printReport(agg);
  console.log(`Wall: ${wallSec.toFixed(1)}s`);
}

// Only run main() when tournament.js is invoked directly. Imports
// (tournament core used by uber.js) should not trigger playback.
if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = {
  playGame,
  playPair,
  emptyAgg,
  addGameToAgg,
  mergeAgg,
  printReport,
  appendPairBlock,
  pairQualifies,
};
