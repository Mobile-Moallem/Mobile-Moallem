#!/usr/bin/env python3
"""Turn forced-align-lines.py output into one clean, in-order timing list.

Words where both methods agree are anchors. Every other word takes the best-scoring candidate
(windowed, global, or the saved time) that fits in order between its neighbours; if none fits,
it is spaced evenly between the anchors around it. With --only-agreed, non-anchor words keep
their saved time (use this for hymns that are already good, to apply only sure fixes).

Usage  python3 build-final.py V2.json OUT.json [--only-agreed] [--min-change 0.3]
Writes {"timings": [...], "words": [... with "final" and "how"]}.
"""
import argparse, json
ap = argparse.ArgumentParser(); ap.add_argument("v2"); ap.add_argument("out")
ap.add_argument("--only-agreed", action="store_true"); ap.add_argument("--min-change", type=float, default=0.0)
ap.add_argument("--gap", type=float, default=0.05); a = ap.parse_args()
W = json.load(open(a.v2))["words"]; n = len(W)
anchor = [w["forced"] if w.get("agree") else None for w in W]
if a.only_agreed:
    anchor = [t if t is not None and w["old"] is not None and abs(t - w["old"]) >= a.min_change else None for t, w in zip(anchor, W)]
out, how, prev = [], [], -1.0
for i, w in enumerate(W):
    nxt_i = next((j for j in range(i + 1, n) if anchor[j] is not None), None)
    nxt = anchor[nxt_i] if nxt_i is not None else float("inf")
    if anchor[i] is not None and prev < anchor[i] < nxt:
        t, h = anchor[i], "agreed"
    else:
        cands = [(w["old"], 0.0, "saved")] if a.only_agreed else []
        if not a.only_agreed:
            cands = sorted([(w.get("forced_window"), w.get("score_window") or 0, "window"),
                            (w.get("forced_global"), w.get("score_global") or 0, "global"),
                            (w["old"], 0.0, "saved")], key=lambda c: -c[1])
        fit = [c for c in cands if c[0] is not None and prev + a.gap <= c[0] < nxt]
        if fit:
            t, h = fit[0][0], fit[0][2]
        else:
            hi = nxt if nxt != float("inf") else prev + 1.0
            k = (nxt_i - i + 1) if nxt_i is not None else 2
            t, h = prev + (hi - prev) / k, "spaced"
    t = round(max(t, prev + a.gap if prev >= 0 else t), 2)
    out.append(t); how.append(h); prev = t
assert all(x < y for x, y in zip(out, out[1:]))
for w, t, h in zip(W, out, how): w["final"], w["how"] = t, h
json.dump({"timings": out, "words": W}, open(a.out, "w"), ensure_ascii=False, indent=1)
from collections import Counter
print(a.out, len(out), "words", dict(Counter(how)), "changed >0.3s vs saved:", sum(abs(t - w["old"]) > 0.3 for t, w in zip(out, W) if w["old"] is not None))
