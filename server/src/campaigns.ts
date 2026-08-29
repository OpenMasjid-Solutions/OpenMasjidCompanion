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

// ── Why it did not work ──────────────────────────────────────────────────────

/**
 * Why a fetch produced no campaign.
 *
 * Seven different problems with seven different fixes. The first version of this collapsed all
 * of them into one sentence — "we couldn't reach this appeal" — and that is worse than useless
 * on a link the admin has just checked in their own browser: it names the one explanation they
 * have already ruled out and gives them nowhere to go. Whatever else is uncertain about another
 * app's availability, WHICH WAY it failed is something we know exactly.
 */
export type Problem =
  | { kind: 'dns'; host: string }
  | { kind: 'refused'; host: string }
  | { kind: 'tls'; host: string }
  | { kind: 'timeout'; host: string }
  | { kind: 'redirect'; to: string }
  | { kind: 'http'; status: number }
  | { kind: 'body' };

/** The admin's sentence: what happened, and what to do about it. Written for a volunteer. */
export function describeProblem(p: Problem): string {
  switch (p.kind) {
    case 'dns':
      return `This app can't look up "${p.host}" from inside your masjid's network, so it can't read the appeal. The link is fine in a browser on your phone because your phone looks it up on the internet — the server can't. Check that the box running OpenMasjidOS can reach the internet.`;
    case 'refused':
      return `Nothing answered at "${p.host}" when this app tried. Your own browser reaches it over the internet; this server has to as well, and something on the network is refusing the connection.`;
    case 'tls':
      return `The secure connection to "${p.host}" couldn't be verified. If you're using your own certificate rather than Cloudflare's, that's usually the cause.`;
    case 'timeout':
      return `"${p.host}" didn't answer in time. If OpenMasjid Donations is busy or restarting this clears on its own; if it keeps happening, the server may not have a route out to the internet and back.`;
    case 'redirect':
      return `That link was redirected somewhere this app won't follow (${p.to}). If there's a login page such as Cloudflare Access in front of your donation pages, this app can't get past it — appeals have to be publicly readable.`;
    case 'http':
      return p.status === 403 || p.status === 401
        ? `The donation page refused this app (HTTP ${p.status}). Something in front of it — a Cloudflare rule, or Access — is requiring a login that a public appeal shouldn't need.`
        : `The donation page answered with an error (HTTP ${p.status}) instead of the appeal.`;
    case 'body':
      return 'Something answered at that address, but it wasn’t an appeal. Check the link points at one appeal in OpenMasjid Donations — its own “Share” button gives you the right one.';
  }
}

/** The short technical line, for whoever can act on it. Shown under the sentence. */
export function problemDetail(p: Problem): string {
  switch (p.kind) {
    case 'dns':
      return `DNS lookup failed for ${p.host}`;
    case 'refused':
      return `connection refused by ${p.host}`;
    case 'tls':
      return `TLS verification failed for ${p.host}`;
    case 'timeout':
      return `no answer from ${p.host} within ${TIMEOUT_MS / 1000}s`;
    case 'redirect':
      return `redirected to ${p.to}`;
    case 'http':
      return `HTTP ${p.status}`;
    case 'body':
      return 'the reply was not a campaign';
  }
}

/** Node wraps a network failure in a TypeError with the real errno on `cause`. */
function classify(err: unknown, host: string): Problem {
  if (err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError') return { kind: 'timeout', host };
  const cause = (err as { cause?: { code?: string } } | undefined)?.cause;
  const code = String(cause?.code ?? '');
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { kind: 'dns', host };
  if (/^(CERT_|DEPTH_ZERO|UNABLE_TO_|SELF_SIGNED|ERR_TLS|EPROTO)/.test(code)) return { kind: 'tls', host };
  return { kind: 'refused', host };
}

/**
 * Identify ourselves.
 *
 * An unnamed client is what a WAF blocks first, and this request crosses the public internet to
 * the masjid's own Cloudflare hostname — there is genuinely something in the middle.
 */
const UA = 'OpenMasjidCompanion (+https://github.com/OpenMasjid-Solutions/OpenMasjidCompanion)';

/** Enough for a canonical-host or trailing-slash redirect; not enough to be a loop. */
const MAX_HOPS = 3;

/**
 * GET, following redirects by hand.
 *
 * The rest of this app sets `redirect: 'error'` (CLAUDE.md §13), and the REASON it does is that
 * every other outbound call presents `X-OpenMasjid-App-Secret` — following a redirect would
 * hand a credential to whatever host the redirect named. **This call presents nothing**: it is
 * the same anonymous GET any browser makes to a public donor page. Refusing a redirect outright
 * therefore buys no secrecy and breaks ordinary deployments — a canonical-host rule, a
 * trailing-slash normalisation, an http→https bump at the Cloudflare edge.
 *
 * So each hop is followed deliberately and re-checked. **Only the address the admin typed may
 * be a private one**; a redirect must land on public https. Otherwise a public link could bounce
 * us onto `192.168.x.x` and turn an admin's paste box into a port scanner.
 */
async function getFollowing(start: string, adminTyped: boolean): Promise<{ ok: true; res: Response; text: string } | { ok: false; problem: Problem }> {
  let url = start;
  for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
    const host = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return url;
      }
    })();

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        signal: ctrl.signal,
        // Manual, not 'follow': every hop is inspected before it is taken.
        redirect: 'manual',
        headers: { accept: 'application/json', 'user-agent': UA },
      });
    } catch (err) {
      return { ok: false, problem: classify(err, host) };
    } finally {
      clearTimeout(t);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return { ok: false, problem: { kind: 'http', status: res.status } };
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        return { ok: false, problem: { kind: 'redirect', to: location.slice(0, 120) } };
      }
      // Two kinds of hop are allowed, and nothing else:
      //
      //  • SAME ORIGIN — a trailing-slash or path normalisation, and the commonest redirect
      //    there is. Safe by construction: it cannot reach a host we were not already talking
      //    to, so it is permitted even from the LAN address an admin may legitimately paste.
      //  • A PUBLIC HTTPS host — a canonical-hostname rule at the edge.
      //
      // What this refuses is the one that matters: a public link that bounces us onto
      // 192.168.x.x, which would turn the admin's paste box into a port scanner for the
      // masjid's own network.
      const sameOrigin = next.origin === new URL(url).origin;
      const publicHttps = next.protocol === 'https:' && !isPrivateHost(next.hostname);
      if (next.username || next.password || !(sameOrigin || publicHttps)) {
        return { ok: false, problem: { kind: 'redirect', to: `${next.protocol}//${next.hostname}` } };
      }
      url = next.toString();
      continue;
    }

    if (res.status === 404 || res.status === 410) return { ok: true, res, text: '' }; // gone; body unread
    if (!res.ok) return { ok: false, problem: { kind: 'http', status: res.status } };

    const declared = Number.parseInt(res.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declared) && declared > MAX_BYTES) return { ok: false, problem: { kind: 'body' } };
    const text = await res.text().catch(() => '');
    if (text.length > MAX_BYTES) return { ok: false, problem: { kind: 'body' } };
    return { ok: true, res, text };
  }
  void adminTyped;
  return { ok: false, problem: { kind: 'redirect', to: 'too many redirects' } };
}

