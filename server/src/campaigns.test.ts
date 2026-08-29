// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Appeals: the link an admin pastes, and what happens when the app on the other end misbehaves.
 *
 * Two things here are worth more than the rest of the file:
 *
 *  - **"Gone" and "could not ask" must never collapse into each other.** A Donations container
 *    restarting while one phone happens to open the app must not delete a masjid's Ramadan
 *    appeal from the noticeboard, and a genuinely deleted appeal must not linger for ever.
 *  - **Cross-app content is untrusted content.** The payload is written by another app, which
 *    is not the same as being written by us, and an image URL that ends up in a `src` is the
 *    obvious way that matters.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Problem, Campaigns, describeProblem, fetchCampaign, isLocalOnly, parseShareLink, problemDetail, safeImage } from './campaigns';
import { Store } from './store';

// ── The pasted link ──────────────────────────────────────────────────────────

const ok = (raw: string) => {
  const r = parseShareLink(raw);
  assert.ok(r.ok, `expected ${raw} to parse: ${r.ok ? '' : r.error}`);
  return r.link;
};

test('a Donations share link becomes a base and a slug', () => {
  // What the "Copy link" button in the Donations admin actually produces: the donor page.
  assert.deepEqual(ok('https://omos.example.org/donations/ramadan'), {
    base: 'https://omos.example.org/donations',
    slug: 'ramadan',
  });
});

test('THE DONATIONS PREFIX IS NEVER ASSUMED to be "/donations"', () => {
  // The admin names the tunnel path, and a masjid that called it "give" would otherwise have
  // every appeal 404 with nothing explaining why.
  assert.deepEqual(ok('https://omos.example.org/give/roof'), { base: 'https://omos.example.org/give', slug: 'roof' });
  assert.deepEqual(ok('https://give.masjid.org/roof'), { base: 'https://give.masjid.org', slug: 'roof' });
  assert.deepEqual(ok('https://omos.example.org/apps/donations/roof'), {
    base: 'https://omos.example.org/apps/donations',
    slug: 'roof',
  });
});

test('a trailing slash, spaces and a query string do not change the appeal', () => {
  assert.deepEqual(ok('  https://omos.example.org/donations/ramadan/  ').slug, 'ramadan');
  assert.deepEqual(ok('https://omos.example.org/donations/ramadan?utm_source=whatsapp').slug, 'ramadan');
  assert.deepEqual(ok('https://omos.example.org/donations/ramadan#give').slug, 'ramadan');
});

test('PLAIN HTTP IS REFUSED ON A PUBLIC HOST, and the message says why', () => {
  // Not pedantry: this app is served over the tunnel as HTTPS, and a browser blocks an http
  // link from it as mixed content. "Invalid link" would send an admin looking for a typo.
  const r = parseShareLink('http://give.masjid.org/ramadan');
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.error, /https/);
  assert.match(r.ok ? '' : r.error, /phones|internet/i);
});

test('a private address is allowed through, and flagged as inside-the-building only', () => {
  // A masjid testing on their own LAN is doing something reasonable. It just does not work for
  // anybody outside, so it is reported rather than blocked or silently accepted.
  const link = ok('http://192.168.1.20:7881/donations/ramadan');
  assert.equal(link.base, 'http://192.168.1.20:7881/donations');
  assert.equal(isLocalOnly(link), true);
  assert.equal(isLocalOnly(ok('https://omos.example.org/donations/ramadan')), false);
});

test('a link with a sign-in built into it is refused', () => {
  // Forwarding it would send someone's credential to whatever host the link named.
  const r = parseShareLink('https://user:pass@omos.example.org/donations/ramadan');
  assert.equal(r.ok, false);
});

test('the Donations app’s own address is not an appeal', () => {
  const r = parseShareLink('https://omos.example.org/');
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.error, /appeal/i);
});

