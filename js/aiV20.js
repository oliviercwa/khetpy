// v20 Khet search — v19 plus pondering during the opponent's turn.
//
// v19 inherited: make/unmake search, incremental Zobrist, hand-rolled
// placement sort, precomputed history bucket. Search hot path and move
// ordering are byte-identical to v19 for the moves alpha-beta explores.
//
// v20 adds: cooperative ponder that runs between nextMove() calls on the
// position after our just-played move (opponent to move). It shares the
// TT with real choose() calls and exposes a resumeHint so the next real
// search can skip iterative-deepening warm-ups already covered by ponder.
// When nextMove() fires to start a real search, ponderStop() flips an
// abort flag that the existing _search deadline check already polls; the
// running slice unwinds via TimeoutError exactly like a normal timeout.

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

// Ponder slice budget. Each cooperative slice runs for this many
// milliseconds before yielding via setImmediate, so the event loop can
// deliver the next nextMove() request promptly. The tournament budget is
// 250ms and the search deadline is usually ~162ms (0.9 * 180ms), leaving
// ample headroom; we just need each slice short enough that an incoming
// real-search request waits at most ~one slice. 15ms is conservative.
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

    // Ponder plumbing. _abort short-circuits the _search deadline check
    // so nextMove() can interrupt an in-flight slice immediately.
    // _ponderGen is bumped on every ponderStart/ponderStop pair so that a
    // stale setImmediate callback left over from a cancelled ponder sees
    // the mismatch at slice entry and bails out silently.
    this._abort       = false;
    this._ponderGen   = 0;
    this._ponderState = null;
    // Cumulative ponder stats (harness reporting only; free of hot-path
    // cost because they're only bumped at slice boundaries and in
    // ponderStart/ponderStop which run outside search).
    this.ponderSlices     = 0;
    this.ponderMaxDepth   = 0;
    this.ponderLastDepth  = 0;
    // Per-session observability fields. Populated by _ponderSlice and
    // buildResumeHint; read by the harness right after nextMove() resolves
    // to explain what ponder accomplished during the idle window.
    this.ponderNodes              = 0;     // nodes this ponder session produced
    this.ponderLastExploredDepth  = 0;     // depth ponder reached for opp's actual move (scenario 2/3)
    this.ponderLastInFlight       = false; // true = scenario 3 (was searching opp's move when aborted)
    this.ponderLastRootIdx        = -1;    // opp move index in ponder's rootMoves (-1 = not found)
    this.ponderLastRootCount      = 0;     // how many root moves ponder enumerated at its root
    this.ponderLastBestGuessDepth = 0;     // ps.bestCompletedD at ponderStop time

    // TT probe/hit counters. Cumulative for the life of this AB instance;
    // the harness diffs them across nextMove calls to get per-turn deltas.
    this.ttProbes       = 0;
    this.ttHits         = 0;
    this.ponderTtProbes = 0;
    this.ponderTtHits   = 0;
  }

  choose(s, resumeHint = null) {
    // Clear the abort flag in case a pending ponder slice was cancelled
    // just before we were called — otherwise the _search deadline check
    // would throw _TIMEOUT on our first node.
    this._abort = false;

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

    // Seed `best` from the ponder hint if it's a valid root move. That
    // way a very-tight deadline (e.g. the first ID iteration times out)
    // still returns a move that ponder already vetted. We deliberately
    // do NOT raise `startDepth` from the hint: with a warm TT, depths
    // 1..(ponder_depth-1) complete almost instantly via TT hits at the
    // grandchild level, and running them keeps lastDepth accurate and
    // gives the root move ordering a chance to settle before the real
    // work at deeper plies.
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
      // Use the stored bestMove as a move-ordering hint only when the entry
      // is reasonably deep and not a fail-low result. UPPER-flagged entries
      // mean every move scored below the origAlpha at search time — in a
      // ponder context this happened under a window tighter than choose()'s
      // fresh [-INF,INF] window, so the "best fail-low" move is an unreliable
      // hint and can degrade alpha-beta pruning for choose().
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

  // -------- Ponder API --------
  //
  // The ponder root is the state after OUR just-played move, so it's the
  // opponent's turn to move. Ponder runs the same iterative deepening
  // search from that root, warming the TT and tracking per-root-move
  // completion progress. When nextMove() arrives with the opponent's
  // actual move, buildResumeHint() consults the per-move progress to
  // tell choose() at what depth to resume.

  ponderStop() {
    // Bumping _ponderGen invalidates any queued setImmediate callback
    // from the old ponder session (stale slices see the mismatch at
    // entry and return). Setting _abort unwinds any currently-running
    // slice via the existing _search timeout check.
    this._ponderGen++;
    this._abort = true;
  }

  ponderStart(s) {
    // Capture a fresh root. Because the Agent layer holds s as its only
    // live reference, we own it for the duration of the ponder session —
    // slices mutate it via doMoveInPlace and restore it via undoMove, so
    // between slices it is always in its original root form.
    zobristInit(s);
    const { count: initCount } = orderedMoves(s, 0);
    if (initCount === 0) {
      // Terminal ponder root — nothing to ponder.
      this._ponderState = null;
      return;
    }

    // TT root probe for a prior ponder/choose entry at this root, so we
    // can bias the move ordering the same way choose() would.
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

    // Copy the ordered root moves into our own Int32Array so that slices
    // remain correct even if something else clobbers moveBufs[0] between
    // slices. (Nothing should — JS is single-threaded and ponder is the
    // only thing running between slices — but this keeps ponder self-
    // contained and is cheap.)
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
      // Per-depth partial-search state restored at the top of each slice
      // so resumption is exact (no lost alpha tightening).
      currentBV:      -INF,
      currentBB:      0,
      currentAlpha:   -INF,
      bestCompleted:  0,
      bestCompletedV: 0,
      bestCompletedD: 0,
    };

    // Fresh killers/history for ponder. The next real choose() clears
    // them again at its own entry, so nothing carries over to real play.
    //
    // NOTE: we deliberately do NOT reset this.nodes here. The harness
    // reads agent.nodes right after nextMove() returns (i.e. after this
    // ponderStart() call), and that value must still reflect the search
    // just completed by choose(). Ponder slices will then add on top
    // until the next choose() resets nodes at its own entry.
    this.killers.fill(0);
    this.history.clear();

    // Reset per-ponder-session stats. ponderNodes is INTENTIONALLY not
    // reset here — it accumulates across the whole game like ponderSlices,
    // and the harness reads per-turn deltas. Resetting here would zero it
    // before the harness's post-nextMove read can see it.
    this.ponderLastDepth = 0;

    this._ponderGen++;
    this._abort = false;

    const myGen = this._ponderGen;
    setImmediate(() => this._ponderSlice(myGen));
  }

  _ponderSlice(myGen) {
    if (myGen !== this._ponderGen) return;           // stale
    if (this._abort) return;                         // stopped
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
      // deadline OR abort — ps was updated in place before the throw.
    }

    // Accumulate per-session ponder nodes. this.nodes is shared with choose()
    // but choose() resets it at entry, and ponderStart() zeroes ponderNodes,
    // so between ponderStart and ponderStop this delta faithfully tracks
    // ponder-only work without touching the _search hot path.
    this.ponderNodes    += this.nodes    - nodesBefore;
    this.ponderTtProbes += this.ttProbes - ttProbesBefore;
    this.ponderTtHits   += this.ttHits   - ttHitsBefore;

    // Track ponder's deepest fully-completed depth for harness reporting.
    // ps.currentDepth is the depth being ATTEMPTED; the last successful
    // one is (ps.currentDepth - 1) once we've advanced past it, or
    // ps.bestCompletedD (which reflects any depth that committed a best
    // move at the root).
    if (ps.bestCompletedD > this.ponderLastDepth) this.ponderLastDepth = ps.bestCompletedD;
    if (ps.bestCompletedD > this.ponderMaxDepth)  this.ponderMaxDepth  = ps.bestCompletedD;

    if (this._abort)          return;                // aborted — leave ps
    if (mate)                 return;                // mate found, done
    if (ps.currentDepth >= 14) return;               // depth cap reached

    setImmediate(() => this._ponderSlice(myGen));
  }

  // Runs iterative deepening on the ponder root, resuming from
  // ps.currentDepth / ps.currentMoveIdx. Returns true iff a mate-value
  // result is reached (at which point the caller should stop slicing).
  // Throws _TIMEOUT on deadline/abort, with ps.currentMoveIdx /
  // currentBV / currentBB / currentAlpha pointing at the last move the
  // loop was working on — so the next slice can pick up exactly there.
  _ponderIdLoop(s, ps) {
    while (ps.currentDepth < 14) {
      const depth = ps.currentDepth;
      const beta = INF;

      // Restore partial state for this depth. On the first entry into a
      // fresh depth these are -INF / -INF / 0 (set at depth advance).
      let alpha = ps.currentAlpha;
      let bv    = ps.currentBV;
      let bb    = ps.currentBB;

      for (let i = ps.currentMoveIdx; i < ps.rootCount; i++) {
        // Persist where we are BEFORE attempting the search so that a
        // _TIMEOUT throw leaves resumable state pointing at this i.
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

        // This move completed cleanly at this depth.
        if (depth > ps.completedDepth[i]) ps.completedDepth[i] = depth;
        if (v > bv) { bv = v; bb = a; }
        if (v > alpha) alpha = v;
      }

      // Full depth complete. Commit the best move at this depth.
      if (bb !== 0) {
        ps.bestCompleted  = bb;
        ps.bestCompletedV = bv;
        ps.bestCompletedD = depth;
        // Store the root TT entry so choose() at the same root picks it
        // up as its rootTtMove.
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

      if (bv >= MATE_HI) return true;                // mate found

      // Advance to next depth. Reset per-depth partial state.
      ps.currentDepth   = depth + 1;
      ps.currentMoveIdx = 0;
      ps.currentMove    = 0;
      ps.currentAlpha   = -INF;
      ps.currentBV      = -INF;
      ps.currentBB      = 0;
    }
    return false;
  }

  // Called by nextMove() to translate ponder progress into a resumeHint
  // for the upcoming choose() call. M is the opponent's actual move as
  // an internal move int. After this method returns (with or without a
  // hint) the ponder state is cleared; anything still running is a
  // stale slice that will no-op on gen mismatch.
  buildResumeHint(M) {
    const ps = this._ponderState;
    if (ps === null) {
      // No ponder session was active (first move of the game, or ponder
      // aborted itself before producing state). Zero the diagnostic fields
      // so the harness sees an unambiguous "nothing happened".
      this.ponderLastExploredDepth  = 0;
      this.ponderLastInFlight       = false;
      this.ponderLastRootIdx        = -1;
      this.ponderLastRootCount      = 0;
      this.ponderLastBestGuessDepth = 0;
      return null;
    }

    // Find M in the ponder root's ordered move list.
    let idx = -1;
    for (let i = 0; i < ps.rootCount; i++) {
      if (ps.rootMoves[i] === M) { idx = i; break; }
    }

    this.ponderLastRootCount      = ps.rootCount;
    this.ponderLastBestGuessDepth = ps.bestCompletedD;

    if (idx === -1) {
      // Opponent played a move we didn't enumerate — should not happen
      // for legal moves, but bail cleanly rather than lie to choose().
      this.ponderLastExploredDepth = 0;
      this.ponderLastInFlight      = false;
      this.ponderLastRootIdx       = -1;
      this._ponderState = null;
      return null;
    }

    this.ponderLastRootIdx       = idx;
    this.ponderLastExploredDepth = ps.completedDepth[idx] | 0;
    this.ponderLastInFlight      = (ps.currentMove === M);

    // We pass ponder's last fully-completed best move and its depth as
    // a safety seed. choose() runs its normal ID from depth 1 regardless
    // — warm-up depths hit the TT at the grandchildren level and are
    // near-free — but if the very first deep iteration times out, at
    // least `best` and `lastDepth` still point at ponder's result.
    const hint = {
      bestGuess:      ps.bestCompleted,
      bestGuessDepth: ps.bestCompletedD,
    };

    // Discard ponder state — stale TT entries for other branches stay in
    // the table and are simply never queried (they're hash-addressed and
    // eventually overwritten under replace-always).
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
