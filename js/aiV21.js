// v21 Khet search — v20 plus a depth-1 terminal-pre-scan.
//
// v20 bug: inside _search(), moves are ordered by stagedInteriorMovesV19
// which appends A_P placements last and truncates to MOVE_CAP. The
// positional scoring of placements (distance to opp pharaoh, sphinx
// alignment) does not reflect laser-redirect tactics, so placements that
// reflect the laser into the opponent's pharaoh get mispruned. The
// mating response is literally invisible to v20's interior search, even
// at high depth.
//
// v21 adds a guarded terminal-pre-scan at depth=1: when the raw move
// list was pruned (fullLen > MOVE_CAP), iterate the raw A_P placements
// and check for a 1-ply mate via doMove/check state.win/undoMove. If
// found, return MATE_HI-ply immediately and cache in the TT. Everything
// else — ponder, iterative deepening, _search hot path, move ordering —
// is byte-identical to v20.

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

// --- Transposition table --- (own instance; DO NOT share with v20 or
// the A/B measurement is contaminated by cross-version TT bleed.)
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

const POND_SLICE_MS = 15;

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

    this._abort       = false;
    this._ponderGen   = 0;
    this._ponderState = null;
    this.ponderSlices     = 0;
    this.ponderMaxDepth   = 0;
    this.ponderLastDepth  = 0;
    this.ponderNodes              = 0;
    this.ponderLastExploredDepth  = 0;
    this.ponderLastInFlight       = false;
    this.ponderLastRootIdx        = -1;
    this.ponderLastRootCount      = 0;
    this.ponderLastBestGuessDepth = 0;

    this.ttProbes       = 0;
    this.ttHits         = 0;
    this.ponderTtProbes = 0;
    this.ponderTtHits   = 0;
  }

  choose(s, resumeHint = null) {
    this._abort = false;

    const start = _now();
    this.deadline = start + this.t * 1000 * 0.90;
    this.nodes = 0;
    this.lastDepth = 0;
    this.killers.fill(0);
    this.history.clear();

    zobristInit(s);

    const { count: initCount } = orderedMoves(s, 0);
    if (initCount === 0) return 0;

    const rootBuf = moveBufs[0];

    // Immediate-win scan at the root.
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
    if (resumeHint !== null && resumeHint.bestGuess !== 0) {
      for (let i = 0; i < count; i++) {
        if (rootBuf[i] === resumeHint.bestGuess) { best = resumeHint.bestGuess; break; }
      }
      if (resumeHint.bestGuessDepth > 0) {
        this.lastDepth = resumeHint.bestGuessDepth;
      }
    }

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
      if (this._abort || _now() > this.deadline) throw _TIMEOUT;
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
      if (d >= depth - 1 && fl !== UPPER) ttMove = mv;
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

    // Depth-1 terminal-pre-scan. Guards a move-ordering hole where
    // laser-redirect placements receive no positional signal and get cut
    // from the top-MOVE_CAP list, hiding 1-ply mates from the search.
    // Gated on fullLen > MOVE_CAP so the scan only runs when pruning
    // actually happened. Only A_P placements are checked — the observed
    // bug class is specifically placements, which dominate the pruned
    // tail. rawBuf is the same Int32Array stagedInteriorMovesV19 just
    // read from; it still holds the full move list from orderedMoves().
    if (depth === 1 && fullLen > MOVE_CAP) {
      const rawBuf = moveBufs[bufDepth];
      const mover  = state.turn;
      for (let i = 0; i < fullLen; i++) {
        const a = rawBuf[i];
        if (((a >>> 28) & 0xF) !== A_P) continue;
        const rec = doMoveInPlace(state, a, ply);
        const win = state.win;
        undoMove(state, rec);
        if (win === mover) {
          const mv = MATE_HI - ply;
          ttVerify[slotIdx] = verH;
          ttData[slot]     = depth;
          ttData[slot + 1] = mv;
          ttData[slot + 2] = EXACT;
          ttData[slot + 3] = a;
          return mv;
        }
      }
    }

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

  ponderStop() {
    this._ponderGen++;
    this._abort = true;
  }

  ponderStart(s) {
    zobristInit(s);
    const { count: initCount } = orderedMoves(s, 0);
    if (initCount === 0) {
      this._ponderState = null;
      return;
    }

    const idxH = s.idxH;
    const verH = s.verH || 1;
    const slotIdx = idxH & TT_MASK;
    const slot = slotIdx * 4;
    let rootTtMove = 0;
    if (ttVerify[slotIdx] === verH) {
      const mv = ttData[slot + 3];
      if (mv !== 0) {
        const rootBuf0 = moveBufs[0];
        for (let i = 0; i < initCount; i++) {
          if (rootBuf0[i] === mv) { rootTtMove = mv; break; }
        }
      }
    }

    scoreMoves(s, 0, initCount, rootTtMove, 14);
    const nOrdered = interleaveRoot(s, 0, initCount, rootTtMove);

    const rootBuf = moveBufs[0];
    const rootMoves = new Int32Array(nOrdered);
    for (let i = 0; i < nOrdered; i++) rootMoves[i] = rootBuf[i];

    this._ponderState = {
      rootState:      s,
      rootHash:       idxH,
      rootMoves:      rootMoves,
      rootCount:      nOrdered,
      completedDepth: new Int8Array(nOrdered),
      currentDepth:   1,
      currentMoveIdx: 0,
      currentMove:    0,
      currentBV:      -INF,
      currentBB:      0,
      currentAlpha:   -INF,
      bestCompleted:  0,
      bestCompletedV: 0,
      bestCompletedD: 0,
    };

    this.killers.fill(0);
    this.history.clear();

    this.ponderLastDepth = 0;

    this._ponderGen++;
    this._abort = false;

    const myGen = this._ponderGen;
    setImmediate(() => this._ponderSlice(myGen));
  }

  _ponderSlice(myGen) {
    if (myGen !== this._ponderGen) return;
    if (this._abort) return;
    const ps = this._ponderState;
    if (ps === null) return;
    if (ps.currentDepth >= 14) return;

    const s = ps.rootState;
    this.deadline = _now() + POND_SLICE_MS;
    this.ponderSlices++;
    const nodesBefore    = this.nodes;
    const ttProbesBefore = this.ttProbes;
    const ttHitsBefore   = this.ttHits;

    let mate = false;
    try {
      mate = this._ponderIdLoop(s, ps);
    } catch (e) {
      if (e !== _TIMEOUT) throw e;
    }

    this.ponderNodes    += this.nodes    - nodesBefore;
    this.ponderTtProbes += this.ttProbes - ttProbesBefore;
    this.ponderTtHits   += this.ttHits   - ttHitsBefore;

    if (ps.bestCompletedD > this.ponderLastDepth) this.ponderLastDepth = ps.bestCompletedD;
    if (ps.bestCompletedD > this.ponderMaxDepth)  this.ponderMaxDepth  = ps.bestCompletedD;

    if (this._abort)          return;
    if (mate)                 return;
    if (ps.currentDepth >= 14) return;

    setImmediate(() => this._ponderSlice(myGen));
  }

  _ponderIdLoop(s, ps) {
    while (ps.currentDepth < 14) {
      const depth = ps.currentDepth;
      const beta = INF;

      let alpha = ps.currentAlpha;
      let bv    = ps.currentBV;
      let bb    = ps.currentBB;

      for (let i = ps.currentMoveIdx; i < ps.rootCount; i++) {
        ps.currentMoveIdx = i;
        ps.currentMove    = ps.rootMoves[i];
        ps.currentAlpha   = alpha;
        ps.currentBV      = bv;
        ps.currentBB      = bb;

        const a = ps.currentMove;
        const rec = doMoveInPlace(s, a, 0);
        let v;
        try {
          v = -this._search(s, depth - 1, -beta, -alpha, 1, 1);
        } finally {
          undoMove(s, rec);
        }

        if (depth > ps.completedDepth[i]) ps.completedDepth[i] = depth;
        if (v > bv) { bv = v; bb = a; }
        if (v > alpha) alpha = v;
      }

      if (bb !== 0) {
        ps.bestCompleted  = bb;
        ps.bestCompletedV = bv;
        ps.bestCompletedD = depth;
        const idxH = s.idxH;
        const verH = s.verH || 1;
        const slotIdx = idxH & TT_MASK;
        const slot = slotIdx * 4;
        ttVerify[slotIdx] = verH;
        ttData[slot]     = depth;
        ttData[slot + 1] = bv;
        ttData[slot + 2] = EXACT;
        ttData[slot + 3] = bb;
      }

      if (bv >= MATE_HI) return true;

      ps.currentDepth   = depth + 1;
      ps.currentMoveIdx = 0;
      ps.currentMove    = 0;
      ps.currentAlpha   = -INF;
      ps.currentBV      = -INF;
      ps.currentBB      = 0;
    }
    return false;
  }

  buildResumeHint(M) {
    const ps = this._ponderState;
    if (ps === null) {
      this.ponderLastExploredDepth  = 0;
      this.ponderLastInFlight       = false;
      this.ponderLastRootIdx        = -1;
      this.ponderLastRootCount      = 0;
      this.ponderLastBestGuessDepth = 0;
      return null;
    }

    let idx = -1;
    for (let i = 0; i < ps.rootCount; i++) {
      if (ps.rootMoves[i] === M) { idx = i; break; }
    }

    this.ponderLastRootCount      = ps.rootCount;
    this.ponderLastBestGuessDepth = ps.bestCompletedD;

    if (idx === -1) {
      this.ponderLastExploredDepth = 0;
      this.ponderLastInFlight      = false;
      this.ponderLastRootIdx       = -1;
      this._ponderState = null;
      return null;
    }

    this.ponderLastRootIdx       = idx;
    this.ponderLastExploredDepth = ps.completedDepth[idx] | 0;
    this.ponderLastInFlight      = (ps.currentMove === M);

    const hint = {
      bestGuess:      ps.bestCompleted,
      bestGuessDepth: ps.bestCompletedD,
    };

    this._ponderState = null;
    return hint;
  }
}

function clearTT() { ttClear(); }

const _now = () => performance.now();

const ttInfo = {
  entries: TT_SIZE,
  bytes:   TT_SIZE * 4 + TT_SIZE * 4 * 4,
};

module.exports = { AB, clearTT, ttInfo, ttFillCount };
