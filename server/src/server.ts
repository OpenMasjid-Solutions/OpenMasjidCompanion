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
import { createHash } from 'node:crypto';
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
import { type Appearance, type LogoImage, clearSessionCache, fetchAppearance, fetchLogo, probePlatform, raiseAlert } from './fabric';
import { Cached, KEEP, loaded } from './cache';
import { getSite, refreshSite } from './site';
import { TimetableService, type TimetableState } from './timetableService';
import { Icons, type IconKind, THEME_HEX } from './icons';
import { buildManifest, installName } from './webmanifest';
import { parseChangelog, readChangelog } from './changelog';

const log = makeLog('server');

export interface ServerDeps {
  store: Store;
  /** Overridable so a test can drive the timetable without a broker or a timer. */
  timetable?: TimetableService;
  /** Where the built web app lives. Overridable so a test can point at a fixture, or at
   *  nowhere at all, without needing Vite to have run. */
  publicDir?: string;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { store } = deps;
  const publicDir = deps.publicDir ?? config.publicDir;
  // Built here rather than passed in, so one server owns one timetable. `index.ts` starts its
  // background refresh; a test drives it directly and never starts a timer.
  const timetable = deps.timetable ?? new TimetableService(store);
  // The icon set needs to know which timetable is chosen, because Display's logo hangs off it.
  // A getter rather than a value: the admin can change the timetable while the server runs.
  const icons = new Icons(store, () => timetable.chosenId);

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
  app.get('/api/app', async () => {
    const site = getSite();
    return {
      data: {
        name: 'OpenMasjid Companion',
        version: config.version,
        /** Running under OpenMasjidOS with the Fabric available. NOT "signed in" — the admin
         *  panel asks that separately, because conflating the two is what locks an admin out
         *  after a restore. */
        embedded: ssoConfigured(),
        /** This app's public address, or '' when it has not been shared over the tunnel. Live
         *  from the platform, not from the boot-time environment variable — the admin can turn
         *  sharing on without restarting anything. */
        publicUrl: site.publicUrl,
        /**
         * The base path the ROUTER is actually stripping, not the one the platform last
         * mentioned. They are the same in practice — adopting a new one is what sets it — but
         * the page builds every URL it fetches from this value, so it has to be told what will
         * actually route rather than what we intend to route next.
         */
        basePath: getBasePath(),
        /**
         * Can this app honestly offer to be installed and to send notifications?
         *
         * Both need a secure context, which means the tunnel. Over plain HTTP on the LAN the
         * service worker and the Push API do not exist at all, so a page that offered either
         * would be showing a button that cannot work. And the page IS still reachable on the
         * LAN — a kiosk or a hallway screen may be pointed at it — so the answer is to say so
         * plainly rather than to hide the page or to pretend.
         */
        /** What this app is called on a home screen. The install prompt names it, so a musalli
         *  is told they are adding their masjid rather than a piece of software. */
        installName: installName(store.get('app.name') ?? '', timetable.peek().feed?.masjidName ?? ''),
        remote: {
          configured: site.configured,
          enabled: site.enabled,
          /** A tunnel URL is https by construction. Computed here so the page keys off one
           *  boolean instead of re-deriving the rule in the browser. */
          secure: site.enabled && site.publicUrl.startsWith('https://'),
        },
      },
    };
  });

  // ── Appearance + logo, relayed from the platform ────────────────────────────
  // These go through us rather than being fetched by the page. See fabric.ts: our page is
  // HTTPS behind the tunnel and the platform is plain HTTP on the LAN, so a direct browser
  // fetch is mixed content and is blocked in the one place a musalli ever opens the app.
  //
  // Neither needs a rate limiter, and that is a property of the cache rather than an
  // oversight: the TTL and the in-flight dedupe together bound the OUTBOUND rate at one call
  // per TTL no matter how many phones ask, and serving the cached copy is a memory read. A
  // per-peer limiter here could only ever 429 a musalli's own logo.

  const appearanceCache = new Cached<Appearance>(async () => {
    const a = await fetchAppearance();
    return a ? loaded(a) : KEEP;
  }, 20_000);

  app.get('/api/public/appearance', async (_req, reply) => {
    const entry = await appearanceCache.get();
    if (!entry.value) return reply.code(503).send({ error: 'The dashboard is not reachable right now.' });
    reply.header('cache-control', 'public, max-age=15');
    return { data: entry.value };
  });

  const logoCache = new Cached<LogoImage | null>(async () => {
    const r = await fetchLogo();
    if (r === 'unavailable') return KEEP; // an outage is not an answer — keep what we had
    return loaded(r === 'none' ? null : r);
  }, 5 * 60_000);

