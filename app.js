/* ─── Config ───────────────────────────────────────────────────────────────────
 * Override at deploy time without editing this file by defining
 * window.CRYPTOSCOPE_CONFIG before app.js loads, e.g. in index.html:
 *
 *   <script>window.CRYPTOSCOPE_CONFIG = { apiKey: 'CG-xxxx' };</script>
 *
 * A free CoinGecko "Demo" API key raises rate limits substantially and makes
 * the live auto-refresh far more reliable. Get one at coingecko.com/api.
 */
const CFG = Object.assign({
  apiBase: 'https://api.coingecko.com/api/v3',
  apiKey:  '',            // CoinGecko demo key (CG-...). Empty = anonymous tier.
  dataBase: 'data',       // folder of pre-fetched static JSON (GitHub Actions output)
}, window.CRYPTOSCOPE_CONFIG || {});

/* ─── Constants ────────────────────────────────────────────────────────────── */
const BULL_C  = '#c8f060';
const BEAR_C  = '#ff6b6b';
const EMA20_C = 'rgba(200,240,96,0.85)';
const EMA50_C = 'rgba(96,200,240,0.85)';
const AI_C    = '#f0b860';
const GRID_C  = '#1f1f1f';
const TICK_C  = '#555';
const PAD     = { top:18, right:78, bottom:28, left:8 };

const TF_LABELS = { 1:'1H', 4:'4H', 24:'1D', 168:'1W' };
const TF_DAYS   = { 1:1, 4:7, 24:30, 168:180 };
// Live auto-refresh cadence per timeframe (ms). Coarser frames refresh less often
// to stay friendly with CoinGecko's free-tier rate limits.
const TF_REFRESH = { 1:30000, 4:60000, 24:120000, 168:300000 };

const API   = CFG.apiBase;
// Cache TTLs — long enough to absorb rapid UI toggles & rate limits.
const MARKETS_TTL = 25000;   // ms for the top-20 markets snapshot
const OHLC_TTL    = 25000;   // ms per (coin, timeframe) candle set
const HIST_TTL    = 6*3600*1000;  // daily history changes slowly — cache 6h

const STATIC_BASE = CFG.dataBase || 'data';
const STATIC_TTL  = 10*60*1000;   // re-read a static file at most every 10 min

const LS_KEY = 'cryptoscope:prefs';

/* ─── State ─────────────────────────────────────────────────────────────────── */
let coins     = [];
let ohlcData  = [];
let coneOn    = false;   // Monte-Carlo forecast cone overlay on the chart
let currentTF = 1;       // always a Number
let isFetching = false;
let reqId      = 0;      // monotonically increasing token — guards against stale responses
let refreshTimer = null;
let lastUpdated  = 0;
let lastPrice    = null;
let STATIC       = false; // true when pre-fetched data/ files are present (set at boot)
let dataGeneratedAt = 0;  // generatedAt from data/meta.json (static mode)
let dataIntervalH   = 6;  // how often the GitHub Action refreshes data (hours)
let oracle       = null; // latest Oracle.analyze() result
let tfScores     = {};   // { tf: verdictScore } for the current coin
let tfScoresCoin = null; // coin id those scores belong to
let seasonal     = null; // latest Seasonal.analyze() result
let seasonalCoin = null; // coin id the seasonal result belongs to
let currentCoinName = '';

/* ─── Persisted prefs ───────────────────────────────────────────────────────── */
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    if (TF_LABELS[p.tf]) currentTF = +p.tf;
    if (typeof p.cone === 'boolean') coneOn = p.cone;
    return p;
  } catch { return {}; }
}
function savePrefs() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      coin: document.getElementById('coinSelect').value,
      tf: currentTF,
      cone: coneOn,
    }));
  } catch { /* storage unavailable — ignore */ }
}

/* ─── Chart (TradingView lightweight-charts — professional rendering) ─────────── */
let lwChart=null, candleSeries=null, ema20Series=null, ema50Series=null;
let fcUpper=null, fcLower=null, fcMedian=null;
let chartReady=false;
let seasChart=null;  // second lightweight-charts instance for the seasonal overlay
const SEAS_PALETTE = ['#5a9cff', '#b57cf0', '#4ec9a8', '#e0667f', '#e09a52'];

function initChart() {
  const el = document.getElementById('chartDiv');
  if (!el) return;
  if (!window.LightweightCharts) {
    el.innerHTML = '<div class="chart-fallback">Chart engine failed to load — check your connection and refresh.</div>';
    return;
  }
  lwChart = LightweightCharts.createChart(el, {
    autoSize: true,
    layout: { background:{ type:'solid', color:'#161616' }, textColor:'#7a7a7a', fontFamily:"'DM Mono', monospace", fontSize:11 },
    grid: { vertLines:{ color:'rgba(255,255,255,0.035)' }, horzLines:{ color:'rgba(255,255,255,0.035)' } },
    rightPriceScale: { borderColor:'#2a2a2a', scaleMargins:{ top:0.12, bottom:0.12 } },
    timeScale: { borderColor:'#2a2a2a', timeVisible:true, secondsVisible:false, rightOffset:6, barSpacing:8 },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine:{ color:'rgba(240,237,232,0.25)', width:1, style:3, labelBackgroundColor:'#2a2a2a' },
      horzLine:{ color:'rgba(240,237,232,0.25)', width:1, style:3, labelBackgroundColor:'#2a2a2a' },
    },
    localization: { priceFormatter: p => fmtPrice(p) },
  });
  candleSeries = lwChart.addCandlestickSeries({
    upColor:'#c8f060', downColor:'#ff6b6b', borderUpColor:'#c8f060', borderDownColor:'#ff6b6b',
    wickUpColor:'rgba(200,240,96,0.7)', wickDownColor:'rgba(255,107,107,0.75)',
  });
  const ln = (color,width,style)=> lwChart.addLineSeries({
    color, lineWidth:width, lineStyle:style||0,
    priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false,
  });
  ema20Series = ln(EMA20_C, 2);
  ema50Series = ln(EMA50_C, 2);
  fcUpper  = ln('rgba(240,184,96,0.4)', 1, 2);
  fcLower  = ln('rgba(240,184,96,0.4)', 1, 2);
  fcMedian = ln(AI_C, 2, 2);
  lwChart.subscribeCrosshairMove(onCrosshair);
  chartReady = true;
}

function setChartData(fit) {
  if (!chartReady || !candleSeries || !ohlcData.length) return;
  try {
    // strictly-ascending unique times (lightweight-charts requirement)
    const seen = new Set(), cd = [], idx = [];
    ohlcData.forEach((d,i) => {
      const time = Math.floor(d.t/1000);
      if (seen.has(time)) return;
      seen.add(time); cd.push({ time, open:d.o, high:d.h, low:d.l, close:d.c }); idx.push(i);
    });
    candleSeries.setData(cd);
    const closes = ohlcData.map(d=>d.c);
    const e20 = calcEMA(closes, Math.min(20, closes.length));
    const e50 = calcEMA(closes, Math.min(50, closes.length));
    const toLine = arr => idx.map(i => arr[i]!=null ? { time:Math.floor(ohlcData[i].t/1000), value:arr[i] } : null).filter(Boolean);
    ema20Series.setData(toLine(e20));
    ema50Series.setData(toLine(e50));
    updateForecastSeries();
    updateLegend(ohlcData[ohlcData.length-1]);
    if (fit) lwChart.timeScale().fitContent();
  } catch (e) { console.error('chart setData failed:', e); }
}

