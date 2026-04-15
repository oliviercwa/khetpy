# khet-v18-js

JavaScript port of the Khet alpha-beta AI (v18) and its game rules, plus a
tournament harness. Matches the JS tournament API — module-level
`setup(initialPositions, isFirstPlayer)` and `nextMove(opponentAction)`.

## Layout

- `game.js`        — board, `doMove`, `orderedMoves`, `laser`, `evalf`,
                     Zobrist hashing, JS tournament API translation
- `moveOrdering.js` — empirical priors, `scoreMoves`, `stagedInteriorMoves`,
                     `interleaveRoot`
- `aiV18.js`       — `AB` search class (ID + negamax + TT)
- `index.js`       — module-level `setup` / `nextMove` API
- `harness.js`     — tournament runner

## Running

```
node harness.js --games 4 --seed 0 --time 0.18
node harness.js -g 10 --verbose
```

Requires Node 18+ (uses ESM, global `performance`).

## Notes

- **No pondering.** v18's ponder thread is intentionally omitted; the JS
  port is single-threaded.
- **No debug logging.** OTL-2 / debug buffers from the Python version are
  stripped.
- **Algorithm is identical** to Python v18: negamax + alpha-beta +
  transposition table + staged interior ordering + root-level
  sphinx-rotate / pyramid-place interleave.
- Default move budget is 0.18 s with a 0.90 margin (162 ms actual),
  matching Python v18.
