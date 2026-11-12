---
name: hymn-word-alignment
description: Re-time Mobile Moallem hymn word timings by forced-aligning the Coptic text to its recording (torchaudio MMS_FA), then hand back a list for the editor's "Paste timings" box or, only if asked, save it to STAGING. Use when the user asks to align, re-time, fix the timings of, or "do the alignment" for a hymn (Ten Theno, canticles, etc.), or wants a word-by-word playback check of timings.
---

# Hymn word alignment (Mobile Moallem)

Finds where each word really starts in a hymn recording by lining up the text against the audio
with a speech model, and compares it with the timings already saved.

## Ground rules (from the user — always follow)

- **Staging only.** Read and write only D1 `mobile-moallem-staging` and R2 `mobile-moallem-staging-media`.
  Never touch `mobile-moallem-production`, `main`, `production`, or the live site (mobilemoallem.com).
- **Default output is a list for the Paste timings box**, not a database write. The user pastes it in the
  editor (Edit hymn → Timing → under *Start aligning* → **Paste timings**).
- **Writing to staging D1 only if the user asks.** Show the SQL first and wait for "go". Back up first into
  `word_timing_backups(run_id, hymn_id, column_name, before_json, previous_updated_at, created_at)`.
  Keep `status` unchanged.
- **Code changes:** commit → push branch → then deploy to staging (show the command, wait for "go").
- Never print or store tokens. Explain each step in plain, simple words.

## Setup (once)

- App folder (has `wrangler.jsonc`): `~/Documents/Codex/2026-09-16/all-right-chatgpt-here-s-what/Mobile-Moallem/application`
- Wrangler 4.x with Node 24 (`wrangler login` must already be done).
- Python env with torch + torchaudio 2.5.1 and numpy. If `~/.cache/mm-align/venv` is missing:
  ```bash
  python3 -m venv ~/.cache/mm-align/venv && ~/.cache/mm-align/venv/bin/pip install numpy torch==2.5.1 torchaudio==2.5.1
  ```
  Set `TORCH_HOME=~/.cache/mm-align/torch` (the model is ~1.2 GB, downloaded on first run).
- `afconvert` (built into macOS) converts audio.

`SK=~/.claude/skills/hymn-word-alignment/scripts`, `PY=~/.cache/mm-align/venv/bin/python`, work in a scratch folder.

## Steps

1. **Find the hymn id(s)** — a hymn is one row per season:
   `python3 $SK/fetch-hymn.py --search "ten theno" --app-dir APP --wrangler WRANGLER`
2. **Fetch text, timings and recording** (read-only):
   `python3 $SK/fetch-hymn.py HYMN_ID WORK --name tt --app-dir APP --wrangler WRANGLER`
   → `WORK/tt.json`, `tt.wav`, `tt.audio`. Use `--section english` for English words.
3. **Align:** `$PY $SK/forced-align.py WORK/tt.json WORK/tt.wav WORK/tt-forced.json`
   - Skips audio before (first saved time − 4 s). If the hymn has no saved timings, or a long intro,
     pass `--start-at SECONDS` and/or `--first-word N`.
   - Each word gets `forced` (seconds), `end`, and `score` (0–1 confidence).
4. **Judge quality.** Good runs: most scores ≥ 0.3 and forced times close to saved ones.
   **Long, drawn-out hymns (e.g. 2nd/3rd Canticles) — preferred method:**
   `$PY $SK/forced-align-lines.py WORK/tt.json WORK/tt.wav WORK/tt-v2.json`
   (whole-hymn pass with a `<star>` before each line to soak up held notes/repeats, plus a per-line
   windowed pass; reports how many words both agree on — 77–83% on the 2nd/3rd, 98–99% on 1st/4th), then
   `python3 $SK/build-final.py WORK/tt-v2.json WORK/tt-final.json` → strictly increasing `timings`.
   For a hymn that is already good, apply only sure fixes: add `--only-agreed --min-change 0.3`.
   Check: share of times where loudness rises over the next 80 ms (new should beat saved; random ≈ 45–50%).
   Older fallback: `merge-sure-timings.py` keeps only sure words from a forced-align.py run.
5. **Let the user check it by ear:**
   `python3 $SK/karaoke-view.py WORK/tt.json WORK/tt-forced.json WORK/view.html --audio-src tt.audio --font-src coptic.ttf`
   and/or `timing-review.py` (old vs new table). Serve WORK with a small local server and open it in the
   browser pane (the page loads audio as a blob, so plain `python3 -m http.server` is fine). The Coptic
   font: `dist/client/` in the app folder (CS Avva Shenouda).
6. **Hand back the Paste-timings list** (one number per word, `null` = untimed):
   `python3 -c "import json,sys;print(json.dumps([w['forced'] for w in json.load(open(sys.argv[1]))['words']]))" WORK/tt-forced.json`
   Save it to a file in the work folder and tell the user the word count; it must match exactly.
   Tell them: open the hymn → Edit hymn → Paste timings → choose *Coptic words* → paste → Apply →
   check → *Complete for listeners*.
7. **Same hymn in several seasons:** if the text and recording are identical, the same list applies;
   otherwise fetch and align each one.

## Coptic text notes

Text uses the CS Avva Shenouda font encoding; `forced-align.py` romanises it (`LETTERS`,
`ABBREVIATIONS`, `WHOLE_WORDS`). If a new abbreviation (overline `=` marks) misaligns, add it there.
Words are split with whitespace, exactly as the site does, so index i = timing i.

## Known issues to mention, not fix silently

- The site highlights about 0.25 s late (timeupdate-driven), so words can look late even when timings are right.
- Server media lookup uses `LIMIT 1` on a shared recording key; a draft sharing a key can 404 the recording.