function updateForecastSeries() {
  if (!fcMedian) return;
  if (coneOn && oracle && oracle.mc && oracle.mc.cone.length > 1 && ohlcData.length) {
    const barSec = Math.max(1, Math.round(oracle.meta.barMs/1000));
    const lastT  = Math.floor(ohlcData[ohlcData.length-1].t/1000);
    const up=[], lo=[], md=[];
    oracle.mc.cone.forEach((c,i) => {
      const time = lastT + i*barSec;
      up.push({ time, value:c.p95 }); lo.push({ time, value:c.p5 }); md.push({ time, value:c.p50 });
    });
    fcUpper.setData(up); fcLower.setData(lo); fcMedian.setData(md);
  } else {
    fcUpper.setData([]); fcLower.setData([]); fcMedian.setData([]);
  }
}

function updateLegend(d) {
  const el = document.getElementById('chartLegend');
  if (!el || !d) return;
  const bull = d.c >= d.o;
  el.innerHTML =
    `<span class="lg-t">${fmtFull(d.t)}</span>` +
    `<span><i>O</i>${fmtUSD(d.o)}</span><span><i>H</i><b style="color:var(--bull)">${fmtUSD(d.h)}</b></span>` +
    `<span><i>L</i><b style="color:var(--bear)">${fmtUSD(d.l)}</b></span>` +
    `<span><i>C</i><b style="color:${bull?'var(--bull)':'var(--bear)'}">${fmtUSD(d.c)}</b></span>`;
  el.classList.add('show');
}

function onCrosshair(param) {
  if (!param || !param.time || !param.seriesData) { if (ohlcData.length) updateLegend(ohlcData[ohlcData.length-1]); return; }
  const d = param.seriesData.get(candleSeries);
  if (d) updateLegend({ t: (typeof param.time==='number' ? param.time*1000 : Date.now()), o:d.open, h:d.high, l:d.low, c:d.close });
  else if (ohlcData.length) updateLegend(ohlcData[ohlcData.length-1]);
}

/* ─── Skeleton bars (decorative) ───────────────────────────────────────────── */
(function buildSkel() {
  const heights = [30,55,40,70,45,80,35,60,50,75,40,65,30,55,70,45,80,60,35,50];
  document.getElementById('skelBars').innerHTML =
    heights.map(h => `<div class="skel-bar" style="height:${h}px"></div>`).join('');
})();

/* ─── Toast ─────────────────────────────────────────────────────────────────── */
let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
}

/* ─── Live status tag ───────────────────────────────────────────────────────── */
function setLive(state, text) {
  const tag = document.getElementById('liveTag');
  tag.className = 'live-tag' + (state ? ' ' + state : '');
  if (text != null) document.getElementById('liveTxt').textContent = text;
}
function nextRefreshDate() {                 // next UTC-aligned schedule boundary
  const ms = dataIntervalH * 3600 * 1000;
  return new Date(Math.ceil(Date.now() / ms) * ms);
}
function updateStaticTag() {
  const t = nextRefreshDate().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const stale = dataGeneratedAt && (Date.now() - dataGeneratedAt > dataIntervalH * 3600 * 1000 * 2.2);
  const tag = document.getElementById('liveTag');
  tag.className = 'live-tag' + (stale ? ' stale' : '');
  document.getElementById('liveTxt').textContent = `Refreshed every ${dataIntervalH}h · next ~${t}`;
}
function markFresh() {
  if (STATIC) updateStaticTag();
  else setLive('', 'Live · just now');
}
function tickLiveLabel() {
  if (STATIC) { updateStaticTag(); return; }   // show the schedule, not a ticking clock
  if (!lastUpdated) return;
  const secs = Math.round((Date.now() - lastUpdated) / 1000);
  let txt;
  if (secs < 5)        txt = 'Live · just now';
  else if (secs < 60)  txt = `Live · ${secs}s ago`;
  else                 txt = `Live · ${Math.round(secs/60)}m ago`;
  const tag = document.getElementById('liveTag');
  if (!tag.classList.contains('offline') && !tag.classList.contains('syncing')) {
    document.getElementById('liveTxt').textContent = txt;
    tag.classList.toggle('stale', secs > 90);
  }
}
setInterval(tickLiveLabel, 1000);

/* ─── Robust fetch: timeout + retry w/ exponential backoff + 429 awareness ──── */
function withKey(url) {
  if (!CFG.apiKey) return url;
  return url + (url.includes('?') ? '&' : '?') + 'x_cg_demo_api_key=' + encodeURIComponent(CFG.apiKey);
}
async function fetchJSON(url, { tries = 3, timeout = 9000, noKey = false } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    const ctrl = new AbortController();
    const to   = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(noKey ? url : withKey(url), { signal: ctrl.signal, headers: { accept: 'application/json' } });
      clearTimeout(to);
      if (r.status === 429) {
        const ra = parseFloat(r.headers.get('retry-after'));
        const wait = (Number.isFinite(ra) ? ra * 1000 : 1500 * (attempt + 1));
        if (attempt < tries - 1) { await sleep(Math.min(wait, 8000)); continue; }
        throw new RateLimitError();
      }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      clearTimeout(to);
      lastErr = e;
      if (attempt < tries - 1) await sleep(250 * Math.pow(2, attempt));
    }
  }
  throw lastErr || new Error('Request failed');
}
function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }
class RateLimitError extends Error { constructor(){ super('Rate limited'); this.rateLimited = true; } }

/* ─── Tiny TTL cache ────────────────────────────────────────────────────────── */
const cache = new Map();
async function cachedJSON(key, url, ttl, opts) {
  const hit = cache.get(key);
  if (hit && Date.now() < hit.exp) return hit.data;
  try {
    const data = await fetchJSON(url, opts);
    cache.set(key, { data, exp: Date.now() + ttl });
    return data;
  } catch (e) {
    if (hit) { e.servedStale = true; return hit.data; }
    throw e;
  }
}

/* ─── Loading state helpers ─────────────────────────────────────────────────── */
function setLoading(coinName) {
  isFetching = true;
  const overlay = document.getElementById('loading');
  overlay.classList.remove('hidden', 'error');
  document.getElementById('loadingCoinName').textContent = coinName || '—';
  document.getElementById('statusBar').classList.add('fetching');
  document.getElementById('fetchIndicator').classList.add('visible');
  ['coinVol','coinMcap','coinHigh','coinLow'].forEach(id => {
    document.getElementById(id).innerHTML = '<span class="shimmer"></span>';
  });
  document.getElementById('coinSelect').disabled = true;
  document.getElementById('tfGroup').classList.add('disabled');
  document.getElementById('aiToggle').classList.add('disabled');
  setLive('syncing', 'Loading…');
}

