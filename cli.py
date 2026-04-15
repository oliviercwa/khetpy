import argparse
import os
import sys
import time
import multiprocessing as mp
from collections import Counter
from concurrent.futures import ProcessPoolExecutor, as_completed

import ai_api
from game_v13 import init, do, terminal
from worker import run as worker_run


class WorkerHandle:
    """Controller-side handle to a worker process running one AI."""

    def __init__(self):
        self.parent, child = mp.Pipe()
        self.proc = mp.Process(target=worker_run, args=(child,), daemon=True)
        self.proc.start()

    def enable_otl2(self, worker_id):
        """Enable OTL-2 diagnostic collection in this worker."""
        self.parent.send({'cmd': 'enable_otl2', 'worker_id': worker_id})
        r = self.parent.recv()
        if not r.get('ok'):
            raise RuntimeError(f'enable_otl2 failed: {r}')
        self._otl2_worker_id = worker_id

    def reset(self, name, pl, t, ponder, seed,
              better_eval=True, quiescence=True):
        self.parent.send({
            'cmd': 'reset',
            'name': name, 'pl': pl, 't': t,
            'ponder': ponder, 'seed': seed,
            'better_eval': better_eval,
            'quiescence': quiescence,
        })
        r = self.parent.recv()
        if not r.get('ok'):
            raise RuntimeError(f'worker reset failed: {r}')

    def choose(self, state):
        """Send a state to the worker and wait for its move.

        Returns (move, elapsed_seconds, cumulative_nodes, depth). Elapsed
        time is wall clock at the controller, covering IPC + compute —
        this is the real tournament budget gate. Depth is the max ID
        depth completed for the last choose().
        """
        t0 = time.perf_counter()
        self.parent.send({'cmd': 'choose', 'state': state})
        r = self.parent.recv()
        dt = time.perf_counter() - t0
        if not r.get('ok'):
            raise RuntimeError(f'worker choose failed: {r}')
        tt = {
            'probes': r.get('tt_probes', 0),
            'hits': r.get('tt_hits', 0),
            'cutoffs': r.get('tt_cutoffs', 0),
            'move_used': r.get('tt_move_used', 0),
            'peak': r.get('tt_peak', 0),
            'p_nodes': r.get('ponder_nodes', 0),
            'p_stores': r.get('ponder_stores', 0),
            'p_hit': r.get('ponder_hit_on_stored', 0),
            'p_cut': r.get('ponder_cutoff_on_stored', 0),
        }
        return r['move'], dt, r['total_nodes'], r.get('depth', 0), tt, r.get('otl2_events', [])

    def setup(self, name, initial_positions, is_first_player, t, ponder, seed=0):
        """Send setup command to worker (new functional API)."""
        self.parent.send({
            'cmd': 'setup',
            'name': name,
            'initial_positions': initial_positions,
            'is_first_player': is_first_player,
            't': t,
            'ponder': ponder,
            'seed': seed,
        })
        r = self.parent.recv()
        if not r.get('ok'):
            raise RuntimeError(f'worker setup failed: {r}')

    def next_move(self, opponent_action):
        """Send next_move command; returns (action_dict, elapsed_s, total_nodes, depth, tt, otl2)."""
        t0 = time.perf_counter()
        self.parent.send({'cmd': 'next_move', 'opponent_action': opponent_action})
        r = self.parent.recv()
        dt = time.perf_counter() - t0
        if not r.get('ok'):
            raise RuntimeError(f'worker next_move failed: {r}')
        tt = {
            'probes':   r.get('tt_probes', 0),
            'hits':     r.get('tt_hits', 0),
            'cutoffs':  r.get('tt_cutoffs', 0),
            'move_used': r.get('tt_move_used', 0),
            'peak':     r.get('tt_peak', 0),
            'p_nodes':  r.get('ponder_nodes', 0),
            'p_stores': r.get('ponder_stores', 0),
            'p_hit':    r.get('ponder_hit_on_stored', 0),
            'p_cut':    r.get('ponder_cutoff_on_stored', 0),
        }
        return r['action'], dt, r['total_nodes'], r.get('depth', 0), tt, r.get('otl2_events', [])

    def close(self):
        try:
            self.parent.send({'cmd': 'close'})
            self.parent.recv()
        except Exception:
            pass
        self.proc.join(timeout=2)
        if self.proc.is_alive():
            self.proc.terminate()


_PIECE_SYM = {
    'pharaoh': 'Ph', 'sphinx': 'Sp', 'anubis': 'An',
    'scarab': 'Sc', 'pyramid': 'Py',
}


