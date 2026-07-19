// Generates src/icons/icon-{48,96}.png from code.
//
// Committing generated binaries is normally a smell, but an extension needs real
// PNGs and a 40-line generator is far easier to audit than two opaque blobs.
// Re-run with `node tools/make-icons.mjs` after changing the design.

import { deflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'icons');

const BG = [21, 32, 43, 255]; // X dark blue-grey
const FG = [231, 233, 234, 255]; // near-white

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * The mark: a rounded square, a downward arrow (export), and a baseline bar.
 * Coordinates are in a 0..1 space so both sizes come out identical.
 */
function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const put = (x, y, colour) => {
    const i = (y * size + x) * 4;
    px[i] = colour[0];
    px[i + 1] = colour[1];
    px[i + 2] = colour[2];
    px[i + 3] = colour[3];
  };

  const radius = size * 0.22;
  const inside = (x, y) => {
    // rounded-rect membership test
    const cx = Math.min(Math.max(x, radius), size - radius);
    const cy = Math.min(Math.max(y, radius), size - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  };

  const shaftHalf = size * 0.055;
  const shaftTop = size * 0.24;
  const shaftBottom = size * 0.56;
  const headTop = shaftBottom;
  const headBottom = size * 0.72;
  const headHalf = size * 0.17;
  const barTop = size * 0.78;
  const barBottom = size * 0.845;
  const barHalf = size * 0.22;
  const mid = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = x + 0.5;
      const fy = y + 0.5;
      if (!inside(fx, fy)) continue;

      let colour = BG;
      const dx = Math.abs(fx - mid);

      if (fy >= shaftTop && fy < shaftBottom && dx <= shaftHalf) colour = FG;
      else if (fy >= headTop && fy <= headBottom) {
        // triangle narrowing to a point at headBottom
        const t = (fy - headTop) / (headBottom - headTop);
        if (dx <= headHalf * (1 - t)) colour = FG;
      } else if (fy >= barTop && fy <= barBottom && dx <= barHalf) colour = FG;

      put(x, y, colour);
    }
  }
  return px;
}

await mkdir(outDir, { recursive: true });
for (const size of [48, 96]) {
  await writeFile(resolve(outDir, `icon-${size}.png`), encodePng(size, size, draw(size)));
  console.log(`wrote icon-${size}.png`);
}