function clearLoading() {
  isFetching = false;
  document.getElementById('loading').classList.add('hidden');
  document.getElementById('statusBar').classList.remove('fetching');
  document.getElementById('fetchIndicator').classList.remove('visible');
  document.getElementById('coinSelect').disabled = false;
  document.getElementById('tfGroup').classList.remove('disabled');
  document.getElementById('aiToggle').classList.remove('disabled');
}

function showError(msg) {
  isFetching = false;
  const overlay = document.getElementById('loading');
  overlay.classList.remove('hidden');
  overlay.classList.add('error');
  document.getElementById('errMsg').textContent = msg;
  document.getElementById('statusBar').classList.remove('fetching');
  document.getElementById('fetchIndicator').classList.remove('visible');
  document.getElementById('coinSelect').disabled = false;
  document.getElementById('tfGroup').classList.remove('disabled');
  document.getElementById('aiToggle').classList.remove('disabled');
  setLive('offline', 'Offline');
}

/* ─── Boot: fetch top 20 ────────────────────────────────────────────────────── */
async function boot() {
  const prefs = loadPrefs();
  document.querySelectorAll('input[name="tf"]').forEach(r => { r.checked = (+r.value === currentTF); });
  document.getElementById('tfLabel').innerHTML = `Timeframe <strong>${TF_LABELS[currentTF]}</strong>`;
  document.getElementById('aiToggle').classList.toggle('active', coneOn);
  initChart();

  // Detect pre-fetched static data (data/meta.json). If present, the app reads
  // static JSON and makes no API calls at runtime.
  setLive('syncing', 'Connecting…');
  try {
    const meta = await fetchJSON(`${STATIC_BASE}/meta.json?t=${Date.now()}`, { tries: 1, timeout: 6000, noKey: true });
    if (meta && meta.generatedAt) { STATIC = true; dataGeneratedAt = meta.generatedAt; if (meta.intervalHours) dataIntervalH = meta.intervalHours; }
  } catch (e) { STATIC = false; }

  try {
    coins = await loadMarketsArray();
    if (!Array.isArray(coins) || !coins.length) throw new Error('No market data');
    document.getElementById('coinSelect').innerHTML = coins.map(c =>
      `<option value="${c.id}">${c.symbol.toUpperCase()} — ${c.name}</option>`
    ).join('');
    if (prefs.coin && coins.some(c => c.id === prefs.coin)) {
      document.getElementById('coinSelect').value = prefs.coin;
    }
    await loadChart();
  } catch (e) {
    document.getElementById('coinSelect').innerHTML = '<option value="">Retry…</option>';
    showError(e.rateLimited
      ? 'Rate limited by CoinGecko. Give it a few seconds and retry.'
      : 'Couldn’t load the coin list. Check your connection and retry.');
  }
}

/* ─── Refresh coin info bar ─────────────────────────────────────────────────── */
function refreshBar(coin, shimmerStats) {
  if (!coin) return;
  const img = coin.image ? `<img class="coin-icon" src="${coin.image}" onerror="this.remove()"/>` : '';
  document.getElementById('coinName').innerHTML    = `${img}${coin.name}`;

  const priceEl = document.getElementById('coinPrice');
  const newPrice = coin.current_price;
  priceEl.textContent = fmtUSD(newPrice);
  if (lastPrice != null && newPrice != null && newPrice !== lastPrice) {
    const cls = newPrice > lastPrice ? 'flash-up' : 'flash-dn';
    priceEl.classList.remove('flash-up', 'flash-dn');
    void priceEl.offsetWidth;
    priceEl.classList.add(cls);
    setTimeout(() => priceEl.classList.remove(cls), 600);
  }
  lastPrice = newPrice;

  const pct = +(coin.price_change_percentage_24h || 0);
  const el  = document.getElementById('coinChange');
  el.textContent = (pct >= 0 ? '▲ +' : '▼ ') + Math.abs(pct).toFixed(2) + '%';
  el.className   = 'coin-change ' + (pct >= 0 ? 'bull' : 'bear');
  if (!shimmerStats) {
    document.getElementById('coinVol').textContent   = fmtBig(coin.total_volume);
    document.getElementById('coinMcap').textContent  = fmtBig(coin.market_cap);
    document.getElementById('coinHigh').textContent  = fmtUSD(coin.high_24h);
    document.getElementById('coinLow').textContent   = fmtUSD(coin.low_24h);
  }
}

/* ─── Static-first loader ────────────────────────────────────────────────────
 * In static mode (data/ present) we read pre-fetched JSON → zero API calls at
 * runtime. If a static file is missing we fall back to the live API, so the app
 * still works locally / before the first scheduled fetch. */
async function staticJSON(relPath, force) {
  const url = `${STATIC_BASE}/${relPath}` + (force ? `?t=${Date.now()}` : '');
  return cachedJSON(`s:${relPath}`, url, STATIC_TTL, { noKey: true, tries: 1, timeout: 8000 });
}

/* ─── Fetch OHLC ─────────────────────────────────────────────────────────────── */
async function fetchOHLC(coinId, tf, { fresh = false } = {}) {
  let raw = null;
  if (STATIC) {
    const sk = `s:ohlc/${coinId}-${tf}.json`;
    if (fresh) cache.delete(sk);
    try { raw = await staticJSON(`ohlc/${coinId}-${tf}.json`, fresh); } catch (e) { raw = null; }
  }
  if (!Array.isArray(raw) || !raw.length) {        // live fallback
    const days = TF_DAYS[tf] || 1;
    const key  = `ohlc:${coinId}:${tf}`;
    if (fresh) cache.delete(key);
    raw = await cachedJSON(key, `${API}/coins/${coinId}/ohlc?vs_currency=usd&days=${days}`, OHLC_TTL);
  }
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('Empty OHLC');
  return raw.map(d => ({ t:+d[0], o:+d[1], h:+d[2], l:+d[3], c:+d[4] }));
}

/* ─── Top-20 markets snapshot (one source covers every coin) ─────────────────── */
const MARKETS_URL =
  `${API}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=20&page=1&sparkline=false&price_change_percentage=24h`;

async function loadMarketsArray(force = false) {
  if (STATIC) {
    if (force) cache.delete('s:markets.json');
    try { const a = await staticJSON('markets.json', force); if (Array.isArray(a) && a.length) return a; } catch (e) {}
  }
  if (force) cache.delete('markets');
  return cachedJSON('markets', MARKETS_URL, MARKETS_TTL);
}

async function refreshMarkets(force = false) {
  const arr = await loadMarketsArray(force);
  if (Array.isArray(arr)) {
    const byId = new Map(arr.map(c => [c.id, c]));
    coins = coins.map(c => byId.get(c.id) || c);  // merge fresh data, keep dropdown order
  }
  return arr;
}

/* ─── Fetch long daily history → powers seasonality ──────────────────────────
 * CoinGecko's free/demo tier caps history at 365 days, which isn't enough for
 * multi-year / halving seasonality. CryptoCompare's histoday (allData) is free,
 * keyless, CORS-friendly and returns full history (BTC back to 2010) — and it
 * doesn't touch the CoinGecko quota. One cached call per coin (6h TTL). */