test('nonsense is refused rather than fetched', () => {
  for (const bad of ['', '   ', 'ramadan', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x']) {
    assert.equal(parseShareLink(bad).ok, false, `${bad} should not parse`);
  }
});

// ── Untrusted content ────────────────────────────────────────────────────────

test('AN IMAGE URL FROM ANOTHER APP IS A URL FROM OUTSIDE', () => {
  const base = 'https://omos.example.org/donations';
  assert.equal(safeImage('javascript:alert(1)', base), '');
  assert.equal(safeImage('data:image/svg+xml,<svg onload=alert(1)>', base), '');
  assert.equal(safeImage('', base), '');
  assert.equal(safeImage(undefined, base), '');
  // A relative path is resolved against DONATIONS, which is where it was written — resolving
  // it against our own origin would point at a file on this server that does not exist.
  assert.equal(safeImage('/uploads/cover.jpg', base), 'https://omos.example.org/uploads/cover.jpg');
  assert.equal(safeImage('uploads/cover.jpg', base), 'https://omos.example.org/donations/uploads/cover.jpg');
  assert.equal(safeImage('https://cdn.example.org/c.jpg', base), 'https://cdn.example.org/c.jpg');
});

// ── A fake Donations ─────────────────────────────────────────────────────────

interface Fake {
  base: string;
  close: () => Promise<void>;
  /** What the next request gets. */
  reply: { status: number; body: string; type?: string };
  hits: number;
  /** Answer the next request with a same-origin 302, the way a trailing-slash rule does. */
  redirectOnce: boolean;
}

async function startDonations(): Promise<Fake> {
  const state: Fake = {
    base: '',
    close: async () => undefined,
    reply: { status: 200, body: '{}' },
    hits: 0,
    redirectOnce: false,
  };
  const server = http.createServer((req, res) => {
    state.hits += 1;
    if (state.redirectOnce) {
      state.redirectOnce = false;
      return res.writeHead(302, { location: `${req.url}?r=1` }).end();
    }
    if (!/^\/api\/public\/campaign\//.test(req.url ?? '')) {
      return res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"no"}');
    }
    res.writeHead(state.reply.status, { 'content-type': state.reply.type ?? 'application/json' });
    res.end(state.reply.body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  state.base = `http://127.0.0.1:${port}`;
  state.close = () => new Promise<void>((r) => server.close(() => r()));
  return state;
}

const campaignJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    data: {
      slug: 'ramadan',
      title: 'Ramadan Appeal',
      type: 'donation',
      description: 'Feeding the neighbourhood every night of Ramadan.',
      coverImage: '/uploads/ramadan.jpg',
      goalAmount: 20000,
      raised: 8450,
      currency: 'gbp',
      allowMonthly: true,
      masjidName: 'Masjid An-Noor',
      ready: true,
      readyReason: '',
      testMode: false,
      // Fields we deliberately do not read. Present so the parser is exercised against the
      // real payload's shape rather than a trimmed one.
      publishableKey: 'pk_test_x',
      presetAmounts: [10, 25, 50],
      thankYou: { heading: 'Jazāk Allāhu khayran' },
      ...over,
    },
  });

test('an appeal comes through, sanitised and in our own shape', async () => {
  const d = await startDonations();
  try {
    d.reply = { status: 200, body: campaignJson() };
    const r = (await fetchCampaign({ base: d.base, slug: 'ramadan' })).load;
    assert.ok(r.ok);
    const c = r.value!;
    assert.equal(c.title, 'Ramadan Appeal');
    assert.equal(c.goalAmount, 20000);
    assert.equal(c.raised, 8450);
    assert.equal(c.currency, 'GBP', 'normalised for Intl, which is case-sensitive about this');
    assert.equal(c.allowMonthly, true);
    assert.equal(c.coverImage, `${d.base}/uploads/ramadan.jpg`);
    assert.equal(c.ready, true);
  } finally {
    await d.close();
  }
});

test('GONE AND COULD-NOT-ASK ARE DIFFERENT ANSWERS', async () => {
  const d = await startDonations();
  try {
    // 404: Donations says this appeal is not there. A settled answer.
    d.reply = { status: 404, body: '{"error":"This donation page isn’t available."}' };
    const gone = (await fetchCampaign({ base: d.base, slug: 'ramadan' })).load;
    assert.deepEqual(gone, { ok: true, value: null }, 'a definite "it is gone"');

    // 503: Donations is restarting. Answering "gone" here would delete a live appeal from a
    // masjid's noticeboard for a whole TTL because of a container restart.
    d.reply = { status: 503, body: 'upstream not ready' };
    assert.equal((await fetchCampaign({ base: d.base, slug: 'ramadan' })).load.ok, false, 'keep what we have');
  } finally {
    await d.close();
  }
});

test('a reply that is not a campaign is kept, not treated as gone', async () => {
  const d = await startDonations();
  try {
    for (const body of ['not json at all', '{"data":null}', '<html>proxy error</html>', '{"data":[]}']) {
      d.reply = { status: 200, body };
      assert.equal((await fetchCampaign({ base: d.base, slug: 'x' })).load.ok, false, `${body.slice(0, 20)} should be KEEP`);
    }
  } finally {
    await d.close();
  }
});

test('a missing field degrades that field, never the whole appeal', async () => {
  // Donations is a separate app on its own release cycle. A renamed or removed field must not
  // empty a masjid's appeals section — it must lose one number.
  const d = await startDonations();
  try {
    d.reply = { status: 200, body: JSON.stringify({ data: { title: 'Roof Fund' } }) };
    const r = (await fetchCampaign({ base: d.base, slug: 'roof' })).load;
    assert.ok(r.ok);
    assert.equal(r.value!.title, 'Roof Fund');
    assert.equal(r.value!.goalAmount, 0, 'no goal is a tile with no progress bar, not an error');
    assert.equal(r.value!.currency, '');
    assert.equal(r.value!.ready, true, 'an older Donations with no `ready` field is working fine');
  } finally {
    await d.close();
  }
});

test('a wrongly typed field is dropped rather than rendered', async () => {
  const d = await startDonations();
  try {
    d.reply = { status: 200, body: campaignJson({ goalAmount: 'lots', title: 42, currency: 'not-a-code' }) };
    const r = (await fetchCampaign({ base: d.base, slug: 'ramadan' })).load;
    assert.ok(r.ok);
    assert.equal(r.value!.goalAmount, 0);
    assert.equal(r.value!.title, 'ramadan', 'falls back to the slug rather than printing "42"');
    assert.equal(r.value!.currency, '');
  } finally {
    await d.close();
  }
});

// ── The list ─────────────────────────────────────────────────────────────────

function tempStore(): { store: Store; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-camp-'));
  const store = new Store(path.join(dir, 'data'));
  return {
    store,
    cleanup: () => {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('an appeal that cannot take a donation is hidden from phones and named to the admin', async () => {
  // The tap a musalli gives a tile is the only one they were going to give it, and a QR code on
  // a noticeboard is not the place to discover that an appeal is switched off.
  const d = await startDonations();
  const s = tempStore();
  try {
    d.reply = { status: 200, body: campaignJson({ ready: false, readyReason: 'This masjid hasn’t finished setting up donations.' }) };
    const c = new Campaigns(s.store);
    c.set([{ base: d.base, slug: 'ramadan' }]);

    assert.deepEqual(await c.publicTiles(), [], 'nothing on the phone');
    const admin = await c.adminList();
    assert.equal(admin.length, 1);
    assert.equal(admin[0].health, 'ok', 'the appeal exists; it just cannot take money');
    assert.match(admin[0].notReady, /finished setting up/, 'Donations’ own sentence, not one of ours');
  } finally {
    await d.close();
    s.cleanup();
  }
});

test('A TEST-MODE APPEAL IS SHOWN, and the admin is warned', async () => {
  // The masjid chose to feature it and Donations badges it on its own page. But an appeal that
  // takes no real money is something the admin should hear from us, not from a puzzled donor.
  const d = await startDonations();
  const s = tempStore();
  try {
    d.reply = { status: 200, body: campaignJson({ testMode: true }) };
    const c = new Campaigns(s.store);
    c.set([{ base: d.base, slug: 'ramadan' }]);
    assert.equal((await c.publicTiles()).length, 1);
    assert.equal((await c.adminList())[0].testMode, true);
  } finally {
    await d.close();
    s.cleanup();
  }
});

test('the order the admin typed is the order on the phone', async () => {
  const d = await startDonations();
  const s = tempStore();
  try {
    d.reply = { status: 200, body: campaignJson() };
    const c = new Campaigns(s.store);
    c.set([
      { base: d.base, slug: 'roof' },
      { base: d.base, slug: 'ramadan' },
    ]);
    assert.deepEqual((await c.publicTiles()).map((t) => t.href), [`${d.base}/roof`, `${d.base}/ramadan`]);
  } finally {
    await d.close();
    s.cleanup();
  }
});

test('FIFTY PHONES AT MAGHRIB COST ONE REQUEST PER APPEAL', async () => {
  // On a Pi running the core, Display and Donations on one box, the stampede is the outage.
  const d = await startDonations();
  const s = tempStore();
  try {
    d.reply = { status: 200, body: campaignJson() };
    const c = new Campaigns(s.store);
    c.set([{ base: d.base, slug: 'ramadan' }]);
    d.hits = 0;
    await Promise.all(Array.from({ length: 50 }, () => c.publicTiles()));
    assert.equal(d.hits, 1, 'in-flight dedupe, then the TTL');
  } finally {
    await d.close();
    s.cleanup();
  }
});

test('the list survives a restart, and a link that stopped being valid is dropped', async () => {
  const s = tempStore();
  try {
    const first = new Campaigns(s.store);
    first.set([{ base: 'https://omos.example.org/donations', slug: 'ramadan' }]);
    assert.equal(new Campaigns(s.store).count(), 1, 'read back from the volume');

    // Something wrote nonsense into the store. It is skipped rather than crashing the server on
    // boot, which is the failure mode that matters for a value read at construction time.
    s.store.setJson('campaigns.links', ['https://omos.example.org/donations/ok', 'not-a-link', 42, null]);
    const after = new Campaigns(s.store);
    assert.equal(after.count(), 1);
    assert.equal(after.list()[0].slug, 'ok');
  } finally {
    s.cleanup();
  }
});

test('removing an appeal forgets what was cached about it', async () => {
  // Otherwise removing and re-adding a link shows whatever was last seen rather than re-checking
  // — which is exactly what an admin does after fixing something in Donations.
  const d = await startDonations();
  const s = tempStore();
  try {
    d.reply = { status: 200, body: campaignJson() };
    const c = new Campaigns(s.store);
    c.set([{ base: d.base, slug: 'ramadan' }]);
    await c.publicTiles();
    c.set([]);
    c.set([{ base: d.base, slug: 'ramadan' }]);
    d.hits = 0;
    await c.publicTiles();
    assert.equal(d.hits, 1, 're-checked rather than served from the old entry');
  } finally {
    await d.close();
    s.cleanup();
  }
});

// ── Why it did not work ──────────────────────────────────────────────────────
//
// The first version answered "we couldn't reach this appeal" to every one of these, which is
// the one explanation an admin has already ruled out by opening the link in their own browser.
// Whatever is uncertain about another app's availability, WHICH WAY it failed is knowable.

test('AN HTTP ERROR IS REPORTED AS ONE, with its status', async () => {
  const d = await startDonations();
  try {
    d.reply = { status: 403, body: 'forbidden' };
    const r = await fetchCampaign({ base: d.base, slug: 'ramadan' });
    assert.equal(r.load.ok, false);
    assert.deepEqual(r.problem, { kind: 'http', status: 403 });
    // A 403 in front of a PUBLIC donor page is nearly always an access rule, so the sentence
    // says so rather than blaming the link.
    assert.match(describeProblem(r.problem!), /refused|login/i);
    assert.equal(problemDetail(r.problem!), 'HTTP 403');
  } finally {
    await d.close();
  }
});

test('a name that does not resolve says so, and names the host', async () => {
  // The commonest real cause: the admin's phone looks the address up on the internet and the
  // link works; the server behind them cannot, and gets told nothing useful.
  const r = await fetchCampaign({ base: 'https://not-a-real-host.invalid/donations', slug: 'ramadan' });
  assert.equal(r.load.ok, false);
  assert.equal(r.problem?.kind, 'dns');
  assert.match(describeProblem(r.problem!), /not-a-real-host\.invalid/);
  assert.match(describeProblem(r.problem!), /look up/i);
});

test('nothing listening is not the same as a name that will not resolve', async () => {
  // Port 1 on loopback: resolves instantly, refuses instantly.
  const r = await fetchCampaign({ base: 'http://127.0.0.1:1/donations', slug: 'ramadan' });
  assert.equal(r.load.ok, false);
  assert.equal(r.problem?.kind, 'refused');
});

test('a reply that is not a campaign is reported as such, not as unreachable', async () => {
  const d = await startDonations();
  try {
    d.reply = { status: 200, body: '<html>an error page from something in front</html>', type: 'text/html' };
    const r = await fetchCampaign({ base: d.base, slug: 'ramadan' });
    assert.equal(r.problem?.kind, 'body');
    assert.match(describeProblem(r.problem!), /wasn’t an appeal|Share/);
  } finally {
    await d.close();
  }
});

test('every problem has a sentence and a technical line, and neither is empty', () => {
  // A missing branch here would surface as a blank warning box on the panel — the failure mode
  // this whole taxonomy exists to prevent, reintroduced by a switch that fell through.
  const all: Problem[] = [
    { kind: 'dns', host: 'h' },
    { kind: 'refused', host: 'h' },
    { kind: 'tls', host: 'h' },
    { kind: 'timeout', host: 'h' },
    { kind: 'redirect', to: 'https://x' },
    { kind: 'http', status: 500 },
    { kind: 'body' },
  ];
  for (const p of all) {
    assert.ok(describeProblem(p).length > 20, `${p.kind} needs a real sentence`);
    assert.ok(problemDetail(p).length > 3, `${p.kind} needs a detail line`);
  }
});

// ── Redirects ────────────────────────────────────────────────────────────────

/** A server that redirects once, to wherever it is told. */
async function startRedirector(to: string): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(302, { location: to }).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}/donations`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('A SAME-ORIGIN REDIRECT IS FOLLOWED, because this call carries no credential', async () => {
  // Everything else in this app sets redirect:'error' — and the REASON is that those calls
  // present X-OpenMasjid-App-Secret. This one is an anonymous GET to a public page, so refusing
  // a trailing-slash or canonical-host redirect buys no secrecy and breaks real deployments.
  const d = await startDonations();
  try {
    d.redirectOnce = true;
    d.reply = { status: 200, body: campaignJson() };
    const r = await fetchCampaign({ base: d.base, slug: 'ramadan' });
    assert.equal(r.load.ok, true, 'the redirect was followed');
    assert.equal(r.load.ok && r.load.value?.title, 'Ramadan Appeal');
  } finally {
    await d.close();
  }
});

test('A CROSS-ORIGIN HOP TO A PRIVATE ADDRESS IS REFUSED, even from a private start', async () => {
  // The address the admin typed may be a LAN one. A redirect TARGET may not be, unless it is
  // the same origin we were already talking to — otherwise a pasted link becomes a way to make
  // this server fetch arbitrary addresses on the masjid's own network.
  const d = await startDonations();
  const rd = await startRedirector(`${d.base}/api/public/campaign/ramadan`);
  try {
    const r = await fetchCampaign({ base: rd.base, slug: 'ramadan' });
    assert.equal(r.load.ok, false);
    assert.equal(r.problem?.kind, 'redirect');
  } finally {
    await rd.close();
    await d.close();
  }
});

test('A REDIRECT MAY NOT REACH A PRIVATE ADDRESS, however the first link looked', async () => {
  // Only the address the admin typed may be a LAN one. Without this, a public link that
  // redirects turns the admin's paste box into a port scanner for the masjid's own network.
  const rd = await startRedirector('http://192.168.1.1/admin');
  try {
    const r = await fetchCampaign({ base: rd.base, slug: 'ramadan' });
    assert.equal(r.load.ok, false);
    assert.equal(r.problem?.kind, 'redirect');
    assert.match(describeProblem(r.problem!), /redirected/i);
  } finally {
    await rd.close();
  }
});

test('a redirect loop gives up rather than spinning', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(302, { location: `https://example.invalid${req.url}` }).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    const r = await fetchCampaign({ base: `http://127.0.0.1:${port}/donations`, slug: 'ramadan' });
    assert.equal(r.load.ok, false);
    // Either it ran out of hops or the invalid host failed to resolve — both are refusals, and
    // neither is a hang.
    assert.ok(r.problem?.kind === 'redirect' || r.problem?.kind === 'dns');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('the panel is told which way it failed, not just that it did', async () => {
  const s = tempStore();
  try {
    const c = new Campaigns(s.store);
    c.set([{ base: 'https://not-a-real-host.invalid/donations', slug: 'ramadan' }]);
    const row = (await c.adminList())[0];
    assert.equal(row.health, 'unreachable');
    assert.match(row.why, /look up/i, 'a sentence a volunteer can act on');
    assert.match(row.detail, /DNS lookup failed/, 'and the technical line under it');
    assert.deepEqual(await c.publicTiles(), [], 'and nothing on a phone either way');
  } finally {
    s.cleanup();
  }
});
