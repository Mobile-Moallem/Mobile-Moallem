# Alignment lab

Research tools for auto-aligning Hazzat notation to recordings. Nothing here is
used by the live site. Everything runs locally (numpy/scipy, Node). No external
APIs are used.

## Run

```
python3 build_dataset.py          # decode backup recordings, build data/ (not committed)
node eval-baseline.mjs --trim     # score the current in-app engine
python3 eval_matcher.py anchored  # score the new matcher (leave-one-hymn-out)
```

Feature caches (`data/*.feat.npz`) are produced by computing `features.features()`
on each recording; see `features.py`.

## Data

9 hymns with uploaded recordings and complete Hazzat timings, 2,102 timed words.
Stored Hazzat timings are still one slot per whitespace word (pre-v2 format).

## Results (within 1 second of hand timing)

| Engine | Auto span | Editor marks start/end |
|---|---|---|
| Current `alignment-worker.js` | 3% | 6% |
| Proportional by glyph length (naive) | n/a | 14% |
| `align.py` matcher | 8% | 24% (37% within 2 s) |

See `results.txt` for per-hymn numbers.

## Findings

- Learned per-glyph durations predict word length well (corr 0.85 vs 0.72 for character count).
- Within one hymn, identical notation words have consistent duration (CV 0.1–0.3) and
  pitch (~1 semitone). Glyphs do not predict pitch across different hymns.
- With true per-hymn melody templates the matcher reaches 36% within 1 s; learning those
  templates from its own alignment or from a hand-timed first verse has not worked yet.
- Automatic start/end detection fails when recordings have extra audio after the hymn.
- Measuring durations in "sung time" (ignoring pauses) made results worse as implemented.
