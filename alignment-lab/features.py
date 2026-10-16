"""Local audio features for alignment (numpy/scipy only, no external services).

Frame hop is 20 ms. Produces per-frame:
  rms_db   - loudness in dB
  flux     - positive spectral flux (new energy appearing: note/syllable onsets)
  f0       - pitch in Hz (0 when unvoiced), simple YIN
  voiced   - voicing confidence 0..1
"""
import json, os
import numpy as np
from scipy.signal import stft

HOP = 0.02


def load(rec_json):
    d = json.load(open(rec_json))
    pcm = np.fromfile(os.path.join(os.path.dirname(rec_json), d['audio']), dtype=np.float32)
    return d, pcm


def yin_f0(x, rate, hop_n, fmin=70, fmax=600, win=1024):
    n = 1 + (len(x) - win) // hop_n
    if n <= 0:
        return np.zeros(0), np.zeros(0)
    idx = np.arange(win)[None, :] + hop_n * np.arange(n)[:, None]
    frames = x[idx].astype(np.float64)
    frames -= frames.mean(1, keepdims=True)
    tmin, tmax = int(rate / fmax), int(rate / fmin)
    # Difference function via FFT autocorrelation.
    nfft = 2 * win
    F = np.fft.rfft(frames, nfft)
    ac = np.fft.irfft(F * np.conj(F), nfft)[:, :tmax + 1]
    energy = np.cumsum(frames ** 2, axis=1)
    e0 = energy[:, -1:]
    # d(tau) = sum x[j]^2 + sum x[j+tau]^2 - 2 ac(tau), over j < win - tau
    taus = np.arange(tmax + 1)
    left = energy[:, (win - 1 - taus).clip(0)]
    right = e0 - np.concatenate([np.zeros((n, 1)), energy[:, :tmax]], axis=1)
    d = left + right - 2 * ac
    d[:, 0] = 0
    cmnd = d[:, 1:] * np.arange(1, tmax + 1) / np.maximum(np.cumsum(d[:, 1:], axis=1), 1e-12)
    cmnd = np.concatenate([np.ones((n, 1)), cmnd], axis=1)
    sub = cmnd[:, tmin:tmax + 1]
    best = sub.argmin(1)
    conf = 1 - sub[np.arange(n), best]
    tau = best + tmin
    # Parabolic refinement.
    a = cmnd[np.arange(n), (tau - 1).clip(1)]
    b = cmnd[np.arange(n), tau]
    c = cmnd[np.arange(n), (tau + 1).clip(max=tmax)]
    denom = a - 2 * b + c
    shift = np.where(np.abs(denom) > 1e-9, 0.5 * (a - c) / denom, 0)
    f0 = rate / (tau + shift)
    return f0, conf.clip(0, 1)


def features(pcm, rate):
    hop_n = int(HOP * rate)
    win = 1024
    pad = np.concatenate([np.zeros(win // 2, np.float32), pcm, np.zeros(win, np.float32)])
    f0, conf = yin_f0(pad, rate, hop_n)
    n = len(f0)
    idx = np.arange(win)[None, :] + hop_n * np.arange(n)[:, None]
    rms = np.sqrt((pad[idx].astype(np.float64) ** 2).mean(1) + 1e-12)
    rms_db = 20 * np.log10(rms)
    _, _, Z = stft(pad, fs=rate, nperseg=win, noverlap=win - hop_n, boundary=None, padded=False)
    mag = np.log1p(100 * np.abs(Z[: win // 4]))  # up to ~2.7 kHz
    m = min(mag.shape[1], n)
    flux = np.zeros(n)
    flux[1:m] = np.maximum(mag[:, 1:m] - mag[:, : m - 1], 0).sum(0)
    voiced = conf * (rms_db > np.percentile(rms_db, 30))
    f0 = np.where(voiced > 0.75, f0, 0)
    return {'rms_db': rms_db, 'flux': flux, 'f0': f0, 'voiced': voiced, 'hop': HOP}
