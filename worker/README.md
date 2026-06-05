# CryptoScope API proxy (Cloudflare Worker)

Keeps your CoinGecko API key **server-side** so it never reaches the browser.
The web app calls this Worker; the Worker adds the key and forwards to CoinGecko.

## Why

A pure static site can't hide a key — anything shipped to the browser (and every
request URL) is readable in DevTools. This tiny Worker holds the key as an
encrypted secret, so the browser only ever sees calls to *your* Worker.

## Deploy (one time)

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and
[Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/).

```bash
cd worker
npm install -g wrangler     # if you don't have it
wrangler login

# Store your CoinGecko key as an encrypted secret (paste it when prompted):
wrangler secret put CG_API_KEY

# Publish:
wrangler deploy
```

Wrangler prints your Worker URL, e.g.:

```
https://cryptoscope-proxy.<your-subdomain>.workers.dev
```

## Point the app at it

In `../index.html`, set the app's API base to that URL (a line is already there,
commented, ready to fill in):

```html
<script>window.CRYPTOSCOPE_CONFIG = { apiBase: 'https://cryptoscope-proxy.<your-subdomain>.workers.dev' };</script>
```

That's it — the browser now talks only to the Worker, and the key stays private.

## Hardening (optional but recommended)

- **Lock to your origin** so nobody else can spend your quota: uncomment
  `ALLOWED_ORIGIN` in `wrangler.toml`, set it to your site URL, and redeploy.
- **Rotate the key.** Any key that was ever committed in plain text (e.g. in
  `index.html`) should be regenerated at coingecko.com — the old one lives on in
  git history. Put the new key only in the Worker secret.