async function fetchHistory(coinId) {
  if (STATIC) {
    try {
      const j = await staticJSON(`history/${coinId}.json`);
      const pr = j && j.prices;
      if (Array.isArray(pr) && pr.length) {
        const out = pr.map(p => ({ t: +p[0], price: +p[1] })).filter(d => d.price > 0);
        if (out.length) return out;
      }
    } catch (e) { /* fall through to live */ }
  }
  // Live fallback: CryptoCompare histoday (keyless, full history)
  const coin = coins.find(c => c.id === coinId);
  const sym  = (coin && coin.symbol ? coin.symbol : coinId).toUpperCase();
  const raw  = await cachedJSON(
    `hist:${sym}`,
    `https://min-api.cryptocompare.com/data/v2/histoday?fsym=${encodeURIComponent(sym)}&tsym=USD&allData=true`,
    HIST_TTL,
    { tries: 2, timeout: 12000, noKey: true }
  );
  const arr = raw && raw.Data && raw.Data.Data;
  if (!Array.isArray(arr)) throw new Error('No history');
  const out = arr.filter(d => d && d.close > 0).map(d => ({ t: d.time * 1000, price: +d.close }));
  if (!out.length) throw new Error('No history');   // symbol not listed on the provider
  return out;                                       // may be short — caller measures span
}

/* ─── EMA (for chart overlay lines only — Oracle computes its own) ──────────── */
function calcEMA(vals, period) {
  const out = new Array(vals.length).fill(null);
  if (vals.length < period) return out;
  const k = 2 / (period + 1);
  let prev = vals.slice(0, period).reduce((a,b)=>a+b,0) / period;
  out[period-1] = prev;
  for (let i = period; i < vals.length; i++) { prev = vals[i]*k + prev*(1-k); out[i] = prev; }
  return out;
}


/* ════════════════════════════════════════════════════════════════════════════
 * ORACLE DASHBOARD RENDERING
 * ════════════════════════════════════════════════════════════════════════════ */
const pct  = (v, d=1) => `${v>=0?'+':''}${(v*100).toFixed(d)}%`;
const pctP = (v, d=0) => `${(v*100).toFixed(d)}%`;            // unsigned probability
const sc   = v => v > 0.15 ? 'bull' : v < -0.15 ? 'bear' : 'neutral';

function scoreColor(s) { return `hsl(${Math.round(s*1.2)}, 65%, 55%)`; } // 0=red → 100=green

function gaugeSVG(score, color) {
  const cx=110, cy=104, r=88;
  const s = Math.max(0, Math.min(100, score));
  const arcLen = Math.PI * r;            // true length of the semicircle
  const dash   = s / 100 * arcLen;       // fill this many units, rest is gap
  const track = `M ${cx-r} ${cy} A ${r} ${r} 0 0 0 ${cx+r} ${cy}`;
  return `
  <svg class="gauge" viewBox="0 0 220 112" width="100%" height="100%">
    <defs>
      <linearGradient id="gaugeGrad" x1="${cx-r}" y1="0" x2="${cx+r}" y2="0" gradientUnits="userSpaceOnUse">
        <stop offset="0%"   stop-color="#ff4d4d"/>
        <stop offset="30%"  stop-color="#ff8a3d"/>
        <stop offset="55%"  stop-color="#f0b860"/>
        <stop offset="78%"  stop-color="#bfe34f"/>
        <stop offset="100%" stop-color="#79e04a"/>
      </linearGradient>
    </defs>
    <!-- dim full track -->
    <path d="${track}" fill="none" stroke="#242424" stroke-width="14" stroke-linecap="round"/>
    <!-- gradient fill from the left (bear) stopping at the score -->
    <path d="${track}" fill="none" stroke="url(#gaugeGrad)" stroke-width="14" stroke-linecap="round"
          stroke-dasharray="${dash.toFixed(2)} ${(arcLen + 2).toFixed(2)}"/>
    <!-- score in the centre -->
    <text x="110" y="86" text-anchor="middle" fill="${color}"
          font-family="'DM Serif Display', serif" font-style="italic" font-size="44">${score}</text>
    <text x="110" y="104" text-anchor="middle" fill="#666"
          font-family="'DM Mono', monospace" font-size="10" letter-spacing="1.5">/ 100</text>
  </svg>`;
}

/* Two-line caption under each card: what it shows + what it means. */
function odesc(what, mean) {
  return `<div class="ocard-desc"><span><i>Shows</i>${what}</span><span><i>Means</i>${mean}</span></div>`;
}

/* Small ring showing the verdict score for one timeframe (null = still loading). */
function miniRing(tf, score) {
  const has = score != null;
  const col = has ? scoreColor(score) : '#3a3a3a';
  const r = 15, circ = 2 * Math.PI * r, dash = has ? score / 100 * circ : 0;
  return `<div class="tfm ${tf === currentTF ? 'cur' : ''}" data-tf="${tf}">
    <svg viewBox="0 0 40 40" width="40" height="40">
      <circle cx="20" cy="20" r="${r}" fill="none" stroke="#242424" stroke-width="4"/>
      <circle cx="20" cy="20" r="${r}" fill="none" stroke="${col}" stroke-width="4" stroke-linecap="round"
        stroke-dasharray="${dash.toFixed(1)} ${circ.toFixed(1)}" transform="rotate(-90 20 20)"/>
      <text x="20" y="24" text-anchor="middle" font-size="12" fill="${col}" font-family="'DM Mono',monospace">${has ? score : '·'}</text>
    </svg>
    <span class="tfm-lbl">${TF_LABELS[tf]}</span>
  </div>`;
}

function updateTfCircle(tf, score) {
  const el = document.querySelector(`.tfm[data-tf="${tf}"]`);
  if (el) el.outerHTML = miniRing(tf, score);
}

/* Background: compute the verdict for the other timeframes and fill their rings.
   Best-effort + gentle pacing so it doesn't trip the rate limit. */
async function ensureMultiTF(coinId) {
  if (oracle) { tfScores[currentTF] = oracle.composite.score; updateTfCircle(currentTF, oracle.composite.score); }
  const myReq = reqId;
  for (const tf of [1, 4, 24, 168]) {
    if (tf === currentTF || tfScores[tf] != null) continue;
    try {
      const candles = await fetchOHLC(coinId, tf);
      if (myReq !== reqId || tfScoresCoin !== coinId) return;
      const r = (window.Oracle && candles.length >= 30) ? Oracle.analyze(candles, { paths: 600 }) : null;
      tfScores[tf] = r ? r.composite.score : null;
      updateTfCircle(tf, tfScores[tf]);
    } catch (e) {
      updateTfCircle(tf, null);
    }
    await sleep(450);
  }
}

/* ════════════════════════════════════════════════════════════════════════════
 * SIMPLE "QUICK READ" — plain-language summary for non-experts
 * ════════════════════════════════════════════════════════════════════════════ */
