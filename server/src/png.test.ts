// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The PNG codec.
 *
 * Two things rest on this being right. The obvious one is that a masjid's app icon looks like
 * their logo. The less obvious one is a SECURITY property: CLAUDE.md §13 requires that nothing
 * is served back byte-for-byte from an upload, and the way that is true is that an upload is
 * decoded to pixels and a completely fresh file written from them. A decoder that quietly
 * passed unknown bytes through would break that guarantee without breaking any image.
 *
 * The fixtures are built here rather than checked in, so the tests describe the shapes they
 * cover instead of hiding them in binaries.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { type Image, cropSquare, decodePng, encodePng, looksLikePng, maskable, resize } from './png';

const px = (img: Image, x: number, y: number) => {
  const o = (y * img.width + x) * 4;
  return [img.rgba[o], img.rgba[o + 1], img.rgba[o + 2], img.rgba[o + 3]];
};

/** A solid image, for the cases where only the geometry is under test. */
function solid(w: number, h: number, [r, g, b, a]: number[]): Image {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = a;
  }
  return { width: w, height: h, rgba };
}

/** Build a PNG by hand at a given colour type / bit depth, so the decoder is tested against
 *  files it did not itself write. */
function makePng(opts: {
  width: number;
  height: number;
  depth: number;
  colorType: number;
  /** Raw, UNFILTERED scanline bytes (without the leading filter byte). */
  lines: number[][];
  palette?: number[];
  trns?: number[];
  filter?: number;
}): Buffer {
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i += 1) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(body), 0);
    return Buffer.concat([len, body, c]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(opts.width, 0);
  ihdr.writeUInt32BE(opts.height, 4);
  ihdr[8] = opts.depth;
  ihdr[9] = opts.colorType;

  // Apply the requested filter so the decoder's unfilter path is what is being tested.
  const ft = opts.filter ?? 0;
  const bpp = Math.max(1, Math.ceil((({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[opts.colorType] * opts.depth) / 8));
  const raw: Buffer[] = [];
  let prev: number[] | null = null;
  for (const line of opts.lines) {
    const enc = Buffer.alloc(line.length + 1);
    enc[0] = ft;
    for (let i = 0; i < line.length; i += 1) {
      const a = i >= bpp ? line[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      let pred = 0;
      if (ft === 1) pred = a;
      else if (ft === 2) pred = b;
      else if (ft === 3) pred = (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      enc[i + 1] = (line[i] - pred) & 0xff;
    }
    raw.push(enc);
    prev = line;
  }

  const parts = [
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(opts.palette ? [chunk('PLTE', Buffer.from(opts.palette))] : []),
    ...(opts.trns ? [chunk('tRNS', Buffer.from(opts.trns))] : []),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(raw))),
    chunk('IEND', Buffer.alloc(0)),
  ];
  return Buffer.concat(parts);
}

// ── Sniffing ─────────────────────────────────────────────────────────────────

test('a PNG is recognised from its magic bytes, not its name or its declared type', () => {
  // The whole point: an upload's filename and content-type are claims made by whoever sent it.
  assert.equal(looksLikePng(encodePng(solid(2, 2, [1, 2, 3, 255]))), true);
  assert.equal(looksLikePng(Buffer.from('<svg onload="alert(1)"/>')), false);
  assert.equal(looksLikePng(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0])), false, 'a JPEG');
  assert.equal(looksLikePng(Buffer.alloc(4)), false, 'too short');
});

test('a file that is not a PNG is refused rather than half-read', () => {
  assert.throws(() => decodePng(Buffer.from('<svg/>')), /not a PNG/);
  assert.throws(() => decodePng(Buffer.alloc(0)), /not a PNG/);
});

// ── Round trip ───────────────────────────────────────────────────────────────

test('pixels survive a decode/encode round trip exactly', () => {
  const src: Image = { width: 3, height: 2, rgba: new Uint8Array([
    255, 0, 0, 255,   0, 255, 0, 255,   0, 0, 255, 255,
    10, 20, 30, 128,  40, 50, 60, 0,    70, 80, 90, 255,
  ]) };
  const back = decodePng(encodePng(src));
  assert.equal(back.width, 3);
  assert.equal(back.height, 2);
  assert.deepEqual(Array.from(back.rgba), Array.from(src.rgba));
});

