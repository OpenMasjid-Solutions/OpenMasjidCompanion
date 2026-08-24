// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * fabric.ts — everything this app says to OpenMasjidOS. Server→server, always.
 *
 * Slice 2 covers single sign-on. The public-URL lookup, the appearance relay, the alert
 * channel and the timetable broker call all land here in later slices and share the posture
 * set out below.
 *
 * THE POSTURE, which every call in this file follows without exception:
 *
 *  - **`redirect: 'error'`.** We present a credential; following a redirect would hand it to
 *    whatever host the redirect named.
 *  - **An `AbortController` timeout on every call.** The platform is on the same LAN and is
 *    usually instant, but "usually" is not a property you can build a prayer-times page on.
 *  - **It never throws.** An unreachable platform means "no Fabric this request" — never a
 *    crash, and never a lock-out. This is the single most important sentence in the file.
 *  - **Nothing here is persisted.** See config.ts: the base URL, the secret and the public URL
 *    are read from the environment every process start, because the platform rewrites all
 *    three across a restore onto a new machine.
 *
 * RESTORE / MIGRATION RESILIENCE is not an abstraction. The failure it prevents is: a masjid
 * restores a backup onto a new box, the platform issues a new address and secret, a cached
 * copy points at the old one, and the admin is locked out of the app with nothing in any log
 * explaining why. `docs/RESTORE_SSO_FIX.md` in the sibling repos is the write-up.
 */
import { config, ssoConfigured } from './config';
import { normBasePath } from './basePath';
import { makeLog } from './logger';

const log = makeLog('fabric');

export { ssoConfigured };

/**
 * Is `host` a loopback / private / LAN address, where sending our app secret over plain HTTP
 * is acceptable? The normal deployment (the platform on the same box, or a 192.168.x.x
 * machine) is exactly this, and warning about it would be noise.
 *
 * Exported for its own test: the ranges below are the kind of thing that is easy to get
 * subtly wrong, and both directions of error are bad. Too strict and a masjid's log carries a
 * scary security warning about a perfectly normal LAN install, which trains them to ignore
 * warnings; too loose and a genuinely public plain-HTTP deployment says nothing at all.
 */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[/, '').replace(/\]$/, ''); // strip IPv6 brackets
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
  // Names that cannot be public by construction. `.internal` is ICANN-reserved for private
  // use, and is what Docker hands containers ("host.docker.internal") — the single most
  // common way this app reaches a platform that is not on its own loopback.
  if (h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.internal') || h.endsWith('.home.arpa')) return true;
  // A single-label name has no public DNS meaning at all: it is a container name on a Docker
  // network, or a hostname from the LAN's own resolver. Either way it never left the building.
  if (!h.includes('.') && !h.includes(':')) return true;
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true; // IPv6 link-local + ULA
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 169 && b === 254) return true; // 169.254.0.0/16
  }
  return false;
}

// Warn at most once per process — a cleartext secret on a public host is a configuration
// concern, not a per-request event, so it must not spam a masjid's log.
let cleartextSecretWarned = false;

/** One-time nudge when our per-app secret is about to cross the network in cleartext to a
 *  PUBLIC host. We never stop sending — an operator who put the platform on another machine
 *  over plain HTTP has a working install, and breaking it would be worse than saying so. */
function warnIfCleartextSecret(): void {
  if (cleartextSecretWarned || !config.omosBaseUrl) return;
  let url: URL;
  try {
    url = new URL(config.omosBaseUrl);
  } catch {
    return; // malformed base URL — the fetch will fail and be handled there
  }
  if (url.protocol === 'https:') return;
  if (isPrivateHost(url.hostname)) return;
  cleartextSecretWarned = true;
  log.warn(
    `OPENMASJID_BASE_URL is a public address over plain http (${url.host}); this app's Fabric secret ` +
      `is crossing the network unencrypted. For a cross-host deployment set an https OPENMASJID_BASE_URL. ` +
      `(Over a trusted LAN, plain http is fine.)`,
  );
}

/** Pull the platform's session token out of the raw Cookie header.
 *
 *  ONLY from the Cookie header — never a query string, a custom header or a body. Those are
 *  all things a page can be made to send from somewhere else; the cookie is the browser's own
 *  same-site decision, which is the entire basis on which the platform's answer means
 *  anything. */
function omosCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const m = /(?:^|;\s*)omos_session=([^;]+)/.exec(cookieHeader);
  if (!m) return null;
  const token = m[1].trim();
  // Only forward something shaped like a cookie value, so nothing odd can be injected into
  // the outbound Cookie header we build from it.
  return /^[A-Za-z0-9._~%+/=-]{1,4096}$/.test(token) ? token : null;
}

