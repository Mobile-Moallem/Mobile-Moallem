#!/usr/bin/env python3
"""Fetch one hymn's Coptic text, saved word timings and recording from STAGING (read-only).

Writes OUT_DIR/<name>.json  ({hymn_id, title, recording_url, recording_key, text, timings})
and   OUT_DIR/<name>.wav    (16 kHz mono 16-bit, what forced-align.py needs)
       OUT_DIR/<name>.audio  (the original recording, for the playback page)

Only ever reads the `mobile-moallem-staging` D1 database and `mobile-moallem-staging-media` R2
bucket. It never writes anything.

Usage
  python3 fetch-hymn.py HYMN_ID OUT_DIR [--name NAME] [--section coptic|english]
      --app-dir  path to Mobile-Moallem/application (has wrangler.jsonc)
      --wrangler path to the wrangler binary (default: `wrangler` on PATH)
  python3 fetch-hymn.py --search "ten theno" --app-dir ...   # list matching hymn ids
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import subprocess
import sys
import urllib.parse

DB = "mobile-moallem-staging"
BUCKET = "mobile-moallem-staging-media"
SITE = "https://staging.mobilemoallem.com"


def d1(sql: str, a) -> list[dict]:
    cmd = [a.wrangler, "d1", "execute", DB, "--remote", "--json", "--env=", "--command", sql]
    res = subprocess.run(cmd, cwd=a.app_dir, capture_output=True, text=True)
    if res.returncode != 0:
        sys.exit("wrangler d1 failed:\n" + res.stderr[-2000:])
    return json.loads(res.stdout)[0]["results"]


def catalog_text(hymn_id: str, section: str) -> str:
    """Text from staging's catalog/<season>.json, decoded like site.js decodeCatalogText()."""
    season, service_id, slug = hymn_id.split("/", 2)
    res = subprocess.run(["curl", "-sSfL", f"{SITE}/catalog/{urllib.parse.quote(season)}.json"],
                         capture_output=True, text=True, check=True)
    for service in json.loads(res.stdout):
        if service.get("id") != service_id:
            continue
        for h in service.get("hymns", []):
            if h.get("id") != slug:
                continue
            variation = ((h.get("formats") or {}).get("1") or [{}])[0]
            out = []
            for p in (variation.get("content") or {}).get("paragraphs", []):
                col = next((c for c in p.get("columns", []) if (c.get("language") or "").lower() == section), None)
                raw = re.sub(r"<br\s*/?\s*>", " ", (col or {}).get("content") or "", flags=re.I)
                out.append(html.unescape(raw).strip())
            return "\n".join(out).strip()
    return ""


def q(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("hymn_id", nargs="?")
    ap.add_argument("out_dir", nargs="?")
    ap.add_argument("--name")
    ap.add_argument("--section", choices=["coptic", "english"], default="coptic")
    ap.add_argument("--search")
    ap.add_argument("--app-dir", required=True)
    ap.add_argument("--wrangler", default="wrangler")
    a = ap.parse_args()

    if a.search:
        like = q("%" + a.search + "%")
        for r in d1(f"SELECT hymn_id, season, status, title FROM hymn_projects WHERE title LIKE {like} OR hymn_id LIKE {like} ORDER BY hymn_id", a):
            print(f"{r['hymn_id']}\t{r['season']}\t{r['status']}\t{r['title']}")
        return
    if not (a.hymn_id and a.out_dir):
        ap.error("need HYMN_ID and OUT_DIR (or --search)")

    if a.section == "coptic":
        cols = "coptic_text AS text, coptic_timings_json AS timings, coptic_recording_url AS url, coptic_recording_key AS rkey"
    else:
        cols = "text_content AS text, timings_json AS timings, recording_url AS url, recording_key AS rkey"
    rows = d1(f"SELECT hymn_id, title, status, {cols} FROM hymn_projects WHERE hymn_id = {q(a.hymn_id)}", a)
    if not rows:
        sys.exit(f"no hymn {a.hymn_id!r} on staging")
    r = rows[0]
    text = (r["text"] or "").strip()
    if not text:
        # No editor override: the site shows the catalog text (same as site.js catalogText()).
        text = catalog_text(a.hymn_id, a.section)
        if not text:
            sys.exit("could not find this hymn's text in the database or the staging catalog")
    timings = json.loads(r["timings"] or "[]")
    words = re.split(r"\s+", text) if text else []
    if len(words) != len(timings):
        print(f"warning: {len(words)} words but {len(timings)} saved timings; padding with null", file=sys.stderr)
        timings = (timings + [None] * len(words))[: len(words)]

    os.makedirs(a.out_dir, exist_ok=True)
    name = a.name or a.hymn_id.rsplit("/", 1)[-1]
    base = os.path.join(a.out_dir, name)
    raw = base + ".audio"
    key, url = r["rkey"], r["url"]
    if key:
        res = subprocess.run([a.wrangler, "r2", "object", "get", f"{BUCKET}/{key}", "--remote", "--file", raw],
                             cwd=a.app_dir, capture_output=True, text=True)
        if res.returncode != 0:
            sys.exit("wrangler r2 get failed:\n" + res.stderr[-2000:])
    elif url:
        full = url if url.startswith("http") else urllib.parse.urljoin(SITE, url)
        subprocess.run(["curl", "-sSfL", "-o", raw, full], check=True)
    else:
        sys.exit("this hymn has no recording for that section")

    subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", raw, base + ".wav"], check=True)
    json.dump({"hymn_id": r["hymn_id"], "title": r["title"], "status": r["status"], "recording_url": url,
               "recording_key": key, "text": text, "timings": timings},
              open(base + ".json", "w"), ensure_ascii=False, indent=1)
    timed = sum(t is not None for t in timings)
    print(f"{r['hymn_id']}: {len(words)} words, {timed} timed, status {r['status']}; wrote {base}.json/.wav/.audio")


if __name__ == "__main__":
    main()
