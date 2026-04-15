// yourTeam.js — bundled submission (version v19)
// Generated 2026-04-12T20:32:17.336Z
// Do not edit by hand. Run: node js/bundle.js --version v19

'use strict';
const { performance } = require('perf_hooks');
const __m = Object.create(null);

// ----- game.js -----
__m["./game.js"] = (function() {
// Khet game rules, board representation, move generation, laser resolution,
// evaluation, Zobrist hashing, and JS tournament API translation.
//
// Board: Uint8Array(100), cell index r*10+c (row 0 = top = P1 home row).
// Piece byte: 0 = empty, otherwise (type << 4) | (owner << 2) | dIdx
//   type  ∈ {1..5} = T_PHARAOH, T_SPHINX, T_SCARAB, T_ANUBIS, T_PYRAMID
//   owner ∈ {1, 2}
//   dIdx  ∈ {0..3} = 0°, 90°, 180°, 270°  (0=N, 1=E, 2=S, 3=W)
//
// Move: packed 32-bit int
//   bits 31-28 code: 1=R, 2=M, 3=P, 4=S
//   R: [code|4:r|4:c|1:dd]                    dd 1=CW, 0=CCW
//   M: [code|4:r|4:c|4:nr|4:nc]
//   P: [code|4:r|4:c|2:dIdx]
//   S: [code|1:tgt]                            tgt 0=sphinx, 1=pharaoh

const T_PHARAOH = 1;
const T_SPHINX  = 2;
const T_SCARAB  = 3;
const T_ANUBIS  = 4;
const T_PYRAMID = 5;

const A_R = 1;
const A_M = 2;
const A_P = 3;
const A_S = 4;

const DR = [-1, 0, 1, 0];
const DC = [ 0, 1, 0,-1];

const VALS = new Int32Array(8);
VALS[T_PHARAOH] = 1000;
VALS[T_SPHINX]  = 50;
VALS[T_SCARAB]  = 40;
VALS[T_ANUBIS]  = 30;
VALS[T_PYRAMID] = 20;

// Pyramid deflection table: PYR_REDIRECT[pyrDIdx*4 + incDIdx]
// = new dIdx if beam deflected, -1 if pyramid is hit (absorbed).
// From Python PYR = {0:{270:0, 180:90}, 90:{0:90, 270:180},
//                    180:{0:270, 90:180}, 270:{90:0, 180:270}}
// dIdx mapping: 0→0, 90→1, 180→2, 270→3
const PYR_REDIRECT = new Int8Array(16);
PYR_REDIRECT.fill(-1);
PYR_REDIRECT[0 * 4 + 3] = 0;
PYR_REDIRECT[0 * 4 + 2] = 1;
PYR_REDIRECT[1 * 4 + 0] = 1;
PYR_REDIRECT[1 * 4 + 3] = 2;
PYR_REDIRECT[2 * 4 + 0] = 3;
PYR_REDIRECT[2 * 4 + 1] = 2;
PYR_REDIRECT[3 * 4 + 1] = 0;
PYR_REDIRECT[3 * 4 + 2] = 3;

// Scarab deflection: SCR_REDIRECT[scarabDIdx*4 + incDIdx] = new dIdx.
// Even scarab (d ∈ {0°,180°}): inc 0→3, 1→2, 2→1, 3→0
// Odd scarab  (d ∈ {90°,270°}): inc 0→1, 1→0, 2→3, 3→2
const SCR_REDIRECT = new Int8Array(16);
const SCR_EVEN = [3, 2, 1, 0];
const SCR_ODD  = [1, 0, 3, 2];
for (let inc = 0; inc < 4; inc++) {
  SCR_REDIRECT[0 * 4 + inc] = SCR_EVEN[inc];
  SCR_REDIRECT[1 * 4 + inc] = SCR_ODD[inc];
  SCR_REDIRECT[2 * 4 + inc] = SCR_EVEN[inc];
  SCR_REDIRECT[3 * 4 + inc] = SCR_ODD[inc];
}

const PYRAMID_RETURN_DELAY = 2;
const SWAP_COOLDOWN = 4;
const TURN_LIMIT = 100;

function mkPiece(t, o, d) { return (t << 4) | (o << 2) | d; }

// ---------- State ----------

function newState() {
  return {
    b: new Uint8Array(100),
    r1: 7, r2: 7,
    turn: 1, ply: 0, win: 0,
    sph1: -1, sph2: -1,
    cd1s: 0, cd1p: 0, cd2s: 0, cd2p: 0,
    pq: null,
  };
}

function cloneState(s) {
  return {
    b: s.b.slice(),
    r1: s.r1, r2: s.r2,
    turn: s.turn, ply: s.ply, win: s.win,
    sph1: s.sph1, sph2: s.sph2,
    cd1s: s.cd1s, cd1p: s.cd1p, cd2s: s.cd2s, cd2p: s.cd2p,
    pq: s.pq ? s.pq.slice() : null,
  };
}

function terminal(s) { return s.win !== 0; }

// ---------- Laser ----------

const _laserSeen = new Uint8Array(400); // (cell*4 + d) visited
const _doLaserHits = new Int32Array(32);

// Walk the laser beam, writing hits into outHits as (cell, piece) pairs.
// Returns hit count.
function laser(s, pl, outHits) {
  const sph = pl === 1 ? s.sph1 : s.sph2;
  if (sph < 0) return 0;
  const start = s.b[sph];
  if (start === 0) return 0;
  let d = start & 3;
  let r = (sph / 10) | 0;
  let c = sph - r * 10;
  r += DR[d]; c += DC[d];
  _laserSeen.fill(0);
  const b = s.b;
  let count = 0;
  while (r >= 0 && r < 10 && c >= 0 && c < 10) {
    const cell = r * 10 + c;
    const key = cell * 4 + d;
    if (_laserSeen[key]) break;
    _laserSeen[key] = 1;
    const q = b[cell];
    if (q === 0) { r += DR[d]; c += DC[d]; continue; }
    const inc = (d + 2) & 3;
    const qt = q >> 4;
    if (qt === T_SPHINX) break;
    if (qt === T_PHARAOH) {
      outHits[count++] = cell;
      outHits[count++] = q;
      break;
    }
    if (qt === T_ANUBIS) {
      const qd = q & 3;
      // Python: block if (q.d - inc) % 360 == 180, i.e. qd XOR 2 == inc
      if (((qd - inc) & 3) === 2) break;
      outHits[count++] = cell;
      outHits[count++] = q;
      r += DR[d]; c += DC[d];
      continue;
    }
    if (qt === T_PYRAMID) {
      const pd = q & 3;
      const nd = PYR_REDIRECT[pd * 4 + inc];
      if (nd >= 0) {
        d = nd;
        r += DR[d]; c += DC[d];
        continue;
      }
      outHits[count++] = cell;
      outHits[count++] = q;
      r += DR[d]; c += DC[d];
      continue;
    }
    // Scarab
    d = SCR_REDIRECT[(q & 3) * 4 + inc];
    r += DR[d]; c += DC[d];
  }
  return count >> 1;
}

// laser is exported via module.exports at the bottom

// ---------- doMove ----------

function doMove(s, move) {
  const ns = cloneState(s);
  const actingPlayer = s.turn;
  ns.turn = 3 - actingPlayer;
  ns.ply = s.ply + 1;
  ns.win = 0;

  const code = (move >>> 28) & 0xF;
  let fireLaser = true;

  if (code === A_R) {
    const r = (move >>> 24) & 0xF;
    const c = (move >>> 20) & 0xF;
    const dd = (move >>> 19) & 1;
    const cell = r * 10 + c;
    const p = ns.b[cell];
    const newDir = (((p & 3) + (dd === 1 ? 1 : 3)) & 3);
    ns.b[cell] = (p & 0xFC) | newDir;
  } else if (code === A_M) {
    const r = (move >>> 24) & 0xF;
    const c = (move >>> 20) & 0xF;
    const nr = (move >>> 16) & 0xF;
    const nc = (move >>> 12) & 0xF;
    const from = r * 10 + c;
    const to = nr * 10 + nc;
    ns.b[to] = ns.b[from];
    ns.b[from] = 0;
  } else if (code === A_P) {
    const r = (move >>> 24) & 0xF;
    const c = (move >>> 20) & 0xF;
    const d = (move >>> 18) & 3;
    const cell = r * 10 + c;
    ns.b[cell] = mkPiece(T_PYRAMID, actingPlayer, d);
    if (actingPlayer === 1) ns.r1--; else ns.r2--;
  } else {
    // EXCHANGE
    const tgt = move & 1;           // 0=sphinx, 1=pharaoh
    const targetT = tgt === 0 ? T_SPHINX : T_PHARAOH;
    let scCell = -1, tgCell = -1;
    const b = ns.b;
    for (let i = 0; i < 100; i++) {
      const bp = b[i];
      if (bp === 0) continue;
      if (((bp >> 2) & 3) !== actingPlayer) continue;
      const t = bp >> 4;
      if (t === T_SCARAB) scCell = i;
      else if (t === targetT) tgCell = i;
      if (scCell >= 0 && tgCell >= 0) break;
    }
    if (scCell >= 0 && tgCell >= 0) {
      const sp = b[scCell];
      const tp = b[tgCell];
      b[scCell] = tp;
      b[tgCell] = sp;
      if (tgt === 0) {
        // Sphinx moved to scarab's old cell; skip laser this turn.
        if (actingPlayer === 1) { ns.sph1 = scCell; ns.cd1s = SWAP_COOLDOWN; }
        else                    { ns.sph2 = scCell; ns.cd2s = SWAP_COOLDOWN; }
        fireLaser = false;
      } else {
        if (actingPlayer === 1) ns.cd1p = SWAP_COOLDOWN;
        else                    ns.cd2p = SWAP_COOLDOWN;
      }
    }
  }

  // Fire laser
  if (fireLaser) {
    const n = laser(ns, actingPlayer, _doLaserHits);
    let loserMask = 0; // bit 0 = P1 lost pharaoh, bit 1 = P2
    const b = ns.b;
    for (let i = 0; i < n; i++) {
      const cell = _doLaserHits[i * 2];
      const hp   = _doLaserHits[i * 2 + 1];
      const cur = b[cell];
      // Python check: same type+owner (ignore direction since direction may change)
      if ((cur & 0xFC) !== (hp & 0xFC)) continue;
      const ht = hp >> 4;
      const ho = (hp >> 2) & 3;
      if (ht === T_PHARAOH) {
        loserMask |= (1 << (ho - 1));
        b[cell] = 0;
      } else {
        b[cell] = 0;
        if (ht === T_PYRAMID) {
          if (ns.pq === null) ns.pq = [];
          ns.pq.push(ns.ply + PYRAMID_RETURN_DELAY, ho);
        }
      }
    }
    if (loserMask !== 0) {
      if (loserMask === 3)      ns.win = -1;  // both pharaohs destroyed — draw
      else if (loserMask === 1) ns.win = 2;
      else                      ns.win = 1;
    }
  }

  // Decrement cooldowns
  if (ns.cd1s > 0) ns.cd1s--;
  if (ns.cd1p > 0) ns.cd1p--;
  if (ns.cd2s > 0) ns.cd2s--;
  if (ns.cd2p > 0) ns.cd2p--;

  // Pyramid return queue — returns go to OPPONENT of the owner
  if (ns.pq !== null && ns.pq.length > 0) {
    const pq = ns.pq;
    let write = 0;
    for (let i = 0; i < pq.length; i += 2) {
      const rp = pq[i];
      const owner = pq[i + 1];
      if (rp <= ns.ply) {
        if (owner === 1) ns.r2++;
        else              ns.r1++;
      } else {
        pq[write++] = rp;
        pq[write++] = owner;
      }
    }
    pq.length = write;
    if (write === 0) ns.pq = null;
  }

  // Turn-limit material tiebreak
  if (ns.ply >= TURN_LIMIT && ns.win === 0) {
    let m1 = 0, m2 = 0;
    const b = ns.b;
    for (let i = 0; i < 100; i++) {
      const bp = b[i];
      if (bp === 0) continue;
      const v = VALS[bp >> 4];
      if (((bp >> 2) & 3) === 1) m1 += v;
      else                        m2 += v;
    }
    if (m1 > m2)      ns.win = 1;
    else if (m2 > m1) ns.win = 2;
    else              ns.win = -1;
  }

  return ns;
}

// ---------- Move generation ----------

const MAX_DEPTH = 18;
const MOVE_BUF_SIZE = 500;
const moveBufs    = new Array(MAX_DEPTH);
const scratchBufs = new Array(MAX_DEPTH);
for (let i = 0; i < MAX_DEPTH; i++) {
  moveBufs[i]    = new Int32Array(MOVE_BUF_SIZE);
  scratchBufs[i] = new Int32Array(MOVE_BUF_SIZE);
}

const _blocked = new Uint8Array(100);

// orderedMoves(s, bufDepth) fills moveBufs[bufDepth] with legal moves
// and returns { count, oppPh } where oppPh is the opponent pharaoh cell or -1.
function orderedMoves(s, bufDepth) {
  const buf = moveBufs[bufDepth];
  let n = 0;
  const pl = s.turn;
  const b = s.b;
  let hasScarab = false;
  let ownPharaoh = -1;
  let oppPharaoh = -1;

  for (let cell = 0; cell < 100; cell++) {
    const p = b[cell];
    if (p === 0) continue;
    const o = (p >> 2) & 3;
    const t = p >> 4;
    if (o !== pl) {
      if (t === T_PHARAOH) oppPharaoh = cell;
      continue;
    }
    if (t === T_SCARAB) hasScarab = true;
    else if (t === T_PHARAOH) ownPharaoh = cell;
    const r = (cell / 10) | 0;
    const c = cell - r * 10;
    // Rotate (all except pharaoh)
    if (t !== T_PHARAOH) {
      const base = (A_R << 28) | (r << 24) | (c << 20);
      buf[n++] = base | (1 << 19);   // CW
      buf[n++] = base;                // CCW
    }
    // Move (anubis, pyramid, scarab)
    if (t === T_ANUBIS || t === T_PYRAMID || t === T_SCARAB) {
      for (let di = 0; di < 4; di++) {
        const nr = r + DR[di], nc = c + DC[di];
        if (nr >= 0 && nr < 10 && nc >= 0 && nc < 10 && b[nr * 10 + nc] === 0) {
          buf[n++] = (A_M << 28) | (r << 24) | (c << 20) | (nr << 16) | (nc << 12);
        }
      }
    }
  }

  // Placements
  const reserve = pl === 1 ? s.r1 : s.r2;
  if (reserve > 0) {
    _blocked.fill(0);
    // Mark cells adjacent to own pharaoh and both sphinxes
    const mark = (cell) => {
      if (cell < 0) return;
      const cr = (cell / 10) | 0, cc = cell - cr * 10;
      if (cr > 0)         _blocked[cell - 10] = 1;
      if (cr < 9)         _blocked[cell + 10] = 1;
      if (cc > 0)         _blocked[cell - 1]  = 1;
      if (cc < 9)         _blocked[cell + 1]  = 1;
    };
    mark(ownPharaoh);
    mark(s.sph1);
    mark(s.sph2);
    for (let cell = 0; cell < 100; cell++) {
      if (b[cell] !== 0 || _blocked[cell]) continue;
      const r = (cell / 10) | 0;
      const c = cell - r * 10;
      const base = (A_P << 28) | (r << 24) | (c << 20);
      buf[n++] = base | (0 << 18);
      buf[n++] = base | (1 << 18);
      buf[n++] = base | (2 << 18);
      buf[n++] = base | (3 << 18);
    }
  }

  // Swaps
  if (hasScarab) {
    const ownSphinx = pl === 1 ? s.sph1 : s.sph2;
    const cdS = pl === 1 ? s.cd1s : s.cd2s;
    const cdP = pl === 1 ? s.cd1p : s.cd2p;
    if (ownSphinx >= 0 && cdS === 0) buf[n++] = (A_S << 28) | 0;
    if (ownPharaoh >= 0 && cdP === 0) buf[n++] = (A_S << 28) | 1;
  }

  return { count: n, oppPh: oppPharaoh };
}

// ---------- evalf ----------

const _evalHitsA = new Int32Array(32);
const _evalHitsB = new Int32Array(32);

function evalf(s, pl) {
  if (s.win !== 0) {
    if (s.win === -1) return 0;
    return s.win === pl ? 100000 : -100000;
  }
  const op = 3 - pl;
  let sc = 0;
  const b = s.b;
  for (let cell = 0; cell < 100; cell++) {
    const p = b[cell];
    if (p === 0) continue;
    const t = p >> 4;
    const o = (p >> 2) & 3;
    const r = (cell / 10) | 0;
    let v = VALS[t];
    const adv = pl === 1 ? r : 9 - r;
    v += adv * 2;
    sc += (o === pl) ? v : -v;
  }
  const nOwn = laser(s, pl, _evalHitsA);
  const nOpp = laser(s, op, _evalHitsB);
  for (let i = 0; i < nOwn; i++) {
    const hp = _evalHitsA[i * 2 + 1];
    const ht = hp >> 4;
    if (ht === T_PHARAOH) return 50000;
    if (ht === T_ANUBIS) sc += 500;
    else if (ht === T_PYRAMID) sc += 200;
  }
  for (let i = 0; i < nOpp; i++) {
    const hp = _evalHitsB[i * 2 + 1];
    const ht = hp >> 4;
    if (ht === T_PHARAOH) return -50000;
    if (ht === T_ANUBIS) sc -= 500;
    else if (ht === T_PYRAMID) sc -= 200;
  }
  sc -= s.ply * 2;
  return sc;
}

// ---------- Zobrist hashing ----------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) | 0;
  };
}

