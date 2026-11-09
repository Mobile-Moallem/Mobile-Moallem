#!/usr/bin/env python3
"""Side-by-side review page: saved timings vs forced alignment (vs onset snap).

Usage
  python3 scripts/timing-review.py INPUT.json FORCED.json OUT.html [--onset ONSET.json] [--audio-src FILE]

INPUT.json is the hymn export (text + saved timings), FORCED.json is the output
of forced-align.py, ONSET.json (optional) is aligned-timings.json from
word-timing-aligner.py. Output is a static HTML page; nothing is saved anywhere.
"""
from __future__ import annotations

import argparse
import html
import json

import numpy as np

AGREE = 0.15  # seconds: two methods "agree" when this close


def fmt(t):
    return "—" if t is None else f"{int(t // 60)}:{t % 60:05.2f}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("forced")
    ap.add_argument("out")
    ap.add_argument("--onset")
    ap.add_argument("--audio-src", default="recording.mp3")
    a = ap.parse_args()

    meta = json.load(open(a.input))
    forced = json.load(open(a.forced))["words"]
    onset = json.load(open(a.onset))["new_timings"] if a.onset else [None] * len(forced)

    both = [w for w in forced if w["old"] is not None and w["forced"] is not None]
    d = np.array([w["forced"] - w["old"] for w in both])
    agree_onset = [w for w in both if onset[w["index"]] is not None and abs(onset[w["index"]] - w["forced"]) <= AGREE]
    low = [w for w in both if w["score"] < 0.3]

    lines, idx = [], 0
    for line in meta["text"].split("\n"):
        n = len(line.split())
        lines.append(range(idx, idx + n))
        idx += n

    rows = []
    for ln, ids in enumerate(lines, 1):
        rows.append(f'<tr class="line"><td colspan="7">Line {ln}</td></tr>')
        for i in ids:
            w = forced[i]
            old, new, on = w["old"], w["forced"], onset[i]
            shift = None if old is None or new is None else new - old
            cls = []
            if shift is not None and abs(shift) >= 0.25:
                cls.append("big")
            if w["score"] is not None and w["score"] < 0.3:
                cls.append("low")
            btn = lambda t: "" if t is None else f'<button data-t="{t}">▶ {fmt(t)}</button>'
            agree = "" if on is None or new is None else ("✓" if abs(on - new) <= AGREE else "")
            conf = "" if w["score"] is None else f'<span class="meter"><i style="width:{w["score"] * 100:.0f}%"></i></span>{w["score"]:.2f}'
            rows.append(
                f'<tr class="{" ".join(cls)}"><td class="n">{i + 1}</td>'
                f'<td><span class="w">{html.escape(w["word"])}</span><span class="r">{html.escape(w["roman"])}</span></td>'
                f"<td>{btn(old)}</td><td>{btn(new)}</td>"
                f'<td class="d">{"" if shift is None else f"{shift:+.2f}s"}</td><td class="c">{conf}</td><td class="a">{agree}</td></tr>'
            )

    title = html.escape(meta.get("title", "Hymn"))
    page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Word Timing Review</title>
