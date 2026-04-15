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
} = require('./game.js');

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

module.exports = { scoreMoves, interleaveRoot, stagedInteriorMoves };
