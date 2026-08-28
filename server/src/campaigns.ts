// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * campaigns.ts — the masjid's appeals, read from OpenMasjidDonations' public surface.
 *
 * **This app never touches money** (CLAUDE.md §2). It reads the same public JSON any browser
 * loading a donor page would read, renders a tile, and links out. There is no Stripe SDK here,
 * no amount, no card field, no intent, no receipt. Giving happens on the Donations page.
 *
 * Zero Donations-side changes were needed, and that is the point of the design: Donations
 * already serves `GET <base>/api/public/campaign/<slug>` for its own donor page, so the
 * integration is a client, not a contract negotiation.
 *
 * **Curation is by pasted links, and that is a feature rather than a shortcut.** Donations has
 * no "list all campaigns" endpoint, and adding one would be the wrong shape anyway: a masjid
 * running a private staff appeal alongside a public Ramadan one does not want the first on the
 * noticeboard. The masjid pastes what belongs in the app, in the order it should appear.
 *
 * THE POSTURE, matching fabric.ts, because operationally this is another app's output:
 *
 *  - `redirect: 'error'` and an AbortController on every call. It never throws.
 *  - A response-size cap, checked on the declared length AND on the real bytes.
 *  - Everything parsed with zod and re-emitted field by field. Nothing from this feed reaches a
 *    musalli's screen without having been named here first — an image URL that is not http(s)
 *    is dropped, not rendered.
 *  - Serve-stale-on-error per tile: a Donations restart must not empty the appeals section.
 */
import { z } from 'zod';
import { Cached, KEEP, type Load, loaded } from './cache';
import { isPrivateHost } from './fabric';
import { makeLog } from './logger';
import type { Store } from './store';

const log = makeLog('campaigns');

const KEY_LINKS = 'campaigns.links';

/** Fresh enough that a donation shows up on the progress bar within a minute or two, cheap
 *  enough that fifty phones at Maghrib cost one request per appeal. */
const TTL_MS = 60_000;
const RETRY_MS = 20_000;
const TIMEOUT_MS = 5_000;
/** A campaign's JSON is a couple of KB. Anything approaching this is not one. */
const MAX_BYTES = 256 * 1024;
/** Enough for a noticeboard, few enough that the page stays a prayer-times page. */
export const MAX_LINKS = 12;

// ── The link an admin pastes ─────────────────────────────────────────────────

export interface Link {
  /** Everything before the slug: an origin, plus the tunnel path Donations sits on. */
  base: string;
  slug: string;
}

/** The link as the admin typed it, which is what they need to see to recognise it again. */
export const linkUrl = (l: Link): string => `${l.base}/${l.slug}`;

/**
 * A Donations share link → the base and slug to ask for.
 *
 * The share link is what the Donations admin's "Copy link" button produces — the donor page
 * itself, `<publicBase>/<slug>` — because that is the thing a masjid already has in their
 * clipboard. Asking them to construct an API URL would be asking them to know we exist.
 *
 * `https` is required for anything on a public host, and the message says why rather than
 * saying "invalid": this link ends up on a phone that is not in the building, and an http link
 * on a page served over the tunnel is blocked by the browser as mixed content before it is
 * anything else. A private address is allowed through — a masjid testing on their LAN is doing
 * something reasonable — but it is flagged, because it will work for them and nobody else.
 */
export function parseShareLink(raw: string): { ok: true; link: Link } | { ok: false; error: string } {
  const text = (raw ?? '').trim();
  if (!text) return { ok: false, error: 'Paste the link to an appeal.' };

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: 'That doesn’t look like a link. Copy it from the appeal’s “Share” button in OpenMasjid Donations.' };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: 'That link needs to start with https://.' };
  }
  // A username or password in a URL is never part of a share link, and forwarding one would
  // send a credential to a host chosen by whoever wrote the link.
  if (url.username || url.password) {
    return { ok: false, error: 'That link has a sign-in built into it, which we can’t use. Copy the plain share link.' };
  }
  if (url.protocol === 'http:' && !isPrivateHost(url.hostname)) {
    return {
      ok: false,
      error: 'That link needs to start with https://. Musallis open this app over the internet, and their phones will refuse a plain http link.',
    };
  }

  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const slug = parts.pop() ?? '';
  if (!slug) {
    return { ok: false, error: 'That’s the address of the Donations app itself, not of one appeal. Open the appeal and copy its share link.' };
  }
  // Donations' own slugs; anything else is a mistyped or truncated link rather than a campaign.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(slug)) {
    return { ok: false, error: 'That link doesn’t point at an appeal. Copy it from the appeal’s “Share” button.' };
  }
  // The API lives beside the donor page, so whatever prefix Donations is mounted under is
  // carried through unchanged. Never assumed to be "/donations": the admin can rename it.
  const base = `${url.origin}${parts.length ? `/${parts.map(encodeURIComponent).join('/')}` : ''}`;
  return { ok: true, link: { base, slug } };
}

/** True when this link only resolves inside the building. Surfaced to the admin, never hidden. */
export const isLocalOnly = (l: Link): boolean => {
  try {
    const u = new URL(l.base);
    return u.protocol === 'http:' || isPrivateHost(u.hostname);
  } catch {
    return false;
  }
};

