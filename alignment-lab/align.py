"""Hazzat-to-recording aligner (local math only).

1. Duration model: each Hazzat word's expected length = learned per-glyph weights
   (ridge regression on hand-timed hymns, tempo-normalised).
2. Boundary evidence: a new word usually starts with a loudness dip just before,
   a burst of new spectral energy just after, and often a pitch change.
3. Dynamic programming picks the word start times that best balance (1) and (2),
   in order, between a start and end time. A second pass adapts to local tempo.
"""
import collections
import numpy as np

HOP = 0.02
MIN_COUNT = 15


# ---------- duration model ----------
class DurationModel:
    def __init__(self, ridge=1.0):
        self.ridge = ridge
        self.vocab = []
        self.w = None

    def _x(self, g):
        v = np.zeros(len(self.vocab) + 1)
        v[-1] = 1
        for c in g:
            if c in self.index:
                v[self.index[c]] += 1
        return v

    def fit(self, hymns):
        counts = collections.Counter(c for h in hymns for g in h['tokens'] for c in g)
        self.vocab = sorted(c for c, n in counts.items() if n >= MIN_COUNT)
        self.index = {c: i for i, c in enumerate(self.vocab)}
        A, y = [], []
        for h in hymns:
            t = h['times']
            pairs = [(h['tokens'][i], t[i + 1] - t[i]) for i in range(len(t) - 1)
                     if t[i] is not None and t[i + 1] is not None]
            if not pairs:
                continue
            m = np.mean([d for _, d in pairs])
            for g, d in pairs:
                A.append(self._x(g)); y.append(d / m)
        A, y = np.array(A), np.array(y)
        self.w = np.linalg.solve(A.T @ A + self.ridge * np.eye(A.shape[1]), A.T @ y)
        return self

    def predict(self, tokens):
        if self.w is None:
            return np.array([max(1, len(g)) for g in tokens], float)
        return np.maximum(np.array([self._x(g) @ self.w for g in tokens]), 0.08)

    def to_json(self):
        return {'vocab': self.vocab, 'weights': [round(float(x), 5) for x in self.w]}


# ---------- boundary evidence ----------
def z(a):
    med = np.median(a)
    mad = np.median(np.abs(a - med)) * 1.4826 + 1e-9
    return np.clip((a - med) / mad, -4, 4)


def onset_score(F, before=5, after=5):
    """Per-frame evidence that a new word starts here (higher = more likely)."""
    db, flux, f0 = F['rms_db'], F['flux'], F['f0']
    n = len(db)
    zdb, zfl = z(db), z(np.log1p(flux))
    cdb = np.concatenate([[0], np.cumsum(zdb)])
    cfl = np.concatenate([[0], np.cumsum(zfl)])
    i = np.arange(n)
    lo, hi = (i - before).clip(0), (i + after).clip(max=n)
    dip = -(cdb[i + 1] - cdb[lo]) / np.maximum(i + 1 - lo, 1)    # quiet just before
    burst = (cfl[hi] - cfl[i]) / np.maximum(hi - i, 1)            # new energy after
    lf = np.where(f0 > 0, np.log2(np.maximum(f0, 1)), np.nan)
    # Pitch change: median pitch of next 8 frames vs previous 8 frames (vectorised via rolling).
    pch = np.zeros(n)
    voiced = ~np.isnan(lf)
    fill = np.where(voiced, lf, 0.0)
    cv = np.concatenate([[0], np.cumsum(voiced)])
    cf = np.concatenate([[0], np.cumsum(fill)])
    w = 8
    a0, a1 = (i - w).clip(0), i
    b0, b1 = i, (i + w).clip(max=n)
    na, nb = cv[a1] - cv[a0], cv[b1] - cv[b0]
    ma = (cf[a1] - cf[a0]) / np.maximum(na, 1)
    mb = (cf[b1] - cf[b0]) / np.maximum(nb, 1)
    ok = (na >= 3) & (nb >= 3)
    pch[ok] = np.minimum(np.abs(mb - ma)[ok] * 12, 4)  # semitones, capped
    return 0.5 * dip + 0.5 * burst + 0.25 * pch


