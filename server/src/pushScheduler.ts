// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * pushScheduler.ts — deciding the moment a phone buzzes.
 *
 * **Nothing here computes a prayer time** (CLAUDE.md §2). Every time it acts on came from
 * Display as "HH:mm" in the masjid's own IANA zone; this file only turns those into instants
 * and compares them with the clock.
 *
 * Four rules, each of which exists because its absence is a real harm rather than a bug:
 *
 *  1. **Never notify from stale data.** If the timetable cache is older than
 *     `STALE_LIMIT_MS`, nothing is sent at all. A confidently wrong "Maghrib in 10 minutes"
 *     is worse than silence, because somebody acts on it — they leave the house.
 *  2. **Never send a backlog.** A container that was off for six hours must not deliver six
 *     hours of missed reminders the moment it comes back. Anything older than `GRACE_MS` is
 *     dropped, not queued: a reminder about a prayer that has been and gone is noise at best.
 *  3. **Idempotent by construction.** Each subscription carries `sentThrough`; a tick only
 *     ever considers the window `(sentThrough, now]` and then advances it. A restart mid-tick
 *     re-sends at most the last window, and the notification `tag` collapses a duplicate on
 *     the phone anyway.
 *  4. **Jitter.** Fifty phones at one masjid all want Maghrib at the same second. Sending
 *     them in one burst is how a push service starts rate-limiting a masjid's box.
 */
import { makeLog } from './logger';
import { raiseAlert } from './fabric';
import { ANNOUNCE_COOLDOWN_MS, ANNOUNCE_MAX_CHARS, MAX_JUMUAH, NAMES, PRAYERS, type Notifiable, type Notification, type Prefs, type Subscriptions, type Vapid, safeEndpoint, sendOne, vapidSubject } from './push';
import { formatTimeIn, isHhmm, zonedTimeToEpoch } from './zoned';
import { dueAction, type Schedules } from './schedules';
import type { TimetableFeed } from './timetable';

const log = makeLog('push');

/** How often the scheduler wakes. A minute's granularity is what "5 minutes before" means to
 *  a reader, and the window arithmetic makes the exact cadence irrelevant to correctness. */
export const TICK_MS = 30_000;

/**
 * How old the timetable may be before notifications stop.
 *
 * 48 hours: long enough that a Display restart or an overnight outage never silences a masjid,
 * short enough that nobody is ever notified from times that have had two days to drift.
 */
export const STALE_LIMIT_MS = 48 * 60 * 60_000;

/** How late a notification may be and still be worth sending. Beyond this the moment has
 *  passed and the reminder is misinformation. */
export const GRACE_MS = 5 * 60_000;

/**
 * Spread a burst, so a masjid's box does not look like one client hammering a push service.
 *
 * **Small, because it is applied per send and the sends run concurrently.** The first version
 * of this was 20 seconds and the loop was sequential, which is a bug that only appears once a
 * masjid has real subscribers: fifty phones × up to 20 s each is a tick lasting seventeen
 * minutes, far beyond the five-minute grace window, so reminders would quietly stop arriving
 * for exactly the masjids where they were working.
 */
export const JITTER_MS = 800;

/**
 * How many pushes are in flight at once.
 *
 * The real spreading mechanism. Ten concurrent requests is nothing to a push service and keeps
 * a tick's wall-clock time proportional to `subscribers / 10` rather than to `subscribers` —
 * which is what makes the 30-second tick and the five-minute grace window mean anything.
 */
export const CONCURRENCY = 10;

/**
 * Run `work` over `items` with at most `concurrency` in flight.
 *
 * A fixed pool of workers pulling from a shared cursor, rather than chunking into batches: a
 * batch runs at the speed of its slowest member, and one phone on a slow network would hold up
 * nine others for no reason.
 */
export async function fanOut<T>(items: T[], concurrency: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      await work(items[i]);
    }
  });
  await Promise.all(workers);
}