function humDur(ms) {
  const h = ms/3600000;
  if (h < 36) return 'the next day or so';
  const d = h/24;
  if (d < 10) return `the next ${Math.round(d)} days`;
  const w = d/7;
  if (w < 8) return `the next ${Math.round(w)} weeks`;
  return `the next ${Math.round(d/30)} months`;
}
function simpleVerdict(score) {
  if (score >= 66) return { txt:'Looks Strong',        emoji:'🚀', dir:'up'   };
  if (score >= 57) return { txt:'Leaning Up',          emoji:'📈', dir:'up'   };
  if (score >= 53) return { txt:'Slightly Up',         emoji:'↗️', dir:'up'   };
  if (score >  47) return { txt:'Unclear / Sideways',  emoji:'↔️', dir:'flat' };
  if (score >  43) return { txt:'Slightly Down',       emoji:'↘️', dir:'down' };
  if (score >= 34) return { txt:'Leaning Down',        emoji:'📉', dir:'down' };
  return                  { txt:'Looks Weak',          emoji:'🔻', dir:'down' };
}
function renderSimpleInner(res) {
  const P = res.probs, C = res.composite;
  const up = Math.round(P.pUp*100), down = 100 - up;
  const v = simpleVerdict(C.score);
  const dirCls = v.dir==='up' ? 'bull' : v.dir==='down' ? 'bear' : 'neutral';
  const hz = humDur(res.meta.barMs * res.meta.horizon);
  const av = res.volatility.annVol;
  const risk = av > 0.9 ? '⚠ Expect big price swings — higher risk.'
             : av > 0.5 ? 'Moderate price swings expected.'
             : 'Relatively calm lately.';
  const name = currentCoinName || 'this coin';
  return `
    <div class="ocard-title">Quick Read <span class="ttag">plain-English summary</span></div>
    <div class="simple-head ${dirCls}">
      <div class="simple-emoji">${v.emoji}</div>
      <div>
        <div class="simple-verdict">${v.txt}</div>
        <div class="simple-sub">Over ${hz}, the model gives <b>${name}</b> about a <b>${up}%</b> chance of being higher than now.</div>
      </div>
    </div>
    <div class="ud-bar">
      <div class="ud-up ${up>=down?'win':''}" style="width:${Math.max(up,6)}%">▲ ${up}%</div>
      <div class="ud-dn ${down>up?'win':''}" style="width:${Math.max(down,6)}%">▼ ${down}%</div>
    </div>
    <div class="simple-risk">${risk} <span class="simple-dis">Model estimate — not financial advice.</span></div>`;
}

/* ════════════════════════════════════════════════════════════════════════════
 * SEASONAL PATTERN — cycle overlay + projection (async, one cached history call)
 * ════════════════════════════════════════════════════════════════════════════ */
async function loadSeasonal(coinId) {
  const myReq = reqId;
  const coin = coins.find(c => c.id === coinId);
  const name = coin ? coin.name : coinId;
  try {
    const hist = await fetchHistory(coinId);
    if (myReq !== reqId) return;
    seasonal = window.Seasonal ? Seasonal.analyze(hist, { isBTC: coinId === 'bitcoin', coinName: name }) : null;
    seasonalCoin = coinId;
    if (seasonal) { renderSeasonal(seasonal); return; }
    // Have history, but not enough for a seasonal read — explain why.
    const years = hist.length ? (hist[hist.length-1].t - hist[0].t) / (365*86400000) : 0;
    renderSeasonal(null, { kind: years < 2 ? 'tooNew' : 'tooFew', years, name });
  } catch (e) {
    if (myReq !== reqId) return;
    seasonal = null; seasonalCoin = coinId;
    renderSeasonal(null, { kind: 'error', name });
  }
}

function renderSeasonal(s, info) {
  const host = document.getElementById('seasonalCard');
  if (!host) return;
  if (!s) {
    if (seasChart) { try { seasChart.remove(); } catch(e){} seasChart = null; }
    const name = (info && info.name) || 'this coin';
    let msg;
    if (info && info.kind === 'error') {
      msg = `Couldn’t load price history for <b>${name}</b> — it may not be listed on the history provider.`;
    } else if (info && info.kind === 'tooNew') {
      const span = info.years < 1 ? `${Math.max(1, Math.round(info.years*12))} months` : `${info.years.toFixed(1)} years`;
      msg = `⏳ <b>Not available yet — ${name} is too new.</b><br>We only have about ${span} of price history, and a seasonal read needs at least ~2 years of data to compare cycles.`;
    } else {
      msg = `Not enough complete cycles yet for a reliable seasonal read on <b>${name}</b>.`;
    }
    host.innerHTML = `<div class="ocard-title">Seasonal Pattern</div>
      ${odesc('How this coin behaved at this point in past cycles.', 'Overlay of past cycles + a typical-path projection & target.')}
      <div class="seasonal-msg">${msg}</div>`;
    return;
  }
  const tgtCls = s.projection.targetPct >= 0 ? 'bull' : 'bear';
  const months = s.monthly.map(m => {
    const h = Math.min(100, Math.abs(m.avg)*100*4);
    const col = m.avg >= 0 ? 'var(--bull)' : 'var(--bear)';
    return `<div class="seas-m" title="${m.label}: ${(m.avg*100>=0?'+':'')}${(m.avg*100).toFixed(1)}% avg (${m.n} yrs)">
      <div class="seas-m-bar" style="height:${Math.max(3,h)}%;background:${col}"></div><span>${m.label[0]}</span></div>`;
  }).join('');
  const legendPast = s.pastSeries.map((p,i) =>
    `<span><i style="background:${SEAS_PALETTE[i%SEAS_PALETTE.length]}"></i>${p.label}</span>`).join('');
  host.innerHTML = `
    <div class="ocard-title">Seasonal Pattern <span class="ttag">${s.cycleLabel}</span></div>
    ${odesc(`How ${s.coinName} moved at this stage of past ${s.cycleWord} (normalized to % from cycle start).`, 'Past cycles overlaid + a typical-path projection of where price tends to go next.')}
    <div class="seas-pos">${s.posLabel}</div>
    <div class="seas-wrap"><div id="seasChartDiv"></div></div>
    <div class="dist-legend seas-legend">
      ${legendPast}
      <span><i class="cur" style="background:#c8f060"></i>current</span>
      <span><i class="proj" style="background:#f0b860"></i>typical path →</span>
    </div>
    <div class="metric-grid" style="margin-top:14px">
      ${metric('Sample size', `${s.sampleYears} ${s.cycleWord}`)}
      ${metric('Typical move ahead', pct(s.projection.targetPct,1), tgtCls)}
      ${metric(`Seasonal target (${s.endLabel})`, fmtUSD(s.projection.targetPrice), tgtCls)}
      ${metric(`Next month (${s.bias.month})`, `${pct(s.bias.pct,1)} avg`, s.bias.pct>=0?'bull':'bear')}
    </div>
    <div class="seas-months-title">Month-of-year seasonality (avg return)</div>
    <div class="seas-months">${months}</div>
    <div class="fingerprint-note">${s.summary}</div>`;
  buildSeasChart(s);
}