interface CacheEntry {
  username: string;
  expires: number;
}
const positiveCache = new Map<string, CacheEntry>();
const CACHE_MS = 45_000;
/** Bound the cache. Keys are platform session tokens, so this is belt-and-braces rather than
 *  a defence — but an unbounded map fed from a request header is a leak waiting for a future
 *  caller, and one masjid never has this many admins. */
const CACHE_MAX = 256;

export interface PlatformProbe {
  /** The platform-confirmed username, or null if this visitor is not signed in there. */
  username: string | null;
  /**
   * Did we actually REACH the platform? false = not configured, network error, or timeout.
   *
   * This is the whole reason the function returns a shape instead of a string. "You are not
   * signed in" and "OpenMasjidOS is unreachable" need different screens and different offers:
   * the first says press Open in the dashboard, the second has to offer the local-password
   * recovery. Conflating them is exactly what locks an admin out of their own app after a
   * restore — and it is what `/api/setup`'s guard keys off.
   */
  reachable: boolean;
}

/**
 * Ask the platform whether the viewer of THIS request is the OpenMasjidOS admin.
 *
 * Identity-bound: we present our own per-app secret, so the shared session cookie cannot let
 * some other installed app validate as us. The platform fails closed without it.
 *
 * Never throws. A positive answer is cached briefly per token, because the admin panel makes
 * several requests per page and one platform round trip per request would be both slow and
 * rude on a Pi.
 */