const _zRng = mulberry32(0xC0FFEE);
function _rand32() {
  let x = _zRng();
  if (x === 0) x = 1;
  return x;
}

// Indexed by [cell * 256 + pieceByte]. Overallocated (most piece bytes unused).
const Z_PIECE  = new Int32Array(100 * 256);
const ZV_PIECE = new Int32Array(100 * 256);
const Z_TURN   = new Int32Array(4);
const ZV_TURN  = new Int32Array(4);
const Z_RES    = new Int32Array(2 * 16);   // [player * 16 + reserve]
const ZV_RES   = new Int32Array(2 * 16);
const Z_CD     = new Int32Array(2 * 2 * 8); // [player * 16 + kind * 8 + cd]
const ZV_CD    = new Int32Array(2 * 2 * 8);
const Z_PLY    = new Int32Array(128);
const ZV_PLY   = new Int32Array(128);
const Z_PQ     = new Int32Array(256);       // [(returnPly * 2) + (owner - 1)]
const ZV_PQ    = new Int32Array(256);

for (let i = 0; i < Z_PIECE.length; i++) { Z_PIECE[i]  = _rand32(); ZV_PIECE[i] = _rand32(); }
for (let i = 0; i < Z_TURN.length;  i++) { Z_TURN[i]   = _rand32(); ZV_TURN[i]  = _rand32(); }
for (let i = 0; i < Z_RES.length;   i++) { Z_RES[i]    = _rand32(); ZV_RES[i]   = _rand32(); }
for (let i = 0; i < Z_CD.length;    i++) { Z_CD[i]     = _rand32(); ZV_CD[i]    = _rand32(); }
for (let i = 0; i < Z_PLY.length;   i++) { Z_PLY[i]    = _rand32(); ZV_PLY[i]   = _rand32(); }
for (let i = 0; i < Z_PQ.length;    i++) { Z_PQ[i]     = _rand32(); ZV_PQ[i]    = _rand32(); }

function zobristIdxHash(s) {
  let h = 0;
  const b = s.b;
  for (let i = 0; i < 100; i++) {
    const p = b[i];
    if (p !== 0) h ^= Z_PIECE[(i << 8) | p];
  }
  h ^= Z_TURN[s.turn];
  h ^= Z_RES[s.r1];
  h ^= Z_RES[16 + s.r2];
  h ^= Z_CD[s.cd1s];
  h ^= Z_CD[8 + s.cd1p];
  h ^= Z_CD[16 + s.cd2s];
  h ^= Z_CD[24 + s.cd2p];
  h ^= Z_PLY[s.ply & 127];
  if (s.pq !== null) {
    const pq = s.pq;
    for (let i = 0; i < pq.length; i += 2) {
      h ^= Z_PQ[(pq[i] << 1) | (pq[i + 1] - 1)];
    }
  }
  return h | 0;
}

function zobristVerifyHash(s) {
  let h = 1;
  const b = s.b;
  for (let i = 0; i < 100; i++) {
    const p = b[i];
    if (p !== 0) h ^= ZV_PIECE[(i << 8) | p];
  }
  h ^= ZV_TURN[s.turn];
  h ^= ZV_RES[s.r1];
  h ^= ZV_RES[16 + s.r2];
  h ^= ZV_CD[s.cd1s];
  h ^= ZV_CD[8 + s.cd1p];
  h ^= ZV_CD[16 + s.cd2s];
  h ^= ZV_CD[24 + s.cd2p];
  h ^= ZV_PLY[s.ply & 127];
  if (s.pq !== null) {
    const pq = s.pq;
    for (let i = 0; i < pq.length; i += 2) {
      h ^= ZV_PQ[(pq[i] << 1) | (pq[i + 1] - 1)];
    }
  }
  if (h === 0) h = 1;
  return h | 0;
}

// ---------- API: initial position generation ----------

