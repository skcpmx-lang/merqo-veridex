#!/usr/bin/env node
/**
 * VERIDEX — application icon generator.
 *
 * Produces a multi-resolution `.ico` for Windows and a `.png` for the interface,
 * with no image dependencies: the icon is drawn as vector geometry on a small
 * raster grid and then encoded, so the build is reproducible on any machine and
 * there is no binary asset in the repository that nobody can regenerate.
 *
 * The mark is a hexagonal lens with a scanning line and a central aperture — the
 * "inspection" idea — in VERIDEX cyan on the deep navy brand background.
 *
 * Usage: node scripts/build-icon.mjs
 * Writes: build/icon.ico, build/icon.png, build/icon-256.png
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'build');

const BRAND = {
  navy: [10, 18, 32],
  navyEdge: [16, 28, 48],
  cyan: [34, 211, 238],
  cyanSoft: [125, 232, 245],
  white: [238, 250, 253]
};

/**
 * Draw the icon into an RGBA buffer.
 * @param {number} size
 * @returns {Buffer} RGBA, top row first.
 */
function drawIcon(size) {
  const buffer = Buffer.alloc(size * size * 4);
  const centre = (size - 1) / 2;
  const radius = size * 0.5;

  // Supersampling gives clean edges without a real rasteriser.
  const SS = 3;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          const colour = sample(px, py, centre, radius, size);
          r += colour[0] * colour[3];
          g += colour[1] * colour[3];
          b += colour[2] * colour[3];
          a += colour[3];
        }
      }

      const samples = SS * SS;
      const alpha = a / samples;
      const index = (y * size + x) * 4;
      if (alpha <= 0.001) {
        buffer[index] = 0;
        buffer[index + 1] = 0;
        buffer[index + 2] = 0;
        buffer[index + 3] = 0;
        continue;
      }
      buffer[index] = Math.round(r / a);
      buffer[index + 1] = Math.round(g / a);
      buffer[index + 2] = Math.round(b / a);
      buffer[index + 3] = Math.round(alpha * 255);
    }
  }

  return buffer;
}

/**
 * Colour of one sample point.
 * @returns {[number, number, number, number]} rgba, alpha 0..1
 */
function sample(px, py, centre, radius, size) {
  const dx = px - centre;
  const dy = py - centre;
  const distance = Math.hypot(dx, dy);

  // Rounded-square background, the Windows tile shape.
  const half = size * 0.5;
  const corner = size * 0.22;
  if (roundedSquareDistance(Math.abs(dx), Math.abs(dy), half - size * 0.02, corner) > 0) {
    return [0, 0, 0, 0];
  }

  // Vertical gradient on the background.
  const t = Math.min(1, Math.max(0, py / size));
  let colour = mix(BRAND.navy, BRAND.navyEdge, t);

  // Layers are composited in order, never short-circuited: an early return here
  // swallowed the aperture ring in the first draft of this icon.
  const hexRadius = size * 0.34;
  const hexDistance = hexagonDistance(dx, dy, hexRadius);
  const stroke = Math.max(1, size * 0.04);

  // Glass tint inside the lens housing.
  if (hexDistance < 0) colour = mix(colour, BRAND.cyan, 0.08);

  // Hexagon outline.
  if (Math.abs(hexDistance) < stroke) {
    const edge = 1 - Math.abs(hexDistance) / stroke;
    colour = mix(colour, BRAND.cyan, 0.5 + 0.5 * edge);
  }

  // Central aperture: ring plus a soft iris.
  const ringOuter = size * 0.165;
  const ringInner = size * 0.105;
  if (distance < ringOuter && distance > ringInner) {
    colour = [...BRAND.cyan];
  } else if (distance <= ringInner) {
    // Bright iris so the mark reads as a lens rather than a dark hole.
    const inner = 1 - distance / ringInner;
    colour = mix(mix(BRAND.cyan, BRAND.navy, 0.45), BRAND.cyanSoft, 0.35 + 0.6 * inner);
  }

  // Scanning line across the aperture, clipped to the lens interior.
  if (size >= 48) {
    const lineHalf = Math.max(0.5, size * 0.009);
    // Clipped to the lens interior: the scan line must not touch the housing.
    if (Math.abs(dy) < lineHalf && hexDistance < -stroke * 4 && Math.abs(dx) < hexRadius * 0.86) {
      colour = mix(colour, BRAND.white, 0.85);
    }
  }

  return [...colour, 1];
}

