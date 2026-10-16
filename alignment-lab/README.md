# Alignment lab

Research tools for auto-aligning Hazzat notation to recordings. Nothing here is
used by the live site. Everything runs locally (numpy/scipy, Node). No external
APIs are used.

## Run

```
python3 build_dataset.py          # decode backup recordings, build data/ (not committed)
node eval-baseline.mjs --trim     # score the current in-app engine
PIECES=1 SOFT=1 KEY=1 KEYBREATH=1 python3 eval_matcher.py anchored            # best, editor marks start/end
FINDSTART=1 FINDEND2=1 PIECES=1 SOFT=1 KEY=1 KEYBREATH=1 python3 eval_matcher.py auto   # best, fully automatic
```

Feature caches (`data/*.feat.npz`) are produced by computing `features.features()`
on each recording; see `features.py`.

## In the site (branch only)

`application/dist/client/hazzat-reader.js` is the browser version. The editor's alignment
worker uses it for Hazzat suggestions (`method: 'hazzat-reader'`); word sections keep the old
estimate. `node eval-js.mjs` scores that exact file at the editor's 4 kHz audio:
88% within 1 s with start/end marked, 86% fully automatic (clip honoured when set).
Tests: `application/tests/hazzat-reader.test.mjs`.

## Data

9 hymns with uploaded recordings and complete Hazzat timings, 2,102 timed words.
Stored Hazzat timings are still one slot per whitespace word (pre-v2 format).

## Results (within 1 second of hand timing)

| Engine | Auto span | Editor marks start/end |
|---|---|---|
| Current `alignment-worker.js` | 3% | 6% |
| Proportional by glyph length (naive) | n/a | 14% |
| `align.py` matcher (round 1) | 8% | 24% (37% within 2 s) |
| `align.py` + notation lines anchored to breaths (round 2) | 28% | 43% (60% within 2 s) |
| Round 3: reads the Hazzat key, aligns every piece, breaths as anchors | **88% (95% within 2 s)** | **90% (97% within 2 s)** |

See `results.txt` for per-hymn numbers.

## Findings

Round 3 (reading the notation):
- The Hazzat font key (copticcantor.com/font): bottom row z x c v b n m = full notes of length
  1..7, top row q w e r ... = half notes, a = fast transition, s d f ... = extensions, '.' = breath
  of about one full note. Durations straight from this key (no training) correlate 0.88 with hand
  timings, better than the learned model (0.85). See `HazzatKey`.
- A breath mark '.' means the next piece starts after a pause, like a new notation line.
- New words start with a loudness dip and voicing break (the consonant); pitch changes mostly
  happen *inside* words (new note, same syllable), so pitch steps are no longer rewarded.
- Aligning at the piece level (split at '.', same as the site's hit boxes) turns breaths inside
  long melismas into anchors instead of traps: biggest single gain.
- Fully automatic start/end: try plausible starts/ends at pauses, keep the best notation fit.
- Remaining weak spots: The Creed (intro audio) and the 3rd Canticle in auto mode.
- Still only 9 hymns. Validation on the ~50 Tasbeha-linked timed hymns is pending
  (media.tasbeha.org is blocked from this workspace).


Round 2:
- Notation lines (`<br>` in the Hazzat) start right after a breath: half of line starts are
  within 0.06 s of the end of a quiet stretch. Rewarding line-start words for sitting on a
  pause end (`pause_bonus`, gamma=3) stopped most of the drift.
- Exact notation repeats are rarer than expected (only ~40-60% of words in 3 hymns).
- Automatic hymn-end finding (`find_end`) helps recordings with trailing audio but breaks
  others; tempo (1.7-2.4 s per unit) is too variable to tell them apart. Use the editor's clip.
- Settings (sigma, alpha, gamma) were picked on these same 9 hymns, so expect slightly
  lower accuracy on new hymns.

Round 1:

- Learned per-glyph durations predict word length well (corr 0.85 vs 0.72 for character count).
- Within one hymn, identical notation words have consistent duration (CV 0.1–0.3) and
  pitch (~1 semitone). Glyphs do not predict pitch across different hymns.
- With true per-hymn melody templates the matcher reaches 36% within 1 s; learning those
  templates from its own alignment or from a hand-timed first verse has not worked yet.
- Automatic start/end detection fails when recordings have extra audio after the hymn.
- Measuring durations in "sung time" (ignoring pauses) made results worse as implemented.