  /**
   * The masjid's logo, re-served from our origin.
   *
   * A 404 here is a normal answer that the page is built to handle — most masjids will not
   * have set a logo, and the app falls back to its own mark. It is not an error state.
   *
   * The ETag is the point of this route rather than a nicety: this image is fetched by every
   * phone that opens the app, and a masjid logo is the largest single asset on the page. With
   * one, a returning musalli gets a 304 of a few dozen bytes.
   */
  app.get('/api/public/logo', async (req, reply) => {
    const entry = await logoCache.get();
    const logo = entry.value;
    if (!logo) return reply.code(404).send({ error: 'This masjid has not set a logo.' });

    const etag = `"${createHash('sha256').update(logo.body).digest('base64url').slice(0, 22)}"`;
    // max-age is short but the ETag does the real work: the logo can change the moment the
    // admin uploads a new one in OpenMasjidOS, and a long max-age would leave the old one on
    // every phone that had already loaded it, for as long as it lasted.
    reply.header('cache-control', 'public, max-age=300');
    reply.header('etag', etag);
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.type(logo.mime).send(logo.body);
  });

  // ── Admin: the state of the things this app depends on ──────────────────────

  /**
   * Everything the panel's Home screen reports. One call, because the alternative is a panel
   * that renders in four stages as four requests land.
   *
   * `remote` is the only section with anything in it at this version. Timetable freshness,
   * campaign health and the subscriber count join it as those features arrive.
   */
  app.get('/api/admin/status', { preHandler: requireAdmin }, async () => {
    const site = getSite();
    return {
      data: {
        // `peek`, not `get`: opening the panel must not block on a broker round trip, and the
        // background refresh keeps this warm anyway.
        timetable: summariseTimetable(timetable.peek()),
        pwa: {
          appName: store.get('app.name') ?? '',
          /** What will actually appear under the icon on a home screen. */
          effectiveName: installName(store.get('app.name') ?? '', timetable.peek().feed?.masjidName ?? ''),
          icon: icons.status(),
        },
        remote: {
          /** Is the Fabric there at all? A standalone install is not misconfigured, and must
           *  not be told to go and switch on something that does not exist for it. */
          configured: site.configured,
          /** Remote access is on AND this app is shared. The gate on everything musalli-facing
           *  that needs HTTPS: install, notifications, the QR code. */
          enabled: site.enabled,
          publicUrl: site.publicUrl,
          domain: site.domain,
          /** As in /api/app: the value in effect, so a panel showing it cannot disagree with
           *  the router about where this app answers. */
          basePath: getBasePath(),
          /** Did the last lookup reach the platform? Separate from `enabled`, because "remote
           *  access is off" and "we could not ask" are different problems with different
           *  fixes, and telling an admin the first when it is the second sends them to change
           *  a setting that was already correct. */
          reachable: site.ok,
          checkedAt: site.checkedAt,
        },
      },
    };
  });

  /** "Check again" — the admin has just turned Remote access on in another tab and is looking
   *  at this page waiting for it to notice. Without this they wait out the 5-minute poll and
   *  reasonably conclude it is broken. */
  app.post('/api/admin/site/refresh', { preHandler: requireAdmin }, async (req, reply) => {
    if (!platformCallOk(peerOf(req))) return reply.code(429).send({ error: 'Too many requests. Please try again shortly.' });
    const site = await refreshSite();
    return { data: { configured: site.configured, enabled: site.enabled, publicUrl: site.publicUrl, reachable: site.ok } };
  });

  /**
   * Send the declared `test` alert.
   *
   * This exists so an admin can find out that their alert routing works BEFORE the first real
   * alert needs it. An alert channel is only discovered to be misconfigured at the moment it
   * was needed, which is the worst possible moment — and the admin's routing choice lives in
   * OpenMasjidOS where we cannot read it, so this round trip is the only way either of us can
   * tell.
   */
  app.post('/api/admin/alert/test', { preHandler: requireAdmin }, async (req, reply) => {
    if (!platformCallOk(peerOf(req))) return reply.code(429).send({ error: 'Too many requests. Please try again shortly.' });
    const result = await raiseAlert('test', 'Test alert from OpenMasjid Companion.');
    return { data: { result } };
  });

  // ── The timetable ───────────────────────────────────────────────────────────

