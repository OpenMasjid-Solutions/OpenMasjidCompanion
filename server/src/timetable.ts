// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * timetable.ts — the client for OpenMasjid Display's `timetable` capability.
 *
 * **Display owns the times. This app never calculates one** (CLAUDE.md §2). Everything here
 * either faithfully carries what Display sent or refuses it; there is no branch anywhere in
 * this file that produces a time.
 *
 * The shapes below are Companion's copy of the `Fabric*` interfaces in Display's
 * `server/src/fabricTimetable.ts`, which is the authoritative contract (recorded in
 * docs/DISPLAY_TIMETABLE_WORK_ORDER.md). Two details there are easy to get wrong from the prose
 * alone and were read off the real source:
 *
 *   • `sunrise` is a sibling of `prayers`, NOT a member of it.
 *   • `prayers.*.iqamah` is nullable — a masjid can publish an Adhan with no jamā'ah time.
 *
 * Everything crossing this boundary is parsed with zod. It is another app's output arriving
 * over a network, and it ends up as the prayer times a congregation organises its day by.
 */
import { z } from 'zod';
import { type BrokerResult, brokerCall } from './fabric';
import { makeLog } from './logger';

const log = makeLog('timetable');

export const PRAYER_KEYS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] as const;
export type PrayerKey = (typeof PRAYER_KEYS)[number];

/** 24-hour wall clock, always, whatever `hourCycle` says — that field is presentation. */
const HHMM = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:mm');

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/**
 * An IANA zone this runtime can actually resolve.
 *
 * The single most consequential field in the payload, and the one whose failure is silent:
 * an unrecognised zone makes every conversion fall back to the container's own clock, which
 * is UTC. Every prayer time and every push notification would then be out by the masjid's whole
 * offset — correct-looking, and wrong. Display promises the zone it actually COMPUTED in
 * (see the work order's "Two properties worth relying on"), so a value we cannot resolve means
 * something is badly wrong and the right answer is to refuse the payload, not to guess.
 */
const TIMEZONE = z.string().min(1).max(80).refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat('en-GB', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'not an IANA timezone this runtime knows' },
);

const PrayerSchema = z.object({
  adhan: HHMM.nullable(),
  /** Nullable: a timetable may publish an Adhan with no jamā'ah time set. */
  iqamah: HHMM.nullable(),
});

const JumuahSchema = z.object({
  label: z.string().max(120),
  /** ALWAYS null from Display — Jumu'ah is configured as jamā'ah times only. Carried so the
   *  shape matches, never rendered. See divergence 1 in the work order. */
  adhan: HHMM.nullable(),
  iqamah: HHMM,
});

const DaySchema = z.object({
  date: ISO_DATE,
  hijri: z.object({ label: z.string().max(200) }),
  /** Astronomical Shurūq. `.catch(null)` rather than `.optional()`: an older Display that
   *  omits it, or sends something odd, should cost us the sunrise ROW — not the whole day's
   *  prayer times. */
  sunrise: HHMM.nullable().catch(null),
  prayers: z.object({
    fajr: PrayerSchema,
    dhuhr: PrayerSchema,
    asr: PrayerSchema,
    maghrib: PrayerSchema,
    isha: PrayerSchema,
  }),
  /** `[]` on every day that is not a Friday in the MASJID's zone. Never carried forward —
   *  showing a Jumu'ah row on a Tuesday asserts a jamā'ah that does not happen. */
  jumuah: z.array(JumuahSchema).max(16).catch([]),
});

export const FeedSchema = z.object({
  v: z.number(),
  id: z.string().min(1).max(200),
  /** The admin's PRIVATE label ("Women's section"). Admin picker only — never the musalli page. */
  name: z.string().max(200),
  masjidName: z.string().max(200),
  timezone: TIMEZONE,
  language: z.string().max(16),
  hourCycle: z.enum(['12', '24']),
  /** 45 is Display's cap; the ceiling here is a sanity bound, not a contract. */
  days: z.array(DaySchema).max(60),
});

export const ListSchema = z.object({
  v: z.number(),
  timetables: z.array(z.object({ id: z.string().min(1).max(200), name: z.string().max(200) })).max(200),
});

export type TimetableFeed = z.infer<typeof FeedSchema>;
export type TimetableDay = z.infer<typeof DaySchema>;
export type TimetableSummary = z.infer<typeof ListSchema>['timetables'][number];

/** Parse or return null. `brokerCall` turns null into a `bad_payload` failure, so a malformed
 *  answer degrades a feature rather than throwing inside a request. */
function parseWith<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, label: string): (raw: unknown) => T | null {
  return (raw) => {
    const r = schema.safeParse(raw);
    if (r.success) return r.data;
    log.warn(`${label} payload rejected: ${r.error.issues[0]?.path.join('.')} — ${r.error.issues[0]?.message}`);
    return null;
  };
}

/** Every timetable the admin has in Display, for the picker. */
export async function listTimetables(): Promise<BrokerResult<z.infer<typeof ListSchema>>> {
  return brokerCall('display', 'timetable', 'list', {}, parseWith(ListSchema, 'list'));
}

/** Display's cap. Asking for more is a `400 bad_request`, i.e. our bug. */
export const MAX_DAYS = 45;

/**
 * A window of days for one timetable.
 *
 * `from` is a date in the MASJID's calendar, not ours — the caller works it out from the
 * timezone in the last good feed, because the container's own today can be the wrong day
 * either side of midnight anywhere far from UTC.
 */
export async function getTimetable(id: string, from: string, days: number): Promise<BrokerResult<TimetableFeed>> {
  const clamped = Math.max(1, Math.min(MAX_DAYS, Math.trunc(days)));
  return brokerCall('display', 'timetable', 'get', { id, from, days: clamped }, parseWith(FeedSchema, 'get'));
}
