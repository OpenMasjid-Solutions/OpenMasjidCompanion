// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Where this app thinks it lives.
 *
 * The failure these guard against is the nastiest shape a bug in this app can take: it works
 * perfectly on the LAN, where every developer and every admin tests it, and 404s for every
 * musalli outside the building. Nobody who can see the problem is in a position to notice it,
 * and nobody who notices it can describe it.
 *
 * The single most important case here is the LAST one — that losing contact with the platform
 * does NOT drop the base path. Getting that wrong turns a five-second core restart into the app
 * disappearing from the internet, which is a strictly worse outage than the one it reacts to.
 */
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

/** Load site.ts (and the modules it shares state with) fresh, under a given environment.
 *
 *  config.ts reads the environment ONCE at import — deliberately, because that is how the real
 *  process behaves — so a scenario is a module reload, not a setter. */
function load(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  for (const m of ['./config', './fabric', './basePath', './site']) delete require.cache[require.resolve(m)];
  return {
    site: require('./site') as typeof import('./site'),
    basePath: require('./basePath') as typeof import('./basePath'),
    fabric: require('./fabric') as typeof import('./fabric'),
  };
}

const EMBEDDED = { OPENMASJID_BASE_URL: 'http://127.0.0.1:9', OPENMASJID_APP_SECRET: 's3cret' };
const STANDALONE = { OPENMASJID_BASE_URL: '', OPENMASJID_APP_SECRET: '' };

afterEach(() => {
  for (const k of ['OPENMASJID_BASE_URL', 'OPENMASJID_APP_SECRET', 'OPENMASJID_PUBLIC_URL']) delete process.env[k];
  for (const m of ['./config', './fabric', './basePath', './site']) delete require.cache[require.resolve(m)];
});

// ── The boot-time guess ───────────────────────────────────────────────────────

test('the base path is derived from OPENMASJID_PUBLIC_URL before the Fabric answers anything', () => {
  // Without this there is a window from process start to the first successful site lookup in
  // which every tunnelled request 404s. Seconds normally — unbounded when a masjid reboots the
  // box and the core takes its time coming back.
  const { site } = load({ ...EMBEDDED, OPENMASJID_PUBLIC_URL: 'https://omos.example.org/companion' });
  assert.equal(site.getSite().basePath, '/companion');
});

test('the boot-time base path is applied to the router immediately, not just recorded', () => {
  const { site, basePath } = load({ ...EMBEDDED, OPENMASJID_PUBLIC_URL: 'https://omos.example.org/companion' });
  assert.equal(basePath.getBasePath(), '/companion', 'importing site.ts must wire it up');
  assert.equal(basePath.stripBasePath('/companion/api/app', basePath.getBasePath()), '/api/app');
  assert.equal(site.getSite().publicUrl, 'https://omos.example.org/companion');
});

test('an app served at the root of the tunnel gets an empty base path, not "/"', () => {
  const { basePath } = load({ ...EMBEDDED, OPENMASJID_PUBLIC_URL: 'https://omos.example.org/' });
  assert.equal(basePath.getBasePath(), '');
});

test('basePathFromPublicUrl handles the shapes the platform can actually produce', () => {
  const { site } = load(STANDALONE);
  const f = site.basePathFromPublicUrl;
  assert.equal(f(''), '', 'not shared yet');
  assert.equal(f('https://omos.example.org'), '');
  assert.equal(f('https://omos.example.org/'), '');
  assert.equal(f('https://omos.example.org/companion'), '/companion');
  assert.equal(f('https://omos.example.org/companion/'), '/companion', 'a trailing slash is not part of the prefix');
  assert.equal(f('https://omos.example.org/apps/companion'), '/apps/companion', 'nested paths are legitimate');
  assert.equal(f('not a url'), '', 'garbage must not throw — it would take the boot with it');
});

// ── Normalising what the platform sent ────────────────────────────────────────

test('enabled requires a real public URL, not just the platform saying remote access is on', () => {
  // Remote access being on is about the TUNNEL. An app the admin never ticked "share" for still
  // has no address — and `enabled` is what gates the QR code, so a true here prints a poster
  // pointing at nothing.
  const { fabric } = load(STANDALONE);
  assert.equal(fabric.normaliseSite({ enabled: true, publicUrl: '' }).enabled, false);
  assert.equal(fabric.normaliseSite({ enabled: true, publicUrl: 'https://omos.example.org/companion' }).enabled, true);
  assert.equal(fabric.normaliseSite({ enabled: false, publicUrl: 'https://omos.example.org/companion' }).enabled, false);
});

test('a public URL that is not plainly http(s) is dropped rather than carried', () => {
  // This value ends up on a printed QR code and as a push notification's origin. '' produces an
  // honest "not shared yet"; a javascript: or file: URL produces something worse.
  const { fabric } = load(STANDALONE);
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://example.org', 'omos.example.org', '', null, 42]) {
    assert.equal(fabric.normaliseSite({ enabled: true, publicUrl: bad }).publicUrl, '', `${String(bad)} should be dropped`);
  }
  assert.equal(fabric.normaliseSite({ publicUrl: 'https://a.example.org/x/' }).publicUrl, 'https://a.example.org/x');
});

