// Build the single-file tournament submission yourTeam.js from the
// multi-file source tree. Takes one flag:
//   --version v18 | v19 | v20       (default: v19)
// The output is CommonJS-compatible and exports `setup` and `nextMove`
// via `exports.setup = ...` / `exports.nextMove = ...` per the spec.

const fs   = require('fs');
const path = require('path');

function parseArgs(argv) {
  const opts = { version: 'v19', out: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if      (a === '--version') opts.version = argv[++i];
    else if (a === '--out')     opts.out     = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node bundle.js [--version v18|v19|v20] [--out yourTeam.js]');
      process.exit(0);
    }
    else { console.error(`unknown flag ${a}`); process.exit(1); }
  }
  if (!opts.out) opts.out = path.join(__dirname, '..', 'yourTeam.js');
  return opts;
}

const DEPS = {
  v18: [
    ['game.js',         './game.js'],
    ['moveOrdering.js', './moveOrdering.js'],
    ['aiV18.js',        './aiV18.js'],
  ],
  v19: [
    ['game.js',            './game.js'],
    ['gameV19.js',         './gameV19.js'],
    ['moveOrdering.js',    './moveOrdering.js'],
    ['moveOrderingV19.js', './moveOrderingV19.js'],
    ['aiV19.js',           './aiV19.js'],
  ],
  v20: [
    ['game.js',            './game.js'],
    ['gameV19.js',         './gameV19.js'],
    ['moveOrdering.js',    './moveOrdering.js'],
    ['moveOrderingV19.js', './moveOrderingV19.js'],
    ['aiV20.js',           './aiV20.js'],
  ],
};

// The AI module key fed to the bundled Agent class.
const AI_KEY = { v18: './aiV18.js', v19: './aiV19.js', v20: './aiV20.js' };

function transformFile(src) {
  // Replace `require('./X.js')` with a fake-module registry lookup, and
  // the trailing `module.exports = { ... };` with `return { ... };`.
  let out = src.replace(
    /require\(['"](\.\/[^'"]+)['"]\)/g,
    (_m, p) => `__m[${JSON.stringify(p)}]`
  );
  out = out.replace(
    /module\.exports\s*=\s*(\{[\s\S]*?\});?\s*$/m,
    (_m, obj) => `return ${obj};`
  );
  return out;
}

function wrapAsModule(key, src) {
  return `__m[${JSON.stringify(key)}] = (function() {\n${src}\n})();\n`;
}

// Agent class emitted at the end of the bundle. Keeps the same shape as
// js/index.js but pinned to a single version so the spec-level exports
// (exports.setup, exports.nextMove) are unambiguous.
function agentBlock(version) {
  const aiKey = JSON.stringify(AI_KEY[version]);
  const gameKey = JSON.stringify('./game.js');
  return `
const __game = __m[${gameKey}];
const __ai   = __m[${aiKey}];

class Agent {
  constructor({ searchTimeMs = 230 } = {}) {
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
`;
}

function main() {
  const opts = parseArgs(process.argv);
  const deps = DEPS[opts.version];
  if (!deps) { console.error(`unknown version ${opts.version}`); process.exit(1); }

  const chunks = [];
  chunks.push(`// yourTeam.js — bundled submission (version ${opts.version})`);
  chunks.push(`// Generated ${new Date().toISOString()}`);
  chunks.push(`// Do not edit by hand. Run: node js/bundle.js --version ${opts.version}`);
  chunks.push('');
  chunks.push("'use strict';");
  chunks.push('const { performance } = require(\'perf_hooks\');');
  chunks.push('const __m = Object.create(null);');
  chunks.push('');

  for (const [fname, key] of deps) {
    const srcPath = path.join(__dirname, fname);
    if (!fs.existsSync(srcPath)) {
      console.error(`missing source: ${srcPath}`);
      process.exit(1);
    }
    const raw = fs.readFileSync(srcPath, 'utf8');
    const transformed = transformFile(raw);
    chunks.push(`// ----- ${fname} -----`);
    chunks.push(wrapAsModule(key, transformed));
  }

  chunks.push('// ----- agent glue -----');
  chunks.push(agentBlock(opts.version));

  fs.writeFileSync(opts.out, chunks.join('\n'));
  console.log(`wrote ${opts.out} (${fs.statSync(opts.out).size} bytes, version ${opts.version})`);
}

main();
