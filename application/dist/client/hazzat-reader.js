/* Hazzat reader: aligns every Hazzat piece to a recording by reading the notation.
   Runs locally (worker or Node). Never publishes timings; results are suggestions for review.

   How it reads the music (developed and tested in alignment-lab/ on hand-timed hymns):
   - Note lengths come from the Hazzat font key: bottom-row letters z x c v b n m are full
     notes of length 1..7, top-row q w e r ... are half notes, 'a' is a fast transition,
     s d f ... extend a note, and '.' is a breath of about one full note.
   - A breath mark '.' or a new notation line means the next piece starts after a pause.
   - A new piece starts on a syllable: a short loudness dip and a voicing break.
   - Dynamic programming places every piece in order, then adapts to this cantor's tempo and
     to how he sings repeated notation. Start and end are found by trying pauses and keeping
     the best fit, inside the editor's clip when one is set. */
(() => {
  const HOP = 0.02;

  // ---------- small numeric helpers ----------
  function percentile(arr, p) {
    const s = Float64Array.from(arr).sort();
    if (!s.length) return 0;
    const idx = p / 100 * (s.length - 1), lo = Math.floor(idx), hi = Math.min(s.length - 1, lo + 1);
    return s[lo] + (s[hi] - s[lo]) * (idx - lo);
  }
  function robustZ(a) {
    const med = percentile(a, 50);
    const dev = new Float64Array(a.length);
    for (let i = 0; i < a.length; i++) dev[i] = Math.abs(a[i] - med);
    const mad = percentile(dev, 50) * 1.4826 + 1e-9;
    const out = new Float64Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = Math.max(-4, Math.min(4, (a[i] - med) / mad));
    return out;
  }
  function cumsum(a) {
    const c = new Float64Array(a.length + 1);
    for (let i = 0; i < a.length; i++) c[i + 1] = c[i] + a[i];
    return c;
  }
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let len = 2; len <= n; len *= 2) {
      const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
      for (let i = 0; i < n; i += len) {
        let xr = 1, xi = 0;
        for (let j = 0; j < len / 2; j++) {
          const p = i + j, q = p + len / 2, tr = re[q] * xr - im[q] * xi, ti = re[q] * xi + im[q] * xr;
          re[q] = re[p] - tr; im[q] = im[p] - ti; re[p] += tr; im[p] += ti;
          const nx = xr * wr - xi * wi; xi = xr * wi + xi * wr; xr = nx;
        }
      }
    }
  }

  // ---------- audio features (20 ms frames) ----------
  function features(pcm, rate) {
    const hop = Math.round(HOP * rate);
    let win = 1; while (win < 0.064 * rate) win *= 2;          // ~64 ms analysis window
    const pad = new Float32Array(pcm.length + win + win / 2);
    pad.set(pcm, win / 2);
    const n = Math.max(1, 1 + Math.floor((pad.length - win) / hop));
    const rmsDb = new Float64Array(n), flux = new Float64Array(n), conf = new Float64Array(n);
    const hann = Float64Array.from({ length: win }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / win));
    let wsum = 0; for (const v of hann) wsum += v;
    const nb = win / 2 + 1, maxBin = Math.min(nb, Math.floor(2700 * win / rate) + 1);
    let prevMag = new Float64Array(maxBin), mag = new Float64Array(maxBin);
    const re = new Float64Array(win), im = new Float64Array(win);
    // Simple YIN for voicing (70-600 Hz).
    const tmin = Math.max(2, Math.floor(rate / 600)), tmax = Math.min(Math.floor(rate / 70), Math.floor(win / 2) - 1);
    const W = win - tmax, d = new Float64Array(tmax + 1);
    for (let t = 0; t < n; t++) {
      const o = t * hop;
      let e = 0, m = 0;
      for (let j = 0; j < win; j++) m += pad[o + j];
      m /= win;
      for (let j = 0; j < win; j++) { const v = pad[o + j]; e += v * v; re[j] = (v) * hann[j]; im[j] = 0; }
      rmsDb[t] = 20 * Math.log10(Math.sqrt(e / win + 1e-12));
      fft(re, im);
      let f = 0;
      for (let k = 0; k < maxBin; k++) {
        mag[k] = Math.log1p(100 * Math.sqrt(re[k] * re[k] + im[k] * im[k]) / wsum);
        if (t > 0) { const df = mag[k] - prevMag[k]; if (df > 0) f += df; }
      }
      flux[t] = f;
      [prevMag, mag] = [mag, prevMag];
      // YIN cumulative-mean-normalised difference.
      let run = 0, best = 1, bestTau = tmin;
      for (let tau = 1; tau <= tmax; tau++) {
        let s = 0;
        for (let j = 0; j < W; j++) { const a = (pad[o + j] - m) - (pad[o + j + tau] - m); s += a * a; }
        run += s;
        const c = run > 0 ? s * tau / run : 1;
        if (tau >= tmin && c < best) { best = c; bestTau = tau; }
      }
      conf[t] = Math.max(0, Math.min(1, 1 - best));
    }
    const loudCut = percentile(rmsDb, 30);
    const voiced = new Uint8Array(n);
    for (let t = 0; t < n; t++) voiced[t] = conf[t] * (rmsDb[t] > loudCut ? 1 : 0) > 0.75 ? 1 : 0;
    return { rmsDb, flux, voiced, n, duration: pcm.length / rate };
  }

  // ---------- evidence ----------
  function onsetScore(F) {
    const { rmsDb, flux, voiced, n } = F;
    const zdb = robustZ(rmsDb), lf = new Float64Array(n);
    for (let i = 0; i < n; i++) lf[i] = Math.log1p(flux[i]);
    const zfl = robustZ(lf), cdb = cumsum(zdb), cfl = cumsum(zfl), cv = cumsum(voiced);
    const out = new Float64Array(n), unv = new Float64Array(n);
    let unvMean = 0;
    for (let i = 0; i < n; i++) {
      const b1 = Math.min(n, i + 8), a0 = Math.max(0, i - 4);
      unv[i] = 1 - (cv[b1] - cv[a0]) / Math.max(b1 - a0, 1);
      unvMean += unv[i];
    }
    unvMean /= n;
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - 5), hi = Math.min(n, i + 5);
      const dip = -(cdb[i + 1] - cdb[lo]) / Math.max(i + 1 - lo, 1);
      const burst = (cfl[hi] - cfl[i]) / Math.max(hi - i, 1);
      out[i] = 0.5 * dip + 0.5 * burst + 0.3 * (unv[i] - unvMean);
    }
    return out;
  }
  function quietness(F) {
    const lo = percentile(F.rmsDb, 10), hi = percentile(F.rmsDb, 90), q = new Float64Array(F.n);
    for (let i = 0; i < F.n; i++) q[i] = (F.rmsDb[i] - lo) / Math.max(hi - lo, 1e-6);
    return q;
  }
  function pauseCandidates(F, minLen = 0.12) {
    const q = quietness(F), out = [], k = Math.floor(minLen / HOP);
    for (let i = 0; i < F.n;) {
      if (q[i] < 0.15) {
        let j = i, mn = Infinity;
        while (j < F.n && q[j] < 0.15) { mn = Math.min(mn, q[j]); j++; }
        if (j - i >= k) out.push([j, 0.5 * Math.min((j - i) * HOP / 0.6, 1) + 0.5 * (1 - Math.max(mn, 0) / 0.15)]);
        i = j;
      } else i++;
    }
    return out;
  }
  function pauseBonus(F, lead = 0.06, spread = 0.2) {
    const out = new Float64Array(F.n), w = Math.floor(3 * spread / HOP);
    for (const [end, strength] of pauseCandidates(F)) {
      const c = end - Math.round(lead / HOP);
      for (let x = Math.max(0, c - w); x < Math.min(F.n, c + w + 1); x++) {
        const v = strength * Math.exp(-0.5 * ((x - c) * HOP / spread) ** 2);
        if (v > out[x]) out[x] = v;
      }
    }
    return out;
  }
  function singingSpan(F) {
    const db = F.rmsDb, p20 = percentile(db, 20), thr = p20 + 0.35 * (percentile(db, 95) - p20);
    const k = Math.floor(1.0 / HOP), loud = new Float64Array(F.n);
    for (let i = 0; i < F.n; i++) loud[i] = db[i] > thr ? 1 : 0;
    const c = cumsum(loud);
    let first = -1, last = -1;
    for (let i = 0; i < F.n; i++) {
      // centred moving average, like numpy 'same' with a k-wide box
      const a = Math.max(0, i - Math.floor(k / 2)), b = Math.min(F.n, i - Math.floor(k / 2) + k);
      if ((c[b] - c[a]) / k > 0.6) { if (first < 0) first = i; last = i; }
    }
    if (first < 0) return [0, F.n - 1];
    return [Math.max(0, first - Math.floor(k / 2)), Math.min(F.n - 1, last + Math.floor(k / 2))];
  }

  // ---------- reading the notation ----------
  const FULL = 'zxcvbnm', HALF = 'qwertyuiop', EXT = 'sdfghjkl';
  function units(glyph) {
    let u = 0;
    for (const c of glyph) {
      let i;
      if ((i = FULL.indexOf(c)) >= 0) u += i + 1;
      else if ((i = HALF.indexOf(c)) >= 0) u += 0.5 * (i + 1);
      else if (c === 'a') u += 0.25;
      else if ((i = EXT.indexOf(c)) >= 0) u += 0.5 * (i + 1);
      else if (c === '.') u += 1;
    }
    return Math.max(u, 0.25);
  }
  function breathWeights(glyphs, lineStart) {
    const w = new Float64Array(glyphs.length).fill(-0.25);
    w[0] = 0;
    for (let i = 1; i < glyphs.length; i++) if (lineStart[i] || glyphs[i - 1].endsWith('.')) w[i] = 1;
    return w;
  }

  // ---------- dynamic programming ----------
  function dpAlign(expected, start, end, onset, opt, bandFrac = 0.08, minBand = 60) {
    const { sigma, alpha, bonus, weights, gamma } = opt;
    const n = expected.length, total = end - start;
    let sum = 0; for (const e of expected) sum += e;
    const exp = Float64Array.from(expected, e => e * total / Math.max(sum, 1e-9));
    const cum = new Float64Array(n + 1); cum[0] = start;
    for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + exp[i];
    for (let i = 0; i <= n; i++) cum[i] = Math.ceil(cum[i] - 1e-9);
    const band = Math.max(minBand, Math.floor(bandFrac * total));
    const INF = 1e18, inv = 1 / (2 * sigma * sigma);
    const grid = Array.from({ length: 64 }, (_, j) => Math.exp(Math.log(0.25) + (Math.log(12) - Math.log(0.25)) * j / 63));
    let prevLo = start, prev = new Float64Array([0]);
    const backs = [];
    for (let i = 1; i <= n; i++) {
      let lo, hi;
      if (i < n) {
        const center = Math.round(cum[i]);
        lo = Math.max(start + i, center - band); hi = Math.min(end - (n - i), center + band);
        if (hi < lo) lo = hi = Math.min(Math.max(center, start + i), end);
      } else lo = hi = end;
      const width = hi - lo + 1, e = Math.max(exp[i - 1], 1);
      const ks = [...new Set(grid.map(g => Math.max(1, Math.round(e * g))))];
      const best = new Float64Array(width).fill(INF), arg = new Int32Array(width);
      const plen = prev.length;
      for (const k of ks) {
        const cost = Math.log(k / e) ** 2 * inv;
        for (let c = 0; c < width; c++) {
          const src = lo + c - k - prevLo;
          if (src < 0 || src >= plen) continue;
          const v = prev[src] + cost;
          if (v < best[c]) { best[c] = v; arg[c] = lo + c - k; }
        }
      }
      let any = false;
      for (let c = 0; c < width; c++) if (best[c] < INF / 2) { any = true; break; }
      if (!any) {
        for (let c = 0; c < width; c++) { best[c] = Math.abs(lo + c - (i < n ? cum[i] : end)); arg[c] = Math.min(Math.max(lo + c - Math.floor(e), prevLo), prevLo + plen - 1); }
      } else if (i < n) {
        const wi = weights ? weights[i] : 0;
        for (let c = 0; c < width; c++) best[c] -= alpha * onset[lo + c] + (bonus && gamma > 0 ? gamma * wi * bonus[lo + c] : 0);
      }
      backs.push([lo, arg]);
      prevLo = lo; prev = best;
    }
    const starts = new Int32Array(n);
    let cur = end;
    for (let i = n; i > 0; i--) {
      const [lo, arg] = backs[i - 1];
      const p = arg[Math.min(Math.max(cur - lo, 0), arg.length - 1)];
      starts[i - 1] = p; cur = p;
    }
    starts[0] = start;
    return { starts, cost: prev[prev.length - 1] };
  }

  function alignPieces(glyphs, lineStart, F, startSec, endSec, cache = {}) {
    const n = glyphs.length;
    const onset = cache.onset || (cache.onset = onsetScore(F));
    const bonus = cache.bonus || (cache.bonus = pauseBonus(F));
    const weights = breathWeights(glyphs, lineStart);
    const opt = { sigma: 0.45, alpha: 0.3, bonus, weights, gamma: 1.0 };
    const start = Math.round(startSec / HOP), end = Math.round(endSec / HOP);
    const rel = Float64Array.from(glyphs, units);
    let rs = 0; for (const r of rel) rs += r;
    const span = end - start;
    const base = Float64Array.from(rel, r => r / rs * span);
    let { starts } = dpAlign(base, start, end, onset, opt);
    // Learn this cantor's rhythm: identical notation sung with a shared duration factor.
    const groups = new Map();
    glyphs.forEach((g, i) => { if (!groups.has(g)) groups.set(g, []); groups.get(g).push(i); });
    let expected = base;
    for (let it = 0; it < 3; it++) {
      const ratio = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const e = i + 1 < n ? starts[i + 1] : end;
        ratio[i] = Math.log(Math.max(e - starts[i], 0.5) / Math.max(base[i], 1));
      }
      const out = Float64Array.from(base);
      for (const idx of groups.values()) {
        let m = 0; for (const i of idx) m += ratio[i]; m /= idx.length;
        const f = Math.exp(m * idx.length / (idx.length + 2));
        for (const i of idx) out[i] = base[i] * f;
      }
      let os = 0; for (const v of out) os += v;
      expected = Float64Array.from(out, v => v / os * span);
      ({ starts } = dpAlign(expected, start, end, onset, opt, 0.05, 50));
    }
    // Follow local tempo changes (smoothed over ±12 pieces), then refine.
    {
      const ratio = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const e = i + 1 < n ? starts[i + 1] : end;
        ratio[i] = Math.log(Math.max(e - starts[i], 0.5) / Math.max(expected[i], 1));
      }
      const cr = cumsum(ratio), next = new Float64Array(n);
      let ns = 0;
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - 12), b = Math.min(n, i + 13);
        next[i] = expected[i] * Math.exp((cr[b] - cr[a]) / (b - a)); ns += next[i];
      }
      for (let i = 0; i < n; i++) next[i] = next[i] / ns * span;
      ({ starts } = dpAlign(next, start, end, onset, opt, 0.03, 40));
    }
    return Array.from(starts, s => Math.round(s * HOP * 100) / 100);
  }

  function fitCost(glyphs, lineStart, F, start, end, cache) {
    const rel = Float64Array.from(glyphs, units);
    const opt = { sigma: 0.45, alpha: 0.3, bonus: cache.bonus, weights: breathWeights(glyphs, lineStart), gamma: 1.0 };
    return dpAlign(rel, start, end, cache.onset, opt).cost / glyphs.length;
  }
  function pick(list, max) {
    if (list.length <= max) return list;
    return Array.from({ length: max }, (_, j) => list[Math.round(j * (list.length - 1) / (max - 1))]);
  }
  function findEnd(glyphs, lineStart, F, startSec, cache) {
    const [, e0] = singingSpan(F), sf = Math.round(startSec / HOP), n = glyphs.length;
    let total = 0; for (const g of glyphs) total += units(g);
    const q = quietness(F), k = Math.floor(0.4 / HOP), cands = new Set([e0]);
    const loEnd = sf + 0.45 * total / HOP, hiEnd = Math.min(e0, sf + 1.1 * total / HOP);
    for (let i = sf + 1; i < e0 - k; i++) {
      if (q[i] < 0.15 && q[i - 1] >= 0.15 && i >= loEnd && i <= hiEnd) {
        let ok = true; for (let j = i; j < i + k; j++) if (q[j] >= 0.15) { ok = false; break; }
        if (ok) cands.add(i);
      }
    }
    let best = [Infinity, e0];
    for (const c of pick([...cands].sort((a, b) => a - b), 16)) {
      if (c - sf < n * 3) continue;
      const s = fitCost(glyphs, lineStart, F, sf, c, cache);
      if (s < best[0] || (s === best[0] && c < best[1])) best = [s, c];
    }
    return best[1] * HOP;
  }
  function findStart(glyphs, lineStart, F, endSec, cache, search = 40) {
    const [s0] = singingSpan(F), ef = Math.round(endSec / HOP), n = glyphs.length;
    const cands = [s0, ...pauseCandidates(F).map(c => c[0]).filter(c => c > s0 && c < s0 + search / HOP && c < ef - n * 3)];
    let best = [Infinity, s0];
    for (const c of pick(cands, 12)) {
      const s = fitCost(glyphs, lineStart, F, c, ef, cache);
      if (s < best[0] || (s === best[0] && c < best[1])) best = [s, c];
    }
    return best[1] * HOP;
  }

  /* glyphs: Hazzat text of each piece (site hit boxes, in order); lineStart: true where a piece
     begins a notation line; clip: optional {start, end} seconds set by the editor. */
  function read({ pcm, rate, glyphs, lineStart, clip, start, end }) {
    if (!glyphs?.length) throw new Error('Add Hazzat first.');
    const F = features(pcm, rate);
    if (percentile(F.rmsDb, 90) < -80) throw new Error('This recording is silent or too quiet to align.');
    const cache = {};
    cache.onset = onsetScore(F); cache.bonus = pauseBonus(F);
    const ls = glyphs.map((_, i) => Boolean(lineStart?.[i]));
    let s = Number.isFinite(start) ? start : Math.max(clip?.start || 0, singingSpan(F)[0] * HOP);
    let e = end;
    if (!Number.isFinite(e)) {
      e = findEnd(glyphs, ls, F, s, cache);
      if (Number.isFinite(clip?.end)) e = Math.min(e, clip.end);
      if (!Number.isFinite(start)) s = Math.max(s, findStart(glyphs, ls, F, e, cache));
    }
    e = Math.min(e, F.duration - 0.05);
    if (e - s < glyphs.length * 0.06) throw new Error('The recording is too short for this much Hazzat.');
    const times = alignPieces(glyphs, ls, F, s, e, cache);
    return { times, duration: Math.round(F.duration * 100) / 100, start: s, end: e };
  }

  const api = { read, features, units, breathWeights, singingSpan, pauseCandidates, HOP };
  if (typeof module !== 'undefined') module.exports = api;
  globalThis.HazzatReader = api;
})();
