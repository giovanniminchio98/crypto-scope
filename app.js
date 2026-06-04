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
let aiEnabled = false;
let currentTF = 1;      // always a Number
let isFetching = false;
let reqId      = 0;     // monotonically increasing token — guards against stale responses
let refreshTimer = null;
let lastUpdated  = 0;
let lastPrice    = null;
let model        = null; // precomputed render model (EMAs, forecast, scales)

/* ─── Persisted prefs ───────────────────────────────────────────────────────── */
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    if (TF_LABELS[p.tf]) currentTF = +p.tf;
    if (typeof p.ai === 'boolean') aiEnabled = p.ai;
    return p;
  } catch { return {}; }
}
function savePrefs() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      coin: document.getElementById('coinSelect').value,
      tf: currentTF,
      ai: aiEnabled,
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
        // Rate limited — respect Retry-After if present, else back off.
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
      // Don't keep retrying on the final attempt; otherwise back off (250,500,1000ms…)
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
    // Serve stale-on-error if we have anything cached — keeps the UI alive.
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
  // Restore saved timeframe / AI state into the UI before first paint.
  const prefs = loadPrefs();
  document.querySelectorAll('input[name="tf"]').forEach(r => { r.checked = (+r.value === currentTF); });
  document.getElementById('tfLabel').innerHTML = `Timeframe <strong>${TF_LABELS[currentTF]}</strong>`;
  document.getElementById('aiToggle').classList.toggle('active', aiEnabled);

  setLive('syncing', 'Connecting…');
  try {
    coins = await cachedJSON(
      'markets',
      `${API}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=20&page=1&sparkline=false&price_change_percentage=24h`,
      MARKETS_TTL
    );
    if (!Array.isArray(coins) || !coins.length) throw new Error('No market data');
    document.getElementById('coinSelect').innerHTML = coins.map(c =>
      `<option value="${c.id}">${c.symbol.toUpperCase()} — ${c.name}</option>`
    ).join('');
    // Restore previously selected coin if it's still in the top 20.
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

  // Price with directional flash on change
  const priceEl = document.getElementById('coinPrice');
  const newPrice = coin.current_price;
  priceEl.textContent = fmtUSD(newPrice);
  if (lastPrice != null && newPrice != null && newPrice !== lastPrice) {
    const cls = newPrice > lastPrice ? 'flash-up' : 'flash-dn';
    priceEl.classList.remove('flash-up', 'flash-dn');
    void priceEl.offsetWidth; // restart transition
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

/* ─── Fetch a single coin's latest market data (cheap live price refresh) ────── */
async function fetchCoinMarket(coinId) {
  const arr = await fetchJSON(
    `${API}/coins/markets?vs_currency=usd&ids=${coinId}&price_change_percentage=24h`,
    { tries: 2, timeout: 7000 }
  );
  return Array.isArray(arr) && arr[0] ? arr[0] : null;
}

/* ─── Math ───────────────────────────────────────────────────────────────────── */
function calcEMA(vals, period) {
  const out = new Array(vals.length).fill(null);
  if (vals.length < period) return out;
  const k = 2 / (period + 1);
  let prev = vals.slice(0, period).reduce((a,b)=>a+b,0) / period;
  out[period-1] = prev;
  for (let i = period; i < vals.length; i++) { prev = vals[i]*k + prev*(1-k); out[i] = prev; }
  return out;
}

function calcLinReg(vals) {
  const n = vals.length;
  let sx=0,sy=0,sxy=0,sx2=0;
  for (let i=0;i<n;i++) { sx+=i; sy+=vals[i]; sxy+=i*vals[i]; sx2+=i*i; }
  const d = n*sx2 - sx*sx;
  if (!d) return { slope:0, intercept:vals[0]||0 };
  const slope = (n*sxy-sx*sy)/d;
  return { slope, intercept:(sy-slope*sx)/n };
}

function calcVol(vals) {
  if (vals.length < 2) return 0.01;
  const rets = [];
  for (let i=1;i<vals.length;i++) if(vals[i-1]) rets.push((vals[i]-vals[i-1])/vals[i-1]);
  if (!rets.length) return 0.01;
  const mu = rets.reduce((a,b)=>a+b,0)/rets.length;
  return Math.sqrt(rets.reduce((a,b)=>a+(b-mu)**2,0)/rets.length) || 0.01;
}

function buildForecast(closes, times) {
  const fBars = Math.max(8, Math.round(closes.length * 0.18));
  const { slope, intercept } = calcLinReg(closes);
  const sigma = calcVol(closes);
  const dt    = times.length > 1 ? times[times.length-1] - times[times.length-2] : 3600000;
  const lastT = times[times.length-1];
  const lastC = closes[closes.length-1];
  const pts   = [];
  for (let f=0; f<=fBars; f++) {
    const val  = f===0 ? lastC : slope*(closes.length-1+f)+intercept;
    const band = lastC * sigma * Math.sqrt(f) * 3.0;
    pts.push({ t:lastT+dt*f, v:val, upper:val+band, lower:val-band });
  }
  return { pts, slope, sigma, fBars };
}

/* ─── Build render model once per data change (so hover redraws are cheap) ───── */
function rebuildModel() {
  if (!ohlcData.length) { model = null; return; }
  const closes = ohlcData.map(d=>d.c);
  const times  = ohlcData.map(d=>d.t);
  const e20    = calcEMA(closes, Math.min(20, closes.length));
  const e50    = calcEMA(closes, Math.min(50, closes.length));
  const fc     = aiEnabled ? buildForecast(closes, times) : null;

  const allY = [...ohlcData.flatMap(d=>[d.h,d.l]), ...e20.filter(Boolean), ...e50.filter(Boolean)];
  if (fc) allY.push(...fc.pts.flatMap(p=>[p.upper,p.lower]));
  const yMin = Math.min(...allY), yMax = Math.max(...allY);
  const yPad = (yMax-yMin)*0.09 || Math.abs(yMin)*0.05 || 1;
  const yLo  = yMin-yPad, yHi = yMax+yPad, yRng = yHi-yLo||1;

  const fcLen = fc ? fc.pts.length-1 : 0;
  const nBars = ohlcData.length + fcLen;

  model = { closes, times, e20, e50, fc, yLo, yRng, nBars, fcLen };
}

/* ─── Draw ───────────────────────────────────────────────────────────────────── */
let _sx, _sy;

function draw(hoverIdx) {
  if (!model || !ohlcData.length) { ctx2.clearRect(0,0,CW,CH); return; }
  const W = CW, H = CH;
  const pw = W - PAD.left - PAD.right;
  const ph = H - PAD.top  - PAD.bottom;
  ctx2.clearRect(0, 0, W, H);

  const { e20, e50, fc, yLo, yRng, nBars } = model;

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

  // AI band (behind everything)
  if (fc && fc.pts.length>1) {
    const si = ohlcData.length-1;
    ctx2.beginPath();
    fc.pts.forEach((p,fi) => { const x=_sx(si+fi),y=_sy(p.upper); fi===0?ctx2.moveTo(x,y):ctx2.lineTo(x,y); });
    for (let fi=fc.pts.length-1;fi>=0;fi--) ctx2.lineTo(_sx(si+fi),_sy(fc.pts[fi].lower));
    ctx2.closePath(); ctx2.fillStyle='rgba(240,184,96,0.16)'; ctx2.fill();
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

  // AI projection (on top)
  if (fc && fc.pts.length>1) {
    const si = ohlcData.length-1;
    const sepX = _sx(si);

    ctx2.save(); ctx2.strokeStyle='rgba(240,184,96,0.35)'; ctx2.lineWidth=1; ctx2.setLineDash([4,4]);
    ctx2.beginPath(); ctx2.moveTo(sepX,PAD.top); ctx2.lineTo(sepX,H-PAD.bottom); ctx2.stroke();
    ctx2.setLineDash([]); ctx2.restore();

    ctx2.fillStyle='rgba(240,184,96,0.6)'; ctx2.font='9px DM Mono,monospace'; ctx2.textAlign='center';
    ctx2.fillText('▶  FORECAST', (sepX+(W-PAD.right))/2, PAD.top+13);

    ctx2.save(); ctx2.strokeStyle='rgba(240,184,96,0.3)'; ctx2.lineWidth=1; ctx2.setLineDash([2,5]);
    ['upper','lower'].forEach(k => {
      ctx2.beginPath();
      fc.pts.forEach((p,fi) => { const x=_sx(si+fi),y=_sy(p[k]); fi===0?ctx2.moveTo(x,y):ctx2.lineTo(x,y); });
      ctx2.stroke();
    });
    ctx2.setLineDash([]); ctx2.restore();

    ctx2.save();
    ctx2.strokeStyle=AI_C; ctx2.lineWidth=2.5;
    ctx2.shadowColor='rgba(240,184,96,0.55)'; ctx2.shadowBlur=8;
    ctx2.setLineDash([9,5]);
    ctx2.beginPath();
    fc.pts.forEach((p,fi) => { const x=_sx(si+fi),y=_sy(p.v); fi===0?ctx2.moveTo(x,y):ctx2.lineTo(x,y); });
    ctx2.stroke(); ctx2.setLineDash([]); ctx2.shadowBlur=0; ctx2.restore();
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

/* ─── Update AI insight text ────────────────────────────────────────────────── */
function updateAIPanel(coin, coinId) {
  document.getElementById('aiBadge').classList.toggle('on', aiEnabled);
  document.getElementById('aiLegend').classList.toggle('on', aiEnabled);
  if (!aiEnabled || !model || !model.fc) {
    document.getElementById('aiInsight').classList.remove('on');
    return;
  }
  const fc    = model.fc;
  const closes= model.closes;
  const lastC = closes[closes.length-1];
  const endV  = fc.pts[fc.pts.length-1].v;
  const chPct = ((endV-lastC)/lastC*100).toFixed(2);
  const vol   = (fc.sigma*100).toFixed(3);
  const trend = fc.slope>0 ? 'bullish' : 'bearish';
  const str   = Math.abs(fc.slope/lastC*1000)>0.5 ? 'strong' : 'moderate';
  document.getElementById('aiTxt').innerHTML =
    `Based on <strong>${ohlcData.length} candles</strong> of ${TF_LABELS[currentTF]} price action,
    the regression model detects a <strong>${str} ${trend} trend</strong> for ${coin?coin.name:coinId}.
    Projected move over next <strong>${fc.fBars} bars</strong>:
    <strong>${+chPct>0?'+':''}${chPct}%</strong>.
    Per-bar volatility: <strong>${vol}%</strong> —
    shaded area shows ±1σ confidence corridor.
    ${Math.abs(+chPct)>5?'<br><strong style="color:var(--bear)">⚠ High momentum — elevated risk.</strong>':''}
    <br><br><em style="color:#555">Statistical projection only — not financial advice.</em>`;
  document.getElementById('aiInsight').classList.add('on');
}

/* ─── Load chart (full load, with spinner) ──────────────────────────────────── */
async function loadChart() {
  const coinId = document.getElementById('coinSelect').value;
  if (!coinId) return;

  const myReq = ++reqId;            // claim this request
  stopAutoRefresh();
  savePrefs();
  const coin = coins.find(c => c.id === coinId);

  setLoading(coin ? coin.name : coinId);
  if (coin) refreshBar(coin, true); // show price/change immediately, shimmer stats

  document.getElementById('tfLabel').innerHTML =
    `Timeframe <strong>${TF_LABELS[currentTF]}</strong>`;

  let data;
  try {
    data = await fetchOHLC(coinId, currentTF);
  } catch (e) {
    if (myReq !== reqId) return;     // a newer request superseded us — bail quietly
    console.error('OHLC fetch failed:', e);
    showError(e.rateLimited
      ? 'CoinGecko rate limit hit. Wait a moment, then retry.'
      : 'Couldn’t load chart data for this coin. Retry?');
    return;
  }

  if (myReq !== reqId) return;       // stale response — discard

  ohlcData = data;
  if (coin) refreshBar(coin, false);

  sizeCanvas();
  rebuildModel();
  draw();
  clearLoading();
  updateAIPanel(coin, coinId);

  lastUpdated = Date.now();
  setLive('', 'Live · just now');
  startAutoRefresh();
}

/* ─── Silent live refresh (no spinner, no control lockout) ──────────────────── */
async function refreshLive() {
  const coinId = document.getElementById('coinSelect').value;
  if (!coinId || isFetching || document.hidden) return;

  const myReq = reqId;               // piggyback on current request generation
  setLive('syncing', 'Updating…');
  try {
    // Fetch fresh candles + latest price in parallel.
    const [data, market] = await Promise.all([
      fetchOHLC(coinId, currentTF, { fresh: true }),
      fetchCoinMarket(coinId).catch(() => null)
    ]);
    if (myReq !== reqId) return;     // user switched coin/TF mid-flight

    ohlcData = data;
    const coin = coins.find(c => c.id === coinId);
    if (market && coin) Object.assign(coin, market);
    if (coin) refreshBar(coin, false);

    rebuildModel();
    requestDraw();
    updateAIPanel(coin, coinId);

    lastUpdated = Date.now();
    setLive('', 'Live · just now');
  } catch (e) {
    if (myReq !== reqId) return;
    // Background failure — keep showing existing data, just flag staleness.
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

// Pause polling when tab is hidden; refresh immediately when it returns.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopAutoRefresh();
  } else if (ohlcData.length) {
    // If data is stale on return, refresh right away then resume cadence.
    if (Date.now() - lastUpdated > 15000) refreshLive();
    startAutoRefresh();
  }
});

/* ─── Crosshair / tooltip — rAF-throttled for smoothness ─────────────────────── */
const tooltip = document.getElementById('tooltip');
let pendingHover = null;   // {x, y} or 'clear'
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

// Mouse
cv.addEventListener('mousemove', e => onPointer(e.clientX, e.clientY));
cv.addEventListener('mouseleave', clearHover);

// Touch
cv.addEventListener('touchmove', e => {
  e.preventDefault();
  const t = e.touches[0];
  onPointer(t.clientX, t.clientY);
}, { passive: false });
cv.addEventListener('touchend', clearHover);
cv.addEventListener('touchcancel', clearHover);

/* ─── Events ─────────────────────────────────────────────────────────────────── */
document.getElementById('coinSelect').addEventListener('change', loadChart);

document.querySelectorAll('input[name="tf"]').forEach(r =>
  r.addEventListener('change', e => { currentTF = +e.target.value; loadChart(); })
);

document.getElementById('aiToggle').addEventListener('click', () => {
  if (isFetching) return;
  aiEnabled = !aiEnabled;
  document.getElementById('aiToggle').classList.toggle('active', aiEnabled);
  savePrefs();
  if (ohlcData.length) {
    // No network needed — just recompute the model and redraw.
    rebuildModel();
    requestDraw();
    const coinId = document.getElementById('coinSelect').value;
    updateAIPanel(coins.find(c => c.id === coinId), coinId);
  }
});

document.getElementById('retryBtn').addEventListener('click', () => {
  if (!coins.length) boot();
  else loadChart();
});

// Debounced resize so dragging the window doesn't thrash redraws.
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { sizeCanvas(); draw(); }, 120);
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
function fmtFull(ts) {
  return new Date(ts).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
}

/* ─── Boot ───────────────────────────────────────────────────────────────────── */
boot();