test('a re-encoded PNG keeps NOTHING from the original but its pixels', () => {
  // The security property. A source carrying an extra chunk — a comment, a colour profile, or
  // something a viewer might act on — must not reach our origin.
  const withJunk = Buffer.concat([
    makePng({ width: 1, height: 1, depth: 8, colorType: 2, lines: [[9, 9, 9]] }).subarray(0, -12),
    (() => {
      // A tEXt chunk carrying a payload, spliced in before IEND.
      const data = Buffer.from('Comment\0<script>alert(1)</script>', 'latin1');
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length, 0);
      const body = Buffer.concat([Buffer.from('tEXt'), data]);
      return Buffer.concat([len, body, Buffer.alloc(4)]);
    })(),
    makePng({ width: 1, height: 1, depth: 8, colorType: 2, lines: [[9, 9, 9]] }).subarray(-12),
  ]);

  const out = encodePng(decodePng(withJunk));
  assert.equal(out.includes(Buffer.from('script')), false, 'the payload must not survive');
  assert.equal(out.includes(Buffer.from('tEXt')), false, 'nor the chunk carrying it');
  assert.deepEqual(Array.from(decodePng(out).rgba), [9, 9, 9, 255], 'but the picture does');
});

// ── Colour types and bit depths ──────────────────────────────────────────────

test('truecolour with alpha (the common case)', () => {
  const png = makePng({ width: 2, height: 1, depth: 8, colorType: 6, lines: [[1, 2, 3, 255, 4, 5, 6, 128]] });
  const img = decodePng(png);
  assert.deepEqual(px(img, 0, 0), [1, 2, 3, 255]);
  assert.deepEqual(px(img, 1, 0), [4, 5, 6, 128]);
});

test('truecolour without alpha becomes fully opaque', () => {
  const img = decodePng(makePng({ width: 1, height: 1, depth: 8, colorType: 2, lines: [[10, 20, 30]] }));
  assert.deepEqual(px(img, 0, 0), [10, 20, 30, 255]);
});

test('a palette PNG resolves through PLTE, and tRNS gives it transparency', () => {
  const png = makePng({
    width: 2,
    height: 1,
    depth: 8,
    colorType: 3,
    palette: [255, 0, 0, 0, 255, 0],
    trns: [0, 255],
    lines: [[0, 1]],
  });
  const img = decodePng(png);
  assert.deepEqual(px(img, 0, 0), [255, 0, 0, 0], 'palette entry 0, fully transparent');
  assert.deepEqual(px(img, 1, 0), [0, 255, 0, 255]);
});

test('a 1-BIT image is scaled to full range, not left as 0 and 1', () => {
  // Get this wrong and a black-and-white logo decodes to two shades of black — an icon that
  // looks like a smudge, which is exactly the kind of thing that ships unnoticed.
  const img = decodePng(makePng({ width: 8, height: 1, depth: 1, colorType: 0, lines: [[0b10101010]] }));
  assert.deepEqual(px(img, 0, 0), [255, 255, 255, 255], 'a set bit is white');
  assert.deepEqual(px(img, 1, 0), [0, 0, 0, 255], 'a clear bit is black');
});

test('4-bit palette entries unpack two to a byte, high nibble first', () => {
  // 0x12 is two samples: index 1 then index 2. Reading them the other way round, or as one
  // byte, silently picks the wrong colours out of the palette rather than failing.
  const img = decodePng(
    makePng({ width: 2, height: 1, depth: 4, colorType: 3, palette: [1, 1, 1, 2, 2, 2, 3, 3, 3], lines: [[0x12]] }),
  );
  assert.deepEqual(px(img, 0, 0), [2, 2, 2, 255], 'palette entry 1');
  assert.deepEqual(px(img, 1, 0), [3, 3, 3, 255], 'palette entry 2');
});

test('greyscale with alpha keeps its alpha', () => {
  const img = decodePng(makePng({ width: 1, height: 1, depth: 8, colorType: 4, lines: [[200, 64]] }));
  assert.deepEqual(px(img, 0, 0), [200, 200, 200, 64]);
});

test('16-bit samples decode to their high byte rather than failing', () => {
  const img = decodePng(makePng({ width: 1, height: 1, depth: 16, colorType: 2, lines: [[0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc]] }));
  assert.deepEqual(px(img, 0, 0), [0x12, 0x56, 0x9a, 255]);
});

test('every scanline filter type is undone correctly', () => {
  // A real encoder picks a different filter per line; a decoder that only handled None would
  // work on its own output and fail on everyone else's.
  const lines = [
    [10, 20, 30, 255, 40, 50, 60, 255],
    [11, 21, 31, 255, 41, 51, 61, 255],
    [12, 22, 32, 255, 42, 52, 62, 255],
  ];
  for (const filter of [0, 1, 2, 3, 4]) {
    const img = decodePng(makePng({ width: 2, height: 3, depth: 8, colorType: 6, lines, filter }));
    assert.deepEqual(px(img, 0, 0), [10, 20, 30, 255], `filter ${filter}`);
    assert.deepEqual(px(img, 1, 2), [42, 52, 62, 255], `filter ${filter}`);
  }
});

// ── Refusals ─────────────────────────────────────────────────────────────────

test('an interlaced PNG is refused BY NAME, not half-decoded into noise', () => {
  const png = makePng({ width: 1, height: 1, depth: 8, colorType: 6, lines: [[1, 2, 3, 4]] });
  png[8 + 8 + 12] = 1; // IHDR interlace byte
  assert.throws(() => decodePng(png), /interlac/i);
});

