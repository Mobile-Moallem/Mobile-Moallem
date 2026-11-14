#!/usr/bin/env python3
"""Nudge word start times to the real start of each word in melismatic (long-held-note) chant.

Hand-tapped or aligned times in melisma tend to switch to the next word a little early, while
the previous word's held vowel is still being sung. The speech model hears held vowels as almost
silence, so forced alignment can't fix this alone. Instead, for every word this looks in a small
window around its current time (default 0.3 s before to 1.2 s after) for the clearest sign that
a new syllable begins:

  * timbre change  – the vowel colour changes (MFCC novelty; pitch changes in a melisma don't count)
  * loudness dip-then-rise – a consonant briefly interrupts the held note
  * first-letter evidence – the speech model's probability for the word's first consonant

and moves the time there only when that sign is clearly stronger than at the current time.
Words stay in order. Writes a forced.json-shaped file (old = input times, forced = snapped)
so karaoke-view.py can play Saved vs Fixed side by side.

Usage
  python3 snap-melisma.py INPUT.json RECORDING.wav OUT.json [--before 0.3] [--after 1.2] [--min-gain 1.0]
INPUT.json is fetch-hymn.py output (text + timings).
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re

import numpy as np
import torch
import torchaudio

_spec = importlib.util.spec_from_file_location("fa", os.path.join(os.path.dirname(__file__), "forced-align.py"))
fa = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fa)
RATE, HOP = 16000, 160  # 10 ms frames


def z(x):
    x = np.asarray(x, float)
    s = x.std()
    return (x - x.mean()) / s if s > 1e-9 else x * 0


def features(wav: torch.Tensor):
    mf = torchaudio.transforms.MFCC(sample_rate=RATE, n_mfcc=13,
                                    melkwargs={"n_fft": 512, "hop_length": HOP, "n_mels": 40})(wav).numpy()[1:]  # drop energy coef
    n = mf.shape[1]
    x = wav.numpy()[: n * HOP]
    x = np.pad(x, (0, n * HOP - len(x)))
    db = 20 * np.log10(np.sqrt((x.reshape(n, HOP) ** 2).mean(1)) + 1e-5)
    w = 15  # 150 ms each side
    nov = np.zeros(n)
    rise = np.zeros(n)
    for i in range(w, n - w):
        a, b = mf[:, i - w:i].mean(1), mf[:, i:i + w].mean(1)
        nov[i] = 1 - np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9)
        rise[i] = db[i:i + 8].mean() - db[max(0, i - 8):i].min()
    return z(nov), z(rise), db


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("wav")
    ap.add_argument("out")
    ap.add_argument("--before", type=float, default=0.3)
    ap.add_argument("--after", type=float, default=1.2)
    ap.add_argument("--min-gain", type=float, default=1.0, help="how much stronger the new spot must be")
    ap.add_argument("--gap", type=float, default=0.15)
    a = ap.parse_args()

    meta = json.load(open(a.input))
    words = re.split(r"\s+", meta["text"].strip())
    old = meta["timings"]
    wav = fa.read_wav(a.wav)
    nov, rise, db = features(wav)
    n = len(nov)

    # first-letter evidence from the speech model
    bundle = torchaudio.pipelines.MMS_FA
    model = bundle.get_model(with_star=False)
    D = bundle.get_dict(star=None)
    em = fa.emissions(model, wav)
    P = em.exp().numpy() if float(em.max()) <= 0 else em.softmax(-1).numpy()
    spf = (len(wav) / RATE) / P.shape[0]
    frame_t = np.arange(n) * HOP / RATE
    model_idx = np.minimum((frame_t / spf).astype(int), P.shape[0] - 1)

    def letter_curve(word):
        r = fa.romanise(word)
        lead = r[:2] if r[:2] in ("kh", "th", "sh", "ps", "ks") else r[:1]
        ids = [D[c] for c in lead if c in D]
        c = P[:, ids].sum(1) if ids else np.zeros(P.shape[0])
        c = np.convolve(c, np.ones(5) / 5, mode="same")[model_idx]
        return c, r[:1] not in "aeiou"

    rows, prev = [], -1.0
    for i, w in enumerate(words):
        t = old[i]
        if t is None:
            rows.append({"index": i, "word": w, "old": None, "forced": None, "score": None})
            continue
        nxt = next((old[j] for j in range(i + 1, len(words)) if old[j] is not None), None)
        lo_t = max(t - a.before, prev + a.gap)
        hi_t = t + a.after
        if nxt is not None:
            hi_t = min(hi_t, nxt - a.gap)
        lo, hi = int(lo_t * 100), int(hi_t * 100)
        new, gain = t, 0.0
        if hi > lo + 2 and hi < n:
            lc, consonant = letter_curve(w)
            lz = z(lc[max(0, lo - 300):hi + 300])[min(300, lo):][: hi - lo]
            score = nov[lo:hi] + rise[lo:hi] + (1.5 * lz if consonant else 0.5 * lz)
            here = int(round(t * 100)) - lo
            here_score = score[min(max(here, 0), len(score) - 1)]
            best = int(np.argmax(score))
            gain = float(score[best] - here_score)
            if gain >= a.min_gain:
                new = round((lo + best) / 100, 2)
        new = max(new, round(prev + a.gap, 2)) if prev >= 0 else new
        rows.append({"index": i, "word": w, "roman": fa.romanise(w), "old": t, "forced": new,
                     "score": round(gain, 2), "agree": True})
        prev = new
    json.dump({"hymn_id": meta.get("hymn_id"), "first_word": 0, "words": rows},
              open(a.out, "w"), ensure_ascii=False, indent=1)
    moved = [r for r in rows if r["old"] is not None and abs(r["forced"] - r["old"]) >= 0.05]
    later = sum(r["forced"] > r["old"] for r in moved)
    print(f"{len(rows)} words; moved {len(moved)} ({later} later, {len(moved) - later} earlier); "
          f"median move {np.median([r['forced'] - r['old'] for r in moved]) if moved else 0:+.2f}s; wrote {a.out}")


if __name__ == "__main__":
    main()
