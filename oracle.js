/* ════════════════════════════════════════════════════════════════════════════
 * CryptoScope Oracle — client-side quantitative analytics engine.
 *
 * Pure functions, no DOM, no network. Given an array of OHLC candles it derives:
 *   • Trend / momentum / volatility indicators
 *   • Hurst exponent (persistence vs mean reversion) & regime classification
 *   • Risk metrics: annualized vol, historical VaR/CVaR, max drawdown, Sharpe, Sortino
 *   • Distribution stats: skewness, excess kurtosis, lag-1 autocorrelation, Z-score
 *   • A Monte-Carlo GBM forecast → probability cone + terminal distribution
 *   • A fused, weighted composite "verdict" (0–100) with a confidence estimate
 *
 * Everything is computed from price (and, where available, derived) series, so it
 * runs anywhere with zero dependencies.
 * ════════════════════════════════════════════════════════════════════════════ */
const Oracle = (function () {
  'use strict';

  /* ── basic stats ─────────────────────────────────────────────────────────── */
  const sum   = a => a.reduce((x, y) => x + y, 0);
  const mean  = a => (a.length ? sum(a) / a.length : 0);
  function std(a, m) {
    if (a.length < 2) return 0;
    m = (m == null) ? mean(a) : m;
    return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
  }
  function skewness(a) {
    const m = mean(a), s = std(a, m), n = a.length;
    if (!s || n < 3) return 0;
    return a.reduce((acc, x) => acc + ((x - m) / s) ** 3, 0) / n;
  }
  function kurtosis(a) { // excess kurtosis (normal = 0)
    const m = mean(a), s = std(a, m), n = a.length;
    if (!s || n < 4) return 0;
    return a.reduce((acc, x) => acc + ((x - m) / s) ** 4, 0) / n - 3;
  }
  function quantile(sorted, q) {
    if (!sorted.length) return 0;
    const idx = (sorted.length - 1) * q, lo = Math.floor(idx), hi = Math.ceil(idx);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }
  function logReturns(c) {
    const r = [];
    for (let i = 1; i < c.length; i++) if (c[i - 1] > 0 && c[i] > 0) r.push(Math.log(c[i] / c[i - 1]));
    return r;
  }
  function simpleReturns(c) {
    const r = [];
    for (let i = 1; i < c.length; i++) if (c[i - 1]) r.push(c[i] / c[i - 1] - 1);
    return r;
  }
  function linregSlope(xs, ys) {
    const n = xs.length;
    let sx = 0, sy = 0, sxy = 0, sx2 = 0;
    for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxy += xs[i] * ys[i]; sx2 += xs[i] * xs[i]; }
    const d = n * sx2 - sx * sx;
    return d ? (n * sxy - sx * sy) / d : 0;
  }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /* ── indicators ──────────────────────────────────────────────────────────── */
  function emaSeries(vals, period) {
    const out = new Array(vals.length).fill(null);
    if (vals.length < period) return out;
    const k = 2 / (period + 1);
    let prev = mean(vals.slice(0, period));
    out[period - 1] = prev;
    for (let i = period; i < vals.length; i++) { prev = vals[i] * k + prev * (1 - k); out[i] = prev; }
    return out;
  }

  function rsi(c, p = 14) {
    if (c.length < p + 1) return null;
    let gain = 0, loss = 0;
    for (let i = 1; i <= p; i++) { const d = c[i] - c[i - 1]; if (d >= 0) gain += d; else loss -= d; }
    gain /= p; loss /= p;
    for (let i = p + 1; i < c.length; i++) {
      const d = c[i] - c[i - 1];
      gain = (gain * (p - 1) + Math.max(d, 0)) / p;
      loss = (loss * (p - 1) + Math.max(-d, 0)) / p;
    }
    if (loss === 0) return 100;
    return 100 - 100 / (1 + gain / loss);
  }

  function macd(c, f = 12, s = 26, sig = 9) {
    if (c.length < s + sig) return null;
    const ef = emaSeries(c, f), es = emaSeries(c, s);
    const macdLine = [];
    for (let i = 0; i < c.length; i++) if (ef[i] != null && es[i] != null) macdLine.push(ef[i] - es[i]);
    if (macdLine.length < sig) return null;
    const sigLine = emaSeries(macdLine, sig);
    const m = macdLine[macdLine.length - 1];
    const sg = sigLine[sigLine.length - 1];
    return { macd: m, signal: sg, hist: m - sg };
  }

  function bollinger(c, p = 20, k = 2) {
    if (c.length < p) return null;
    const slice = c.slice(-p), m = mean(slice), sd = std(slice, m);
    const price = c[c.length - 1], upper = m + k * sd, lower = m - k * sd;
    return { mid: m, upper, lower, pctB: (price - lower) / ((upper - lower) || 1), bandwidth: (upper - lower) / (m || 1) };
  }

  function stochastic(h, l, c, p = 14) {
    if (c.length < p) return null;
    const hh = Math.max(...h.slice(-p)), ll = Math.min(...l.slice(-p));
    return { k: (c[c.length - 1] - ll) / ((hh - ll) || 1) * 100 };
  }

  function atr(h, l, c, p = 14) {
    if (c.length < p + 1) return null;
    const tr = [];
    for (let i = 1; i < c.length; i++)
      tr.push(Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
    let a = mean(tr.slice(0, p));
    for (let i = p; i < tr.length; i++) a = (a * (p - 1) + tr[i]) / p;
    return a;
  }

  /* Hurst exponent via rescaled-range (R/S) analysis across chunk sizes.
     H > 0.5 → persistent/trending · H < 0.5 → anti-persistent/mean-reverting. */
  function hurst(series) {
    const N = series.length;
    if (N < 32) return 0.5;
    const xs = [], ys = [];
    for (let size = 8; size <= Math.floor(N / 2); size = Math.floor(size * 1.6)) {
      const chunks = Math.floor(N / size);
      let rsAcc = 0, cnt = 0;
      for (let ci = 0; ci < chunks; ci++) {
        const chunk = series.slice(ci * size, (ci + 1) * size);
        const m = mean(chunk);
        let cum = 0, mx = -Infinity, mn = Infinity;
        for (const v of chunk) { cum += v - m; if (cum > mx) mx = cum; if (cum < mn) mn = cum; }
        const R = mx - mn, S = std(chunk, m);
        if (S > 0) { rsAcc += R / S; cnt++; }
      }
      if (cnt) { xs.push(Math.log(size)); ys.push(Math.log(rsAcc / cnt)); }
    }
    if (xs.length < 2) return 0.5;
    return clamp(linregSlope(xs, ys), 0, 1);
  }

  function autocorr(series, lag = 1) {
    const n = series.length;
    if (n <= lag + 1) return 0;
    const m = mean(series);
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { den += (series[i] - m) ** 2; if (i >= lag) num += (series[i] - m) * (series[i - lag] - m); }
    return den ? num / den : 0;
  }

  function maxDrawdown(c) {
    let peak = c[0], mdd = 0;
    for (const v of c) { if (v > peak) peak = v; const dd = (v - peak) / peak; if (dd < mdd) mdd = dd; }
    return mdd; // negative fraction
  }

  /* Significant price levels via fractal pivots, clustered near current price. */
  function pivotLevels(h, l, c, w = 3) {
    const price = c[c.length - 1], res = [], sup = [];
    for (let i = w; i < c.length - w; i++) {
      let isHigh = true, isLow = true;
      for (let j = i - w; j <= i + w; j++) { if (h[j] > h[i]) isHigh = false; if (l[j] < l[i]) isLow = false; }
      if (isHigh && h[i] > price) res.push(h[i]);
      if (isLow && l[i] < price) sup.push(l[i]);
    }
    const dedupe = (arr, dir) => {
      arr.sort((a, b) => dir * (a - b));
      const out = [];
      for (const v of arr) { if (!out.some(x => Math.abs(x - v) / price < 0.012)) out.push(v); if (out.length >= 3) break; }
      return out;
    };
    return { resistances: dedupe(res, 1), supports: dedupe(sup, -1) };
  }

  /* ── Monte-Carlo GBM simulation ──────────────────────────────────────────── */
  let _spare = null;
  function gauss() { // Box-Muller with cached spare
    if (_spare != null) { const v = _spare; _spare = null; return v; }
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    const r = Math.sqrt(-2 * Math.log(u)), th = 2 * Math.PI * v;
    _spare = r * Math.sin(th);
    return r * Math.cos(th);
  }

  function monteCarlo(closes, horizon, paths) {
    const r = logReturns(closes);
    const mu = mean(r), sigma = std(r) || 1e-6;
    const S0 = closes[closes.length - 1];
    const stepVals = Array.from({ length: horizon + 1 }, () => []);
    const terminals = [], maxRets = [], minRets = [];
    for (let p = 0; p < paths; p++) {
      let logCum = 0, mx = 0, mn = 0;
      stepVals[0].push(S0);
      for (let t = 1; t <= horizon; t++) {
        logCum += mu + sigma * gauss();           // empirical drift already nets the -½σ² term
        stepVals[t].push(S0 * Math.exp(logCum));
        if (logCum > mx) mx = logCum;
        if (logCum < mn) mn = logCum;
      }
      terminals.push(S0 * Math.exp(logCum));
      maxRets.push(Math.exp(mx) - 1);
      minRets.push(Math.exp(mn) - 1);
    }
    const cone = stepVals.map(arr => {
      arr.sort((a, b) => a - b);
      return { p5: quantile(arr, .05), p25: quantile(arr, .25), p50: quantile(arr, .5), p75: quantile(arr, .75), p95: quantile(arr, .95) };
    });
    terminals.sort((a, b) => a - b);
    return { mu, sigma, S0, horizon, paths, cone, terminals, maxRets, minRets };
  }

  /* ── signal scoring helpers ──────────────────────────────────────────────── */
  function sig(key, name, score, detail) { return { key, name, score: clamp(score, -1, 1), detail }; }

  /* ── public: full analysis ───────────────────────────────────────────────── */
  function analyze(candles, opts = {}) {
    const closes = candles.map(d => d.c);
    const highs  = candles.map(d => d.h);
    const lows   = candles.map(d => d.l);
    const times  = candles.map(d => d.t);
    const n = closes.length;
    if (n < 30) return null;

    // bar duration from the median timestamp delta → robust annualization
    const diffs = [];
    for (let i = 1; i < times.length; i++) diffs.push(times[i] - times[i - 1]);
    diffs.sort((a, b) => a - b);
    const barMs = diffs[Math.floor(diffs.length / 2)] || 3600000;
    const barsPerYear = (365.25 * 24 * 3600 * 1000) / barMs;

    const lr = logReturns(closes);
    const sr = simpleReturns(closes);
    const muBar = mean(lr), sdBar = std(lr) || 1e-6;
    const price = closes[n - 1];

    // indicators
    const e20s = emaSeries(closes, Math.min(20, n));
    const e50s = emaSeries(closes, Math.min(50, n));
    const e20 = e20s[n - 1], e50 = e50s[n - 1];
    const slopePct = (() => {
      const look = Math.min(20, n - 1);
      const xs = [], ys = [];
      for (let i = n - look; i < n; i++) { xs.push(i); ys.push(closes[i]); }
      return linregSlope(xs, ys) / price * 100; // % per bar
    })();
    const rsiV = rsi(closes);
    const macdV = macd(closes);
    const bbV = bollinger(closes);
    const stochV = stochastic(highs, lows, closes);
    const atrV = atr(highs, lows, closes);
    const atrPct = atrV != null ? atrV / price * 100 : null;

    // statistics
    const H = hurst(lr);
    const skew = skewness(lr);
    const kurt = kurtosis(lr);
    const ac1 = autocorr(lr, 1);
    const zLook = Math.min(20, n);
    const zSlice = closes.slice(-zLook);
    const zMean = mean(zSlice), zStd = std(zSlice, zMean) || 1e-9;
    const zScore = (price - zMean) / zStd;

    // risk
    const annVol = sdBar * Math.sqrt(barsPerYear);
    const annRet = muBar * barsPerYear;
    const srSorted = sr.slice().sort((a, b) => a - b);
    const var95 = -quantile(srSorted, 0.05);                       // 1-bar 95% VaR (positive = loss)
    const tail = srSorted.filter(x => x <= -var95);
    const cvar95 = tail.length ? -mean(tail) : var95;              // expected shortfall
    const mdd = maxDrawdown(closes);
    const downside = sr.filter(x => x < 0);
    const sharpe = sdBar ? muBar / sdBar * Math.sqrt(barsPerYear) : 0;
    const sortino = downside.length ? muBar / (std(downside) || 1e-9) * Math.sqrt(barsPerYear) : 0;

    // Monte Carlo
    const horizon = clamp(Math.round(n * 0.2), 12, 60);
    const paths = opts.paths || 3000;
    const mc = monteCarlo(closes, horizon, paths);

    // forecast probabilities
    const term = mc.terminals, N = term.length;
    const pUp = term.filter(v => v > price).length / N;
    const expRet = mean(term) / price - 1;
    const medRet = quantile(term, 0.5) / price - 1;
    const rangeLo = quantile(term, 0.05) / price - 1;
    const rangeHi = quantile(term, 0.95) / price - 1;
    const sigH = sdBar * Math.sqrt(horizon); // horizon sigma (log)
    const pTermAbove = pct => term.filter(v => v >= price * (1 + pct / 100)).length / N;
    const pTermBelow = pct => term.filter(v => v <= price * (1 - pct / 100)).length / N;
    const pTouchUp = pct => mc.maxRets.filter(v => v * 100 >= pct).length / N;
    const pTouchDn = pct => mc.minRets.filter(v => v * 100 <= -pct).length / N;
    const t1 = +(sigH * 100).toFixed(1);                  // ~1σ horizon move in %
    const targets = [
      { label: `+${t1}% (1σ)`, p: pTermAbove(t1), touch: pTouchUp(t1), dir: 1 },
      { label: `−${t1}% (1σ)`, p: pTermBelow(t1), touch: pTouchDn(t1), dir: -1 },
      { label: '+5%',  p: pTermAbove(5),  touch: pTouchUp(5),  dir: 1 },
      { label: '−5%',  p: pTermBelow(5),  touch: pTouchDn(5),  dir: -1 },
      { label: '+10%', p: pTermAbove(10), touch: pTouchUp(10), dir: 1 },
      { label: '−10%', p: pTermBelow(10), touch: pTouchDn(10), dir: -1 },
    ];

    // ── signals (each scored -1..1) ──
    const signals = [];
    // trend: EMA cross + price vs EMA50
    let trendScore = 0;
    if (e20 != null && e50 != null) trendScore += clamp((e20 - e50) / (e50 || 1) / 0.02, -1, 1) * 0.6;
    if (e50 != null) trendScore += clamp((price - e50) / (e50 || 1) / 0.03, -1, 1) * 0.4;
    signals.push(sig('trend', 'Trend (EMA 20/50)', trendScore,
      e20 != null && e50 != null ? (e20 > e50 ? 'Fast EMA above slow — uptrend' : 'Fast EMA below slow — downtrend') : 'n/a'));
    // slope
    signals.push(sig('slope', 'Regression slope', clamp(slopePct / 0.5, -1, 1),
      `${slopePct >= 0 ? '+' : ''}${slopePct.toFixed(3)}% / bar`));
    // MACD histogram
    if (macdV) signals.push(sig('macd', 'MACD histogram', clamp(macdV.hist / (price * 0.01), -1, 1),
      `${macdV.hist >= 0 ? 'Positive' : 'Negative'} momentum`));
    // RSI (distance from 50, but extreme overbought/oversold fades)
    if (rsiV != null) {
      let rScore = (rsiV - 50) / 30;
      if (rsiV > 72) rScore = -((rsiV - 72) / 28) * 0.6;   // overbought → fade
      if (rsiV < 28) rScore =  ((28 - rsiV) / 28) * 0.6;   // oversold → bounce
      signals.push(sig('rsi', 'RSI (14)', clamp(rScore, -1, 1), `${rsiV.toFixed(1)} ${rsiV > 70 ? '· overbought' : rsiV < 30 ? '· oversold' : ''}`));
    }
    // Stochastic
    if (stochV) signals.push(sig('stoch', 'Stochastic %K', clamp((stochV.k - 50) / 50 * (stochV.k > 80 || stochV.k < 20 ? -0.7 : 1), -1, 1),
      `${stochV.k.toFixed(1)}`));
    // Bollinger %B
    if (bbV) signals.push(sig('boll', 'Bollinger %B', clamp((0.5 - bbV.pctB) / 0.5 * 0.8, -1, 1),
      `%B ${bbV.pctB.toFixed(2)} · band ${(bbV.bandwidth * 100).toFixed(1)}%`));
    // Z-score mean reversion
    signals.push(sig('z', 'Z-score (mean rev.)', clamp(-zScore / 2.5, -1, 1),
      `${zScore >= 0 ? '+' : ''}${zScore.toFixed(2)}σ from mean`));
    // Hurst-weighted momentum: if persistent, trust the drift; if mean-reverting, fade it
    const driftScore = clamp(mc.mu / sdBar, -1, 1);
    const hAdj = (H - 0.5) * 2; // -1..1
    signals.push(sig('mc', 'MC drift × Hurst', clamp(driftScore * (0.5 + 0.5 * Math.sign(hAdj) * Math.abs(hAdj)), -1, 1),
      `μ ${(mc.mu * 100).toFixed(3)}%/bar · H ${H.toFixed(2)}`));

    // ── composite verdict ──
    // Weighted fusion. The score is the net direction; confidence is a separate
    // read of how much the signals AGREE and how strong they are (so it isn't
    // just a restatement of |score-50|).
    const weights = { trend: 1.4, slope: 0.9, macd: 1.0, rsi: 0.9, stoch: 0.6, boll: 0.7, z: 0.8, mc: 1.3 };
    let wSum = 0, wAbs = 0, wSign = 0, wMag = 0;
    for (const s of signals) {
      const w = weights[s.key] || 1;
      wSum  += w * s.score;
      wAbs  += w;
      wSign += w * Math.sign(s.score);   // directional vote
      wMag  += w * Math.abs(s.score);    // conviction
    }
    const norm = wAbs ? wSum / wAbs : 0;            // -1..1 → drives the score
    const score100 = Math.round(clamp(50 + norm * 50, 0, 100));

    const agreement = wAbs ? Math.abs(wSign) / wAbs : 0;   // 0..1 directional consensus
    const strength  = wAbs ? wMag / wAbs : 0;              // 0..1 average signal conviction
    const dataFactor = clamp(n / 150, 0.5, 1);            // more candles → steadier read
    const confidence = Math.round(clamp((0.55 * agreement + 0.45 * strength) * dataFactor * 100, 5, 95));
    const label =
      score100 >= 72 ? 'Strongly Bullish' :
      score100 >= 60 ? 'Bullish' :
      score100 >= 54 ? 'Lean Bullish' :
      score100 >  46 ? 'Neutral' :
      score100 >  40 ? 'Lean Bearish' :
      score100 >  28 ? 'Bearish' : 'Strongly Bearish';

    // ── regime ──
    const volMed = (() => {
      const absr = sr.map(Math.abs).sort((a, b) => a - b);
      return quantile(absr, 0.5);
    })();
    const curVol = Math.abs(sr[sr.length - 1] || 0);
    const persistence = H > 0.55 ? 'Persistent / trending' : H < 0.45 ? 'Mean-reverting' : 'Random walk';
    const dir = norm > 0.12 ? 'up' : norm < -0.12 ? 'down' : 'sideways';
    const volState = annVol > 1.2 ? 'extreme' : annVol > 0.8 ? 'high' : annVol > 0.4 ? 'moderate' : 'low';
    const regime = { persistence, dir, volState, label: `${persistence} · ${volState} vol · biased ${dir}` };

    return {
      meta: { bars: n, barMs, barsPerYear, horizon, price, generatedAt: Date.now() },
      trend: { e20, e50, slopePct },
      momentum: { rsi: rsiV, macd: macdV, stoch: stochV ? stochV.k : null },
      volatility: { annVol, atr: atrV, atrPct, bollinger: bbV },
      stats: { hurst: H, skew, kurtosis: kurt, autocorr: ac1, zScore },
      risk: { var95, cvar95, maxDrawdown: mdd, sharpe, sortino, annRet },
      regime,
      signals,
      composite: { score: score100, label, confidence, norm },
      mc,
      probs: { pUp, expRet, medRet, rangeLo, rangeHi, sigH, targets },
      levels: pivotLevels(highs, lows, closes),
    };
  }

  return { analyze };
})();

// Expose as a global property so other scripts can feature-detect via window.Oracle.
if (typeof window !== 'undefined') window.Oracle = Oracle;
