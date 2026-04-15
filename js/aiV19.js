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
} = require('./game.js');
const {
  scoreMoves, interleaveRoot, stagedInteriorMovesV19,
} = require('./moveOrderingV19.js');
const {
  doMoveInPlace, undoMove, zobristInit,
} = require('./gameV19.js');
const { performance } = require('perf_hooks');

// --- Transposition table --- (same layout as v18, separate instance)
const TT_BITS = 19;
const TT_SIZE = 1 << TT_BITS;
const TT_MASK = TT_SIZE - 1;
const ttVerify = new Int32Array(TT_SIZE);
const ttData   = new Int32Array(TT_SIZE * 4);

function ttClear() { ttVerify.fill(0); }

function ttFillCount() {
  let n = 0;
  for (let i = 0; i < TT_SIZE; i++) if (ttVerify[i] !== 0) n++;
  return n;
}

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
    this.ttProbes   = 0;
    this.ttHits     = 0;
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
    this.ttProbes++;
    if (ttVerify[idxH & TT_MASK] === verH) {
      this.ttHits++;
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
    this.ttProbes++;
    if (ttVerify[slotIdx] === verH) {
      this.ttHits++;
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

const ttInfo = {
  entries: TT_SIZE,
  bytes:   TT_SIZE * 4 + TT_SIZE * 4 * 4,
};

module.exports = { AB, clearTT, ttInfo, ttFillCount };
