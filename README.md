# CryptoScope

Real-time crypto candlestick charts for the top 20 coins by market cap, with
EMA overlays and a statistical AI trend projection. Pure static site — no build
step, no dependencies. Data via the [CoinGecko API](https://www.coingecko.com/en/api).

## Files

| File         | Purpose                                                       |
|--------------|---------------------------------------------------------------|
| `index.html` | Markup + layout (clearly divided sections)                    |
| `styles.css` | All styling (dark theme, animations, responsive)              |
| `oracle.js`  | Quant analytics engine — pure functions, no DOM (the "oracle")|
| `app.js`     | Data fetching, caching, canvas chart, live refresh, dashboard |

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

## The Oracle (quant engine)

`oracle.js` derives a full probabilistic reading from the candle series — the
kind of analytics you normally only see in quant terminals:

- **Monte-Carlo GBM simulation** (3,000 paths) → a probability cone on the chart
  plus a terminal-price distribution histogram, with concrete numbers: chance
  up/down over the horizon, expected & median move, 90% interval, and target
  **touch** probabilities (e.g. odds of tagging +1σ / ±5% / ±10%).
- **Hurst exponent** (R/S analysis) → persistent/trending vs mean-reverting
  regime detection.
- **Risk profile** — annualized volatility, historical **VaR & CVaR** (expected
  shortfall), max drawdown, Sharpe & Sortino.
- **Distribution stats** — skewness, excess kurtosis (fat tails), lag-1
  autocorrelation, Z-score.
- **Signal matrix** — 8 weighted factors (EMA trend, regression slope, MACD,
  RSI, Stochastic, Bollinger %B, Z-score, Hurst-adjusted drift) fused into a
  single **verdict gauge** (0–100) with a confidence score and regime label.

## Plain-English & seasonal views

- **Quick Read card** — a non-expert summary at the top of the Oracle: a big
  up/down probability split, a friendly verdict ("Leaning Up 📈"), a one-line
  takeaway, and a plain risk note. Built for someone with zero crypto/finance
  background.
- **Seasonal Pattern card** — analyzes long daily history (one cached call) for
  cyclical behaviour: Bitcoin uses its **4-year halving cycle**; everything else
  uses a **yearly cycle**. It overlays past cycles vs the current one on a chart,
  projects a "typical path" forward to a **price target**, and shows
  month-of-year seasonality. `seasonal.js` is a standalone, dependency-free
  engine.

## Features

- **Robust API layer** — request timeouts, retries with exponential backoff,
  429 rate-limit handling (honors `Retry-After`), and a TTL cache with
  stale-on-error fallback so transient failures don't blank the chart.
- **Live updates** — silent background auto-refresh per timeframe, paused when
  the tab is hidden; live "last updated" indicator and directional price flash.
  A manual **Refresh** button force-bypasses the cache for price + candles.
- **Professional chart** — rendered with [TradingView lightweight-charts]
  (https://github.com/tradingview/lightweight-charts) (loaded from a CDN, no
  build step): crisp candles, real time axis, built-in crosshair + OHLC legend,
  EMA 20/50 overlays, and the Monte-Carlo forecast (median + 5/95% bounds) drawn
  into the future.
- **Per-timeframe verdict** — four mini rings on the Oracle Verdict card show the
  composite score for 1H / 4H / 1D / 1W at a glance (computed in the background).
- **Remembers your last coin, timeframe, and cone toggle** across reloads.

### Social links

Footer icons (X, LinkedIn, Email) are at the bottom of `index.html`.

> Quant model output is a statistical estimate, not financial advice.
