#!/usr/bin/env python3
"""Word-timing aligner (offline, read-only).

Takes a hymn's saved word timings and its recording, measures where each word
actually starts in the audio, and writes the old and new timings side by side.
It never writes to D1 or any live service: output is a JSON file and an HTML
report for review.

Words are split the same way the site does (`text.trim().split(/\\s+/)`), so
index i of the timings array is word i. Untimed words (null) stay null.

Method
  1. Decode the recording to 16 kHz mono WAV first (macOS: `afconvert -f WAVE
     -d LEI16@16000 -c 1 in.mp3 out.wav`; elsewhere: `ffmpeg -i in.mp3 -ac 1
     -ar 16000 out.wav`).
  2. Build an onset-strength curve at 10 ms resolution from log-spectral flux
     (new sound energy appearing, e.g. a consonant or a new vowel) plus the rise
     of the loudness envelope out of a dip (the breath or consonant gap before a
     word). Each part is normalised against its local surroundings so quiet and
     loud passages count the same.
  3. For every timed word, look for onset peaks within +/- WINDOW seconds of the
     saved time, but never before the previous word's new time or after the next
     word's saved time. Peaks are weighted by closeness to the saved time, so the
     saved timing acts as a prior and only moves when the audio clearly shows a
     word start nearby.
  4. If no peak is strong enough, the saved time is kept and the word is flagged.

Usage
  python3 scripts/word-timing-aligner.py INPUT.json RECORDING.wav OUT_DIR [--audio-src URL_OR_PATH]

INPUT.json: {"title", "hymn_id", "section", "text", "timings": [...]}
Requires numpy.
"""
from __future__ import annotations

import argparse
import html
import json
import re
import wave
from pathlib import Path

import numpy as np

RATE = 16000
HOP = 160            # 10 ms
NFFT = 1024
WINDOW = 0.6         # seconds searched either side of the saved time
PRIOR_SIGMA = 0.3    # how strongly the saved time pulls the choice
MIN_GAP = 0.12       # minimum spacing between consecutive word starts
MIN_STRENGTH = 1.0   # peak strength (local z-score) needed to move a word


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        if w.getframerate() != RATE or w.getsampwidth() != 2:
            raise SystemExit(f"Expected 16 kHz 16-bit WAV, got {w.getframerate()} Hz / {8 * w.getsampwidth()} bit")
        data = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768
        if w.getnchannels() > 1:
            data = data.reshape(-1, w.getnchannels()).mean(axis=1)
    return data


def local_normalise(x: np.ndarray, span: int) -> np.ndarray:
    """z-score of each frame against a moving window (mean / std).

    Mean/std rather than median/MAD: the loudness-rise signal is zero most of
    the time, which makes MAD collapse to ~0 and blow the scores up.
    """
    pad = span // 2
    padded = np.pad(x, pad, mode="reflect")
    windows = np.lib.stride_tricks.sliding_window_view(padded, span)[: len(x)]
    mean = windows.mean(axis=1)
    std = windows.std(axis=1)
    return (x - mean) / np.maximum(std, 1e-3 * (x.std() + 1e-9))


def onset_strength(pcm: np.ndarray) -> np.ndarray:
    n = 1 + (len(pcm) - NFFT) // HOP
    frames = np.lib.stride_tricks.as_strided(
        pcm, shape=(n, NFFT), strides=(pcm.strides[0] * HOP, pcm.strides[0])
    )
    spec = np.abs(np.fft.rfft(frames * np.hanning(NFFT), axis=1))
    freqs = np.fft.rfftfreq(NFFT, 1 / RATE)
    band = (freqs >= 80) & (freqs <= 5000)          # voice range
    logspec = np.log1p(100 * spec[:, band])

    flux = np.maximum(0, np.diff(logspec, axis=0, prepend=logspec[:1])).sum(axis=1)
    loud = np.log(1e-5 + (spec[:, band] ** 2).sum(axis=1))
    loud = np.convolve(loud, np.ones(5) / 5, mode="same")
    # rise out of a dip: how much louder now than the quietest point in the last 150 ms
    look = 15
    past_min = np.array([loud[max(0, i - look): i + 1].min() for i in range(len(loud))])
    rise = np.maximum(0, loud - past_min)
    rise = np.maximum(0, np.diff(rise, prepend=rise[:1]))

    span = 151  # 1.5 s context
    strength = 0.65 * local_normalise(flux, span) + 0.35 * local_normalise(rise, span)
    return np.convolve(strength, np.hanning(5) / np.hanning(5).sum(), mode="same")