function seasAxisLabel(t, s) {
  const frac = ((t/86400) - 1) / (s.gridN - 1);
  if (s.mode === 'halving') return (frac*4).toFixed(1) + 'y';
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return M[Math.min(11, Math.max(0, Math.floor(frac*12)))];
}

/* Seasonal overlay rendered with lightweight-charts (crisp vector lines).
   X-axis is a synthetic per-cycle timeline (so every cycle aligns); each value
   is normalized cumulative return, so all cycles are directly comparable. */
function buildSeasChart(s) {
  if (seasChart) { try { seasChart.remove(); } catch(e){} seasChart = null; }
  const el = document.getElementById('seasChartDiv');
  if (!el) return;
  if (!window.LightweightCharts) { el.innerHTML = '<div class="chart-fallback">Chart engine unavailable.</div>'; return; }
  seasChart = LightweightCharts.createChart(el, {
    autoSize: true,
    layout: { background:{ type:'solid', color:'#161616' }, textColor:'#7a7a7a', fontFamily:"'DM Mono', monospace", fontSize:10 },
    grid: { vertLines:{ color:'rgba(255,255,255,0.03)' }, horzLines:{ color:'rgba(255,255,255,0.03)' } },
    rightPriceScale: { borderColor:'#2a2a2a', scaleMargins:{ top:0.1, bottom:0.08 } },
    timeScale: { borderColor:'#2a2a2a', tickMarkFormatter: t => seasAxisLabel(t, s) },
    crosshair: { mode: LightweightCharts.CrosshairMode.Magnet, vertLine:{ labelVisible:false }, horzLine:{ labelVisible:true } },
    localization: {
      priceFormatter: v => (v*100>=0?'+':'') + (v*100).toFixed(0) + '%',
      timeFormatter: t => Math.round(((t/86400)-1)/(s.gridN-1)*100) + '% through cycle',
    },
    handleScroll: false, handleScale: false,
  });
  const tOf = i => (i+1)*86400;
  const toData = arr => arr.map((v,i) => v==null ? null : { time: tOf(i), value: v }).filter(Boolean);
  // past cycles — distinct colors, thin
  s.pastSeries.forEach((p, idx) => {
    const ser = seasChart.addLineSeries({ color: SEAS_PALETTE[idx%SEAS_PALETTE.length], lineWidth: 1,
      priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false });
    ser.setData(toData(p.vals));
  });
  // projection — dashed gold (where price tends to go next)
  const proj = seasChart.addLineSeries({ color:'#f0b860', lineWidth:2, lineStyle:2,
    priceLineVisible:false, lastValueVisible:false, crosshairMarkerVisible:false });
  proj.setData(toData(s.projection.display));
  // current cycle — bold, bright, on top
  const cur = seasChart.addLineSeries({ color:'#c8f060', lineWidth:3,
    priceLineVisible:false, lastValueVisible:true, crosshairMarkerVisible:true });
  cur.setData(toData(s.current));
  seasChart.timeScale().fitContent();
}

function probBar(p, dir) {
  const col = dir > 0 ? 'var(--bull)' : 'var(--bear)';
  return `<div class="pbar"><div class="pbar-fill" style="width:${Math.round(p*100)}%;background:${col}"></div></div>`;
}

function signalRow(s) {
  const cls = sc(s.score);
  const w = Math.round(Math.abs(s.score)*50);
  const side = s.score >= 0 ? 'left:50%' : `right:50%;left:auto`;
  const col = cls==='bull'?'var(--bull)':cls==='bear'?'var(--bear)':'var(--muted)';
  return `
  <div class="sig-row">
    <div class="sig-name">${s.name}<em>${s.detail||''}</em></div>
    <div class="sig-track">
      <div class="sig-mid"></div>
      <div class="sig-fill" style="width:${w}%;${side};background:${col}"></div>
    </div>
    <div class="sig-pill ${cls}">${s.score>0?'+':''}${(s.score*100).toFixed(0)}</div>
  </div>`;
}

function metric(label, value, cls='') {
  return `<div class="metric"><span class="m-label">${label}</span><span class="m-val ${cls}">${value}</span></div>`;
}

function hurstNote(H) {
  if (H > 0.55) return 'persistent — trends tend to continue';
  if (H < 0.45) return 'anti-persistent — reversals likely';
  return 'random walk — little memory';
}

