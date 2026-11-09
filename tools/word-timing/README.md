# Word-timing tools (offline, not part of the website)

Scripts used on 2026-11-08/09 to re-time hymns on **staging** and to produce lists for the
editor's **Paste timings** box. Nothing here is deployed; they run on a laptop with
Python 3 + numpy + torch/torchaudio 2.5.1 (MMS_FA forced-alignment model).

- `forced-align.py` – forced alignment of the Coptic text to the recording (main method).
- `merge-sure-timings.py` – keep only confident forced times, keep the old time elsewhere.
- `word-timing-aligner.py` – first attempt (loudness-onset method); kept for reference.
- `timing-review.py` – old vs new timings side by side (HTML report).
- `karaoke-view.py` – word-by-word playback page for checking timings by ear.
