// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * push.ts — prayer notifications, self-hosted end to end.
 *
 * No third-party push relay, no account, no analytics service. This app generates its own
 * VAPID keypair on first boot and talks straight to whatever push service the musalli's
 * browser nominated (Google's, Apple's, Mozilla's). The masjid's box is the only server in the
 * loop that knows anything.
 *
 * **WHAT IS STORED ABOUT A MUSALLI, IN FULL** (CLAUDE.md §9): the push endpoint URL, the two
 * keys needed to encrypt to it, which prayers they chose, whether they want the adhan and/or
 * N minutes before the jamā'ah, and two timestamps. That is the whole row. No name, no phone,
 * no IP, no history of what they opened. The admin is shown a COUNT and never a list — there
 * is no endpoint in this app that returns one.
 *
 * The endpoint is treated as a pseudo-identifier: it is never logged in full, only as a host
 * plus a short hash, which is enough to correlate failures without writing down who.
 *
 * **The VAPID private key is the one secret that belongs on the data volume.** Unlike
 * `OPENMASJID_APP_SECRET` (which the platform rotates and re-injects), this is *our own*
 * long-lived identity toward the push services: regenerating it silently invalidates every
 * subscription in the masjid, and every phone goes quiet with nothing to explain why. It is
 * never logged and never sent to a browser — only the public half is.
 */
import crypto from 'node:crypto';
import webpush, { type PushSubscription as WebPushSubscription } from 'web-push';
import { z } from 'zod';
import { makeLog } from './logger';
import type { Store } from './store';

const log = makeLog('push');

const KEY_VAPID = 'push.vapid';

/** Prayers a musalli can be reminded about. Jumu'ah rides on the Friday Dhuhr choice — a
 *  separate switch for a prayer that exists one day in seven reads as a bug on the other six. */
export const PRAYERS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] as const;
export type Prayer = (typeof PRAYERS)[number];

export const NAMES: Record<Prayer, string> = {
  fajr: 'Fajr',
  dhuhr: 'Dhuhr',
  asr: 'Asr',
  maghrib: 'Maghrib',
  isha: 'Isha',
};

/** How early a "before the jamā'ah" reminder may be set. An hour is already generous; more
 *  would be a reminder about a prayer that is not the next one. */
export const MAX_LEAD_MIN = 60;

/** A ceiling on stored subscriptions, so a broken client looping on subscribe cannot fill a
 *  Pi's disk. The admin is told when it is reached — silently dropping the next musalli's
 *  subscription would be a bug nobody could see. */
export const MAX_SUBSCRIPTIONS = 5000;

// ── What a phone sends us ────────────────────────────────────────────────────

export const PrefsSchema = z.object({
  /** Which prayers. An empty list is legitimate — it is how someone turns everything off
   *  without unsubscribing, and the scheduler simply never has anything to send them. */
  prayers: z.array(z.enum(PRAYERS)).max(PRAYERS.length),
  /** At the adhan. */
  adhan: z.boolean(),
  /** N minutes before the jamā'ah; 0 = at the jamā'ah itself. Null = not wanted. */
  beforeIqamah: z.number().int().min(0).max(MAX_LEAD_MIN).nullable(),
  /**
   * Occasional notices from the masjid — a funeral, a closure, a changed jamā'ah.
   *
   * **A separate choice from the prayer reminders**, because they are a different thing: a
   * musalli who unticked every prayer wants silence at prayer times, not to be unreachable
   * when the masjid has something to say. Broadcasting to them anyway on the grounds that they
   * "opted into notifications" would be the kind of reasoning that trains people to block a
   * site.
   *
   * Defaults to true, which also makes it the right value for every subscription written
   * before this field existed — those rows parse as opted in, which is what somebody who
   * signed up for reminders from their masjid would expect.
   */
  announcements: z.boolean().default(true),
});
export type Prefs = z.infer<typeof PrefsSchema>;