export async function probePlatform(cookieHeader: string | undefined): Promise<PlatformProbe> {
  if (!ssoConfigured()) return { username: null, reachable: false };
  const token = omosCookie(cookieHeader);
  if (!token) {
    // Nothing to validate — but still report reachability, so the UI can tell "open it from
    // the dashboard" apart from "the platform is down".
    return { username: null, reachable: await platformReachable() };
  }

  const cached = positiveCache.get(token);
  if (cached && cached.expires > Date.now()) return { username: cached.username, reachable: true };

  warnIfCleartextSecret();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${config.omosBaseUrl}/api/auth/session`, {
      headers: {
        cookie: `omos_session=${token}`,
        // A CREDENTIAL. Never logged, never persisted, never sent anywhere but here.
        'x-openmasjid-app-secret': config.omosAppSecret,
      },
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(t);
    // ANY HTTP response — even a 401 or a 500 — means the platform is reachable. That
    // distinction is the point of this function.
    if (res.ok) {
      const j = (await res.json().catch(() => ({}))) as { authenticated?: boolean; username?: unknown };
      if (j.authenticated === true) {
        // An untrusted display string. Capped and trimmed; never used for a decision.
        const username = (typeof j.username === 'string' ? j.username : '').trim().slice(0, 64) || 'OpenMasjidOS';
        positiveCache.set(token, { username, expires: Date.now() + CACHE_MS });
        if (positiveCache.size > CACHE_MAX) {
          const now = Date.now();
          for (const [k, v] of positiveCache) if (v.expires <= now) positiveCache.delete(k);
        }
        return { username, reachable: true };
      }
    }
    return { username: null, reachable: true };
  } catch (err) {
    log.debug(`platform session check failed: ${err instanceof Error ? err.message : String(err)}`);
    return { username: null, reachable: false };
  }
}

/**
 * Cheap "is the platform up?" check, used only when there is no session cookie to validate.
 *
 * Hits the appearance endpoint because it is public and CORS-enabled — any response at all,
 * including an error status, proves we reached it. Deliberately does NOT present the secret:
 * this answers a question about the network, not about us.
 */
export async function platformReachable(): Promise<boolean> {
  if (!config.omosBaseUrl) return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    await fetch(`${config.omosBaseUrl}/api/public/appearance`, { signal: ctrl.signal, redirect: 'error' });
    clearTimeout(t);
    return true;
  } catch {
    return false;
  }
}

/** Drop cached positive session answers. Called on logout so signing out here does not leave
 *  a 45-second window in which the next request silently signs you back in. */
export function clearSessionCache(): void {
  positiveCache.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Where this app actually lives on the internet (`domain: true`)
// ─────────────────────────────────────────────────────────────────────────────

/** What `GET /api/fabric/site` tells us, normalised. Never persisted — see the file header. */
export interface FabricSite {
  /** Remote access is on AND this app is shared through the tunnel. */
  enabled: boolean;
  /** The masjid's tunnel domain, e.g. "omos.example.org". Display only. */
  domain: string;
  /** Our full public address with no trailing slash, or '' when not shared. */
  publicUrl: string;
  /** The path prefix the front door forwards to us: '' or '/companion'. */
  basePath: string;
}

/** Accept only a real absolute http(s) URL. A malformed or exotic-scheme value here would end
 *  up on a printed QR code and as a push notification's origin, so '' is the safer answer. */
function safeAbsoluteUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) return '';
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

/**
 * Ask the platform for our public address and base path.
 *
 * This is the LIVE source of truth for both. `OPENMASJID_PUBLIC_URL` is only the value we had
 * at boot: the admin can turn Remote access on, share this app, or rename its path at any
 * moment, and none of those restart the container.
 *
 * Returns null on any failure — the caller keeps whatever it last knew, which matters more
 * here than anywhere else in this file. See site.ts.
 */
export async function fetchSite(): Promise<FabricSite | null> {
  if (!ssoConfigured()) return null;
  warnIfCleartextSecret();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/site`, {
      headers: { 'x-openmasjid-app-secret': config.omosAppSecret },
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(t);
    if (!res.ok) {
      log.debug(`site lookup refused: HTTP ${res.status}`);
      return null;
    }
    const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!j || typeof j !== 'object') return null;
    return normaliseSite(j);
  } catch (err) {
    log.debug(`site lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Turn whatever the platform sent into the shape the rest of this app relies on.
 *
 * Exported for its own test. The platform is not hostile, but this value decides what gets
 * printed on a poster and how every absolute URL in the app is built, so it is validated like
 * anything else that crosses a process boundary.
 */
export function normaliseSite(j: Record<string, unknown>): FabricSite {
  const publicUrl = safeAbsoluteUrl(j.publicUrl);
  return {
    // `enabled` alone is not enough. It reports that Remote access is on; an app the admin
    // never ticked "share" for still has no public address. Both, or neither.
    enabled: j.enabled === true && !!publicUrl,
    domain: typeof j.domain === 'string' ? j.domain.slice(0, 253) : '',
    publicUrl,
    basePath: normBasePath(j.basePath),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Appearance + logo, relayed through our own server
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Why these are RELAYED rather than fetched by the browser (CLAUDE.md §6.2):
 *
 * Our page is HTTPS behind the tunnel. The platform's endpoint is plain HTTP on the LAN. A
 * direct fetch from the page is mixed content and the browser blocks it — so the appearance
 * would work in dev, work on the LAN, and fail in the one place a musalli ever opens the app.
 * Going through our own server means one origin and one scheme, with no exceptions to reason
 * about.
 */

/** The only appearance keys we pass on. An allowlist rather than a pass-through: this feeds a
 *  page's CSS variables, and a field we do not understand has no business reaching them. */
export interface Appearance {
  theme?: string;
  wallpaper?: string;
  wallpaperImage?: string;
  accent?: string;
  lang?: string;
}

const APPEARANCE_KEYS = ['theme', 'wallpaper', 'wallpaperImage', 'accent', 'lang'] as const;

/** Keep only known keys, only strings, each length-capped. Exported for its own test. */
export function pickAppearance(raw: unknown): Appearance {
  const out: Appearance = {};
  if (!raw || typeof raw !== 'object') return out;
  const src = raw as Record<string, unknown>;
  for (const k of APPEARANCE_KEYS) {
    const v = src[k];
    // wallpaperImage can legitimately be a data: URI, so it gets the larger cap. The web
    // sanitises it again before it reaches a CSS url() — see prefs.ts safeImageUrl.
    if (typeof v === 'string') out[k] = v.slice(0, k === 'wallpaperImage' ? 4096 : 64);
  }
  return out;
}

/** The dashboard's current look, or null if we could not reach it. Public on the platform, so
 *  no secret is presented — this asks nothing about us. */
export async function fetchAppearance(): Promise<Appearance | null> {
  if (!config.omosBaseUrl) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${config.omosBaseUrl}/api/public/appearance`, { signal: ctrl.signal, redirect: 'error' });
    clearTimeout(t);
    if (!res.ok) return null;
    return pickAppearance(await res.json().catch(() => null));
  } catch {
    return null;
  }
}

/** A logo big enough to derive a 512px app icon from, and nowhere near big enough to be a
 *  problem on a Pi. The platform re-encodes on upload, so a real one is far under this. */
const LOGO_MAX_BYTES = 1_500_000;