// ── What Donations serves ────────────────────────────────────────────────────

/**
 * Only the fields a tile needs, and every one of them optional.
 *
 * Donations' payload is much larger than this — preset amounts, Stripe publishable keys, thank
 * you pages, fee rules. None of it is ours, and parsing loosely is deliberate: a field added or
 * renamed on their side must not empty a masjid's appeals section on ours. `.catch(...)` on
 * each field means a surprising type degrades that one value rather than the whole response.
 */
const PublicCampaign = z
  .object({
    slug: z.string().max(200).optional().catch(undefined),
    title: z.string().max(300).optional().catch(undefined),
    type: z.string().max(40).optional().catch(undefined),
    description: z.string().max(4000).optional().catch(undefined),
    coverImage: z.string().max(2000).optional().catch(undefined),
    goalAmount: z.number().optional().catch(undefined),
    raised: z.number().optional().catch(undefined),
    currency: z.string().max(10).optional().catch(undefined),
    allowMonthly: z.boolean().optional().catch(undefined),
    masjidName: z.string().max(200).optional().catch(undefined),
    /** False when this appeal cannot currently take a donation, with Donations' own sentence
     *  in `readyReason`. We do not write our own — theirs is written for a donor. */
    ready: z.boolean().optional().catch(undefined),
    readyReason: z.string().max(500).optional().catch(undefined),
    /** A test-mode appeal takes no real money. The admin is told; see `AdminCampaign`. */
    testMode: z.boolean().optional().catch(undefined),
  })
  .passthrough();

/** A tile, as this app will serve it. Every field has already been through `PublicCampaign`
 *  and, where it becomes an attribute on a page, through `safeImage`. */
export interface Campaign {
  slug: string;
  title: string;
  type: string;
  description: string;
  coverImage: string;
  goalAmount: number;
  raised: number;
  currency: string;
  allowMonthly: boolean;
  masjidName: string;
  ready: boolean;
  readyReason: string;
  testMode: boolean;
}

/**
 * An image URL safe to put in a `src`.
 *
 * Cross-app content is untrusted content, whatever its provenance. `javascript:` and `data:`
 * are the two that matter, and a relative path is resolved against the DONATIONS base rather
 * than ours, since that is where it was written.
 */
export function safeImage(raw: string | undefined, base: string): string {
  const v = (raw ?? '').trim();
  if (!v) return '';
  try {
    const u = new URL(v, `${base}/`);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
  } catch {
    return '';
  }
}

const clean = (s: string | undefined, max: number): string => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const money = (n: number | undefined): number => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0);

/**
 * Fetch one appeal.
 *
 * Three outcomes, kept apart because they are three different screens:
 *
 *  - a campaign — it is there and this is it;
 *  - `loaded(null)` — Donations answered that it is **gone** (404: deleted, or made inactive).
 *    A settled answer, worth caching, and the admin is told the appeal no longer exists.
 *  - `KEEP` — we could not ask. Never cached as "gone": a Donations container restarting while
 *    one phone happened to open the app must not delete a masjid's Ramadan appeal from the
 *    noticeboard for the rest of the TTL.
 */
export async function fetchCampaign(link: Link): Promise<Load<Campaign | null>> {
  const url = `${link.base}/api/public/campaign/${encodeURIComponent(link.slug)}`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, { signal: ctrl.signal, redirect: 'error', headers: { accept: 'application/json' } });
    } finally {
      clearTimeout(t);
    }

    if (res.status === 404 || res.status === 410) return loaded(null); // settled: it is gone
    if (!res.ok) return KEEP; // 5xx, a proxy error page, Donations still starting

    const declared = Number.parseInt(res.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declared) && declared > MAX_BYTES) return KEEP;
    const text = await res.text();
    if (text.length > MAX_BYTES) return KEEP;

    const parsed = PublicCampaign.safeParse(JSON.parse(text)?.data);
    if (!parsed.success) {
      // Something is at that address answering JSON, but it is not a campaign. Almost always a
      // link to the Donations app root or to another app entirely, so it is worth a line in
      // the log — the admin panel can only say "we could not read it".
      log.debug(`not a campaign payload at ${url}`);
      return KEEP;
    }
    const c = parsed.data;

    return loaded({
      slug: link.slug,
      title: clean(c.title, 120) || link.slug,
      type: clean(c.type, 40),
      description: clean(c.description, 300),
      coverImage: safeImage(c.coverImage, link.base),
      goalAmount: money(c.goalAmount),
      raised: money(c.raised),
      currency: /^[A-Za-z]{3}$/.test(c.currency ?? '') ? (c.currency as string).toUpperCase() : '',
      allowMonthly: c.allowMonthly === true,
      masjidName: clean(c.masjidName, 120),
      // Absent means yes. An older Donations that predates the field is working fine, and
      // defaulting to "not ready" would hide every appeal on it.
      ready: c.ready !== false,
      readyReason: clean(c.readyReason, 300),
      testMode: c.testMode === true,
    });
  } catch {
    // A timeout, a refused connection, a redirect we would not follow, malformed JSON.
    return KEEP;
  }
}

