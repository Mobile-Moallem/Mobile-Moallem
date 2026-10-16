"""Build an evaluation set: hymns with hand-timed Hazzat whose recording is in live-backup.

For each unique recording, emits data/<name>.json with:
  tokens   - Hazzat hit tokens in score order (same tokenizing as site.js)
  times    - hand timings per token (None where unknown)
  sung     - the full sung order including repeat passes: [{index, time}]
  audio    - path to decoded 22.05 kHz mono float32 PCM
"""
import json, os, re, subprocess, html
from html.parser import HTMLParser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKUP = os.path.join(ROOT, 'live-backup')
CATALOG = os.path.join(ROOT, 'application/dist/client/catalog')
OUT = os.path.join(ROOT, 'alignment-lab/data')
RATE = 22050


class HazzatText(HTMLParser):
    """Collect text of HazzatFont/HazzatVFont spans in document order."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack, self.chunks = [], []
    # Each outermost Hazzat element is one chunk, like element.textContent in site.js.
    def handle_starttag(self, tag, attrs):
        if tag == 'br':
            return
        cls = (dict(attrs).get('class') or '').split()
        hz = 'HazzatFont' in cls or 'HazzatVFont' in cls
        if hz and not any(self.stack):
            self.chunks.append([0, ''])
        self.stack.append(hz)
    def handle_startendtag(self, tag, attrs):
        pass
    def handle_endtag(self, tag):
        if tag != 'br' and self.stack:
            self.stack.pop()
    def handle_data(self, data):
        if any(self.stack):
            self.chunks[-1][1] += data


def hit_tokens(text):
    out = []
    for part in re.split(r'(\s+)', text):
        out += re.split(r'(?<=\.)(?=[^\s).])', part)
    return [t for t in out if t and not t.isspace()]


def tokens_for(notation):
    p = HazzatText(); p.feed(notation)
    toks = []
    for _, text in p.chunks:
        toks += hit_tokens(text)
    return toks


def words_for(notation):
    p = HazzatText(); p.feed(notation)
    return [w for _, text in p.chunks for w in text.split()]


def catalog_notation(hymn_id):
    season, _service, slug = hymn_id.split('/', 2)
    path = os.path.join(CATALOG, season + '.json')
    if not os.path.exists(path):
        return ''
    for section in json.load(open(path)):
        for h in section.get('hymns', []):
            if h['id'] == slug:
                v = (h.get('formats', {}).get('2') or h.get('formats', {}).get('3') or [None])[0]
                c = (v or {}).get('content', {})
                return c.get('copticHazzat') or c.get('englishHazzat') or ''
    return ''


def main():
    os.makedirs(OUT, exist_ok=True)
    projects = json.load(open(os.path.join(BACKUP, 'tables/hymn_projects.json')))
    repeats = {r['hymn_id']: json.loads(r['sections_json'] or '[]')
               for r in json.load(open(os.path.join(BACKUP, 'tables/hymn_repeat_sections.json')))}
    clips = {(c['hymn_id'], c['section']): c for c in json.load(open(os.path.join(BACKUP, 'tables/hymn_recording_clips.json')))}
    local = os.path.join(BACKUP, 'media/recordings')
    seen = {}
    for p in projects:
        times = json.loads(p['hazzat_timings_json'] or '[]')
        key = (p['recording_key'] or '').split('/')[-1]
        if not times or not key or not os.path.exists(os.path.join(local, key)):
            continue
        timed = sum(t is not None for t in times)
        if key in seen and seen[key][0] >= timed:
            continue
        seen[key] = (timed, p)
    summary = []
    for key, (timed, p) in seen.items():
        hid = p['hymn_id']
        notation = p['notation_html'] or catalog_notation(hid)
        # Stored timings still use the pre-v2 format: one slot per whitespace word.
        # site.js splits these into hit boxes on load (migrateHazzatHitBoxes).
        words = words_for(notation)
        toks = words
        times = json.loads(p['hazzat_timings_json'])
        name = hid.split('/')[-1][:40]
        if len(toks) != len(times):
            summary.append((name, 'SKIP token mismatch', len(toks), len(times)))
            continue
        if timed < 0.6 * len(times):
            summary.append((name, 'SKIP mostly untimed', timed, len(times)))
            continue
        sung = [{'index': i, 'time': t} for i, t in enumerate(times)]
        for sec in repeats.get(hid, []):
            if sec.get('key') != 'hazzatTimings':
                continue
            for pass_ in sec['passes']:
                for off, t in enumerate(pass_):
                    sung.append({'index': sec['startIndex'] + off, 'time': t, 'repeat': True})
        timed_sung = sorted([s for s in sung if s['time'] is not None], key=lambda s: s['time'])
        # Reconstruct performance order: sort by time; untimed slots stay out of scoring.
        pcm = os.path.join(OUT, name + '.f32')
        if not os.path.exists(pcm):
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', os.path.join(local, key), '-ac', '1', '-ar', str(RATE), '-f', 'f32le', pcm], check=True)
        dur = os.path.getsize(pcm) / 4 / RATE
        clip = clips.get((hid, 'hazzat'))
        rec = {'hymn_id': hid, 'tokens': toks, 'times': times, 'sung': sung, 'performance': timed_sung,
               'audio': os.path.basename(pcm), 'rate': RATE, 'duration': dur,
               'clip': [clip['clip_start'], clip['clip_end']] if clip else None}
        json.dump(rec, open(os.path.join(OUT, name + '.json'), 'w'), ensure_ascii=False)
        summary.append((name, 'OK', len(toks), timed, sum(1 for s in sung if s.get('repeat')), round(dur)))
    for s in summary:
        print(*s)


if __name__ == '__main__':
    main()
