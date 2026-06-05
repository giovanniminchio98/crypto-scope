/* Generates the app icons (PNG) from a small candlestick design using only
 * Node's built-in zlib — no image libraries needed. Run: node scripts/make-icons.mjs */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

/* ── minimal PNG encoder ───────────────────────────────────────────────────── */
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride); }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ── design (normalized 0..1 coordinates) ──────────────────────────────────── */
const LIME = [200, 240, 96];
const RED  = [255, 107, 107];
const AMBER= [240, 184, 96];
// three rising candles: [centerX, bodyTop, bodyBottom, wickTop, wickBottom, color]
const CANDLES = [
  [0.315, 0.52, 0.66, 0.46, 0.72, RED],
  [0.500, 0.42, 0.56, 0.36, 0.62, LIME],
  [0.685, 0.28, 0.46, 0.22, 0.52, LIME],
];
const BODY_W = 0.13, WICK_W = 0.03;

function makeIconRGBA(size, zoom = 1) {
  const SS = 4, W = size * SS, H = size * SS;
  const tx = v => 0.5 + (v - 0.5) * zoom;   // scale content around the centre
  const buf = Buffer.alloc(W * H * 4);
  const px = (x, y, c) => { const i = (y * W + x) * 4; buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = 255; };
  // background: subtle vertical gradient (#1b1b1b → #0c0c0c) with a faint lime glow top-right
  for (let y = 0; y < H; y++) {
    const t = y / H;
    const base = Math.round(0x1b + (0x0c - 0x1b) * t);
    for (let x = 0; x < W; x++) {
      const gx = x / W, gy = y / H;
      const glow = Math.max(0, 1 - Math.hypot(gx - 0.85, gy - 0.12) * 1.7) * 22;
      px(x, y, [Math.min(255, base + glow * 0.9), Math.min(255, base + glow), Math.min(255, base + glow * 0.4)]);
    }
  }
  const fillRect = (x0, y0, x1, y1, c, r = 0) => {
    const X0 = Math.round(x0 * W), Y0 = Math.round(y0 * H), X1 = Math.round(x1 * W), Y1 = Math.round(y1 * H);
    const rr = r * W;
    for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      if (rr > 0) { // rounded corners
        const cx = Math.min(Math.max(x, X0 + rr), X1 - rr), cy = Math.min(Math.max(y, Y0 + rr), Y1 - rr);
        if (Math.hypot(x - cx, y - cy) > rr) continue;
      }
      px(x, y, c);
    }
  };
  // candles (content scaled around centre by `zoom`)
  const bw = BODY_W * zoom, ww = WICK_W * zoom;
  for (const [cx, bt, bb, wt, wb, col] of CANDLES) {
    const cxz = tx(cx);
    fillRect(cxz - ww / 2, tx(wt), cxz + ww / 2, tx(wb), col);               // wick
    fillRect(cxz - bw / 2, tx(bt), cxz + bw / 2, tx(bb), col, 0.02 * zoom);  // body
  }
  // downsample SS×SS → 1 (anti-alias)
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const i = ((y * SS + sy) * W + (x * SS + sx)) * 4; r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
    }
    const n = SS * SS, o = (y * size + x) * 4;
    out[o] = r / n | 0; out[o + 1] = g / n | 0; out[o + 2] = b / n | 0; out[o + 3] = a / n | 0;
  }
  return out;
}

for (const [size, zoom] of [[32, 1.45], [48, 1.4], [180, 1], [192, 1], [512, 1]]) {
  const name = size === 180 ? 'apple-touch-icon.png' : size <= 48 ? `favicon-${size}.png` : `icon-${size}.png`;
  writeFileSync(`icons/${name}`, encodePNG(size, size, makeIconRGBA(size, zoom)));
  console.log('wrote icons/' + name);
}
