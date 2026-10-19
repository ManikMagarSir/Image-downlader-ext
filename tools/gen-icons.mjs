// Dev-time generator for extension icons (no runtime dependency).
// Usage: node tools/gen-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
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
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

// Antialiased coverage of a pixel-center vs a circle outline / segment.
function inRing(x, y, cx, cy, r, w) {
  return Math.abs(Math.hypot(x - cx, y - cy) - r) <= w / 2;
}

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const bg = [0x1b, 0x1f, 0x2a];
  const fg = [0x4c, 0xc2, 0xff];
  const R = size * 0.24, cx = size * 0.42, cy = size * 0.42, W = size * 0.085;
  const hx = size * 0.595, hy = size * 0.595, ex = size * 0.82, ey = size * 0.82;
  const corner = size * 0.18;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      // rounded-square background
      const qx = Math.abs(px - size / 2) - (size / 2 - corner);
      const qy = Math.abs(py - size / 2) - (size / 2 - corner);
      const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - corner;
      let r = bg[0], g = bg[1], b = bg[2], a = d <= 0.5 ? 255 : 0;
      const ring = inRing(px, py, cx, cy, R, W) || (px > hx - 1 && segDist(px, py, hx, hy, ex, ey) <= W / 2);
      if (ring) { r = fg[0]; g = fg[1]; b = fg[2]; a = 255; }
      const i = (y * size + x) * 4;
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
    }
  }
  return buf;
}

mkdirSync(OUT, { recursive: true });
for (const s of [16, 32, 48, 128]) {
  writeFileSync(join(OUT, `icon${s}.png`), encodePNG(s, render(s)));
  console.log(`icons/icon${s}.png`);
}