// Seeded Khet initial board — mirrors game.py `init(seed)`.
function initRandom(seed) {
  const rng = mulberry32(seed >>> 0);
  const randInt = (n) => (rng() >>> 0) % n;

  const s = newState();
  const sc = randInt(10);
  const sphDIdx = (9 - sc) > sc ? 1 : 3;
  s.b[sc] = mkPiece(T_SPHINX, 1, sphDIdx);
  s.b[90 + (9 - sc)] = mkPiece(T_SPHINX, 2, (sphDIdx + 2) & 3);
  s.sph1 = sc;
  s.sph2 = 90 + (9 - sc);

  const pcChoices = [];
  for (let i = 0; i < 10; i++) {
    if (i !== 0 && i !== 9 && i !== sc && i !== (9 - sc)) pcChoices.push(i);
  }
  const pc = pcChoices[randInt(pcChoices.length)];
  s.b[20 + pc] = mkPiece(T_PHARAOH, 1, 2);
  s.b[70 + (9 - pc)] = mkPiece(T_PHARAOH, 2, 2);

  s.b[40 + pc] = mkPiece(T_ANUBIS, 1, 2);
  s.b[50 + (9 - pc)] = mkPiece(T_ANUBIS, 2, 0);
  s.b[20 + (9 - sc)] = mkPiece(T_ANUBIS, 1, 2);
  s.b[70 + sc] = mkPiece(T_ANUBIS, 2, 0);

  const sccChoices = [];
  for (let c = 0; c < 10; c++) {
    if (s.b[30 + c] === 0 && s.b[60 + (9 - c)] === 0) sccChoices.push(c);
  }
  const scc = sccChoices[randInt(sccChoices.length)];
  const scarabDIdx = randInt(4);
  s.b[30 + scc] = mkPiece(T_SCARAB, 1, scarabDIdx);
  s.b[60 + (9 - scc)] = mkPiece(T_SCARAB, 2, (scarabDIdx + 2) & 3);
  return s;
}

// ---------- API: translation to/from JS tournament spec ----------

// JS Cell n: line = (n//10 + 1) from BOTTOM, col = (n%10 + 1).
// Internal row 0 is the TOP. Mapping:
//   internal_row = 9 - (cell // 10),  internal_col = cell % 10
//   cell         = (9 - row) * 10 + col

function cellToInternal(cell) {
  const row = 9 - ((cell / 10) | 0);
  const col = cell - ((cell / 10) | 0) * 10;
  return row * 10 + col;
}

function internalToJsCell(internalCell) {
  const row = (internalCell / 10) | 0;
  const col = internalCell - row * 10;
  return (9 - row) * 10 + col;
}

// Pyramid orientation (JS corner-cell encoding): 0/9/90/99 → dIdx 0/1/2/3
// 0  = bottom-left  → internal d = 0°   (dIdx 0)
// 9  = bottom-right → internal d = 90°  (dIdx 1)
// 90 = top-left     → internal d = 270° (dIdx 3)
// 99 = top-right    → internal d = 180° (dIdx 2)
function orientToDIdx(orient) {
  if (orient === 0)  return 0;
  if (orient === 9)  return 1;
  if (orient === 90) return 3;
  return 2; // 99
}
const DIDX_TO_ORIENT = [0, 9, 99, 90];

// Scarab orientation: 0 → d=90° (dIdx 1),  9 → d=0° (dIdx 0)
function scarabOrientToDIdx(orient) { return orient === 0 ? 1 : 0; }
function scarabDIdxToOrient(dIdx)   { return (dIdx & 1) === 1 ? 0 : 9; }

function stateFromInitialPositions(ip) {
  const s = newState();

  // Player 1 sphinx
  const sphInternal = cellToInternal(ip.sphinx);
  const sphR = (sphInternal / 10) | 0;
  const sc   = sphInternal - sphR * 10;
  const sphDIdx = (9 - sc) > sc ? 1 : 3;
  s.b[sphInternal] = mkPiece(T_SPHINX, 1, sphDIdx);
  s.sph1 = sphInternal;

  // Player 1 pharaoh
  const phInternal = cellToInternal(ip.pharaoh);
  const phR = (phInternal / 10) | 0;
  const pc  = phInternal - phR * 10;
  s.b[phInternal] = mkPiece(T_PHARAOH, 1, 2);

  // Player 1 anubis
  s.b[40 + pc]         = mkPiece(T_ANUBIS, 1, 2);
  s.b[20 + (9 - sc)]   = mkPiece(T_ANUBIS, 1, 2);

  // Player 1 scarab
  const scInternal = cellToInternal(ip.scarab.position);
  const scR = (scInternal / 10) | 0;
  const scC = scInternal - scR * 10;
  const scarabDIdx = scarabOrientToDIdx(ip.scarab.orientation);
  s.b[scInternal] = mkPiece(T_SCARAB, 1, scarabDIdx);

  // Player 2 — point-symmetric mirror
  const mirSph = (9 - sphR) * 10 + (9 - sc);
  s.b[mirSph] = mkPiece(T_SPHINX, 2, (sphDIdx + 2) & 3);
  s.sph2 = mirSph;
  s.b[(9 - phR) * 10 + (9 - pc)] = mkPiece(T_PHARAOH, 2, 2);
  s.b[50 + (9 - pc)]             = mkPiece(T_ANUBIS, 2, 0);
  s.b[70 + sc]                   = mkPiece(T_ANUBIS, 2, 0);
  s.b[(9 - scR) * 10 + (9 - scC)] = mkPiece(T_SCARAB, 2, (scarabDIdx + 2) & 3);

  s.r1 = 7; s.r2 = 7;
  s.turn = 1; s.ply = 0; s.win = 0;
  return s;
}

function makeInitialPositions(s) {
  const b = s.b;
  let sphinxCell = -1, pharaohCell = -1, scarabCell = -1, scarabDIdx = -1;
  for (let i = 0; i < 100; i++) {
    const p = b[i];
    if (p === 0) continue;
    if (((p >> 2) & 3) !== 1) continue;
    const t = p >> 4;
    if      (t === T_SPHINX)  sphinxCell  = i;
    else if (t === T_PHARAOH) pharaohCell = i;
    else if (t === T_SCARAB)  { scarabCell = i; scarabDIdx = p & 3; }
  }
  return {
    sphinx:  internalToJsCell(sphinxCell),
    pharaoh: internalToJsCell(pharaohCell),
    scarab: {
      position:    internalToJsCell(scarabCell),
      orientation: scarabDIdxToOrient(scarabDIdx),
    },
  };
}

function actionToInternal(action, s) {
  const act = action.action;
  if (act === 'ROTATE') {
    const cell = cellToInternal(action.cell);
    const r = (cell / 10) | 0, c = cell - r * 10;
    const dd = action.result === 'CLOCKWISE' ? 1 : 0;
    return (A_R << 28) | (r << 24) | (c << 20) | (dd << 19);
  }
  if (act === 'MOVE') {
    const cell = cellToInternal(action.cell);
    const ncell = cellToInternal(action.result);
    const r = (cell / 10) | 0, c = cell - r * 10;
    const nr = (ncell / 10) | 0, nc = ncell - nr * 10;
    return (A_M << 28) | (r << 24) | (c << 20) | (nr << 16) | (nc << 12);
  }
  if (act === 'PLACE') {
    const dest = cellToInternal(action.result.destination);
    const r = (dest / 10) | 0, c = dest - r * 10;
    const d = orientToDIdx(action.result.orientation);
    return (A_P << 28) | (r << 24) | (c << 20) | (d << 18);
  }
  if (act === 'EXCHANGE') {
    const tcell = cellToInternal(action.result);
    const targetByte = s.b[tcell];
    const tgt = (targetByte >> 4) === T_SPHINX ? 0 : 1;
    return (A_S << 28) | tgt;
  }
  throw new Error('Unknown action: ' + act);
}

function internalToAction(move, sBefore, player) {
  const code = (move >>> 28) & 0xF;
  if (code === A_R) {
    const r = (move >>> 24) & 0xF;
    const c = (move >>> 20) & 0xF;
    const dd = (move >>> 19) & 1;
    return {
      action: 'ROTATE',
      cell: internalToJsCell(r * 10 + c),
      result: dd === 1 ? 'CLOCKWISE' : 'ANTICLOCKWISE',
    };
  }
  if (code === A_M) {
    const r = (move >>> 24) & 0xF;
    const c = (move >>> 20) & 0xF;
    const nr = (move >>> 16) & 0xF;
    const nc = (move >>> 12) & 0xF;
    return {
      action: 'MOVE',
      cell: internalToJsCell(r * 10 + c),
      result: internalToJsCell(nr * 10 + nc),
    };
  }
  if (code === A_P) {
    const r = (move >>> 24) & 0xF;
    const c = (move >>> 20) & 0xF;
    const d = (move >>> 18) & 3;
    return {
      action: 'PLACE',
      cell: player === 1 ? -1 : -2,
      result: {
        destination: internalToJsCell(r * 10 + c),
        orientation: DIDX_TO_ORIENT[d],
      },
    };
  }
  if (code === A_S) {
    const tgt = move & 1;
    const targetT = tgt === 0 ? T_SPHINX : T_PHARAOH;
    let scCell = -1, tgCell = -1;
    const b = sBefore.b;
    for (let i = 0; i < 100; i++) {
      const p = b[i];
      if (p === 0) continue;
      if (((p >> 2) & 3) !== player) continue;
      const t = p >> 4;
      if      (t === T_SCARAB) scCell = i;
      else if (t === targetT)  tgCell = i;
    }
    return {
      action: 'EXCHANGE',
      cell: internalToJsCell(scCell),
      result: internalToJsCell(tgCell),
    };
  }
  throw new Error('Unknown move code: ' + code);
}

return {
  T_PHARAOH, T_SPHINX, T_SCARAB, T_ANUBIS, T_PYRAMID,
  A_R, A_M, A_P, A_S,
  DR, DC,
  VALS, PYRAMID_RETURN_DELAY, SWAP_COOLDOWN, TURN_LIMIT,
  MAX_DEPTH, moveBufs, scratchBufs,
  mkPiece, newState, terminal, doMove, orderedMoves, evalf, laser,
  zobristIdxHash, zobristVerifyHash,
  Z_PIECE, ZV_PIECE, Z_TURN, ZV_TURN, Z_RES, ZV_RES,
  Z_CD, ZV_CD, Z_PLY, ZV_PLY, Z_PQ, ZV_PQ,
  initRandom,
  stateFromInitialPositions, makeInitialPositions,
  actionToInternal, internalToAction,
};
})();

