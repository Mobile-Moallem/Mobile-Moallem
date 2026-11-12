#!/usr/bin/env python3
"""Re-time melismatic hymns whose highlight jumps to the next word too early.

Cause (found on the 1st Lobsh, 2026-11-12): the singer stretches the LAST syllable of a word for
seconds. Hand-tapped times mark the next word when that stretch BEGINS, so each saved time sits
near the start of the previous word's long last syllable, 1-5 s before the word is really sung.
The real start of word k therefore lies between saved[k] and saved[k+1].

Fix: align each word's letters with the speech model, but only inside that window
(saved[k] - --before  …  saved[k+2] + --after, aligned together with word k+1 as context), with a <star> token on both sides to absorb the
held notes around it. The start of the word's first letter is its new time. Whole-hymn alignment
is not used because the model hears held vowels as silence and can drift by 15-30 s at line starts.

If the model hears nothing of the word in its window (score below --min-score) the saved time is
kept. Order is kept. Each word records its window, score and what was decided.

Usage
  python3 melisma-align.py INPUT.json RECORDING.wav OUT.json [--before 0.3] [--after 0.5]
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re

import torch
import torchaudio
import torchaudio.functional as F

_spec = importlib.util.spec_from_file_location("fa", os.path.join(os.path.dirname(__file__), "forced-align.py"))
fa = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fa)
RATE = fa.RATE


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("wav")
    ap.add_argument("out")
    ap.add_argument("--before", type=float, default=0.3)
    ap.add_argument("--after", type=float, default=0.5)
    ap.add_argument("--last-span", type=float, default=15.0, help="window length for the final word")
    ap.add_argument("--min-score", type=float, default=0.05)
    ap.add_argument("--gap", type=float, default=0.15)
    a = ap.parse_args()

    meta = json.load(open(a.input))
    words = re.split(r"\s+", meta["text"].strip())
    old = meta["timings"]
    assert len(old) == len(words)

    bundle = torchaudio.pipelines.MMS_FA
    model = bundle.get_model(with_star=True)
    D = bundle.get_dict(star="*")
    star = D["*"]
    wav = fa.read_wav(a.wav)
    em = fa.emissions(model, wav)
    spf = (len(wav) / RATE) / em.shape[0]

    rows, prev = [], -1.0
    for k, w in enumerate(words):
        t = old[k]
        if t is None:
            rows.append({"index": k, "word": w, "old": None, "forced": None, "how": "untimed"})
            continue
        later = [j for j in range(k + 1, len(words)) if old[j] is not None]
        nxt = old[later[0]] if later else None
        nxt2 = old[later[1]] if len(later) > 1 else None
        lo_t = max(0.0, t - a.before, prev + a.gap if prev >= 0 else 0.0)
        # word k really starts before word k+1 does, and word k+1 really starts before saved[k+2]
        hi_t = (nxt2 + a.after) if nxt2 is not None else ((nxt + a.last_span) if nxt is not None else t + a.last_span)
        lo, hi = int(lo_t / spf), min(em.shape[0], int(hi_t / spf))
        roman = fa.romanise(w)
        toks = [D[c] for c in roman]
        ctx = [D[c] for c in fa.romanise(words[later[0]])] if later else []
        new, score, how = t, 0.0, "kept (window too short)"
        if hi - lo > len(toks) + len(ctx) + 4:
            # the next word is aligned too, as context, so word k is not matched to a later echo
            seq = [star] + toks + [star] + ctx + ([star] if ctx else [])
            aligned, sc = F.forced_align(em[lo:hi].unsqueeze(0), torch.tensor([seq], dtype=torch.int32), blank=0)
            spans = F.merge_tokens(aligned[0], sc[0].exp())[1:1 + len(toks)]
            dur = sum(s.end - s.start for s in spans) or 1
            score = float(sum(s.score * (s.end - s.start) for s in spans) / dur)
            start = round((spans[0].start + lo) * spf, 2)
            if score >= a.min_score:
                new, how = start, f"heard in {lo_t:.2f}-{hi_t:.2f}"
            else:
                how = f"kept (word not heard clearly in {lo_t:.2f}-{hi_t:.2f}, score {score:.2f})"
        if prev >= 0 and new < prev + a.gap:
            new, how = round(prev + a.gap, 2), how + "; pushed to keep order"
        rows.append({"index": k, "word": w, "roman": roman, "old": t, "forced": new,
                     "score": round(score, 3), "agree": True, "how": how})
        prev = new

    json.dump({"hymn_id": meta.get("hymn_id"), "first_word": 0, "words": rows},
              open(a.out, "w"), ensure_ascii=False, indent=1)
    import statistics as st
    moves = [r["forced"] - r["old"] for r in rows if r["old"] is not None]
    kept = sum(r["how"].startswith("kept") for r in rows)
    print(f"{len(rows)} words; median move {st.median(moves):+.2f}s; later >0.3s: {sum(m > 0.3 for m in moves)}; "
          f"earlier >0.3s: {sum(m < -0.3 for m in moves)}; kept: {kept}; wrote {a.out}")


if __name__ == "__main__":
    main()
