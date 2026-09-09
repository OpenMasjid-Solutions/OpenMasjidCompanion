// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The service worker, actually run.
 *
 * `sw.tmpl` is a standalone script, not a module, so it was the one file in this app that nothing
 * could execute in a test — and it is the file that decides whether a musalli is shown a live
 * prayer time or a saved one. "I read it and it looks right" is not good enough for that: the
 * failure it guards against is silent on screen, and the first report of a mistake here is
 * somebody who missed jamāʿah.
 *
 * So the real template is loaded, its two placeholders filled in exactly as the server fills
 * them, and run inside a sandbox with a mock Cache Storage and a mock `fetch`. What is asserted
 * is the OBSERVABLE behaviour a phone would get back, not the shape of the source.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = fs.readFileSync(path.resolve(HERE, '..', 'public', 'sw.tmpl'), 'utf8');
const BASE = '/companion';
const TIMETABLE = `https://masjid.example${BASE}/api/public/timetable`;

/** The smallest Cache Storage that behaves like the real one for our purposes: keyed by URL. */
function makeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    return {
      match: async (req: Request | string) => store.get(typeof req === 'string' ? req : req.url),
      put: async (req: Request | string, res: Response) => {
        store.set(typeof req === 'string' ? req : req.url, res);
      },
      add: async () => undefined,
      delete: async () => true,
    };
  };
  return {
    api: { open, keys: async () => [...stores.keys()], match: async () => undefined, delete: async () => true },
    stores,
  };
}

/**
 * Run the worker and hand back its `fetch` listener plus the mocks it was given.
 *
 * `netFor` is the mock network: return a Response, or throw to be offline.
 */
function boot(netFor: (url: string) => Promise<Response>) {
  const source = TEMPLATE.split('__VERSION__').join('9.9.9').split('__BASE__').join(BASE);
  const listeners = new Map<string, (e: unknown) => void>();
  const { api: cacheApi, stores } = makeCaches();

  const self = {
    addEventListener: (type: string, fn: (e: unknown) => void) => listeners.set(type, fn),
    location: { origin: 'https://masjid.example' },
    clients: { claim: async () => undefined, matchAll: async () => [], openWindow: async () => undefined },
    registration: { showNotification: async () => undefined, pushManager: { subscribe: async () => ({}) } },
    skipWaiting: () => undefined,
  };

  const sandbox = {
    self,
    caches: cacheApi,
    fetch: (req: Request | string) => netFor(typeof req === 'string' ? req : req.url),
    Response,
    Headers,
    Request,
    URL,
    setTimeout,
    clearTimeout,
    Date,
    console,
  };
  vm.runInNewContext(source, sandbox);
  return { listeners, stores };
}

/** Drive the worker's fetch handler the way the browser would, and await what it answers. */
async function ask(listeners: Map<string, (e: unknown) => void>, url: string): Promise<Response> {
  const handler = listeners.get('fetch');
  assert.ok(handler, 'the worker registered no fetch listener');
  let answered: Promise<Response> | null = null;
  handler({
    request: new Request(url, { method: 'GET' }),
    respondWith: (p: Promise<Response>) => {
      answered = p;
    },
  });
  assert.ok(answered, 'the worker did not respond to a timetable request at all');
  return answered;
}

const json = (body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...extra } });

// ── online ───────────────────────────────────────────────────────────────────

test('ONLINE, the timetable comes from the network and is NOT marked as a copy', async () => {
  const { listeners, stores } = boot(async () => json({ data: { at: 111, days: ['live'] } }));
  const res = await ask(listeners, TIMETABLE);

  assert.equal(res.headers.get('x-omc-from-cache'), null, 'a live answer must never be labelled a copy');
  assert.deepEqual(((await res.json()) as { data: { days: string[] } }).data.days, ['live']);

  // …and it is kept, stamped with when THIS PHONE received it, ready for the next time there is
  // no signal. Without the stamp the page cannot say how old a copy is.
  const stored = [...stores.values()].flatMap((s) => [...s.values()])[0];
  assert.ok(stored, 'a successful fetch must populate the cache — otherwise there is no offline');
  assert.match(String(stored.headers.get('x-omc-cached-at')), /^\d{10,}$/, 'stamped with a real epoch');
});

// ── offline: the case that was reported as not working ───────────────────────

test('OFFLINE, THE SAVED COPY IS SERVED AND IS MARKED AS ONE', async () => {
  // This is the reported bug, executed rather than reasoned about: a phone with no signal must
  // still get times, and the response must carry the flag the page turns into "you are offline,
  // these were saved on …". No flag, no notice, and the reader cannot tell a copy from a live one.
  let online = true;
  const { listeners } = boot(async () => {
    if (!online) throw new TypeError('Failed to fetch');
    return json({ data: { at: 222, days: ['saved'] } });
  });

  await ask(listeners, TIMETABLE); // one good load, so there is something to fall back to
  online = false;

  const res = await ask(listeners, TIMETABLE);
  assert.equal(res.headers.get('x-omc-from-cache'), '1', 'THE COPY MUST DECLARE ITSELF');
  assert.match(String(res.headers.get('x-omc-cached-at')), /^\d{10,}$/, 'and say when it was taken');
  assert.deepEqual(((await res.json()) as { data: { days: string[] } }).data.days, ['saved'], 'the times still arrive');
});

test('offline with NOTHING saved yet fails rather than inventing a body', async () => {
  // A fresh install that has never been online has no times, and must say so — the page renders
  // its "prayer times aren't set up yet" state. Anything else would be fabricating a timetable.
  const { listeners } = boot(async () => {
    throw new TypeError('Failed to fetch');
  });
  const res = await ask(listeners, TIMETABLE);
  assert.ok(!res.ok, 'no cache and no network is a failure, not an empty timetable');
});

test('a server error falls back to the copy rather than blanking the times', async () => {
  let broken = false;
  const { listeners } = boot(async () => (broken ? new Response('nope', { status: 500 }) : json({ data: { days: ['saved'] } })));
  await ask(listeners, TIMETABLE);
  broken = true;

  const res = await ask(listeners, TIMETABLE);
  assert.equal(res.headers.get('x-omc-from-cache'), '1');
  assert.deepEqual(((await res.json()) as { data: { days: string[] } }).data.days, ['saved']);
});

// ── the appeals keep the other policy ────────────────────────────────────────

test('the appeals are still answered from cache first — being a minute old costs nothing there', async () => {
  const { listeners } = boot(async () => json({ data: [{ slug: 'live' }] }));
  const url = `https://masjid.example${BASE}/api/public/campaigns`;
  await ask(listeners, url);

  const res = await ask(listeners, url);
  assert.equal(res.headers.get('x-omc-from-cache'), '1', 'served from cache, and labelled either way');
});

// ── the admin is never cached ────────────────────────────────────────────────

test('THE WORKER STILL REFUSES TO TOUCH THE ADMIN PANEL', async () => {
  const { listeners } = boot(async () => json({ data: 'secret' }));
  const handler = listeners.get('fetch')!;
  let answered = false;
  handler({
    request: new Request(`https://masjid.example${BASE}/api/admin/status`, { method: 'GET' }),
    respondWith: () => {
      answered = true;
    },
  });
  assert.equal(answered, false, 'an admin request must go straight to the network, uncached');
});
