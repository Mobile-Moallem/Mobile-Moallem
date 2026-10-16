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
import os as _os
ONSET_MODE = _os.environ.get('ONSET', 'syllable')
ONSET_PITCH = float(_os.environ.get('OPITCH', 0.0))
UNV_W = float(_os.environ.get('UNVW', 0.3))


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


class HazzatKey:
    """Duration from the Hazzat font key (copticcantor.com/font, same letters as hazzat.com):
    bottom row z x c v b n m = full notes of length 1..7, top row q w e r ... = half notes,
    'a' = fast transition, s d f ... = extensions, '.' = breath of about one full note."""
    FULL, HALF, EXT = 'zxcvbnm', 'qwertyuiop', 'sdfghjkl'

    def __init__(self, full=1.0, half=0.5, fast=0.25, ext=0.5, breath=1.0):
        self.full, self.half, self.fast, self.ext, self.breath = full, half, fast, ext, breath

    def units(self, g):
        u = 0.0
        for c in g:
            if c in self.FULL: u += self.full * (self.FULL.index(c) + 1)
            elif c in self.HALF: u += self.half * (self.HALF.index(c) + 1)
            elif c == 'a': u += self.fast
            elif c in self.EXT: u += self.ext * (self.EXT.index(c) + 1)
            elif c == '.': u += self.breath
        return max(u, 0.25)

    def fit(self, hymns):
        return self

    def predict(self, tokens):
        return np.array([self.units(g) for g in tokens])

    @staticmethod
    def breath_weights(tokens, line_start):
        """+1 where the notation implies a breath just before the word (new line, or the
        previous word ends with a breath mark '.'); a mild negative elsewhere."""
        w = np.full(len(tokens), -0.25)
        w[0] = 0
        for i in range(1, len(tokens)):
            if (line_start is not None and line_start[i]) or tokens[i - 1].endswith('.'):
                w[i] = 1.0
        return w


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
    if ONSET_MODE == 'legacy':
        return 0.5 * dip + 0.5 * burst + 0.25 * pch
    # Words start on a syllable: a short loudness dip and a voicing break (the consonant).
    # Pitch changes mostly happen *inside* a word (new note, same syllable), so they count against.
    unv = 1 - (cv[b1] - cv[(i - 4).clip(0)]) / np.maximum(b1 - (i - 4).clip(0), 1)
    return 0.5 * dip + 0.5 * burst + UNV_W * (unv - unv.mean()) - ONSET_PITCH * pch


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


def dp_align(expected, start, end, onset, sigma, alpha, band_frac=0.08, min_band=60, fixed=None, act=None, pitch=None, beta=0.0, bonus=None, is_line=None, gamma=0.0, return_cost=False):
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
            if bonus is not None and gamma > 0:
                if is_line.dtype != bool:
                    best = best - gamma * is_line[i] * bonus[cand]   # learned breath weights
                elif is_line[i]:
                    best = best - gamma * bonus[cand]
                else:
                    best = best + 0.25 * gamma * bonus[cand]  # mid-line words rarely start after a breath
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
    if return_cost:
        return starts, float(prev[-1])
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
          passes=2, learn_hymn=3, shrink=2.0, known=None, use_activity=False, beta=0.0, pitch_iters=0, oracle_starts=None, line_start=None, gamma=0.0, breath=None):
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

    bonus = is_line = None
    if line_start is not None and gamma > 0:
        bonus = pause_bonus(F)
        if breath == 'key':
            is_line = HazzatKey.breath_weights(tokens, line_start)
        elif breath is not None:
            is_line = breath.weights(tokens, line_start)
        else:
            is_line = np.array(line_start, bool)
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
    starts = dp_align(expected, start, end, onset, sigma, alpha, fixed=fixed, act=act, bonus=bonus, is_line=is_line, gamma=gamma)
    base = expected
    for _ in range(learn_hymn):
        expected = _anchor_expected(adapt(base, starts), start, end, fixed, Cs)
        starts = dp_align(expected, start, end, onset, sigma, alpha, band_frac=0.05, min_band=50, fixed=fixed, act=act, bonus=bonus, is_line=is_line, gamma=gamma)
    for _ in range(passes - 1):
        ends = np.append(starts[1:], end)
        actual = np.maximum(Cs[ends] - Cs[starts], 0.5)
        ratio = np.log(actual / np.maximum(expected, 1))
        k = np.ones(2 * local_window + 1)
        sm = np.convolve(ratio, k, 'same') / np.convolve(np.ones_like(ratio), k, 'same')
        exp2 = _anchor_expected(expected * np.exp(sm), start, end, fixed, Cs)
        starts = dp_align(exp2, start, end, onset, sigma, alpha, band_frac=0.03, min_band=40, fixed=fixed, act=act, bonus=bonus, is_line=is_line, gamma=gamma)
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
                          fixed=fixed, act=act, pitch=(CF, CV, tpl), beta=beta, bonus=bonus, is_line=is_line, gamma=gamma)
        pitch_iters -= 1
    for _ in range(pitch_iters):
        tpl = templates(starts if oracle_starts is None else np.round(np.array(oracle_starts) / HOP).astype(np.int64))
        starts = dp_align(expected, start, end, onset, sigma, alpha, band_frac=0.05, min_band=50,
                          fixed=fixed, act=act, pitch=(CF, CV, tpl), beta=beta, bonus=bonus, is_line=is_line, gamma=gamma)
    return starts * HOP