  /**
   * What a musalli's phone reads.
   *
   * Deliberately NOT the whole feed. `name` is the admin's private label for the timetable
   * ("Women's section", "Main hall") and is never shown on a Display screen either — putting it
   * on the public page would leak an internal note onto the noticeboard. `id` is equally not
   * theirs to know.
   *
   * The whole window goes over in one response rather than a day at a time: at Display's own
   * worst-case measurement the full 45 days is 18.5 KB, so a month of prayer times costs less
   * than one photograph, and the week and month views then need no further requests — which is
   * what makes them work offline in the slice that adds the service worker.
   */
  app.get('/api/public/timetable', async (req, reply) => {
    const state = await timetable.get();
    const feed = state.feed;

    const body = {
      configured: !!state.id,
      /** ms epoch of the last successful read from Display; 0 = never. The page turns this
       *  into "last updated …", and MUST show it when `stale` is true. */
      at: state.at,
      /** The times on screen are older than they should be and the last refresh failed. */
      stale: state.stale,
      masjid: feed
        ? {
            name: feed.masjidName,
            timezone: feed.timezone,
            language: feed.language,
            hourCycle: feed.hourCycle,
          }
        : null,
      days: feed?.days ?? [],
    };

    // A weak validator over the content, so a phone that reopens the app gets a 304 instead of
    // the month again. Keyed on the fetch time and the day count rather than hashing the body:
    // the payload only ever changes when one of those does.
    const etag = `W/"${state.at.toString(36)}-${body.days.length}-${state.stale ? 's' : 'f'}"`;
    reply.header('cache-control', 'public, max-age=60');
    reply.header('etag', etag);
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return { data: body };
  });

  /** The picker's list. Live from Display every time — an admin opening this screen is about to
   *  choose, and a cached list is how you pick a timetable that was deleted this morning. */
  app.get('/api/admin/timetables', { preHandler: requireAdmin }, async (req, reply) => {
    if (!platformCallOk(peerOf(req))) return reply.code(429).send({ error: 'Too many requests. Please try again shortly.' });
    const res = await timetable.list();
    if (!res.ok) {
      // 200 with a named reason, not an HTTP error: "Display isn't installed" is an ANSWER the
      // panel renders as a screen, and turning it into a 502 would make the panel show a
      // generic failure instead of the one sentence that tells the admin what to do.
      return { data: { ok: false, reason: res.failure.admin, code: res.failure.code, timetables: [] } };
    }
    return { data: { ok: true, reason: '', code: '', timetables: res.data.timetables, chosen: timetable.chosenId } };
  });