test('the base path from the platform is normalised the same way as the boot-time one', () => {
  const { fabric } = load(STANDALONE);
  assert.equal(fabric.normaliseSite({ basePath: 'companion' }).basePath, '/companion');
  assert.equal(fabric.normaliseSite({ basePath: '/companion/' }).basePath, '/companion');
  assert.equal(fabric.normaliseSite({ basePath: '/' }).basePath, '');
  assert.equal(fabric.normaliseSite({}).basePath, '');
});

// ── Adopting, and refusing to un-adopt ────────────────────────────────────────

test('a successful lookup adopts the platform base path and applies it to the router', async () => {
  const { site, basePath } = load(EMBEDDED);
  await site.refreshSite(async () => ({ enabled: true, domain: 'omos.example.org', publicUrl: 'https://omos.example.org/prayer', basePath: '/prayer' }));

  assert.equal(basePath.getBasePath(), '/prayer');
  const s = site.getSite();
  assert.equal(s.enabled, true);
  assert.equal(s.ok, true);
  assert.ok(s.checkedAt > 0, 'a successful lookup stamps when we last heard');
});

test('the admin renaming the path is picked up on the next poll', async () => {
  const { site, basePath } = load(EMBEDDED);
  await site.refreshSite(async () => ({ enabled: true, domain: 'd', publicUrl: 'https://d/companion', basePath: '/companion' }));
  assert.equal(basePath.getBasePath(), '/companion');
  await site.refreshSite(async () => ({ enabled: true, domain: 'd', publicUrl: 'https://d/salah', basePath: '/salah' }));
  assert.equal(basePath.getBasePath(), '/salah', 'the base path is live, not read once at boot');
});

test('A FAILED LOOKUP CHANGES NOTHING — the app stays on the internet while the core restarts', async () => {
  // The whole point of the module. The tunnel is Cloudflare's and this container is ours; both
  // keep working perfectly while the OpenMasjidOS core is restarting. Treating "cannot reach the
  // core" as "no remote access" would strip the base path and 404 every musalli for the
  // duration — converting a platform hiccup into an outage of the only thing they use.
  const { site, basePath } = load(EMBEDDED);
  await site.refreshSite(async () => ({ enabled: true, domain: 'omos.example.org', publicUrl: 'https://omos.example.org/companion', basePath: '/companion' }));
  const good = site.getSite();

  await site.refreshSite(async () => null); // the core is down

  const after = site.getSite();
  assert.equal(basePath.getBasePath(), '/companion', 'the router must keep stripping the prefix');
  assert.equal(after.basePath, '/companion');
  assert.equal(after.publicUrl, good.publicUrl, 'the QR code still points somewhere real');
  assert.equal(after.enabled, true, 'remote access did not turn itself off');
  assert.equal(after.checkedAt, good.checkedAt, 'but we do not pretend we just heard from it');
  assert.equal(after.ok, false, 'and the panel can say the platform is unreachable right now');
});

test('a standalone install reports "not configured" rather than "misconfigured"', async () => {
  // There is nothing wrong with a standalone install, and an admin must not be sent to switch on
  // a Remote access setting that does not exist for them.
  const { site } = load(STANDALONE);
  const s = await site.refreshSite(async () => {
    throw new Error('must not be called when there is no Fabric');
  });
  assert.equal(s.configured, false);
  assert.equal(s.enabled, false);
  assert.equal(s.ok, false);
});

// ── Where our secret is allowed to go in cleartext ────────────────────────────

test('a LAN or container address is recognised as private, so a normal install logs no warning', () => {
  // A security warning that fires on every ordinary install is worse than no warning: it is the
  // one a masjid learns to scroll past, and then the real one arrives and looks the same.
  const { fabric } = load(STANDALONE);
  for (const host of [
    'localhost',
    '127.0.0.1',
    '127.1.2.3',
    '10.0.0.5',
    '192.168.1.20',
    '172.16.0.1',
    '172.31.255.254',
    '169.254.10.1',
    '::1',
    '[::1]',
    'fd00::1',
    'fe80::1',
    'omos.local',
    'pi.lan',
    'host.docker.internal', // what Docker hands a container reaching its host
    'omos-core', // a bare container name on a Docker network
    'raspberrypi',
  ]) {
    assert.equal(fabric.isPrivateHost(host), true, `${host} should count as private`);
  }
});

test('a genuinely public host is NOT treated as private — that warning has to still fire', () => {
  const { fabric } = load(STANDALONE);
  for (const host of [
    'example.org',
    'omos.example.org',
    '8.8.8.8',
    '172.32.0.1', // just outside 172.16/12 — the boundary worth pinning
    '172.15.255.255',
    '11.0.0.1', // just outside 10/8
    '192.169.0.1', // just outside 192.168/16
    '2606:4700::1111',
  ]) {
    assert.equal(fabric.isPrivateHost(host), false, `${host} should NOT count as private`);
  }
});
