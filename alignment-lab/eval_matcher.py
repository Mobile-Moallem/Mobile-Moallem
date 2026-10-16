"""Leave-one-hymn-out evaluation of align.py against hand timings.

The duration model scoring hymn X is trained only on the other hymns, so the
numbers reflect how it would do on a hymn nobody has timed yet.

Modes:
  auto     - finds where the singing starts and stops by itself (clip used if set)
  anchored - editor marks the first word's start and roughly where the hymn ends
"""
import glob, json, os, sys, time
import numpy as np
from align import LearnedKey, align_pieces, find_end_pieces, find_start_pieces, DurationModel, HazzatKey, BreathModel, align, align_lines, find_end, singing_span, HOP

HERE = os.path.dirname(os.path.abspath(__file__))


def load_all():
    hymns = []
    for f in sorted(glob.glob(os.path.join(HERE, 'data/*.json'))):
        d = json.load(open(f))
        z = np.load(f.replace('.json', '.feat.npz'))
        d['F'] = {k: z[k] for k in z.files}
        d['name'] = os.path.basename(f)[:-5]
        hymns.append(d)
    return hymns


def score(pred, truth):
    e = np.array([abs(p - t) for p, t in zip(pred, truth) if t is not None])
    return e


def run(hymns, mode, **kw):
    out = {}
    for k, h in enumerate(hymns):
        model = (LearnedKey(ridge=float(os.environ.get('RIDGE', 6))) if os.environ.get('LKEY') else HazzatKey() if os.environ.get('KEY') else DurationModel()).fit([x for j, x in enumerate(hymns) if j != k])
        timed = [t for t in h['times'] if t is not None]
        start = end = None
        if mode == 'anchored':
            start = timed[0]
            gaps = np.diff(timed)
            end = timed[-1] + float(np.median(gaps)) * 1.5
        elif h['clip']:
            start, end = h['clip'][0], min(h['clip'][1], h['duration'] - 0.05)
        if mode == 'auto':
            # Start: first sustained singing (inside the clip if one is set).
            s0, _ = singing_span(h['F'])
            start = max(start or 0, s0 * HOP)
            if os.environ.get('FINDEND2'):
                end = find_end_pieces(h['tokens'], h['line_start'], h['F'], model, start, sigma=kw['sigma'], alpha=kw['alpha'],
                                      gamma=float(os.environ.get('GAMMA', 1.0)))
                if h['clip']:
                    end = min(end, h['clip'][1])
                if os.environ.get('FINDSTART'):
                    start = max(start, find_start_pieces(h['tokens'], h['line_start'], h['F'], model, end,
                                                         sigma=kw['sigma'], alpha=kw['alpha']))
            elif os.environ.get('FINDEND'):
                end = find_end(h['tokens'], h['F'], model, start, line_start=h['line_start'] if os.environ.get('SOFT') else None,
                               sigma=kw['sigma'], alpha=kw['alpha'], gamma=float(os.environ.get('GAMMA', 3.0)))
                if h['clip']:
                    end = min(end, h['clip'][1])
        known = None
        truth = list(h['times'])
        if mode == 'seeded':
            # Editor hand-times roughly the first 10% of words (about one verse).
            start = timed[0]
            end = timed[-1] + float(np.median(np.diff(timed))) * 1.5
            cut = max(8, len(truth) // 10)
            known = {i: t for i, t in enumerate(truth[:cut]) if t is not None}
        orc = None
        if os.environ.get('ORACLE'):
            tt = np.array([np.nan if x is None else x for x in h['times']]); ok = np.isfinite(tt)
            orc = np.interp(np.arange(len(tt)), np.flatnonzero(ok), tt[ok])
        if os.environ.get('SOFT'):
            br = 'key' if os.environ.get('KEYBREATH') else (BreathModel().fit([x for j, x in enumerate(hymns) if j != k]) if os.environ.get('BREATH') else None)
            if os.environ.get('PIECES'):
                pred, _, _ = align_pieces(h['tokens'], h['line_start'], h['F'], model, start=start, end=end,
                                          gamma=float(os.environ.get('GAMMA', 1.0)), breath=br, **kw)
            else:
                pred = align(h['tokens'], h['F'], model, start=start, end=end, line_start=h['line_start'],
                             gamma=float(os.environ.get('GAMMA', 1.0)), breath=br, **kw)
        elif os.environ.get('LINES'):
            pred = align_lines(h['tokens'], h['line_start'], h['F'], model, start=start, end=end,
                               gamma=float(os.environ.get('GAMMA', 2.0)), **kw)
        else:
            pred = align(h['tokens'], h['F'], model, start=start, end=end, known=known, oracle_starts=orc, **kw)
        if known:
            truth = [None if i in known else t for i, t in enumerate(truth)]  # score only untouched words
        out[h['name']] = (pred, score(pred, truth))
    return out


def report(title, res):
    print('\n' + title)
    print('hymn'.ljust(34), 'slots', 'median', '≤0.3s', '≤0.5s', ' ≤1s', ' ≤2s')
    allv = []
    for name, (_, e) in res.items():
        allv.append(e)
        p = lambda s: '%3.0f%%' % (100 * (e <= s).mean())
        print(name[:34].ljust(34), str(len(e)).rjust(5), ('%.2fs' % np.median(e)).rjust(6), p(.3).rjust(5), p(.5).rjust(5), p(1).rjust(4), p(2).rjust(4))
    e = np.concatenate(allv)
    p = lambda s: '%3.0f%%' % (100 * (e <= s).mean())
    print('ALL'.ljust(34), str(len(e)).rjust(5), ('%.2fs' % np.median(e)).rjust(6), p(.3).rjust(5), p(.5).rjust(5), p(1).rjust(4), p(2).rjust(4))
    return e


if __name__ == '__main__':
    hymns = load_all()
    kw = dict(sigma=float(os.environ.get('SIGMA', 0.45)), alpha=float(os.environ.get('ALPHA', 0.3)), learn_hymn=int(os.environ.get('LEARN', 3)), passes=int(os.environ.get('PASSES', 2)), beta=float(os.environ.get('BETA', 0)), pitch_iters=int(os.environ.get('PITER', 0)))
    for mode in sys.argv[1:] or ['auto', 'anchored']:
        t0 = time.time()
        res = run(hymns, mode, **kw)
        report(f'{mode.upper()}  {kw}  ({time.time() - t0:.0f}s)', res)
        for name, (pred, _) in res.items():
            json.dump([round(float(x), 2) for x in pred], open(os.path.join(HERE, f'data/{name}.matcher-{mode}.pred'), 'w'))