  /** Choose one. The id is a non-secret and is the only thing about the choice we persist. */
  const ChooseBody = z.object({ id: z.string().min(1).max(200) });
  app.post('/api/admin/timetable', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = ChooseBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Please choose a timetable.' });
    timetable.setChosen(parsed.data.id);
    // A different timetable may carry a different masjid's logo, so the icon is no longer
    // necessarily right. Not awaited: the admin should not wait on a re-derive to see the times.
    void icons.invalidate();
    // Fetch it straight away so the panel can show the admin what they just picked, and so a
    // wrong choice is visible immediately rather than at the next poll.
    const state = await timetable.get();
    return { data: summariseTimetable(state) };
  });

  /** "Refresh now" — an Iqamah was changed in Display and the admin wants it on phones today. */
  app.post('/api/admin/timetable/refresh', { preHandler: requireAdmin }, async (req, reply) => {
    if (!platformCallOk(peerOf(req))) return reply.code(429).send({ error: 'Too many requests. Please try again shortly.' });
    return { data: summariseTimetable(await timetable.refresh()) };
  });

  // ── The PWA: manifest, icons, service worker ────────────────────────────────

  /**
   * The web manifest, generated per request.
   *
   * Never a static file: the name is a setting, `start_url`/`scope` are the tunnel path the
   * admin chose and can rename, and the language follows the masjid's timetable. A static one
   * would be wrong for every masjid but the first.
   *
   * Deliberately NOT cached hard. Renaming the app or changing the icon should reach a phone
   * that reinstalls, and a manifest is fetched once at install — there is nothing to save here.
   */
  app.get('/manifest.webmanifest', async (_req, reply) => {
    const feed = timetable.peek().feed;
    const manifest = buildManifest({
      appName: store.get('app.name') ?? '',
      masjidName: feed?.masjidName ?? '',
      basePath: getBasePath(),
      lang: feed?.language ?? 'en',
      theme: THEME_HEX,
      background: THEME_HEX,
    });
    reply.header('cache-control', 'no-cache');
    reply.type('application/manifest+json');
    return manifest;
  });

  const ICON_ROUTES: Record<string, IconKind> = {
    '192.png': 'icon-192',
    '512.png': 'icon-512',
    'maskable.png': 'maskable-512',
  };

  /**
   * The derived icons.
   *
   * Cached by ETag rather than by time: the icon changes when the masjid changes their logo,
   * which is rare but must not take a day to appear. The bytes are already on disk, so a
   * revalidation costs a hash and a 304.
   */
  app.get<{ Params: { name: string } }>('/api/public/icon/:name', async (req, reply) => {
    const kind = ICON_ROUTES[req.params.name];
    if (!kind) return reply.code(404).send({ error: 'Not found.' });
    const body = await icons.read(kind);
    if (!body) return reply.code(404).send({ error: 'No icon is available.' });

    const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 22)}"`;
    reply.header('cache-control', 'public, max-age=3600');
    reply.header('etag', etag);
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.type('image/png').send(body);
  });

  /**
   * The service worker.
   *
   * Served from THIS path — `<basePath>/sw.js` as the browser sees it — which is what makes the
   * scope correct with no `Service-Worker-Allowed` header games. That is the payoff of
   * stripping the prefix before routing.
   *
   * `no-cache` is not optional: a service worker cached by the browser is a service worker that
   * cannot be replaced, and this one holds the app's shell. Getting it wrong pins a stale build
   * on a phone with no way to fix it remotely.
   */
  const swTemplate = (() => {
    for (const p of [path.join(publicDir, 'sw.tmpl'), path.resolve(__dirname, '..', '..', 'web', 'public', 'sw.tmpl')]) {
      try {
        return fs.readFileSync(p, 'utf8');
      } catch {
        /* try the next */
      }
    }
    log.warn('no sw.tmpl found — the app will not work offline');
    return '';
  })();

  app.get('/sw.js', async (_req, reply) => {
    if (!swTemplate) return reply.code(404).send({ error: 'Not found.' });
    reply.header('cache-control', 'no-cache');
    reply.header('service-worker-allowed', getBasePath() + '/');
    return reply
      .type('text/javascript')
      .send(swTemplate.split('__VERSION__').join(config.version).split('__BASE__').join(getBasePath()));
  });

  // ── Admin: the app's name and icon ──────────────────────────────────────────

  /** PNG only, and larger than the global body limit — a 1024px logo is legitimately a few
   *  hundred KB. Parsed as a raw buffer: the bytes are validated from their magic numbers and
   *  re-encoded, so nothing here is trusted because of what it claimed to be. */
  app.addContentTypeParser('image/png', { parseAs: 'buffer', bodyLimit: 4 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.post('/api/admin/icon', { preHandler: requireAdmin, bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: 'Please choose a PNG image.' });
    }
    const res = await icons.setUpload(body);
    if (!res.ok) return reply.code(400).send({ error: res.error });
    return { data: icons.status() };
  });

  /** Go back to the automatic chain: the timetable's logo, then the platform's, then ours. */
  app.post('/api/admin/icon/reset', { preHandler: requireAdmin }, async () => {
    await icons.clearUpload();
    return { data: icons.status() };
  });

  /**
   * The name under the icon.
   *
   * Empty means "follow the masjid name from the timetable", which is the right default and the
   * reason this is not simply pre-filled with it — a masjid that renames itself in Display
   * should not have to remember to rename it here too.
   */
  const NameBody = z.object({ name: z.string().max(60) });
  app.post('/api/admin/appname', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = NameBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'That name is too long — 60 characters at most.' });
    const name = parsed.data.name.trim();
    if (name) store.set('app.name', name);
    else store.del('app.name');
    return { data: { appName: name, effective: installName(name, timetable.peek().feed?.masjidName ?? '') } };
  });

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

/**
 * What the ADMIN panel is told about the timetable.
 *
 * Carries `name` (the admin's own private label — this is the one place it belongs) and the
 * failure in plain words. Never the days: the panel shows a preview from the public route like
 * everyone else, so there is one code path producing prayer times, not two.
 */
function summariseTimetable(state: TimetableState) {
  return {
    id: state.id,
    name: state.feed?.name ?? '',
    masjidName: state.feed?.masjidName ?? '',
    timezone: state.feed?.timezone ?? '',
    days: state.feed?.days.length ?? 0,
    at: state.at,
    stale: state.stale,
    /** Present only when the last attempt failed. Already plain English — see fabric.ts. */
    problem: state.failure ? { code: state.failure.code, message: state.failure.admin, retryable: state.failure.retryable } : null,
  };
}
