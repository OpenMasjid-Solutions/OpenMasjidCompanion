// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * png.ts — decode, resize and re-encode PNG images, with no dependencies at all.
 *
 * WHY THIS EXISTS RATHER THAN A LIBRARY. Deriving a masjid's app icon needs exactly three
 * things: read a PNG, scale it, write a PNG. `sharp` is a native module and a genuine problem
 * on the arm64 Raspberry Pi this family targets; the pure-JS alternatives are large. Node
 * already ships zlib, which is the only hard part of PNG — the rest is chunk framing and
 * unfiltering scanlines. CLAUDE.md §10 explicitly allows a plain resizer here because this runs
 * ONCE when an admin uploads a logo, not on any request path.
 *
 * SECURITY. This is also what makes CLAUDE.md §13's "nothing is served back byte-for-byte from
 * an upload" true. An uploaded file is decoded to raw pixels and a completely fresh PNG is
 * written from them: no chunk, no comment, no colour profile and no trailing data from the
 * original survives. A file that is not really a PNG fails to decode and is refused.
 *
 * SCOPE, deliberately narrow. Non-interlaced PNGs, which is every PNG a masjid will ever upload
 * — Adam7 interlacing is refused by name rather than half-supported. Bit depths 1/2/4/8 for
 * palette and greyscale, 8/16 for truecolour. Everything decodes to straight RGBA8.
 */
import zlib from 'node:zlib';

export interface Image {
  width: number;
  height: number;
  /** Straight (non-premultiplied) RGBA, 4 bytes per pixel, row-major. */
  rgba: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Is this plausibly a PNG at all? Checked from the MAGIC BYTES, never a filename or a
 *  client-supplied content type — both of which are claims, not facts. */
export function looksLikePng(buf: Buffer): boolean {
  return buf.length > 8 && buf.subarray(0, 8).equals(SIGNATURE);
}

// ── CRC32, for writing chunks ────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── Decode ───────────────────────────────────────────────────────────────────

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Reverse one scanline's filter, in place. The five filter types are the whole of PNG's
 *  compression pre-pass; `bpp` is the byte distance to the pixel on the left. */
function unfilter(type: number, line: Buffer, prev: Buffer | null, bpp: number): void {
  const n = line.length;
  switch (type) {
    case 0:
      return; // None
    case 1: // Sub
      for (let i = bpp; i < n; i += 1) line[i] = (line[i] + line[i - bpp]) & 0xff;
      return;
    case 2: // Up
      if (prev) for (let i = 0; i < n; i += 1) line[i] = (line[i] + prev[i]) & 0xff;
      return;
    case 3: // Average
      for (let i = 0; i < n; i += 1) {
        const left = i >= bpp ? line[i - bpp] : 0;
        const up = prev ? prev[i] : 0;
        line[i] = (line[i] + ((left + up) >> 1)) & 0xff;
      }
      return;
    case 4: // Paeth
      for (let i = 0; i < n; i += 1) {
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = prev ? prev[i] : 0;
        const c = prev && i >= bpp ? prev[i - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        line[i] = (line[i] + pred) & 0xff;
      }
      return;
    default:
      throw new Error(`unknown PNG filter type ${type}`);
  }
}

/** Pull `count` samples of `depth` bits out of a packed scanline. */
function unpackBits(line: Buffer, depth: number, count: number): number[] {
  if (depth === 8) return Array.from(line.subarray(0, count));
  const out: number[] = [];
  const perByte = 8 / depth;
  const mask = (1 << depth) - 1;
  for (let i = 0; i < count; i += 1) {
    const byte = line[Math.floor(i / perByte)];
    const shift = 8 - depth * ((i % perByte) + 1);
    out.push((byte >> shift) & mask);
  }
  return out;
}

/**
 * Decode a PNG to RGBA8. Throws on anything malformed or out of scope — the caller turns that
 * into "we could not read that image", which is a normal answer for an upload.
 */
export function decodePng(buf: Buffer): Image {
  if (!looksLikePng(buf)) throw new Error('not a PNG');

  let width = 0;
  let height = 0;
  let depth = 8;
  let colorType = 6;
  let palette: Buffer | null = null;
  let transparency: Buffer | null = null;
  const idat: Buffer[] = [];

  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (off + 12 + len > buf.length) throw new Error('truncated PNG');

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNGs are not supported — re-save without interlacing');
      if (!(colorType in CHANNELS)) throw new Error(`unsupported PNG colour type ${colorType}`);
    } else if (type === 'PLTE') palette = Buffer.from(data);
    else if (type === 'tRNS') transparency = Buffer.from(data);
    else if (type === 'IDAT') idat.push(Buffer.from(data));
    else if (type === 'IEND') break;

    off += 12 + len; // length + type + data + CRC
  }

