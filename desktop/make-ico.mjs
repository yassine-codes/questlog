#!/usr/bin/env node
// make-ico.mjs — pure-Node (zero npm dep) generator for questlog.ico
// ---------------------------------------------------------------------------
// Renders the dashboard favicon design into a multi-resolution .ico:
//   bg   rounded-rect  #3a3225  (rx 6 in a 32-unit box)
//   road quadratic stroke #dac89e width 4, round caps  (path M6 22 Q12 12 16 16 T26 12)
//   nodes circles r3.5  #6f9c58 @(7,22)  #cf9a30 @(16,16)  #4f88b0 @(25,12)
// The favicon SVG (index.html line 3) is the single source of truth for these
// numbers. The `T` smooth-quad reflects control (12,12) about (16,16) -> (20,20),
// so the road is two quadratic Beziers.
//
// Technique: render each size at 4x supersample, hard-threshold coverage per
// subpixel, box-downsample with premultiplied averaging for clean AA against the
// transparent corners, encode as PNG (node:zlib deflate + hand-rolled CRC32 /
// chunking), wrap PNGs in an ICO directory (PNG-in-ICO is valid for Vista+).
//
// Usage:  node make-ico.mjs [outPath]
//         default outPath = <this dir>/questlog.ico
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Geometry (32-unit design space) — mirrors index.html favicon exactly.
// ---------------------------------------------------------------------------
const BOX = 32;
const RRECT_R = 6;
const ROAD_HALF = 2;        // stroke-width 4 -> half 2
const NODE_R = 3.5;
const COL = {
  bg:   [0x3a, 0x32, 0x25],
  road: [0xda, 0xc8, 0x9e],
  n1:   [0x6f, 0x9c, 0x58],
  n2:   [0xcf, 0x9a, 0x30],
  n3:   [0x4f, 0x88, 0xb0],
};
const NODES = [
  { x: 7,  y: 22, c: COL.n1 },
  { x: 16, y: 16, c: COL.n2 },
  { x: 25, y: 12, c: COL.n3 },
];

// Two quadratic Bezier segments describing the road centreline.
const QUADS = [
  { p0: [6, 22],  p1: [12, 12], p2: [16, 16] },
  { p0: [16, 16], p1: [20, 20], p2: [26, 12] },
];

function quadPoint(q, t) {
  const u = 1 - t;
  const a = u * u, b = 2 * u * t, c = t * t;
  return [
    a * q.p0[0] + b * q.p1[0] + c * q.p2[0],
    a * q.p0[1] + b * q.p1[1] + c * q.p2[1],
  ];
}

// Flatten the two quads into a single polyline (unit space).
const ROAD_PTS = (() => {
  const pts = [];
  const N = 48;
  for (const q of QUADS) {
    for (let i = 0; i <= N; i++) {
      if (i === 0 && pts.length) continue; // avoid duplicate join vertex
      pts.push(quadPoint(q, i / N));
    }
  }
  return pts;
})();

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const cx = ax + t * dx, cy = ay + t * dy;
  const ex = px - cx, ey = py - cy;
  return Math.sqrt(ex * ex + ey * ey);
}

function distToRoad(px, py) {
  let min = Infinity;
  for (let i = 0; i + 1 < ROAD_PTS.length; i++) {
    const d = distToSeg(px, py, ROAD_PTS[i][0], ROAD_PTS[i][1], ROAD_PTS[i + 1][0], ROAD_PTS[i + 1][1]);
    if (d < min) min = d;
  }
  return min;
}

// Signed-distance rounded box: inside when <= 0.
function roundedRectInside(x, y) {
  const half = BOX / 2 - RRECT_R;  // 10
  const qx = Math.abs(x - BOX / 2) - half;
  const qy = Math.abs(y - BOX / 2) - half;
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.sqrt(ox * ox + oy * oy) - RRECT_R <= 0;
}

// Topmost opaque colour at a unit-space sample, or null if transparent.
function sampleColor(ux, uy) {
  if (!roundedRectInside(ux, uy)) return null;
  let col = COL.bg;
  if (distToRoad(ux, uy) <= ROAD_HALF) col = COL.road;
  for (const n of NODES) {
    const dx = ux - n.x, dy = uy - n.y;
    if (dx * dx + dy * dy <= NODE_R * NODE_R) col = n.c;
  }
  return col;
}

// ---------------------------------------------------------------------------
// Rasterise one size to straight-alpha RGBA (size*size*4), 4x supersampled.
// ---------------------------------------------------------------------------
function rasterize(size) {
  const SS = 4;
  const k = (size * SS) / BOX; // device(px)-per-unit at supersample
  const out = Buffer.alloc(size * size * 4);
  const subN = SS * SS;
  for (let oy = 0; oy < size; oy++) {
    for (let ox = 0; ox < size; ox++) {
      let aAcc = 0, rAcc = 0, gAcc = 0, bAcc = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const dx = ox * SS + sx + 0.5;
          const dy = oy * SS + sy + 0.5;
          const c = sampleColor(dx / k, dy / k);
          if (c) { aAcc += 255; rAcc += c[0] * 255; gAcc += c[1] * 255; bAcc += c[2] * 255; }
        }
      }
      const idx = (oy * size + ox) * 4;
      const a = Math.round(aAcc / subN);
      if (aAcc > 0) {
        out[idx]     = Math.round(rAcc / aAcc);
        out[idx + 1] = Math.round(gAcc / aAcc);
        out[idx + 2] = Math.round(bAcc / aAcc);
      }
      out[idx + 3] = a;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// PNG encoding (RGBA, 8-bit, no interlace).
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function encodePng(rgba, size) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  // raw scanlines, each prefixed with filter byte 0
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------
// ICO container (PNG-in-ICO).
// ---------------------------------------------------------------------------
function buildIco(entries) {
  // entries: [{ size, png }]
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(count, 4);
  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  const images = [];
  entries.forEach((e, i) => {
    const b = i * 16;
    dir[b] = e.size >= 256 ? 0 : e.size;      // 0 means 256
    dir[b + 1] = e.size >= 256 ? 0 : e.size;
    dir[b + 2] = 0;   // palette
    dir[b + 3] = 0;   // reserved
    dir.writeUInt16LE(1, b + 4);   // colour planes
    dir.writeUInt16LE(32, b + 6);  // bits per pixel
    dir.writeUInt32LE(e.png.length, b + 8);
    dir.writeUInt32LE(offset, b + 12);
    offset += e.png.length;
    images.push(e.png);
  });
  return Buffer.concat([header, dir, ...images]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const outPath = process.argv[2] || path.join(__dirname, "questlog.ico");
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const entries = sizes.map((size) => ({ size, png: encodePng(rasterize(size), size) }));
  const ico = buildIco(entries);
  fs.writeFileSync(outPath, ico);
  process.stdout.write(`wrote ${outPath} (${ico.length} bytes, sizes ${sizes.join("/")})\n`);
}

main();
