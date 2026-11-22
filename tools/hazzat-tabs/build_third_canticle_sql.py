"""Build the SQL that gives the 3rd Canticle its three Hazzat tabs.

The three parts (Esmo Epchoise, Hos Erof, Arihoou Chasf) come from the hazzat.com
catalog bundled in application/dist/client/catalog/annual.json (checked byte-for-byte
against hazzat.com on 2026-11-21). Each part is wrapped in
<div class="hazzat-tab" data-title="..."> so the reader shows one tab per part.

Esmo Epchoise stays first and unchanged, so every existing Hazzat timing keeps
pointing at the same hit box; Hos Erof and Arihoou Chasf start untimed.
The Esmo Epchoise text is replaced in place, so marker comments around it
(e.g. <!-- hazzat-dot-split:v1 -->, <!-- hazzat-hit-boxes:v2 -->) are kept, and rows
already holding tabs, or without the unchanged Esmo text, are left alone.
A matching rollback statement is printed as a comment at the end.

    python3 tools/hazzat-tabs/build_third_canticle_sql.py > third-canticle-hazzat-tabs.sql
"""
import html, json, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
catalog = json.loads((ROOT / "application/dist/client/catalog/annual.json").read_text())
hymn = next(h for s in catalog for h in s["hymns"] if h["id"] == "3rd-canticle-annual")
parts = hymn["formats"]["2"]
assert [p["name"] for p in parts] == ["Esmo Epchoise", "Hos Erof", "Arihoou Chasf"], [p["name"] for p in parts]

old = parts[0]["content"]["copticHazzat"]
new = "".join(
    '<div class="hazzat-tab" data-title="%s">%s</div>' % (html.escape(p["name"], quote=True), p["content"]["copticHazzat"])
    for p in parts
)
q = lambda s: "'" + s.replace("'", "''") + "'"
ids = [
    "annual/midnight-psalmody-4/3rd-canticle-annual",
    "kiahk/midnight-psalmody-4/3rd-canticle-annual",
    "bright-saturday/praises-2/3rd-canticle-annual",
    "saint-marys-fastfeast/saint-mary-fastfeast-midnight-psalmody/3rd-canticle-annual",
]
print("-- 3rd Canticle: Hazzat in three tabs (Esmo Epchoise / Hos Erof / Arihoou Chasf)")
print("UPDATE hymn_projects SET notation_html = replace(notation_html, %s, %s)," % (q(old), q(new)))
print("  updated_at = CAST(strftime('%%s','now') AS INTEGER) * 1000")
print("WHERE hymn_id IN (%s)" % ", ".join(q(i) for i in ids))
print("  AND instr(notation_html, %s) > 0 AND instr(notation_html, 'hazzat-tab') = 0;" % q(old))
print()
print("-- ROLLBACK (run only to undo):")
print("-- UPDATE hymn_projects SET notation_html = replace(notation_html, %s, %s) WHERE hymn_id IN (%s);" % (q(new), q(old), ", ".join(q(i) for i in ids)))