<style>
:root{{--bg:#fbfaf7;--fg:#1d1b18;--mute:#6b665e;--line:#e4e0d8;--card:#fff;--acc:#1f6feb;--warn:#b54708;--big:#fff4e5;--ok:#2f7d4f}}
@media (prefers-color-scheme:dark){{:root:not([data-theme="light"]){{--bg:#171614;--fg:#ece8e1;--mute:#a19b91;--line:#2f2c28;--card:#1f1d1a;--acc:#6ea8ff;--warn:#f0a35b;--big:#2d2416;--ok:#6fcf97}}}}
:root[data-theme="dark"]{{--bg:#171614;--fg:#ece8e1;--mute:#a19b91;--line:#2f2c28;--card:#1f1d1a;--acc:#6ea8ff;--warn:#f0a35b;--big:#2d2416;--ok:#6fcf97}}
body{{background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,sans-serif;margin:0;padding:24px 16px}}
main{{max-width:920px;margin:auto}} h1{{font-size:22px;margin:0 0 4px}} .sub{{color:var(--mute);margin:0 0 14px;max-width:70ch}}
.stats{{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px}}
.stat{{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;min-width:120px}}
.stat b{{display:block;font-size:20px;font-variant-numeric:tabular-nums}} .stat span{{color:var(--mute);font-size:13px}}
.bar{{position:sticky;top:0;background:var(--bg);padding:8px 0;z-index:2;display:flex;gap:10px;align-items:center;flex-wrap:wrap}}
audio{{width:100%;max-width:520px}} label{{color:var(--mute);font-size:13px}}
.wrap{{overflow-x:auto}} table{{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}}
th,td{{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);white-space:nowrap;vertical-align:middle}}
th{{color:var(--mute);font-weight:500;font-size:13px}} td.n{{color:var(--mute)}}
.w{{display:block}} .r{{display:block;color:var(--mute);font-size:12px}}
tr.line td{{color:var(--mute);font-size:12px;text-transform:uppercase;letter-spacing:.04em;padding-top:14px}}
td.d{{color:var(--acc);font-weight:600}} tr.big{{background:var(--big)}} tr.low td.c{{color:var(--warn)}} td.a{{color:var(--ok)}}
.meter{{display:inline-block;width:44px;height:6px;border-radius:3px;background:var(--line);margin-right:6px;vertical-align:middle;overflow:hidden}}
.meter i{{display:block;height:100%;background:currentColor;opacity:.7}}
button{{font:inherit;font-size:13px;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:6px;padding:2px 8px;cursor:pointer}}
button:hover{{border-color:var(--acc)}}
</style></head><body><main>
<h1>{title} — word timings</h1>
<p class="sub">Saved = staging timings. Forced = where a speech model hears each word start after lining up the whole text with the recording. Confidence is the model's certainty (low under 0.3). ✓ = an independent onset detector landed within {AGREE:.2f} s of the forced time. Nothing has been saved anywhere.</p>
<div class="stats">
<div class="stat"><b>{len(both)}</b><span>words compared</span></div>
<div class="stat"><b>{np.median(np.abs(d)):.2f} s</b><span>median |forced − saved|</span></div>
<div class="stat"><b>{np.median(d):+.2f} s</b><span>median signed shift</span></div>
<div class="stat"><b>{int((np.abs(d) >= .25).sum())}</b><span>off by ≥ 0.25 s</span></div>
<div class="stat"><b>{int((np.abs(d) >= 1).sum())}</b><span>off by ≥ 1 s</span></div>
<div class="stat"><b>{len(low)}</b><span>low confidence</span></div>
{"" if not a.onset else f'<div class="stat"><b>{len(agree_onset)}</b><span>onset agrees ✓</span></div>'}
</div>
<div class="bar"><audio id="a" controls preload="auto" src="{html.escape(a.audio_src)}"></audio>
<label><input type="checkbox" id="snip" checked> stop after 1.5 s</label></div>
<div class="wrap"><table><thead><tr><th>#</th><th>Word</th><th>Saved</th><th>Forced</th><th>Shift</th><th>Confidence</th><th>Onset</th></tr></thead>
<tbody>{"".join(rows)}</tbody></table></div></main>
<script>
const a=document.getElementById('a'),snip=document.getElementById('snip');let stop=null;
document.addEventListener('click',e=>{{const t=e.target.closest('button[data-t]');if(!t)return;
a.currentTime=Math.max(0,+t.dataset.t-0.1);a.play();clearTimeout(stop);if(snip.checked)stop=setTimeout(()=>a.pause(),1600);}});
</script></body></html>"""
    open(a.out, "w").write(page)
    print(f"{len(both)} words · median |shift| {np.median(np.abs(d)):.2f}s · ≥0.25s {int((np.abs(d) >= .25).sum())} · "
          f"≥1s {int((np.abs(d) >= 1).sum())} · low conf {len(low)} · onset agrees {len(agree_onset)}")


if __name__ == "__main__":
    main()
