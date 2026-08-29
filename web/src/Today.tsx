// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The musalli's page: which prayer is on, how long until the next, and the day's timetable.
 *
 * The design follows docs/DESIGN_LANGUAGE.md. What matters underneath it:
 *
 *  • **Every time on this page came from Display.** Nothing here computes one.
 *  • **Every time is the MASJID's wall clock**, in the timezone the payload carries — not the
 *    reader's. Someone opening this in another country sees the masjid's times, as they read on
 *    the wall inside the building.
 *  • **Old data says so.** A stale marker is what makes serving a cache honest at all.
 *  • **The IQAMAH is the answer to the question.** A musalli checking their phone is deciding
 *    when to leave the house, and that is the jamā'ah time. The Adhan is context beside it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, CalendarDays, ChevronLeft, ChevronRight, Clock3 } from 'lucide-react';
import {
  type Day,
  type DailyKey,
  type Masjid,
  type MonthMarks,
  type PeriodKey,
  type Slot,
  MONTH_MARKS,
  changedOn,
  formatDate,
  formatTime,
  formatUntil,
  periodOf,
  positionAt,
  slotTime,
  slotsFor,
  todayInZone,
  zonedTimeToEpoch,
} from './prayerTimes';
import { Month } from './Month';
import { useSwipe } from './swipe';
import { MasjidLogo, Note } from './ui';

export interface Timetable {
  configured: boolean;
  at: number;
  stale: boolean;
  masjid: Masjid | null;
  days: Day[];
  /** Which jamā'āt the month view marks as changed. Optional because a phone can be holding a
   *  service-worker cache of a payload written before this setting existed, and a month view
   *  that throws on an old cache is a worse bug than one that marks the default days. */
  marks?: MonthMarks;
}

/** Re-render often enough that the countdown stays true to the minute, and no more. A page left
 *  open on a shelf in the prayer hall should not be repainting every second. */
function useMinuteTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // Line up with the start of the next minute so the countdown changes when the clock does,
    // rather than up to 59 seconds late.
    let interval: ReturnType<typeof setInterval> | undefined;
    const align = setTimeout(() => {
      setNow(Date.now());
      interval = setInterval(() => setNow(Date.now()), 60_000);
    }, 60_000 - (Date.now() % 60_000));
    return () => {
      clearTimeout(align);
      if (interval) clearInterval(interval);
    };
  }, []);
  return now;
}

