/* ════════════════════════════════════════════════════════════════════════════
 * CryptoScope Seasonal — cycle / seasonality analysis from long daily history.
 *
 * Two modes:
 *   • Bitcoin → 4-year halving cycle (aligns each cycle by days-since-halving)
 *   • Everything else → annual cycle (aligns each year by day-of-year)
 *
 * For each completed cycle it builds a normalized cumulative-return path, averages
 * them into a "typical path", overlays the current (in-progress) cycle, and
 * projects the rest of the current cycle from where we are now → a price target.
 * Also computes month-of-year seasonality.
 *
 * Pure functions, no DOM/network. Input: [{t, price}] daily ascending.
 * ════════════════════════════════════════════════════════════════════════════ */
const Seasonal = (function () {
  'use strict';
  const DAY = 86400000;
  const G = 100;                       // resample grid resolution (0..1 of cycle)

  // Bitcoin halving dates (UTC). Last entry is the *next* (approx) halving.
  const BTC_HALVINGS = [
    Date.parse('2012-11-28'), Date.parse('2016-07-09'),
    Date.parse('2020-05-11'), Date.parse('2024-04-20'),
    Date.parse('2028-04-15'),
  ];
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  const mean = a => a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0;
  const std  = a => { if (a.length<2) return 0; const m=mean(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1)); };

  function dayOfYear(ts) {
    const d = new Date(ts);
    return (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(),0,0)) / DAY;
  }
  function cumReturns(prices) { const p0 = prices[0]; return prices.map(p => p / p0 - 1); }

  function interp(xs, ys, x) {
    const n = xs.length;
    if (x < xs[0] || x > xs[n-1]) return null;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo+hi)>>1; if (xs[mid] <= x) lo = mid; else hi = mid; }
    const t = (x - xs[lo]) / ((xs[hi]-xs[lo]) || 1);
    return ys[lo] + (ys[hi]-ys[lo]) * t;
  }
  function resample(seg) {
    const out = new Array(G).fill(null);
    for (let i = 0; i < G; i++) out[i] = interp(seg.x, seg.v, i/(G-1));
    return out;
  }

  function annualSegments(history) {
    const byYear = {};
    for (const d of history) { const y = new Date(d.t).getUTCFullYear(); (byYear[y] = byYear[y] || []).push(d); }
    const segs = [];
    for (const y of Object.keys(byYear).sort()) {
      const arr = byYear[y];
      if (arr.length < 20) continue;
      segs.push({ label: y, x: arr.map(d => dayOfYear(d.t)/366), v: cumReturns(arr.map(d=>d.price)), startT: arr[0].t });
    }
    return segs;
  }
  function halvingSegments(history) {
    const segs = [];
    for (let i = 0; i < BTC_HALVINGS.length - 1; i++) {
      const start = BTC_HALVINGS[i], end = BTC_HALVINGS[i+1];
      const arr = history.filter(d => d.t >= start && d.t < end);
      if (arr.length < 40) continue;
      segs.push({ label: `${new Date(start).getUTCFullYear()} cycle`, x: arr.map(d => (d.t-start)/(end-start)), v: cumReturns(arr.map(d=>d.price)), startT: start });
    }
    return segs;
  }

  function monthlySeasonality(history) {
    const groups = {};
    for (const d of history) { const dt = new Date(d.t); const k = dt.getUTCFullYear()+'-'+dt.getUTCMonth(); (groups[k] = groups[k] || []).push(d.price); }
    const byMonth = Array.from({length:12}, () => []);
    for (const k of Object.keys(groups)) { const m = +k.split('-')[1]; const a = groups[k]; if (a.length>1) byMonth[m].push(a[a.length-1]/a[0]-1); }
    return byMonth.map((a,m) => ({ m, label: MONTHS[m], avg: mean(a), n: a.length }));
  }

  function analyze(history, opts = {}) {
    if (!Array.isArray(history) || history.length < 220) return null;   // need ~9+ months
    const isBTC = !!opts.isBTC;
    const mode = isBTC ? 'halving' : 'annual';
    const segs = isBTC ? halvingSegments(history) : annualSegments(history);
    if (segs.length < 2) return null;

    const current = segs[segs.length - 1];
    const completed = segs.slice(0, -1).filter(s => Math.max(...s.x) >= 0.9);
    if (completed.length < 1) return null;

    const past = completed.map(resample);
    const curR = resample(current);
    const nowFrac = Math.max(...current.x);
    let nowIdx = Math.min(G-1, Math.max(1, Math.round(nowFrac*(G-1))));

    // average "typical" path across completed cycles
    const avg = new Array(G).fill(null);
    for (let i = 0; i < G; i++) {
      const vals = past.map(p => p[i]).filter(v => v != null);
      if (vals.length) avg[i] = mean(vals);
    }
    while (nowIdx > 0 && avg[nowIdx] == null) nowIdx--;

    // current anchor value (last known point of the in-progress cycle)
    let curAnchor = null;
    for (let i = nowIdx; i >= 0; i--) if (curR[i] != null) { curAnchor = curR[i]; break; }
    if (curAnchor == null) curAnchor = 0;

    // projection: continue along the typical path, anchored to where we are
    const proj = new Array(G).fill(null);
    if (avg[nowIdx] != null) for (let i = nowIdx; i < G; i++) if (avg[i] != null) proj[i] = curAnchor + (avg[i] - avg[nowIdx]);

    const currentPrice = history[history.length-1].price;
    const targetPct   = (avg[nowIdx] != null && avg[G-1] != null) ? (1+avg[G-1])/(1+avg[nowIdx]) - 1 : 0;
    const targetPrice = currentPrice * (1 + targetPct);

    // y-range across everything drawn
    let yMin = Infinity, yMax = -Infinity;
    const scan = arr => arr.forEach(v => { if (v!=null) { if (v<yMin) yMin=v; if (v>yMax) yMax=v; } });
    past.forEach(scan); scan(curR); scan(proj);
    if (!isFinite(yMin)) { yMin = -0.2; yMax = 0.2; }

    // calendar / position labels
    const remFrac = 1 - nowFrac;
    let posLabel, endLabel, remLabel;
    if (isBTC) {
      posLabel = `Year ${(nowFrac*4).toFixed(1)} of 4 · ${Math.round(nowFrac*100)}% through the halving cycle`;
      endLabel = 'next halving';
      remLabel = `~${Math.round(remFrac*48)} months`;
    } else {
      posLabel = `Day ${Math.round(nowFrac*365)} of 365 · ${Math.round(nowFrac*100)}% through the year`;
      endLabel = 'year-end';
      remLabel = `~${Math.max(1,Math.round(remFrac*12))} months`;
    }

    const monthly = monthlySeasonality(history);
    const nextMonth = (new Date(history[history.length-1].t).getUTCMonth() + 1) % 12;
    const bias = { month: MONTHS[nextMonth], pct: monthly[nextMonth].avg, n: monthly[nextMonth].n };

    // reliability note from how varied the past outcomes were at cycle end
    const endReturns = past.map(p => p[G-1]).filter(v=>v!=null);
    const spread = std(endReturns);
    const reliability = spread > Math.abs(targetPct)*1.5 ? 'past cycles varied a lot, so treat this loosely' : 'past cycles were fairly consistent';

    const cycleWord = isBTC ? 'cycles' : 'years';
    const dirWord = targetPct >= 0 ? 'gain' : 'drop';
    const summary = `Across ${completed.length} past ${cycleWord}, ${opts.coinName||'this asset'} averaged a ` +
      `${(targetPct*100>=0?'+':'')}${(targetPct*100).toFixed(1)}% ${dirWord} from this point to ${endLabel} (${remLabel} away) — ${reliability}.`;

    return {
      mode, cycleLabel: isBTC ? 'Halving cycle · 4y' : 'Yearly cycle',
      cycleWord, coinName: opts.coinName || '',
      posLabel, endLabel, remLabel,
      past, current: curR, projection: { display: proj, targetPct, targetPrice, nowIdx, nowFrac },
      yMin, yMax, monthly, bias, sampleYears: completed.length, summary,
    };
  }

  return { analyze };
})();
if (typeof window !== 'undefined') window.Seasonal = Seasonal;