# ---------- line anchoring (phrases start after breaths) ----------
def pause_candidates(F, min_len=0.12):
    """Frames where a quiet stretch ends, with a 0..1 'pause strength'."""
    db = F['rms_db']
    lo, hi = np.percentile(db, 10), np.percentile(db, 90)
    q = (db - lo) / max(hi - lo, 1e-6)          # 0 = quiet, 1 = loud
    quiet = q < 0.15
    cands = []
    n = len(q)
    i = 0
    k = int(min_len / HOP)
    while i < n:
        if quiet[i]:
            j = i
            while j < n and quiet[j]:
                j += 1
            if j - i >= k:
                depth = 1 - max(q[i:j].min(), 0) / 0.15
                length = min((j - i) * HOP / 0.6, 1.0)
                cands.append((j, 0.5 * length + 0.5 * depth))
            i = j
        else:
            i += 1
    return cands


def line_dp(line_exp, start, end, cands, sigma=0.35, gamma=2.0, band_frac=0.15):
    """Choose a start frame for each line after the first among pause candidates.
    line_exp: expected frames per line (sums to end-start)."""
    L = len(line_exp)
    if L <= 1:
        return []
    pos = np.array([c for c, _ in cands if start < c < end], dtype=np.int64)
    strength = np.array([s for c, s in cands if start < c < end])
    if len(pos) < L - 1:
        return None
    cum = start + np.cumsum(line_exp)
    band = max(int(band_frac * (end - start)), 150)
    INF = 1e18
    # prev over candidate indices (plus virtual start)
    prev_pos = np.array([start]); prev = np.array([0.0])
    backs = []
    for li in range(1, L + 1):
        if li < L:
            ok = np.abs(pos - cum[li - 1]) <= band
            cpos = pos[ok]; cstr = strength[ok]; cidx = np.flatnonzero(ok)
            if not len(cpos):
                return None
        else:
            cpos = np.array([end]); cstr = np.array([0.0]); cidx = np.array([-1])
        e = max(line_exp[li - 1], 1.0)
        k = cpos[None, :] - prev_pos[:, None]
        dur = np.where(k > 0, np.log(np.maximum(k, 1) / e) ** 2 / (2 * sigma ** 2), INF)
        tot = prev[:, None] + dur
        j = tot.argmin(0)
        best = tot[j, np.arange(len(cpos))] - gamma * cstr
        backs.append((cpos, j))
        prev_pos, prev = cpos, best
    # backtrack
    out = []
    ci = 0
    for li in range(L, 1, -1):
        cpos, j = backs[li - 1]
        ci = j[ci]
        out.append(int(backs[li - 2][0][ci]))
    return out[::-1]


