// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * bearing.ts — which way is Makkah, and which way is the phone pointing.
 *
 * Named for what it holds rather than for the screen that uses it, and NOT `qibla.ts`: this
 * repository is developed on a case-insensitive filesystem, where `qibla.ts` and `Qibla.tsx`
 * are the same name and `import './Qibla'` resolves to whichever TypeScript saw first. The
 * same split as `Notify.tsx`/`reminders.ts` and `Today.tsx`/`prayerTimes.ts`.
 *
 * **This is not a prayer-time calculation and does not touch the CLAUDE.md §2 rule.** The
 * distinction is not a technicality: a wrong prayer time is silent and unfalsifiable, so this
 * app refuses to compute one and reads Display's instead. A wrong bearing is neither — hold the
 * phone up and a compass pointing at the car park is obviously wrong. `docs/DESIGN_LANGUAGE.md`
 * records Hasan's decision on 2026-08-24 and the work order that was withdrawn because of it.
 *
 * Two separate problems live here, and only the first is arithmetic:
 *
 *  1. **The bearing** — a great-circle heading from the device's own position to the Kaaba.
 *     Pure, exact, and the same answer every time. It is what the screen leads with.
 *  2. **The heading** — which way the phone is physically pointing, from the magnetometer.
 *     Needs a permission on iOS, needs a user gesture, is absent on most laptops, and is
 *     wrong indoors near steel. So it is an ENHANCEMENT layered on top, never the thing the
 *     screen depends on: the bearing and a north-up dial are useful with no compass at all.
 */

/** The Kaaba. The one constant in this app that will never need a setting. */
export const KAABA = { lat: 21.4225, lon: 39.8262 };

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Fold any angle into [0, 360). Written once because `%` on a negative gives a negative. */
export function norm360(d: number): number {
  return ((d % 360) + 360) % 360;
}

/** The signed difference from `a` to `b`, in (-180, 180]. Positive = clockwise. What "turn
 *  right by 40°" is computed from. */
export function angleDelta(a: number, b: number): number {
  const d = norm360(b - a);
  return d > 180 ? d - 360 : d;
}

/**
 * The initial great-circle bearing from a position to the Kaaba, in degrees clockwise from
 * true north.
 *
 * The **initial** bearing of the great circle, which is what "face the Qibla" means and is not
 * the same as the bearing you would read off a flat map. On a Mercator projection the line from
 * London to Makkah looks like it points south-east; the great circle leaves London at 119°,
 * which is also south-east — but from New York the two disagree by nearly forty degrees, and it
 * is the great circle that is right.
 *
 * Returns null AT the Kaaba and at its exact antipode, where there is no answer rather than a
 * wrong one: every direction is towards Makkah from one and away from it from the other. Both
 * are unreachable in practice and both make `atan2(0, 0)` return 0, which would silently claim
 * "due north".
 */
export function qiblaBearing(lat: number, lon: number): number | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const φ1 = rad(lat);
  const φ2 = rad(KAABA.lat);
  const Δλ = rad(KAABA.lon - lon);

  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  // Both components vanish only when the two points are the same or exactly opposite. `atan2`
  // answers 0 for that, and "due north" is not a thing this should ever say without meaning it.
  if (Math.abs(y) < 1e-12 && Math.abs(x) < 1e-12) return null;
  return norm360(deg(Math.atan2(y, x)));
}

/**
 * The great-circle distance to the Kaaba in kilometres.
 *
 * Not needed to point anywhere — it is on screen because it is the one number that tells
 * somebody the bearing was computed from where they actually are. "1,240 km" from a phone in
 * Cairo is a sanity check anybody can perform; a bearing on its own is not.
 */
