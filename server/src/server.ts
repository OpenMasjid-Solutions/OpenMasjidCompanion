// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * server.ts — the Fastify app itself: every route, every hook, and nothing about
 * processes, ports or signals. `index.ts` is the thin bootstrap that owns those.
 *
 * The split exists so the whole server can be built in a test and driven with
 * `app.inject()` — which is the only way to prove the thing slice 1 is really about:
 * that one running server answers correctly at BOTH of its addresses, the LAN form with
 * no prefix and the tunnelled form with the admin's prefix still on the front. Testing
 * `stripBasePath` in isolation proves the arithmetic; only injecting a request proves
 * the hook is actually wired to it.
 */
import path from 'node:path';
import fs from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import { z } from 'zod';
import { config, ssoConfigured } from './config';
import { makeLog } from './logger';
import type { Store } from './store';
import { getBasePath, injectBase, stripBasePath } from './basePath';
import { COOKIE, MAX_AGE_MS, SSO_SESSION_MS, cookieOptions, hashPassword, makeToken, secureForRequest, tokenUser, verifyPassword, verifyToken } from './auth';
import { LoginLimiter, makeRateLimiter } from './rateLimit';
import { clearSessionCache, probePlatform } from './fabric';
import { parseChangelog, readChangelog } from './changelog';

const log = makeLog('server');

export interface ServerDeps {
  store: Store;
  /** Where the built web app lives. Overridable so a test can point at a fixture, or at
   *  nowhere at all, without needing Vite to have run. */
  publicDir?: string;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { store } = deps;
  const publicDir = deps.publicDir ?? config.publicDir;

  const app = Fastify({
    logger: false, // we log ourselves, and never log a secret
    // trustProxy stays OFF. The container is port-mapped directly, so a client-supplied
    // X-Forwarded-For must not be believed — otherwise the rate limiters that are the
    // real defence behind an unauthenticated write endpoint and a short admin password
    // could be bypassed with a request header. Anything needing a client identity reads
    // the real TCP peer instead.
    trustProxy: false,
    bodyLimit: 1_048_576, // 1 MiB; the icon upload gets its own, larger, limit later
    // Bound how long one request may hold a socket. Node already defends the classic
    // slowloris with headersTimeout/requestTimeout; this tightens the grip on a Pi's
    // socket table without getting in the way of an icon upload over bad masjid wifi.
    requestTimeout: 120_000,
    // The whole base-path mechanism, in one hook: strip the tunnel's prefix BEFORE
    // routing, so every route below is written at the root and behaves identically in
    // both shapes. '' until the Fabric says otherwise, so a standalone install never
    // rewrites anything.
    rewriteUrl(req) {
      return stripBasePath(req.url ?? '/', getBasePath());
    },
  });

  await app.register(fastifyCookie); // parses req.cookies + decorates reply.setCookie

