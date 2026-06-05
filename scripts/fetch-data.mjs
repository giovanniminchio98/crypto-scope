/* ─────────────────────────────────────────────────────────────────────────────
 * CryptoScope — daily data fetcher (runs in GitHub Actions, not in the browser).
 *
 * Pulls everything the app needs for the top-20 coins and writes it as static
 * JSON into ./data, so the deployed site makes ZERO API calls at runtime — the
 * number of CoinGecko calls is fixed per run, independent of how many people
 * visit. The CoinGecko key is read from the CG_KEY secret (server-side only).
 *
 * Output:
 *   data/markets.json            — raw CoinGecko top-20 markets
 *   data/ohlc/<id>-<tf>.json     — raw CoinGecko OHLC per coin & timeframe
 *   data/history/<id>.json       — { prices: [[tsMs, price], ...] } (weekly)
 *   data/meta.json               — { generatedAt, coins, ok, fail }
 * ───────────────────────────────────────────────────────────────────────────── */
import { writeFile, mkdir } from 'node:fs/promises';

const CG  = 'https://api.coingecko.com/api/v3';
const KEY = process.env.CG_KEY || '';
const OUT = 'data';
const TF_DAYS = { '1': 1, '4': 7, '24': 30, '168': 180 };   // must match the app

const sleep = ms => new Promise(r => setTimeout(r, ms));
const withKey = u => KEY ? u + (u.includes('?') ? '&' : '?') + 'x_cg_demo_api_key=' + KEY : u;

async function getJSON(url, { tries = 4, noKey = false } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(noKey ? url : withKey(url), { headers: { accept: 'application/json' } });
      if (r.status === 429) { await sleep(4000 * (i + 1)); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { lastErr = e; if (i < tries - 1) await sleep(1500 * (i + 1)); }
  }
  throw lastErr;
}

async function main() {
  await mkdir(OUT, { recursive: true });

  console.log('Fetching markets…');
  const markets = await getJSON(`${CG}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=20&page=1&sparkline=false&price_change_percentage=24h`);
  const ids = markets.map(c => c.id);

  // One bundle holds everything for every coin → the site loads it once.
  const bundle = { generatedAt: Date.now(), intervalHours: 6, coins: ids, markets, ohlc: {}, history: {} };

  let ok = 0, fail = 0;
  for (const c of markets) {
    bundle.ohlc[c.id] = {};
    for (const [tf, days] of Object.entries(TF_DAYS)) {
      try {
        bundle.ohlc[c.id][tf] = await getJSON(`${CG}/coins/${c.id}/ohlc?vs_currency=usd&days=${days}`);
        ok++;
      } catch (e) { console.error('  OHLC fail', c.id, tf, e.message); fail++; }
      await sleep(2400);  // stay well under the demo-tier rate limit
    }
    // Long history from CryptoCompare (keyless), downsampled to weekly to keep the bundle lean.
    try {
      const sym = (c.symbol || c.id).toUpperCase();
      const cc = await getJSON(`https://min-api.cryptocompare.com/data/v2/histoday?fsym=${encodeURIComponent(sym)}&tsym=USD&allData=true`, { noKey: true });
      const arr = (cc && cc.Data && cc.Data.Data) || [];
      bundle.history[c.id] = arr.filter((d, i) => d && d.close > 0 && i % 7 === 0).map(d => [d.time * 1000, +d.close]);
    } catch (e) { console.error('  history fail', c.id, e.message); }
    await sleep(1200);
  }

  await writeFile(`${OUT}/bundle.json`, JSON.stringify(bundle));
  await writeFile(`${OUT}/meta.json`, JSON.stringify({ generatedAt: bundle.generatedAt, intervalHours: 6, coins: ids, ok, fail }));
  console.log(`Done. OHLC ok=${ok} fail=${fail}, ${ids.length} coins → data/bundle.json`);
}

main().catch(e => { console.error(e); process.exit(1); });