/** Bulk rejection across the fleet, not one dead phone — the difference between "somebody
 *  wiped their handset" and "nothing is being delivered to anyone". */
const FLEET_FAIL_MIN = 5;
const FLEET_FAIL_RATIO = 0.5;

/**
 * What to call the i-th Jumu'ah of a day.
 *
 * The masjid's own wording when they gave one. The fallback matches the day view's
 * (`slotsFor` in web/src/prayerTimes.ts) so a reminder never names a jamā'ah differently from
 * the row it corresponds to.
 */
export function jumuahName(held: { label: string }[], i: number): string {
  return held[i]?.label || (held.length > 1 ? `Jumuʿah ${i + 1}` : 'Jumuʿah');
}

/** One thing to send to one subscription. */
export interface Due {
  at: number;
  prayer: Notifiable;
  date: string;
  kind: 'adhan' | 'iqamah';
  hhmm: string;
  /** What to call it. Fixed for the five; the masjid's own wording for a Jumu'ah, which may be
   *  "First Jumu'ah" or anything else they have typed into Display. */
  label: string;
  /** What the notification's tag is built from. Stable, and never the masjid's editable label. */
  key: string;
}

/**
 * Everything a subscription is due in `(after, now]`.
 *
 * Pure, and separated from the sending for exactly that reason: this is where a DST mistake
 * would live, and it is testable against real transitions with no network, no database and no
 * clock of its own.
 *
 * A day is only considered when Display actually sent it. **A missing day is never
 * extrapolated** — that would be inventing a prayer time, which this app may not do.
 */
export function dueFor(feed: TimetableFeed, prefs: Prefs, after: number, now: number): Due[] {
  const out: Due[] = [];
  if (now <= after) return out;
  const wanted = new Set(prefs.prayers);
  if (wanted.size === 0) return out;

  // Two days either side of the window is ample: the window is seconds wide in practice, and
  // a lead time can only pull a send an hour earlier.
  const from = after - 36 * 60 * 60_000;
  const to = now + 36 * 60 * 60_000;

  /**
   * One prayer's two possible moments, filtered to the window.
   *
   * `key` is what the notification's tag is built from — a STABLE identifier, never the
   * masjid's own label. Two Jumu'ah jamā'āt that a masjid happens to have named the same thing
   * would otherwise share a tag, and the second would silently replace the first on the lock
   * screen. `only` restricts a call to one of the two moments.
   */
  const consider = (
    day: (typeof feed.days)[number],
    prayer: Notifiable,
    label: string,
    adhan: string | null,
    iqamah: string | null,
    key = prayer as string,
    only?: 'adhan' | 'iqamah',
  ) => {
    if (prefs.adhan && only !== 'iqamah' && isHhmm(adhan)) {
      const at = zonedTimeToEpoch(day.date, adhan, feed.timezone);
      if (at >= from && at <= to && at > after && at <= now) out.push({ at, prayer, date: day.date, kind: 'adhan', hhmm: adhan, label, key });
    }
    if (prefs.beforeIqamah !== null && only !== 'adhan' && isHhmm(iqamah)) {
      const at = zonedTimeToEpoch(day.date, iqamah, feed.timezone) - prefs.beforeIqamah * 60_000;
      if (at >= from && at <= to && at > after && at <= now) out.push({ at, prayer, date: day.date, kind: 'iqamah', hhmm: iqamah, label, key });
    }
  };

  for (const day of feed.days) {
    // **Jumu'ah STANDS IN FOR Dhuhr on the day it is held**, exactly as it does in the day view
    // (`slotsFor`). A Dhuhr reminder on a Friday would be a reminder about a jamā'ah the masjid
    // is not holding, at a time nobody is gathering.
    const jumuah = day.jumuah ?? [];
    const isJumuahDay = jumuah.length > 0;

    for (const prayer of PRAYERS) {
      if (prayer === 'dhuhr' && isJumuahDay) continue;
      if (!wanted.has(prayer)) continue;
      const p = day.prayers[prayer];
      consider(day, prayer, NAMES[prayer], p.adhan, p.iqamah);
    }

    if (isJumuahDay && wanted.has('jumuah')) {
      const held = jumuah.slice(0, MAX_JUMUAH);
      // `null` means every one the masjid holds — the default, and what a row written before
      // this choice existed reads as.
      let pick = held.map((_, i) => i).filter((i) => prefs.jumuah === null || prefs.jumuah.includes(i));

      // **A CHOSEN POSITION THAT IS NOT HELD THIS WEEK.** A masjid that drops from two
      // Jumu'ah to one would otherwise silence everyone who picked the second — permanently,
      // and with nothing on any screen to explain it. An explicitly empty list still means
      // none; it is only a non-empty choice that matched nothing which falls back, and it
      // falls back to the first, because that is the Jumu'ah the masjid is actually holding.
      if (pick.length === 0 && held.length > 0 && (prefs.jumuah === null || prefs.jumuah.length > 0)) pick = [0];

      // **ONE ADHAN, ONE REMINDER.** Display carries no per-Jumu'ah adhan — there is a single
      // adhan that day and it is Dhuhr's — so sending it once per chosen Jumu'ah would put two
      // or three identical notifications on a lock screen at the same second.
      if (prefs.adhan) {
        const anyAdhan = held.find((j) => j.adhan)?.adhan ?? day.prayers.dhuhr.adhan;
        // With one jamāʿah the adhan can carry its own name; with several it cannot claim any
        // one of them, because it is the single adhan for the day.
        const adhanLabel = held.length === 1 ? jumuahName(held, 0) : 'Jumuʿah';
        consider(day, 'jumuah', adhanLabel, anyAdhan, null, 'jumuah-adhan', 'adhan');
      }

      for (const i of pick) {
        const j = held[i];
        if (!j) continue;
        consider(day, 'jumuah', jumuahName(held, i), null, j.iqamah, `jumuah-${i}`);
      }
    }
  }

  return out.sort((a, b) => a.at - b.at);
}