/** Signed distance to a rounded square; negative inside. */
function roundedSquareDistance(ax, ay, half, corner) {
  const qx = ax - (half - corner);
  const qy = ay - (half - corner);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - corner + half * 0.0;
}

/** Signed distance to a regular hexagon with a flat top; negative inside. */
function hexagonDistance(dx, dy, radius) {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  // Flat-top hexagon: width = 2r, height = sqrt(3) r.
  const limit = radius;
  // A regular flat-top hexagon has width 2r and height sqrt(3)r, so the vertical
  // half-extent is sqrt(3)/2 r. Using r/2 here produced a squashed, wide hexagon.
  const projected = ax * 0.8660254 + ay * 0.5;
  return Math.max(projected - limit, ay - limit * 0.8660254);
}

/** @param {number[]} a @param {number[]} b @param {number} t */
function mix(a, b, t) {
  const clamp = Math.min(1, Math.max(0, t));
  return [
    a[0] + (b[0] - a[0]) * clamp,
    a[1] + (b[1] - a[1]) * clamp,
    a[2] + (b[2] - a[2]) * clamp
  ];
}

// ── PNG encoding ─────────────────────────────────────────────────────────────

/** @param {Buffer} rgba @param {number} size */
function encodePng(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: none
    rgba.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** @param {string} type @param {Buffer} data */
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData) >>> 0, 0);
  return Buffer.concat([length, typeAndData, crc]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** @param {Buffer} buffer */
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

// ── ICO encoding ─────────────────────────────────────────────────────────────

/**
 * Build a multi-image .ico. Each entry embeds a PNG, which Windows supports from
 * Vista onwards for all sizes.
 * @param {Array<{size:number, png:Buffer}>} images
 */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;

  images.forEach((image, index) => {
    const entry = index * 16;
    // 256 is encoded as 0 in the directory.
    directory[entry] = image.size >= 256 ? 0 : image.size;
    directory[entry + 1] = image.size >= 256 ? 0 : image.size;
    directory[entry + 2] = 0; // palette
    directory[entry + 3] = 0;
    directory.writeUInt16LE(1, entry + 4); // colour planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32BE(0, entry + 8);
    directory.writeUInt32LE(image.png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.png.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.png)]);
}

// ── Main ─────────────────────────────────────────────────────────────────────

const SIZES = [16, 24, 32, 48, 64, 128, 256];

await mkdir(OUT_DIR, { recursive: true });

const images = SIZES.map((size) => {
  const rgba = drawIcon(size);
  return { size, rgba, png: encodePng(rgba, size) };
});

const ico = encodeIco(images);
await writeFile(path.join(OUT_DIR, 'icon.ico'), ico);

const large = images.find((image) => image.size === 256);
await writeFile(path.join(OUT_DIR, 'icon.png'), large.png);
await writeFile(path.join(OUT_DIR, 'icon-256.png'), large.png);

// Also a 512 px PNG for the interface and documentation.
const heroRgba = drawIcon(512);
await writeFile(path.join(OUT_DIR, 'icon-512.png'), encodePng(heroRgba, 512));

// electron-builder reads build/icon.ico by convention; the renderer and docs read
// assets/icons, so both locations are written from the same draw.
const ASSET_DIR = path.join(ROOT, 'assets/icons');
await mkdir(ASSET_DIR, { recursive: true });
await writeFile(path.join(ASSET_DIR, 'icon.ico'), ico);
await writeFile(path.join(ASSET_DIR, 'icon.png'), large.png);
await writeFile(path.join(ASSET_DIR, 'icon-256.png'), large.png);
await writeFile(path.join(ASSET_DIR, 'icon-512.png'), encodePng(heroRgba, 512));

console.log('VERIDEX icon generated');
console.log(`  build/icon.ico      ${ico.length} bytes, ${SIZES.length} sizes: ${SIZES.join(', ')}`);
console.log(`  build/icon.png      ${large.png.length} bytes, 256x256`);
console.log(`  build/icon-512.png  ${encodePng(heroRgba, 512).length} bytes, 512x512`);
