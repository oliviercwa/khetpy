import time
from game import moves, do, terminal, evalf

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
