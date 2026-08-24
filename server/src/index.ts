// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Entry point. Opens the data volume, builds the server (server.ts), listens, and stops
 * tidily on a signal. Everything that answers a request lives in server.ts, so this file
 * stays the one place that knows about processes and ports.
 */
import { config, ssoConfigured } from './config';
import { makeLog } from './logger';
import { Store } from './store';
import { buildServer } from './server';
import { startSitePolling } from './site';

const log = makeLog('main');

async function main(): Promise<void> {
  const store = new Store();
  const app = await buildServer({ store });

  // Find out where we live, and keep finding out. The admin can turn Remote access on, share
  // this app, or rename its path at any moment, and none of those restart the container. Started
  // BEFORE listen so the first request already has the boot-time base path applied — see site.ts.
  startSitePolling();

  await app.listen({ port: config.port, host: config.host });
  log.info(`OpenMasjid Companion ${config.version} listening on http://${config.host}:${config.port}`);
  log.info(ssoConfigured() ? 'running embedded under OpenMasjidOS (Fabric available)' : 'running standalone (no Fabric)');
  if (config.devStub) {
    // Loud, every boot. This is the only state in which the app can show a prayer time
    // that did not come from Display, and a masjid must never be in it by accident.
    log.warn('COMPANION_DEV_STUB=1 — prayer times may come from the DEVELOPMENT STUB, not from OpenMasjid Display. Never set this on a real masjid box.');
  }

  const shutdown = (code = 0) => {
    log.info('shutting down');
    store.close();
    app.close().finally(() => setTimeout(() => process.exit(code), 200));
    // Hard backstop in case close() hangs, so the container actually cycles.
    setTimeout(() => process.exit(code), 2000).unref?.();
  };
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
}

main().catch((err) => {
  log.error('failed to start', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
