#!/usr/bin/env python3
"""Mix saved and forced-aligned timings, taking the forced time only where it is sure.

A word gets its forced time when all of these hold:
  * the model's confidence (score) is at least --min-score
  * the forced time is within --max-shift seconds of the saved time
  * it is not within --guard words of a drift stretch (3+ words in a row
    that moved by --max-shift or more, i.e. where the model lost its place)
  * keeping it leaves the timings in order, at least --min-gap apart
Every other word keeps its saved time. Writes a forced.json-shaped file whose
"forced" field holds the mixed result (so karaoke-view.py can show it) plus a
"source" field per word.

Usage
  python3 scripts/merge-sure-timings.py FORCED.json OUT.json
"""
from __future__ import annotations

import argparse
import json


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("forced")
    ap.add_argument("out")
    ap.add_argument("--min-score", type=float, default=0.3)
    ap.add_argument("--max-shift", type=float, default=1.0)
    ap.add_argument("--guard", type=int, default=2)
    ap.add_argument("--min-gap", type=float, default=0.1)
    a = ap.parse_args()

    data = json.load(open(a.forced))
    words = data["words"]
    n = len(words)
    shift = [None if w["old"] is None or w["forced"] is None else w["forced"] - w["old"] for w in words]

    drift = [False] * n
    i = 0
    while i < n:
        j = i
        while j < n and shift[j] is not None and abs(shift[j]) >= a.max_shift:
            j += 1
        if j - i >= 3:
            for k in range(max(0, i - a.guard), min(n, j + a.guard)):
                drift[k] = True
        i = max(j, i + 1)

    sure = [
        shift[i] is not None and words[i]["score"] >= a.min_score
        and abs(shift[i]) < a.max_shift and not drift[i]
        for i in range(n)
    ]

    # Take sure forced times, then undo any that break ordering until stable.
    while True:
        mixed = [w["forced"] if s else w["old"] for w, s in zip(words, sure)]
        bad = None
        last = None
        for i, t in enumerate(mixed):
            if t is None:
                continue
            if last is not None and t - mixed[last] < a.min_gap:
                bad = i if sure[i] else last
                if not sure[bad]:
                    bad = None
                    break
                break
            last = i
        if bad is None:
            break
        sure[bad] = False

    out_words = []
    for w, s, t in zip(words, sure, mixed):
        out_words.append({**w, "aligned": w["forced"], "forced": t, "source": "forced" if s else "saved"})
    json.dump({**data, "words": out_words}, open(a.out, "w"), ensure_ascii=False, indent=1)
    taken = sum(sure)
    ts = [t for t in mixed if t is not None]
    print(f"{taken}/{n} words take the forced time; increasing={all(x < y for x, y in zip(ts, ts[1:]))}")


if __name__ == "__main__":
    main()
