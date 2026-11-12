#!/usr/bin/env python3
"""Line-aware forced alignment for long, drawn-out hymns (e.g. the 2nd/3rd Canticles).

forced-align.py aligns the whole hymn as one string. In long melismatic chants the singer holds
notes, adds syllables or repeats phrases that are not in the text, and the model can lose its
place for a whole stretch. This script fixes that two ways and compares them:

  A. "global+star": whole hymn in one pass, but with a <star> token before every line, which can
     soak up any sung material that is not in the text (intros, held notes, repeats).
  B. "windowed": each line on its own, inside a window around its saved start time
     (from the line's first saved time − PAD to the next line's first saved time + PAD),
     with <star> at both ends.

Per word it writes forced_global, forced_window, their scores, and `forced` = the agreed time
(the two methods within --agree seconds → their mean; otherwise the higher-scoring one, flagged
with agree=false). Output has the same shape as forced-align.py, so merge-sure-timings.py,
karaoke-view.py and timing-review.py all work on it.

Usage
  python3 forced-align-lines.py INPUT.json RECORDING.wav OUT.json [--pad 6] [--agree 0.35]
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


def align(em, tokens):
    aligned, scores = F.forced_align(em.unsqueeze(0), torch.tensor([tokens], dtype=torch.int32), blank=0)
    return F.merge_tokens(aligned[0], scores[0].exp())


def word_spans(spans, groups, star_id):
    """spans: merged token spans; groups: list of per-word token counts in order, with None = star."""
    out, k = [], 0
    for g in groups:
        n = 1 if g is None else g
        piece = spans[k:k + n]
        k += n
        if g is not None:
            out.append(piece)
    return out


def summarise(piece, offset, spf):
    start = round((piece[0].start + offset) * spf, 2)
    end = round((piece[-1].end + offset) * spf, 2)
    dur = sum(s.end - s.start for s in piece) or 1
    score = float(sum(s.score * (s.end - s.start) for s in piece) / dur)
    return start, end, round(score, 3)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("wav")
    ap.add_argument("out")
    ap.add_argument("--pad", type=float, default=6.0)
    ap.add_argument("--agree", type=float, default=0.35)
    ap.add_argument("--start-at", type=float, default=None)
    a = ap.parse_args()

    meta = json.load(open(a.input))
    text = meta["text"].strip()
    lines = [l.split() for l in text.split("\n") if l.split()]
    words = re.split(r"\s+", text)
    assert sum(map(len, lines)) == len(words)
    old = meta["timings"]
    assert len(old) == len(words)

    bundle = torchaudio.pipelines.MMS_FA
    model = bundle.get_model(with_star=True)
    dictionary = bundle.get_dict(star="*")
    star = dictionary["*"]

    wav = fa.read_wav(a.wav)
    em = fa.emissions(model, wav)
    spf = (len(wav) / RATE) / em.shape[0]
    roman = [fa.romanise(w) for w in words]
    toks = [[dictionary[c] for c in r] for r in roman]

    # --- A: global with a star before every line ---
    first_t = next((t for t in old if t is not None), 0.0)
    start_at = a.start_at if a.start_at is not None else max(0.0, first_t - 4.0)
    skip = int(start_at / spf)
    seq, groups, idx = [], [], 0
    for line in lines:
        seq.append(star); groups.append(None)
        for _ in line:
            seq += toks[idx]; groups.append(len(toks[idx])); idx += 1
    seq.append(star); groups.append(None)
    g = word_spans(align(em[skip:], seq), groups, star)
    glob = [summarise(p, skip, spf) for p in g]

    # --- B: each line in its own window around the saved times ---
    win = [None] * len(words)
    idx = 0
    line_first = []
    for line in lines:
        line_first.append(idx); idx += len(line)
    for li, line in enumerate(lines):
        i0 = line_first[li]
        i1 = i0 + len(line)
        t0 = next((old[j] for j in range(i0, i1) if old[j] is not None), None)
        nxt = next((old[j] for j in range(i1, len(words)) if old[j] is not None), None)
        if t0 is None:
            continue
        lo = max(0, int((t0 - a.pad) / spf))
        hi = min(em.shape[0], int(((nxt if nxt is not None else t0 + 30) + a.pad) / spf))
        seq = [star] + [t for j in range(i0, i1) for t in toks[j]] + [star]
        grp = [None] + [len(toks[j]) for j in range(i0, i1)] + [None]
        try:
            pieces = word_spans(align(em[lo:hi], seq), grp, star)
        except Exception:
            continue
        for j, p in zip(range(i0, i1), pieces):
            win[j] = summarise(p, lo, spf)

    rows = []
    for i, w in enumerate(words):
        gs, ge, gsc = glob[i]
        row = {"index": i, "word": w, "roman": roman[i], "old": old[i],
               "forced_global": gs, "score_global": gsc}
        if win[i]:
            ws, we, wsc = win[i]
            row.update(forced_window=ws, score_window=wsc)
            agree = abs(ws - gs) <= a.agree
            if agree:
                row.update(forced=round((ws + gs) / 2, 2), score=round(max(wsc, gsc), 3), end=max(ge, we))
            elif wsc >= gsc:
                row.update(forced=ws, score=wsc, end=we)
            else:
                row.update(forced=gs, score=gsc, end=ge)
            row["agree"] = agree
        else:
            row.update(forced=gs, score=gsc, end=ge, agree=False)
        rows.append(row)

    json.dump({"hymn_id": meta.get("hymn_id"), "first_word": 0, "words": rows},
              open(a.out, "w"), ensure_ascii=False, indent=1)
    n_agree = sum(r["agree"] for r in rows)
    print(f"{len(rows)} words; global and windowed agree on {n_agree} ({100*n_agree//len(rows)}%); wrote {a.out}")


if __name__ == "__main__":
    main()
