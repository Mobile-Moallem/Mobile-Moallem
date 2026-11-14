#!/usr/bin/env python3
"""Word-by-word playback page: saved timings vs fixed (forced-aligned) timings.

Plays the recording and lights up each word as it is sung, using either the
saved staging timings, the fixed timings, or both side by side.

Usage
  python3 scripts/karaoke-view.py INPUT.json FORCED.json OUT.html [--audio-src FILE] [--font-src FILE]
"""
from __future__ import annotations

import argparse
import html
import json


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("forced")
    ap.add_argument("out")
    ap.add_argument("--audio-src", default="recording.mp3")
    ap.add_argument("--font-src", default="coptic.ttf")
    a = ap.parse_args()

    meta = json.load(open(a.input))
    words = json.load(open(a.forced))["words"]
    lines, idx = [], 0
    for line in meta["text"].split("\n"):
        n = len(line.split())
        lines.append(list(range(idx, idx + n)))
        idx += n
    data = {
        "lines": lines,
        "words": [{"w": w["word"], "r": w["roman"], "saved": w["old"], "fixed": w["forced"]} for w in words],
    }
    title = html.escape(meta.get("title", "Hymn"))

    page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Timing Playback</title>
<style>
@font-face{{font-family:"Coptic Hazzat";src:url("{html.escape(a.font_src)}") format("truetype");font-display:swap}}
:root{{--bg:#f7f4ee;--fg:#1d1b18;--mute:#8a847a;--line:#e2ddd3;--card:#fffdf9;--hl:#f2c14e;--hlfg:#1d1b18;--fixed:#1f6feb;--saved:#9a6b2f;--moved:#1f6feb}}
@media (prefers-color-scheme:dark){{:root:not([data-theme="light"]){{--bg:#151412;--fg:#ece8e1;--mute:#8d877d;--line:#2e2b27;--card:#1d1b18;--hl:#e0ad3a;--hlfg:#151412;--fixed:#6ea8ff;--saved:#d1a26a;--moved:#6ea8ff}}}}
:root[data-theme="dark"]{{--bg:#151412;--fg:#ece8e1;--mute:#8d877d;--line:#2e2b27;--card:#1d1b18;--hl:#e0ad3a;--hlfg:#151412;--fixed:#6ea8ff;--saved:#d1a26a;--moved:#6ea8ff}}
*{{box-sizing:border-box}}
body{{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,sans-serif;margin:0}}
header{{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line);padding:14px 16px 12px}}
.top{{max-width:1100px;margin:auto;display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center}}
h1{{font-size:17px;margin:0;flex:1 1 260px}}
audio{{width:100%;max-width:1100px;display:block;margin:10px auto 0}}
.seg{{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--card)}}
.seg button{{font:inherit;font-size:13px;border:0;background:none;color:var(--fg);padding:6px 12px;cursor:pointer}}
.seg button[aria-pressed=true]{{background:var(--fg);color:var(--bg)}}
label{{font-size:13px;color:var(--mute);display:inline-flex;gap:6px;align-items:center}}
main{{max-width:1100px;margin:auto;padding:18px 16px 60vh;display:grid;gap:24px;grid-template-columns:1fr}}
main.both{{grid-template-columns:1fr 1fr}}
@media (max-width:760px){{main.both{{grid-template-columns:1fr}}}}
.col{{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px}}
.col h2{{font-size:12px;letter-spacing:.06em;text-transform:uppercase;margin:0 0 10px;display:flex;justify-content:space-between}}
.col.fixed h2{{color:var(--fixed)}} .col.saved h2{{color:var(--saved)}}
.col h2 span{{color:var(--mute);font-weight:400;text-transform:none;letter-spacing:0}}
.ln{{margin:0 0 14px;line-height:2.1}}
.wd{{font-family:"Coptic Hazzat",serif;font-size:22px;padding:1px 4px;border-radius:5px;cursor:pointer;transition:background .08s,color .08s;position:relative}}
.wd.untimed{{color:var(--mute);cursor:default}}
.wd.past{{opacity:.55}}
.wd.now{{background:var(--hl);color:var(--hlfg);opacity:1}}
.wd.moved::after{{content:"";position:absolute;left:30%;right:30%;bottom:-2px;height:2px;border-radius:1px;background:var(--moved);opacity:.7}}
.wd.now.moved::after{{background:var(--hlfg)}}
.roman .wd{{font-family:system-ui,-apple-system,sans-serif;font-size:16px}}
.legend{{font-size:12px;color:var(--mute);max-width:1100px;margin:8px auto 0;display:flex;flex-wrap:wrap;gap:4px 16px}}
.legend i{{display:inline-block;width:14px;height:2px;background:var(--moved);vertical-align:middle;margin-right:4px}}
.legend b{{display:inline-block;width:14px;height:12px;border-radius:3px;background:var(--hl);vertical-align:middle;margin-right:4px}}
</style></head><body>
<header><div class="top">
<h1>{title}</h1>
<div class="seg" role="group" aria-label="Timings">
<button data-mode="fixed" aria-pressed="true">Fixed</button><button data-mode="saved" aria-pressed="false">Saved</button><button data-mode="both" aria-pressed="false">Side by side</button>
</div>
<label><input type="checkbox" id="roman"> Pronunciation</label>
<label><input type="checkbox" id="follow" checked> Follow along</label>
</div>
<audio id="a" controls preload="auto" src="{html.escape(a.audio_src)}"></audio>
<div class="legend"><span><b></b>word being sung</span><span><i></i>fixed time differs from saved by ≥ 0.25 s</span><span>Click any word to jump there.</span></div>
</header>
<main id="m"></main>
<script>
const D={json.dumps(data, ensure_ascii=False)};
const a=document.getElementById('a'),m=document.getElementById('m');
// Load the whole file into memory so seeking works even on servers without range requests.
fetch(a.getAttribute('src')).then(r=>r.ok?r.blob():null).then(b=>{{if(b)a.src=URL.createObjectURL(b);}}).catch(()=>{{}});
const cols={{}};
function build(kind,label,note){{
  const col=document.createElement('section');col.className='col '+kind;
  col.innerHTML='<h2>'+label+'<span>'+note+'</span></h2>';
  const els=[];
  for(const ids of D.lines){{
    const p=document.createElement('p');p.className='ln';
    for(const i of ids){{
      const w=D.words[i],t=w[kind],s=document.createElement('span');
      s.className='wd'+(t==null?' untimed':'');s.dataset.w=w.w;s.dataset.r=w.r;s.textContent=w.w;
      if(kind==='fixed'&&t!=null&&w.saved!=null&&Math.abs(t-w.saved)>=.25)s.classList.add('moved');
      if(t!=null)s.onclick=()=>{{a.currentTime=Math.max(0,t-.05);a.play();}};
      els.push([t,s]);p.appendChild(s);p.appendChild(document.createTextNode(' '));
    }}
    col.appendChild(p);
  }}
  const timed=els.filter(e=>e[0]!=null).sort((x,y)=>x[0]-y[0]);
  cols[kind]={{col,timed,cur:-1}};m.appendChild(col);
}}
build('fixed','Fixed timings','forced alignment');
build('saved','Saved timings','staging');
function setMode(mode){{
  document.querySelectorAll('.seg button').forEach(b=>b.setAttribute('aria-pressed',b.dataset.mode===mode));
  cols.fixed.col.hidden=mode==='saved';cols.saved.col.hidden=mode==='fixed';
  m.classList.toggle('both',mode==='both');
  try{{localStorage.setItem('kv-mode',mode)}}catch(e){{}}
}}
document.querySelectorAll('.seg button').forEach(b=>b.onclick=()=>setMode(b.dataset.mode));
let saved='fixed';try{{saved=localStorage.getItem('kv-mode')||'fixed'}}catch(e){{}}setMode(saved);
document.getElementById('roman').onchange=e=>{{
  document.body.classList.toggle('roman',e.target.checked);
  document.querySelectorAll('.wd').forEach(s=>s.textContent=e.target.checked?s.dataset.r:s.dataset.w);
}};
const follow=document.getElementById('follow');
function tick(){{
  const t=a.currentTime;
  for(const k in cols){{
    const c=cols[k];let lo=-1,hi=c.timed.length-1;
    while(lo<hi){{const mid=(lo+hi+1)>>1;if(c.timed[mid][0]<=t)lo=mid;else hi=mid-1;}}
    if(lo!==c.cur){{
      c.timed.forEach(([,s],j)=>{{s.classList.toggle('past',j<lo);s.classList.toggle('now',j===lo);}});
      c.cur=lo;
      if(follow.checked&&!c.col.hidden&&lo>=0&&(k==='fixed'||cols.fixed.col.hidden)){{
        const r=c.timed[lo][1].getBoundingClientRect();
        if(r.top<160||r.bottom>innerHeight-80)c.timed[lo][1].scrollIntoView({{block:'center',behavior:'smooth'}});
      }}
    }}
  }}
  requestAnimationFrame(tick);
}}
requestAnimationFrame(tick);
</script></body></html>"""
    open(a.out, "w").write(page)
    print("wrote", a.out)


if __name__ == "__main__":
    main()
