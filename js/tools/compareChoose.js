// Probe 2c: call the shipped choose() directly with a matched time budget
// on the same in-game positions and log (depth, move) for each. This is
// the closest replica of what the tournament actually exercises.
//
// For each game:
//   - play a scripted self-play forward using v18.choose as the reference
//   - at each ply, independently call v18.choose and v19.choose on the
//     same position with a matched time budget
//   - log depth reached and chosen move for both
//   - tally: (1) move agreements, (2) move disagreements at same depth,
//            (3) move disagreements due to depth difference
//
// Usage:
//   node js/tools/compareChoose.js --games 10 --time-ms 180 --max-ply 80

const {
  initRandom, makeInitialPositions, stateFromInitialPositions,
  doMove,
} = require('../game.js');
const aiV18 = require('../aiV18.js');
const aiV19 = require('../aiV19.js');

// --- CLI ---
const argv = process.argv.slice(2);
const opts = {
  games: 10,
  timeMs: 180,
  startSeed: 200,
  maxPly: 80,
  verbose: false,
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if      (a === '--games')      opts.games     = parseInt(argv[++i], 10);
  else if (a === '--time-ms')    opts.timeMs    = parseInt(argv[++i], 10);
  else if (a === '--start-seed') opts.startSeed = parseInt(argv[++i], 10);
  else if (a === '--max-ply')    opts.maxPly    = parseInt(argv[++i], 10);
  else if (a === '-v')           opts.verbose   = true;
  else if (a === '-h' || a === '--help') {
    console.log('Usage: node compareChoose.js [--games N] [--time-ms T] [--start-seed S] [--max-ply P] [-v]');
    process.exit(0);
  }
}

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

// --- Main ---

console.log(`compareChoose: games=${opts.games} time=${opts.timeMs}ms start-seed=${opts.startSeed}`);

let totalPlies = 0;
let agreeSameDepth = 0;
let agreeDiffDepth = 0;
let disagreeSameDepth = 0;
let disagreeDiffDepth = 0;
const sameDepthDisagreements = [];

const depthHist18 = new Map();
const depthHist19 = new Map();

const t0 = Date.now();
for (let g = 0; g < opts.games; g++) {
  const seed = opts.startSeed + g;
  const s0 = initRandom(seed);
  const ip = makeInitialPositions(s0);
  let s = stateFromInitialPositions(ip);

  // Fresh AIs + cleared TTs per game (mirrors index.js:42 setup()).
  aiV18.clearTT();
  aiV19.clearTT();
  const secs = opts.timeMs / 1000;
  const ai18 = new aiV18.AB(s.turn, secs);
  const ai19 = new aiV19.AB(s.turn, secs);

  let pig = 0;
  while (s.win === 0 && s.ply < opts.maxPly) {
    ai18.pl = s.turn;
    ai19.pl = s.turn;

    // Call both shipped choose() on independent clones so neither touches
    // the other's state. Both use their own module-level persistent TT.
    const m18 = ai18.choose(cloneForDoMove(s));
    const d18 = ai18.lastDepth;
    const m19 = ai19.choose(cloneForDoMove(s));
    const d19 = ai19.lastDepth;

    depthHist18.set(d18, (depthHist18.get(d18) || 0) + 1);
    depthHist19.set(d19, (depthHist19.get(d19) || 0) + 1);

    const sameDepth = d18 === d19;
    const agree = m18 === m19;
    if (agree && sameDepth)       agreeSameDepth++;
    else if (agree && !sameDepth) agreeDiffDepth++;
    else if (!agree && sameDepth) {
      disagreeSameDepth++;
      if (sameDepthDisagreements.length < 20) {
        sameDepthDisagreements.push({
          seed, pig, ply: s.ply, turn: s.turn, depth: d18,
          m18, m19,
        });
      }
    } else {
      disagreeDiffDepth++;
    }
    totalPlies++;

    // Advance the game via v18's choice (reference).
    s = doMove(s, m18);
    pig++;
  }
  if (opts.verbose) console.log(`  seed=${seed}: played ${pig} plies, winner=${s.win}`);
}
const dt = (Date.now() - t0) / 1000;

console.log('');
console.log(`Ran ${totalPlies} ply-level comparisons across ${opts.games} games in ${dt.toFixed(1)}s`);
console.log('');
console.log('Outcome breakdown:');
console.log(`  agree at same depth      : ${agreeSameDepth.toString().padStart(5)} (${(100 * agreeSameDepth / totalPlies).toFixed(1)}%)`);
console.log(`  agree at different depth : ${agreeDiffDepth.toString().padStart(5)} (${(100 * agreeDiffDepth / totalPlies).toFixed(1)}%)`);
console.log(`  disagree at same depth   : ${disagreeSameDepth.toString().padStart(5)} (${(100 * disagreeSameDepth / totalPlies).toFixed(1)}%)`);
console.log(`  disagree at diff depth   : ${disagreeDiffDepth.toString().padStart(5)} (${(100 * disagreeDiffDepth / totalPlies).toFixed(1)}%)`);

function histLine(label, m) {
  const keys = Array.from(m.keys()).sort((a, b) => a - b);
  const parts = keys.map(k => `${k}:${m.get(k)}`);
  console.log(`  ${label}: ${parts.join(' ')}`);
}
console.log('');
console.log('Depth distribution:');
histLine('v18', depthHist18);
histLine('v19', depthHist19);

if (sameDepthDisagreements.length > 0) {
  console.log('');
  console.log(`First ${sameDepthDisagreements.length} SAME-DEPTH disagreements (these are the interesting ones):`);
  for (const d of sameDepthDisagreements) {
    console.log(
      `  seed=${d.seed} pig=${d.pig} ply=${d.ply} turn=${d.turn} d=${d.depth}: ` +
      `v18=${decodeMove(d.m18)}  |  v19=${decodeMove(d.m19)}`
    );
  }
}
