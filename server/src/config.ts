// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Environment configuration, read ONCE per process start.
 *
 * RESTORE / MIGRATION RESILIENCE — required of every Fabric app, and the reason this is
 * a module-level constant rather than something cached on disk. `OPENMASJID_BASE_URL`,
 * `OPENMASJID_APP_SECRET` and `OPENMASJID_PUBLIC_URL` are rewritten by the platform when
 * a backup is restored onto a different machine, when the admin changes their domain,
 * and when a secret is rotated. A persisted copy would point at the old box and quietly
 * break sign-in, the timetable feed and every link on the poster at the same time.
 *
 * So: read from the environment at boot, never written to /data, never logged.
 *
 * `manifest.yaml` declares NO `settings:`, so nothing here is an install-time question.
 * Everything a masjid chooses is chosen inside the app and saved to the data volume.
 */
import fs from 'node:fs';
import path from 'node:path';

function env(name: string, def = ''): string {
  const v = process.env[name];
  return v == null || v === '' ? def : v;
}
function intEnv(name: string, def: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? n : def;
}

/** Read this app's version from the package.json shipped next to the runtime (copied to
 *  /app/package.json in the image). Falls back gracefully in dev. */
function readVersion(): string {
  for (const p of [path.join(process.cwd(), 'package.json'), path.join(__dirname, '..', 'package.json')]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8')) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      /* try next */
    }
  }
  return '0.0.0';
}

export const config = {
  port: intEnv('PORT', 8080),
  /** Bind all interfaces so the LAN (and Docker's port mapping) can reach us. */
  host: env('HOST', '0.0.0.0'),
  dataDir: env('DATA_DIR', path.resolve(process.cwd(), 'data')),
  publicDir: env('PUBLIC_DIR', path.resolve(__dirname, '..', 'public')),
  version: readVersion(),

  /** The platform's address. Set ONLY by the platform — never let anything else set it;
   *  it is where we forward the admin's session cookie and present our secret. */
  omosBaseUrl: env('OPENMASJID_BASE_URL', '').replace(/\/+$/, ''),
  omosAppId: env('OPENMASJID_APP_ID', ''),
  /** Per-app secret issued by the platform. A CREDENTIAL: never logged, never persisted,
   *  never sent to a browser. It authenticates us to /api/auth/session, /api/fabric/site,
   *  /api/fabric/alert and the app-to-app broker. */
  omosAppSecret: env('OPENMASJID_APP_SECRET', ''),
  /** Convenience mirror of this app's public address, injected empty when the admin has
   *  not shared the app over the tunnel. GET /api/fabric/site is the LIVE source of
   *  truth; this is what we have before the first successful fetch. Never persisted. */
  omosPublicUrl: env('OPENMASJID_PUBLIC_URL', '').replace(/\/+$/, ''),
};

/** True when the app is running embedded under OpenMasjidOS with the Fabric available.
 *  Both halves are needed: a base URL with no secret authenticates nothing, and a secret
 *  with no base URL has nowhere to go. */
export function ssoConfigured(): boolean {
  return !!config.omosBaseUrl && !!config.omosAppSecret;
}

export type Config = typeof config;
