// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * icons.ts — the icon that ends up on a musalli's home screen.
 *
 * **It is the MASJID's, not ours.** Someone who adds this to their phone should see their own
 * masjid on the screen, next to their bank and their messages — not a logo belonging to the
 * software. Ours is only the fallback for a masjid that has not set one anywhere.
 *
 * Four sources, in order, each falling through to the next on any failure:
 *
 *   1. **An upload in this app's settings.** An explicit choice by the admin, so it wins and is
 *      never overridden by anything below.
 *   2. **The logo on the chosen timetable in OpenMasjid Display**, over the broker (work order
 *      #2). The most specific answer: a masjid that put their logo on their prayer screens
 *      should not have to upload it again here.
 *   3. **The platform's logo**, from OpenMasjidOS → Settings → Customize.
 *   4. **Companion's own mark**, bundled in the image so this always resolves to something.
 *
 * Derived ONCE per source change, not per request. `ensureIcons` re-checks the upstream on a
 * slow cadence and re-derives only when the bytes actually differ — a masjid that changes their
 * logo in OpenMasjidOS sees it here within the hour without anything being regenerated in
 * between.
 *
 * Only PNG sources can be derived from. That is not a shortcut: CLAUDE.md §10 specifies a PNG
 * upload, Display's own uploader re-encodes to PNG, and decoding JPEG would mean a dependency
 * this app does not otherwise need. A source we cannot decode falls through to the next one
 * rather than producing a broken icon.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { config } from './config';
import { fetchLogo } from './fabric';
import { makeLog } from './logger';
import { type Image, cropSquare, decodePng, encodePng, looksLikePng, maskable, resize } from './png';
import type { Store } from './store';
import { getTimetableLogo } from './timetable';

const log = makeLog('icons');

export type IconSource = 'upload' | 'display' | 'platform' | 'bundled';
export type IconKind = 'icon-512' | 'icon-192' | 'maskable-512';

const KINDS: Record<IconKind, { size: number; maskable: boolean }> = {
  'icon-512': { size: 512, maskable: false },
  'icon-192': { size: 192, maskable: false },
  'maskable-512': { size: 512, maskable: true },
};

/** The ground a maskable icon is composited onto, and the manifest's background. Matches the
 *  musalli page's night sky so the splash screen and the page are the same app. */
export const THEME_RGB: [number, number, number] = [0x0f, 0x20, 0x44];
export const THEME_HEX = '#0F2044';

const KEY_META = 'icons.meta';
const KEY_UPLOAD = 'icons.upload'; // the admin's own file, base64, so it survives a re-derive

/** How often the upstream sources are re-checked. A logo changes about once in the life of an
 *  install, so this is about eventual correctness, not freshness. */
const RECHECK_MS = 60 * 60_000;

interface IconMeta {
  source: IconSource;
  /** sha256 of the SOURCE bytes. Re-derivation is keyed off this, so an upstream that keeps
   *  serving the same logo costs one hash and nothing else. */
  fingerprint: string;
  at: number;
  checkedAt: number;
}

/** Where the bundled mark lives, in both layouts this app runs in. */
function bundledMarkPath(): string | null {
  for (const p of [
    path.join(config.publicDir, 'mark-512.png'),
    path.resolve(__dirname, '..', '..', 'web', 'public', 'mark-512.png'),
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export class Icons {
  private readonly dir: string;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly store: Store,
    private readonly timetableId: () => string,
  ) {
    this.dir = path.join(config.dataDir, 'icons');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private file(kind: IconKind): string {
    return path.join(this.dir, `${kind}.png`);
  }

  private meta(): IconMeta | null {
    return this.store.getJson<IconMeta | null>(KEY_META, null);
  }

  /** What the admin panel shows: where the current icon came from, and when. */
  status(): { source: IconSource; at: number; hasUpload: boolean } {
    const m = this.meta();
    return { source: m?.source ?? 'bundled', at: m?.at ?? 0, hasUpload: !!this.store.get(KEY_UPLOAD) };
  }

  /** The bytes for one variant, deriving them first if we have none. Never throws: an icon is
   *  not worth failing a request over, and the manifest can point at one that 404s far more
   *  gracefully than the whole page can fail. */
  async read(kind: IconKind): Promise<Buffer | null> {
    await this.ensure();
    try {
      return fs.readFileSync(this.file(kind));
    } catch {
      return null;
    }
  }

  /**
   * Derive the icon set if it is missing or the source has changed.
   *
   * Deduped: the manifest and three icon routes are all fetched together when a phone installs
   * the app, and each of them calls this.
   */
  async ensure(force = false): Promise<void> {
    if (!this.inflight) {
      this.inflight = this.run(force).finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async run(force: boolean): Promise<void> {
    const meta = this.meta();
    const have = Object.keys(KINDS).every((k) => fs.existsSync(this.file(k as IconKind)));
    const due = force || !meta || !have || Date.now() - meta.checkedAt >= RECHECK_MS;
    if (!due) return;

    const found = await this.resolveSource();
    if (!found) {
      log.warn('no icon source could be read at all — not even the bundled mark');
      return;
    }

    const fingerprint = createHash('sha256').update(found.png).digest('hex');
    if (meta && have && meta.fingerprint === fingerprint && meta.source === found.source) {
      // Same bytes as last time: nothing to redo, but record that we looked.
      this.store.setJson(KEY_META, { ...meta, checkedAt: Date.now() });
      return;
    }

    try {
      this.derive(found.png);
    } catch (err) {
      log.warn(`could not derive icons from the ${found.source} logo: ${err instanceof Error ? err.message : String(err)}`);
      // A source that decodes badly must not leave the app with no icon at all. Fall back to
      // the bundled mark, unless that is what just failed.
      if (found.source === 'bundled') return;
      const mark = bundledMarkPath();
      if (!mark) return;
      try {
        this.derive(fs.readFileSync(mark));
        this.store.setJson(KEY_META, { source: 'bundled', fingerprint: 'fallback', at: Date.now(), checkedAt: Date.now() });
      } catch {
        /* nothing more to try */
      }
      return;
    }

    this.store.setJson(KEY_META, { source: found.source, fingerprint, at: Date.now(), checkedAt: Date.now() });
    log.info(`app icon derived from the ${found.source} logo`);
  }

  /** Walk the chain until something yields PNG bytes. */
  private async resolveSource(): Promise<{ source: IconSource; png: Buffer } | null> {
    const uploaded = this.store.get(KEY_UPLOAD);
    if (uploaded) {
      const buf = Buffer.from(uploaded, 'base64');
      if (looksLikePng(buf)) return { source: 'upload', png: buf };
    }

    const id = this.timetableId();
    if (id) {
      const res = await getTimetableLogo(id);
      if (res.ok && res.data) {
        const buf = Buffer.from(res.data.data, 'base64');
        if (looksLikePng(buf)) return { source: 'display', png: buf };
        log.debug(`Display's timetable logo is ${res.data.mime}, which cannot be decoded here — trying the platform`);
      }
    }

    const platform = await fetchLogo();
    if (platform !== 'none' && platform !== 'unavailable' && looksLikePng(platform.body)) {
      return { source: 'platform', png: platform.body };
    }

    const mark = bundledMarkPath();
    if (mark) {
      try {
        return { source: 'bundled', png: fs.readFileSync(mark) };
      } catch {
        /* fall through */
      }
    }
    return null;
  }

  /** Decode once, write every variant. Throws if the source is not a decodable PNG. */
  private derive(png: Buffer): void {
    const square = cropSquare(decodePng(png));
    for (const [kind, spec] of Object.entries(KINDS) as [IconKind, (typeof KINDS)[IconKind]][]) {
      const img: Image = spec.maskable ? maskable(square, spec.size, THEME_RGB) : resize(square, spec.size, spec.size);
      // Written to a temporary name and renamed, so a phone fetching an icon mid-derive gets
      // either the old file or the new one, never half of one.
      const tmp = `${this.file(kind)}.tmp`;
      fs.writeFileSync(tmp, encodePng(img));
      fs.renameSync(tmp, this.file(kind));
    }
  }

  /**
   * The admin's own icon.
   *
   * Validated from the MAGIC BYTES and re-encoded, never stored or served as uploaded — see
   * png.ts. Returns a plain sentence on refusal, because this is a screen a volunteer is
   * standing at.
   */
  async setUpload(buf: Buffer): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!looksLikePng(buf)) return { ok: false, error: 'That file isn’t a PNG. Please save your logo as a PNG and try again.' };
    let img: Image;
    try {
      img = decodePng(buf);
    } catch (err) {
      const why = err instanceof Error ? err.message : '';
      return { ok: false, error: /interlac/i.test(why) ? 'That PNG is interlaced. Please re-save it without interlacing.' : 'We couldn’t read that image. Please try a different PNG.' };
    }
    if (Math.min(img.width, img.height) < 192) {
      return { ok: false, error: `That image is ${img.width}×${img.height}. Please use one at least 512 pixels on each side, so it stays sharp on a home screen.` };
    }

    // Store the RE-ENCODED bytes, not the upload. Nothing the admin sent is ever written to the
    // volume or served back, and a re-derive later starts from something already known good.
    const clean = encodePng(cropSquare(img));
    this.store.set(KEY_UPLOAD, clean.toString('base64'));
    await this.ensure(true);
    return { ok: true };
  }

  /** Drop the upload and go back to the automatic chain. */
  async clearUpload(): Promise<void> {
    this.store.del(KEY_UPLOAD);
    await this.ensure(true);
  }

  /** Called when the admin picks a different timetable: the Display logo may now be a different
   *  masjid's, so the current icon is no longer necessarily right. */
  async invalidate(): Promise<void> {
    await this.ensure(true);
  }
}
