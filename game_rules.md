# Khet 2.0 — Authoritative Rules (as used by this project)

This file records the rule interpretation the code in `game.py` is aligned to.
When code and this file disagree, one of them is wrong — do not silently "fix"
`game.py` without checking here first.

## Board

- 10×10 grid.
- Point-symmetric randomized initial layout.

## Pieces

- **Pharaoh** — must be protected. If hit by a laser, its owner loses.
- **Sphinx** — fires the laser. Cannot be destroyed. Can be rotated/swapped but
  its laser still fires each turn (except the turn it is swapped).
- **Anubis** — shielded on its facing side. A laser hitting the shielded face is
  absorbed (piece survives, beam stops). Hit on any other side destroys it.
- **Pyramid** — mirror on two adjacent faces, reflects the beam. Destroyed if
  hit on a non-mirror face.
- **Scarab** — double-sided mirror, always reflects. Cannot be destroyed by the
  laser. Can **swap** with an adjacent own Sphinx or own Pharaoh.

## Initial placement (per rules)

- **Sphinx**: row 0 / row 9, random column on the first line. Laser is
  **HORIZONTAL**, facing the side with the **most available cells**
  (east if `9 - sc > sc`, else west). P2 mirrors point-symmetrically.
- **Pharaoh**: row 2 / 7, random column — not on column 0, 9, the sphinx
  column, or the opponent-sphinx column.
- **Anubis #1**: row 4 / 5, on the own pharaoh's column, facing the opponent
  (P1 faces south d=180, P2 faces north d=0).
- **Anubis #2**: row 2 / 7, on the **opponent's sphinx column**, facing the
  opponent (P1:180, P2:0).
- **Scarab**: row 3 / 6, any empty column, random orientation.
- **Reserves**: 7 pyramids per player, 0 on the board at start.

**Important**: the rules do not require the opening position to be
non-terminal or blunder-free. If a random legal opening allows a 1-move or
2-move kill, that is allowed by the rules and should NOT be "fixed" by
filtering openings.

## Turn structure

1. Active player takes exactly one action:
   - **Rotate** any own piece except Pharaoh (±90°).
   - **Move** an Anubis/Pyramid/Scarab to an adjacent empty cell.
   - **Place** a pyramid from reserve onto a legal empty cell.
   - **Swap** (Scarab only) with own Sphinx or own Pharaoh if that swap's
     cooldown is 0.
2. Active player's **Sphinx fires its laser** — *except* on a turn where the
   action was a Sphinx swap (that turn's laser is suppressed).
3. Resolve hits: Pharaoh hit → that player loses. Other hits destroy the
   piece. Destroyed pyramids enter the return queue.

## Constants (must match rules)

- `SWAP_COOLDOWN = 4` — each swap target (sphinx/pharaoh) has its own
  independent cooldown of **4 player turns**.
- `PYRAMID_RETURN_DELAY = 2` — a destroyed pyramid appears in the
  **opponent's** reserve after 1 turn, and the new owner cannot place it on
  their very-next turn. Implemented as "reserve increments 2 plies after
  destruction".
- `TURN_LIMIT = 100` — game ends at 100 player turns total; material tiebreak
  decides the winner.

## Laser mechanics

- The laser is **one particle**. It does not re-fire or branch when a piece is
  destroyed mid-beam. When an Anubis is destroyed the beam continues past;
  when a pyramid is destroyed the beam also continues.
- Scarab reflection depends on orientation parity (even d vs odd d × 90).
- Pyramid reflection uses the `PYR` table in `game.py`.
- Anubis shield rule in code: `(q.d - inc) % 360 == 180` where `inc` is the
  direction the beam is travelling minus 180 (i.e. "where it came from"). The
  shield is on the *back* of the piece per this formula — unusual but
  internally consistent. Do not change this without re-deriving it.

## Placement legality

A pyramid can be placed on any empty cell that is **not orthogonally adjacent
to the placing player's own Pharaoh** and **not orthogonally adjacent to any
Sphinx** (either player's).

## What the rules do NOT enforce

- Opening positions are not filtered for blunders or immediate wins.
- The Sphinx cannot be destroyed, so it is never removed from the board.
- There is no restriction on rotating the Sphinx each turn.