function renderOracle(res) {
  const host = document.getElementById('oracle');
  if (!res) {
    host.innerHTML = `<div class="oracle-empty">Not enough candles for a full reading on this timeframe.
      Try a longer timeframe.</div>`;
    return;
  }
  const C = res.composite, col = scoreColor(C.score);
  const P = res.probs, R = res.risk, S = res.stats, V = res.volatility, T = res.trend;
  const hSlope = T.slopePct;

  // probability ladder rows
  const ladder = P.targets.map(t => `
    <div class="prob-row">
      <span class="prob-lbl">${t.label}</span>
      ${probBar(t.p, t.dir)}
      <span class="prob-val">${pctP(t.p)}<em>touch ${pctP(t.touch)}</em></span>
    </div>`).join('');

  host.innerHTML = `
  <div class="oracle-grid">

    <!-- QUICK READ (plain language, for everyone) -->
    <div class="ocard simple wide">${renderSimpleInner(res)}</div>

    <!-- SEASONAL (filled async once history loads) -->
    <div class="ocard wide" id="seasonalCard">
      <div class="ocard-title">Seasonal Pattern</div>
      ${odesc('How this coin behaved at this point in past cycles.', 'Overlay of past cycles + a typical-path projection & target.')}
      <div class="seasonal-msg">Loading historical cycles…</div>
    </div>

    <!-- VERDICT -->
    <div class="ocard verdict">
      <div class="ocard-title">Oracle Verdict</div>
      ${odesc('All signals fused into one score, 0–100.', '50 = neutral · higher = stronger bullish odds.')}
      <div class="gauge-wrap">${gaugeSVG(C.score, col)}</div>
      <div class="gauge-ends"><span class="ge-bear">◀ Bear</span><span class="ge-bull">Bull ▶</span></div>
      <div class="verdict-label" style="color:${col}">${C.label}</div>
      <div class="verdict-conf" title="How much the 8 signals agree with each other and how strong they are — not the same as the score. Low = signals conflict / weak; high = aligned & strong.">Confidence <strong>${C.confidence}%</strong> · ${res.meta.bars} candles</div>
      <div class="verdict-regime">${res.regime.label}</div>
      <div class="tf-mini-title">Verdict by timeframe</div>
      <div class="tf-mini" id="tfMini">${[1,4,24,168].map(tf => miniRing(tf, tfScores[tf])).join('')}</div>
    </div>

    <!-- PROBABILITIES -->
    <div class="ocard">
      <div class="ocard-title">Forecast Probabilities <span class="ttag">${res.meta.horizon} bars · ${res.mc.paths.toLocaleString()} sims</span></div>
      ${odesc('Thousands of simulated future price paths.', 'Odds & size of the move over the next horizon.')}
      <div class="prob-head">
        <div class="prob-big ${P.pUp>=0.5?'bull':'bear'}">${pctP(P.pUp)}<small>chance up</small></div>
        <div class="prob-big ${P.pUp<0.5?'bear':'neutral'}">${pctP(1-P.pUp)}<small>chance down</small></div>
      </div>
      <div class="prob-stats">
        ${metric('Expected move', pct(P.expRet,2), P.expRet>=0?'bull':'bear')}
        ${metric('Median move', pct(P.medRet,2), P.medRet>=0?'bull':'bear')}
        ${metric('90% range', `${pct(P.rangeLo,1)} … ${pct(P.rangeHi,1)}`)}
      </div>
      <div class="prob-ladder">${ladder}</div>
    </div>

    <!-- SIGNAL MATRIX -->
    <div class="ocard wide">
      <div class="ocard-title">Signal Matrix <span class="ttag">8 weighted factors fused into the verdict</span></div>
      ${odesc('Eight indicators each scored −100 … +100.', 'Green leans bullish, red bearish; together they set the verdict.')}
      <div class="sig-list">${res.signals.map(signalRow).join('')}</div>
    </div>

    <!-- RISK -->
    <div class="ocard">
      <div class="ocard-title">Risk Profile</div>
      ${odesc('How violent this asset’s moves are right now.', 'Higher volatility, VaR & drawdown = bigger swings and losses.')}
      <div class="metric-grid">
        ${metric('Volatility (ann.)', pctP(V.annVol,0))}
        ${metric('ATR', V.atrPct!=null?V.atrPct.toFixed(2)+'%':'—')}
        ${metric('VaR 95% (1 bar)', pctP(R.var95,2), 'bear')}
        ${metric('CVaR 95%', pctP(R.cvar95,2), 'bear')}
        ${metric('Max drawdown', pctP(R.maxDrawdown,1), 'bear')}
        ${metric('Sharpe (ann.)', R.sharpe.toFixed(2), R.sharpe>=0?'bull':'bear')}
        ${metric('Sortino (ann.)', R.sortino.toFixed(2), R.sortino>=0?'bull':'bear')}
        ${metric('Return (ann.)', pct(R.annRet,0), R.annRet>=0?'bull':'bear')}
      </div>
    </div>

    <!-- STATISTICAL FINGERPRINT -->
    <div class="ocard">
      <div class="ocard-title">Statistical Fingerprint</div>
      ${odesc('The shape & memory of this coin’s returns.', 'Hurst >0.5 trends, <0.5 mean-reverts; fat tails = crash risk.')}
      <div class="metric-grid">
        ${metric('Hurst exponent', S.hurst.toFixed(3))}
        ${metric('Trend slope', `${hSlope>=0?'+':''}${hSlope.toFixed(3)}%/bar`, hSlope>=0?'bull':'bear')}
        ${metric('Skewness', S.skew.toFixed(3), S.skew>=0?'bull':'bear')}
        ${metric('Excess kurtosis', S.kurtosis.toFixed(2))}
        ${metric('Autocorr (lag 1)', S.autocorr.toFixed(3))}
        ${metric('Z-score', `${S.zScore>=0?'+':''}${S.zScore.toFixed(2)}σ`)}
      </div>
      <div class="fingerprint-note">H = ${S.hurst.toFixed(2)} → ${hurstNote(S.hurst)}.
        Fat tails: ${S.kurtosis>1?'pronounced':'mild'} (kurt ${S.kurtosis.toFixed(1)}).</div>
    </div>

    <!-- DISTRIBUTION -->
    <div class="ocard wide">
      <div class="ocard-title">Projected Price Distribution <span class="ttag">terminal outcomes at horizon</span></div>
      ${odesc('Where the simulated prices land at the horizon.', 'Wider spread = more uncertainty; dashed line = price now.')}
      <div class="dist-wrap"><canvas id="distCv"></canvas></div>
      <div class="dist-legend">
        <span><i style="background:var(--bull)"></i>upside</span>
        <span><i style="background:var(--bear)"></i>downside</span>
        <span><i style="background:#fff;opacity:.5"></i>current price</span>
        <span><i style="background:var(--accent2)"></i>median</span>
      </div>
    </div>

  </div>
  <div class="oracle-disclaimer">⚠ Quantitative model output — statistical estimates from historical price only, <strong>not financial advice</strong>. Crypto is volatile; models can be confidently wrong.</div>`;

  drawDistribution(res);
}

/* Histogram of Monte-Carlo terminal prices. */
function drawDistribution(res) {
  const canvas = document.getElementById('distCv');
  if (!canvas) return;
  const host = canvas.parentElement;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = host.clientWidth, H = 150;
  canvas.width = W*dpr; canvas.height = H*dpr;
  canvas.style.width = W+'px'; canvas.style.height = H+'px';
  const c = canvas.getContext('2d');
  c.setTransform(dpr,0,0,dpr,0,0);
  c.clearRect(0,0,W,H);

  const term = res.mc.terminals;          // already sorted
  const price = res.meta.price;
  const lo = term[Math.floor(term.length*0.01)], hi = term[Math.floor(term.length*0.99)];
  const span = (hi-lo)||1;
  const bins = 36;
  const counts = new Array(bins).fill(0);
  for (const v of term) {
    if (v < lo || v > hi) continue;
    let b = Math.floor((v-lo)/span*bins); if (b>=bins) b=bins-1; if (b<0) b=0;
    counts[b]++;
  }
  const maxC = Math.max(...counts) || 1;
  const bw = W/bins;
  const median = term[Math.floor(term.length*0.5)];
  const xOf = v => (v-lo)/span*W;

  // bars
  for (let i=0;i<bins;i++) {
    const h = counts[i]/maxC * (H-22);
    const binCenter = lo + (i+0.5)/bins*span;
    c.fillStyle = binCenter >= price ? 'rgba(200,240,96,0.55)' : 'rgba(255,107,107,0.55)';
    c.fillRect(i*bw+1, H-18-h, bw-2, h);
  }
  // current price marker
  const px = xOf(price);
  if (px>=0 && px<=W) {
    c.strokeStyle='rgba(255,255,255,0.55)'; c.lineWidth=1.5; c.setLineDash([3,3]);
    c.beginPath(); c.moveTo(px,4); c.lineTo(px,H-18); c.stroke(); c.setLineDash([]);
  }
  // median marker
  const mx = xOf(median);
  if (mx>=0 && mx<=W) {
    c.strokeStyle='#f0b860'; c.lineWidth=2;
    c.beginPath(); c.moveTo(mx,4); c.lineTo(mx,H-18); c.stroke();
  }
  // x labels
  c.fillStyle='#666'; c.font='9px DM Mono,monospace'; c.textAlign='center';
  c.fillText(fmtPrice(lo), 22, H-5);
  c.fillText(fmtPrice(median), W/2, H-5);
  c.fillText(fmtPrice(hi), W-26, H-5);
}

