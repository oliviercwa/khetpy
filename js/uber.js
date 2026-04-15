// Uber tournament harness — parallelizes tournament.js across forked
// child processes. Same CLI as tournament.js plus --workers N. Each
// worker plays a slice of the paired games to completion and sends back
// a local aggregate, which the main process merges and reports.
//
// Uses child_process.fork instead of worker_threads for compatibility
// with older Node versions. Each worker is a fresh Node VM with its own
// module-level transposition tables, so there is no cross-worker TT
// interference. The AB hot path is never touched.
//
// Usage:
//   node uber.js --workers 8 --games 200 --a v18 --b v19
//   node uber.js --workers 4 --games 100 --seed 0 --turn-time-ms 250

const { fork } = require('child_process');
const { performance } = require('perf_hooks');
const os = require('os');
const fs = require('fs');

const tc = require('./tournament.js');

const WORKER_FLAG = '--worker-mode';
const isWorker = process.argv.includes(WORKER_FLAG);

// ---------- CLI ----------

function parseArgs(argv) {
  const opts = {
    games:          100,
    seed:           0,
    turnTimeMs:     250,
    searchTimeMs:   230,
    a:              'v19',
    b:              'v19',
    maxPly:         200,
    verbose:        false,
    ponderWindowMs: 0,
    workers:        Math.max(1, (os.cpus() && os.cpus().length) || 1),
    logLosses:      null,
    logLossesFile:  'losses.log',
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if      (a === WORKER_FLAG)                       continue;   // consumed by dispatch
    else if (a === '--games'          || a === '-g')  opts.games          = parseInt(argv[++i], 10);
    else if (a === '--seed'           || a === '-s')  opts.seed           = parseInt(argv[++i], 10);
    else if (a === '--turn-time-ms')                  opts.turnTimeMs     = parseFloat(argv[++i]);
    else if (a === '--search-time-ms')                opts.searchTimeMs   = parseFloat(argv[++i]);
    else if (a === '--ponder-window-ms')              opts.ponderWindowMs = parseFloat(argv[++i]);
    else if (a === '--a')                             opts.a              = argv[++i];
    else if (a === '--b')                             opts.b              = argv[++i];
    else if (a === '--max-ply')                       opts.maxPly         = parseInt(argv[++i], 10);
    else if (a === '--workers'        || a === '-w')  opts.workers        = parseInt(argv[++i], 10);
    else if (a === '--verbose'        || a === '-v')  opts.verbose        = true;
    else if (a === '--log-losses')                    opts.logLosses      = argv[++i];
    else if (a === '--log-losses-file')               opts.logLossesFile  = argv[++i];
    else if (a === '--help'           || a === '-h') {
      console.log(
        'Usage: node uber.js [--workers N] [--games N] [--seed S]\n' +
        '                    [--a v18|v19] [--b v18|v19]\n' +
        '                    [--turn-time-ms MS] [--search-time-ms MS]\n' +
        '                    [--max-ply N] [--verbose]\n' +
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
  if (opts.workers < 1) opts.workers = 1;
  return opts;
}

// ---------- Worker body ----------

// When forked with WORKER_FLAG, the process waits for a single message
// carrying { pairIndices, opts }, plays them, and sends back { agg }.
function workerMain() {
  process.on('message', async (msg) => {
    try {
      const { pairIndices, opts } = msg;
      const agg = tc.emptyAgg(opts.a, opts.b);
      const lossPairs = [];
      const slim = (game) => ({
        seed:             game.seed,
        plies:            game.plies,
        winner:           game.winner,
        reason:           game.reason,
        p1Version:        game.p1Version,
        p2Version:        game.p2Version,
        moveHistory:      game.moveHistory,
        depthHistory:     game.depthHistory,
        nodesHistory:     game.nodesHistory,
        timeHistory:      game.timeHistory,
        initialPositions: game.initialPositions,
      });
      for (const p of pairIndices) {
        const seed = opts.seed + p;
        const [gA, gB] = await tc.playPair(seed, opts.a, opts.b, opts);
        tc.addGameToAgg(agg, gA);
        tc.addGameToAgg(agg, gB);
        if (opts.logLosses && tc.pairQualifies(gA, gB, opts.a, opts.b, opts.logLosses)) {
          lossPairs.push({ gA: slim(gA), gB: slim(gB) });
        }
      }
      process.send({ agg, lossPairs }, () => process.exit(0));
    } catch (e) {
      console.error('[worker] error:', e && e.stack || e);
      process.exit(1);
    }
  });
}

// ---------- Main ----------

function splitPairs(nPairs, nWorkers) {
  // Round-robin so long/short games are spread rather than concentrated.
  const out = [];
  for (let w = 0; w < nWorkers; w++) out.push([]);
  for (let p = 0; p < nPairs; p++) out[p % nWorkers].push(p);
  return out;
}

function runWorker(slice, opts) {
  return new Promise((resolve, reject) => {
    const child = fork(__filename, [WORKER_FLAG], { silent: false });
    let done = false;
    child.on('message', (msg) => {
      if (msg && msg.agg) {
        done = true;
        resolve({ agg: msg.agg, lossPairs: msg.lossPairs || [] });
      }
    });
    child.on('error', (e) => {
      if (!done) reject(e);
    });
    child.on('exit', (code) => {
      if (!done) reject(new Error(`worker exited with code ${code} before sending result`));
    });
    child.send({ pairIndices: slice, opts });
  });
}

async function mainThreadMain() {
  const opts = parseArgs(process.argv);
  const nPairs = opts.games / 2;
  const nWorkers = Math.min(opts.workers, Math.max(1, nPairs));

  console.log(
    `Uber: ${opts.a} vs ${opts.b}, ${opts.games} games (${nPairs} pairs), ` +
    `seed=${opts.seed}, search=${opts.searchTimeMs}ms, turn-limit=${opts.turnTimeMs}ms, ` +
    `workers=${nWorkers}`
  );

  const slices = splitPairs(nPairs, nWorkers);

  // Drop empty slices (when nPairs < nWorkers is capped above, but be safe).
  const activeSlices = slices.filter((s) => s.length > 0);

  const wallT0 = performance.now();
  const results = await Promise.all(activeSlices.map((s) => runWorker(s, opts)));
  const wallSec = (performance.now() - wallT0) / 1000;

  const workerAggs = results.map((r) => r.agg);
  const allLossPairs = [];
  for (const r of results) for (const pr of r.lossPairs) allLossPairs.push(pr);

  // Worker-side agg structures serialized through IPC lose the Infinity
  // sentinel for untouched min fields (JSON-based IPC turns Infinity into
  // null). Restore sentinels so mergeAgg behaves correctly.
  for (const a of workerAggs) reviveInfinities(a);

  const combined = tc.emptyAgg(opts.a, opts.b);
  for (const wa of workerAggs) tc.mergeAgg(combined, wa);

  tc.printReport(combined);
  console.log(
    `Wall: ${wallSec.toFixed(1)}s  (${(opts.games / wallSec).toFixed(1)} games/s across ${nWorkers} workers)`
  );

  if (opts.logLosses) {
    fs.writeFileSync(opts.logLossesFile, '');
    if (allLossPairs.length > 0) {
      allLossPairs.sort((x, y) => x.gA.seed - y.gA.seed);
      for (const pr of allLossPairs) {
        tc.appendPairBlock(opts.logLossesFile, pr.gA, pr.gB, opts.a, opts.b, opts.logLosses);
      }
      console.log(`Logged ${allLossPairs.length} qualifying pairs to ${opts.logLossesFile}`);
    }
  }
}

function reviveInfinities(agg) {
  for (const va of [agg.aStats, agg.bStats]) {
    if (va.minTime === null || va.minTime === undefined) va.minTime = Infinity;
    if (va.minDepth === null || va.minDepth === undefined) va.minDepth = Infinity;
  }
}

// ---------- Dispatch ----------

if (isWorker) {
  workerMain();
} else {
  mainThreadMain().catch((e) => { console.error(e); process.exit(1); });
}