def singing_span(F):
    """Rough start/end of sustained singing."""
    db = F['rms_db']
    thr = np.percentile(db, 20) + 0.35 * (np.percentile(db, 95) - np.percentile(db, 20))
    loud = db > thr
    k = int(1.0 / HOP)
    sus = np.convolve(loud.astype(float), np.ones(k) / k, mode='same') > 0.6
    idx = np.flatnonzero(sus)
    if not len(idx):
        return 0, len(db) - 1
    return max(0, idx[0] - k // 2), min(len(db) - 1, idx[-1] + k // 2)


# ---------- dynamic programming ----------
def activity(F, floor=0.08):
    """0..1 per frame: how much this frame counts as sung time (pauses count little)."""
    db = F['rms_db']
    lo, hi = np.percentile(db, 15), np.percentile(db, 90)
    a = np.clip((db - lo) / max(hi - lo, 1e-6) * 1.6 - 0.3, 0, 1)
    a = np.convolve(a, np.ones(5) / 5, 'same')
    return np.maximum(a, floor)


def dp_align(expected, start, end, onset, sigma, alpha, band_frac=0.08, min_band=60, fixed=None, act=None, pitch=None, beta=0.0):
    """pitch: optional (CF, CV, templates[n,2]) - cumulative voiced pitch sums and per-word
    expected (first-half, second-half) pitch levels; beta weights that match."""
    """expected: per-word expected frames (sum = end-start). Returns start frame per word.
    Word 0 starts at `start`; later starts are chosen; the last word ends at `end`.
    Durations are limited to 1/4..4x expected, searched on a geometric grid."""
    n = len(expected)
    if act is None:
        act = np.ones(len(onset))
    C = np.concatenate([[0], np.cumsum(act)])  # sung-time clock; C[f] = sung frames before f
    sung_total = C[end] - C[start]
    targets = C[start] + np.concatenate([[0], np.cumsum(expected)]) * sung_total / max(expected.sum(), 1e-9)
    cum = np.searchsorted(C, targets).astype(float) - 0
    expected = expected * sung_total / max(expected.sum(), 1e-9)
    total = end - start
    band = max(min_band, int(band_frac * total))
    INF = 1e18
    prev_lo, prev = start, np.array([0.0])
    back = []
    for i in range(1, n + 1):
        if i < n:
            center = int(round(cum[i]))
            lo, hi = max(start + i, center - band), min(end - (n - i), center + band)
            if hi < lo:
                lo = hi = min(max(center, start + i), end)
            if fixed and i in fixed:
                lo = hi = fixed[i]
        else:
            lo = hi = end
        width = hi - lo + 1
        e = max(expected[i - 1], 1.0)
        # Wall-clock durations to try: from 1/4 of expected sung time up to 4x plus generous room for pauses.
        ks = np.unique(np.clip(np.round(e * np.exp(np.linspace(np.log(.25), np.log(12), 64))), 1, None).astype(int))
        best = np.full(width, INF)
        arg = np.zeros(width, dtype=np.int64)
        cand = np.arange(lo, hi + 1)
        plen = len(prev)
        for k in ks:
            src = cand - k - prev_lo
            ok = (src >= 0) & (src < plen)
            if not ok.any():
                continue
            v = np.full(width, INF)
            sung = np.maximum(C[cand[ok]] - C[cand[ok] - k], 0.5)
            v[ok] = prev[src[ok]] + np.log(sung / e) ** 2 / (2 * sigma ** 2)
            if pitch is not None and beta > 0:
                CF, CV, tpl = pitch
                t = tpl[i - 1]
                if np.isfinite(t).all():
                    b, a2 = cand[ok], cand[ok] - k
                    m = (a2 + b) // 2
                    pc = 0
                    for (x0, x1, tv) in ((a2, m, t[0]), (m, b, t[1])):
                        nv = CV[x1] - CV[x0]
                        lvl = (CF[x1] - CF[x0]) / np.maximum(nv, 1)
                        d = np.minimum((lvl - tv) ** 2, 9.0)
                        pc = pc + np.where(nv >= 3, d, 2.0)
                    v[ok] += beta * pc
            better = v < best
            best[better] = v[better]
            arg[better] = cand[better] - k
        if i < n:
            best = best - alpha * onset[cand]
        if not np.isfinite(best).any() or best.min() >= INF / 2:
            # Fallback: nothing reachable (extreme tempo); place proportionally.
            best = np.abs(cand - (cum[i] if i < n else end)).astype(float)
            arg = np.clip(cand - int(e), prev_lo, prev_lo + plen - 1)
        back.append((lo, arg))
        prev_lo, prev = lo, best
    starts = np.zeros(n, dtype=np.int64)
    cur = end
    for i in range(n, 0, -1):
        lo, arg = back[i - 1]
        p = int(arg[min(max(cur - lo, 0), len(arg) - 1)])
        starts[i - 1] = p
        cur = p
    starts[0] = start
    return starts


def _anchor_expected(expected, start, end, fixed, clock=None):
    """Rescale expected durations (sung-time units) so each stretch between anchors fits exactly."""
    if clock is not None:
        return _anchor_expected(expected, clock[start], clock[end],
                                {i: clock[f] for i, f in (fixed or {}).items()})
    pts = sorted([(0, start)] + [(i, f) for i, f in (fixed or {}).items() if 0 < i < len(expected)] + [(len(expected), end)])
    out = expected.copy()
    for (i0, f0), (i1, f1) in zip(pts, pts[1:]):
        if i1 > i0:
            seg = out[i0:i1]
            out[i0:i1] = seg / max(seg.sum(), 1e-9) * max(f1 - f0, 0.5 * (i1 - i0))
    return out


def align(tokens, F, model, start=None, end=None, sigma=0.45, alpha=0.3, local_window=12,
          passes=2, learn_hymn=3, shrink=2.0, known=None, use_activity=False, beta=0.0, pitch_iters=0, oracle_starts=None):
    """known: {word_index: seconds} hand timings to honour (e.g. the first verse)."""
    onset = onset_score(F)
    act = activity(F) if use_activity else None
    Cs = np.concatenate([[0], np.cumsum(act if act is not None else np.ones(len(onset)))])
    s0, e0 = singing_span(F)
    start = s0 if start is None else int(round(start / HOP))
    end = e0 if end is None else int(round(end / HOP))
    fixed = {i: int(round(t / HOP)) for i, t in (known or {}).items() if t is not None and 0 < i < len(tokens)}
    if known and known.get(0) is not None:
        start = int(round(known[0] / HOP))
    f0 = F['f0']
    lf = np.where(f0 > 0, 12 * np.log2(np.maximum(f0, 1)), np.nan)
    lf = lf - np.nanmedian(lf)
    voiced = np.isfinite(lf) & (np.abs(lf) < 14)
    CF = np.concatenate([[0], np.cumsum(np.where(voiced, lf, 0))])
    CV = np.concatenate([[0], np.cumsum(voiced)])

    def templates(starts):
        """Per notation word: mean pitch of its first/second half, averaged over its repeats."""
        ends = np.append(starts[1:], end)
        m = (starts + ends) // 2
        lv = np.full((len(tokens), 2), np.nan)
        for j, (x0, x1) in enumerate(((starts, m), (m, ends))):
            nv = CV[x1] - CV[x0]
            lv[:, j] = np.where(nv >= 3, (CF[x1] - CF[x0]) / np.maximum(nv, 1), np.nan)
        tpl = np.full((len(tokens), 2), np.nan)
        for g, idx in groups.items():
            if len(idx) < 3:
                continue
            vals = lv[idx]
            med = np.nanmedian(vals, axis=0)
            tpl[idx] = med
        return tpl

    rel = model.predict(tokens)
    groups = {}
    for i, g in enumerate(tokens):
        groups.setdefault(g, []).append(i)

    def adapt(base, starts):
        """Per-hymn rhythm: identical notation words share a learned duration factor."""
        ends = np.append(starts[1:], end)
        actual = np.maximum(Cs[ends] - Cs[starts], 0.5)
        ratio = np.log(actual / np.maximum(base, 1))
        out = base.copy()
        for g, idx in groups.items():
            n = len(idx)
            out[idx] = base[idx] * np.exp(ratio[idx].mean() * n / (n + shrink))
        return out / out.sum() * (Cs[end] - Cs[start])

    expected = _anchor_expected(rel / rel.sum() * (Cs[end] - Cs[start]), start, end, fixed, Cs)
    if known and len(fixed) >= 2:
        # Learn group factors directly from the hand-timed words.
        kt = sorted((i, t) for i, t in fixed.items())
        ratio = {}
        for (i, t), (j, u) in zip(kt, kt[1:]):
            if j == i + 1:
                ratio.setdefault(tokens[i], []).append(np.log(max(Cs[u] - Cs[t], 0.5) / max(expected[i], 0.5)))
        for g, r in ratio.items():
            n = len(r)
            expected[groups[g]] *= np.exp(np.mean(r) * n / (n + shrink))
        expected = _anchor_expected(expected, start, end, fixed, Cs)
    starts = dp_align(expected, start, end, onset, sigma, alpha, fixed=fixed, act=act)
    base = expected
    for _ in range(learn_hymn):
        expected = _anchor_expected(adapt(base, starts), start, end, fixed, Cs)
        starts = dp_align(expected, start, end, onset, sigma, alpha, band_frac=0.05, min_band=50, fixed=fixed, act=act)
    for _ in range(passes - 1):
        ends = np.append(starts[1:], end)
        actual = np.maximum(Cs[ends] - Cs[starts], 0.5)
        ratio = np.log(actual / np.maximum(expected, 1))
        k = np.ones(2 * local_window + 1)
        sm = np.convolve(ratio, k, 'same') / np.convolve(np.ones_like(ratio), k, 'same')
        exp2 = _anchor_expected(expected * np.exp(sm), start, end, fixed, Cs)
        starts = dp_align(exp2, start, end, onset, sigma, alpha, band_frac=0.03, min_band=40, fixed=fixed, act=act)
        expected = exp2
    if known and pitch_iters and len(fixed) >= 2:
        # Melody templates from the hand-timed words only (realistic: editor timed verse 1).
        ks = sorted(fixed.items())
        lv = {}
        for (i, a0), (j, b0) in zip(ks, ks[1:]):
            if j != i + 1:
                continue
            m = (a0 + b0) // 2
            v = []
            for x0, x1 in ((a0, m), (m, b0)):
                nv = CV[x1] - CV[x0]
                v.append((CF[x1] - CF[x0]) / nv if nv >= 3 else np.nan)
            lv.setdefault(tokens[i], []).append(v)
        tpl = np.full((len(tokens), 2), np.nan)
        for g, vals in lv.items():
            tpl[groups[g]] = np.nanmedian(np.array(vals), axis=0)
        starts = dp_align(expected, start, end, onset, sigma, alpha, band_frac=0.05, min_band=50,
                          fixed=fixed, act=act, pitch=(CF, CV, tpl), beta=beta)
        pitch_iters -= 1
    for _ in range(pitch_iters):
        tpl = templates(starts if oracle_starts is None else np.round(np.array(oracle_starts) / HOP).astype(np.int64))
        starts = dp_align(expected, start, end, onset, sigma, alpha, band_frac=0.05, min_band=50,
                          fixed=fixed, act=act, pitch=(CF, CV, tpl), beta=beta)
    return starts * HOP
