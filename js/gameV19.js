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
} = require('./game.js');

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

module.exports = {
  doMoveInPlace, undoMove, zobristInit, initIdxH, initVerH, MAX_UNDO,
};
