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

const _TYPE_LETTER = ['.', 'H', 'X', 'S', 'A', 'P'];
const _DIR_LETTER  = ['N', 'E', 'S', 'W'];

function boardToString(s) {
  const lines = [];
  lines.push('     0    1    2    3    4    5    6    7    8    9');
  for (let r = 0; r < 10; r++) {
    const cells = [];
    for (let c = 0; c < 10; c++) {
      const p = s.b[r * 10 + c];
      if (p === 0) { cells.push('.   '); continue; }
      const t = p >> 4;
      const o = (p >> 2) & 3;
      const d = p & 3;
      cells.push(`${o}${_TYPE_LETTER[t]}${_DIR_LETTER[d]} `);
    }
    lines.push(`${r}  ${cells.join(' ')}`);
  }
  lines.push(`turn=${s.turn} ply=${s.ply} win=${s.win}`);
  return lines.join('\n');
}

module.exports = {
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
  boardToString,
};
