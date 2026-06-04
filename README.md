# CryptoScope

Real-time crypto candlestick charts for the top 20 coins by market cap, with
EMA overlays and a statistical AI trend projection. Pure static site — no build
step, no dependencies. Data via the [CoinGecko API](https://www.coingecko.com/en/api).

## Files

| File         | Purpose                                              |
|--------------|------------------------------------------------------|
| `index.html` | Markup + layout                                      |
| `styles.css` | All styling (dark theme, animations, responsive)     |
| `app.js`     | Data fetching, caching, canvas chart, live refresh   |

## Run locally

It's a static site, so just serve the folder with anything:

```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

(Opening `index.html` directly via `file://` also works, but a local server
avoids browser quirks.)

## Deploy

Drop the three files on any static host — GitHub Pages, Netlify, Vercel,
Cloudflare Pages, S3, etc. No configuration required.

## Optional: CoinGecko Demo API key

The app works anonymously, but CoinGecko's anonymous tier is rate-limited. A
free **Demo** API key raises those limits and makes the live auto-refresh much
more reliable. Get one at <https://www.coingecko.com/en/api>, then uncomment the
config line near the bottom of `index.html`:

```html
<script>window.CRYPTOSCOPE_CONFIG = { apiKey: 'CG-your-demo-key' };</script>
```

You can also override `apiBase` there (e.g. to point at the Pro API host or a
proxy of your own).

## Features

- **Robust API layer** — request timeouts, retries with exponential backoff,
  429 rate-limit handling (honors `Retry-After`), and a TTL cache with
  stale-on-error fallback so transient failures don't blank the chart.
- **Live updates** — silent background auto-refresh per timeframe, paused when
  the tab is hidden; live "last updated" indicator and directional price flash.
- **Smooth rendering** — `requestAnimationFrame`-throttled crosshair,
  precomputed chart model (so hovering doesn't recompute indicators),
  devicePixelRatio-aware canvas, and debounced resize.
- **Indicators** — EMA 20 / EMA 50 and an optional linear-regression forecast
  with a ±1σ confidence band.
- **Remembers your last coin, timeframe, and AI toggle** across reloads.

> AI projections are statistical estimates, not financial advice.