// ----- gameV19.js -----
__m["./gameV19.js"] = (function() {
// v19 mutable state helpers — doMoveInPlace / undoMove with incremental
// Zobrist maintenance. Outcome-identical to v18's doMove + zobristIdxHash +
// zobristVerifyHash, but avoids per-node Uint8Array.slice and full-board
// hash sweeps.

const {
  T_PHARAOH, T_SPHINX, T_SCARAB, T_PYRAMID,
  A_R, A_M, A_P, A_S,
  VALS, PYRAMID_RETURN_DELAY, SWAP_COOLDOWN, TURN_LIMIT,
  laser,
  Z_PIECE, ZV_PIECE, Z_TURN, ZV_TURN, Z_RES, ZV_RES,
  Z_CD, ZV_CD, Z_PLY, ZV_PLY, Z_PQ, ZV_PQ,
} = __m["./game.js"];

const MAX_UNDO = 64;
const _laserHits = new Int32Array(32);

// One undo record per search ply. Preallocated, zero per-node alloc.
function makeUndoRec() {
  return {
    mutCount: 0,
    mutCells: new Int32Array(16),
    mutPrev:  new Int32Array(16),
    prevTurn: 0, prevPly: 0, prevWin: 0,
    prevR1: 0, prevR2: 0,
    prevSph1: 0, prevSph2: 0,
    prevCd1s: 0, prevCd1p: 0, prevCd2s: 0, prevCd2p: 0,
    prevIdxH: 0, prevVerH: 0,
    prevPqWasNull: true,
    prevPqLen: 0,
    prevPqBuf: new Int32Array(32),
  };
}

const UNDO_STACK = new Array(MAX_UNDO);
for (let i = 0; i < MAX_UNDO; i++) UNDO_STACK[i] = makeUndoRec();

// Compute raw Zobrist idx hash matching zobristIdxHash (no fixup).
function initIdxH(s) {
  let h = 0;
  const b = s.b;
  for (let i = 0; i < 100; i++) {
    const p = b[i];
    if (p !== 0) h ^= Z_PIECE[(i << 8) | p];
  }
  h ^= Z_TURN[s.turn];
  h ^= Z_RES[s.r1];
  h ^= Z_RES[16 + s.r2];
  h ^= Z_CD[s.cd1s];
  h ^= Z_CD[8 + s.cd1p];
  h ^= Z_CD[16 + s.cd2s];
  h ^= Z_CD[24 + s.cd2p];
  h ^= Z_PLY[s.ply & 127];
  if (s.pq !== null) {
    const pq = s.pq;
    for (let i = 0; i < pq.length; i += 2) {
      h ^= Z_PQ[(pq[i] << 1) | (pq[i + 1] - 1)];
    }
  }
  return h | 0;
}

// Compute raw Zobrist verify hash. Unlike zobristVerifyHash, this does NOT
// apply the `|| 1` fixup — that is done at TT access sites in aiV19 so that
// incremental xor updates remain a consistent raw value.
function initVerH(s) {
  let h = 1;
  const b = s.b;
  for (let i = 0; i < 100; i++) {
    const p = b[i];
    if (p !== 0) h ^= ZV_PIECE[(i << 8) | p];
  }
  h ^= ZV_TURN[s.turn];
  h ^= ZV_RES[s.r1];
  h ^= ZV_RES[16 + s.r2];
  h ^= ZV_CD[s.cd1s];
  h ^= ZV_CD[8 + s.cd1p];
  h ^= ZV_CD[16 + s.cd2s];
  h ^= ZV_CD[24 + s.cd2p];
  h ^= ZV_PLY[s.ply & 127];
  if (s.pq !== null) {
    const pq = s.pq;
    for (let i = 0; i < pq.length; i += 2) {
      h ^= ZV_PQ[(pq[i] << 1) | (pq[i + 1] - 1)];
    }
  }
  return h | 0;
}

// Initialise incremental hashes on a fresh state. Idempotent if called
// multiple times (always recomputes from scratch).
function zobristInit(s) {
  s.idxH = initIdxH(s);
  s.verH = initVerH(s);
}

// In-place doMove. Mutates s and returns an undo record from the stack.
// `slot` is the stack index to use (typically the caller's ply counter).
function doMoveInPlace(s, move, slot) {
  const rec = UNDO_STACK[slot];
  rec.prevTurn = s.turn;
  rec.prevPly  = s.ply;
  rec.prevWin  = s.win;
  rec.prevR1   = s.r1;
  rec.prevR2   = s.r2;
  rec.prevSph1 = s.sph1;
  rec.prevSph2 = s.sph2;
  rec.prevCd1s = s.cd1s;
  rec.prevCd1p = s.cd1p;
  rec.prevCd2s = s.cd2s;
  rec.prevCd2p = s.cd2p;
  rec.prevIdxH = s.idxH;
  rec.prevVerH = s.verH;

  if (s.pq === null) {
    rec.prevPqWasNull = true;
    rec.prevPqLen = 0;
  } else {
    rec.prevPqWasNull = false;
    const pq = s.pq;
    const L = pq.length;
    rec.prevPqLen = L;
    for (let i = 0; i < L; i++) rec.prevPqBuf[i] = pq[i];
  }

  let nMut = 0;
  const mutCells = rec.mutCells;
  const mutPrev  = rec.mutPrev;
  let idxH = s.idxH;
  let verH = s.verH;

  const actingPlayer = s.turn;
  s.turn = 3 - actingPlayer;
  s.ply  = s.ply + 1;
  s.win  = 0;

  const code = (move >>> 28) & 0xF;
  let fireLaser = true;
  const b = s.b;

  if (code === A_R) {
    const r = (move >>> 24) & 0xF;
    const c = (move >>> 20) & 0xF;
    const dd = (move >>> 19) & 1;
    const cell = r * 10 + c;
    const p = b[cell];
    mutCells[nMut] = cell;
    mutPrev[nMut]  = p;
    nMut++;
    const newDir = (((p & 3) + (dd === 1 ? 1 : 3)) & 3);
    const newP = (p & 0xFC) | newDir;
    b[cell] = newP;
    const ki0 = (cell << 8) | p;
    const ki1 = (cell << 8) | newP;
    idxH ^= Z_PIECE[ki0]  ^ Z_PIECE[ki1];
    verH ^= ZV_PIECE[ki0] ^ ZV_PIECE[ki1];
  } else if (code === A_M) {
    const r  = (move >>> 24) & 0xF;
    const c  = (move >>> 20) & 0xF;
    const nr = (move >>> 16) & 0xF;
    const nc = (move >>> 12) & 0xF;
    const from = r  * 10 + c;
    const to   = nr * 10 + nc;
    const pFrom = b[from];
    mutCells[nMut] = from; mutPrev[nMut] = pFrom; nMut++;
    mutCells[nMut] = to;   mutPrev[nMut] = 0;     nMut++;
    b[to] = pFrom;
    b[from] = 0;
    const kf = (from << 8) | pFrom;
    const kt = (to   << 8) | pFrom;
    idxH ^= Z_PIECE[kf]  ^ Z_PIECE[kt];
    verH ^= ZV_PIECE[kf] ^ ZV_PIECE[kt];
    if ((pFrom >> 4) === T_SPHINX) {
      if (actingPlayer === 1) s.sph1 = to;
      else                    s.sph2 = to;
    }
  } else if (code === A_P) {
    const r = (move >>> 24) & 0xF;
    const c = (move >>> 20) & 0xF;
    const d = (move >>> 18) & 3;
    const cell = r * 10 + c;
    mutCells[nMut] = cell; mutPrev[nMut] = 0; nMut++;
    const newP = (T_PYRAMID << 4) | (actingPlayer << 2) | d;
    b[cell] = newP;
    if (actingPlayer === 1) s.r1--; else s.r2--;
    const kn = (cell << 8) | newP;
    idxH ^= Z_PIECE[kn];
    verH ^= ZV_PIECE[kn];
  } else {
    // A_S: exchange
    const tgt = move & 1;
    const targetT = tgt === 0 ? T_SPHINX : T_PHARAOH;
    let scCell = -1, tgCell = -1;
    for (let i = 0; i < 100; i++) {
      const bp = b[i];
      if (bp === 0) continue;
      if (((bp >> 2) & 3) !== actingPlayer) continue;
      const t = bp >> 4;
      if      (t === T_SCARAB) scCell = i;
      else if (t === targetT)  tgCell = i;
      if (scCell >= 0 && tgCell >= 0) break;
    }
    if (scCell >= 0 && tgCell >= 0) {
      const sp = b[scCell];
      const tp = b[tgCell];
      mutCells[nMut] = scCell; mutPrev[nMut] = sp; nMut++;
      mutCells[nMut] = tgCell; mutPrev[nMut] = tp; nMut++;
      b[scCell] = tp;
      b[tgCell] = sp;
      const ksp1 = (scCell << 8) | sp;
      const ksp2 = (scCell << 8) | tp;
      const ktp1 = (tgCell << 8) | tp;
      const ktp2 = (tgCell << 8) | sp;
      idxH ^= Z_PIECE[ksp1]  ^ Z_PIECE[ksp2]  ^ Z_PIECE[ktp1]  ^ Z_PIECE[ktp2];
      verH ^= ZV_PIECE[ksp1] ^ ZV_PIECE[ksp2] ^ ZV_PIECE[ktp1] ^ ZV_PIECE[ktp2];
      if (tgt === 0) {
        if (actingPlayer === 1) { s.sph1 = scCell; s.cd1s = SWAP_COOLDOWN; }
        else                    { s.sph2 = scCell; s.cd2s = SWAP_COOLDOWN; }
        fireLaser = false;
      } else {
        if (actingPlayer === 1) s.cd1p = SWAP_COOLDOWN;
        else                    s.cd2p = SWAP_COOLDOWN;
      }
    }
  }

  // Fire laser — commits hash and mut list first so `laser` sees a consistent
  // board. (laser only reads b / sph*; we can flush idxH/verH later.)
  if (fireLaser) {
    const n = laser(s, actingPlayer, _laserHits);
    let loserMask = 0;
    for (let i = 0; i < n; i++) {
      const cell = _laserHits[i * 2];
      const hp   = _laserHits[i * 2 + 1];
      const cur = b[cell];
      if ((cur & 0xFC) !== (hp & 0xFC)) continue;
      const ht = hp >> 4;
      const ho = (hp >> 2) & 3;
      mutCells[nMut] = cell; mutPrev[nMut] = cur; nMut++;
      b[cell] = 0;
      const kk = (cell << 8) | cur;
      idxH ^= Z_PIECE[kk];
      verH ^= ZV_PIECE[kk];
      if (ht === T_PHARAOH) {
        loserMask |= (1 << (ho - 1));
      } else if (ht === T_PYRAMID) {
        if (s.pq === null) s.pq = [];
        s.pq.push(s.ply + PYRAMID_RETURN_DELAY, ho);
      }
    }
    if (loserMask !== 0) {
      if      (loserMask === 3) s.win = -1;
      else if (loserMask === 1) s.win = 2;
      else                      s.win = 1;
    }
  }

  rec.mutCount = nMut;

  // Cooldown decrements
  if (s.cd1s > 0) s.cd1s--;
  if (s.cd1p > 0) s.cd1p--;
  if (s.cd2s > 0) s.cd2s--;
  if (s.cd2p > 0) s.cd2p--;

  // Pyramid return queue
  if (s.pq !== null && s.pq.length > 0) {
    const pq = s.pq;
    let write = 0;
    const L = pq.length;
    for (let i = 0; i < L; i += 2) {
      const rp = pq[i];
      const owner = pq[i + 1];
      if (rp <= s.ply) {
        if (owner === 1) s.r2++;
        else             s.r1++;
      } else {
        pq[write++] = rp;
        pq[write++] = owner;
      }
    }
    pq.length = write;
    if (write === 0) s.pq = null;
  }

  // Turn-limit material tiebreak
  if (s.ply >= TURN_LIMIT && s.win === 0) {
    let m1 = 0, m2 = 0;
    for (let i = 0; i < 100; i++) {
      const bp = b[i];
      if (bp === 0) continue;
      const v = VALS[bp >> 4];
      if (((bp >> 2) & 3) === 1) m1 += v;
      else                        m2 += v;
    }
    if      (m1 > m2) s.win = 1;
    else if (m2 > m1) s.win = 2;
    else              s.win = -1;
  }

  // Fix up scalar hash contributions (xor out old, xor in new).
  idxH ^= Z_TURN[rec.prevTurn]       ^ Z_TURN[s.turn];
  idxH ^= Z_RES[rec.prevR1]          ^ Z_RES[s.r1];
  idxH ^= Z_RES[16 + rec.prevR2]     ^ Z_RES[16 + s.r2];
  idxH ^= Z_CD[rec.prevCd1s]         ^ Z_CD[s.cd1s];
  idxH ^= Z_CD[8 + rec.prevCd1p]     ^ Z_CD[8 + s.cd1p];
  idxH ^= Z_CD[16 + rec.prevCd2s]    ^ Z_CD[16 + s.cd2s];
  idxH ^= Z_CD[24 + rec.prevCd2p]    ^ Z_CD[24 + s.cd2p];
  idxH ^= Z_PLY[rec.prevPly & 127]   ^ Z_PLY[s.ply & 127];

  verH ^= ZV_TURN[rec.prevTurn]       ^ ZV_TURN[s.turn];
  verH ^= ZV_RES[rec.prevR1]          ^ ZV_RES[s.r1];
  verH ^= ZV_RES[16 + rec.prevR2]     ^ ZV_RES[16 + s.r2];
  verH ^= ZV_CD[rec.prevCd1s]         ^ ZV_CD[s.cd1s];
  verH ^= ZV_CD[8 + rec.prevCd1p]     ^ ZV_CD[8 + s.cd1p];
  verH ^= ZV_CD[16 + rec.prevCd2s]    ^ ZV_CD[16 + s.cd2s];
  verH ^= ZV_CD[24 + rec.prevCd2p]    ^ ZV_CD[24 + s.cd2p];
  verH ^= ZV_PLY[rec.prevPly & 127]   ^ ZV_PLY[s.ply & 127];

  // PQ hash contributions: xor out all old entries, xor in all new entries.
  if (!rec.prevPqWasNull) {
    const pbuf = rec.prevPqBuf;
    const L = rec.prevPqLen;
    for (let i = 0; i < L; i += 2) {
      const k = (pbuf[i] << 1) | (pbuf[i + 1] - 1);
      idxH ^= Z_PQ[k];
      verH ^= ZV_PQ[k];
    }
  }
  if (s.pq !== null) {
    const pq = s.pq;
    const L = pq.length;
    for (let i = 0; i < L; i += 2) {
      const k = (pq[i] << 1) | (pq[i + 1] - 1);
      idxH ^= Z_PQ[k];
      verH ^= ZV_PQ[k];
    }
  }

  s.idxH = idxH | 0;
  s.verH = verH | 0;
  return rec;
}

function undoMove(s, rec) {
  const b = s.b;
  const mutCells = rec.mutCells;
  const mutPrev  = rec.mutPrev;
  for (let i = rec.mutCount - 1; i >= 0; i--) {
    b[mutCells[i]] = mutPrev[i];
  }
  s.turn = rec.prevTurn;
  s.ply  = rec.prevPly;
  s.win  = rec.prevWin;
  s.r1   = rec.prevR1;
  s.r2   = rec.prevR2;
  s.sph1 = rec.prevSph1;
  s.sph2 = rec.prevSph2;
  s.cd1s = rec.prevCd1s;
  s.cd1p = rec.prevCd1p;
  s.cd2s = rec.prevCd2s;
  s.cd2p = rec.prevCd2p;
  s.idxH = rec.prevIdxH;
  s.verH = rec.prevVerH;
  if (rec.prevPqWasNull) {
    s.pq = null;
  } else {
    if (s.pq === null) s.pq = [];
    const pq = s.pq;
    pq.length = rec.prevPqLen;
    const pbuf = rec.prevPqBuf;
    for (let i = 0; i < rec.prevPqLen; i++) pq[i] = pbuf[i];
  }
}

return {
  doMoveInPlace, undoMove, zobristInit, initIdxH, initVerH, MAX_UNDO,
};
})();

