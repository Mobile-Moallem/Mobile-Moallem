"""Leave-one-hymn-out test of fine snapping on top of the coarse piece alignment.
Needs coarse predictions from:  LKEY=1 PIECES=1 SOFT=1 KEYBREATH=1 python3 eval_matcher.py <mode>
(which saves word-level starts) plus the piece-level starts saved by this script's coarse run."""
import glob, json, os, sys, re
import numpy as np
from refine import fine_features, TapModel, snap, FH
from align import LearnedKey, align_pieces, find_end_pieces, find_start_pieces, singing_span, HOP
from eval_matcher import load_all

HERE = os.path.dirname(os.path.abspath(__file__))
mode = sys.argv[1] if len(sys.argv) > 1 else 'anchored'
WIN = float(os.environ.get('WIN', 0.6)); SD = float(os.environ.get('SD', 0.3)); PW = float(os.environ.get('PW', 1.0))
C = float(os.environ.get('C', 0.3))

hymns = load_all()
fx = {}
for h in hymns:
    cache = os.path.join(HERE, 'data', h['name'] + '.fine.npy')
    if os.path.exists(cache):
        fx[h['name']] = np.load(cache)
    else:
        pcm = np.fromfile(os.path.join(HERE, 'data', h['audio']), dtype=np.float32)
        X, _ = fine_features(pcm, h['rate']); np.save(cache, X); fx[h['name']] = X

# Coarse piece-level starts (leave-one-out), cached per mode.
coarse = {}
for k, h in enumerate(hymns):
    cp = os.path.join(HERE, 'data', f"{h['name']}.pieces-{mode}.cache")
    if os.path.exists(cp) and not os.environ.get('RECOARSE'):
        coarse[h['name']] = json.load(open(cp)); continue
    model = LearnedKey().fit([x for j, x in enumerate(hymns) if j != k])
    timed = [t for t in h['times'] if t is not None]
    if mode == 'anchored':
        start = timed[0]; end = timed[-1] + float(np.median(np.diff(timed))) * 1.5
    else:
        s0, _ = singing_span(h['F']); start = max(h['clip'][0] if h['clip'] else 0, s0 * HOP)
        end = find_end_pieces(h['tokens'], h['line_start'], h['F'], model, start, sigma=0.45, alpha=0.3)
        if h['clip']: end = min(end, h['clip'][1])
        start = max(start, find_start_pieces(h['tokens'], h['line_start'], h['F'], model, end, sigma=0.45, alpha=0.3))
    wt, pt, owner = align_pieces(h['tokens'], h['line_start'], h['F'], model, start=start, end=end,
                                 sigma=0.45, alpha=0.3, gamma=1.0, breath='key', learn_hymn=3, passes=2)
    coarse[h['name']] = {'pieces': [float(x) for x in pt], 'owner': [int(o) for o in owner]}
    json.dump(coarse[h['name']], open(cp, 'w'))

def word_errs(h, piece_times, owner):
    owner = np.array(owner); first = np.searchsorted(owner, np.arange(len(h['tokens'])))
    return np.array([abs(piece_times[first[i]] - t) for i, t in enumerate(h['times']) if t is not None])

rows = []
for k, h in enumerate(hymns):
    # train tap model on other hymns' word starts (the timings we have)
    tm = TapModel(C=C).fit([(fx[x['name']], x['times']) for j, x in enumerate(hymns) if j != k])
    c = coarse[h['name']]
    ref = snap(c['pieces'], fx[h['name']], tm, window=WIN, prior_sd=SD, prior_w=PW, fixed_first=(mode == 'anchored'))
    e0 = word_errs(h, c['pieces'], c['owner']); e1 = word_errs(h, ref, c['owner'])
    rows.append((h['name'], e0, e1))
    json.dump([round(float(x), 3) for x in ref], open(os.path.join(HERE, 'data', f"{h['name']}.refined-{mode}.cache"), 'w'))

pct = lambda e, s: '%3.0f%%' % (100 * np.mean(e <= s))
print(f'{mode.upper()}  win={WIN} sd={SD} pw={PW} C={C}')
print('hymn'.ljust(30), '  coarse ≤.1 ≤.25  ≤.5   ≤1 |  snapped ≤.1 ≤.25  ≤.5   ≤1')
for n, a, b in rows:
    print(n[:30].ljust(30), '        ', pct(a, .1), pct(a, .25), pct(a, .5), pct(a, 1), '|         ', pct(b, .1), pct(b, .25), pct(b, .5), pct(b, 1))
A = np.concatenate([r[1] for r in rows]); B = np.concatenate([r[2] for r in rows])
print('ALL'.ljust(30), '        ', pct(A, .1), pct(A, .25), pct(A, .5), pct(A, 1), '|         ', pct(B, .1), pct(B, .25), pct(B, .5), pct(B, 1))
