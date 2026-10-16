"""Score the Hazzat reader on the sung performance, including repeated sections.

Repeated sections (hymn_repeat_sections) are sung again right after their first pass; the
editor saved a time for each pass. The reader aligns the expanded sequence (notation in the
order it is sung) and is scored on every timed entry. Timings are treated as good but not
perfect: besides accuracy, large disagreements are listed for a look at the audio.

Usage: python3 eval_perf.py [auto|anchored] [hymn-name-substring ...]
"""
import glob, json, os, sys
import numpy as np
from align import breath_fit, follow_along, hit_pieces, sung_order, HazzatKey, align_pieces, find_end_pieces, find_start_pieces, singing_span, HOP
from features import features as compute_features

HERE = os.path.dirname(os.path.abspath(__file__))
mode = sys.argv[1] if len(sys.argv) > 1 else 'auto'
only = sys.argv[2:]
KW = dict(sigma=0.45, alpha=0.3, gamma=1.0, breath='key', learn_hymn=3, passes=int(os.environ.get('PASSES', 2)), section_tempo=bool(os.environ.get('TEMPO')))


SECTIONS = {r['hymn_id']: json.loads(r['sections_json'] or '[]')
            for r in json.load(open(os.path.join(HERE, '../live-backup/tables/hymn_repeat_sections.json')))}


def performance(d):
    """(word index, hand time) in sung order. The order comes from the Hazzat's own repeat
    marks; times for repeat passes come from the editor's saved repeat sections."""
    passes = {}
    for sec in SECTIONS.get(d['hymn_id'], []):
        if sec.get('key') != 'hazzatTimings':
            continue
        for k, p in enumerate(sec['passes'], start=1):
            for off, t in enumerate(p):
                passes[(sec['startIndex'] + off, k)] = t
    return [(i, d['times'][i] if k == 0 else passes.get((i, k))) for i, k in sung_order(d['tokens'])]


def features_for(d):
    cache = os.path.join(HERE, 'data', d['audio'].replace('.f32', '.feat.npz'))
    if os.path.exists(cache):
        z = np.load(cache)
        return {k: z[k] for k in z.files}
    pcm = np.fromfile(os.path.join(HERE, 'data', d['audio']), dtype=np.float32)
    F = compute_features(pcm, d['rate'])
    np.savez(cache, **{k: v for k, v in F.items() if k != 'hop'})
    return {k: v for k, v in F.items() if k != 'hop'}


rows = []
model = HazzatKey()
for f in sorted(glob.glob(os.path.join(HERE, 'data/*.json'))):
    d = json.load(open(f)); name = os.path.basename(f)[:-5]
    if only and not any(o in name for o in only):
        continue
    F = features_for(d)
    seq = performance(d)
    toks = [d['tokens'][i] for i, _ in seq]
    ls = [bool(d['line_start'][i]) or (k > 0 and seq[k - 1][0] != i - 1) for k, (i, _) in enumerate(seq)]  # a repeat restarts a phrase
    truth = [t for _, t in seq]
    timed = [t for t in truth if t is not None]
    if mode == 'anchored':
        start = timed[0]; end = timed[-1] + float(np.median(np.diff(sorted(timed)))) * 1.5
    else:
        s0, _ = singing_span(F)
        start = max(d['clip'][0] if d['clip'] else 0, s0 * HOP)
        end = find_end_pieces(toks, ls, F, model, start, sigma=0.45, alpha=0.3)
        if d['clip']:
            end = min(end, d['clip'][1])
        start = max(start, find_start_pieces(toks, ls, F, model, end, sigma=0.45, alpha=0.3))
    pcs, pl, own = [], [], []
    for wi, w in enumerate(toks):
        for k2, pp in enumerate(hit_pieces(w)):
            pcs.append(pp); pl.append(bool(ls[wi]) and k2 == 0); own.append(wi)
    own = np.array(own); first = np.searchsorted(own, np.arange(len(toks)))
    choice = ''
    if os.environ.get('FOLLOW'):
        pt = follow_along(pcs, pl, F, model, start, end)
    else:
        _, pt, _ = align_pieces(toks, ls, F, model, start=start, end=end, **KW)
        if os.environ.get('HYBRID'):
            pf = follow_along(pcs, pl, F, model, start, end)
            sb, sf = breath_fit(pt, pl, F), breath_fit(pf, pl, F)
            choice = 'follow' if sf > sb + float(os.environ.get('MARGIN', 0.05)) else 'main'
            choice += ' (%.2f vs %.2f)' % (sf, sb)
            if choice.startswith('follow'):
                pt = pf
    wt = np.asarray(pt)[first]
    err = np.array([wt[k] - t for k, t in enumerate(truth) if t is not None])
    big = [(k, seq[k][0], toks[k], round(float(wt[k] - t), 2)) for k, t in enumerate(truth) if t is not None and abs(wt[k] - t) > 1]
    rows.append((name, err, sum(1 for s in d['sung'] if s.get('repeat')), big))
    if choice: print('  ', name[:30], 'chose', choice, flush=True)
    json.dump({'pred': [round(float(x), 3) for x in wt], 'seq': seq}, open(os.path.join(HERE, 'data', f'{name}.perf-{mode}.cache'), 'w'))

pct = lambda e, s: '%3.0f%%' % (100 * np.mean(np.abs(e) <= s))
print(mode.upper(), '(Hazzat key, every piece, repeats sung in order)')
print('hymn'.ljust(34), 'timed', 'reps', 'median', '≤.25s', ' ≤.5s', '  ≤1s', '  ≤2s')
for n, e, r, _ in rows:
    print(n[:34].ljust(34), str(len(e)).rjust(5), str(r).rjust(4), ('%.2fs' % np.median(np.abs(e))).rjust(6), pct(e, .25).rjust(5), pct(e, .5).rjust(5), pct(e, 1).rjust(5), pct(e, 2).rjust(5))
if rows:
    E = np.concatenate([r[1] for r in rows])
    print('ALL'.ljust(34), str(len(E)).rjust(5), '    ', ('%.2fs' % np.median(np.abs(E))).rjust(6), pct(E, .25).rjust(5), pct(E, .5).rjust(5), pct(E, 1).rjust(5), pct(E, 2).rjust(5))
if os.environ.get('SHOWBIG'):
    for n, _, _, big in rows:
        if big:
            print('\n' + n, 'disagreements > 1 s:', big[:25])