def _fmt_board(s):
    lines = []
    header = '     ' + ' '.join(f' c{c} ' for c in range(10))
    lines.append(header)
    for r in range(10):
        row = f'r{r}:  '
        for c in range(10):
            p = s.b[r][c]
            if p:
                row += f'{_PIECE_SYM[p.t]}{p.o}{p.d:03d} '
            else:
                row += ' ....  '
        lines.append(row)
    lines.append(
        f'turn=P{s.turn} ply={s.ply} reserves={{1:{s.r[1]}, 2:{s.r[2]}}} '
        f'cd1={s.cd[1]} cd2={s.cd[2]} pq={s.pq} win={s.win}'
    )
    return '\n'.join(lines)


def play(seed, p1_name, p2_name, move_time, w1, w2, ponder=False,
         better_eval=True, quiescence=True, log=None):
    """Play one game using the setup/next_move functional API.

    Both workers are initialised with setup() at the start of each game,
    giving per-game isolation (fresh TT, fresh state). The canonical game
    state is maintained here for validation, logging, and statistics; each
    AI also tracks its own internal copy via next_move().
    """
    s = init(seed)
    if log is not None:
        log.write(f'=== Game seed={seed} {p1_name} vs {p2_name} ===\n')
        log.write('-- init --\n')
        log.write(_fmt_board(s) + '\n')

    initial_positions = ai_api.make_initial_positions(s)
    w1.setup(p1_name, initial_positions, True,  move_time, ponder, seed)
    w2.setup(p2_name, initial_positions, False, move_time, ponder, seed)

    m = 0
    max_t = {1: 0.0, 2: 0.0}
    violations = {1: 0, 2: 0}
    total_nodes = {1: 0, 2: 0}
    depths = {1: [], 2: []}
    times = {1: [], 2: []}
    otl2_events = []

    tt_final = {1: None, 2: None}
    last_action = {1: None, 2: None}   # last JS-style action each player played
    if __debug__:
        _move_hist = []  # [(player, move_type, piece_type), ...]
    while not terminal(s) and m < 200:
        pid    = s.turn
        worker = w1 if pid == 1 else w2
        opp    = 3 - pid
        act_js, dt, tn, depth, tt, otl2 = worker.next_move(last_action[opp])
        otl2_events.extend(otl2)
        if dt > max_t[pid]:
            max_t[pid] = dt
        if dt > move_time:
            violations[pid] += 1
        total_nodes[pid] = tn
        tt_final[pid] = tt
        if depth > 0:
            depths[pid].append(depth)
            times[pid].append(dt)
        if not act_js:
            break
        # Convert JS action → internal tuple for canonical state update & logging.
        act = ai_api.action_to_internal(act_js, s)
        last_action[pid] = act_js
        if __debug__:
            _mt = act[0]
            if _mt in ('r', 'm'):
                _pt = s.b[act[1]][act[2]].t
            elif _mt == 'p':
                _pt = 'pyramid'
            else:
                _pt = 'scarab'
            _move_hist.append((pid, _mt, _pt))
        s = do(s, act)
        m += 1
        if log is not None:
            log.write(f'-- move {m} P{pid} ({p1_name if pid==1 else p2_name}) '
                      f'played {act_js} in {dt*1000:.1f}ms depth={depth} --\n')
            log.write(_fmt_board(s) + '\n')

    def _stats(xs):
        if not xs:
            return (0, 0.0, 0, 0, 0)
        return (min(xs), sum(xs) / len(xs), max(xs), sum(xs), len(xs))

    # Each stat tuple is (min, avg, max, sum, count) where sum/count let
    # callers compute a weighted per-move average across multiple games.
    depth_stats = {1: _stats(depths[1]), 2: _stats(depths[2])}
    time_stats = {1: _stats(times[1]), 2: _stats(times[2])}

    _endgame = None
    if __debug__ and s.win in (1, 2):
        winner_moves = [(mt, pt) for (pl, mt, pt) in _move_hist if pl == s.win]
        _endgame = {}
        for i, lb in enumerate((2, 4, 6)):
            idx = -(i + 1)  # -1, -2, -3
            if abs(idx) <= len(winner_moves):
                _endgame[lb] = winner_moves[idx]

    return (s.win, m, total_nodes[1], total_nodes[2], max_t, violations,
            depth_stats, time_stats, tt_final, _endgame, otl2_events)


def _labels_for(args):
    """Return (label1, label2) — tag self-play with (A)/(B) so the two
    instances remain distinguishable in the aggregates.
    """
    if args.p1 == args.p2:
        return f'{args.p1} (A)', f'{args.p2} (B)'
    return args.p1, args.p2