/** A campaign, or the reason there isn't one. */
export interface FetchResult {
  load: Load<Campaign | null>;
  /** null when the fetch succeeded (including a definite "it's gone"). */
  problem: Problem | null;
}

/**
 * Fetch one appeal.
 *
 * Three outcomes, kept apart because they are three different screens:
 *
 *  - a campaign — it is there and this is it;
 *  - `loaded(null)` — Donations answered that it is **gone** (404: deleted, or made inactive).
 *    A settled answer, worth caching, and the admin is told the appeal no longer exists.
 *  - `KEEP` — we could not ask, with `problem` saying which of the seven ways. Never cached as
 *    "gone": a Donations container restarting while one phone happened to open the app must not
 *    delete a masjid's Ramadan appeal from the noticeboard for the rest of the TTL.
 */
export async function fetchCampaign(link: Link): Promise<FetchResult> {
  const url = `${link.base}/api/public/campaign/${encodeURIComponent(link.slug)}`;
  const got = await getFollowing(url, true);
  if (!got.ok) {
    log.debug(`${link.slug}: ${problemDetail(got.problem)}`);
    return { load: KEEP, problem: got.problem };
  }
  const res = got.res;
  if (res.status === 404 || res.status === 410) return { load: loaded(null), problem: null };

  try {
    const parsed = PublicCampaign.safeParse(JSON.parse(got.text)?.data);
    if (!parsed.success) {
      // Something is at that address answering, but it is not a campaign. Almost always a link
      // to the Donations app root, or to another app entirely.
      log.debug(`not a campaign payload at ${url}`);
      return { load: KEEP, problem: { kind: 'body' } };
    }
    const c = parsed.data;

    return { load: loaded({
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
    }), problem: null };
  } catch {
    // Malformed JSON — an HTML error page from something in front of Donations, most often.
    return { load: KEEP, problem: { kind: 'body' } };
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
  /** When `health` is 'unreachable': what actually went wrong, in plain words. */
  why: string;
  /** The same thing in one technical line, for whoever can act on it. */
  detail: string;
  testMode: boolean;
  localOnly: boolean;
}

export class Campaigns {
  private links: Link[];
  /** One cache per slug, keyed by the full URL so re-pasting a link under a different base is a
   *  different entry rather than a silently shared one. */
  private cache = new Map<string, Cached<Campaign | null>>();
  /** The last reason a link did not load, keyed the same way. Not in `Cached` because it is
   *  about the ATTEMPT, and `Cached` deliberately only remembers values. */
  private problems = new Map<string, Problem | null>();

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
    for (const key of [...this.problems.keys()]) if (!live.has(key)) this.problems.delete(key);
  }

  private entryFor(link: Link): Cached<Campaign | null> {
    const key = linkUrl(link);
    let c = this.cache.get(key);
    if (!c) {
      c = new Cached<Campaign | null>(async () => {
        const r = await fetchCampaign(link);
        this.problems.set(key, r.problem);
        return r.load;
      }, TTL_MS, RETRY_MS);
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
    return rows.map(({ link, value, ever }) => {
      const key = linkUrl(link);
      const problem = this.problems.get(key) ?? null;
      // A value we have never had AND a live failure is "unreachable". A value that loaded and
      // came back null is "gone" — the two must not merge, and neither may borrow the other's
      // explanation.
      const health: Health = value ? 'ok' : ever ? 'gone' : 'unreachable';
      return {
        url: key,
        slug: link.slug,
        title: value?.title ?? link.slug,
        health,
        notReady: value && !value.ready ? value.readyReason || 'This appeal isn’t accepting donations at the moment.' : '',
        why: health === 'unreachable' && problem ? describeProblem(problem) : '',
        detail: health === 'unreachable' && problem ? problemDetail(problem) : '',
        testMode: value?.testMode === true,
        localOnly: isLocalOnly(link),
      };
    });
  }

  /** For the admin panel's summary line, without fetching anything. */
  count(): number {
    return this.links.length;
  }
}

