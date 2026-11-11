#!/usr/bin/env python3
"""Forced word alignment for Coptic hymns (offline, read-only).

Instead of guessing from sound onsets, this lines up the actual text against
the recording with a multilingual speech model (torchaudio MMS_FA, wav2vec2
trained for forced alignment in 1,100+ languages on romanised text). Every word
gets the time where the model hears it begin, plus a confidence score.

Coptic text in the site's font encoding (CS Avva Shenouda: `s` = shai,
`;` = theta, `]` = ti, ...) is first converted to Latin letters that follow the
church pronunciation, because the model only knows a-z.

Words are split the same way the site does, so index i = timings[i]. Words
before --first-word (untimed in the saved data) are not aligned.

Usage
  python3 scripts/forced-align.py INPUT.json RECORDING.wav OUT.json [--first-word N]

Requires torch + torchaudio (2.1–2.8). The model (~1.2 GB) downloads on first
run into $TORCH_HOME.
"""
from __future__ import annotations

import argparse
import json
import re
import wave

import numpy as np
import torch
import torchaudio
import torchaudio.functional as F

RATE = 16000

# CS Avva Shenouda font letter -> pronunciation (church Bohairic).
LETTERS = {
    "a": "a", "b": "v", "g": "g", "d": "d", "e": "e", "z": "z", "y": "i",
    ";": "th", "i": "i", "k": "k", "l": "l", "m": "m", "n": "n", "x": "ks",
    "o": "o", "p": "p", "r": "r", "c": "s", "t": "t", "u": "u", "f": "f",
    "v": "f", ",": "kh", "'": "ps", "w": "o", "s": "sh", "q": "kh", "h": "h",
    "j": "g", "[": "sh", "]": "ti", "<": "kh",
}
# Abbreviations written with overline marks (=). Order matters.
ABBREVIATIONS = [
    ("=e=;=u", "ethouab"),   # holy
    ("=p=n=a", "pnevma"),    # spirit
    ("=p=na", "pnevma"),     # spirit (short form)
    ("=a=l", "allilouia"),   # alleluia
    ("=i=c=l", "israil"),    # Israel (P=i=c=l)
    ("i=c=l", "iisrail"),    # Israel (Pi=c=l)
    ("=o=c", "chois"),       # Lord (P=o=c -> pchois)
]
WHOLE_WORDS = {
    "v]": "efnouti",         # God
    "a=l": "allilouia",      # alleluia
    "=b": "esnav",           # numeral two
}
VOWELS = set("aeiouyw")


def romanise(word: str) -> str:
    w = word.lower().rstrip(".@:")
    if w in WHOLE_WORDS:
        return WHOLE_WORDS[w]
    for abbr, spoken in ABBREVIATIONS:
        w = w.replace(abbr, "\0" + spoken + "\0")
    out, i, raw = [], 0, False
    while i < len(w):
        ch = w[i]
        if ch == "\0":
            raw = not raw
        elif raw:
            out.append(ch)
        elif ch == "`":
            # jinkim: a short "e" before a consonant, silent before a vowel
            nxt = w[i + 1] if i + 1 < len(w) else ""
            if nxt and nxt not in VOWELS and nxt != "`":
                out.append("e")
        elif ch in LETTERS:
            out.append(LETTERS[ch])
        i += 1
    s = re.sub(r"[^a-z]", "", "".join(out))
    return s or "a"


def read_wav(path: str) -> torch.Tensor:
    with wave.open(path, "rb") as w:
        assert w.getframerate() == RATE and w.getsampwidth() == 2, "need 16 kHz 16-bit WAV"
        data = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768
        if w.getnchannels() > 1:
            data = data.reshape(-1, w.getnchannels()).mean(axis=1)
    return torch.from_numpy(data.copy())


def emissions(model, wav: torch.Tensor, chunk_s=20.0, context_s=2.0) -> torch.Tensor:
    """Run the model in overlapping chunks (full-length attention would need ~20 GB)."""
    chunk, ctx = int(chunk_s * RATE), int(context_s * RATE)
    parts, start = [], 0
    with torch.inference_mode():
        while start < len(wav):
            lo, hi = max(0, start - ctx), min(len(wav), start + chunk + ctx)
            em, _ = model(wav[lo:hi].unsqueeze(0))
            em = em[0]
            fps = em.shape[0] / ((hi - lo) / RATE)
            a = int(round((start - lo) / RATE * fps))
            b = a + int(round(min(chunk, len(wav) - start) / RATE * fps))
            parts.append(em[a:b])
            start += chunk
    return torch.cat(parts)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("wav")
    ap.add_argument("out")
    ap.add_argument("--first-word", type=int, default=None,
                    help="index of the first word sung in the recording (default: first timed word)")
    ap.add_argument("--start-at", type=float, default=None,
                    help="ignore audio before this second (default: 4 s before the first saved timing, "
                         "so a spoken or instrumental intro isn't mistaken for the first words)")
    args = ap.parse_args()

    meta = json.load(open(args.input))
    words = re.split(r"\s+", meta["text"].strip())
    timings = meta["timings"]
    assert len(words) == len(timings), "word/timing count mismatch"
    first = args.first_word if args.first_word is not None else next(i for i, t in enumerate(timings) if t is not None)

    bundle = torchaudio.pipelines.MMS_FA
    model = bundle.get_model(with_star=False)
    dictionary = bundle.get_dict(star=None)

    wav = read_wav(args.wav)
    em = emissions(model, wav)
    sec_per_frame = (len(wav) / RATE) / em.shape[0]
    start_at = args.start_at
    if start_at is None:
        start_at = max(0.0, (timings[first] if timings[first] is not None else 0.0) - 4.0)
    skip = int(start_at / sec_per_frame)
    em = em[skip:]

    sung = words[first:]
    roman = [romanise(w) for w in sung]
    tokens = [dictionary[c] for r in roman for c in r]
    aligned, scores = F.forced_align(em.unsqueeze(0), torch.tensor([tokens], dtype=torch.int32), blank=0)
    spans = F.merge_tokens(aligned[0], scores[0].exp())

    rows, k = [], 0
    for i, w in enumerate(words):
        if i < first:
            rows.append({"index": i, "word": w, "roman": romanise(w), "old": timings[i], "forced": None, "score": None})
            continue
        n = len(roman[i - first])
        ws = spans[k:k + n]
        k += n
        start = round((ws[0].start + skip) * sec_per_frame, 2)
        score = float(sum(s.score * (s.end - s.start) for s in ws) / sum(s.end - s.start for s in ws))
        rows.append({"index": i, "word": w, "roman": roman[i - first], "old": timings[i],
                     "forced": start, "end": round((ws[-1].end + skip) * sec_per_frame, 2), "score": round(score, 3)})

    json.dump({"hymn_id": meta.get("hymn_id"), "first_word": first, "words": rows}, open(args.out, "w"), ensure_ascii=False, indent=1)
    print(f"aligned {len(sung)} words; wrote {args.out}")


if __name__ == "__main__":
    main()
