// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * auth.ts — the admin session for THIS app.
 *
 * Two ways in, and they are not equals:
 *
 *  - **OpenMasjidOS SSO** is the front door. The admin presses "Open" in the dashboard, the
 *    platform's session cookie rides along, our server asks the platform whether it is real,
 *    and on a yes we mint a SHORT local session (1 h). Short, because the platform's answer is
 *    a snapshot: an admin who signs out of the dashboard should not stay signed in here for
 *    a month on the strength of one 45-second-old yes.
 *  - **A local password** is the RECOVERY route, for when OpenMasjidOS itself is unreachable —
 *    a restore onto a new box, the core briefly down. It lasts 30 days because someone using
 *    it is by definition unable to use the front door.
 *
 * The session itself is a signed cookie, not a stored one: an HMAC over a small JSON payload
 * with an expiry and an audience. No session table to sweep, and nothing to leak.
 *
 * No external crypto dependency — Node's `crypto` does scrypt and HMAC.
 */
import crypto from 'node:crypto';

export const COOKIE = 'omc_session';

/** A password login lasts 30 days; an SSO-minted session is capped short so a stale platform
 *  session cannot linger here after a dashboard logout. */
export const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
export const SSO_SESSION_MS = 60 * 60 * 1000;

export interface Cred {
  hash: string;
  salt: string;
  /** scrypt cost (N) this hash was made with. Stored so the cost can be raised later without
   *  locking out an admin whose password was hashed under the old one. */
  n: number;
}

// N=2^16 is 4x Node's default. r=8, p=1, with maxmem sized for it (~67 MiB transient). We stop
// short of 2^17 deliberately: this app is expected to run on a Raspberry Pi alongside the
// platform and everything else the masjid installed, and a login that swaps the box out is a
// worse outcome than a slightly cheaper KDF behind a rate limiter.
const SCRYPT_N = 2 ** 16;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const scryptOpts = (n: number) => ({ N: n, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });

export function hashPassword(password: string): Cred {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(password, salt, 32, scryptOpts(SCRYPT_N));
  return { hash: dk.toString('hex'), salt: salt.toString('hex'), n: SCRYPT_N };
}

export function verifyPassword(password: string, cred: Cred): boolean {
  try {
    const dk = crypto.scryptSync(password, Buffer.from(cred.salt, 'hex'), 32, scryptOpts(cred.n ?? 16384));
    const stored = Buffer.from(cred.hash, 'hex');
    // Length check first: timingSafeEqual THROWS on a mismatch, and the length of a hash is
    // not the secret.
    return stored.length === dk.length && crypto.timingSafeEqual(stored, dk);
  } catch {
    return false;
  }
}

function hmac(secret: Buffer, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

/** The only audience this app mints. Named rather than implied so a token minted for some
 *  future purpose can never be replayed at the admin panel. */
type Audience = 'admin';

/**
 * Mint a session token: `<base64url(claims)>.<hmac>`.
 *
 * `usr` carries the admin's OpenMasjidOS username so the panel can greet them without a
 * platform round-trip on every request. It is INSIDE the HMAC, so it cannot be forged — and it
 * is only ever a display string, never something a decision is made on.
 */
export function makeToken(secret: Buffer, maxAgeMs = MAX_AGE_MS, aud: Audience = 'admin', usr?: string): string {
  const claims: { exp: number; aud: Audience; usr?: string } = { exp: Date.now() + maxAgeMs, aud };
  if (usr) claims.usr = usr.slice(0, 120);
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${hmac(secret, payload)}`;
}

/** Verify signature, expiry AND audience — constant-time on the signature. */
export function verifyToken(secret: Buffer, token: string | undefined, aud: Audience = 'admin'): boolean {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return false;
  const payload = token.slice(0, dot);
  const a = Buffer.from(token.slice(dot + 1));
  const b = Buffer.from(hmac(secret, payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { exp?: number; aud?: string };
    return typeof obj.exp === 'number' && obj.exp > Date.now() && obj.aud === aud;
  } catch {
    return false;
  }
}

/** The username inside a VALID token, or ''. Verifies BEFORE reading, so a caller can never be
 *  handed an attacker-chosen name from an unsigned payload. */
export function tokenUser(secret: Buffer, token: string | undefined, aud: Audience = 'admin'): string {
  if (!token || !verifyToken(secret, token, aud)) return '';
  try {
    const obj = JSON.parse(Buffer.from(token.slice(0, token.lastIndexOf('.')), 'base64url').toString()) as { usr?: unknown };
    return typeof obj.usr === 'string' ? obj.usr.slice(0, 120) : '';
  } catch {
    return '';
  }
}

/** Escape hatch for an operator who knows their deployment is HTTPS-only and wants no scheme
 *  sniffing at all. Nothing in the shipped configuration sets it. */
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1' || (process.env.COOKIE_SECURE ?? '').toLowerCase() === 'true';

/**
 * Did this request arrive over TLS?
 *
 * The cookie CANNOT just always be `Secure`: a masjid LAN is plain HTTP, and the flag would
 * lock every standalone admin out of their own panel. It also must not never be `Secure`: this
 * app is published on a public hostname through the tunnel, and a 30-day admin token with no
 * transport restriction would then ride any plaintext request to the same host.
 *
 * So it follows the scheme the request actually arrived on.
 *
 * On reading `x-forwarded-proto` while `trustProxy` is off: safe here in a way it would not be
 * for a rate-limit key. The header can only ADD `Secure` to the cookie in the response to THAT
 * SAME request — i.e. it can only restrict where the sender's own cookie will be sent. No
 * cross-user effect, no privilege gained, and a cross-site attacker cannot set headers on the
 * admin's own request in the first place.
 */
export function secureForRequest(req: { protocol?: string; headers: Record<string, unknown> }): boolean {
  if (COOKIE_SECURE) return true;
  if (req.protocol === 'https') return true;
  const xfp = req.headers['x-forwarded-proto'];
  // May be a comma-separated list from a proxy chain; the client-facing hop is the first entry.
  const first = (Array.isArray(xfp) ? xfp[0] : typeof xfp === 'string' ? xfp : '').split(',')[0].trim().toLowerCase();
  return first === 'https';
}

/**
 * Cookie options. HttpOnly + SameSite=Lax + Path=/.
 *
 * `Path: '/'` and not the base path, deliberately. Behind the tunnel the browser sees us under
 * `/companion`, on the LAN at the root, and the SAME browser may hit both — scoping the cookie
 * to a prefix would silently drop the session on whichever form it was not minted under.
 */
export function cookieOptions(maxAgeMs = MAX_AGE_MS, secure = COOKIE_SECURE) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    secure,
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}
