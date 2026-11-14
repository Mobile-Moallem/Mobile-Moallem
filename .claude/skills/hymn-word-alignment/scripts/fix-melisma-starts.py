#!/usr/bin/env python3
"""Fix word starts that switch too early in melismatic chant (decided word by word).

What goes wrong (found on the 1st Lobsh, 2026-11-12): the singer stretches the LAST syllable of a
word for several seconds, often takes a breath, and only then starts the next word. Hand-tapped
times put the next word at the start of that stretched syllable or just before the breath, so
the highlight jumps 0.5–3 s early. Whole-text forced alignment can't fix it because the speech
model hears held vowels as near-silence.

How this decides, per word (using the current saved time t as a rough guide):
  1. Breaths: stretches ≥120 ms where loudness drops far below the singing (the singer breathes).
  2. Evidence: the speech model's probability for the word's first consonant
     (for words starting with a jinkim, e.g. `nte, the consonant after it).
  3. If a breath begins within --look seconds after t, compare the evidence before the breath
     with the evidence right after it:
        after clearly stronger  → the word starts when singing resumes after that breath
        before clearly stronger → the breath is inside this word's own long note; start = where its
                                  first consonant is heard before the breath (usually ≈ t)
  4. No breath: move to where the first consonant is heard, only if that is clear and within
     the window; otherwise keep t.
  5. Never past the next word; order is kept. Every decision is written with a reason.

Usage
  python3 fix-melisma-starts.py INPUT.json RECORDING.wav OUT.json [--look 3.5]
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
RATE, HOP = 16000, 160
CLUSTERS = ("kh", "th", "sh", "ps", "ks")


def loudness(wav):
    x = wav.numpy()
    n = len(x) // HOP
    db = 20 * np.log10(np.sqrt((x[: n * HOP].reshape(n, HOP) ** 2).mean(1)) + 1e-5)
    return np.convolve(db, np.ones(5) / 5, "same")


def breaths(db, min_len=12):
    sung = np.percentile(db, 75)
    quiet = db < sung - 18
    out, i, n = [], 0, len(db)
    while i < n:
        if quiet[i]:
            j = i
            while j < n and quiet[j]:
                j += 1
            if j - i >= min_len:
                out.append((i / 100, j / 100))
            i = j
        else:
            i += 1
    return out


def lead_letters(word):
    raw = word.lower()
    r = fa.romanise(word)
    if raw.startswith("`") and len(r) > 1 and r[0] == "e":
        r = r[1:]  # jinkim: the short "e" is not a reliable cue; use the consonant after it
    if r[:2] in CLUSTERS:
        return r[:2], True
    return r[:1], r[:1] not in "aeiou"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("wav")
    ap.add_argument("out")
    ap.add_argument("--look", type=float, default=3.5, help="how far after the saved time a breath may be")
    ap.add_argument("--ratio", type=float, default=1.5, help="how much stronger one side must be")
    ap.add_argument("--min-ev", type=float, default=0.08)
    a = ap.parse_args()

    meta = json.load(open(a.input))
    words = re.split(r"\s+", meta["text"].strip())
    old = meta["timings"]
    wav = fa.read_wav(a.wav)
    db = loudness(wav)
    br = breaths(db)

    bundle = torchaudio.pipelines.MMS_FA
    model = bundle.get_model(with_star=False)
    D = bundle.get_dict(star=None)
    em = fa.emissions(model, wav)
    P = em.exp().numpy() if float(em.max()) <= 0 else em.softmax(-1).numpy()
    spf = (len(wav) / RATE) / P.shape[0]

    def curve(word):
        lead, _ = lead_letters(word)
        ids = [D[c] for c in lead if c in D]
        return P[:, ids].sum(1) if ids else np.zeros(P.shape[0])

    def peak(c, s, e):
        i, j = max(0, int(s / spf)), min(len(c), int(e / spf))
        if j <= i:
            return 0.0, s
        k = int(np.argmax(c[i:j]))
        return float(c[i + k]), (i + k) * spf

    def resume_after(b1):
        """first moment singing is back after a breath"""
        i = int(b1 * 100)
        sung = np.percentile(db, 75)
        while i < len(db) and db[i] < sung - 12:
            i += 1
        return i / 100

    rows, prev = [], -1.0
    for k, w in enumerate(words):
        t = old[k]
        if t is None:
            rows.append({"index": k, "word": w, "old": None, "forced": None, "how": "untimed"})
            continue
        nxt = next((old[j] for j in range(k + 1, len(words)) if old[j] is not None), None)
        limit = (nxt - 0.15) if nxt is not None else t + a.look + 2
        c = curve(w)
        _, consonant = lead_letters(w)
        new, how = t, "kept (no clear evidence)"
        nb = [b for b in br if t < b[0] <= t + a.look and b[1] < limit]
        if nb:
            b0, b1 = nb[0]
            ev_before, at_before = peak(c, t - 0.5, b0)
            r = resume_after(b1)
            ev_after, at_after = peak(c, b1, min(r + 1.0, limit))
            if ev_after >= a.min_ev and ev_after > ev_before * a.ratio:
                new, how = r, f"starts after the breath at {b0:.2f}-{b1:.2f} (first letter heard after: {ev_after:.2f} vs before {ev_before:.2f})"
            elif ev_before >= a.min_ev and ev_before > ev_after * a.ratio:
                cand = at_before - 0.08
                if abs(cand - t) <= 1.0 and cand > t:
                    new, how = cand, f"breath is inside this word; first letter heard at {at_before:.2f}"
                else:
                    how = f"breath is inside this word; saved time fits (first letter {ev_before:.2f} before breath)"
            elif not consonant:
                how = "kept (word starts with a vowel and evidence is unclear)"
        else:
            ev, at = peak(c, t - 0.3, min(t + 1.5, limit))
            if consonant and ev >= 0.3 and at - 0.08 > t + 0.15:
                new, how = at - 0.08, f"first letter heard at {at:.2f} (strength {ev:.2f})"
        new = round(max(new, prev + 0.15) if prev >= 0 else new, 2)
        rows.append({"index": k, "word": w, "roman": fa.romanise(w), "old": t, "forced": new,
                     "score": None, "agree": True, "how": how})
        prev = new

    json.dump({"hymn_id": meta.get("hymn_id"), "first_word": 0, "breaths": br, "words": rows},
              open(a.out, "w"), ensure_ascii=False, indent=1)
    moved = [r for r in rows if r["old"] is not None and abs(r["forced"] - r["old"]) >= 0.05]
    later = [r["forced"] - r["old"] for r in moved if r["forced"] > r["old"]]
    print(f"{len(rows)} words; {len(br)} breaths; moved {len(moved)} "
          f"({len(later)} later, median {np.median(later) if later else 0:+.2f}s); kept {len(rows) - len(moved)}; wrote {a.out}")


if __name__ == "__main__":
    main()
