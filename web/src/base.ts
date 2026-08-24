// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Runtime base path — the browser half of what `server/src/basePath.ts` does.
 *
 * OpenMasjidOS serves this app under an admin-chosen path prefix behind its Cloudflare
 * tunnel (e.g. "/companion") and forwards that prefix intact. The server strips it before
 * routing, and injects it into the page twice: as a `<base href>` so Vite's relative asset
 * URLs resolve, and as `window.__OMOS_BASE__` for everything below.
 *
 * The two are not interchangeable, which is the thing to understand before touching this
 * file. `<base href>` fixes RELATIVE URLs; it does nothing for `fetch('/api/app')`, which
 * is root-absolute and would go to the wrong app entirely. So every absolute in-app URL
 * this code builds goes through `withBase`.
 *
 * Read once per page load. Empty string when served at the root — a kiosk on the LAN, or
 * remote access off — and then everything below is the identity function.
 */
declare global {
  interface Window {
    __OMOS_BASE__?: string;
  }
}

function read(): string {
  const raw = (typeof window !== 'undefined' && window.__OMOS_BASE__) || '';
  const t = raw.trim().replace(/\/+$/, '');
  if (!t) return '';
  return t.startsWith('/') ? t : '/' + t;
}

/** The base path, e.g. "/companion" or "" (no trailing slash). */
export const BASE = read();

/** Prefix an absolute in-app path ("/api/app", "/week") with the base path. */
export const withBase = (p: string): string => (BASE && p.startsWith('/') ? BASE + p : p);

/**
 * Strip the base path off a `location.pathname` for client-side route matching, so the
 * router sees "/week" whether the page was opened on the LAN or under "/companion".
 *
 * The `startsWith(BASE + '/')` shape matters for the same reason it does on the server: a
 * masjid whose path is "/masjid" must not have "/masjidname" quietly rewritten.
 */
export const stripBase = (pathname: string): string => {
  if (BASE && (pathname === BASE || pathname.startsWith(BASE + '/'))) return pathname.slice(BASE.length) || '/';
  return pathname;
};

/** The absolute origin+base this page is served from — what a share link or a QR code
 *  would have to point at. Used only for display; the authoritative public URL comes from
 *  the platform (`/api/fabric/site`), because this one is whatever address the viewer
 *  happened to type, and a LAN address on a poster is a QR code that works for nobody. */
export const pageOrigin = (): string =>
  typeof window === 'undefined' ? '' : window.location.origin + BASE;
