// Module-level agent API for the JS tournament spec:
//   setup(initialPositions, isFirstPlayer) -> Promise<true>    (<= 1000 ms)
//   nextMove(opponentAction)               -> Promise<Action>  (<= 250 ms)
//
// The submitted yourTeam.js is a bundled form of this file plus one AI
// version's sources. During development this file supports multiple versions
// through the `Agent` class so the tournament harness can pit them against
// each other in one process.

const {
  stateFromInitialPositions,
  doMove,
  actionToInternal,
  internalToAction,
} = require('./game.js');

const v18 = require('./aiV18.js');
const v19 = require('./aiV19.js');
const v20 = require('./aiV20.js');
const v21 = require('./aiV21.js');

const VERSIONS = {
  v18: { AB: v18.AB, clearTT: v18.clearTT, ponder: false, ttInfo: v18.ttInfo, ttFillCount: v18.ttFillCount },
  v19: { AB: v19.AB, clearTT: v19.clearTT, ponder: false, ttInfo: v19.ttInfo, ttFillCount: v19.ttFillCount },
  v20: { AB: v20.AB, clearTT: v20.clearTT, ponder: true,  ttInfo: v20.ttInfo, ttFillCount: v20.ttFillCount },
  v21: { AB: v21.AB, clearTT: v21.clearTT, ponder: true,  ttInfo: v21.ttInfo, ttFillCount: v21.ttFillCount },
};

class Agent {
  constructor({ version = 'v20', searchTimeMs = 230 } = {}) {
    const v = VERSIONS[version];
    if (!v) throw new Error(`unknown AI version ${version}`);
    this._version      = version;
    this._v            = v;
    this._searchTimeMs = searchTimeMs;
    this._state        = null;
    this._player       = 0;
    this._ai           = null;
  }

  async setup(initialPositions, isFirstPlayer) {
    this._player = isFirstPlayer ? 1 : 2;
    this._state  = stateFromInitialPositions(initialPositions);
    this._v.clearTT();
    this._ai = new this._v.AB(this._player, this._searchTimeMs / 1000);
    return true;
  }

  async nextMove(opponentAction) {
    // First thing: stop any ponder slice that may be running or queued
    // so the abort flag is set before choose() enters.
    if (this._v.ponder) this._ai.ponderStop();

    let resumeHint = null;
    if (opponentAction != null) {
      const mInt = actionToInternal(opponentAction, this._state);
      // Build the hint BEFORE mutating _state — the hint references the
      // ponder root, which IS the current _state.
      if (this._v.ponder) resumeHint = this._ai.buildResumeHint(mInt);
      this._state = doMove(this._state, mInt);
    }

    const move = this._v.ponder
      ? this._ai.choose(this._state, resumeHint)
      : this._ai.choose(this._state);
    const js   = internalToAction(move, this._state, this._player);
    this._state = doMove(this._state, move);

    // Kick off ponder from the post-our-move state. setImmediate ensures
    // the first slice only runs after this async function has resolved,
    // i.e. after the arena/harness has received our move.
    if (this._v.ponder) this._ai.ponderStart(this._state);

    return js;
  }

  get lastDepth()       { return this._ai ? this._ai.lastDepth  : 0; }
  get nodes()           { return this._ai ? this._ai.nodes      : 0; }
  get totalNodes()      { return this._ai ? this._ai.totalNodes : 0; }
  get ponderSlices()    { return this._ai && this._ai.ponderSlices    || 0; }
  get ponderMaxDepth()  { return this._ai && this._ai.ponderMaxDepth  || 0; }
  get ponderEnabled()   { return !!this._v.ponder; }
  get ttInfo()          { return this._v.ttInfo; }
  get ttFillCount()     { return this._v.ttFillCount ? this._v.ttFillCount() : 0; }
  get ponderNodes()              { return this._ai && this._ai.ponderNodes              || 0; }
  get ponderLastExploredDepth()  { return this._ai && this._ai.ponderLastExploredDepth  || 0; }
  get ponderLastInFlight()       { return !!(this._ai && this._ai.ponderLastInFlight); }
  get ponderLastRootIdx()        { return this._ai ? this._ai.ponderLastRootIdx         : -1; }
  get ponderLastRootCount()      { return this._ai && this._ai.ponderLastRootCount      || 0; }
  get ponderLastBestGuessDepth() { return this._ai && this._ai.ponderLastBestGuessDepth || 0; }
  get ttProbes()        { return this._ai && this._ai.ttProbes        || 0; }
  get ttHits()          { return this._ai && this._ai.ttHits          || 0; }
  get ponderTtProbes()  { return this._ai && this._ai.ponderTtProbes  || 0; }
  get ponderTtHits()    { return this._ai && this._ai.ponderTtHits    || 0; }
}

const _singleton = new Agent();

exports.Agent    = Agent;
exports.setup    = (ip, fp) => _singleton.setup(ip, fp);
exports.nextMove = (a)      => _singleton.nextMove(a);
exports.getTtFillCount = (version) => {
  const v = VERSIONS[version];
  return v && v.ttFillCount ? v.ttFillCount() : null;
};