// ── The masjid's list ────────────────────────────────────────────────────────

/** What a musalli's phone is given. No health, no reasons, no test-mode flag — those are the
 *  admin's business, and a tile is either shown or it is not. */
export interface PublicTile {
  slug: string;
  title: string;
  description: string;
  coverImage: string;
  goalAmount: number;
  raised: number;
  currency: string;
  allowMonthly: boolean;
  /** Where the giving happens. Opened in a new tab so an installed app hands off and comes back. */
  href: string;
}

export type Health = 'ok' | 'gone' | 'unreachable';

/** One row of the admin's list: the link, and the truth about it. */
export interface AdminCampaign {
  url: string;
  slug: string;
  title: string;
  health: Health;
  /** Set when Donations says the appeal cannot take a donation right now — their words. */
  notReady: string;
  testMode: boolean;
  localOnly: boolean;
}

export class Campaigns {
  private links: Link[];
  /** One cache per slug, keyed by the full URL so re-pasting a link under a different base is a
   *  different entry rather than a silently shared one. */
  private cache = new Map<string, Cached<Campaign | null>>();

  constructor(private readonly store: Store) {
    this.links = this.read();
  }

  private read(): Link[] {
    const raw = this.store.getJson<unknown>(KEY_LINKS, []);
    if (!Array.isArray(raw)) return [];
    const out: Link[] = [];
    for (const item of raw) {
      const r = typeof item === 'string' ? parseShareLink(item) : { ok: false as const, error: '' };
      if (r.ok) out.push(r.link);
    }
    return out.slice(0, MAX_LINKS);
  }

  /** The links as stored — used by the admin screen, and to seed the text area. */
  list(): Link[] {
    return [...this.links];
  }

  /**
   * Replace the whole ordered list.
   *
   * Whole-list rather than add/remove/move, because the order IS the setting and three
   * endpoints that each mutate it would need to agree about what happens when two of them race.
   * The caller has already parsed each line, so this takes links rather than text.
   */
  set(links: Link[]): void {
    this.links = links.slice(0, MAX_LINKS);
    this.store.setJson(KEY_LINKS, this.links.map(linkUrl));
    // Drop caches for links that are no longer listed, so removing and re-adding an appeal
    // re-checks it rather than showing whatever was last seen.
    const live = new Set(this.links.map(linkUrl));
    for (const key of [...this.cache.keys()]) if (!live.has(key)) this.cache.delete(key);
  }

  private entryFor(link: Link): Cached<Campaign | null> {
    const key = linkUrl(link);
    let c = this.cache.get(key);
    if (!c) {
      c = new Cached<Campaign | null>(() => fetchCampaign(link), TTL_MS, RETRY_MS);
      this.cache.set(key, c);
    }
    return c;
  }

  /** Fetch every listed appeal, in parallel, never throwing. */
  private async all(): Promise<{ link: Link; value: Campaign | null | undefined; ever: boolean }[]> {
    return Promise.all(
      this.links.map(async (link) => {
        const e = await this.entryFor(link).get();
        return { link, value: e.value, ever: e.at > 0 };
      }),
    );
  }

  /** Force a re-check of every appeal — the admin has just fixed something in Donations. */
  async refresh(): Promise<void> {
    for (const link of this.links) this.entryFor(link).invalidate();
    await this.all();
  }

  /**
   * The tiles a musalli sees.
   *
   * Two things are dropped: an appeal Donations says is **gone**, and one it says is **not
   * ready** to take a donation. Both leave silently and are named loudly in the admin panel —
   * a tile that leads to "this appeal isn't available" has spent the one tap a musalli was
   * going to give it, and a QR code on a noticeboard is not a place to find that out.
   *
   * A test-mode appeal is NOT dropped. The masjid chose to feature it, Donations' own page
   * badges it clearly, and the admin is warned here — deciding for them would be a step too far.
   */
  async publicTiles(): Promise<PublicTile[]> {
    const rows = await this.all();
    const out: PublicTile[] = [];
    for (const { link, value } of rows) {
      if (!value || !value.ready) continue;
      out.push({
        slug: value.slug,
        title: value.title,
        description: value.description,
        coverImage: value.coverImage,
        goalAmount: value.goalAmount,
        raised: value.raised,
        currency: value.currency,
        allowMonthly: value.allowMonthly,
        href: linkUrl(link),
      });
    }
    return out;
  }

  /** The admin's list, with every reason a tile is not on a phone. */
  async adminList(): Promise<AdminCampaign[]> {
    const rows = await this.all();
    return rows.map(({ link, value, ever }) => ({
      url: linkUrl(link),
      slug: link.slug,
      title: value?.title ?? link.slug,
      health: value ? 'ok' : ever ? 'gone' : 'unreachable',
      notReady: value && !value.ready ? value.readyReason || 'This appeal isn’t accepting donations at the moment.' : '',
      testMode: value?.testMode === true,
      localOnly: isLocalOnly(link),
    }));
  }

  /** For the admin panel's summary line, without fetching anything. */
  count(): number {
    return this.links.length;
  }
}