export function Today({ data, onPeriod }: { data: Timetable; onPeriod: (period: PeriodKey) => void }): JSX.Element {
  const now = useMinuteTick();
  const [offset, setOffset] = useState(0);
  const [view, setView] = useState<'day' | 'month'>('day');
  /** Which way the last day change went, so the new day slides in from the side it came from. */
  const [slide, setSlide] = useState<'next' | 'prev' | null>(null);

  const masjid = data.masjid;
  const zone = masjid?.timezone ?? 'UTC';

  const todayIndex = useMemo(() => {
    const today = todayInZone(now, zone);
    const i = data.days.findIndex((d) => d.date === today);
    return i >= 0 ? i : 0;
  }, [data.days, now, zone]);

  const index = Math.min(data.days.length - 1, Math.max(0, todayIndex + offset));
  const day = data.days[index];

  // The hero always reports NOW, whichever day the table below is showing. Someone browsing
  // ahead to next Friday still wants to know how long until Maghrib today.
  const position = useMemo(() => positionAt(data.days, zone, now), [data.days, zone, now]);
  const period = periodOf(position);

  /**
   * Tell the shell which part of the day it is, so the whole page can be themed for it.
   *
   * Reported upward rather than applied here because it sets an attribute on the ROOT element —
   * the sky, the ink and the glass all key off it, and they sit outside this component.
   */
  useEffect(() => {
    if (masjid) onPeriod(period);
  }, [period, masjid, onPeriod]);

  const step = useCallback(
    (by: 1 | -1) => {
      setOffset((o) => {
        const next = Math.min(data.days.length - 1, Math.max(0, todayIndex + o + by)) - todayIndex;
        if (next !== o) setSlide(by === 1 ? 'next' : 'prev');
        return next;
      });
    },
    [data.days.length, todayIndex],
  );

  const swipe = useSwipe(
    useCallback(() => step(1), [step]),
    useCallback(() => step(-1), [step]),
  );

  if (!masjid || !day) return <NotSetUp />;

  const slots = slotsFor(day);
  const isToday = index === todayIndex;
  /** Which jamā'āt this masjid changed on this day. The same rule the month view marks with. */
  const changed = changedOn(data.days, day.date, data.marks ?? MONTH_MARKS);

  if (view === 'month') {
    return (
      <Month
        days={data.days}
        masjid={masjid}
        marks={data.marks ?? MONTH_MARKS}
        today={data.days[todayIndex]?.date ?? day.date}
        anchor={day.date}
        onAnchor={(date) => {
          const i = data.days.findIndex((d) => d.date.slice(0, 7) === date.slice(0, 7));
          if (i >= 0) setOffset(i - todayIndex);
        }}
        onPick={(date) => {
          const i = data.days.findIndex((d) => d.date === date);
          if (i >= 0) setOffset(i - todayIndex);
          setSlide(null);
          setView('day');
        }}
        onClose={() => setView('day')}
      />
    );
  }

  return (
    <main className="today" {...swipe}>
      <section className="hero">
        <h1 className="hero__now">{position.label || masjid.name}</h1>
        {position.next && (
          <p className="hero__until tnum">
            {formatUntil(position.until)} until {position.next.label}
          </p>
        )}
      </section>

      <Arc slots={slots} day={day} zone={zone} now={now} isToday={isToday} />

      <div className="todaybar">
        {isToday ? (
          <span className="arc__chip">Today</span>
        ) : (
          // An arrow pointing back the way today lies, so it reads as "go back to today" rather
          // than as a label. Replaces a chip that used to print the weekday, which was both
          // redundant — the full date is directly below it — and wrong (it printed the comma).
          <button className="arc__chip arc__chip--btn" onClick={() => { setSlide(offset > 0 ? 'prev' : 'next'); setOffset(0); }}>
            {offset > 0 && <ChevronLeft size={14} aria-hidden="true" />}
            Today
            {offset < 0 && <ChevronRight size={14} aria-hidden="true" />}
          </button>
        )}
      </div>

      <div className="datebar">
        <button className="datebar__btn" onClick={() => step(-1)} disabled={index <= 0} aria-label="Previous day">
          <ChevronLeft size={22} aria-hidden="true" />
        </button>
        <div className="datebar__main">
          <div className="datebar__greg">{formatDate(day.date, masjid.language)}</div>
          {/* Display's own already-localised label. This app never computes or reformats a
              Hijri date — see the work order's divergence 5. */}
          <div className="datebar__hijri">{day.hijri.label}</div>
        </div>
        <button className="datebar__btn" onClick={() => step(1)} disabled={index >= data.days.length - 1} aria-label="Next day">
          <ChevronRight size={22} aria-hidden="true" />
        </button>
        <button className="datebar__btn" onClick={() => setView('month')} aria-label="This month">
          <CalendarDays size={20} aria-hidden="true" />
        </button>
      </div>

      {/* Keyed on the date so a day change remounts and the slide replays. */}
      <div className="times" key={day.date} data-slide={slide ?? undefined} role="table" aria-label={`Prayer times for ${formatDate(day.date, masjid.language)}`}>
        <div className="time-head" role="row">
          <span role="columnheader">
            <span className="sr-only">Prayer</span>
          </span>
          <span role="columnheader">Adhan</span>
          <span role="columnheader">Iqamah</span>
        </div>
        {slots.map((slot, i) => (
          <TimeRow
            key={`${slot.key}-${i}`}
            slot={slot}
            masjid={masjid}
            state={rowState(slot, day.date, zone, now, isToday, position.current?.at ?? 0)}
            changed={changed.has(slot.key as DailyKey)}
          />
        ))}
      </div>

      {data.stale && <StaleNote at={data.at} />}
    </main>
  );
}

type RowState = 'past' | 'now' | 'future';

/** Which prayers have been and which is on. Only ever applied to the day actually in progress:
 *  highlighting a row on next Tuesday's table would be meaningless. */
function rowState(slot: Slot, date: string, zone: string, now: number, isToday: boolean, currentAt: number): RowState {
  const hhmm = slotTime(slot);
  if (!isToday || !hhmm) return 'future';
  const at = zonedTimeToEpoch(date, hhmm, zone);
  if (at === currentAt) return 'now';
  return at < now ? 'past' : 'future';
}