def align_lines(tokens, line_start, F, model, start=None, end=None, sigma_line=0.35, gamma=2.0, **kw):
    """Anchor each notation line to a pause, then align words inside lines."""
    s0, e0 = singing_span(F)
    sf = s0 if start is None else int(round(start / HOP))
    ef = e0 if end is None else int(round(end / HOP))
    rel = model.predict(tokens)
    rel = rel / rel.sum() * (ef - sf)
    firsts = [i for i in range(1, len(tokens)) if line_start[i]]
    bounds = [0] + firsts + [len(tokens)]
    line_exp = np.array([rel[a:b].sum() for a, b in zip(bounds, bounds[1:])])
    picks = line_dp(line_exp, sf, ef, pause_candidates(F), sigma=sigma_line, gamma=gamma)
    known = None
    if picks:
        known = {i: f * HOP for i, f in zip(firsts, picks)}
    return align(tokens, F, model, start=sf * HOP, end=ef * HOP, known=known, **kw)


def pause_bonus(F, lead=0.06, spread=0.2):
    """Per-frame 0..1 evidence that a phrase (notation line) starts here:
    peaks just before the end of each breath/pause."""
    n = len(F['rms_db'])
    out = np.zeros(n)
    w = int(3 * spread / HOP)
    ker = np.exp(-0.5 * (np.arange(-w, w + 1) * HOP / spread) ** 2)
    for end, strength in pause_candidates(F):
        c = end - int(round(lead / HOP))
        lo, hi = max(0, c - w), min(n, c + w + 1)
        out[lo:hi] = np.maximum(out[lo:hi], strength * ker[lo - (c - w):hi - (c - w)])
    return out


def find_end(tokens, F, model, start, line_start=None, sec_per_unit=2.0, tempo_sd=0.2,
             sigma=0.6, alpha=0.3, gamma=3.0, max_cands=14):
    """Pick where the hymn ends when the recording has extra audio after it.
    Tries pause starts near the tempo-predicted end; keeps the best notation fit."""
    s0, e0 = singing_span(F)
    sf = int(round(start / HOP)) if start is not None else s0
    units = model.predict(tokens).sum()
    exp_end = sf + sec_per_unit * units / HOP
    db = F['rms_db']
    lo, hi = np.percentile(db, 10), np.percentile(db, 90)
    q = (db - lo) / max(hi - lo, 1e-6)
    quiet = q < 0.15
    # pause starts = loud->quiet transitions lasting >= 0.3 s
    k = int(0.3 / HOP)
    starts_q = [i for i in range(1, len(q) - k) if quiet[i] and not quiet[i - 1] and quiet[i:i + k].all()]
    win_lo, win_hi = sf + 0.7 * (exp_end - sf), min(e0, sf + 1.35 * (exp_end - sf))
    cands = [c for c in starts_q if win_lo <= c <= win_hi] + [e0]
    cands = sorted(set(min(c, e0) for c in cands))
    if len(cands) > max_cands:
        idx = np.linspace(0, len(cands) - 1, max_cands).round().astype(int)
        cands = [cands[i] for i in idx]
    onset = onset_score(F)
    bonus = pause_bonus(F) if line_start is not None else None
    is_line = np.array(line_start, bool) if line_start is not None else None
    rel = model.predict(tokens)
    best, best_end = np.inf, e0
    for c in cands:
        if c - sf < len(tokens) * 3:
            continue
        expct = rel / rel.sum() * (c - sf)
        _, cost = dp_align(expct, sf, c, onset, sigma, alpha, bonus=bonus, is_line=is_line,
                           gamma=gamma if bonus is not None else 0, return_cost=True)
        rate = (c - sf) * HOP / units
        total = cost / len(tokens) + np.log(rate / sec_per_unit) ** 2 / (2 * tempo_sd ** 2) / len(tokens) * 30
        if total < best:
            best, best_end = total, c
    return best_end * HOP


# ---------- breath model: which words usually start right after a pause ----------
def breath_category(tokens, line_start, i):
    if i == 0:
        return 'first'
    if line_start is not None and line_start[i]:
        return 'line'
    prev = tokens[i - 1]
    return 'after_' + prev[-1] if prev else 'other'


