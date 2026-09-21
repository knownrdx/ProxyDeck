#!/usr/bin/env node
// Generates icons/{on,off}-{16,32,48,128}.png — zero dependencies, hand-rolled PNG encoder.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(OUT, { recursive: true });

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // no filter
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const lerp = (a, b, t) => a + (b - a) * t;
function blend(dst, i, r, g, b, a) {
  const da = dst[i + 3] / 255;
  const out = a + da * (1 - a);
  if (out <= 0) return;
  dst[i] = Math.round((r * a + dst[i] * da * (1 - a)) / out);
  dst[i + 1] = Math.round((g * a + dst[i + 1] * da * (1 - a)) / out);
  dst[i + 2] = Math.round((b * a + dst[i + 2] * da * (1 - a)) / out);
  dst[i + 3] = Math.round(out * 255);
}

/** Rounded-square badge with a power glyph — "on" is green, "off" is slate. */
function drawIcon(size, on) {
  const S = 4;                 // supersample factor
  const N = size * S;
  const px = Buffer.alloc(N * N * 4);
  const radius = N * 0.26;
  const c1 = on ? [22, 196, 127] : [86, 98, 120];
  const c2 = on ? [79, 140, 255] : [52, 61, 80];

  const insideRounded = (x, y) => {
    const rx = Math.min(x, N - 1 - x), ry = Math.min(y, N - 1 - y);
    if (rx >= radius || ry >= radius) return rx >= 0 && ry >= 0;
    const dx = radius - rx, dy = radius - ry;
    return dx * dx + dy * dy <= radius * radius;
  };

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (!insideRounded(x, y)) continue;
      const t = (x / N) * 0.45 + (y / N) * 0.55;
      const i = (y * N + x) * 4;
      px[i] = Math.round(lerp(c1[0], c2[0], t));
      px[i + 1] = Math.round(lerp(c1[1], c2[1], t));
      px[i + 2] = Math.round(lerp(c1[2], c2[2], t));
      px[i + 3] = 255;
    }
  }

  // power glyph: arc + vertical stem, white
  const cx = N / 2, cy = N * 0.54;
  const R = N * 0.25;
  const w = Math.max(N * 0.085, 1.6);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = x - cx, dy = y - cy;
      const dist = Math.hypot(dx, dy);
      const i = (y * N + x) * 4;
      // arc (open at top, ~300 degrees)
      const ang = Math.atan2(dy, dx) * 180 / Math.PI; // -180..180, -90 = up
      const openHalf = 32;
      const inGap = ang < -90 + openHalf && ang > -90 - openHalf;
      if (Math.abs(dist - R) < w / 2 && !inGap) blend(px, i, 255, 255, 255, 0.97);
      // stem
      if (Math.abs(dx) < w / 2 && y > cy - R * 1.62 && y < cy - R * 0.12) blend(px, i, 255, 255, 255, 0.97);
    }
  }

  // downsample S x S box filter
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const i = ((y * S + sy) * N + (x * S + sx)) * 4;
          const av = px[i + 3] / 255;
          r += px[i] * av; g += px[i + 1] * av; b += px[i + 2] * av; a += av;
        }
      }
      const o = (y * size + x) * 4;
      if (a > 0) { out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a); }
      out[o + 3] = Math.round((a / (S * S)) * 255);
    }
  }
  return encodePNG(size, out);
}

let count = 0;
for (const on of [true, false]) {
  for (const size of [16, 32, 48, 128]) {
    const file = `${OUT}/${on ? 'on' : 'off'}-${size}.png`;
    writeFileSync(file, drawIcon(size, on));
    count++;
  }
}
console.log(`Generated ${count} icons in ${OUT}`);
