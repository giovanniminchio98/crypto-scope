/* ─────────────────────────────────────────────────────────────────────────────
 * CryptoScope — daily data fetcher (runs in GitHub Actions, not in the browser).
 *
 * Pulls everything the app needs for the top-20 coins and writes one static
 * bundle, so the deployed site makes ZERO API calls at runtime regardless of
 * traffic. Prices come from CoinGecko (markets, needs the CG_API_KEY secret);
 * candles + history come from CryptoCompare (keyless, exact per-interval candles).
 *
 * Output:
 *   data/bundle.json — { generatedAt, intervalHours, coins, markets,
 *                        ohlc:{ <id>:{ <tf>:[[t,o,h,l,c],...] } },
 *                        history:{ <id>:[[t,price],...] } }
 *   data/meta.json   — { generatedAt, intervalHours, coins, ok, fail }
 * ───────────────────────────────────────────────────────────────────────────── */
import { writeFile, mkdir, readFile } from 'node:fs/promises';

const CG  = 'https://api.coingecko.com/api/v3';
const CC  = 'https://min-api.cryptocompare.com/data';
const KEY = process.env.CG_KEY || '';
const OUT = 'data';
// CryptoCompare endpoints giving EXACT candles for each timeframe (keyless).
const TF_CC = { '1': ['histohour', 1], '4': ['histohour', 4], '24': ['histoday', 1], '168': ['histoday', 7] };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const withKey = u => KEY ? u + (u.includes('?') ? '&' : '?') + 'x_cg_demo_api_key=' + KEY : u;

async function getJSON(url, { tries = 4, noKey = false } = {}) {
  let lastErr = new Error('request failed');
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(noKey ? url : withKey(url), { headers: { accept: 'application/json' } });
      if (r.status === 429) { lastErr = new Error('HTTP 429 (rate limited)'); await sleep(4000 * (i + 1)); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { lastErr = e || lastErr; if (i < tries - 1) await sleep(1500 * (i + 1)); }
  }
  throw lastErr;
}

// Exact OHLC candles from CryptoCompare (keyless, true per-interval).
async function ccOHLC(sym, tf) {
  const [path, agg] = TF_CC[tf];
  const j = await getJSON(`${CC}/v2/${path}?fsym=${encodeURIComponent(sym)}&tsym=USD&aggregate=${agg}&limit=300`, { noKey: true });
  const arr = (j && j.Data && j.Data.Data) || [];
  return arr.filter(d => d && d.close > 0).map(d => [d.time * 1000, d.open, d.high, d.low, d.close]);
}

// Map CryptoCompare's top-by-mcap rows to the CoinGecko markets shape the app uses.
function ccToMarkets(rows) {
  return rows.filter(x => x && x.RAW && x.RAW.USD && x.CoinInfo).map(x => {
    const i = x.CoinInfo, u = x.RAW.USD;
    return {
      id: i.Name.toLowerCase(),                  // symbol-based id (consistent across runs)
      symbol: i.Name.toLowerCase(),
      name: i.FullName || i.Name,
      image: i.ImageUrl ? 'https://www.cryptocompare.com' + i.ImageUrl : '',
      current_price: u.PRICE,
      market_cap: u.MKTCAP,
      total_volume: u.TOTALVOLUME24HTO,
      high_24h: u.HIGH24HOUR,
      low_24h: u.LOW24HOUR,
      price_change_percentage_24h: u.CHANGEPCT24HOUR,
    };
  });
}

async function fetchMarkets(prev) {
  // 1) CoinGecko — best fidelity; works reliably when the CG_API_KEY secret is set.
  try {
    const m = await getJSON(`${CG}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=20&page=1&sparkline=false&price_change_percentage=24h`);
    if (Array.isArray(m) && m.length) return m;
  } catch (e) { console.error('CoinGecko markets failed:', e && e.message); }
  // 2) CryptoCompare top-by-mcap — keyless, so the job succeeds without any secret.
  try {
    const j = await getJSON(`${CC}/top/mcapfull?limit=20&tsym=USD`, { noKey: true });
    const m = ccToMarkets((j && j.Data) || []);
    if (m.length) { console.log('Using CryptoCompare markets fallback (keyless).'); return m; }
  } catch (e) { console.error('CryptoCompare markets failed:', e && e.message); }
  // 3) Previous bundle.
  return prev.markets;
}

async function main() {
  await mkdir(OUT, { recursive: true });

  // Carry-forward: reuse the previous bundle for anything that fails this run, so
  // the published bundle is always complete (no gaps → no switch errors).
  let prev = { markets: [], ohlc: {}, history: {} };
  try { prev = JSON.parse(await readFile(`${OUT}/bundle.json`, 'utf8')); } catch (e) { /* first run */ }

  console.log('Fetching markets…');
  const markets = await fetchMarkets(prev);
  if (!Array.isArray(markets) || !markets.length) throw new Error('No markets from any provider and no previous bundle');
  const ids = markets.map(c => c.id);

  // One bundle holds everything for every coin → the site loads it once.
  const bundle = { generatedAt: Date.now(), intervalHours: 6, coins: ids, markets, ohlc: {}, history: {} };

  let ok = 0, fail = 0, carried = 0;
  for (const c of markets) {
    const sym = (c.symbol || c.id).toUpperCase();
    bundle.ohlc[c.id] = {};
    // Candles from CryptoCompare → exact 1h/4h/1d/1w (keyless, not rate-limited).
    for (const tf of Object.keys(TF_CC)) {
      try {
        const candles = await ccOHLC(sym, tf);
        if (candles.length) { bundle.ohlc[c.id][tf] = candles; ok++; }
        else throw new Error('empty');
      } catch (e) {
        const old = prev.ohlc && prev.ohlc[c.id] && prev.ohlc[c.id][tf];
        if (old) { bundle.ohlc[c.id][tf] = old; carried++; }
        else { console.error('  OHLC fail', c.id, tf, e && e.message); fail++; }
      }
      await sleep(250);
    }
    // Long history (weekly) from CryptoCompare to keep the bundle lean.
    try {
      const cc = await getJSON(`${CC}/v2/histoday?fsym=${encodeURIComponent(sym)}&tsym=USD&allData=true`, { noKey: true });
      const arr = (cc && cc.Data && cc.Data.Data) || [];
      const weekly = arr.filter((d, i) => d && d.close > 0 && i % 7 === 0).map(d => [d.time * 1000, +d.close]);
      if (weekly.length) bundle.history[c.id] = weekly;
      else if (prev.history && prev.history[c.id]) { bundle.history[c.id] = prev.history[c.id]; carried++; }
    } catch (e) {
      if (prev.history && prev.history[c.id]) { bundle.history[c.id] = prev.history[c.id]; carried++; }
      else console.error('  history fail', c.id, e && e.message);
    }
    await sleep(250);
  }

  await writeFile(`${OUT}/bundle.json`, JSON.stringify(bundle));
  await writeFile(`${OUT}/meta.json`, JSON.stringify({ generatedAt: bundle.generatedAt, intervalHours: 6, coins: ids, ok, fail }));
  console.log(`Done. OHLC ok=${ok} fail=${fail} carried=${carried}, ${ids.length} coins → data/bundle.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