class BreathModel:
    """P(word starts within a breath) per notation context, learned from timed hymns."""
    def __init__(self, prior_n=8):
        self.prior_n = prior_n
        self.rate = {}
        self.base = 0.2

    def fit(self, hymns):
        hits = collections.Counter(); tot = collections.Counter()
        for h in hymns:
            C = np.array([c for c, _ in pause_candidates(h['F'])]) * HOP
            for i in range(1, len(h['tokens'])):
                t = h['times'][i]
                if t is None:
                    continue
                k = breath_category(h['tokens'], h.get('line_start'), i)
                tot[k] += 1
                hits[k] += bool(np.any((t - C > -0.35) & (t - C < 0.25)))
        self.base = sum(hits.values()) / max(sum(tot.values()), 1)
        self.rate = {k: (hits[k] + self.prior_n * self.base) / (tot[k] + self.prior_n) for k in tot}
        return self

    def weights(self, tokens, line_start):
        """+1 = expect a breath before this word, 0 = neutral, negative = expect none."""
        top = max(self.rate.get('line', 0.7), self.base + 0.1)
        w = np.zeros(len(tokens))
        for i in range(1, len(tokens)):
            p = self.rate.get(breath_category(tokens, line_start, i), self.base)
            w[i] = np.clip((p - self.base) / (top - self.base), -0.5, 1.2)
        return w


# ---------- piece-level alignment (the site's v2 hit boxes) ----------
import re as _re


def hit_pieces(word):
    """Same split as site.js hazzatHitTokens: a breath mark '.' ends a piece."""
    return [p for p in _re.split(r'(?<=\.)(?=[^\s).])', word) if p]


def align_pieces(words, line_start, F, model, start=None, end=None, **kw):
    """Align every Hazzat piece; returns (word_times, piece_times, piece_word_index)."""
    pieces, owner, pline = [], [], []
    for wi, w in enumerate(words):
        for k, p in enumerate(hit_pieces(w)):
            pieces.append(p); owner.append(wi)
            pline.append(bool(line_start[wi]) and k == 0)
    pt = align(pieces, F, model, start=start, end=end, line_start=pline, **kw)
    owner = np.array(owner)
    first = np.searchsorted(owner, np.arange(len(words)))
    return pt[first], pt, owner


def find_end_pieces(words, line_start, F, model, start, sigma=0.45, alpha=0.3, gamma=1.0,
                    tempo_sd=0.25, max_cands=16):
    """Choose where the hymn ends (recordings may continue after it). For each plausible
    end (start of a pause), measure how well the notation fits; keep the best."""
    pieces, pline = [], []
    for wi, w in enumerate(words):
        for k, p in enumerate(hit_pieces(w)):
            pieces.append(p); pline.append(bool(line_start[wi]) and k == 0)
    s0, e0 = singing_span(F)
    sf = int(round(start / HOP))
    rel = model.predict(pieces)
    units = rel.sum()
    onset = onset_score(F)
    bonus = pause_bonus(F)
    bw = HazzatKey.breath_weights(pieces, pline)
    db = F['rms_db']
    lo, hi = np.percentile(db, 10), np.percentile(db, 90)
    quiet = (db - lo) / max(hi - lo, 1e-6) < 0.15
    k = int(0.4 / HOP)
    pause_starts = [i for i in range(sf + 1, e0 - k) if quiet[i] and not quiet[i - 1] and quiet[i:i + k].all()]
    # Tempo range seen in sung Coptic hymns: roughly 0.45-1.1 s per full-note unit.
    lo_end, hi_end = sf + 0.45 * units / HOP, min(e0, sf + 1.1 * units / HOP)
    cands = sorted(set([c for c in pause_starts if lo_end <= c <= hi_end] + [e0]))
    if len(cands) > max_cands:
        cands = [cands[i] for i in np.linspace(0, len(cands) - 1, max_cands).round().astype(int)]
    scored = []
    for c in cands:
        if c - sf < len(pieces) * 3:
            continue
        exp_ = rel / units * (c - sf)
        _, cost = dp_align(exp_, sf, c, onset, sigma, alpha, bonus=bonus, is_line=bw, gamma=gamma, return_cost=True)
        scored.append((cost / len(pieces), c))
    if not scored:
        return e0 * HOP
    return min(scored)[1] * HOP