/**
 * One row: prayer, Adhan, Iqamah — under real column headings.
 *
 * **The Iqamah is the larger of the two**, because it is the one being asked about: a musalli
 * looking at their phone is working out when to leave, and that is the jamā'ah. The Adhan sits
 * beside it, smaller, as the context that makes it make sense.
 *
 * Headed columns also quietly fix a Friday problem. Every Jumu'ah that day carries the same
 * Adhan — Display has no per-Jumu'ah one — so two rows show an identical Adhan and different
 * Iqamahs. Unlabelled, that reads as a mistake; under a heading it reads as exactly what it is.
 *
 * Marked up with ARIA table roles rather than a <table>: the current prayer is outlined as a
 * whole row, which is awkward on table cells, and CSS grid gives the alignment for nothing.
 */
function TimeRow({ slot, masjid, state, changed }: { slot: Slot; masjid: Masjid; state: RowState; changed: boolean }): JSX.Element {
  const cls = ['time-row', state === 'past' && 'time-row--past', state === 'now' && 'time-row--now', slot.sunEvent && 'time-row--sun']
    .filter(Boolean)
    .join(' ');
  const fmt = (t: string | null) => formatTime(t, masjid.hourCycle, masjid.language);

  // A sun event has no jamā'ah at all. Rather than an empty Iqamah cell — which leaves the time
  // stranded under one of two headings that does not apply to it — its one time spans both
  // columns and centres between them, so the row reads as "this is not a jamā'ah" at a glance.
  if (slot.sunEvent) {
    return (
      <div className={cls} role="row">
        <span className="time-row__name" role="cell">
          {slot.label}
        </span>
        {/* Two columns' worth of one cell. Without `aria-colspan` this row would be one cell
            short of every other row, and a screen reader walking the table column by column
            would report it as ragged. */}
        <span className="time-row__suntime tnum" role="cell" aria-colspan={2}>
          {fmt(slot.adhan)}
        </span>
      </div>
    );
  }

  return (
    <div className={cls} role="row">
      <span className="time-row__name" role="cell">
        {slot.label}
      </span>
      <span className="time-row__adhan tnum" role="cell">
        {fmt(slot.adhan)}
      </span>
      {/* Coloured when this is the day the masjid changed this jamā'ah — the same comparison the
          month view marks the day with. No note beside it: someone who knows their usual time
          sees that this one is not it, and someone who does not is unaffected.

          The words are for a screen reader, which gets nothing at all from a colour. They are
          in the same `.sr-only` the column headings use, so nothing is added to the page a
          sighted reader can see — the ask was no visible note, not no information. */}
      <span className={changed ? 'time-row__iqamah time-row__iqamah--changed tnum' : 'time-row__iqamah tnum'} role="cell">
        {fmt(slot.iqamah)}
        {changed && <span className="sr-only">, Iqamah changed</span>}
      </span>
    </div>
  );
}

/**
 * The day as an arc, with the prayers along it and a marker at now.
 *
 * A cubic Bézier evaluated directly rather than measured through the DOM, so it renders
 * identically on the server-built HTML, in a screenshot, and on a phone. `pathLength="1"`
 * normalises the curve so the travelled portion is a plain fraction.
 *
 * THE GEOMETRY IS THE POINT, and three things about it are deliberate (Hasan, 2026-08-29,
 * matching the reference app in docs/DESIGN_LANGUAGE.md):
 *
 *  - **It runs edge to edge.** The path starts and ends at x = 0 and x = W with no inset, and
 *    the CSS pulls the SVG out through the page's own side padding, so the curve leaves the
 *    screen rather than stopping short of it inside a column of text.
 *  - **A cubic, not a quadratic.** Control points at 0.28W and 0.72W flatten the top and steepen
 *    the shoulders. Worth being honest about the size of this one: normalised to the same
 *    height it is only about three units away from the parabola it replaced, and most of what
 *    reads as a different shape is the band being 0.275 of the width rather than 0.208. The
 *    cubic is here because it is the family that can be tuned toward the reference at all — the
 *    quadratic has one control point and therefore one degree of freedom, which is the height.
 *  - **The viewBox is the path's own bounds.** The old one reserved 71 units of empty space
 *    above the peak, which is the whole of the gap that made the arc sit too far below the
 *    countdown. Only the stroke and the "now" marker's radius are padded for.
 */