  if (!width || !height) throw new Error('PNG has no image header');
  // A hostile or corrupt IHDR could claim enormous dimensions; the raw buffer would be
  // width*height*4 bytes before anything else got a say.
  if (width > 8192 || height > 8192) throw new Error('image is too large');

  const channels = CHANNELS[colorType];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bitsPerPixel = channels * depth;
  const bytesPerLine = Math.ceil((bitsPerPixel * width) / 8);
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  if (raw.length < (bytesPerLine + 1) * height) throw new Error('PNG pixel data is short');

  const rgba = new Uint8Array(width * height * 4);
  let prev: Buffer | null = null;
  let p = 0;

  for (let y = 0; y < height; y += 1) {
    const filterType = raw[p];
    const line = Buffer.from(raw.subarray(p + 1, p + 1 + bytesPerLine));
    p += 1 + bytesPerLine;
    unfilter(filterType, line, prev, bpp);
    prev = line;

    // 16-bit samples are read as their high byte: this produces an app icon, and the low byte
    // would be thrown away by the resize regardless.
    const step = depth === 16 ? 2 : 1;
    const samples = depth < 8 ? unpackBits(line, depth, width * channels) : null;
    const sampleAt = (i: number) => (samples ? samples[i] : line[i * step]);

    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      const s = x * channels;
      if (colorType === 3) {
        const idx = sampleAt(s);
        const pi = idx * 3;
        rgba[o] = palette?.[pi] ?? 0;
        rgba[o + 1] = palette?.[pi + 1] ?? 0;
        rgba[o + 2] = palette?.[pi + 2] ?? 0;
        rgba[o + 3] = transparency && idx < transparency.length ? transparency[idx] : 255;
      } else if (colorType === 0 || colorType === 4) {
        // Greyscale is scaled up from its bit depth so 1-bit black/white becomes 0/255 rather
        // than 0/1, which would otherwise render as an all-black icon.
        const max = (1 << Math.min(depth, 8)) - 1;
        const g = Math.round((sampleAt(s) / max) * 255);
        rgba[o] = g;
        rgba[o + 1] = g;
        rgba[o + 2] = g;
        rgba[o + 3] = colorType === 4 ? sampleAt(s + 1) : 255;
      } else {
        rgba[o] = sampleAt(s);
        rgba[o + 1] = sampleAt(s + 1);
        rgba[o + 2] = sampleAt(s + 2);
        rgba[o + 3] = colorType === 6 ? sampleAt(s + 3) : 255;
      }
    }
  }

  return { width, height, rgba };
}

// ── Encode ───────────────────────────────────────────────────────────────────

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Pick the filter that makes a scanline cheapest to compress, by the standard
 *  minimum-sum-of-absolute-differences heuristic. Costs a little CPU once, and saves a lot on a
 *  photographic logo — an unfiltered 512×512 RGBA is a megabyte before deflate sees it. */
function filterLine(line: Buffer, prev: Buffer | null, bpp: number): Buffer {
  const n = line.length;
  const best = { score: Infinity, type: 0, out: Buffer.alloc(0) };

  for (let type = 0; type <= 4; type += 1) {
    const out = Buffer.alloc(n);
    for (let i = 0; i < n; i += 1) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      let pred = 0;
      if (type === 1) pred = a;
      else if (type === 2) pred = b;
      else if (type === 3) pred = (a + b) >> 1;
      else if (type === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[i] = (line[i] - pred) & 0xff;
    }
    let score = 0;
    for (let i = 0; i < n; i += 1) score += out[i] < 128 ? out[i] : 256 - out[i];
    if (score < best.score) {
      best.score = score;
      best.type = type;
      best.out = out;
    }
  }
  return Buffer.concat([Buffer.from([best.type]), best.out]);
}