// ----- moveOrdering.js -----
__m["./moveOrdering.js"] = (function() {
// Move ordering for Khet v18 — ported from move_ordering.py and
// ai_ab_v18.py _interleave_root.
//
// Three public entry points:
//   scoreMoves        — root scoring (full empirical prior)
//   interleaveRoot    — v18 root-only sphinx/place interleave
//   stagedInteriorMoves — interior-node staged ordering

const {
  T_PHARAOH, T_PYRAMID, T_SPHINX, T_SCARAB, T_ANUBIS,
  A_R, A_M, A_P, A_S,
  moveBufs, scratchBufs,
} = __m["./game.js"];

// --- Empirical priors (from move_ordering.py PRIOR_*) ---

const K_PYR_PLACE = 0;
const K_PYR_MOVE  = 1;
const K_PYR_ROT   = 2;
const K_SPH_ROT   = 3;
const K_SCR_MOVE  = 4;
const K_SCR_SWAP  = 5;
const K_SCR_ROT   = 6;
const K_ANB_MOVE  = 7;
const K_ANB_ROT   = 8;
const NUM_KEYS    = 9;

function makePrior(entries) {
  const a = new Float32Array(NUM_KEYS);
  for (const [k, v] of entries) a[k] = v;
  return a;
}
const PRIOR_1 = makePrior([
  [K_PYR_PLACE, 1000], [K_PYR_MOVE, 120],
  [K_SPH_ROT,     80], [K_PYR_ROT,   35],
  [K_SCR_MOVE,    20], [K_SCR_SWAP,  12],
  [K_ANB_MOVE,     5], [K_SCR_ROT,    2],
  [K_ANB_ROT,      0],
]);
const PRIOR_2 = makePrior([
  [K_PYR_PLACE, 1000], [K_SPH_ROT, 430],
  [K_SCR_SWAP,   170], [K_PYR_MOVE, 75],
  [K_PYR_ROT,     45], [K_SCR_MOVE, 40],
  [K_ANB_MOVE,    18], [K_SCR_ROT,   8],
  [K_ANB_ROT,      0],
]);
const PRIOR_3 = makePrior([
  [K_PYR_PLACE, 1000], [K_PYR_MOVE, 110],
  [K_SCR_SWAP,    95], [K_SPH_ROT,   90],
  [K_SCR_MOVE,    50], [K_PYR_ROT,   40],
  [K_ANB_MOVE,    22], [K_ANB_ROT,    4],
  [K_SCR_ROT,      0],
]);
const PRIOR_4P = makePrior([
  [K_PYR_PLACE, 260], [K_PYR_MOVE, 220],
  [K_SPH_ROT,   150], [K_PYR_ROT,   90],
  [K_SCR_MOVE,   85], [K_SCR_SWAP,  60],
  [K_ANB_MOVE,   40], [K_ANB_ROT,   15],
  [K_SCR_ROT,    10],
]);

const PRIOR_SCALE = 2.5;
const TT_BONUS = 2000000;

// Classify a move into its K_* key, given the state (for piece types).
function classifyKey(s, m) {
  const code = (m >>> 28) & 0xF;
  if (code === A_P) return K_PYR_PLACE;
  if (code === A_S) return K_SCR_SWAP;
  const r = (m >>> 24) & 0xF;
  const c = (m >>> 20) & 0xF;
  const pt = s.b[r * 10 + c] >> 4;
  if (code === A_R) {
    if (pt === T_PYRAMID) return K_PYR_ROT;
    if (pt === T_SPHINX)  return K_SPH_ROT;
    if (pt === T_SCARAB)  return K_SCR_ROT;
    return K_ANB_ROT;
  }
  // A_M
  if (pt === T_PYRAMID) return K_PYR_MOVE;
  if (pt === T_SCARAB)  return K_SCR_MOVE;
  return K_ANB_MOVE;
}

function phaseWeight(s) {
  const b = s.b;
  let nonRoyal = 0;
  for (let i = 0; i < 100; i++) {
    const p = b[i];
    if (p === 0) continue;
    const t = p >> 4;
    if (t !== T_SPHINX && t !== T_PHARAOH) nonRoyal++;
  }
  const totalReserve = s.r1 + s.r2;
  return (nonRoyal <= 12 || totalReserve <= 5) ? 1.0 : 0.35;
}

function empiricalPrior(s, m, ownTurnsLeft) {
  const key = classifyKey(s, m);
  const pl = s.turn;
  const reserve = pl === 1 ? s.r1 : s.r2;

  let table;
  if      (ownTurnsLeft <= 1) table = PRIOR_1;
  else if (ownTurnsLeft === 2) table = PRIOR_2;
  else if (ownTurnsLeft === 3) table = PRIOR_3;
  else                         table = PRIOR_4P;

  let base = table[key];

  if (key === K_PYR_PLACE) {
    if (reserve === 0) return 0;
    if (ownTurnsLeft <= 3) base *= 1.20;
  }
  if (reserve === 0) {
    if      (key === K_PYR_MOVE) base *= 1.25;
    else if (key === K_SPH_ROT)  base *= 1.15;
    else if (key === K_SCR_MOVE) base *= 1.15;
    else if (key === K_SCR_SWAP) base *= 1.10;
  }
  // Sphinx swap penalty: a[0]=='s' and a[1]=='sphinx'  (target code 0 = sphinx)
  if (((m >>> 28) & 0xF) === A_S && (m & 1) === 0) {
    base *= 0.75;
    if (ownTurnsLeft === 1) base *= 0.50;
  }
  return base * PRIOR_SCALE;
}

// --- Root scoring ---

// Reorders moveBufs[bufDepth][0..len] by empirical prior descending.
// ttMove (or 0 for none) receives TT_BONUS.
// Uses Int32 decorated-sort: pack (-score*1024 + origIdx) and sort ascending.
const _decScore = new Int32Array(500);
const _decTmp   = new Int32Array(500);

function scoreMoves(s, bufDepth, len, ttMove, depth) {
  const buf = moveBufs[bufDepth];
  const ownTurnsLeft = (depth + 1) >> 1;
  const pw = phaseWeight(s);
  for (let i = 0; i < len; i++) {
    const m = buf[i];
    let sc = pw * empiricalPrior(s, m, ownTurnsLeft);
    if (ttMove !== 0 && m === ttMove) sc += TT_BONUS;
    // Pack (-sc as int) in high 16, origIdx in low 16
    // Clamp sc to ~32767 after scaling so it fits
    let scInt = (sc > 2000000) ? 32767 : ((sc * 0.01) | 0);
    if (scInt > 32767) scInt = 32767;
    if (scInt < -32767) scInt = -32767;
    _decScore[i] = ((-scInt) << 16) | i;
  }
  const sub = _decScore.subarray(0, len);
  sub.sort();
  for (let i = 0; i < len; i++) {
    const origIdx = _decScore[i] & 0xFFFF;
    _decTmp[i] = buf[origIdx];
  }
  for (let i = 0; i < len; i++) buf[i] = _decTmp[i];
}

// --- v18 root interleave ---

const _iSphRot   = new Int32Array(8);
const _iPyrPlace = new Int32Array(400);
const _iScrSwap  = new Int32Array(4);
const _iPyrMove  = new Int32Array(16);
const _iOtherNp  = new Int32Array(128);

function interleaveRoot(s, bufDepth, len, ttMove) {
  const buf = moveBufs[bufDepth];
  const out = scratchBufs[bufDepth];
  let n = 0;
  let ttIdx = -1;

  // Phase 0: TT move (if present and in buf)
  if (ttMove !== 0) {
    for (let i = 0; i < len; i++) {
      if (buf[i] === ttMove) { out[n++] = ttMove; ttIdx = i; break; }
    }
  }

  let nSR = 0, nPP = 0, nSS = 0, nPM = 0, nON = 0;
  for (let i = 0; i < len; i++) {
    if (i === ttIdx) continue;
    const m = buf[i];
    const code = (m >>> 28) & 0xF;
    if (code === A_P) { _iPyrPlace[nPP++] = m; continue; }
    if (code === A_S) { _iScrSwap[nSS++]  = m; continue; }
    const r = (m >>> 24) & 0xF;
    const c = (m >>> 20) & 0xF;
    const pt = s.b[r * 10 + c] >> 4;
    if (code === A_R) {
      if (pt === T_SPHINX) _iSphRot[nSR++] = m;
      else                 _iOtherNp[nON++] = m;
    } else {
      if (pt === T_PYRAMID) _iPyrMove[nPM++] = m;
      else                  _iOtherNp[nON++] = m;
    }
  }

  const SR = nSR < 2 ? nSR : 2;
  const PP = nPP < 2 ? nPP : 2;
  const maxI = SR > PP ? SR : PP;
  for (let i = 0; i < maxI; i++) {
    if (i < SR) out[n++] = _iSphRot[i];
    if (i < PP) out[n++] = _iPyrPlace[i];
  }
  for (let i = 0; i < nSS; i++) out[n++] = _iScrSwap[i];
  for (let i = 0; i < nPM; i++) out[n++] = _iPyrMove[i];
  for (let i = 0; i < nON; i++) out[n++] = _iOtherNp[i];
  for (let i = SR; i < nSR; i++) out[n++] = _iSphRot[i];
  for (let i = PP; i < nPP; i++) out[n++] = _iPyrPlace[i];

  // Write back into buf
  for (let i = 0; i < n; i++) buf[i] = out[i];
  return n;
}

// --- Staged interior move ordering ---

// Non-placement class indices (mirror Python _PYR_MOV etc.)
const _PYR_MOV = 0;
const _PYR_ROT = 1;
const _SPH_ROT = 2;
const _SCR_MOV = 3;
const _SCR_ROT = 4;
const _SCR_SWP = 5;
const _ANB_MOV = 6;
const _ANB_ROT = 7;
const _NUM_CLS = 8;

const _ORD_1  = [_PYR_MOV, _SPH_ROT, _SCR_SWP, _SCR_MOV, _PYR_ROT, _ANB_MOV, _ANB_ROT, _SCR_ROT];
const _ORD_2  = [_SPH_ROT, _SCR_SWP, _PYR_MOV, _SCR_MOV, _PYR_ROT, _ANB_MOV, _ANB_ROT, _SCR_ROT];
const _ORD_3P = [_PYR_MOV, _SCR_MOV, _SCR_SWP, _SPH_ROT, _PYR_ROT, _ANB_MOV, _ANB_ROT, _SCR_ROT];

const QUOTA_1 = 6, QUOTA_2 = 4, QUOTA_DEFAULT = 2;

const _clsBuf = new Array(_NUM_CLS);
for (let i = 0; i < _NUM_CLS; i++) _clsBuf[i] = new Int32Array(64);
const _clsLen = new Int32Array(_NUM_CLS);
const _placeBuf = new Int32Array(400);
const _placeKey = new Int32Array(400);
const _placeTmp = new Int32Array(400);

// Classify non-placement, non-swap moves into class buckets.
function classifyNonPlace(m, pt) {
  const code = (m >>> 28) & 0xF;
  if (code === A_R) {
    if (pt === T_PYRAMID) return _PYR_ROT;
    if (pt === T_SPHINX)  return _SPH_ROT;
    if (pt === T_SCARAB)  return _SCR_ROT;
    return _ANB_ROT;
  }
  // A_M
  if (pt === T_PYRAMID) return _PYR_MOV;
  if (pt === T_SCARAB)  return _SCR_MOV;
  return _ANB_MOV;
}

// Insertion-sort a class bucket by history score descending.
function historySortBucket(buf, len, history) {
  if (len < 2) return;
  for (let i = 1; i < len; i++) {
    const m = buf[i];
    const h = history.get(m) | 0;
    let j = i - 1;
    while (j >= 0) {
      const pm = buf[j];
      const ph = history.get(pm) | 0;
      if (ph >= h) break;
      buf[j + 1] = pm;
      j--;
    }
    buf[j + 1] = m;
  }
}

// Rank placements in-place by cheap static heuristic (mirrors Python
// _rank_placements_inplace). oppPhCell is opponent pharaoh cell or -1.
function rankPlacements(buf, len, s, pl, oppPhCell) {
  let opr, opc;
  if (oppPhCell >= 0) {
    opr = (oppPhCell / 10) | 0;
    opc = oppPhCell - opr * 10;
  } else { opr = 5; opc = 5; }
  const sph = pl === 1 ? s.sph1 : s.sph2;
  let spr, spc;
  if (sph >= 0) { spr = (sph / 10) | 0; spc = sph - spr * 10; }
  else          { spr = -1; spc = -1; }
  const fwdD = pl === 1 ? 2 : 0;
  const oppHalf = pl === 1;

  for (let i = 0; i < len; i++) {
    const m = buf[i];
    const r = (m >>> 24) & 0xF;
    const c = (m >>> 20) & 0xF;
    const d = (m >>> 18) & 3;
    let dr = r - opr; if (dr < 0) dr = -dr;
    let dc = c - opc; if (dc < 0) dc = -dc;
    const dist = dr + dc;
    let sc = dist < 18 ? (18 - dist) * 3 : 0;
    if ((oppHalf && r >= 5) || (!oppHalf && r <= 4)) sc += 10;
    if (r === spr || c === spc) sc += 8;
    if      (d === fwdD) sc += 5;
    else if (d === 1 || d === 3) sc += 2;
    _placeKey[i] = ((-sc) << 16) | i;
  }
  const sub = _placeKey.subarray(0, len);
  sub.sort();
  for (let i = 0; i < len; i++) {
    const origIdx = _placeKey[i] & 0xFFFF;
    _placeTmp[i] = buf[origIdx];
  }
  for (let i = 0; i < len; i++) buf[i] = _placeTmp[i];
}

// stagedInteriorMoves: reorder movesIn[0..inLen] into scratchBufs[bufDepth].
// Returns new length written into scratchBufs[bufDepth].
//
// killer0/killer1 are packed move ints (0 for none). history is a Map.
function stagedInteriorMoves(
  s, bufDepth, inLen, depth,
  ttMove, killer0, killer1, history, oppPhCell,
) {
  const inBuf  = moveBufs[bufDepth];
  const outBuf = scratchBufs[bufDepth];
  const otl = (depth + 1) >> 1;
  const pl = s.turn;

  // Reset buckets
  for (let i = 0; i < _NUM_CLS; i++) _clsLen[i] = 0;
  let placeLen = 0;

  // Partition
  for (let i = 0; i < inLen; i++) {
    const m = inBuf[i];
    const code = (m >>> 28) & 0xF;
    if (code === A_P) { _placeBuf[placeLen++] = m; continue; }
    if (code === A_S) {
      const ci = _SCR_SWP;
      _clsBuf[ci][_clsLen[ci]++] = m;
      continue;
    }
    const r = (m >>> 24) & 0xF;
    const c = (m >>> 20) & 0xF;
    const pt = s.b[r * 10 + c] >> 4;
    const ci = classifyNonPlace(m, pt);
    _clsBuf[ci][_clsLen[ci]++] = m;
  }

  let nOut = 0;
  const skip0 = ttMove, skip1 = killer0, skip2 = killer1;

  // Phase 0: TT move (if legal — present in partition).
  if (ttMove !== 0) {
    let legal = false;
    const code = (ttMove >>> 28) & 0xF;
    if (code === A_P) {
      for (let i = 0; i < placeLen; i++) if (_placeBuf[i] === ttMove) { legal = true; break; }
    } else if (code === A_S) {
      const buf = _clsBuf[_SCR_SWP];
      const len = _clsLen[_SCR_SWP];
      for (let i = 0; i < len; i++) if (buf[i] === ttMove) { legal = true; break; }
    } else {
      const r = (ttMove >>> 24) & 0xF;
      const c = (ttMove >>> 20) & 0xF;
      const pc = s.b[r * 10 + c];
      if (pc !== 0) {
        const ci = classifyNonPlace(ttMove, pc >> 4);
        const buf = _clsBuf[ci];
        const len = _clsLen[ci];
        for (let i = 0; i < len; i++) if (buf[i] === ttMove) { legal = true; break; }
      }
    }
    if (legal) outBuf[nOut++] = ttMove;
  }

  // Phase 1: killers (non-placement, not skipped).
  for (let ki = 0; ki < 2; ki++) {
    const k = ki === 0 ? killer0 : killer1;
    if (k === 0) continue;
    if (k === skip0) continue;
    const code = (k >>> 28) & 0xF;
    if (code === A_P) continue;
    if (ki === 1 && k === killer0) continue;
    let legal = false;
    if (code === A_S) {
      const buf = _clsBuf[_SCR_SWP];
      const len = _clsLen[_SCR_SWP];
      for (let i = 0; i < len; i++) if (buf[i] === k) { legal = true; break; }
    } else {
      const r = (k >>> 24) & 0xF;
      const c = (k >>> 20) & 0xF;
      const pc = s.b[r * 10 + c];
      if (pc !== 0 && ((pc >> 2) & 3) === pl) {
        const ci = classifyNonPlace(k, pc >> 4);
        const buf = _clsBuf[ci];
        const len = _clsLen[ci];
        for (let i = 0; i < len; i++) if (buf[i] === k) { legal = true; break; }
      }
    }
    if (legal) outBuf[nOut++] = k;
  }

  // Phase 2: non-placement classes in priority order.
  const order = otl <= 1 ? _ORD_1 : (otl === 2 ? _ORD_2 : _ORD_3P);
  for (let oi = 0; oi < 8; oi++) {
    const ci = order[oi];
    const len = _clsLen[ci];
    if (len === 0) continue;
    const buf = _clsBuf[ci];
    if (history.size > 0 && len > 1) historySortBucket(buf, len, history);
    for (let i = 0; i < len; i++) {
      const m = buf[i];
      if (m === skip0 || m === skip1 || m === skip2) continue;
      outBuf[nOut++] = m;
    }
  }

  // Phase 3 + 5: placements (top-K, then rest).
  if (placeLen > 0) {
    rankPlacements(_placeBuf, placeLen, s, pl, oppPhCell);
    const K = otl === 1 ? QUOTA_1 : (otl === 2 ? QUOTA_2 : QUOTA_DEFAULT);
    let added = 0;
    let cutoff = placeLen;
    for (let i = 0; i < placeLen; i++) {
      const m = _placeBuf[i];
      if (m === skip0 || m === skip1 || m === skip2) continue;
      outBuf[nOut++] = m;
      added++;
      if (added >= K) { cutoff = i + 1; break; }
    }
    for (let i = cutoff; i < placeLen; i++) {
      const m = _placeBuf[i];
      if (m === skip0 || m === skip1 || m === skip2) continue;
      outBuf[nOut++] = m;
    }
  }

  return nOut;
}

return { scoreMoves, interleaveRoot, stagedInteriorMoves };
})();

