/* ─────────────────────────────────────────────────────────────────────────────
 * CryptoScope — daily data fetcher (runs in GitHub Actions, not in the browser).
 *
 * Uses ONLY the CoinGecko API (with the CG_KEY secret) for markets, candles and
 * history, and writes one static bundle so the deployed site makes zero API
 * calls at runtime.
 *
 * NOTE: CoinGecko's free/demo tier caps historical data at 365 days, so the
 * seasonal/halving card needs more history than this source can provide — it
 * will show "not enough history" for most coins. (Multi-year history requires a
 * different source or a paid CoinGecko plan.)
 *
 * Output:
 *   data/bundle.json — { generatedAt, intervalHours, coins, markets,
 *                        ohlc:{ <id>:{ <tf>:[[t,o,h,l,c],...] } },
 *                        history:{ <id>:[[t,price],...] } }
 *   data/meta.json   — { generatedAt, intervalHours, coins, ok, fail }
 * ───────────────────────────────────────────────────────────────────────────── */
import { writeFile, mkdir, readFile } from 'node:fs/promises';

const CG  = 'https://api.coingecko.com/api/v3';
const KEY = process.env.CG_KEY || '';
const OUT = 'data';
const TF_DAYS = { '1': 1, '4': 7, '24': 30, '168': 180 };   // must match the app

const sleep = ms => new Promise(r => setTimeout(r, ms));
const withKey = u => KEY ? u + (u.includes('?') ? '&' : '?') + 'x_cg_demo_api_key=' + KEY : u;

async function getJSON(url, { tries = 4 } = {}) {
  let lastErr = new Error('request failed');
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(withKey(url), { headers: { accept: 'application/json' } });
      if (r.status === 429) { lastErr = new Error('HTTP 429 (rate limited)'); await sleep(5000 * (i + 1)); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { lastErr = e || lastErr; if (i < tries - 1) await sleep(1500 * (i + 1)); }
  }
  throw lastErr;
}

async function main() {
  await mkdir(OUT, { recursive: true });

  if (!KEY) console.warn('WARNING: no CoinGecko key set — anonymous calls from a datacenter IP are usually rate-limited.');

  // Carry-forward: reuse the previous bundle for anything that fails this run, so
  // the published bundle is always complete (no gaps → no switch errors).
  let prev = { markets: [], ohlc: {}, history: {} };
  try { prev = JSON.parse(await readFile(`${OUT}/bundle.json`, 'utf8')); } catch (e) { /* first run */ }

  console.log('Fetching markets…');
  let markets;
  try {
    markets = await getJSON(`${CG}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=20&page=1&sparkline=false&price_change_percentage=24h`);
  } catch (e) {
    console.error('markets failed:', e && e.message, '— reusing previous bundle.');
    markets = prev.markets;
  }
  if (!Array.isArray(markets) || !markets.length) {
    throw new Error('No markets from CoinGecko and no previous bundle. Check the CoinGecko key / rate limit.');
  }
  const ids = markets.map(c => c.id);

  const bundle = { generatedAt: Date.now(), intervalHours: 6, coins: ids, markets, ohlc: {}, history: {} };

  let ok = 0, fail = 0, carried = 0, histOk = 0, histMiss = 0;
  for (const c of markets) {
    bundle.ohlc[c.id] = {};
    // Candles — CoinGecko OHLC per timeframe.
    for (const [tf, days] of Object.entries(TF_DAYS)) {
      try {
        const arr = await getJSON(`${CG}/coins/${c.id}/ohlc?vs_currency=usd&days=${days}`);
        const candles = (arr || []).map(d => [+d[0], +d[1], +d[2], +d[3], +d[4]]);
        if (!candles.length) throw new Error('empty');
        bundle.ohlc[c.id][tf] = candles; ok++;
      } catch (e) {
        const old = prev.ohlc && prev.ohlc[c.id] && prev.ohlc[c.id][tf];
        if (old) { bundle.ohlc[c.id][tf] = old; carried++; }
        else { console.error(`  OHLC fail ${c.id} tf=${tf}: ${e && e.message}`); fail++; }
      }
      await sleep(2200);   // CoinGecko demo tier ≈ 30 calls/min
    }
    // History — CoinGecko market_chart (capped at 365 days on the free tier), weekly.
    try {
      const j = await getJSON(`${CG}/coins/${c.id}/market_chart?vs_currency=usd&days=365&interval=daily`);
      const w = ((j && j.prices) || []).filter((d, i) => i % 7 === 0).map(d => [d[0], d[1]]).filter(d => d[1] > 0);
      if (w.length >= 10) { bundle.history[c.id] = w; histOk++; }
      else throw new Error('too few points');
    } catch (e) {
      if (prev.history && prev.history[c.id]) { bundle.history[c.id] = prev.history[c.id]; carried++; histOk++; }
      else { console.error(`  history fail ${c.id}: ${e && e.message}`); histMiss++; }
    }
    await sleep(2200);
  }

  await writeFile(`${OUT}/bundle.json`, JSON.stringify(bundle));
  await writeFile(`${OUT}/meta.json`, JSON.stringify({ generatedAt: bundle.generatedAt, intervalHours: 6, coins: ids, ok, fail }));
  console.log(`Done. candles ok=${ok} fail=${fail} carried=${carried}; history ok=${histOk} missing=${histMiss}; ${ids.length} coins → data/bundle.json`);
  console.log('NOTE: CoinGecko free history is limited to 365 days — seasonal/halving cycles will be unavailable for most coins.');
}

main().catch(e => { console.error('FATAL:', e && e.message); process.exit(1); });
