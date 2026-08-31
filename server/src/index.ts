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
import { buildServer, makePush } from './server';
import { startSitePolling, stopSitePolling } from './site';
import { TimetableService } from './timetableService';

const log = makeLog('main');

async function main(): Promise<void> {
  const store = new Store();
  const timetable = new TimetableService(store);
  const push = makePush(store, timetable);
  const app = await buildServer({ store, timetable, push });

  // Find out where we live, and keep finding out. The admin can turn Remote access on, share
  // this app, or rename its path at any moment, and none of those restart the container. Started
  // BEFORE listen so the first request already has the boot-time base path applied — see site.ts.
  startSitePolling();

  // Keep the masjid's prayer times warm in the background, so a phone opening the app reads a
  // cache rather than waiting on a broker round trip to Display.
  timetable.start();

  // Prayer notifications. Started after the timetable, because a scheduler with no times to
  // work from has nothing to do — and it refuses to send from stale data anyway, so the
  // ordering is belt and braces rather than load-bearing.
  push.scheduler.start();

  await app.listen({ port: config.port, host: config.host });
  log.info(`OpenMasjid Companion ${config.version} listening on http://${config.host}:${config.port}`);
  log.info(ssoConfigured() ? 'running embedded under OpenMasjidOS (Fabric available)' : 'running standalone (no Fabric)');

  const shutdown = (code = 0) => {
    log.info('shutting down');
    timetable.stop();
    push.scheduler.stop();
    stopSitePolling();
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
