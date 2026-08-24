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
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import { config, ssoConfigured } from './config';
import { makeLog } from './logger';
import type { Store } from './store';
import { getBasePath, injectBase, stripBasePath } from './basePath';

const log = makeLog('server');

export interface ServerDeps {
  store: Store;
  /** Where the built web app lives. Overridable so a test can point at a fixture, or at
   *  nowhere at all, without needing Vite to have run. */
  publicDir?: string;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
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

  // ── Health check ────────────────────────────────────────────────────────────
  app.get('/healthz', async () => ({ ok: true }));

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