const W = 320;
/** Band height. 0.275 of the width, taken from the reference: a shallower arc reads as a slouch
 *  rather than an arc, and a taller one crowds the times below it. */
const H = 88;

/**
 * THE SHAPE, and why it is two segments rather than one.
 *
 * A sunrise-to-sunset trajectory is not symmetric and it is not an arc. Hasan described the
 * reference precisely: flat along the horizon at the far left; a quick, steep climb through the
 * morning; flattening as it approaches the top; almost LEVEL across the middle rather than a
 * peak; then a descent that is gentler and more stretched than the climb was; and a sharper
 * drop again as it reaches the right edge.
 *
 * One cubic cannot do that. A single segment has one tangent at each end and no way to be
 * steeper on one side of its maximum than the other — every symmetric-control cubic, and every
 * quadratic, is a hill with matching flanks. Two segments meeting at the summit have four
 * tangents to spend, which is exactly the number that description needs:
 *
 *   • horizontal at the far left     → "almost flat near the horizon"
 *   • horizontal arriving at the top → "gradually flattens out"
 *   • horizontal leaving the top     → "becomes almost level"
 *   • DESCENDING at the right edge   → "drops more noticeably toward the horizon"
 *
 * The numbers are a least-squares fit to ten points sampled off the reference screenshot, not a
 * guess: 1.8% RMS against a band of 1.0, worst point 3.8%. The summit sits at 0.436 of the
 * width — left of centre, which is what makes the descent the longer half.
 */
const PEAK_X = W * 0.436;
const ARC_SEGS = [
  // Up: flat at the horizon, steep through the middle, level at the summit.
  { p0: { x: 0, y: H }, c1: { x: W * 0.126, y: H }, c2: { x: W * 0.253, y: 0 }, p3: { x: PEAK_X, y: 0 } },
  // Down: a long level top, then a stretched descent that steepens into the right edge.
  { p0: { x: PEAK_X, y: 0 }, c1: { x: W * 0.769, y: 0 }, c2: { x: W * 0.781, y: H * 0.72 }, p3: { x: W, y: H } },
];

const ARC_D = ARC_SEGS.map(
  (g, i) => `${i === 0 ? `M ${g.p0.x} ${g.p0.y} ` : ''}C ${g.c1.x} ${g.c1.y} ${g.c2.x} ${g.c2.y} ${g.p3.x} ${g.p3.y}`,
).join(' ');

type Pt = { x: number; y: number };

/** A point on one segment, at that segment's own Bézier parameter. */
function bezier(seg: (typeof ARC_SEGS)[number], t: number): Pt {
  const u = 1 - t;
  return {
    x: u ** 3 * seg.p0.x + 3 * u ** 2 * t * seg.c1.x + 3 * u * t ** 2 * seg.c2.x + t ** 3 * seg.p3.x,
    y: u ** 3 * seg.p0.y + 3 * u ** 2 * t * seg.c1.y + 3 * u * t ** 2 * seg.c2.y + t ** 3 * seg.p3.y,
  };
}

/**
 * Cumulative chord length along the WHOLE path, sampled once.
 *
 * **A curve's parameter is not its length**, and with two segments it is not even continuous:
 * the summit is halfway through the path by parameter but not by distance, because the climb is
 * shorter than the descent. Everything visible is placed by length, so this table is what makes
 * the dots and the marker agree with a stroke the browser measures its own way.
 *
 * Computed at module load because the geometry is constant — nothing here depends on the day or
 * the clock.
 */
const ARC_TABLE = (() => {
  const PER_SEG = 240;
  const pts: Pt[] = [];
  const cum: number[] = [0];
  ARC_SEGS.forEach((seg, i) => {
    // The join is one point, not two: segment n's end and segment n+1's start are the summit.
    for (let k = i === 0 ? 0 : 1; k <= PER_SEG; k += 1) pts.push(bezier(seg, k / PER_SEG));
  });
  for (let i = 1; i < pts.length; i += 1) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  return { pts, cum, total: cum[cum.length - 1] };
})();

