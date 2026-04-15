// Reproduce one compareChoose same-depth disagreement and print diagnostic
// state so we can see what differs. Takes --seed, --pig (plies to play
// forward using v18 as reference) and --time-ms.
//
// Prints, for each AI:
//   - root hash (idxH/verH or zobrist)
//   - rootTtMove picked from the TT (and whether TT had an entry)
//   - chosen move + lastDepth
//   - per-depth best-move sequence via a minimal in-process custom loop
//     that inspects choose() internals

const {
  initRandom, makeInitialPositions, stateFromInitialPositions,
  doMove, orderedMoves, moveBufs,
  zobristIdxHash, zobristVerifyHash,
} = require('../game.js');
const { zobristInit } = require('../gameV19.js');
const aiV18 = require('../aiV18.js');
const aiV19 = require('../aiV19.js');

const argv = process.argv.slice(2);
const opts = { seed: 225, pig: 3, timeMs: 180 };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if      (a === '--seed')    opts.seed   = parseInt(argv[++i], 10);
  else if (a === '--pig')     opts.pig    = parseInt(argv[++i], 10);
  else if (a === '--time-ms') opts.timeMs = parseInt(argv[++i], 10);
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

// --- Set up game state: play forward using the SAME sequence both AIs
// would witness. We want the TT state going into the contested ply to
// reflect what each AI has actually searched in this game. So we run
// both choose()s at each prior ply, and advance the game using v18's
// move (the compareChoose reference).

const s0 = initRandom(opts.seed);
const ip = makeInitialPositions(s0);
let s = stateFromInitialPositions(ip);
const secs = opts.timeMs / 1000;
aiV18.clearTT();
aiV19.clearTT();
const ai18 = new aiV18.AB(s.turn, secs);
const ai19 = new aiV19.AB(s.turn, secs);

for (let p = 0; p < opts.pig; p++) {
  ai18.pl = s.turn;
  ai19.pl = s.turn;
  const m18 = ai18.choose(cloneForDoMove(s));
  ai19.choose(cloneForDoMove(s));
  s = doMove(s, m18);
}

// Now we're at the contested ply. Dump state + AI views.
console.log(`=== seed=${opts.seed} pig=${opts.pig} ply=${s.ply} turn=${s.turn} ===`);
console.log(`board pieces:`);
const cells = [];
for (let i = 0; i < 100; i++) if (s.b[i] !== 0) cells.push(`${i}:${s.b[i]}`);
console.log(`  ${cells.join(' ')}`);
console.log(`  r1=${s.r1} r2=${s.r2} sph1=${s.sph1} sph2=${s.sph2}`);
console.log(`  cd=${s.cd1s}/${s.cd1p}/${s.cd2s}/${s.cd2p} pq=${s.pq ? JSON.stringify(s.pq) : 'null'}`);

// v18 hash for this state
const v18Idx = zobristIdxHash(s);
const v18Ver = zobristVerifyHash(s);
console.log(`v18 hash: idxH=${v18Idx} verH=${v18Ver} slot=${v18Idx & ((1 << 19) - 1)}`);

// v19 hash
const sCopy = cloneForDoMove(s);
zobristInit(sCopy);
console.log(`v19 hash: idxH=${sCopy.idxH} verH=${sCopy.verH} fixed=${sCopy.verH || 1} slot=${sCopy.idxH & ((1 << 19) - 1)}`);

// TT probe inspection for both (before the contested choose() call).
function probeV18(s) {
  const TT_BITS = 19, TT_MASK = (1 << TT_BITS) - 1;
  const slotIdx = zobristIdxHash(s) & TT_MASK;
  const verH = zobristVerifyHash(s);
  const ttV = aiV18.__ttVerify;
  const ttD = aiV18.__ttData;
  return { slotIdx, verH };
}

// We need access to internal TT; not exported. Fall back to running choose()
// and comparing outputs directly. Instrument via re-implementation of root
// TT probe. We already know the hash — check the slot indirectly by running
// choose() and observing.

// Run both choose() instances on the contested position and print results.
ai18.pl = s.turn;
ai19.pl = s.turn;

const s18 = cloneForDoMove(s);
const m18 = ai18.choose(s18);
const d18 = ai18.lastDepth;
const n18 = ai18.nodes;
console.log('');
console.log(`v18: ${decodeMove(m18)} at depth ${d18} (nodes=${n18})`);

const s19 = cloneForDoMove(s);
const m19 = ai19.choose(s19);
const d19 = ai19.lastDepth;
const n19 = ai19.nodes;
console.log(`v19: ${decodeMove(m19)} at depth ${d19} (nodes=${n19})`);

console.log('');
console.log(`match: move=${m18 === m19}  depth=${d18 === d19}`);
