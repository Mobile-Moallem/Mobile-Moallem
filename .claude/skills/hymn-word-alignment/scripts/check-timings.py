#!/usr/bin/env python3
"""Score one or more timing lists for a hymn against its recording.

For each list it reports the share of words whose first consonant (after a jinkim, the consonant
that follows it) is heard by the speech model within 1.2 s after the word's start — a word that is
highlighted too early or too late usually fails this. Vowel-only openings are skipped.
It also reports how many words each candidate moves later/earlier than the saved list by > 0.5 s.

Usage
  python3 check-timings.py INPUT.json RECORDING.wav [CANDIDATE.json ...] [--per-word]
CANDIDATE.json: any output with words[].forced (forced-align*.py, melisma-align.py, build-final.py).
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re

import numpy as np
import torchaudio

_spec = importlib.util.spec_from_file_location("fa", os.path.join(os.path.dirname(__file__), "forced-align.py"))
fa = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fa)
SIM = {"p": "pb", "b": "bpv", "v": "vfb", "f": "fv", "k": "kgq", "g": "gkj", "j": "jgy", "t": "td", "d": "dt", "s": "sc"}


def lead_consonant(roman):
    r = roman[1:] if roman.startswith("e") and len(roman) > 1 and roman[1] not in "aeiou" else roman
    cs = [c for c in r[:3] if c not in "aeiou"]
    return cs[0] if cs else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("wav")
    ap.add_argument("candidates", nargs="*")
    ap.add_argument("--per-word", action="store_true")
    a = ap.parse_args()
    meta = json.load(open(a.input))
    words = re.split(r"\s+", meta["text"].strip())
    roman = [fa.romanise(w) for w in words]
    b = torchaudio.pipelines.MMS_FA
    model = b.get_model(with_star=False)
    D = b.get_dict(star=None)
    wav = fa.read_wav(a.wav)
    P = np.exp(fa.emissions(model, wav).numpy())
    spf = (len(wav) / fa.RATE) / P.shape[0]

    def support(i, t):
        c = lead_consonant(roman[i])
        if c is None or t is None:
            return None
        ids = [D[x] for x in SIM.get(c, c) if x in D]
        lo, hi = max(0, int((t - 0.2) / spf)), min(P.shape[0], int((t + 1.2) / spf))
        return float(P[lo:hi][:, ids].sum(1).max()) if hi > lo and ids else 0.0

    lists = {"saved": meta["timings"]}
    for c in a.candidates:
        lists[os.path.basename(c)] = [w["forced"] for w in json.load(open(c))["words"]]
    res = {}
    for name, ts in lists.items():
        s = [support(i, t) for i, t in enumerate(ts)]
        v = np.array([x for x in s if x is not None])
        later = sum(1 for t, o in zip(ts, lists["saved"]) if t is not None and o is not None and t - o > 0.5)
        earlier = sum(1 for t, o in zip(ts, lists["saved"]) if t is not None and o is not None and o - t > 0.5)
        res[name] = {"heard": round(float(np.mean(v > 0.15)), 3) if len(v) else None, "n": int(len(v)),
                     "later": later, "earlier": earlier, "per_word": s}
        print(f"  {name:28s} first sound heard at start: {res[name]['heard']:.0%} of {len(v)}   "
              f"later>0.5s: {later:3d}  earlier>0.5s: {earlier:3d}")
    if a.per_word:
        json.dump({k: v["per_word"] for k, v in res.items()}, open(a.input.replace(".json", "-check.json"), "w"))


if __name__ == "__main__":
    main()