def find_start_pieces(words, line_start, F, model, end, search=40.0, sigma=0.45, alpha=0.3,
                      gamma=1.0, max_cands=12):
    """Choose where the hymn starts when the recording has speech/intro before it."""
    pieces, pline = [], []
    for wi, w in enumerate(words):
        for k, p in enumerate(hit_pieces(w)):
            pieces.append(p); pline.append(bool(line_start[wi]) and k == 0)
    s0, _ = singing_span(F)
    ef = int(round(end / HOP))
    rel = model.predict(pieces)
    onset = onset_score(F)
    bonus = pause_bonus(F)
    bw = HazzatKey.breath_weights(pieces, pline)
    cands = [s0] + [c for c, _ in pause_candidates(F) if s0 < c < s0 + search / HOP and c < ef - len(pieces) * 3]
    if len(cands) > max_cands:
        cands = [cands[i] for i in np.linspace(0, len(cands) - 1, max_cands).round().astype(int)]
    scored = []
    for c in cands:
        exp_ = rel / rel.sum() * (ef - c)
        _, cost = dp_align(exp_, c, ef, onset, sigma, alpha, bonus=bonus, is_line=bw, gamma=gamma, return_cost=True)
        scored.append((cost / len(pieces), c))
    return min(scored)[1] * HOP


class LearnedKey(HazzatKey):
    """Hazzat key as the starting point, with each symbol's length corrected from hand-timed
    hymns (ridge regression pulled toward the key). Durations are measured in full-note units
    using each hymn's own pace, so different cantors and tempos compare fairly."""
    def __init__(self, ridge=6.0, **kw):
        super().__init__(**kw)
        self.ridge = ridge
        self.vals = None

    @staticmethod
    def feats(g):
        f = collections.Counter()
        if g == '.':
            f['STANDALONE_BREATH'] += 1
            return f
        for c in g:
            f['dot' if c == '.' else c] += 1
        return f

    def prior(self, sym):
        if sym == 'STANDALONE_BREATH': return 1.0
        if sym == 'dot': return self.breath
        if sym == 'A': return 1.0
        return HazzatKey.units(self, sym) if sym not in '+-' else 0.0

    def fit(self, hymns):
        rows, y = [], []
        for h in hymns:
            t, T = h['times'], h['tokens']
            plain = [(t[i + 1] - t[i]) / HazzatKey.units(self, T[i]) for i in range(len(t) - 1)
                     if t[i] is not None and t[i + 1] is not None and set(T[i]) <= set('zxcv')]
            if len(plain) < 5:
                continue
            spu = float(np.median(plain))
            for i in range(len(t) - 1):
                if t[i] is None or t[i + 1] is None:
                    continue
                rows.append(self.feats(T[i])); y.append((t[i + 1] - t[i]) / spu)
        syms = sorted({s for r in rows for s in r})
        X = np.array([[r.get(s, 0) for s in syms] for r in rows], float)
        y = np.array(y)
        p = np.array([self.prior(s) for s in syms])
        # minimise |Xv - y|^2 + ridge*|v - prior|^2, with long words down-weighted (they are noisier)
        w = 1 / np.maximum(X @ np.maximum(p, .25), 1)
        A = X.T @ (X * w[:, None]) + self.ridge * np.eye(len(syms))
        b = X.T @ (y * w) + self.ridge * p
        v = np.linalg.solve(A, b)
        self.vals = dict(zip(syms, v))
        return self

    def units(self, g):
        if self.vals is None:
            return HazzatKey.units(self, g)
        u = sum(n * self.vals.get(s, self.prior(s)) for s, n in self.feats(g).items())
        return max(u, 0.25)


# ---------- repeats written in the Hazzat: ( ... )N ----------
def notation_repeats(words):
    """[(first_word, last_word, times_sung)] from '(' ... ')N' marks. A ')N' at the start of a
    word closes the group before that word; elsewhere it closes it after that word."""
    out, stack = [], []
    for i, w in enumerate(words):
        if '(' in w:
            stack.append(i)
        m = _re.search(r"\)(\d+)", w)
        if m and stack:
            a = stack.pop()
            last = i - 1 if w.lstrip().startswith(')') else i
            if last >= a:
                out.append((a, last, int(m.group(1))))
    return sorted(out)


def sung_order(words):
    """Word indices in the order a cantor sings them (repeat groups expanded),
    with the pass number (0 = first time) for each."""
    reps = {b: (a, n) for a, b, n in notation_repeats(words)}
    seq = []
    for i in range(len(words)):
        seq.append((i, 0))
        if i in reps:
            a, n = reps[i]
            for k in range(1, n):
                seq.extend((j, k) for j in range(a, i + 1))
    return seq
