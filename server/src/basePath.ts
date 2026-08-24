// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * basePath.ts — being reachable at two addresses at once.
 *
 * This app is served in two shapes AT THE SAME TIME, and both have to work:
 *
 *   LAN        http://<box>:7880/api/app            no prefix
 *   tunnelled  https://omos.masjid.org/companion/api/app   the FULL prefix, unstripped
 *
 * OpenMasjidOS puts every app on one public hostname under a path the ADMIN chooses
 * (default the app id, but renameable — never assume "companion"), and neither
 * Cloudflare nor the OS front door strips that prefix before it reaches us. The prefix
 * is learned at runtime from `GET /api/fabric/site`, so it is not something the routes
 * can be written against.
 *
 * The whole strategy is therefore: strip the prefix ONCE, before routing, so every route
 * in the server is written at the root and is identical in both shapes; and tell the
 * PAGE what the prefix is, so the browser can put it back on every URL it builds.
 *
 * Nothing in here reads the request's `Host` header. That header is attacker-controlled
 * on any request and simply absent in a background job like the push scheduler, so a URL
 * derived from it is either forgeable or missing exactly when it matters.
 *
 * Everything here is a pure function over (url, base) plus one module-level holder for
 * the current base — which is what lets Fastify's synchronous `rewriteUrl` hook consult
 * it per request without an await.
 */

/**
 * Normalise a path to `''` or `/seg[/seg…]` — leading slash, no trailing slash.
 *
 * `''` and `'/'` both mean "served at the root", and collapsing them here is what stops
 * `stripBasePath` from ever comparing against a bare `'/'`, which every URL starts with
 * and which would therefore strip the leading slash off every request in the app.
 */
export function normBasePath(raw: unknown): string {
  let p = (typeof raw === 'string' ? raw : '').trim();
  if (!p || p === '/') return '';
  if (!p.startsWith('/')) p = '/' + p;
  p = p.replace(/\/+$/, '');
  return p === '' ? '' : p;
}

/**
 * Remove the tunnel's path prefix from a request target, leaving a root-relative URL.
 *
 * The four cases, and the reason each is written out rather than folded into one regex:
 *
 *   base + '/…'  the ordinary request               /companion/api/app → /api/app
 *   base exactly the app's own front page           /companion         → /
 *   base + '?…'  the front page with a query        /companion?x=1     → /?x=1
 *   anything else                                   left completely alone
 *
 * That last line is the important one, and it is why the check is `base + '/'` rather
 * than `startsWith(base)`. A base of `/masjid` must not eat the prefix of a request for
 * `/masjidname` — and on the LAN, where the same running server is reached with NO
 * prefix at all, every request falls through this untouched. Both shapes are live
 * simultaneously; this function is the only thing that distinguishes them.
 *
 * A doubled prefix (`/companion/companion/x`) has exactly one level removed, which is
 * correct: the second segment is a real route on this app, not a second prefix.
 */
export function stripBasePath(url: string, base: string): string {
  const u = url || '/';
  if (!base) return u;
  if (u === base) return '/';
  if (u.startsWith(base + '/')) return u.slice(base.length);
  if (u.startsWith(base + '?') || u.startsWith(base + '#')) return '/' + u.slice(base.length);
  return u;
}

/**
 * Build an absolute in-app path under the base — the server-side twin of the web's
 * `withBase()`. For anything the SERVER emits that the BROWSER will resolve: the web
 * manifest's `start_url` and `scope`, its icon URLs, the service worker's scope.
 *
 * Only ever called with a literal in-app path. It is not a URL joiner and deliberately
 * refuses to look like one.
 */
export function withBase(base: string, p: string): string {
  if (!p.startsWith('/')) return p;
  return base ? base + p : p;
}

/**
 * The path charset an injected `<base href>` may contain.
 *
 * The base path comes from the platform over the network, and it lands in an HTML
 * attribute. It should always be a tame `/companion`, but "should" is not a property of
 * anything that arrives on a socket: an attribute-escaping quote here would be an
 * injection into every page this app serves. Rather than escape it, restrict it — a
 * URL path segment has no business containing anything outside this set, so anything
 * else is dropped.
 */
const SAFE_PATH_CHARS = /[^\w/-]/g;

/**
 * Serve `index.html` with the base path baked in, two ways, because the browser needs
 * both and they are not interchangeable:
 *
 *  - `<base href="/companion/">` makes the RELATIVE asset URLs Vite emits (`./assets/…`)
 *    resolve under the prefix. Without it, the page loads and every script 404s.
 *  - `window.__OMOS_BASE__` is what the app's own code reads to build API calls, links
 *    and the router's view of `location.pathname`. `<base href>` cannot do that job:
 *    it does not affect `fetch('/api/app')`, which is root-absolute and would leave the
 *    prefix off.
 *
 * One built image works at the root and under any prefix because this is done per
 * request, not at build time.
 */
export function injectBase(html: string, base: string): string {
  const safe = base.replace(SAFE_PATH_CHARS, '');
  const head =
    `<base href="${safe}/">\n    <script>window.__OMOS_BASE__=${JSON.stringify(safe)}</script>`;
  // Vite emits a bare `<head>`, but match attributes too so a future template change
  // cannot silently turn this into a no-op that only shows up behind the tunnel.
  const m = /<head(\s[^>]*)?>/i.exec(html);
  if (!m) return html;
  const at = m.index + m[0].length;
  return html.slice(0, at) + `\n    ${head}` + html.slice(at);
}

// ── The current base path ─────────────────────────────────────────────────────
// Held here rather than passed around because Fastify's `rewriteUrl` runs SYNCHRONOUSLY
// on every request, before routing, and cannot await a fetch. The Fabric client refreshes
// it in the background and calls `setBasePath`; until the first successful fetch — and
// for ever on a standalone install — it stays '' and the app serves at the root, which
// is exactly right.
let current = '';

/** The prefix to strip and inject, right now. Cheap; safe to call per request. */
export function getBasePath(): string {
  return current;
}

/** Record the base path the platform reported. Normalised on the way in so every caller
 *  can hand over whatever `/api/fabric/site` said. */
export function setBasePath(raw: unknown): void {
  current = normBasePath(raw);
}

/** Reset to "served at the root" — tests only, so one case cannot leak into the next. */
export function resetBasePath(): void {
  current = '';
}
