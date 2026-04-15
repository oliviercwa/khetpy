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
} = require('./game.js');

const { scoreMoves, interleaveRoot } = require('./moveOrdering.js');

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

module.exports = { scoreMoves, interleaveRoot, stagedInteriorMovesV19 };
