"""AI worker process.

Runs a single AI instance in its own process so each side of a tournament
has fully isolated CPU, memory, GC, and Python interpreter — matching a
real "one-docker-per-AI" tournament setup. This also lets v15's ponder
thread run on a separate OS process from the opponent, so it uses genuine
idle cycles instead of stealing them via GIL contention.

Protocol (pickled dicts over a multiprocessing.Pipe):
  reset  : {"cmd":"reset", "name":"v13"|"v15", "pl":1|2, "t":float, "ponder":bool, "seed":int}
           -> {"ok": True}
  choose : {"cmd":"choose", "state": S}
           -> {"ok": True, "move": action, "total_nodes": int}
  close  : {"cmd":"close"}
           -> {"ok": True}   (then worker exits)

Pondering is driven entirely by the AI instance itself: v15's choose()
starts a ponder thread on the post-move state before returning. That
thread keeps working while the worker is blocked in conn.recv() waiting
for the next command; the next choose() stops it. No ponder messages
cross the pipe.
"""
import importlib
import random


def _build_ai(name, pl, t, ponder, better_eval=True, quiescence=True):
    if name == 'v13':
        from ai_ab_v13 import AB
        return AB(pl, t)
    if name == 'v16':
        from ai_ab_v16 import AB
        return AB(pl, t, ponder=ponder)
    if name == 'v17':
        from ai_ab_v17 import AB
        return AB(pl, t, ponder=ponder)
    if name == 'v18':
        from ai_ab_v18 import AB
        return AB(pl, t, ponder=ponder)
    if name == 'v17_old':
        from archive_ai.ai_ab_v17_old import AB
        return AB(pl, t, ponder=ponder)
    if name == 'v18_old':
        from archive_ai.ai_ab_v18_old import AB
        return AB(pl, t, ponder=ponder)
    if name == 'v19_old':
        from archive_ai.ai_ab_v19_old import AB
        return AB(pl, t, ponder=ponder,
                  better_eval=better_eval, quiescence=quiescence)
    from ai_ab_v15 import AB
    return AB(pl, t, ponder=ponder)


def _mod_name_for(name):
    if name in ('v17_old', 'v18_old', 'v19_old'):
        return f'archive_ai.ai_ab_{name}'
    return f'ai_ab_{name}'


def run(conn):
    ai = None
    active_mod = None   # module used by setup/next_move protocol
    try:
        while True:
            msg = conn.recv()
            cmd = msg.get('cmd')

            if cmd == 'setup':
                mod = importlib.import_module(_mod_name_for(msg['name']))
                random.seed(msg.get('seed', 0))
                mod.setup(
                    msg['initial_positions'],
                    msg['is_first_player'],
                    t=msg.get('t', 0.18),
                    ponder=msg.get('ponder', False),
                )
                active_mod = mod
                conn.send({'ok': True})

            elif cmd == 'next_move':
                js_move = active_mod.next_move(msg.get('opponent_action'))
                ai_inst = active_mod._ai
                otl2_buf = []
                buf = getattr(ai_inst, '_otl2_buf', None)
                if buf:
                    otl2_buf = list(buf)
                    buf.clear()
                conn.send({
                    'ok': True,
                    'action': js_move,
                    'total_nodes': ai_inst.total_nodes,
                    'depth': getattr(ai_inst, 'last_depth', 0),
                    'tt_probes': getattr(ai_inst, 'tt_probes', 0),
                    'tt_hits': getattr(ai_inst, 'tt_hits', 0),
                    'tt_cutoffs': getattr(ai_inst, 'tt_cutoffs', 0),
                    'tt_move_used': getattr(ai_inst, 'tt_move_used', 0),
                    'tt_peak': getattr(ai_inst, 'tt_peak', 0),
                    'ponder_nodes': getattr(ai_inst, 'ponder_nodes', 0),
                    'ponder_stores': getattr(ai_inst, 'ponder_stores', 0),
                    'ponder_hit_on_stored': getattr(ai_inst, 'ponder_hit_on_stored', 0),
                    'ponder_cutoff_on_stored': getattr(ai_inst, 'ponder_cutoff_on_stored', 0),
                    'otl2_events': otl2_buf,
                })

            elif cmd == 'enable_otl2':
                import ai_ab_v17
                ai_ab_v17.DEBUG_OTL2_LOG = True
                ai_ab_v17._otl2_worker_id = msg.get('worker_id')
                conn.send({'ok': True})

            elif cmd == 'reset':
                if ai is not None and hasattr(ai, 'stop_ponder'):
                    ai.stop_ponder()
                random.seed(msg['seed'])
                ai = _build_ai(
                    msg['name'], msg['pl'], msg['t'], msg['ponder'],
                    better_eval=msg.get('better_eval', True),
                    quiescence=msg.get('quiescence', True),
                )
                conn.send({'ok': True})

            elif cmd == 'choose':
                move = ai.choose(msg['state'])
                # Drain OTL-2 buffer if present.
                otl2_buf = []
                buf = getattr(ai, '_otl2_buf', None)
                if buf:
                    otl2_buf = list(buf)
                    buf.clear()
                conn.send({
                    'ok': True,
                    'move': move,
                    'total_nodes': ai.total_nodes,
                    'depth': getattr(ai, 'last_depth', 0),
                    'tt_probes': getattr(ai, 'tt_probes', 0),
                    'tt_hits': getattr(ai, 'tt_hits', 0),
                    'tt_cutoffs': getattr(ai, 'tt_cutoffs', 0),
                    'tt_move_used': getattr(ai, 'tt_move_used', 0),
                    'tt_peak': getattr(ai, 'tt_peak', 0),
                    'ponder_nodes': getattr(ai, 'ponder_nodes', 0),
                    'ponder_stores': getattr(ai, 'ponder_stores', 0),
                    'ponder_hit_on_stored': getattr(ai, 'ponder_hit_on_stored', 0),
                    'ponder_cutoff_on_stored': getattr(ai, 'ponder_cutoff_on_stored', 0),
                    'otl2_events': otl2_buf,
                })

            elif cmd == 'close':
                if ai is not None and hasattr(ai, 'stop_ponder'):
                    ai.stop_ponder()
                conn.send({'ok': True})
                return

            else:
                conn.send({'ok': False, 'error': f'unknown cmd: {cmd}'})
    except EOFError:
        return
    except Exception as e:
        try:
            conn.send({'ok': False, 'error': repr(e)})
        except Exception:
            pass
        return