/* ─── Compute Oracle + re-render dashboard + rebuild chart model ────────────── */
function analyzeAndRender(fit) {
  oracle = (ohlcData.length >= 30 && window.Oracle) ? Oracle.analyze(ohlcData) : null;
  if (oracle) tfScores[currentTF] = oracle.composite.score;
  renderOracle(oracle);
  // renderOracle rebuilds the grid, so restore the async seasonal card if ready
  if (seasonal && seasonalCoin === document.getElementById('coinSelect').value) renderSeasonal(seasonal);
  document.getElementById('aiBadge').classList.toggle('on', coneOn);
  setChartData(fit);
}

/* ─── Load chart (full load, with spinner) ──────────────────────────────────── */
async function loadChart({ force = false } = {}) {
  const coinId = document.getElementById('coinSelect').value;
  if (!coinId) return;

  const myReq = ++reqId;
  stopAutoRefresh();
  savePrefs();
  lastPrice = null;                       // reset so the price flash isn't misleading across coins
  if (coinId !== tfScoresCoin) { tfScores = {}; tfScoresCoin = coinId; }  // fresh per-coin TF circles
  if (coinId !== seasonalCoin) { seasonal = null; }                       // fresh per-coin seasonal
  const coin = coins.find(c => c.id === coinId);
  currentCoinName = coin ? coin.name : coinId;

  setLoading(coin ? coin.name : coinId);
  if (coin) refreshBar(coin, true);

  document.getElementById('tfLabel').innerHTML =
    `Timeframe <strong>${TF_LABELS[currentTF]}</strong>`;

  // Candles are required; the market snapshot (price/stats) is best-effort so a
  // price-only failure never blanks the chart. One shared markets call updates
  // every coin's price, which keeps us well under the rate limit.
  let data;
  const [ohlcRes, mktRes] = await Promise.allSettled([
    fetchOHLC(coinId, currentTF, { fresh: force }),
    refreshMarkets(force),
  ]);
  if (myReq !== reqId) return;

  if (ohlcRes.status === 'rejected') {
    const e = ohlcRes.reason || {};
    console.error('OHLC fetch failed:', e);
    if (ohlcData.length) {
      // We already have something on screen — keep it rather than going blank.
      clearLoading();
      setLive('stale', 'Price update failed');
      toast(e.rateLimited ? 'Rate limited — showing last data.' : 'Update failed — showing last data.');
      startAutoRefresh();
    } else {
      showError(e.rateLimited
        ? 'CoinGecko rate limit hit. Wait a few seconds, then Retry.'
        : 'Couldn’t load chart data for this coin. Retry?');
    }
    return;
  }
  data = ohlcRes.value;

  ohlcData = data;
  const freshCoin = coins.find(c => c.id === coinId);  // refreshMarkets may have updated this
  if (freshCoin) refreshBar(freshCoin, false);
  else if (coin) refreshBar(coin, false);
  if (mktRes.status === 'rejected' && mktRes.reason && mktRes.reason.rateLimited)
    toast('Price feed rate limited — chart is current, price may lag.');

  analyzeAndRender(true);
  clearLoading();
  ensureMultiTF(coinId);                 // fill in the per-timeframe verdict circles
  if (seasonalCoin === coinId && seasonal) renderSeasonal(seasonal);
  else loadSeasonal(coinId);             // one cached history call → seasonal card

  lastUpdated = Date.now();
  markFresh();
  startAutoRefresh();
}

/* ─── Silent live refresh (no spinner, no control lockout) ──────────────────── */
async function refreshLive() {
  const coinId = document.getElementById('coinSelect').value;
  if (!coinId || isFetching || document.hidden) return;

  const myReq = reqId;
  setLive('syncing', 'Updating…');
  try {
    const [data] = await Promise.all([
      fetchOHLC(coinId, currentTF, { fresh: true }),
      refreshMarkets(true).catch(() => null)   // best-effort price; never breaks the refresh
    ]);
    if (myReq !== reqId) return;

    ohlcData = data;
    const coin = coins.find(c => c.id === coinId);
    if (coin) refreshBar(coin, false);

    analyzeAndRender(false);

    lastUpdated = Date.now();
    markFresh();
  } catch (e) {
    if (myReq !== reqId) return;
    setLive('stale', 'Reconnecting…');
    if (e.rateLimited) toast('Rate limited — backing off live updates.');
  }
}

function startAutoRefresh() {
  if (STATIC) return;             // static data refreshes daily — no point polling
  stopAutoRefresh();
  const interval = TF_REFRESH[currentTF] || 60000;
  refreshTimer = setInterval(refreshLive, interval);
}
function stopAutoRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

document.addEventListener('visibilitychange', () => {
  if (STATIC) return;             // no background polling in static mode
  if (document.hidden) {
    stopAutoRefresh();
  } else if (ohlcData.length) {
    if (Date.now() - lastUpdated > 15000) refreshLive();
    startAutoRefresh();
  }
});

/* ─── Events ─────────────────────────────────────────────────────────────────── */
document.getElementById('coinSelect').addEventListener('change', () => loadChart());

document.querySelectorAll('input[name="tf"]').forEach(r =>
  r.addEventListener('change', e => { currentTF = +e.target.value; loadChart(); })
);

document.getElementById('aiToggle').addEventListener('click', () => {
  if (isFetching) return;
  coneOn = !coneOn;
  document.getElementById('aiToggle').classList.toggle('active', coneOn);
  document.getElementById('aiBadge').classList.toggle('on', coneOn);
  savePrefs();
  updateForecastSeries();
  if (coneOn && lwChart) lwChart.timeScale().fitContent();
});


document.getElementById('retryBtn').addEventListener('click', () => {
  if (!coins.length) boot();
  else loadChart({ force: true });
});

let resizeTimer = null;
window.addEventListener('resize', () => {        // chart autosizes itself; just redraw the histogram
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (oracle) drawDistribution(oracle); }, 150);  // both charts autosize themselves
});

/* ─── Formatters ─────────────────────────────────────────────────────────────── */
function fmtUSD(n) {
  if (n==null) return '—';
  if (n<0.001) return '$'+n.toFixed(6);
  if (n<1)     return '$'+n.toFixed(4);
  return '$'+n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
}
function fmtPrice(n) {
  if (n>=10000) return '$'+(n/1000).toFixed(1)+'k';
  if (n>=1)     return '$'+n.toFixed(2);
  if (n>=0.01)  return '$'+n.toFixed(4);
  return '$'+n.toFixed(6);
}
function fmtBig(n) {
  if (!n) return '—';
  if (n>=1e12) return '$'+(n/1e12).toFixed(2)+'T';
  if (n>=1e9)  return '$'+(n/1e9).toFixed(2)+'B';
  if (n>=1e6)  return '$'+(n/1e6).toFixed(2)+'M';
  return '$'+n.toLocaleString();
}
function fmtAxisTime(ts) {
  const d = new Date(ts);
  if (currentTF <= 4) return d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
  return d.toLocaleDateString([], { month:'short', day:'numeric' });
}
function fmtFull(ts) {
  return new Date(ts).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
}

/* ─── Boot ───────────────────────────────────────────────────────────────────── */
boot();
