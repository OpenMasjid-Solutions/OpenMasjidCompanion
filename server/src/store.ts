// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * store.ts — everything this app remembers, in one SQLite file on the data volume.
 *
 * What belongs here: the admin's choices (which timetable, which appeals, the app's
 * name and icon), the caches that let the app answer when Display or Donations is
 * unreachable, the anonymous push subscriptions, and this app's own long-lived secrets
 * (the session-signing key and, later, the VAPID keypair).
 *
 * What must NEVER be written here, and why it is worth stating rather than assuming:
 *
 *  - `OPENMASJID_APP_SECRET`, `OPENMASJID_BASE_URL`, `OPENMASJID_PUBLIC_URL` or anything
 *    derived from them. The platform rewrites all three across a restore onto a new
 *    machine, a domain change and a secret rotation; a cached copy would survive the
 *    change and point at the old box. They are read from the environment every start
 *    (config.ts) and that is the whole mechanism.
 *  - Anything that identifies a musalli. A push subscription is an endpoint, its keys
 *    and its preferences. No name, no phone, no IP, no history of who opened what.
 *
 * The settings table is a plain key/value store rather than a column per setting on
 * purpose: this app's configuration is a dozen unrelated scalars, and a migration per
 * scalar is a lot of ceremony for something that is read once per request at most.
 * Anything with rows of its own (subscriptions, curated appeals) gets a real table.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { config } from './config';
import { makeLog } from './logger';
import type { Cred } from './auth';

const log = makeLog('store');

/** Bumped when the schema changes in a way `migrate()` has to act on. */
const SCHEMA_VERSION = 1;

export class Store {
  readonly db: Database.Database;
  /** HMAC key for this app's own admin session cookies. Generated on first boot and
   *  kept for the life of the data volume — regenerating it would sign every admin out,
   *  which on a container that restarts to pick up a config change would be every time. */
  readonly secret: Buffer;

  constructor(dir = config.dataDir) {
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(path.join(dir, 'companion.db'));
    // WAL: a reader (a musalli loading the page) never blocks the writer (the push
    // scheduler marking a send). NORMAL sync is the right trade on a Pi with a
    // filesystem cache — the worst case is losing the last write on a power cut, and
    // nothing here is worth a full fsync per statement.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
    this.secret = this.instanceSecret();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const from = Number(this.get('schema_version') ?? '0');
    if (from > SCHEMA_VERSION) {
      // A volume written by a NEWER build than this one. Refusing is wrong (it would
      // brick a masjid that rolled back) and so is silently rewriting it, so we carry
      // on and say so — every read below tolerates a column it does not know about.
      log.warn(`data volume is at schema ${from}, this build knows ${SCHEMA_VERSION} — continuing read-only-compatible`);
      return;
    }
    if (from < SCHEMA_VERSION) this.set('schema_version', String(SCHEMA_VERSION));
  }

  /** This app's own signing key, created once. 32 bytes from the OS CSPRNG. */
  private instanceSecret(): Buffer {
    const existing = this.get('instance_secret');
    if (existing) return Buffer.from(existing, 'base64');
    const fresh = crypto.randomBytes(32);
    this.set('instance_secret', fresh.toString('base64'));
    return fresh;
  }

  // ── settings ────────────────────────────────────────────────────────────────

  get(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  set(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  del(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }

  /** A JSON setting, or `fallback` when it is absent OR unreadable. Unreadable is not
   *  an error path worth propagating: a corrupted row should degrade this app to its
   *  defaults, not stop it from serving prayer times. */
  getJson<T>(key: string, fallback: T): T {
    const raw = this.get(key);
    if (raw == null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      log.warn(`setting "${key}" is not valid JSON — using the default`);
      return fallback;
    }
  }

  setJson(key: string, value: unknown): void {
    this.set(key, JSON.stringify(value));
  }

  // ── the local admin (the RECOVERY route, not the front door) ────────────────
  //
  // There is at most ONE. This app has a single administrator — the person who looks after
  // the masjid's OpenMasjidOS box — and roles, invitations and a user table would all be
  // machinery for a distinction that does not exist here.
  //
  // Under OpenMasjidOS the admin normally never sets one: they press "Open" and SSO signs them
  // in. This exists for the day the platform is unreachable and somebody still has to get into
  // the panel. See the guard on POST /api/setup.

  /** Has a local password ever been set? */
  hasAdmin(): boolean {
    return this.get('admin_cred') != null;
  }

  /** The stored credential, or null. Never leaves the server. */
  getAdmin(): Cred | null {
    return this.getJson<Cred | null>('admin_cred', null);
  }

  /** Set (or replace) the local password. The plaintext never reaches this method — hashing
   *  happens in auth.ts and only the scrypt parameters and digest are stored. */
  setAdmin(cred: Cred): void {
    this.setJson('admin_cred', cred);
  }

  /** Remove the local password. Used when an admin who is signed in via SSO decides they no
   *  longer want a second way in. */
  clearAdmin(): void {
    this.del('admin_cred');
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}