/**
 * The words on the phone.
 *
 * Minimal and non-sensitive: a prayer name, a time, the masjid. Nothing auth-critical, nothing
 * personal, nothing that would matter on a lock screen someone else can see.
 */
export function notificationFor(due: Due, feed: TimetableFeed, lead: number | null, publicUrl: string): Notification {
  const when = formatTimeIn(due.date, due.hhmm, feed.timezone, feed.hourCycle, feed.language);
  const name = due.label;
  const body =
    due.kind === 'adhan'
      ? `Adhan ${when}`
      : lead && lead > 0
        ? `Jamāʿah in ${lead} minute${lead === 1 ? '' : 's'} — ${when}`
        : `Jamāʿah ${when}`;
  return {
    title: `${name} — ${feed.masjidName}`,
    body,
    // One tag per thing per day per kind, so a re-delivery replaces rather than stacks — but
    // two DIFFERENT Jumu'ah jamā'āt must not, since they are separate gatherings an hour
    // apart. Keyed on position rather than the masjid's label, which it may have set to the
    // same words for both.
    tag: `${due.date}:${due.key}:${due.kind}`,
    url: publicUrl || '/',
  };
}

/**
 * An announcement, as it will appear on a lock screen.
 *
 * The masjid's name is the TITLE and the notice is the body, matching the shape of a prayer
 * reminder — the first thing someone needs to know about a notification on their lock screen is
 * who it is from.
 *
 * The tag carries the send time, so two different notices both appear. A prayer reminder's tag
 * collapses a re-delivery of the SAME reminder, which is right; collapsing two unrelated
 * announcements into one would silently swallow the earlier one.
 */
export function announcementFor(text: string, masjidName: string, publicUrl: string, at: number): Notification {
  return {
    title: masjidName || 'Your masjid',
    body: text,
    tag: `announce:${at}`,
    url: publicUrl || '/',
  };
}

