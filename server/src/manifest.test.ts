// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * manifest.yaml and docker-compose.yml are not documentation — they are what the catalog
 * publishes and what every masjid's OpenMasjidOS actually installs. Several of the ways
 * they can be wrong are completely silent: the app builds, boots, and looks fine, while
 * a capability the code depends on was never granted, or the dev channel keeps installing
 * last week's image.
 *
 * Every assertion here corresponds to a specific failure that has really happened
 * somewhere in this family of apps:
 *
 *  - An `${OPENMASJID_*}` var missing from compose `environment:` → the platform writes
 *    it into the app's .env, compose substitutes nothing, and single sign-on silently
 *    no-ops. This left OpenMasjid Display's SSO dead for several releases.
 *  - A compose image tag that has drifted from the manifest version → the dev channel
 *    installs a build that is not this commit, while looking perfectly healthy.
 *  - A capability documented but not declared → a 403 on a masjid's box, discovered by
 *    the masjid.
 *
 * CI's `channel` job asserts some of this too. It is duplicated here on purpose: CI runs
 * on a push, and this runs in the two seconds before one.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

const REPO = path.resolve(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const manifest = parse(read('manifest.yaml')) as Record<string, unknown>;
const compose = parse(read('docker-compose.yml')) as {
  services: Record<string, { image?: string; environment?: Record<string, string>; ports?: string[] }>;
  volumes?: Record<string, unknown>;
};

/** Every service's image reference, because one un-updated line in a multi-service
 *  compose is the whole bug class these checks exist to stop. */
const images = Object.values(compose.services).map((s) => String(s.image ?? ''));

test('identity: the manifest says what the rest of the family expects it to say', () => {
  assert.equal(manifest.id, 'companion', 'the id is the compose project, the registry id and the broker caller id');
  assert.equal(manifest.name, 'OpenMasjid Companion');
  assert.equal(manifest.category, 'community');
  assert.equal(manifest.author, 'OpenMasjid-Solutions');
  assert.equal(manifest.license, 'AGPL-3.0-only');
  assert.equal(manifest.icon, 'icon.png');
  assert.deepEqual(manifest.screenshots, ['screenshots/1.svg']);
  assert.match(String(manifest.id), /^[a-z0-9][a-z0-9-]{0,79}$/, 'the catalog requires kebab-case');
});

test('the version is the same string in the manifest, both package.jsons and the compose tag', () => {
  // Four places, and the platform detects an update by comparing exactly one of them
  // (the manifest's, via the catalog) against what is installed. A drift between them
  // means the dev channel installs something other than this commit.
  const version = String(manifest.version);
  assert.match(version, /^\d+\.\d+\.\d+(-dev\.\d+)?$/, `"${version}" is not X.Y.Z or X.Y.Z-dev.N`);

  for (const rel of ['server/package.json', 'web/package.json']) {
    const pkg = JSON.parse(read(rel)) as { version?: string };
    assert.equal(pkg.version, version, `${rel} version must match manifest.yaml`);
  }

  for (const img of images) {
    const tag = img.split('/').pop()!.split(':')[1]?.split('@')[0] ?? '';
    assert.equal(tag, version, `compose image "${img}" must reference the version this build publishes`);
  }
});

test('the image is the GHCR name the catalog and CI both derive from the repo', () => {
  // CI builds `ghcr.io/<owner-lowercased>/<repo-lowercased>`. Anything else here would
  // publish to one place and install from another.
  for (const img of images) {
    assert.ok(
      img.startsWith('ghcr.io/openmasjid-solutions/openmasjidcompanion:'),
      `compose image "${img}" is not the name CI publishes`,
    );
  }
});

test('the dev channel pins an exact tag, never the moving :dev alias', () => {
  // A moving tag republishes new content under an unchanged reference, which the platform
  // cannot detect as an update at all — nothing to notify, nothing to update to.
  for (const img of images) {
    const tag = img.split('/').pop()!.split(':')[1]?.split('@')[0] ?? '';
    assert.notEqual(tag, 'dev', `compose image "${img}" pins the moving :dev tag`);
  }
});

test('compose references EVERY injected Fabric variable, or it never reaches the container', () => {
  // "Made available" does not mean "set on your container". The platform writes the app's
  // .env and runs `docker compose --env-file`, which only powers ${VAR} SUBSTITUTION — so
  // a var not named here is simply absent inside, and every Fabric call silently no-ops
  // with nothing anywhere saying why.
  const env = compose.services.app?.environment ?? {};
  for (const key of ['OPENMASJID_BASE_URL', 'OPENMASJID_APP_ID', 'OPENMASJID_APP_SECRET', 'OPENMASJID_PUBLIC_URL']) {
    assert.ok(key in env, `docker-compose.yml environment: is missing ${key}`);
    assert.match(
      String(env[key]),
      new RegExp(`^\\$\\{${key}:-\\}$`),
      `${key} must be "\${${key}:-}" — the empty default is what keeps a standalone \`docker compose up\` quiet`,
    );
  }
});

test('every environment variable the code reads from the platform is wired in compose', () => {
  // The check above names the four by hand. This one comes at it from the other side:
  // anything config.ts reads with an OPENMASJID_ prefix must be in the compose, so adding
  // a fifth to the code cannot silently skip the wiring.
  const src = read('server/src/config.ts');
  const wanted = new Set([...src.matchAll(/env\('(OPENMASJID_[A-Z_]+)'/g)].map((m) => m[1]));
  const env = compose.services.app?.environment ?? {};
  const missing = [...wanted].filter((k) => !(k in env));
  assert.deepEqual(missing, [], `config.ts reads these but docker-compose.yml never passes them: ${missing.join(', ')}`);
});

test('the capabilities declared are exactly the ones this app uses', () => {
  assert.equal(manifest.sso, true, 'the admin panel signs in with the dashboard login');
  assert.equal(manifest.domain, true, 'the webmanifest, the QR and the push origin all need our public URL');
  assert.equal(manifest.tunnel, true, "an installable PWA reached by QR code has no meaning without it");
  assert.deepEqual(manifest.fabric, { consumes: ['display/timetable'] });
});

test('the deliberate ABSENCES are still absent — each one is load-bearing', () => {
  // `https:` is reserved by the platform for apps that take card payments and need a
  // browser secure context. This app takes none; its HTTPS comes from the tunnel.
  assert.equal('https' in manifest, false, 'https: is for Stripe apps only — a hard platform rule');
  // This app never touches money. If any of these appear, something has gone badly wrong.
  assert.equal('stripe' in manifest, false, 'this app never takes a payment');
  // No install dialog beyond the tunnel checkbox the platform itself shows.
  assert.equal('settings' in manifest, false, 'install stays one-click; everything is chosen inside the app');
  // v1 serves NO inbound /fabric/* surface at all, so no such route exists to get wrong.
  assert.equal('provides' in (manifest.fabric as object), false, 'this app provides no capability in v1');
  assert.equal('commands' in manifest, false);
  assert.equal('email' in manifest, false);
  assert.equal('whatsapp' in manifest, false);
});

test('every alert id is declared, kebab-case, and carries wording an admin can act on', () => {
  const alerts = manifest.alerts as { id: string; label: string; description?: string }[];
  assert.deepEqual(
    alerts.map((a) => a.id).sort(),
    ['push-failing', 'test', 'timetable-unavailable'],
    'changing this set is a contract change — the platform only accepts a DECLARED id',
  );
  for (const a of alerts) {
    assert.match(a.id, /^[a-z0-9][a-z0-9-]*$/, `alert id "${a.id}" must be kebab-case`);
    assert.ok(a.label && a.label.length <= 80, `alert "${a.id}" needs a short label`);
    assert.ok(a.description && a.description.length > 40, `alert "${a.id}" needs a description that says what to do about it`);
  }
});

test('the compose is least-privilege, and stays that way', () => {
  const svc = compose.services.app as Record<string, unknown>;
  // The catalog build and the platform's install-time consent gate both refuse these, so
  // an app that grows one simply stops installing anywhere — a failure a masjid finds.
  for (const forbidden of ['privileged', 'network_mode', 'pid', 'ipc', 'userns_mode', 'cgroup', 'uts', 'cap_add', 'devices', 'device_cgroup_rules', 'volumes_from', 'extends', 'build', 'env_file']) {
    assert.equal(forbidden in svc, false, `docker-compose.yml must not use "${forbidden}"`);
  }
  assert.deepEqual(svc.cap_drop, ['ALL']);
  assert.deepEqual(svc.security_opt, ['no-new-privileges:true']);
  assert.deepEqual(svc.tmpfs, ['/tmp']);
  // Non-root + read-only rootfs from day one. The sibling apps both record NOT having
  // this as a known gap; a new app has no upgrade path to protect, so it starts with it.
  assert.equal(svc.user, '1000:1000');
  assert.equal(svc.read_only, true);
  // A named volume, never a host bind — "a listed app owns its storage".
  assert.deepEqual(svc.volumes, ['data:/data']);
  assert.ok(compose.volumes && 'data' in compose.volumes);
});

test('the published port is a sensible default above 1024, and nothing depends on it', () => {
  // OpenMasjidOS offers "Open" on the lowest published port and remaps automatically if
  // the host port is taken — so this is a default, not a contract.
  const ports = compose.services.app?.ports ?? [];
  assert.deepEqual(ports, ['7880:8080']);
  const container = Number(String(ports[0]).split(':')[1]);
  const declared = (manifest.ports as { container: number }[])[0];
  assert.equal(declared.container, container, 'manifest.yaml ports: must name the CONTAINER port compose publishes');
  assert.ok(Number(String(ports[0]).split(':')[0]) >= 1024, 'a privileged host port would need capabilities this app drops');
});

test('the Dockerfile creates the data directory owned by the same user the compose runs as', () => {
  // This is the pairing that makes read_only + non-root work at all: Docker copies the
  // ownership of the IMAGE's directory onto a fresh named volume mounted over it. Get it
  // wrong and the volume comes up root-owned and the app cannot open its own database —
  // on a masjid's box, on first boot, with no way to fix it from the dashboard.
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /chown -R 1000:1000 \/data/, 'the Dockerfile must chown /data to the runtime user');
  assert.match(dockerfile, /^USER 1000:1000$/m, 'the image must drop to the unprivileged user');
});