test('an absurd declared size is refused before any buffer is allocated for it', () => {
  const png = makePng({ width: 1, height: 1, depth: 8, colorType: 6, lines: [[1, 2, 3, 4]] });
  png.writeUInt32BE(100000, 16); // IHDR width
  assert.throws(() => decodePng(png), /too large/);
});

test('truncated pixel data is refused rather than producing a half image', () => {
  const png = makePng({ width: 4, height: 4, depth: 8, colorType: 6, lines: Array.from({ length: 4 }, () => Array(16).fill(1)) });
  const broken = makePng({ width: 8, height: 8, depth: 8, colorType: 6, lines: Array.from({ length: 4 }, () => Array(32).fill(1)) });
  assert.ok(decodePng(png), 'the honest one is fine');
  assert.throws(() => decodePng(broken), /short/);
});

// ── Geometry ─────────────────────────────────────────────────────────────────

test('resizing averages the area rather than sampling one pixel', () => {
  // Sampling would pick one corner and return that colour; averaging returns the mean. This is
  // the difference between a legible 192px icon and a field of aliased dots.
  const src: Image = { width: 2, height: 2, rgba: new Uint8Array([
    0, 0, 0, 255,   255, 255, 255, 255,
    255, 255, 255, 255,  0, 0, 0, 255,
  ]) };
  const out = resize(src, 1, 1);
  assert.deepEqual(px(out, 0, 0), [128, 128, 128, 255], 'the mean of the four');
});

test('resizing preserves a solid colour exactly, up and down', () => {
  const src = solid(64, 64, [12, 34, 56, 255]);
  for (const size of [512, 192, 48]) {
    const out = resize(src, size, size);
    assert.equal(out.width, size);
    assert.deepEqual(px(out, size >> 1, size >> 1), [12, 34, 56, 255], `at ${size}`);
  }
});

test('transparent pixels do not bleed colour into the visible ones', () => {
  // A logo saved with white-but-transparent padding is extremely common. Averaging without
  // weighting by alpha drags that white into the edges and leaves a pale halo.
  const src: Image = { width: 2, height: 1, rgba: new Uint8Array([255, 255, 255, 0, 20, 40, 60, 255]) };
  const out = resize(src, 1, 1);
  assert.deepEqual(px(out, 0, 0).slice(0, 3), [20, 40, 60], 'only the opaque pixel contributes colour');
});

test('a wide logo is centre-cropped to a square, not squashed', () => {
  const src = solid(100, 40, [5, 5, 5, 255]);
  const out = cropSquare(src);
  assert.equal(out.width, 40);
  assert.equal(out.height, 40);
  assert.equal(cropSquare(solid(40, 40, [1, 1, 1, 255])).width, 40, 'an already-square image is untouched');
});

test('a maskable icon keeps the artwork inside the safe zone and fills the rest', () => {
  // Android crops a maskable icon to the launcher's shape and only guarantees the middle 80%.
  // Artwork drawn to the edge loses its edges — usually the masjid's name.
  const out = maskable(solid(64, 64, [200, 0, 0, 255]), 100, [10, 20, 30]);
  assert.equal(out.width, 100);
  assert.deepEqual(px(out, 1, 1), [10, 20, 30, 255], 'the corner is background');
  assert.deepEqual(px(out, 50, 50), [200, 0, 0, 255], 'the middle is the artwork');
  assert.equal(px(out, 50, 50)[3], 255, 'and it is fully opaque — a launcher must not see through it');
});

test('a maskable icon is opaque everywhere, whatever the source alpha', () => {
  const out = maskable(solid(32, 32, [255, 255, 255, 0]), 64, [1, 2, 3]);
  for (let i = 3; i < out.rgba.length; i += 4) {
    if (out.rgba[i] !== 255) {
      assert.fail('a transparent maskable icon is drawn on whatever the launcher likes, often black');
    }
  }
});

// ── The real thing ───────────────────────────────────────────────────────────

test('the bundled Companion mark decodes, and derives icons at every size we ship', () => {
  // The default when a masjid has no logo, and the fallback behind every other source. If this
  // one file cannot be read, every masjid without a logo gets no icon at all.
  const p = path.resolve(__dirname, '..', '..', 'web', 'public', 'mark-512.png');
  const img = decodePng(fs.readFileSync(p));
  assert.ok(img.width >= 512 && img.height >= 512, `the bundled mark is ${img.width}×${img.height}, expected at least 512`);
  assert.equal(img.width, img.height, 'and square');

  for (const size of [512, 192]) {
    const out = decodePng(encodePng(resize(cropSquare(img), size, size)));
    assert.equal(out.width, size);
    assert.equal(out.height, size);
  }
  const m = decodePng(encodePng(maskable(cropSquare(img), 512, [15, 32, 68])));
  assert.equal(m.width, 512);
});