// ----- moveOrderingV19.js -----
__m["./moveOrderingV19.js"] = (function() {
// v19 move ordering — bit-identical emitted-move prefix to v18, but
// eliminates the full placement sort that dominated v18's profile (~27%
// of wall).
//
// Key observations:
//   * v18 sorts *every* placement even though only the first MOVE_CAP=24
//     entries are ever searched.
//   * v18's emitted sequence up to slot 24 is: tt + killers + non-place
//     sorted by class+history + placements in score order. So v19 only
//     needs the top (MOVE_CAP - nOut) placements in sorted order to match
//     v18's searched-moves prefix exactly.
//   * A fused scoreAndTopK pass (running-threshold insertion into a size-K
//     buffer) replaces score + sort. For N≈300, K≈12..24 that's ~300+
//     scans and a handful of insertions — vs v18's TypedArray.sort which
//     pays ~N log N plus heavy native-dispatch overhead per call.
//   * historySortBucket also reads each move's history score exactly once
//     into a parallel Int32Array instead of calling history.get twice per
//     insertion-sort comparison.
//
// scoreMoves and interleaveRoot are re-exported from v18 unchanged (they
// run only at the root and are not hot).

const {
  T_PHARAOH, T_PYRAMID, T_SPHINX, T_SCARAB,
  A_R, A_P, A_S,
  moveBufs, scratchBufs,
} = __m["./game.js"];

const { scoreMoves, interleaveRoot } = __m["./moveOrdering.js"];

// --- Staged interior move ordering (v19 copy) ---

const _PYR_MOV = 0;
const _PYR_ROT = 1;
const _SPH_ROT = 2;
const _SCR_MOV = 3;
const _SCR_ROT = 4;
const _SCR_SWP = 5;
const _ANB_MOV = 6;
const _ANB_ROT = 7;
const _NUM_CLS = 8;

const _ORD_1  = [_PYR_MOV, _SPH_ROT, _SCR_SWP, _SCR_MOV, _PYR_ROT, _ANB_MOV, _ANB_ROT, _SCR_ROT];
const _ORD_2  = [_SPH_ROT, _SCR_SWP, _PYR_MOV, _SCR_MOV, _PYR_ROT, _ANB_MOV, _ANB_ROT, _SCR_ROT];
const _ORD_3P = [_PYR_MOV, _SCR_MOV, _SCR_SWP, _SPH_ROT, _PYR_ROT, _ANB_MOV, _ANB_ROT, _SCR_ROT];

// Matches aiV18's MOVE_CAP — the caller never searches past this many
// moves per node, so v19 only needs the top (MOVE_CAP - nonPlaceEmitted)
// placements in sorted order. Rest is dead work.
const MOVE_CAP_LOCAL = 24;

const _clsBuf = new Array(_NUM_CLS);
for (let i = 0; i < _NUM_CLS; i++) _clsBuf[i] = new Int32Array(64);
const _clsLen = new Int32Array(_NUM_CLS);
const _placeBuf = new Int32Array(400);
const _histTmp  = new Int32Array(64);

function classifyNonPlace(m, pt) {
  const code = (m >>> 28) & 0xF;
  if (code === A_R) {
    if (pt === T_PYRAMID) return _PYR_ROT;
    if (pt === T_SPHINX)  return _SPH_ROT;
    if (pt === T_SCARAB)  return _SCR_ROT;
    return _ANB_ROT;
  }
  if (pt === T_PYRAMID) return _PYR_MOV;
  if (pt === T_SCARAB)  return _SCR_MOV;
  return _ANB_MOV;
}

// Insertion sort bucket by history score descending (stable).
// Precomputes history values once per bucket so Map.get is O(n), not O(n^2).
function historySortBucket(buf, len, history) {
  if (len < 2) return;
  const ht = _histTmp;
  for (let i = 0; i < len; i++) ht[i] = history.get(buf[i]) | 0;
  for (let i = 1; i < len; i++) {
    const m = buf[i];
    const h = ht[i];
    let j = i - 1;
    while (j >= 0 && ht[j] < h) {
      buf[j + 1] = buf[j];
      ht[j + 1]  = ht[j];
      j--;
    }
    buf[j + 1] = m;
    ht[j + 1]  = h;
  }
}

// Score every placement and select the top-K smallest keys (largest
// scores) into `_topKKeys[0..returnValue]` in ascending-key order.
// Fused one-pass algorithm: O(N) scoring + expected O(N + K * ln(N/K))
// running-threshold top-K insertion. For N=300, K=6 that's ~330 ops per
// call vs ~1800 for O(N*K) partial sort.
//
// Does NOT modify buf. The caller reads the selected placements via
// `_placeBuf[_topKKeys[i] & 0xFFFF]`.
function scoreAndTopK(buf, len, k, s, pl, oppPhCell) {
  let opr, opc;
  if (oppPhCell >= 0) {
    opr = (oppPhCell / 10) | 0;
    opc = oppPhCell - opr * 10;
  } else { opr = 5; opc = 5; }
  const sph = pl === 1 ? s.sph1 : s.sph2;
  let spr, spc;
  if (sph >= 0) { spr = (sph / 10) | 0; spc = sph - spr * 10; }
  else          { spr = -1; spc = -1; }
  const fwdD = pl === 1 ? 2 : 0;
  const oppHalf = pl === 1;

  const out = _topKKeys;
  const kmax = k < len ? k : len;
  let kk = 0;

  for (let i = 0; i < len; i++) {
    const m = buf[i];
    const r = (m >>> 24) & 0xF;
    const c = (m >>> 20) & 0xF;
    const d = (m >>> 18) & 3;
    let dr = r - opr; if (dr < 0) dr = -dr;
    let dc = c - opc; if (dc < 0) dc = -dc;
    const dist = dr + dc;
    let sc = dist < 18 ? (18 - dist) * 3 : 0;
    if ((oppHalf && r >= 5) || (!oppHalf && r <= 4)) sc += 10;
    if (r === spr || c === spc) sc += 8;
    if      (d === fwdD) sc += 5;
    else if (d === 1 || d === 3) sc += 2;
    const key = ((-sc) << 16) | i;

    if (kk < kmax) {
      let j = kk;
      while (j > 0 && out[j - 1] > key) {
        out[j] = out[j - 1];
        j--;
      }
      out[j] = key;
      kk++;
    } else if (key < out[kk - 1]) {
      let j = kk - 1;
      while (j > 0 && out[j - 1] > key) {
        out[j] = out[j - 1];
        j--;
      }
      out[j] = key;
    }
  }
  return kk;
}

const _topKKeys = new Int32Array(MOVE_CAP_LOCAL + 4);

function stagedInteriorMovesV19(
  s, bufDepth, inLen, depth,
  ttMove, killer0, killer1, history, oppPhCell,
) {
  const inBuf  = moveBufs[bufDepth];
  const outBuf = scratchBufs[bufDepth];
  const otl = (depth + 1) >> 1;
  const pl = s.turn;

  for (let i = 0; i < _NUM_CLS; i++) _clsLen[i] = 0;
  let placeLen = 0;

  for (let i = 0; i < inLen; i++) {
    const m = inBuf[i];
    const code = (m >>> 28) & 0xF;
    if (code === A_P) { _placeBuf[placeLen++] = m; continue; }
    if (code === A_S) {
      const ci = _SCR_SWP;
      _clsBuf[ci][_clsLen[ci]++] = m;
      continue;
    }
    const r = (m >>> 24) & 0xF;
    const c = (m >>> 20) & 0xF;
    const pt = s.b[r * 10 + c] >> 4;
    const ci = classifyNonPlace(m, pt);
    _clsBuf[ci][_clsLen[ci]++] = m;
  }

  let nOut = 0;
  const skip0 = ttMove, skip1 = killer0, skip2 = killer1;

  if (ttMove !== 0) {
    let legal = false;
    const code = (ttMove >>> 28) & 0xF;
    if (code === A_P) {
      for (let i = 0; i < placeLen; i++) if (_placeBuf[i] === ttMove) { legal = true; break; }
    } else if (code === A_S) {
      const buf = _clsBuf[_SCR_SWP];
      const len = _clsLen[_SCR_SWP];
      for (let i = 0; i < len; i++) if (buf[i] === ttMove) { legal = true; break; }
    } else {
      const r = (ttMove >>> 24) & 0xF;
      const c = (ttMove >>> 20) & 0xF;
      const pc = s.b[r * 10 + c];
      if (pc !== 0) {
        const ci = classifyNonPlace(ttMove, pc >> 4);
        const buf = _clsBuf[ci];
        const len = _clsLen[ci];
        for (let i = 0; i < len; i++) if (buf[i] === ttMove) { legal = true; break; }
      }
    }
    if (legal) outBuf[nOut++] = ttMove;
  }

  for (let ki = 0; ki < 2; ki++) {
    const k = ki === 0 ? killer0 : killer1;
    if (k === 0) continue;
    if (k === skip0) continue;
    const code = (k >>> 28) & 0xF;
    if (code === A_P) continue;
    if (ki === 1 && k === killer0) continue;
    let legal = false;
    if (code === A_S) {
      const buf = _clsBuf[_SCR_SWP];
      const len = _clsLen[_SCR_SWP];
      for (let i = 0; i < len; i++) if (buf[i] === k) { legal = true; break; }
    } else {
      const r = (k >>> 24) & 0xF;
      const c = (k >>> 20) & 0xF;
      const pc = s.b[r * 10 + c];
      if (pc !== 0 && ((pc >> 2) & 3) === pl) {
        const ci = classifyNonPlace(k, pc >> 4);
        const buf = _clsBuf[ci];
        const len = _clsLen[ci];
        for (let i = 0; i < len; i++) if (buf[i] === k) { legal = true; break; }
      }
    }
    if (legal) outBuf[nOut++] = k;
  }

  const order = otl <= 1 ? _ORD_1 : (otl === 2 ? _ORD_2 : _ORD_3P);
  for (let oi = 0; oi < 8; oi++) {
    const ci = order[oi];
    const len = _clsLen[ci];
    if (len === 0) continue;
    const buf = _clsBuf[ci];
    if (history.size > 0 && len > 1) historySortBucket(buf, len, history);
    for (let i = 0; i < len; i++) {
      const m = buf[i];
      if (m === skip0 || m === skip1 || m === skip2) continue;
      outBuf[nOut++] = m;
    }
  }

  if (placeLen > 0) {
    // v18 emits ALL placements in sorted order (Phase 3 + Phase 5 with the
    // K cut-point is purely cosmetic — the concatenation is one sorted
    // list). The caller only searches the first MOVE_CAP moves, so we
    // need the top-MOVE_CAP placements in sorted order. We always pick
    // MOVE_CAP worth (not MOVE_CAP - nOut) so that if nOut shrinks under
    // us due to skip filtering we still match v18's first MOVE_CAP slots.
    const kk = scoreAndTopK(_placeBuf, placeLen, MOVE_CAP_LOCAL, s, pl, oppPhCell);
    for (let i = 0; i < kk; i++) {
      const origIdx = _topKKeys[i] & 0xFFFF;
      const m = _placeBuf[origIdx];
      if (m === skip0 || m === skip1 || m === skip2) continue;
      outBuf[nOut++] = m;
    }
  }

  return nOut;
}

return { scoreMoves, interleaveRoot, stagedInteriorMovesV19 };
})();