def peaks_in(strength: np.ndarray, lo: int, hi: int) -> list[int]:
    lo, hi = max(lo, 1), min(hi, len(strength) - 2)
    return [i for i in range(lo, hi + 1) if strength[i] >= strength[i - 1] and strength[i] > strength[i + 1]]


def align(timings: list, strength: np.ndarray) -> list[dict]:
    fps = RATE / HOP
    out, prev_new = [], -1.0
    for i, old in enumerate(timings):
        if old is None:
            out.append({"old": None, "new": None, "status": "untimed", "strength": None})
            continue
        nxt = next((t for t in timings[i + 1:] if t is not None), None)
        lo_t = max(old - WINDOW, prev_new + MIN_GAP)
        hi_t = old + WINDOW if nxt is None else min(old + WINDOW, nxt - MIN_GAP)
        best, best_score = None, -np.inf
        for p in peaks_in(strength, int(lo_t * fps), int(hi_t * fps)):
            t = p / fps
            score = strength[p] * np.exp(-((t - old) ** 2) / (2 * PRIOR_SIGMA ** 2))
            if strength[p] >= MIN_STRENGTH and score > best_score:
                best, best_score = p, score
        if best is None:
            new, status, s = max(old, prev_new + MIN_GAP), "kept", None
        else:
            new, s = round(best / fps, 2), round(float(strength[best]), 2)
            status = "moved" if abs(new - old) >= 0.05 else "confirmed"
        prev_new = new
        out.append({"old": old, "new": round(new, 2), "status": status, "strength": s})
    return out


def report_html(meta: dict, words: list[str], rows: list[dict], audio_src: str) -> str:
    def fmt(t):
        return "—" if t is None else f"{int(t // 60)}:{t % 60:05.2f}"

    lines, idx = [], 0
    for line in meta["text"].split("\n"):
        n = len(line.split())
        lines.append(list(range(idx, idx + n)))
        idx += n

    timed = [r for r in rows if r["old"] is not None]
    deltas = np.array([r["new"] - r["old"] for r in timed])
    moved = [r for r in timed if r["status"] == "moved"]
    kept = [r for r in timed if r["status"] == "kept"]
    big = int((np.abs(deltas) >= 0.25).sum())

    body = []
    for n, ids in enumerate(lines, 1):
        if not ids:
            continue
        body.append(f'<tr class="line"><td colspan="6">Line {n}</td></tr>')
        for i in ids:
            r = rows[i]
            d = None if r["old"] is None else r["new"] - r["old"]
            cls = r["status"] + (" big" if d is not None and abs(d) >= 0.25 else "")
            play_old = "" if r["old"] is None else f'<button data-t="{r["old"]}">▶ {fmt(r["old"])}</button>'
            play_new = "" if r["new"] is None else f'<button data-t="{r["new"]}">▶ {fmt(r["new"])}</button>'
            delta = "" if d is None else f"{d:+.2f}s"
            body.append(
                f'<tr class="{cls}"><td class="n">{i + 1}</td><td class="w">{html.escape(words[i])}</td>'
                f"<td>{play_old}</td><td>{play_new}</td><td class=\"d\">{delta}</td><td>{r['status']}</td></tr>"
            )

    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Word Timing Review</title>
