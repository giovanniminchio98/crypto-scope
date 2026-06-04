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
let model        = null; // precomputed render model (EMAs, cone, scales)
let oracle       = null; // latest Oracle.analyze() result

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

/* ─── Canvas (devicePixelRatio-aware for crisp, non-blurry rendering) ────────── */
const cv   = document.getElementById('cv');
const ctx2 = cv.getContext('2d');
const wrap = document.getElementById('chartWrap');
let CW = 0, CH = 0; // logical (CSS px) canvas size

function sizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  CW = wrap.clientWidth;
  CH = wrap.clientHeight;
  cv.width  = Math.round(CW * dpr);
  cv.height = Math.round(CH * dpr);
  cv.style.width  = CW + 'px';
  cv.style.height = CH + 'px';
  ctx2.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS pixels
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
function tickLiveLabel() {
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
async function fetchJSON(url, { tries = 3, timeout = 9000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    const ctrl = new AbortController();
    const to   = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(withKey(url), { signal: ctrl.signal, headers: { accept: 'application/json' } });
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
  document.getElementById('refreshBtn').classList.add('spin');
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
  document.getElementById('refreshBtn').classList.remove('spin');
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
  document.getElementById('refreshBtn').classList.remove('spin');
  setLive('offline', 'Offline');
}

/* ─── Boot: fetch top 20 ────────────────────────────────────────────────────── */
async function boot() {
  const prefs = loadPrefs();
  document.querySelectorAll('input[name="tf"]').forEach(r => { r.checked = (+r.value === currentTF); });
  document.getElementById('tfLabel').innerHTML = `Timeframe <strong>${TF_LABELS[currentTF]}</strong>`;
  document.getElementById('aiToggle').classList.toggle('active', coneOn);

  setLive('syncing', 'Connecting…');
  try {
    coins = await cachedJSON('markets', MARKETS_URL, MARKETS_TTL);
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

/* ─── Fetch OHLC ─────────────────────────────────────────────────────────────── */
async function fetchOHLC(coinId, tf, { fresh = false } = {}) {
  const days = TF_DAYS[tf] || 1;
  const key  = `ohlc:${coinId}:${tf}`;
  if (fresh) cache.delete(key);
  const raw  = await cachedJSON(
    key,
    `${API}/coins/${coinId}/ohlc?vs_currency=usd&days=${days}`,
    OHLC_TTL
  );
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('Empty OHLC');
  return raw.map(d => ({ t:+d[0], o:+d[1], h:+d[2], l:+d[3], c:+d[4] }));
}

/* ─── Refresh the top-20 markets snapshot (one call covers every coin) ───────────
 * Cached, so flipping between coins within the TTL reuses a single response
 * instead of firing a new request per coin — this is the main rate-limit saver.
 * Pass force:true (the Refresh button) to bust the cache and pull live prices. */
const MARKETS_URL =
  `${API}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=20&page=1&sparkline=false&price_change_percentage=24h`;

async function refreshMarkets(force = false) {
  if (force) cache.delete('markets');
  const arr = await cachedJSON('markets', MARKETS_URL, MARKETS_TTL);
  if (Array.isArray(arr)) {
    const byId = new Map(arr.map(c => [c.id, c]));
    coins = coins.map(c => byId.get(c.id) || c);  // merge fresh data, keep dropdown order
  }
  return arr;
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

/* ─── Build render model (so hover redraws are cheap) ───────────────────────── */
function rebuildModel() {
  if (!ohlcData.length) { model = null; return; }
  const closes = ohlcData.map(d=>d.c);
  const times  = ohlcData.map(d=>d.t);
  const e20    = calcEMA(closes, Math.min(20, closes.length));
  const e50    = calcEMA(closes, Math.min(50, closes.length));

  // Monte-Carlo cone (future) from the Oracle result, only when overlay is on.
  let cone = null, fcLen = 0;
  if (coneOn && oracle && oracle.mc && oracle.mc.cone.length > 1) {
    const dt = oracle.meta.barMs;
    const lastT = times[times.length-1];
    cone = oracle.mc.cone.map((c,i) => ({ t:lastT+dt*i, ...c }));
    fcLen = cone.length - 1;
  }

  const allY = [...ohlcData.flatMap(d=>[d.h,d.l]), ...e20.filter(Boolean), ...e50.filter(Boolean)];
  if (cone) cone.forEach(c => allY.push(c.p95, c.p5));
  const yMin = Math.min(...allY), yMax = Math.max(...allY);
  const yPad = (yMax-yMin)*0.09 || Math.abs(yMin)*0.05 || 1;
  const yLo  = yMin-yPad, yHi = yMax+yPad, yRng = yHi-yLo||1;

  const nBars = ohlcData.length + fcLen;
  model = { closes, times, e20, e50, cone, yLo, yRng, nBars, fcLen };
}

/* ─── Draw ───────────────────────────────────────────────────────────────────── */
let _sx, _sy;

function draw(hoverIdx) {
  if (!model || !ohlcData.length) { ctx2.clearRect(0,0,CW,CH); return; }
  const W = CW, H = CH;
  const pw = W - PAD.left - PAD.right;
  const ph = H - PAD.top  - PAD.bottom;
  ctx2.clearRect(0, 0, W, H);

  const { e20, e50, cone, yLo, yRng, nBars } = model;

  _sx = i => PAD.left + (i/Math.max(nBars-1,1))*pw;
  _sy = v => PAD.top  + ph*(1-(v-yLo)/yRng);

  // Grid + Y axis labels
  for (let i=0;i<=6;i++) {
    const v = yLo+yRng*(i/6), y = _sy(v);
    ctx2.strokeStyle=GRID_C; ctx2.lineWidth=1;
    ctx2.beginPath(); ctx2.moveTo(PAD.left,y); ctx2.lineTo(W-PAD.right,y); ctx2.stroke();
    ctx2.fillStyle=TICK_C; ctx2.font='10px DM Mono,monospace'; ctx2.textAlign='left';
    ctx2.fillText(fmtPrice(v), W-PAD.right+6, y+4);
  }

  // X axis time labels (always-on — grounds the chart in real time)
  ctx2.fillStyle=TICK_C; ctx2.font='9px DM Mono,monospace'; ctx2.textAlign='center';
  const xticks = 5;
  for (let i=0;i<=xticks;i++) {
    const idx = Math.round((ohlcData.length-1) * i/xticks);
    const x = _sx(idx);
    if (x > PAD.left+12 && x < W-PAD.right-12)
      ctx2.fillText(fmtAxisTime(ohlcData[idx].t), x, H-PAD.bottom+13);
  }

  // Monte-Carlo cone (behind candles)
  if (cone && cone.length>1) {
    const si = ohlcData.length-1;
    const bandFill = (key1, key2, alpha) => {
      ctx2.beginPath();
      cone.forEach((p,fi) => { const x=_sx(si+fi),y=_sy(p[key1]); fi===0?ctx2.moveTo(x,y):ctx2.lineTo(x,y); });
      for (let fi=cone.length-1;fi>=0;fi--) ctx2.lineTo(_sx(si+fi),_sy(cone[fi][key2]));
      ctx2.closePath(); ctx2.fillStyle=`rgba(240,184,96,${alpha})`; ctx2.fill();
    };
    bandFill('p95','p5', 0.08);    // 90% interval
    bandFill('p75','p25', 0.16);   // 50% interval
  }

  // EMAs
  line(e20, EMA20_C, 1.5);
  line(e50, EMA50_C, 1.5);

  // Candles
  const barW = Math.max(1.5, (pw/nBars)*0.65);
  ohlcData.forEach((d,i) => {
    const x=_sx(i), yO=_sy(d.o), yC=_sy(d.c), yH=_sy(d.h), yL=_sy(d.l);
    const bull = d.c>=d.o, col = bull?BULL_C:BEAR_C;
    if (hoverIdx===i) { ctx2.fillStyle='rgba(255,255,255,0.04)'; ctx2.fillRect(x-barW/2-2,PAD.top,barW+4,ph); }
    ctx2.strokeStyle=col; ctx2.lineWidth=1;
    ctx2.beginPath(); ctx2.moveTo(x,yH); ctx2.lineTo(x,yL); ctx2.stroke();
    ctx2.fillStyle=col; ctx2.fillRect(x-barW/2, Math.min(yO,yC), barW, Math.max(1.5,Math.abs(yC-yO)));
  });

  // Median projection line + separator + label
  if (cone && cone.length>1) {
    const si = ohlcData.length-1;
    const sepX = _sx(si);

    ctx2.save(); ctx2.strokeStyle='rgba(240,184,96,0.35)'; ctx2.lineWidth=1; ctx2.setLineDash([4,4]);
    ctx2.beginPath(); ctx2.moveTo(sepX,PAD.top); ctx2.lineTo(sepX,H-PAD.bottom); ctx2.stroke();
    ctx2.setLineDash([]); ctx2.restore();

    ctx2.fillStyle='rgba(240,184,96,0.6)'; ctx2.font='9px DM Mono,monospace'; ctx2.textAlign='center';
    ctx2.fillText('▶ MONTE CARLO', (sepX+(W-PAD.right))/2, PAD.top+13);

    ctx2.save();
    ctx2.strokeStyle=AI_C; ctx2.lineWidth=2; ctx2.setLineDash([7,5]);
    ctx2.beginPath();
    cone.forEach((p,fi) => { const x=_sx(si+fi),y=_sy(p.p50); fi===0?ctx2.moveTo(x,y):ctx2.lineTo(x,y); });
    ctx2.stroke(); ctx2.setLineDash([]); ctx2.restore();
  }

  // Crosshair + pinned axis labels
  if (hoverIdx!=null && hoverIdx>=0 && hoverIdx<ohlcData.length) {
    const d    = ohlcData[hoverIdx];
    const cx   = _sx(hoverIdx);
    const cy   = _sy(d.c);
    const bull = d.c >= d.o;

    ctx2.save();
    ctx2.strokeStyle='rgba(240,237,232,0.13)'; ctx2.lineWidth=1; ctx2.setLineDash([4,5]);
    ctx2.beginPath(); ctx2.moveTo(cx,PAD.top); ctx2.lineTo(cx,H-PAD.bottom); ctx2.stroke();
    ctx2.beginPath(); ctx2.moveTo(PAD.left,cy); ctx2.lineTo(W-PAD.right,cy); ctx2.stroke();
    ctx2.setLineDash([]);

    ctx2.beginPath(); ctx2.arc(cx,cy,4,0,Math.PI*2);
    ctx2.fillStyle = bull ? BULL_C : BEAR_C; ctx2.fill();

    const xLbl = fmtFull(d.t);
    ctx2.font   = '10px DM Mono,monospace';
    const xTw   = ctx2.measureText(xLbl).width;
    const xPad  = 7, xBw = xTw+xPad*2, xBh = 18;
    const xBx   = Math.min(Math.max(cx-xBw/2, PAD.left), W-PAD.right-xBw);
    const xBy   = H-PAD.bottom+3;
    ctx2.fillStyle='#2a2a2a'; roundRect(ctx2,xBx,xBy,xBw,xBh,4);
    ctx2.fillStyle='#f0ede8'; ctx2.textAlign='left';
    ctx2.fillText(xLbl, xBx+xPad, xBy+13);

    const yLbl = fmtPrice(d.c);
    const yTw  = ctx2.measureText(yLbl).width;
    const yBw  = yTw+xPad*2, yBh = 18;
    const yBx  = W-PAD.right+4;
    const yBy  = Math.min(Math.max(cy-yBh/2, PAD.top), H-PAD.bottom-yBh);
    ctx2.fillStyle = bull ? 'rgba(200,240,96,0.92)' : 'rgba(255,107,107,0.92)';
    roundRect(ctx2,yBx,yBy,yBw,yBh,4);
    ctx2.fillStyle='#0e0e0e'; ctx2.textAlign='left';
    ctx2.fillText(yLbl, yBx+xPad, yBy+13);

    ctx2.restore();
  }
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x+r,y); c.lineTo(x+w-r,y); c.arcTo(x+w,y,x+w,y+r,r);
  c.lineTo(x+w,y+h-r); c.arcTo(x+w,y+h,x+w-r,y+h,r);
  c.lineTo(x+r,y+h); c.arcTo(x,y+h,x,y+h-r,r);
  c.lineTo(x,y+r); c.arcTo(x,y,x+r,y,r);
  c.closePath(); c.fill();
}

function line(vals, color, width) {
  ctx2.strokeStyle=color; ctx2.lineWidth=width; ctx2.beginPath();
  let started=false;
  vals.forEach((v,i) => {
    if (v==null){started=false;return;}
    const x=_sx(i),y=_sy(v);
    if(!started){ctx2.moveTo(x,y);started=true;} else ctx2.lineTo(x,y);
  });
  ctx2.stroke();
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
    <path d="${track}" pathLength="100" fill="none" stroke="#242424" stroke-width="14" stroke-linecap="round"/>
    <!-- gradient fill from the left (bear) stopping at the score -->
    <path d="${track}" pathLength="100" fill="none" stroke="url(#gaugeGrad)" stroke-width="14"
          stroke-linecap="round" stroke-dasharray="${score} 100"/>
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

    <!-- VERDICT -->
    <div class="ocard verdict">
      <div class="ocard-title">Oracle Verdict</div>
      ${odesc('All signals fused into one score, 0–100.', '50 = neutral · higher = stronger bullish odds.')}
      <div class="gauge-wrap">${gaugeSVG(C.score, col)}</div>
      <div class="gauge-ends"><span class="ge-bear">◀ Bear</span><span class="ge-bull">Bull ▶</span></div>
      <div class="verdict-label" style="color:${col}">${C.label}</div>
      <div class="verdict-conf">Confidence <strong>${C.confidence}%</strong> · ${res.meta.bars} candles</div>
      <div class="verdict-regime">${res.regime.label}</div>
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
function analyzeAndRender() {
  oracle = (ohlcData.length >= 30 && window.Oracle) ? Oracle.analyze(ohlcData) : null;
  renderOracle(oracle);
  document.getElementById('aiBadge').classList.toggle('on', coneOn);
  rebuildModel();
}

/* ─── Load chart (full load, with spinner) ──────────────────────────────────── */
async function loadChart({ force = false } = {}) {
  const coinId = document.getElementById('coinSelect').value;
  if (!coinId) return;

  const myReq = ++reqId;
  stopAutoRefresh();
  savePrefs();
  lastPrice = null;                       // reset so the price flash isn't misleading across coins
  const coin = coins.find(c => c.id === coinId);

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

  sizeCanvas();
  analyzeAndRender();
  draw();
  clearLoading();

  lastUpdated = Date.now();
  setLive('', 'Live · just now');
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

    analyzeAndRender();
    requestDraw();

    lastUpdated = Date.now();
    setLive('', 'Live · just now');
  } catch (e) {
    if (myReq !== reqId) return;
    setLive('stale', 'Reconnecting…');
    if (e.rateLimited) toast('Rate limited — backing off live updates.');
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  const interval = TF_REFRESH[currentTF] || 60000;
  refreshTimer = setInterval(refreshLive, interval);
}
function stopAutoRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopAutoRefresh();
  } else if (ohlcData.length) {
    if (Date.now() - lastUpdated > 15000) refreshLive();
    startAutoRefresh();
  }
});

/* ─── Crosshair / tooltip — rAF-throttled for smoothness ─────────────────────── */
const tooltip = document.getElementById('tooltip');
let pendingHover = null;
let rafQueued = false;

function requestDraw(hoverIdx) {
  if (rafQueued) return;
  rafQueued = true;
  requestAnimationFrame(() => {
    rafQueued = false;
    if (pendingHover === 'clear') { tooltip.style.display='none'; draw(); pendingHover=null; return; }
    if (pendingHover) { renderHover(pendingHover.x, pendingHover.y); pendingHover=null; }
    else draw(hoverIdx);
  });
}

function renderHover(clientX, clientY) {
  if (!ohlcData.length || isFetching) return;
  const rect = cv.getBoundingClientRect();
  const mx   = (clientX - rect.left);
  const pw   = CW - PAD.left - PAD.right;
  const idx  = Math.round(((mx - PAD.left) / pw) * (ohlcData.length - 1));
  if (idx < 0 || idx >= ohlcData.length) { tooltip.style.display='none'; draw(); return; }

  draw(idx);

  const d    = ohlcData[idx];
  const bull = d.c >= d.o;
  const ty   = (clientY - rect.top) - 24;
  const tx   = clientX - rect.left + 18;
  const tw   = 190;
  tooltip.style.display = 'block';
  tooltip.style.left = (tx + tw > rect.width ? tx - tw - 28 : tx) + 'px';
  tooltip.style.top  = Math.max(4, Math.min(ty, rect.height - 90)) + 'px';
  tooltip.innerHTML  =
    `<span style="color:var(--muted);font-size:10px">${fmtFull(d.t)}</span><br>` +
    `<span style="color:var(--muted)">O</span> <strong>${fmtUSD(d.o)}</strong>&ensp;` +
    `<span style="color:var(--muted)">H</span> <strong style="color:var(--bull)">${fmtUSD(d.h)}</strong><br>` +
    `<span style="color:var(--muted)">L</span> <strong style="color:var(--bear)">${fmtUSD(d.l)}</strong>&ensp;` +
    `<span style="color:var(--muted)">C</span> <strong style="color:${bull?'var(--bull)':'var(--bear)'}">${fmtUSD(d.c)}</strong>`;
}

function onPointer(clientX, clientY) { pendingHover = { x: clientX, y: clientY }; requestDraw(); }
function clearHover() { pendingHover = 'clear'; requestDraw(); }

cv.addEventListener('mousemove', e => onPointer(e.clientX, e.clientY));
cv.addEventListener('mouseleave', clearHover);
cv.addEventListener('touchmove', e => {
  e.preventDefault();
  const t = e.touches[0];
  onPointer(t.clientX, t.clientY);
}, { passive: false });
cv.addEventListener('touchend', clearHover);
cv.addEventListener('touchcancel', clearHover);

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
  if (ohlcData.length) { rebuildModel(); requestDraw(); }
});

document.getElementById('refreshBtn').addEventListener('click', () => {
  if (isFetching) return;
  loadChart({ force: true });   // force-bypass cache for both candles + price
});

document.getElementById('retryBtn').addEventListener('click', () => {
  if (!coins.length) boot();
  else loadChart({ force: true });
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { sizeCanvas(); draw(); if (oracle) drawDistribution(oracle); }, 120);
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
