// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The data volume is the one thing in this app that survives a restart, and two of its
 * properties are load-bearing in ways that are easy to break by accident:
 *
 *  - The session-signing secret must be STABLE across restarts. This container restarts
 *    to pick up a platform config change, so a secret regenerated on boot would sign the
 *    admin out every time the masjid changed a setting in OpenMasjidOS.
 *  - A corrupted setting must degrade to the default, never throw. Prayer times are the
 *    point of this app; nothing about a bad row in a key/value table should stop them
 *    being served.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'companion-store-'));
}

test('the store creates its directory and opens a database', () => {
  const dir = path.join(tmp(), 'nested', 'data');
  const store = new Store(dir);
  try {
    assert.ok(fs.existsSync(path.join(dir, 'companion.db')));
    assert.equal(store.db.pragma('journal_mode', { simple: true }), 'wal');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('settings round-trip, overwrite, and delete', () => {
  const dir = tmp();
  const store = new Store(dir);
  try {
    assert.equal(store.get('nothing'), null);
    store.set('app_name', 'Masjid An-Noor');
    assert.equal(store.get('app_name'), 'Masjid An-Noor');
    store.set('app_name', 'Masjid al-Falah');
    assert.equal(store.get('app_name'), 'Masjid al-Falah', 'set overwrites rather than failing on the primary key');
    store.del('app_name');
    assert.equal(store.get('app_name'), null);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('JSON settings round-trip, and a corrupted one falls back instead of throwing', () => {
  const dir = tmp();
  const store = new Store(dir);
  try {
    store.setJson('prefs', { prayers: ['fajr', 'maghrib'], minutes: 10 });
    assert.deepEqual(store.getJson('prefs', null), { prayers: ['fajr', 'maghrib'], minutes: 10 });
    assert.deepEqual(store.getJson('absent', { a: 1 }), { a: 1 });

    store.set('prefs', '{not json');
    assert.deepEqual(store.getJson('prefs', { fallback: true }), { fallback: true }, 'a bad row degrades to the default');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the session secret is generated once and survives a restart', () => {
  // If this ever regresses, every admin is signed out on every container restart — and
  // this container restarts whenever the platform's config changes.
  const dir = tmp();
  const first = new Store(dir);
  const secret = Buffer.from(first.secret);
  first.close();

  assert.equal(secret.length, 32, '32 bytes from the OS CSPRNG');

  const second = new Store(dir);
  try {
    assert.deepEqual(second.secret, secret, 'the same volume must yield the same signing key');
  } finally {
    second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two different volumes get two different secrets', () => {
  const a = tmp();
  const b = tmp();
  const sa = new Store(a);
  const sb = new Store(b);
  try {
    assert.notDeepEqual(sa.secret, sb.secret);
  } finally {
    sa.close();
    sb.close();
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test('the store never persists anything the platform owns', () => {
  // The Fabric restore-resilience contract: the base URL, the app secret and the public
  // URL are rewritten by the platform across a restore onto a new machine, a domain
  // change and a secret rotation. A persisted copy would survive the change and point at
  // the old box — so they are read from the environment every start and never written.
  const dir = tmp();
  const store = new Store(dir);
  try {
    const keys = (store.db.prepare('SELECT key FROM settings').all() as { key: string }[]).map((r) => r.key);
    assert.deepEqual(keys.sort(), ['instance_secret', 'schema_version']);
    for (const k of keys) {
      assert.doesNotMatch(k, /omos|openmasjid|base_?url|public_?url|app_?secret/i);
    }
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('closing twice is not an error', () => {
  // Shutdown runs from a signal handler that may fire more than once.
  const dir = tmp();
  const store = new Store(dir);
  store.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
