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
import { makeLog } from './logger';

const log = makeLog('fabric');

export { ssoConfigured };

/**
 * Is `host` a loopback / private / LAN address, where sending our app secret over plain HTTP
 * is acceptable? The normal deployment (the platform on the same box, or a 192.168.x.x
 * machine) is exactly this, and warning about it would be noise.
 */
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[/, '').replace(/\]$/, ''); // strip IPv6 brackets
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
  if (h.endsWith('.local') || h.endsWith('.lan')) return true;
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