# Move-count bins for the length-of-win histogram. Order matters: this is
# the display order in the final table. Bins overlap intentionally — ">10"
# counts every win that ran longer than 10 moves, including ones also
# counted in ">20" and ">50".
MOVE_BINS = [
    ('0', lambda m: m == 0),
    ('1', lambda m: m == 1),
    ('2', lambda m: m == 2),
    ('3', lambda m: m == 3),
    ('4', lambda m: m == 4),
    ('5', lambda m: m == 5),
    ('6-10', lambda m: 6 <= m <= 10),
    ('11-20', lambda m: 11 <= m <= 20),
    ('21-50', lambda m: 21 <= m <= 50),
    ('51-100', lambda m: 51 <= m <= 100),
    ('>100', lambda m: m > 100),
]
MOVE_BIN_NAMES = [name for name, _ in MOVE_BINS]


def _empty_agg(label1, label2):
    return {
        'wins': {label1: 0, label2: 0, 'Draw': 0},
        'win_bins': {
            label1: {name: 0 for name in MOVE_BIN_NAMES},
            label2: {name: 0 for name in MOVE_BIN_NAMES},
        },
        'nodes': {label1: 0, label2: 0},
        'max_t': {label1: 0.0, label2: 0.0},
        'viol': {label1: 0, label2: 0},
        'depth_min': {label1: None, label2: None},
        'depth_max': {label1: 0, label2: 0},
        'depth_sum': {label1: 0.0, label2: 0.0},
        'depth_cnt': {label1: 0, label2: 0},
        'time_min': {label1: None, label2: None},
        'time_max': {label1: 0.0, label2: 0.0},
        'time_sum': {label1: 0.0, label2: 0.0},
        'time_cnt': {label1: 0, label2: 0},
        # TT counters: summed across games (each game's final = cumulative
        # over the whole game, since we reset workers per game).
        'tt_probes': {label1: 0, label2: 0},
        'tt_hits': {label1: 0, label2: 0},
        'tt_cutoffs': {label1: 0, label2: 0},
        'tt_move_used': {label1: 0, label2: 0},
        'tt_peak': {label1: 0, label2: 0},
        'p_nodes': {label1: 0, label2: 0},
        'p_stores': {label1: 0, label2: 0},
        'p_hit': {label1: 0, label2: 0},
        'p_cut': {label1: 0, label2: 0},
        'total_moves': 0,
        'games_played': 0,
        'endgame_moves': {
            bname: {2: Counter(), 4: Counter(), 6: Counter()}
            for bname in ['all'] + MOVE_BIN_NAMES
        },
    }


def _merge_agg(into, other, label1, label2):
    for lbl in (label1, label2, 'Draw'):
        into['wins'][lbl] += other['wins'][lbl]
    for lbl in (label1, label2):
        into['nodes'][lbl] += other['nodes'][lbl]
        if other['max_t'][lbl] > into['max_t'][lbl]:
            into['max_t'][lbl] = other['max_t'][lbl]
        into['viol'][lbl] += other['viol'][lbl]
        if other['depth_max'][lbl] > into['depth_max'][lbl]:
            into['depth_max'][lbl] = other['depth_max'][lbl]
        cur_dmin = into['depth_min'][lbl]
        oth_dmin = other['depth_min'][lbl]
        if oth_dmin is not None and (cur_dmin is None or oth_dmin < cur_dmin):
            into['depth_min'][lbl] = oth_dmin
        into['depth_sum'][lbl] += other['depth_sum'][lbl]
        into['depth_cnt'][lbl] += other['depth_cnt'][lbl]
        if other['time_max'][lbl] > into['time_max'][lbl]:
            into['time_max'][lbl] = other['time_max'][lbl]
        cur_tmin = into['time_min'][lbl]
        oth_tmin = other['time_min'][lbl]
        if oth_tmin is not None and (cur_tmin is None or oth_tmin < cur_tmin):
            into['time_min'][lbl] = oth_tmin
        into['time_sum'][lbl] += other['time_sum'][lbl]
        into['time_cnt'][lbl] += other['time_cnt'][lbl]
        for key in ('tt_probes', 'tt_hits', 'tt_cutoffs', 'tt_move_used',
                    'p_nodes', 'p_stores', 'p_hit', 'p_cut'):
            into[key][lbl] += other[key][lbl]
        if other['tt_peak'][lbl] > into['tt_peak'][lbl]:
            into['tt_peak'][lbl] = other['tt_peak'][lbl]
        for name in MOVE_BIN_NAMES:
            into['win_bins'][lbl][name] += other['win_bins'][lbl][name]
    into['total_moves'] += other['total_moves']
    into['games_played'] += other['games_played']
    for bname in into['endgame_moves']:
        for lb in (2, 4, 6):
            into['endgame_moves'][bname][lb] += other['endgame_moves'][bname][lb]
    into.setdefault('otl2_events', []).extend(other.get('otl2_events', []))


