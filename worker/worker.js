/* ════════════════════════════════════════════════════════════════════════════
 * CryptoScope API proxy — Cloudflare Worker
 *
 * Keeps the CoinGecko API key server-side. The browser calls this Worker; the
 * Worker injects the key (from the CG_API_KEY secret) and forwards the request
 * to CoinGecko. The key is never sent to, or visible in, the browser.
 *
 * Deploy: see worker/README.md
 * ════════════════════════════════════════════════════════════════════════════ */

const UPSTREAM = 'https://api.coingecko.com/api/v3';

// Only these paths may be proxied — stops the Worker being an open proxy that
// anyone could point at arbitrary CoinGecko endpoints on your key's quota.
const ALLOW = [
  /^\/coins\/markets$/,              // top-N markets snapshot
  /^\/coins\/[^/]+\/ohlc$/,         // per-coin OHLC candles
  /^\/coins\/[^/]+\/market_chart$/, // per-coin daily history (seasonality)
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET')     return json({ error: 'Method not allowed' }, 405, cors);

    // Optional: lock the Worker to your site's origin (set ALLOWED_ORIGIN var).
    if (env.ALLOWED_ORIGIN && origin && origin !== env.ALLOWED_ORIGIN)
      return json({ error: 'Forbidden origin' }, 403, cors);

    if (!ALLOW.some(re => re.test(url.pathname)))
      return json({ error: 'Path not allowed' }, 404, cors);

    const upstream = UPSTREAM + url.pathname + url.search;

    // Serve from the edge cache when we can (cuts calls against your quota).
    const cache = caches.default;
    const cacheKey = new Request(upstream, { method: 'GET' });
    let cached = await cache.match(cacheKey);
    if (!cached) {
      const r = await fetch(upstream, {
        headers: {
          accept: 'application/json',
          'x-cg-demo-api-key': env.CG_API_KEY || '',
        },
        cf: { cacheTtl: 20, cacheEverything: true },
      });
      cached = new Response(r.body, { status: r.status, headers: r.headers });
      cached.headers.set('Cache-Control', 'public, max-age=20');
      if (r.ok) ctx.waitUntil(cache.put(cacheKey, cached.clone()));
    }

    const out = new Response(cached.body, cached);
    for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
    return out;
  },
};

function corsHeaders(origin, env) {
  const allow = env.ALLOWED_ORIGIN || '*';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'accept',
    'Vary': 'Origin',
  };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