/** Write a fresh RGBA8 PNG. Nothing from any source file survives this except pixel values. */
export function encodePng(img: Image): Buffer {
  const { width, height, rgba } = img;
  const bytesPerLine = width * 4;
  const lines: Buffer[] = [];
  let prev: Buffer | null = null;

  for (let y = 0; y < height; y += 1) {
    const line = Buffer.from(rgba.subarray(y * bytesPerLine, (y + 1) * bytesPerLine));
    lines.push(filterLine(line, prev, 4));
    prev = line;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(lines), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Geometry ─────────────────────────────────────────────────────────────────

/**
 * Area-average resize.
 *
 * Averaging over the whole source rectangle rather than sampling one pixel is what stops a
 * 1024px logo with fine lettering turning into a mess of aliased dots at 192px — which is the
 * size this icon is most often seen at, on a home screen.
 *
 * Alpha-weighted, so transparent edges do not drag colour into the visible pixels.
 */
export function resize(img: Image, width: number, height: number): Image {
  const out = new Uint8Array(width * height * 4);
  const sx = img.width / width;
  const sy = img.height / height;

  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.ceil((y + 1) * sy));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.ceil((x + 1) * sx));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = y0; yy < Math.min(y1, img.height); yy += 1) {
        for (let xx = x0; xx < Math.min(x1, img.width); xx += 1) {
          const o = (yy * img.width + xx) * 4;
          const alpha = img.rgba[o + 3];
          r += img.rgba[o] * alpha;
          g += img.rgba[o + 1] * alpha;
          b += img.rgba[o + 2] * alpha;
          a += alpha;
          n += 1;
        }
      }
      const o = (y * width + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round(a / Math.max(1, n));
      }
    }
  }
  return { width, height, rgba: out };
}

/** Centre-crop to a square, so a wide banner logo becomes an icon instead of being squashed. */
export function cropSquare(img: Image): Image {
  const side = Math.min(img.width, img.height);
  if (side === img.width && side === img.height) return img;
  const ox = Math.floor((img.width - side) / 2);
  const oy = Math.floor((img.height - side) / 2);
  const out = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y += 1) {
    const from = ((y + oy) * img.width + ox) * 4;
    out.set(img.rgba.subarray(from, from + side * 4), y * side * 4);
  }
  return { width: side, height: side, rgba: out };
}

/**
 * A maskable icon: the artwork shrunk into the middle of a filled square.
 *
 * Android crops a maskable icon to whatever shape the launcher uses — circle, squircle, teardrop
 * — and only the middle 80% is guaranteed to survive. An icon handed over without this padding
 * gets its edges sliced off, which for a masjid's logo usually means its name. The background is
 * filled because a transparent maskable icon is rendered on whatever the launcher likes,
 * frequently black.
 */
export function maskable(img: Image, size: number, background: [number, number, number]): Image {
  const inner = Math.round(size * 0.8);
  const scaled = resize(img, inner, inner);
  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    out[i * 4] = background[0];
    out[i * 4 + 1] = background[1];
    out[i * 4 + 2] = background[2];
    out[i * 4 + 3] = 255;
  }
  const off = Math.floor((size - inner) / 2);
  for (let y = 0; y < inner; y += 1) {
    for (let x = 0; x < inner; x += 1) {
      const s = (y * inner + x) * 4;
      const d = ((y + off) * size + (x + off)) * 4;
      const a = scaled.rgba[s + 3] / 255;
      // Composite over the background rather than replacing it, so a logo with soft or
      // anti-aliased edges does not get a hard halo.
      out[d] = Math.round(scaled.rgba[s] * a + background[0] * (1 - a));
      out[d + 1] = Math.round(scaled.rgba[s + 1] * a + background[1] * (1 - a));
      out[d + 2] = Math.round(scaled.rgba[s + 2] * a + background[2] * (1 - a));
      out[d + 3] = 255;
    }
  }
  return { width: size, height: size, rgba: out };
}