export const SubscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url().max(1000),
    keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
  }),
  prefs: PrefsSchema,
});
export type SubscribeBody = z.infer<typeof SubscribeSchema>;

export interface Row {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  prefs: Prefs;
  /** ms epoch through which this subscription has already been sent everything it is due.
   *  The scheduler's whole idempotency rests on this one number. */
  sentThrough: number;
}

/**
 * How an endpoint appears in a log.
 *
 * The host tells you which push service is failing, which is the only operationally useful
 * part; the hash lets two lines be recognised as the same phone without writing down which
 * phone. The full endpoint is a pseudo-identifier and never appears anywhere.
 */
export function safeEndpoint(endpoint: string): string {
  const hash = crypto.createHash('sha256').update(endpoint).digest('hex').slice(0, 8);
  try {
    return `${new URL(endpoint).host}#${hash}`;
  } catch {
    return `?#${hash}`;
  }
}

// ── The store ────────────────────────────────────────────────────────────────

export class Subscriptions {
  constructor(private readonly store: Store) {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS push_subs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        endpoint     TEXT NOT NULL UNIQUE,
        p256dh       TEXT NOT NULL,
        auth         TEXT NOT NULL,
        prefs        TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        sent_through INTEGER NOT NULL DEFAULT 0,
        last_ok      INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  /**
   * Add or update, keyed on the endpoint.
   *
   * Re-posting the same endpoint UPDATES rather than duplicating: a browser hands back the
   * same endpoint every time the same phone subscribes, and a musalli who changes their
   * choices is the ordinary case, not a new subscriber.
   *
   * `sent_through` is set to now on insert so a phone that subscribes at 19:00 does not
   * immediately receive everything it "missed" since midnight.
   */
  put(body: SubscribeBody, now = Date.now()): { ok: true } | { ok: false; reason: 'full' } {
    const existing = this.store.db.prepare('SELECT id FROM push_subs WHERE endpoint = ?').get(body.subscription.endpoint);
    if (!existing && this.count() >= MAX_SUBSCRIPTIONS) return { ok: false, reason: 'full' };

    this.store.db
      .prepare(
        `INSERT INTO push_subs (endpoint, p256dh, auth, prefs, created_at, sent_through)
         VALUES (@endpoint, @p256dh, @auth, @prefs, @now, @now)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, prefs = excluded.prefs`,
      )
      .run({
        endpoint: body.subscription.endpoint,
        p256dh: body.subscription.keys.p256dh,
        auth: body.subscription.keys.auth,
        prefs: JSON.stringify(body.prefs),
        now,
      });
    return { ok: true };
  }

  remove(endpoint: string): void {
    this.store.db.prepare('DELETE FROM push_subs WHERE endpoint = ?').run(endpoint);
  }

  count(): number {
    const r = this.store.db.prepare('SELECT COUNT(*) AS n FROM push_subs').get() as { n: number };
    return r.n;
  }

  /** One subscription's stored preferences, so a returning phone can show its own switches
   *  as it left them rather than as the defaults. */
  prefsFor(endpoint: string): Prefs | null {
    const row = this.store.db.prepare('SELECT prefs FROM push_subs WHERE endpoint = ?').get(endpoint) as { prefs: string } | undefined;
    if (!row) return null;
    const parsed = PrefsSchema.safeParse(JSON.parse(row.prefs));
    return parsed.success ? parsed.data : null;
  }

  all(): Row[] {
    const rows = this.store.db.prepare('SELECT id, endpoint, p256dh, auth, prefs, sent_through FROM push_subs').all() as {
      id: number;
      endpoint: string;
      p256dh: string;
      auth: string;
      prefs: string;
      sent_through: number;
    }[];
    const out: Row[] = [];
    for (const r of rows) {
      const parsed = PrefsSchema.safeParse(JSON.parse(r.prefs));
      // A row whose preferences no longer parse is skipped, not deleted: a build that
      // renamed a field should go quiet for that phone, not throw its subscription away.
      if (!parsed.success) continue;
      out.push({ id: r.id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth, prefs: parsed.data, sentThrough: r.sent_through });
    }
    return out;
  }

  markSent(id: number, through: number, ok: boolean): void {
    this.store.db
      .prepare('UPDATE push_subs SET sent_through = ?, last_ok = CASE WHEN ? THEN ? ELSE last_ok END WHERE id = ?')
      .run(through, ok ? 1 : 0, through, id);
  }
}

// ── Keys ─────────────────────────────────────────────────────────────────────

export interface Vapid {
  publicKey: string;
  privateKey: string;
}

/**
 * This app's VAPID keypair, created once and kept for the life of the data volume.
 *
 * Regenerating it invalidates every subscription in the masjid at once — every phone simply
 * stops receiving, with nothing on any screen to explain it — so it is generated exactly once
 * and never rotated on our own initiative.
 */
export function vapidKeys(store: Store): Vapid {
  const held = store.getJson<Partial<Vapid>>(KEY_VAPID, {});
  if (held.publicKey && held.privateKey) return { publicKey: held.publicKey, privateKey: held.privateKey };
  const fresh = webpush.generateVAPIDKeys();
  store.setJson(KEY_VAPID, fresh);
  // The PUBLIC half only. The private key never reaches a log, on any level.
  log.info(`generated this app's VAPID keypair (public ${fresh.publicKey.slice(0, 12)}…)`);
  return fresh;
}

// ── Sending ──────────────────────────────────────────────────────────────────

export type SendOutcome = 'sent' | 'gone' | 'failed';

export interface Notification {
  title: string;
  body: string;
  /** Collapses re-delivery: the same prayer on the same day replaces rather than stacks. */
  tag: string;
  /** Where `notificationclick` should land. Absolute, from the platform's public URL. */
  url: string;
}

/**
 * Deliver one notification.
 *
 * **404 and 410 mean the subscription is dead** — the phone was wiped, the browser data
 * cleared, the app uninstalled — and the row is pruned immediately by the caller. Anything
 * else is a transient failure and the subscription is kept: a push service having a bad ten
 * minutes must not empty a masjid's subscriber list.
 */
export async function sendOne(vapid: Vapid, row: Pick<Row, 'endpoint' | 'p256dh' | 'auth'>, payload: Notification, subject: string): Promise<SendOutcome> {
  const sub: WebPushSubscription = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload), {
      vapidDetails: { subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
      TTL: 600, // ten minutes: a prayer reminder that arrives late is worse than not at all
    });
    return 'sent';
  } catch (err) {
    const status = (err as { statusCode?: number } | undefined)?.statusCode;
    if (status === 404 || status === 410) return 'gone';
    log.debug(`push to ${safeEndpoint(row.endpoint)} failed with ${status ?? 'no status'}`);
    return 'failed';
  }
}

/** How long the masjid must wait between announcements. Not a policy about how much a masjid
 *  may say to its own congregation — it is an accident guard, so a double-tap or a retried
 *  request cannot send the same notice to everyone twice. */
export const ANNOUNCE_COOLDOWN_MS = 60_000;

/** As long as a notification body can be before a lock screen truncates it anyway. */
export const ANNOUNCE_MAX_CHARS = 200;

/**
 * The `sub:` claim on the VAPID token — a contact for whoever runs the push service, should
 * they need to reach whoever is sending. A URL is what the spec wants and what we have; the
 * masjid's own public address is more useful to them than an address of ours.
 */
export function vapidSubject(publicUrl: string): string {
  try {
    const u = new URL(publicUrl);
    if (u.protocol === 'https:' || u.protocol === 'http:') return u.origin;
  } catch {
    /* not configured yet */
  }
  return 'https://github.com/OpenMasjid-Solutions/OpenMasjidCompanion';
}