// ----- aiV19.js -----
__m["./aiV19.js"] = (function() {
// v19 Khet search — same alpha-beta negamax as v18, but:
//   * make/unmake search (doMoveInPlace/undoMove) — no per-node clone.
//   * incremental Zobrist via s.idxH / s.verH.
//   * hand-rolled sort on the placement key Int32Array (no native dispatch).
//   * precomputed history in historySortBucket (no O(n^2) Map.get).
//
// These are pure speedups: move order and values are bit-identical to v18
// for the moves that alpha-beta actually explores.

const {
  orderedMoves, evalf,
  moveBufs, scratchBufs,
} = __m["./game.js"];
const {
  scoreMoves, interleaveRoot, stagedInteriorMovesV19,
} = __m["./moveOrderingV19.js"];
const {
  doMoveInPlace, undoMove, zobristInit,
} = __m["./gameV19.js"];
const { performance } = require('perf_hooks');

// --- Transposition table --- (same layout as v18, separate instance)
const TT_BITS = 19;
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;
const ttVerify = new Int32Array(TT_SIZE);
const ttData   = new Int32Array(TT_SIZE * 4);

function ttClear() { ttVerify.fill(0); }

const EXACT = 0;
const LOWER = 1;
const UPPER = 2;

const MOVE_CAP = 24;
const MAX_PLY  = 16;
const INF      = 1000000000;
const MATE_HI  = 90000;

const A_P = 3;

class TimeoutError extends Error {}
const _TIMEOUT = new TimeoutError();

class AB {
  constructor(pl, t = 0.18) {
    this.pl = pl;
    this.t  = t;
    this.deadline   = 0;
    this.nodes      = 0;
    this.totalNodes = 0;
    this.lastDepth  = 0;
    this.killers    = new Int32Array(MAX_PLY * 2);
    this.history    = new Map();
  }

  choose(s) {
    const start = _now();
    this.deadline = start + this.t * 1000 * 0.90;
    this.nodes = 0;
    this.lastDepth = 0;
    this.killers.fill(0);
    this.history.clear();

    // Initialise incremental Zobrist hashes on the state we were handed.
    zobristInit(s);

    const { count: initCount } = orderedMoves(s, 0);
    if (initCount === 0) return 0;

    const rootBuf = moveBufs[0];

    // Immediate-win scan — always undoes so s is restored.
    for (let i = 0; i < initCount; i++) {
      const a = rootBuf[i];
      const rec = doMoveInPlace(s, a, 0);
      const win = s.win;
      undoMove(s, rec);
      if (win === this.pl) {
        this.totalNodes += 1;
        return a;
      }
    }

    // Root TT probe
    const idxH = s.idxH;
    const verH = s.verH || 1;
    const slot = (idxH & TT_MASK) * 4;
    let rootTtMove = 0;
    if (ttVerify[idxH & TT_MASK] === verH) {
      const mv = ttData[slot + 3];
      if (mv !== 0) {
        for (let i = 0; i < initCount; i++) {
          if (rootBuf[i] === mv) { rootTtMove = mv; break; }
        }
      }
    }

    scoreMoves(s, 0, initCount, rootTtMove, 14);
    const count = interleaveRoot(s, 0, initCount, rootTtMove);

    let best = rootBuf[0];
    let bestScore = -INF;

    for (let depth = 1; depth < 14; depth++) {
      if (_now() > this.deadline) break;
      let bv = -INF;
      let bb = 0;
      let alpha = -INF;
      const beta = INF;
      let timedOut = false;
      try {
        for (let i = 0; i < count; i++) {
          const a = rootBuf[i];
          const rec = doMoveInPlace(s, a, 0);
          let v;
          try {
            v = -this._search(s, depth - 1, -beta, -alpha, 1, 1);
          } finally {
            undoMove(s, rec);
          }
          if (v > bv) { bv = v; bb = a; }
          if (v > alpha) alpha = v;
        }
      } catch (e) {
        if (e !== _TIMEOUT) throw e;
        timedOut = true;
      }
      if (timedOut) break;
      if (bb !== 0) {
        best = bb;
        bestScore = bv;
        this.lastDepth = depth;
        for (let i = 0; i < count; i++) {
          if (rootBuf[i] === bb) {
            for (let j = i; j > 0; j--) rootBuf[j] = rootBuf[j - 1];
            rootBuf[0] = bb;
            break;
          }
        }
        // Store in TT (using v18's `|| 1` fixup on verH).
        ttVerify[idxH & TT_MASK] = verH;
        ttData[slot]     = depth;
        ttData[slot + 1] = bv;
        ttData[slot + 2] = EXACT;
        ttData[slot + 3] = bb;
      }
      if (bv >= MATE_HI) break;
    }

    this.totalNodes += this.nodes;
    return best;
  }

  _search(state, depth, alpha, beta, ply, bufDepth) {
    this.nodes++;
    if ((this.nodes & 7) === 0) {
      if (_now() > this.deadline) throw _TIMEOUT;
    }

    if (state.win !== 0 || depth === 0) {
      return evalf(state, state.turn);
    }

    const origAlpha = alpha;
    const idxH = state.idxH;
    const verH = state.verH || 1;
    const slotIdx = idxH & TT_MASK;
    const slot = slotIdx * 4;
    let ttMove = 0;
    if (ttVerify[slotIdx] === verH) {
      const d  = ttData[slot];
      const v  = ttData[slot + 1];
      const fl = ttData[slot + 2];
      const mv = ttData[slot + 3];
      if (d >= depth) {
        if (fl === EXACT) return v;
        if (fl === LOWER && v >= beta)  return v;
        if (fl === UPPER && v <= alpha) return v;
      }
      ttMove = mv;
    }

    const { count: fullLen, oppPh } = orderedMoves(state, bufDepth);
    if (fullLen === 0) return evalf(state, state.turn);

    const k0 = ply < MAX_PLY ? this.killers[ply * 2]     : 0;
    const k1 = ply < MAX_PLY ? this.killers[ply * 2 + 1] : 0;

    const ordered = scratchBufs[bufDepth];
    const nOrdered = stagedInteriorMovesV19(
      state, bufDepth, fullLen, depth,
      ttMove, k0, k1, this.history, oppPh,
    );
    const limit = nOrdered < MOVE_CAP ? nOrdered : MOVE_CAP;

    let bestV = -INF;
    let bestMove = 0;
    for (let i = 0; i < limit; i++) {
      const a = ordered[i];
      const rec = doMoveInPlace(state, a, ply);
      let v;
      try {
        v = -this._search(state, depth - 1, -beta, -alpha, ply + 1, bufDepth + 1);
      } finally {
        undoMove(state, rec);
      }
      if (v > bestV) { bestV = v; bestMove = a; }
      if (bestV > alpha) alpha = bestV;
      if (alpha >= beta) {
        const code = (a >>> 28) & 0xF;
        if (code !== A_P && ply < MAX_PLY) {
          const kSlot = ply * 2;
          if (this.killers[kSlot] !== a) {
            this.killers[kSlot + 1] = this.killers[kSlot];
            this.killers[kSlot]     = a;
          }
        }
        const prev = this.history.get(a) | 0;
        this.history.set(a, prev + depth * depth);
        break;
      }
    }

    let flag;
    if      (bestV <= origAlpha) flag = UPPER;
    else if (bestV >= beta)      flag = LOWER;
    else                         flag = EXACT;

    ttVerify[slotIdx] = verH;
    ttData[slot]     = depth;
    ttData[slot + 1] = bestV;
    ttData[slot + 2] = flag;
    ttData[slot + 3] = bestMove;

    return bestV;
  }
}

function clearTT() { ttClear(); }

const _now = () => performance.now();

return { AB, clearTT };
})();

// ----- agent glue -----

const __game = __m["./game.js"];
const __ai   = __m["./aiV19.js"];

class Agent {
  constructor({ searchTimeMs = 180 } = {}) {
    this._searchTimeMs = searchTimeMs;
    this._state  = null;
    this._player = 0;
    this._ai     = null;
  }
  async setup(initialPositions, isFirstPlayer) {
    this._player = isFirstPlayer ? 1 : 2;
    this._state  = __game.stateFromInitialPositions(initialPositions);
    __ai.clearTT();
    this._ai = new __ai.AB(this._player, this._searchTimeMs / 1000);
    return true;
  }
  async nextMove(opponentAction) {
    if (opponentAction != null) {
      const mInt = __game.actionToInternal(opponentAction, this._state);
      this._state = __game.doMove(this._state, mInt);
    }
    const move = this._ai.choose(this._state);
    const js   = __game.internalToAction(move, this._state, this._player);
    this._state = __game.doMove(this._state, move);
    return js;
  }
}

const __singleton = new Agent();
exports.setup    = (ip, fp) => __singleton.setup(ip, fp);
exports.nextMove = (a)      => __singleton.nextMove(a);
