"""Fine snapping: move each piece start onto the exact moment an editor would tap.

A small logistic model learns, from hand-timed hymns, what a tap moment sounds like at 10 ms
resolution (consonant noise, vowel attack, change of sound, end of a breath). Each coarse piece
start then moves to the best-scoring nearby frame, keeping the pieces in order.
"""
import numpy as np
from scipy.signal import stft
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

FH = 0.01


def fine_features(pcm, rate):
    hop = int(round(FH * rate)); win = 1024 if rate > 8000 else 256
    f, _, Z = stft(pcm, fs=rate, nperseg=win, noverlap=win - hop, boundary=None, padded=False)
    S = np.abs(Z) + 1e-9
    L = np.log(S)
    bands = {'low': (f >= 80) & (f < 600), 'mid': (f >= 600) & (f < 1800), 'high': f >= 1800}
    base = {}
    for k, m in bands.items():
        if m.any():
            base['e_' + k] = np.log((S[m] ** 2).sum(0) + 1e-9)
    base['e_all'] = np.log((S ** 2).sum(0) + 1e-9)
    Ln = L - L.mean(0, keepdims=True)
    Ln = Ln / (np.linalg.norm(Ln, axis=0, keepdims=True) + 1e-9)
    n = L.shape[1]
    for lag in (2, 5, 10):
        c = np.zeros(n); c[lag:] = 1 - (Ln[:, lag:] * Ln[:, :-lag]).sum(0)
        base['chg%d' % lag] = c
    flux = np.maximum(np.diff(L, axis=1, prepend=L[:, :1]), 0)
    for k, m in bands.items():
        if m.any():
            base['flux_' + k] = flux[m].mean(0)
    # high-band share (sibilants/consonants)
    if 'e_high' in base:
        base['hi_share'] = base['e_high'] - base['e_all']
    feats = {}
    for k, v in base.items():
        v = (v - np.median(v)) / (np.std(v) + 1e-9)
        feats[k] = v
        c = np.concatenate([[0], np.cumsum(v)])
        i = np.arange(n)
        for w in (3, 8, 20):
            lo, hi = (i - w).clip(0), (i + w).clip(max=n)
            before = (c[i] - c[lo]) / np.maximum(i - lo, 1)
            after = (c[hi] - c[i]) / np.maximum(hi - i, 1)
            feats[f'{k}_d{w}'] = after - before
            if k.startswith('e_'):
                feats[f'{k}_b{w}'] = before
                feats[f'{k}_a{w}'] = after
    names = sorted(feats)
    X = np.stack([feats[k] for k in names], 1)
    # Put frames on an exact 10 ms grid: stft frame j is centred at (win/2 + j*hop)/rate seconds,
    # and hop*rate is rarely exactly 10 ms, so map by time instead of by frame count.
    src_t = (win / 2 + np.arange(X.shape[0]) * hop) / rate
    grid = np.arange(int(len(pcm) / rate / FH)) * FH
    X = np.stack([np.interp(grid, src_t, X[:, j]) for j in range(X.shape[1])], 1)
    return X, names


class TapModel:
    def __init__(self, C=0.3):
        self.scaler = StandardScaler(); self.clf = LogisticRegression(C=C, max_iter=2000)

    def fit(self, items, pos_tol=0.02, neg_min=0.08, neg_max=0.8, seed=0):
        """items: [(X, true_times)]"""
        rng = np.random.default_rng(seed)
        Xs, ys = [], []
        for X, times in items:
            n = len(X)
            for t in times:
                if t is None:
                    continue
                c = int(round(t / FH))
                for d in range(-int(pos_tol / FH), int(pos_tol / FH) + 1):
                    if 0 <= c + d < n:
                        Xs.append(X[c + d]); ys.append(1)
                offs = rng.integers(int(neg_min / FH), int(neg_max / FH), 6) * rng.choice([-1, 1], 6)
                for d in offs:
                    if 0 <= c + d < n:
                        Xs.append(X[c + d]); ys.append(0)
        Xs = np.array(Xs); ys = np.array(ys)
        self.clf.fit(self.scaler.fit_transform(Xs), ys)
        return self

    def score(self, X):
        return self.clf.decision_function(self.scaler.transform(X))


def snap(coarse, X, model, window=0.6, prior_sd=0.3, prior_w=1.0, min_gap=0.08, fixed_first=False):
    """Move each start to argmax(tap score + Gaussian prior around coarse), in order (DP)."""
    s = model.score(X)
    n = len(s)
    W = int(window / FH)
    cands, vals = [], []
    for k, t in enumerate(coarse):
        c = int(round(t / FH))
        idx = np.arange(max(0, c - W), min(n, c + W + 1))
        if fixed_first and k == 0:
            idx = np.array([min(max(c, 0), n - 1)])
        v = s[idx] - prior_w * ((idx - c) * FH / prior_sd) ** 2 / 2
        cands.append(idx); vals.append(v)
    gap = int(min_gap / FH)
    # Viterbi: maximise total score with strictly increasing starts (>= min_gap apart)
    best = vals[0].copy(); back = []
    for k in range(1, len(coarse)):
        pi, ci = cands[k - 1], cands[k]
        # prefix max over previous candidates whose position <= ci - gap
        order = np.argsort(pi)
        pm = np.maximum.accumulate(best[order]); pa = order[np.maximum.accumulate(
            np.where(best[order] == pm, np.arange(len(order)), 0))]
        j = np.searchsorted(pi[order], ci - gap, side='right') - 1
        ok = j >= 0
        cur = np.full(len(ci), -np.inf); arg = np.zeros(len(ci), int)
        cur[ok] = pm[j[ok]] + vals[k][ok]; arg[ok] = pa[j[ok]]
        if not ok.any():  # fall back: keep coarse
            cur = vals[k] - 1e6; arg[:] = int(np.argmax(best))
        back.append(arg); best = cur
    out = np.zeros(len(coarse)); i = int(np.argmax(best))
    for k in range(len(coarse) - 1, -1, -1):
        out[k] = cands[k][i] * FH
        if k:
            i = back[k - 1][i]
    return out