<style>
:root{{--bg:#fbfaf7;--fg:#1d1b18;--mute:#6b665e;--line:#e4e0d8;--card:#fff;--moved:#1f6feb;--kept:#b54708;--big:#fff4e5;--ok:#2f7d4f}}
@media (prefers-color-scheme:dark){{:root:not([data-theme="light"]){{--bg:#171614;--fg:#ece8e1;--mute:#a19b91;--line:#2f2c28;--card:#1f1d1a;--moved:#6ea8ff;--kept:#f0a35b;--big:#2d2416;--ok:#6fcf97}}}}
:root[data-theme="dark"]{{--bg:#171614;--fg:#ece8e1;--mute:#a19b91;--line:#2f2c28;--card:#1f1d1a;--moved:#6ea8ff;--kept:#f0a35b;--big:#2d2416;--ok:#6fcf97}}
body{{background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,sans-serif;margin:0;padding:24px 16px}}
main{{max-width:880px;margin:auto}} h1{{font-size:22px;margin:0 0 4px}} .sub{{color:var(--mute);margin:0 0 18px}}
.stats{{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px}}
.stat{{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;min-width:120px}}
.stat b{{display:block;font-size:20px;font-variant-numeric:tabular-nums}} .stat span{{color:var(--mute);font-size:13px}}
.bar{{position:sticky;top:0;background:var(--bg);padding:8px 0;z-index:2;display:flex;gap:10px;align-items:center;flex-wrap:wrap}}
audio{{width:100%;max-width:520px}} label{{color:var(--mute);font-size:13px}}
.wrap{{overflow-x:auto}} table{{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}}
th,td{{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);white-space:nowrap}}
th{{color:var(--mute);font-weight:500;font-size:13px}} td.n{{color:var(--mute)}} td.w{{font-family:"CS Avva Shenouda",ui-serif,serif}}
tr.line td{{color:var(--mute);font-size:12px;text-transform:uppercase;letter-spacing:.04em;padding-top:14px}}
tr.moved td.d{{color:var(--moved);font-weight:600}} tr.kept td:last-child{{color:var(--kept)}} tr.confirmed td:last-child{{color:var(--ok)}}
tr.big{{background:var(--big)}} tr.untimed{{color:var(--mute)}}
button{{font:inherit;font-size:13px;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:6px;padding:2px 8px;cursor:pointer}}
button:hover{{border-color:var(--moved)}}
</style></head><body><main>
<h1>{html.escape(meta.get("title", "Hymn"))} — word timings</h1>
<p class="sub">{html.escape(meta.get("section", ""))} section · staging data · nothing has been saved anywhere. Press ▶ to hear the word from that time.</p>
<p class="sub">First pass: "new" is the strongest sound onset near the saved time. In melismatic chant a note change mid-word also counts as an onset, so check moved words by ear before trusting them.</p>
<div class="stats">
<div class="stat"><b>{len(timed)}</b><span>timed words</span></div>
<div class="stat"><b>{len(moved)}</b><span>moved ≥ 0.05 s</span></div>
<div class="stat"><b>{big}</b><span>moved ≥ 0.25 s</span></div>
<div class="stat"><b>{np.median(np.abs(deltas)):.2f} s</b><span>median shift</span></div>
<div class="stat"><b>{len(kept)}</b><span>kept (no clear onset)</span></div>
<div class="stat"><b>{len(rows) - len(timed)}</b><span>untimed in staging</span></div>
</div>
<div class="bar"><audio id="a" controls preload="auto" src="{html.escape(audio_src)}"></audio>
<label><input type="checkbox" id="snip" checked> stop after 1.5 s</label></div>
<div class="wrap"><table><thead><tr><th>#</th><th>Word</th><th>Old</th><th>New</th><th>Shift</th><th>Result</th></tr></thead>
<tbody>{"".join(body)}</tbody></table></div>
</main><script>
const a=document.getElementById('a'),snip=document.getElementById('snip');let stop=null;
document.addEventListener('click',e=>{{const t=e.target.closest('button[data-t]');if(!t)return;
a.currentTime=Math.max(0,+t.dataset.t-0.15);a.play();clearTimeout(stop);if(snip.checked)stop=setTimeout(()=>a.pause(),1650);}});
</script></body></html>"""


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input")
    ap.add_argument("wav")
    ap.add_argument("out_dir")
    ap.add_argument("--audio-src", help="audio path/URL used by the HTML report's player (default: the WAV)")
    args = ap.parse_args()

    meta = json.loads(Path(args.input).read_text())
    words = re.split(r"\s+", meta["text"].strip())
    timings = meta["timings"]
    if len(words) != len(timings):
        raise SystemExit(f"{len(words)} words but {len(timings)} timings — refusing to guess the mapping")

    strength = onset_strength(read_wav(Path(args.wav)))
    rows = align(timings, strength)

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out / "aligned-timings.json").write_text(json.dumps({
        "hymn_id": meta.get("hymn_id"), "section": meta.get("section"),
        "old_timings": timings, "new_timings": [r["new"] for r in rows],
        "words": [{"index": i, "word": w, **r} for i, (w, r) in enumerate(zip(words, rows))],
    }, ensure_ascii=False, indent=1))
    (out / "timing-review.html").write_text(report_html(meta, words, rows, args.audio_src or Path(args.wav).name))

    timed = [r for r in rows if r["old"] is not None]
    moved = sum(r["status"] == "moved" for r in timed)
    kept = sum(r["status"] == "kept" for r in timed)
    print(f"{len(timed)} timed words: {moved} moved, {len(timed) - moved - kept} confirmed, {kept} kept")
    print(f"Wrote {out / 'aligned-timings.json'} and {out / 'timing-review.html'}")


if __name__ == "__main__":
    main()
