import time
import ai_api
import game as _game
from game import moves, do, terminal, evalf

# ---------------------------------------------------------------------------
# Module-level functional API (setup / next_move)
# ---------------------------------------------------------------------------

_state  = None   # current game.S tracked by this AI
_player = None   # 1 or 2
_ai     = None   # AB instance


def setup(initial_positions, is_first_player, t=0.18, ponder=False):
    """Initialise the AI for a new game.  Returns True."""
    global _state, _player, _ai
    _player = 1 if is_first_player else 2
    _state  = ai_api.state_from_initial_positions(initial_positions)
    _ai     = AB(_player, t=t)   # v13 AB has no ponder param
    return True


def next_move(opponent_action):
    """Apply opponent's last action (JS dict or None) and return our move as a JS dict."""
    global _state
    if opponent_action is not None:
        internal_opp = ai_api.action_to_internal(opponent_action, _state)
        _state = _game.do(_state, internal_opp)
    move         = _ai.choose(_state)
    js_move      = ai_api.internal_to_action(move, _state, _player)
    _state       = _game.do(_state, move)
    return js_move

class _Timeout(Exception): pass

class AB:
    def __init__(self,pl,t=0.18):
        self.pl=pl; self.t=t; self.nodes=0; self.total_nodes=0; self.deadline=0.0
        self.last_depth=0
    def choose(self,s):
        start=time.perf_counter(); self.nodes=0
        self.last_depth=0
        self.deadline = start + self.t*0.90
        acts=moves(s)
        for a in acts:
            if do(s,a).win==self.pl: return a
        best=acts[0] if acts else None
        for d in range(1,9):
            if time.perf_counter() > self.deadline: break
            bv=-1e9; bb=None
            try:
                for a in acts[:16]:
                    v=self._s(do(s,a),d-1,-1e9,1e9,False)
                    if v>bv: bv=v; bb=a
            except _Timeout:
                break
            if bb:
                best=bb
                self.last_depth=d
            if bv>40000: break
        self.total_nodes += self.nodes
        return best
    def _s(self,s,d,a,b,mx):
        self.nodes+=1
        if (self.nodes & 255) == 0 and time.perf_counter() > self.deadline:
            raise _Timeout
        if d==0 or terminal(s): return evalf(s,self.pl)
        acts=moves(s)
        if mx:
            v=-1e9
            for act in acts[:10]:
                v=max(v,self._s(do(s,act),d-1,a,b,False))
                a=max(a,v)
                if b<=a: break
            return v
        else:
            v=1e9
            for act in acts[:10]:
                v=min(v,self._s(do(s,act),d-1,a,b,True))
                b=min(b,v)
                if b<=a: break
            return v