/**
 * The point a given fraction of the way ALONG the path.
 *
 * The progress stroke is drawn with `pathLength="1"` and a `stroke-dasharray`, which the
 * browser measures by LENGTH. Placing the dots and the "now" marker at a Bézier parameter
 * instead left the marker floating up to 8px past the end of the very line it caps, and the
 * coral reaching a dot did not mean that prayer had passed.
 *
 * Interpolated between samples rather than solved: the arc length of a cubic has no closed
 * form, and 480 chords is well under a pixel at any size this renders at.
 */
function pointAtFraction(f: number): Pt {
  const { pts, cum, total } = ARC_TABLE;
  const target = Math.min(1, Math.max(0, f)) * total;
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  if (lo === 0) return pts[0];
  const span = cum[lo] - cum[lo - 1];
  const within = span > 0 ? (target - cum[lo - 1]) / span : 0;
  const a = pts[lo - 1];
  const b = pts[lo];
  return { x: a.x + (b.x - a.x) * within, y: a.y + (b.y - a.y) * within };
}

function Arc({ slots, day, zone, now, isToday }: { slots: Slot[]; day: Day; zone: string; now: number; isToday: boolean }): JSX.Element {
  const at = pointAtFraction;
  const d = ARC_D;

  const placed = slots.map((s) => slotTime(s)).filter((t): t is string => !!t).map((t) => zonedTimeToEpoch(day.date, t, zone));
  const first = placed[0] ?? 0;
  const last = placed[placed.length - 1] ?? 1;
  const span = Math.max(1, last - first);
  const frac = (t: number) => Math.min(1, Math.max(0, (t - first) / span));
  const progress = isToday ? frac(now) : 0;

  return (
    // Padded by the "now" marker's radius plus its stroke, and by nothing else — every unit
    // above that is a gap between the countdown and the arc that nobody asked for.
    <svg className="arc" viewBox={`0 -8 ${W} ${H + 16}`} role="img" aria-label="The day’s prayers">
      <path d={d} className="arc__track" />
      {progress > 0 && <path d={d} className="arc__done" pathLength={1} strokeDasharray={`${progress} 1`} />}
      {placed.map((t, i) => {
        const p = at(frac(t));
        return <circle key={i} cx={p.x} cy={p.y} r={4} className={isToday && t <= now ? 'arc__dot arc__dot--past' : 'arc__dot'} />;
      })}
      {isToday && progress > 0 && progress < 1 && (() => {
        const p = at(progress);
        return <circle cx={p.x} cy={p.y} r={6} className="arc__now" />;
      })()}
    </svg>
  );
}

/** Serving a cache is only honest with this on the page. */
function StaleNote({ at }: { at: number }): JSX.Element {
  const when = at ? new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'a while ago';
  return (
    <p className="stale-note">
      <Clock3 size={16} aria-hidden="true" />
      <span>
        These times were last checked with the masjid&rsquo;s system on {when}. They may have changed since.
      </span>
    </p>
  );
}

/**
 * No timetable connected.
 *
 * Not a loading state and not an error — it is the real, permanent answer for a masjid that has
 * not finished setting up, and it stays exactly this calm. This app never fills the gap with a
 * calculated time.
 */
function NotSetUp(): JSX.Element {
  return (
    <main className="centre-wrap">
      <section className="glass centre-card">
        <span className="centre-emblem">
          <CalendarClock size={26} strokeWidth={1.75} aria-hidden="true" />
        </span>
        <h1 className="centre-title">Prayer times aren&rsquo;t set up yet</h1>
        <p className="centre-lead">
          This masjid hasn&rsquo;t finished setting up their app. Once they have, today&rsquo;s times will be
          right here &mdash; and you&rsquo;ll be able to add this page to your phone&rsquo;s home screen.
        </p>
        <Note>Nothing is shown here until the masjid connects their own timetable, so no time on this page is ever a guess.</Note>
      </section>
    </main>
  );
}

/** The masjid's own name and logo at the top — the app on a musalli's phone is theirs. */
export function MasjidHeader({ name, action }: { name: string; action?: React.ReactNode }): JSX.Element {
  return (
    <header className="topbar">
      <span className="brand">
        <MasjidLogo />
        <b>{name}</b>
      </span>
      <span className="spacer" />
      {action}
    </header>
  );
}
