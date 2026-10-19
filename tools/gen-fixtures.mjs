// Dev-time generator for test fixture images (solid-color PNGs/GIF-less).
// Usage: node tools/gen-fixtures.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'img');
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(b) { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(body)); return Buffer.concat([l, body, c]); }
function png(w, h, rgb) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const i = y * (w * 3 + 1) + 1 + x * 3; raw[i] = rgb[0]; raw[i + 1] = rgb[1]; raw[i + 2] = rgb[2]; } }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
mkdirSync(OUT, { recursive: true });
const specs = [
  ['small-red.png', 100, 60, [200, 40, 40]],
  ['same-name.png', 640, 480, [40, 90, 200]],      // served under two paths
  ['thumb-same-name.png', 80, 60, [40, 90, 200]],
  ['large-blue.png', 800, 600, [30, 120, 220]],
  ['xlarge-blue.png', 1600, 1200, [30, 120, 220]], // srcset big variant
  ['green.png', 300, 300, [40, 180, 90]],
  ['pixel.png', 1, 1, [0, 0, 0]],                  // tracking-pixel style
  ['bg-tile.png', 64, 64, [120, 80, 200]],
  ['param.png', 400, 250, [220, 160, 40]]
];
for (const [name, w, h, rgb] of specs) {
  writeFileSync(join(OUT, name), png(w, h, rgb));
  console.log(`tests/fixtures/img/${name} ${w}x${h}`);
}