def _run_slice(args, worker_idx, log_path, quiet):
    """Run `args.games` games in this process. Returns an aggregate dict.

    `worker_idx` offsets seeds so slices never collide. `quiet=True`
    suppresses per-game progress prints (used in multi-worker runs to
    avoid interleaved stdout from parallel drivers) — the log file still
    captures every move.
    """
    label1, label2 = _labels_for(args)
    agg = _empty_agg(label1, label2)

    v19_better_eval = (args.v19_eval == 'on')
    v19_quiescence = (args.v19_qs == 'on')

    log_fh = open(log_path, 'w', encoding='utf-8') if log_path else None
    w1 = WorkerHandle()
    w2 = WorkerHandle()
    # Enable OTL-2 diagnostic collection in workers (events buffered,
    # returned via choose responses, written to single file by controller).
    if args.debug_otl2:
        w1.enable_otl2(worker_idx)
        w2.enable_otl2(worker_idx)
    base_seed = worker_idx * args.games
    try:
        for i in range(args.games):
            swapped = args.swap and (i % 2 == 1)
            # Pair swapped games by init seed so both AIs face the exact
            # same starting position, one as p1 and one as p2. Offset by
            # base_seed to keep slices non-overlapping across workers.
            game_seed = base_seed + (i // 2 if args.swap else i)
            if swapped:
                seat1_name, seat2_name = args.p2, args.p1
                seat1_label, seat2_label = label2, label1
                ws1, ws2 = w2, w1
            else:
                seat1_name, seat2_name = args.p1, args.p2
                seat1_label, seat2_label = label1, label2
                ws1, ws2 = w1, w2

            if log_fh is not None:
                log_fh.write(f'\n######## Game {i+1}'
                             + (' [swapped]' if swapped else '')
                             + f' ########\n')
            w, m, na, nb, max_t, viol, depth_stats, time_stats, tt_final, endgame_data, otl2 = play(
                game_seed, seat1_name, seat2_name, args.time,
                ws1, ws2, ponder=args.ponder,
                better_eval=v19_better_eval,
                quiescence=v19_quiescence,
                log=log_fh,
            )
            if otl2 and m <= 10:  # only keep short games (3-10 moves)
                game_tag = {'game_seed': game_seed, 'game_idx': i,
                            'winner': w, 'n_moves': m}
                kept = []
                for ev in otl2:
                    nd = ev.get('node', '')
                    # Root events: keep only for 3-4 move games.
                    if nd == 'root':
                        if m <= 4:
                            ev.update(game_tag)
                            kept.append(ev)
                        continue
                    # Interior events: node-level quality filter.
                    bf = ev.get('best_family', '')
                    fp = ev.get('first_placement_rank')
                    cp = ev.get('cutoff_phase', '')
                    if (bf in ('sphinx_rotate', 'pyramid_place',
                               'pyramid_move', 'scarab_swap')
                            or (fp is not None and fp <= 8)
                            or cp != 'before_early'):
                        ev.update(game_tag)
                        kept.append(ev)
                if kept:
                    agg.setdefault('otl2_events', []).extend(kept)
            agg['total_moves'] += m
            agg['games_played'] += 1

            agg['nodes'][seat1_label] += na
            agg['nodes'][seat2_label] += nb
            if max_t[1] > agg['max_t'][seat1_label]:
                agg['max_t'][seat1_label] = max_t[1]
            if max_t[2] > agg['max_t'][seat2_label]:
                agg['max_t'][seat2_label] = max_t[2]
            agg['viol'][seat1_label] += viol[1]
            agg['viol'][seat2_label] += viol[2]

            for seat, lbl in ((1, seat1_label), (2, seat2_label)):
                dmin, _davg, dmax, dsum, dcnt = depth_stats[seat]
                if dcnt == 0:
                    continue
                cur_min = agg['depth_min'][lbl]
                if cur_min is None or dmin < cur_min:
                    agg['depth_min'][lbl] = dmin
                if dmax > agg['depth_max'][lbl]:
                    agg['depth_max'][lbl] = dmax
                agg['depth_sum'][lbl] += dsum
                agg['depth_cnt'][lbl] += dcnt

            for seat, lbl in ((1, seat1_label), (2, seat2_label)):
                tmin, _tavg, tmax, tsum, tcnt = time_stats[seat]
                if tcnt == 0:
                    continue
                cur_tmin = agg['time_min'][lbl]
                if cur_tmin is None or tmin < cur_tmin:
                    agg['time_min'][lbl] = tmin
                if tmax > agg['time_max'][lbl]:
                    agg['time_max'][lbl] = tmax
                agg['time_sum'][lbl] += tsum
                agg['time_cnt'][lbl] += tcnt

            for seat, lbl in ((1, seat1_label), (2, seat2_label)):
                tt = tt_final[seat]
                if not tt:
                    continue
                agg['tt_probes'][lbl] += tt['probes']
                agg['tt_hits'][lbl] += tt['hits']
                agg['tt_cutoffs'][lbl] += tt['cutoffs']
                agg['tt_move_used'][lbl] += tt['move_used']
                if tt['peak'] > agg['tt_peak'][lbl]:
                    agg['tt_peak'][lbl] = tt['peak']
                agg['p_nodes'][lbl] += tt['p_nodes']
                agg['p_stores'][lbl] += tt['p_stores']
                agg['p_hit'][lbl] += tt['p_hit']
                agg['p_cut'][lbl] += tt['p_cut']

            if __debug__ and endgame_data:
                key_bins = ['all']
                for bname, pred in MOVE_BINS:
                    if pred(m):
                        key_bins.append(bname)
                for lb, (mt, pt) in endgame_data.items():
                    k = f'{mt}:{pt}'
                    for bname in key_bins:
                        agg['endgame_moves'][bname][lb][k] += 1

            if w == 1:
                winner_label = seat1_label
            elif w == 2:
                winner_label = seat2_label
            else:
                winner_label = 'Draw'
            agg['wins'][winner_label] += 1
            if winner_label != 'Draw':
                for name, pred in MOVE_BINS:
                    if pred(m):
                        agg['win_bins'][winner_label][name] += 1

            if not quiet:
                tag = ' [swapped]' if swapped else ''
                print(f'Game {i+1}{tag}: {winner_label.upper()} in {m} moves '
                      f'({seat1_label} vs {seat2_label})')
                print(f'  {seat1_label} nodes: {na:,}, '
                      f'{seat2_label} nodes: {nb:,}')
                mark1 = ' !! VIOLATION' if viol[1] > 0 else ''
                mark2 = ' !! VIOLATION' if viol[2] > 0 else ''
                print(f'  max {seat1_label}={max_t[1]*1000:.1f}ms{mark1}  '
                      f'max {seat2_label}={max_t[2]*1000:.1f}ms{mark2}')
                d1 = depth_stats[1]
                d2 = depth_stats[2]
                print(f'  depth {seat1_label}: min={d1[0]} avg={d1[1]:.1f} '
                      f'max={d1[2]}  '
                      f'depth {seat2_label}: min={d2[0]} avg={d2[1]:.1f} '
                      f'max={d2[2]}')
    finally:
        w1.close()
        w2.close()
        if log_fh is not None:
            log_fh.close()

    return agg


def _next_log_base(p1, p2):
    """Return the next free log path prefix, rooted under
    logs/<p1>_vs_<p2>/. The returned string is a path prefix without
    extension — callers append '.log' or '_wK.log'.
    """
    matchup = f'{p1}_vs_{p2}'
    log_dir = os.path.join('logs', matchup)
    os.makedirs(log_dir, exist_ok=True)
    n = 1
    while True:
        candidate = os.path.join(log_dir, f'{matchup}_{n:03d}')
        # Reserve if neither the single-run log nor any per-worker log exists.
        if not os.path.exists(f'{candidate}.log') and not any(
                os.path.exists(f'{candidate}_w{w}.log') for w in range(64)):
            return candidate
        n += 1


_MT_NAMES = {'r': 'rotate', 'm': 'move', 'p': 'place', 's': 'swap'}
_LB_LABELS = {2: 'N-2 (last)', 4: 'N-4', 6: 'N-6'}


def _write_endgame_stats(agg, log_base):
    """Write endgame move statistics to a markdown file."""
    eg = agg['endgame_moves']
    if not any(eg['all'][lb] for lb in (2, 4, 6)):
        return

    # Derive path: logs/<matchup>/statistics_<matchup>_<NNN>.md
    log_dir = os.path.dirname(log_base)
    base_name = os.path.basename(log_base)          # e.g. v15_vs_v16_003
    stat_path = os.path.join(log_dir, f'statistics_{base_name}.md')

    lines = ['# Endgame Move Statistics\n']
    lines.append(f'Games: {agg["games_played"]}  |  '
                 f'Decisive: {sum(eg["all"][2].values())}\n')

    def _render_section(title, counters, bin_label=None):
        """Render 3 tables (by piece, by action, by piece+action) for one
        set of per-lookback Counters.  `counters` is {2: Counter, 4: …, 6: …}.
        """
        any_data = any(counters[lb] for lb in (2, 4, 6))
        if not any_data:
            return
        heading = f'## {title}' if bin_label is None else f'### {title}'
        lines.append(f'\n{heading}\n')

        # --- By piece ---
        lines.append('#### By piece\n')
        lines.append(f'| {"lookback":<12} | {"piece":<10} | {"count":>5} | {"pct":>6} |')
        lines.append(f'|{"-"*14}|{"-"*12}|{"-"*7}|{"-"*8}|')
        for lb in (2, 4, 6):
            ctr = counters[lb]
            if not ctr:
                continue
            total = sum(ctr.values())
            by_piece = Counter()
            for key, cnt in ctr.items():
                _mt, _pt = key.split(':')
                by_piece[_pt] += cnt
            for pt, cnt in by_piece.most_common():
                pct = 100.0 * cnt / total
                lines.append(f'| {_LB_LABELS[lb]:<12} | {pt:<10} '
                             f'| {cnt:>5} | {pct:>5.1f}% |')

        # --- By action ---
        lines.append('\n#### By action\n')
        lines.append(f'| {"lookback":<12} | {"action":<10} | {"count":>5} | {"pct":>6} |')
        lines.append(f'|{"-"*14}|{"-"*12}|{"-"*7}|{"-"*8}|')
        for lb in (2, 4, 6):
            ctr = counters[lb]
            if not ctr:
                continue
            total = sum(ctr.values())
            by_mt = Counter()
            for key, cnt in ctr.items():
                _mt, _pt = key.split(':')
                by_mt[_MT_NAMES.get(_mt, _mt)] += cnt
            for mt, cnt in by_mt.most_common():
                pct = 100.0 * cnt / total
                lines.append(f'| {_LB_LABELS[lb]:<12} | {mt:<10} '
                             f'| {cnt:>5} | {pct:>5.1f}% |')

        # --- By piece + action ---
        lines.append('\n#### By piece + action\n')
        lines.append(f'| {"lookback":<12} | {"piece":<10} | {"action":<10} '
                     f'| {"count":>5} | {"pct":>6} |')
        lines.append(f'|{"-"*14}|{"-"*12}|{"-"*12}|{"-"*7}|{"-"*8}|')
        for lb in (2, 4, 6):
            ctr = counters[lb]
            if not ctr:
                continue
            total = sum(ctr.values())
            # Sort by count descending
            for key, cnt in ctr.most_common():
                _mt, _pt = key.split(':')
                pct = 100.0 * cnt / total
                lines.append(f'| {_LB_LABELS[lb]:<12} | {_pt:<10} '
                             f'| {_MT_NAMES.get(_mt, _mt):<10} '
                             f'| {cnt:>5} | {pct:>5.1f}% |')

    # Overall
    _render_section('All games', eg['all'])

    # Per move-length bin
    for bname in MOVE_BIN_NAMES:
        bin_ctrs = eg[bname]
        if not any(bin_ctrs[lb] for lb in (2, 4, 6)):
            continue
        n_games = sum(bin_ctrs[2].values()) if bin_ctrs[2] else 0
        _render_section(f'Games won in {bname} moves (n={n_games})',
                        bin_ctrs, bin_label=bname)

    with open(stat_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
    print(f'\nEndgame stats: {stat_path}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--games', type=int, default=20,
                    help='Games per worker. Total = workers * games.')
    ap.add_argument('--workers', type=int, default=1,
                    help='Number of parallel driver processes. Each worker '
                         'runs --games games independently; results are '
                         'aggregated at the end.')
    ap.add_argument('--p1', default='v13',
                    choices=['v13', 'v15', 'v16', 'v17', 'v18', 'v17_old', 'v18_old', 'v19_old'])
    ap.add_argument('--p2', default='v15',
                    choices=['v13', 'v15', 'v16', 'v17', 'v18', 'v17_old', 'v18_old', 'v19_old'])
    ap.add_argument('--time', type=float, default=0.18)
    ap.add_argument('--ponder', action='store_true',
                    help='Enable pondering during opponent turn '
                         '(affects all AIs except v13).')
    ap.add_argument('--debug-tt', action='store_true',
                    help='Print per-AI transposition-table hit/cutoff stats '
                         'at the end of the run.')
    ap.add_argument('--swap', action='store_true',
                    help='Alternate sides each game to neutralize first-move '
                         'advantage (odd games play p1/p2 swapped).')
    ap.add_argument('--v19-eval', choices=['on', 'off'], default='on',
                    help='Enable v19 improved eval (only affects v19).')
    ap.add_argument('--v19-qs', choices=['on', 'off'], default='on',
                    help='Enable v19 quiescence search (only affects v19).')
    ap.add_argument('--debug-otl2', action='store_true',
                    help='Enable OTL-2 diagnostic logging for v17 '
                         '(writes JSONL to logs/otl2_debug_*.jsonl).')
    args = ap.parse_args()

    if args.workers < 1:
        ap.error('--workers must be >= 1')

    label1, label2 = _labels_for(args)
    log_base = _next_log_base(args.p1, args.p2) if __debug__ else None
    total_games = args.workers * args.games

    if __debug__:
        if args.workers == 1:
            print(f'Log: {log_base}.log')
        else:
            print(f'Logs: {log_base}_w0.log .. {log_base}_w{args.workers-1}.log')

    print(f'Running {total_games} games: {args.p1.upper()} vs {args.p2.upper()}'
          + (f'  ({args.workers} workers x {args.games} games)'
             if args.workers > 1 else ''))
    print(f'Time: {args.time}s/move  (measured wall-clock at controller, incl. IPC)')
    print(f'Workers: 2 processes (each AI fully isolated — no GIL/GC contention)')
    print(f'v13 = baseline')
    print(f'v15 = v13 + TT + negamax'
          + (' + ponder' if args.ponder else ''))
    print(f'v16 = v15 + full root search + mate-only early break'
          + (' + ponder' if args.ponder else ''))
    print(f'v17 = v15/v16 hybrid (v15 knobs for ply<6, v16 knobs from ply>=6)'
          + (' + ponder' if args.ponder else ''))
    print()

    agg = _empty_agg(label1, label2)

    if args.workers == 1:
        lp = f'{log_base}.log' if __debug__ else None
        slice_agg = _run_slice(args, 0, lp, quiet=False)
        _merge_agg(agg, slice_agg, label1, label2)
    else:
        with ProcessPoolExecutor(max_workers=args.workers) as ex:
            futures = {
                ex.submit(_run_slice, args, idx,
                          f'{log_base}_w{idx}.log' if __debug__ else None,
                          True): idx
                for idx in range(args.workers)
            }
            for fut in as_completed(futures):
                idx = futures[fut]
                slice_agg = fut.result()
                _merge_agg(agg, slice_agg, label1, label2)
                print(f'Worker {idx} done: '
                      f'{label1} {slice_agg["wins"][label1]} - '
                      f'{label2} {slice_agg["wins"][label2]} - '
                      f'Draws {slice_agg["wins"]["Draw"]} '
                      f'({slice_agg["games_played"]} games)')

    games = agg['games_played']
    tm = agg['total_moves']

    w1, w2, wd = agg['wins'][label1], agg['wins'][label2], agg['wins']['Draw']
    def _pct(n: int) -> str:
        return f'{100*n/games:.1f}%' if games > 0 else '-'
    print(f'\nFinal: {label1.upper()} {w1} [{_pct(w1)}] - '
          f'{label2.upper()} {w2} [{_pct(w2)}] - '
          f'Draws {wd} [{_pct(wd)}]')
    if games > 0:
        print(f'Avg moves: {tm/games:.1f}')
    if tm > 0:
        print(f'Avg {label1}: {agg["nodes"][label1]/games:,.0f} '
              f'({agg["nodes"][label1]/tm:,.0f}/move)')
        print(f'Avg {label2}: {agg["nodes"][label2]/games:,.0f} '
              f'({agg["nodes"][label2]/tm:,.0f}/move)')

    def _fmt_depth(lbl):
        cnt = agg['depth_cnt'][lbl]
        if cnt == 0:
            return f'{lbl}: n/a'
        avg = agg['depth_sum'][lbl] / cnt
        dmin = agg['depth_min'][lbl]
        dmax = agg['depth_max'][lbl]
        return f'{lbl}: min={dmin} avg={avg:.2f} max={dmax}'

    print(f'Depth  {_fmt_depth(label1)}')
    print(f'Depth  {_fmt_depth(label2)}')

    def _fmt_time(lbl):
        cnt = agg['time_cnt'][lbl]
        viols = agg['viol'][lbl]
        if cnt == 0:
            return f'{lbl}: n/a  (violations: {viols})'
        avg = agg['time_sum'][lbl] / cnt
        tmin = agg['time_min'][lbl]
        tmax = agg['time_max'][lbl]
        return (f'{lbl}: min={tmin*1000:.1f}ms '
                f'avg={avg*1000:.1f}ms max={tmax*1000:.1f}ms  '
                f'(violations: {viols})')

    print(f'Think  {_fmt_time(label1)}')
    print(f'Think  {_fmt_time(label2)}')

    def _fmt_tt(lbl):
        probes = agg['tt_probes'][lbl]
        hits = agg['tt_hits'][lbl]
        cuts = agg['tt_cutoffs'][lbl]
        mv_used = agg['tt_move_used'][lbl]
        peak = agg['tt_peak'][lbl]
        if probes == 0:
            return f'{lbl}: no TT activity'
        hit_pct = 100.0 * hits / probes
        cut_pct = 100.0 * cuts / probes
        mv_pct = 100.0 * mv_used / probes
        return (f'{lbl}: probes={probes:,} '
                f'hit={hit_pct:.1f}% cutoff={cut_pct:.1f}% '
                f'move_used={mv_pct:.1f}% peak={peak:,}')

    def _fmt_ponder(lbl):
        p_nodes = agg['p_nodes'][lbl]
        p_stores = agg['p_stores'][lbl]
        p_hit = agg['p_hit'][lbl]
        p_cut = agg['p_cut'][lbl]
        if p_nodes == 0 and p_stores == 0:
            return f'{lbl}: no ponder activity (disable or unsupported)'
        reuse = (100.0 * p_hit / p_stores) if p_stores else 0.0
        cut_reuse = (100.0 * p_cut / p_stores) if p_stores else 0.0
        return (f'{lbl}: p_nodes={p_nodes:,} p_stores={p_stores:,} '
                f'p_hit_on_stored={p_hit:,} ({reuse:.1f}% of stores) '
                f'p_cutoff_on_stored={p_cut:,} ({cut_reuse:.1f}% of stores)')

    if args.debug_tt:
        print(f'TT     {_fmt_tt(label1)}')
        print(f'TT     {_fmt_tt(label2)}')
        print(f'Ponder {_fmt_ponder(label1)}')
        print(f'Ponder {_fmt_ponder(label2)}')

    # Win-length distribution. Bins overlap on the ">N" side (a 60-move
    # win is counted under >10, >20, and >50) — the user asked for
    # cumulative tail counts rather than disjoint buckets.
    decisive = w1 + w2
    def _bin_fmt(n: int) -> str:
        """Format count with percentage of decisive games, e.g. '42 [5.3%]'."""
        if decisive > 0:
            return f'{n} [{100*n/decisive:.1f}%]'
        return str(n)

    hdr_moves = 'moves'
    hdr_p1 = f'{label1} won'
    hdr_p2 = f'{label2} won'
    hdr_total = 'Total'
    # Pre-compute formatted cells to measure column widths
    rows = []
    for name in MOVE_BIN_NAMES:
        c1 = agg['win_bins'][label1][name]
        c2 = agg['win_bins'][label2][name]
        rows.append((name, _bin_fmt(c1), _bin_fmt(c2), _bin_fmt(c1 + c2)))
    col_moves = max(len(hdr_moves), max(len(r[0]) for r in rows))
    col_p1 = max(len(hdr_p1), max(len(r[1]) for r in rows))
    col_p2 = max(len(hdr_p2), max(len(r[2]) for r in rows))
    col_total = max(len(hdr_total), max(len(r[3]) for r in rows))
    sep = (f'{"-"*col_moves}-+-{"-"*col_p1}-+-{"-"*col_p2}-+-{"-"*col_total}')
    print(f'\nWin length distribution:')
    print(f'{hdr_moves:<{col_moves}} | {hdr_p1:>{col_p1}} | '
          f'{hdr_p2:>{col_p2}} | {hdr_total:>{col_total}}')
    print(sep)
    for name, f1, f2, ft in rows:
        print(f'{name:<{col_moves}} | {f1:>{col_p1}} | '
              f'{f2:>{col_p2}} | {ft:>{col_total}}')

    if __debug__:
        _write_endgame_stats(agg, log_base)

    # Write aggregated OTL-2 diagnostic JSONL (single file per run).
    otl2_all = agg.get('otl2_events', [])
    if otl2_all:
        import json as _json
        run_id = os.path.basename(log_base)
        otl2_path = f'{log_base}_otl2_diag.jsonl'
        with open(otl2_path, 'w', encoding='utf-8') as f:
            for ev in otl2_all:
                ev['run_id'] = run_id
                f.write(_json.dumps(ev) + '\n')
        print(f'\nOTL-2 diag: {len(otl2_all)} events -> {otl2_path}')

    print(f'\nBudget: {args.time*1000:.0f}ms/move')

    if agg['viol'][label1] > 0 or agg['viol'][label2] > 0:
        sys.exit(1)


if __name__ == '__main__':
    mp.freeze_support()
    main()
