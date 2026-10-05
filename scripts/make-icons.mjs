/**
 * Generates the PWA icons.
 *
 * Written with a tiny hand-rolled PNG encoder rather than a dependency: the icons are
 * flat colour with simple shapes, so there is no reason to pull in a raster library for
 * a one-off build step.
 */
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';

const PUBLIC_DIR = join(import.meta.dirname, '..', 'public');

const BG = [11, 17, 25];
const RING = [56, 189, 248];
const INNER = [248, 113, 113];
const CENTER = [238, 244, 251];

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Encodes RGBA pixel rows as a PNG. */
function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.subarray(y * size * 4, (y + 1) * size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A dartboard-like mark: outer ring, inner ring, bullseye. */
function drawIcon(size, { maskable = false } = {}) {
  const pixels = Buffer.alloc(size * size * 4);
  const center = (size - 1) / 2;
  // A maskable icon must keep its content inside the safe zone (80% of the canvas).
  const scale = maskable ? 0.4 : 0.48;
  const outer = size * scale;
  const ringWidth = outer * 0.26;
  const innerRadius = outer * 0.46;
  const bull = outer * 0.17;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = Math.hypot(x - center, y - center);
      let colour = BG;
      if (distance <= bull) colour = CENTER;
      else if (distance <= innerRadius) colour = INNER;
      else if (distance <= outer && distance >= outer - ringWidth) colour = RING;
      const offset = (y * size + x) * 4;
      pixels[offset] = colour[0];
      pixels[offset + 1] = colour[1];
      pixels[offset + 2] = colour[2];
      pixels[offset + 3] = 255;
    }
  }
  return encodePng(size, pixels);
}

writeFileSync(join(PUBLIC_DIR, 'icon-192.png'), drawIcon(192));
writeFileSync(join(PUBLIC_DIR, 'icon-512.png'), drawIcon(512));
writeFileSync(join(PUBLIC_DIR, 'icon-maskable-512.png'), drawIcon(512, { maskable: true }));

writeFileSync(
  join(PUBLIC_DIR, 'icon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Darts Order">
  <rect width="64" height="64" rx="12" fill="#0b1119"/>
  <circle cx="32" cy="32" r="22" fill="none" stroke="#38bdf8" stroke-width="6"/>
  <circle cx="32" cy="32" r="10" fill="#f87171"/>
  <circle cx="32" cy="32" r="3.8" fill="#eef4fb"/>
</svg>
`,
);

console.log('icons written to public/');