/**
 * Raster types only. SVG is refused DELIBERATELY.
 *
 * We re-serve these bytes from OUR origin, and an SVG is a script container: an `<svg>` with an
 * `onload`, fetched from our own path, is same-origin script in the admin's browser. The
 * platform is not hostile — but "the upstream would never" is not a security property, and the
 * whole cost of the rule is a masjid saving their logo as a PNG.
 *
 * Display reached the same conclusion independently for the timetable logo it now serves us.
 */
const LOGO_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export interface LogoImage {
  mime: string;
  body: Buffer;
}

/**
 * Three outcomes, kept apart on purpose.
 *
 * 'none' is a settled answer — this masjid has not set a logo, or set one we will not re-serve
 * — and caching it for a good while is right. 'unavailable' means we could not ask, and caching
 * THAT would show the fallback mark for the rest of the TTL because the core happened to be
 * restarting when the first phone opened the app.
 */
export type LogoResult = LogoImage | 'none' | 'unavailable';

/** The masjid's logo from the platform. Seeds the default PWA icon and brands the poster —
 *  the app on a musalli's home screen is named and iconed for the MASJID, not for us. */
export async function fetchLogo(): Promise<LogoResult> {
  if (!config.omosBaseUrl) return 'none';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`${config.omosBaseUrl}/api/public/logo`, { signal: ctrl.signal, redirect: 'error' });
    clearTimeout(t);
    // 404 = this masjid has not set a logo. Entirely normal, and a settled answer. Any other
    // refusal is the platform having a problem, which is not settled and should be retried.
    if (!res.ok) return res.status === 404 ? 'none' : 'unavailable';

    const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!LOGO_TYPES.has(mime)) {
      log.debug(`platform logo ignored: type ${mime || 'none'}`);
      return 'none'; // asking again will get the same file
    }
    // Refuse on the declared length first, so an absurd Content-Length costs us nothing. The
    // check is then repeated on the real bytes, because a header is a claim.
    const declared = Number.parseInt(res.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declared) && declared > LOGO_MAX_BYTES) return 'none';

    const body = Buffer.from(await res.arrayBuffer());
    if (body.byteLength === 0 || body.byteLength > LOGO_MAX_BYTES) return 'none';
    return { mime, body };
  } catch {
    return 'unavailable'; // timeout, refused connection, core restarting
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Alerts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The alert ids this app may raise.
 *
 * This list is a CONTRACT WITH manifest.yaml, not a convenience. The platform refuses an id the
 * manifest does not declare, and from the admin's side it refuses it invisibly — the alert they
 * were relying on simply never arrives. `manifest.test.ts` fails the build when the two drift,
 * in either direction.
 */
export const ALERT_IDS = ['timetable-unavailable', 'push-failing', 'test'] as const;
export type AlertId = (typeof ALERT_IDS)[number];

export type AlertResult = 'sent' | 'disabled_by_admin' | 'unavailable';

/**
 * Tell the admin something needs their attention.
 *
 * `disabled_by_admin` is a NORMAL answer, not a failure: the admin chose, in OpenMasjidOS, not
 * to be told about this, and we cannot read that choice. The only correct response is to carry
 * on quietly. Treating it as an error is how an app ends up retrying — or worse, logging a
 * warning every time about the admin's own preference.
 *
 * Alerts reach the ADMIN. Nothing in this app ever messages a musalli (CLAUDE.md §6.6).
 */
export async function raiseAlert(id: AlertId, message?: string): Promise<AlertResult> {
  if (!ssoConfigured()) return 'unavailable';
  // Compile-time typing does not survive a value that arrived from a route handler.
  if (!(ALERT_IDS as readonly string[]).includes(id)) {
    log.warn(`refusing to raise undeclared alert id "${id}"`);
    return 'unavailable';
  }
  warnIfCleartextSecret();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`${config.omosBaseUrl}/api/fabric/alert`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-openmasjid-app-secret': config.omosAppSecret,
      },
      body: JSON.stringify(message ? { id, message: message.slice(0, 500) } : { id }),
      signal: ctrl.signal,
      redirect: 'error',
    });
    clearTimeout(t);
    if (!res.ok) {
      log.debug(`alert "${id}" refused: HTTP ${res.status}`);
      return 'unavailable';
    }
    const j = (await res.json().catch(() => ({}))) as { delivered?: unknown; reason?: unknown };
    if (j.reason === 'disabled_by_admin' || j.delivered === false) return 'disabled_by_admin';
    return 'sent';
  } catch (err) {
    log.debug(`alert "${id}" failed: ${err instanceof Error ? err.message : String(err)}`);
    return 'unavailable';
  }
}