export function distanceToKaaba(lat: number, lon: number): number {
  const R = 6371;
  const φ1 = rad(lat);
  const φ2 = rad(KAABA.lat);
  const Δφ = rad(KAABA.lat - lat);
  const Δλ = rad(KAABA.lon - lon);
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The sixteen points of the compass, so a bearing can be said in words as well as in degrees.
 *  A number is exact; a name is what somebody can act on while looking at a room. */
const POINTS = [
  'north', 'north-northeast', 'northeast', 'east-northeast',
  'east', 'east-southeast', 'southeast', 'south-southeast',
  'south', 'south-southwest', 'southwest', 'west-southwest',
  'west', 'west-northwest', 'northwest', 'north-northwest',
];

export function compassPoint(bearing: number): string {
  return POINTS[Math.round(norm360(bearing) / 22.5) % 16];
}

/**
 * `DeviceOrientationEvent`, minus the parts the DOM lib does not know about.
 *
 * `webkitCompassHeading` is Apple's own and is not in any standard. It is also the ONLY way to
 * get a true heading on an iPhone: Safari's `alpha` is relative to wherever the page happened to
 * start, so a standards-only reading points a confident arrow at nothing in particular.
 */
export interface OrientationLike {
  alpha: number | null;
  absolute?: boolean;
  webkitCompassHeading?: number;
  /** Apple's own accuracy figure, in degrees. -1 means the magnetometer is not calibrated. */
  webkitCompassAccuracy?: number;
}

/**
 * Which way the top of the screen is pointing, in degrees clockwise from north — or null when
 * the event does not actually know.
 *
 * **`absolute` is checked, and that check is the whole difference between a compass and a
 * decoration.** A non-absolute `deviceorientation` event reports rotation relative to an
 * arbitrary starting frame, which on Android is whatever way the phone was facing when the page
 * loaded. Using it would produce an arrow that moves correctly as the phone turns and points
 * somewhere meaningless — the worst possible failure for this screen, because it looks like it
 * is working.
 *
 * `screenAngle` is `screen.orientation.angle`: 0 in portrait, which is how this app is
 * installed (`orientation: 'portrait'` in the manifest) and the case that is certainly right.
 * The correction only does anything for somebody who has rotated a browser tab.
 */
export function headingFrom(e: OrientationLike, screenAngle = 0): number | null {
  // iOS: already a true heading, already clockwise from north.
  if (typeof e.webkitCompassHeading === 'number' && Number.isFinite(e.webkitCompassHeading)) {
    // -1 is Apple's "the magnetometer needs calibrating". Treated as no reading at all rather
    // than as a number, because a figure-of-eight wave is a thing the screen can ask for.
    if (e.webkitCompassAccuracy !== undefined && e.webkitCompassAccuracy < 0) return null;
    return norm360(e.webkitCompassHeading + screenAngle);
  }
  if (e.absolute !== true || typeof e.alpha !== 'number' || !Number.isFinite(e.alpha)) return null;
  // `alpha` turns anticlockwise from north; a compass heading turns clockwise.
  return norm360(360 - e.alpha + screenAngle);
}

/** How close counts as "facing it". Wide enough that a hand-held phone does not flicker in and
 *  out of it, narrow enough to mean something: at 8° the Kaaba is still comfortably inside the
 *  span of a prayer row. */
export const ALIGNED_DEG = 8;

export function isAligned(heading: number, bearing: number): boolean {
  return Math.abs(angleDelta(heading, bearing)) <= ALIGNED_DEG;
}

/**
 * The remembered answer.
 *
 * **The BEARING is stored, never the position.** One number, on the reader's own phone, that
 * never leaves it — where a stored latitude and longitude would be a record of where somebody
 * was, sitting in a browser store for anybody who later picks up the phone. It is all the
 * screen needs, and refusing to write the rest down is cheaper than protecting it.
 *
 * Kept for a month. A bearing does not change unless the reader travels, and somebody who has
 * travelled can press the button again — which is a better trade than asking a congregation for
 * their location every Friday.
 */
const KEY = 'omc-qibla';
export const REMEMBER_MS = 30 * 86_400_000;

export interface Remembered {
  bearing: number;
  /** Kilometres to the Kaaba, for the sanity line. Rounded on the way in — it is a reassurance,
   *  not a measurement, and a metre of precision would be a smaller number about the phone. */
  km: number;
  at: number;
}

export function remember(bearing: number, km: number, now = Date.now()): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ bearing, km: Math.round(km), at: now } satisfies Remembered));
  } catch {
    /* private browsing — it just will not persist */
  }
}

export function recall(now = Date.now()): Remembered | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Remembered>;
    if (typeof v.bearing !== 'number' || typeof v.at !== 'number') return null;
    if (!Number.isFinite(v.bearing) || now - v.at > REMEMBER_MS) return null;
    return { bearing: norm360(v.bearing), km: typeof v.km === 'number' ? v.km : 0, at: v.at };
  } catch {
    return null;
  }
}

export function forget(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to do, and nothing that matters */
  }
}