  // ── Baseline security response headers (every route, including static) ──────
  // Deliberately a short list, and each earns its place here specifically:
  //   • nosniff — the admin will upload an app icon, stored and served from OUR origin.
  //     Its declared type comes from the client, so without this a content-sniffing
  //     browser is the only thing between an uploaded file and same-origin script
  //     execution.
  //   • no-referrer — a musalli tapping "Donate" leaves for the masjid's Donations page.
  //     Nothing about which masjid's app they were in should ride along.
  // frame-ancestors is deliberately NOT set: OpenMasjidOS embeds its apps in a frame.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
  });

  // ── Who is asking, and how often ────────────────────────────────────────────
  // The REAL TCP peer, never req.ip. `trustProxy` is off precisely so a client-supplied
  // X-Forwarded-For cannot become a limiter key — otherwise every limit below is bypassable
  // with a request header.
  const peerOf = (req: FastifyRequest): string => req.socket.remoteAddress ?? 'unknown';

  const loginLimiter = new LoginLimiter();
  // Unauthenticated AND makes an outbound call to the OpenMasjidOS core on every request. With
  // no cap, anyone who can reach this box can use it as an unmetered amplifier against the
  // platform, and each call also holds one of a Pi's sockets for up to 4s. 120/min is far above
  // any real page load, so it can never get in the way of the thing it protects.
  const platformCallOk = makeRateLimiter(120);

  // ── Health check ────────────────────────────────────────────────────────────
  app.get('/healthz', async () => ({ ok: true }));

  // ── Admin session ───────────────────────────────────────────────────────────
  // Every protected route is a simple SYNCHRONOUS cookie check. The expensive part — asking
  // the platform who this is — happens once, in GET /api/session, and is minted into our own
  // short-lived cookie.
  const isAuthed = (cookie: string | undefined): boolean => verifyToken(store.secret, cookie, 'admin');

  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isAuthed(req.cookies[COOKIE])) return reply.code(401).send({ error: 'Please sign in.' });
  };

  /**
   * Who am I? — and the SSO upgrade, in the same call.
   *
   * If the visitor is not already signed in here but carries a valid OpenMasjidOS session, we
   * confirm it with the platform (server→server) and mint a short local cookie. So pressing
   * "Open" in the dashboard lands the admin straight in the panel, and everything after that
   * is a local check.
   *
   * The three states this reports are deliberately separate, because they need three different
   * screens: signed in; not signed in but the platform is reachable ("press Open in your
   * dashboard"); and the platform is UNREACHABLE ("use your local password"). Collapsing the
   * last two is what bricks a panel after a restore.
   */
  app.get('/api/session', async (req, reply) => {
    let authed = isAuthed(req.cookies[COOKIE]);
    let username = authed ? tokenUser(store.secret, req.cookies[COOKIE]) : '';
    // True unless we tried to reach the platform and could not.
    let reachable = true;

    // Only the SSO upgrade costs an outbound call, so the cap guards that branch alone — an
    // already-signed-in admin can never be rate-limited out of their own panel.
    if (!authed && ssoConfigured() && !platformCallOk(peerOf(req))) {
      return reply.code(429).send({ error: 'Too many requests. Please try again shortly.' });
    }
    if (!authed && ssoConfigured()) {
      const probe = await probePlatform(req.headers.cookie);
      reachable = probe.reachable;
      if (probe.username) {
        reply.setCookie(COOKIE, makeToken(store.secret, SSO_SESSION_MS, 'admin', probe.username), cookieOptions(SSO_SESSION_MS, secureForRequest(req)));
        authed = true;
        username = probe.username;
      }
    }

    return {
      data: {
        authed,
        username: username || undefined,
        /** A standalone install with no password yet goes straight to "choose one". Under
         *  OpenMasjidOS, signing in is the dashboard's job, so this stays false and the panel
         *  offers SSO first. */
        needsSetup: !store.hasAdmin() && !ssoConfigured(),
        hasPassword: store.hasAdmin(),
        sso: { enabled: ssoConfigured(), reachable },
      },
    };
  });

  /**
   * First-run setup / local-password recovery.
   *
   * THE GUARD: while the platform is reachable and SSO is configured, this REFUSES. The local
   * password is a recovery path for when OpenMasjidOS is *down* — never a parallel front door.
   * Without the guard there is a window on every SSO install, lasting until someone sets a
   * password (i.e. possibly for ever), in which anyone who can reach this box on the LAN can
   * claim the admin account before the real admin does.
   *
   * It must still work when the platform is genuinely unreachable — a restore onto a new
   * machine, the core briefly down — which is precisely why probePlatform reports reachability
   * separately from identity.
   */
  const SetupBody = z.object({ password: z.string().min(8).max(200) });
  app.post('/api/setup', async (req, reply) => {
    if (store.hasAdmin()) return reply.code(409).send({ error: 'A password has already been set.' });
    // An outbound platform call from an UNAUTHENTICATED route, so it needs the same cap as the
    // others. Without it this is an unmetered amplifier: `hasAdmin()` is false for the whole
    // life of every SSO install, so the 409 above never short-circuits and each POST costs one
    // socket against the core.
    if (ssoConfigured() && !platformCallOk(peerOf(req))) {
      return reply.code(429).send({ error: 'Too many requests. Please try again shortly.' });
    }
    if (ssoConfigured() && (await probePlatform(req.headers.cookie)).reachable) {
      return reply.code(403).send({
        error: 'Sign in through your OpenMasjidOS dashboard — press Open on the Companion app.',
      });
    }
    const parsed = SetupBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Please choose a password of at least 8 characters.' });
    store.setAdmin(hashPassword(parsed.data.password));
    reply.setCookie(COOKIE, makeToken(store.secret, MAX_AGE_MS), cookieOptions(MAX_AGE_MS, secureForRequest(req)));
    log.info('a local admin password was set (recovery route)');
    return { data: { ok: true } };
  });

  /** Password login. Rate-limited with exponential backoff — this is the real defence behind a
   *  password a volunteer chose, on a box that is published to the internet. */
  const LoginBody = z.object({ password: z.string().min(1).max(200) });
  app.post('/api/login', async (req, reply) => {
    const peer = peerOf(req);
    const wait = loginLimiter.retryAfterMs(peer);
    if (wait > 0) return reply.code(429).send({ error: `Too many attempts. Try again in ${Math.ceil(wait / 1000)}s.` });
    const admin = store.getAdmin();
    if (!admin) return reply.code(400).send({ error: 'No password has been set for this app.' });
    const parsed = LoginBody.safeParse(req.body);
    if (parsed.success && verifyPassword(parsed.data.password, admin)) {
      loginLimiter.succeed(peer);
      reply.setCookie(COOKIE, makeToken(store.secret, MAX_AGE_MS), cookieOptions(MAX_AGE_MS, secureForRequest(req)));
      return { data: { ok: true } };
    }
    loginLimiter.fail(peer);
    return reply.code(401).send({ error: 'Incorrect password.' });
  });

  app.post('/api/logout', async (_req, reply) => {
    // Drop the cached platform answer too, or the very next request silently signs the admin
    // back in from a 45-second-old "yes".
    clearSessionCache();
    reply.clearCookie(COOKIE, { path: '/' });
    return { data: { ok: true } };
  });

  // ── What's new (the release notes shipped inside this image) ────────────────
  // Behind auth: it is an admin-panel feature, and there is no reason a musalli's phone should
  // fetch a developer changelog. Parsed once at boot — the file cannot change under a running
  // container, since a new build IS a new container.
  const releases = parseChangelog(readChangelog());
  app.get('/api/changelog', { preHandler: requireAdmin }, async () => ({
    data: { version: config.version, releases },
  }));

  // ── Public bootstrap the web app reads on load (no secrets) ─────────────────
  app.get('/api/app', async () => ({
    data: {
      name: 'OpenMasjid Companion',
      version: config.version,
      /** Running under OpenMasjidOS with the Fabric available. NOT "signed in" — the
       *  admin panel asks that separately, because conflating the two is what locks an
       *  admin out after a restore. */
      embedded: ssoConfigured(),
      /** This app's public address, or '' when the admin has not shared it over the
       *  tunnel yet. The musalli page uses it to decide whether install and
       *  notifications can honestly be offered — neither works over plain HTTP, so
       *  offering them on a LAN address would be a button that cannot work. */
      publicUrl: config.omosPublicUrl,
      basePath: getBasePath(),
    },
  }));

  // ── Static web app (built by Vite into ./public) ────────────────────────────
  const indexPath = path.join(publicDir, 'index.html');
  const havePublic = fs.existsSync(indexPath);
  if (havePublic) {
    // index:false — we serve index.html ourselves so the base path can be injected.
    await app.register(fastifyStatic, { root: publicDir, index: false });
  } else {
    log.warn(`no built web app at ${publicDir} — run "cd web && npm run build" (dev uses the Vite server)`);
  }

  // Read once; the prefix is substituted per request, so one image works at the root and
  // under any tunnel path without being rebuilt.
  const rawIndex = havePublic ? fs.readFileSync(indexPath, 'utf8') : '';
  const sendIndexHtml = (reply: FastifyReply) => reply.type('text/html').send(injectBase(rawIndex, getBasePath()));

  // The admin panel is never cached — not by a browser, not by the service worker that arrives
  // in a later slice, and not by anything in between. Its shell is the same HTML as the
  // musalli page today, but the rule has to exist from the moment the route does: a cached
  // admin shell on a shared phone is a small thing that becomes a bad thing later.
  app.addHook('onSend', async (req, reply) => {
    const u = req.raw.url ?? '';
    if (u.startsWith('/admin') || u.startsWith('/api/admin')) reply.header('cache-control', 'no-store');
  });

  if (havePublic) app.get('/', async (_req, reply) => sendIndexHtml(reply));

  // SPA fallback: client-side routes (/week, /admin, …) resolve to index.html; a request
  // that looks like a file still 404s rather than being handed the app shell, because a
  // stale /assets/x.js answered with HTML is a syntax error reported far from its cause;
  // unknown API routes answer JSON.
  app.setNotFoundHandler((req, reply) => {
    const url = req.raw.url ?? '/';
    const pathname = url.split('?')[0];
    const looksLikeFile = path.extname(pathname) !== '';
    if (req.method === 'GET' && havePublic && !looksLikeFile && !url.startsWith('/api') && !url.startsWith('/healthz')) {
      return sendIndexHtml(reply);
    }
    return reply.code(404).send({ error: 'Not found.' });
  });

  // Consistent JSON error envelope; never leak a stack trace or framework-internal text
  // to a browser. Only a message this app itself authored (expose: true) is surfaced.
  app.setErrorHandler((err, _req, reply) => {
    const e = err as { message?: string; statusCode?: number; expose?: boolean };
    const status = typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500;
    // A 4xx is the client's mistake and says nothing about the health of this box. The
    // musalli page is reachable by anyone holding the QR code, so logging those at error
    // level would let a passer-by bury the one line that mattered.
    if (status >= 500) log.error('request error', e.message ?? 'unknown');
    else log.debug(`request refused (${status}) ${e.message ?? ''}`);
    const friendly =
      status === 413
        ? 'That was too large.'
        : status < 500
          ? "We couldn't process that request."
          : 'Something went wrong. Please try again.';
    reply.code(status).send({ error: e.expose && e.message ? e.message : friendly });
  });

  return app;
}