/** Why an announcement was refused, or '' when it was sent. */
export type AnnounceRefusal = '' | 'empty' | 'too-long' | 'cooldown' | 'nobody';

export interface AnnounceResult {
  refused: AnnounceRefusal;
  /** How many phones it actually reached. */
  sent: number;
  failed: number;
  pruned: number;
  /** How many were eligible — subscribers who have not turned announcements off. */
  audience: number;
}

export interface TimetableSnapshot {
  feed: TimetableFeed | null;
  /** ms epoch of the last successful read; 0 = never. */
  at: number;
}

export type SkipReason = '' | 'no-timetable' | 'stale' | 'no-subscribers';

export interface TickResult {
  sent: number;
  pruned: number;
  failed: number;
  skipped: SkipReason;
}

export class PushScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** So the admin panel can say something true about the last run. */
  lastRunAt = 0;
  lastSentAt = 0;
  lastSkip: SkipReason = '';
  /** ms epoch of the last announcement, for the cooldown. In memory on purpose: a restart is
   *  not a double-send, and the guard exists for the double-tap that happens in one session. */
  lastAnnouncedAt = 0;
  private alerted = false;

  constructor(
    private readonly subs: Subscriptions,
    private readonly vapid: Vapid,
    private readonly snapshot: () => TimetableSnapshot,
    private readonly publicUrl: () => string,
    /** Standing announcements. Optional so every existing test builds a scheduler without one
     *  and gets exactly the behaviour it had before. */
    private readonly schedules: Schedules | null = null,
    /** Injectable so a test drives it without real network or real waiting. */
    private readonly send = sendOne,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass. Never throws: a scheduler that dies takes every future reminder with it. */
  async tick(now = Date.now()): Promise<TickResult> {
    if (this.running) return { sent: 0, pruned: 0, failed: 0, skipped: '' };
    this.running = true;
    try {
      return await this.run(now);
    } catch (err) {
      log.warn(`scheduler tick failed: ${err instanceof Error ? err.message : String(err)}`);
      return { sent: 0, pruned: 0, failed: 0, skipped: '' };
    } finally {
      this.running = false;
      this.lastRunAt = now;
    }
  }

  private async run(now: number): Promise<TickResult> {
    const result: TickResult = { sent: 0, pruned: 0, failed: 0, skipped: '' };
    const { feed, at } = this.snapshot();

    if (!feed || at === 0) {
      this.lastSkip = 'no-timetable';
      result.skipped = 'no-timetable';
      return result;
    }

    /**
     * **Standing announcements go out BEFORE the staleness gate, and that is deliberate.**
     *
     * Rule 1 exists because a prayer reminder computed from two-day-old times may be wrong by
     * minutes and somebody acts on it. An announcement is not computed from the times at all —
     * "the masjid is closed on Saturday" is exactly as true when Display has been unreachable
     * since Thursday. Silencing it would be applying a rule to something the rule was not about,
     * and the thing it would silence is the masjid's own voice at the moment it has lost its
     * other one.
     *
     * The feed is still REQUIRED, for its `timezone` and nothing else: "every Friday at 11:00"
     * is a wall-clock time in the masjid's zone, and there is no honest fallback for not knowing
     * which zone that is (schedules.ts).
     */
    await this.runSchedules(now, feed);

    // Rule 1. The one refusal in this file that protects somebody rather than something.
    if (now - at > STALE_LIMIT_MS) {
      if (this.lastSkip !== 'stale') log.warn('prayer times are more than 48h old — notifications are paused rather than sent from stale data');
      this.lastSkip = 'stale';
      result.skipped = 'stale';
      return result;
    }

    const rows = this.subs.all();
    if (rows.length === 0) {
      this.lastSkip = 'no-subscribers';
      result.skipped = 'no-subscribers';
      return result;
    }
    this.lastSkip = '';

    const subject = vapidSubject(this.publicUrl());
    const url = this.publicUrl() || '/';
    // Rule 2: never reach further back than the grace window, however long we were away.
    const floor = now - GRACE_MS;

let attempted = 0;
    let failed = 0;

    // Worked out first, so the fan-out below is pure sending. A subscription with nothing due
    // still has its window advanced, or it re-scans the same span for ever.
    const work: { row: (typeof rows)[number]; due: Due[] }[] = [];
    for (const row of rows) {
      const due = dueFor(feed, row.prefs, Math.max(row.sentThrough, floor), now);
      if (due.length === 0) this.subs.markSent(row.id, now, false);
      else work.push({ row, due });
    }

    await fanOut(work, CONCURRENCY, async ({ row, due }) => {
      // Rule 4, once per subscription rather than once per notification: the point is to
      // decorrelate phones from each other, not a phone from itself.
      await this.sleep(Math.floor(Math.random() * JITTER_MS));

      let ok = false;
      let dead = false;
      for (const d of due) {
        attempted += 1;
        const outcome = await this.send(this.vapid, row, notificationFor(d, feed, row.prefs.beforeIqamah, url), subject);
        if (outcome === 'sent') {
          ok = true;
          result.sent += 1;
        } else if (outcome === 'gone') {
          dead = true;
          break;
        } else {
          failed += 1;
          result.failed += 1;
        }
      }

      if (dead) {
        // 404/410: the phone is gone. Pruned at once — keeping it means retrying a dead
        // endpoint for ever and inflating the count the admin is shown.
        log.debug(`pruning dead subscription ${safeEndpoint(row.endpoint)}`);
        this.subs.remove(row.endpoint);
        result.pruned += 1;
        return;
      }
      this.subs.markSent(row.id, now, ok);
      if (ok) this.lastSentAt = now;
    });

    await this.maybeAlert(attempted, failed);
    return result;
  }

  /**
   * Send one notice to everybody who wants them.
   *
   * **Not the prayer scheduler's window arithmetic.** An announcement is a thing the admin did,
   * once, now — there is nothing to compute, nothing to be idempotent about, and `sentThrough`
   * is deliberately NOT advanced: a broadcast must not silently swallow a prayer reminder that
   * happened to be due in the same second.
   *
   * Refuses rather than half-sends: an empty notice, one over the length a lock screen shows,
   * or a second one inside the cooldown. That last is an accident guard, not a policy about how
   * much a masjid may say to its own congregation — it stops a double-tap or a retried request
   * from sending the same notice to everyone twice, which is not undoable.
   */
  async announce(text: string, masjidName: string, now = Date.now()): Promise<AnnounceResult> {
    const body = text.replace(/\s+/g, ' ').trim();
    const none: AnnounceResult = { refused: '', sent: 0, failed: 0, pruned: 0, audience: 0 };
    if (!body) return { ...none, refused: 'empty' };
    if (body.length > ANNOUNCE_MAX_CHARS) return { ...none, refused: 'too-long' };
    if (now - this.lastAnnouncedAt < ANNOUNCE_COOLDOWN_MS) return { ...none, refused: 'cooldown' };

    // Claimed BEFORE the first send. Two requests arriving together must not both get past the
    // cooldown while the first is still working its way down a list of five hundred phones.
    this.lastAnnouncedAt = now;
    return this.broadcast(body, masjidName, now);
  }

  /**
   * Every phone that wants notices gets one notice.
   *
   * Split out of `announce` when standing announcements arrived, so a scheduled send takes the
   * same path without taking the **cooldown** with it. That guard is about a human double-tap:
   * two requests a second apart are one intention. A schedule firing forty seconds after
   * somebody pressed Send is two intentions, and swallowing the second would be a notice that
   * silently never went out — which is the failure this feature exists to prevent.
   *
   * Each schedule's own `firedThrough` is what stops IT sending twice.
   */
  private async broadcast(body: string, masjidName: string, now: number): Promise<AnnounceResult> {
    const none: AnnounceResult = { refused: '', sent: 0, failed: 0, pruned: 0, audience: 0 };
    const rows = this.subs.all().filter((r) => r.prefs.announcements);
    if (rows.length === 0) return { ...none, refused: 'nobody' };

    const url = this.publicUrl() || '/';
    const subject = vapidSubject(this.publicUrl());
    const payload = announcementFor(body, masjidName, url, now);
    const result: AnnounceResult = { refused: '', sent: 0, failed: 0, pruned: 0, audience: rows.length };

    // Concurrent, for the same reason as the tick — and here it is also what the admin is
    // waiting on: a sequential broadcast to a congregation's worth of phones would leave them
    // watching a spinner for minutes.
    await fanOut(rows, CONCURRENCY, async (row) => {
      await this.sleep(Math.floor(Math.random() * JITTER_MS));
      const outcome = await this.send(this.vapid, row, payload, subject);
      if (outcome === 'sent') result.sent += 1;
      else if (outcome === 'gone') {
        this.subs.remove(row.endpoint);
        result.pruned += 1;
      } else result.failed += 1;
    });

    // The TEXT is not logged. It is the masjid's message to its congregation, and a log is a
    // file somebody else may read; the counts are what an operator actually needs.
    log.info(`announcement sent to ${result.sent} of ${result.audience} phones (${result.pruned} pruned, ${result.failed} failed)`);
    return result;
  }

  /**
   * Standing announcements whose moment has come round.
   *
   * Sequential over the schedules on purpose — a masjid has one or two, and two notices landing
   * on a lock screen in the same second is worse than one landing a second after the other.
   *
   * A missed occurrence is marked as dealt with WITHOUT sending (`dueAction` returns `skip`),
   * so a box that was off over the weekend comes back silent rather than delivering Friday's
   * reminder on Sunday morning. Never throws: a broken schedule must not take the prayer
   * reminders in the same tick down with it.
   */
  private async runSchedules(now: number, feed: TimetableFeed): Promise<void> {
    if (!this.schedules) return;
    let list;
    try {
      list = this.schedules.all().filter((x) => x.enabled);
    } catch (err) {
      log.warn(`could not read the announcement schedules: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    for (const s of list) {
      const due = dueAction(s, now, feed.timezone);
      if (!due) continue;

      if (due.action === 'skip') {
        log.info(`a scheduled announcement was missed while this app was not running — skipped rather than sent late`);
        this.schedules.markFired(s.id, due.at, false);
        if (s.repeat === 'once') this.schedules.finishOnce(s.id);
        continue;
      }

      // Marked BEFORE the send, not after. A crash or a restart part-way through a broadcast
      // must not leave the occurrence looking undelivered — re-running it would send the same
      // notice to everyone who already had it, and that is the half of this that cannot be
      // taken back. Under-delivering to some phones is recoverable; double-sending is not.
      this.schedules.markFired(s.id, due.at, true);
      if (s.repeat === 'once') this.schedules.finishOnce(s.id);

      const out = await this.broadcast(s.text, feed.masjidName ?? '', now);
      if (out.refused) log.info(`a scheduled announcement was not sent: ${out.refused}`);
      else this.lastSentAt = now;
    }
  }

  /**
   * Bulk rejection is an alert; one dead phone is not.
   *
   * Once per episode, and only when a real majority of a real number of attempts failed —
   * an alert per failed send would be a way of telling the admin nothing.
   */
  private async maybeAlert(attempted: number, failed: number): Promise<void> {
    const bad = attempted >= FLEET_FAIL_MIN && failed / attempted >= FLEET_FAIL_RATIO;
    if (!bad) {
      this.alerted = false; // the episode is over; the next one may alert again
      return;
    }
    if (this.alerted) return;
    this.alerted = true;
    log.warn(`${failed} of ${attempted} prayer notifications were rejected — raising the push-failing alert`);
    await raiseAlert('push-failing', `${failed} of ${attempted} prayer reminders were rejected by the phones' push services.`);
  }
}
