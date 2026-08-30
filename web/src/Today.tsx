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
import { haptic } from './haptics';
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

  /** Returns whether it actually moved. The window has ends, and at one of them a swipe is a
   *  gesture that was understood and refused — which is a different thing to confirm than a day
   *  changing, and the haptic below is why the difference now has to be reported. */
  const step = useCallback(
    (by: 1 | -1) => {
      const next = Math.min(data.days.length - 1, Math.max(0, todayIndex + offset + by)) - todayIndex;
      if (next === offset) return false;
      setSlide(by === 1 ? 'next' : 'prev');
      setOffset(next);
      return true;
    },
    [data.days.length, todayIndex, offset],
  );

  /**
   * A swipe that moves a day buzzes; one that runs into the end of the window does not.
   *
   * Here rather than inside `useSwipe`, because only the caller knows whether anything happened
   * — and a buzz for a swipe that changed nothing is a confirmation of nothing. The arrows do
   * not do this: they are buttons, and the delegated listener in haptics.ts has already
   * confirmed the press.
   */
  const swipe = useSwipe(
    useCallback(() => {
      if (step(1)) haptic('select');
    }, [step]),
    useCallback(() => {
      if (step(-1)) haptic('select');
    }, [step]),
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
 * Computed here rather than measured through the DOM, so it renders identically in the
 * server-built HTML, in a screenshot and on a phone. `pathLength="1"` normalises the curve so
 * the travelled portion is a plain fraction of its length.
 *
 * Two things about the frame, before the shape below:
 *
 *  - **It runs edge to edge.** The path spans 0…W with no inset and the CSS pulls the SVG out
 *    through the page's own side padding, so the curve leaves the screen rather than stopping
 *    short inside a column of text.
 *  - **The viewBox is the path's own bounds**, plus the "now" marker's radius and nothing else.
 *    An earlier one reserved 71 units of empty space above the peak, which was the whole of the
 *    gap that made the arc sit too far below the countdown.
 */
const W = 320;
/** Band height. 0.275 of the width: a shallower arc reads as a slouch, a taller one crowds the
 *  times below it. */
const H = 88;

/**
 * THE SHAPE: one continuous function, no joined segments.
 *
 *     y(x) = H · sin^P( π · (x/W)^K )
 *
 * This replaces a pair of cubic Béziers that met at the summit. Two segments could be given
 * matching TANGENTS there but not matching CURVATURE, and the difference is exactly what Hasan
 * saw. Two separate measurements on the old pair, and they are not the same number: curvature
 * STEPPED by 78% across the summit itself, and separately it VARIED by 4.6× within ±12% of the
 * width around it — the radius at the apex was 96 units while the flattest point beside it was
 * 268. A curve that goes slack either side of its own peak reads as a table top — a plateau with
 * a crease in the middle — however smooth the tangents are.
 *
 * An analytic curve cannot have that fault. It is C-infinity everywhere in (0, W), so "no
 * visible break between ascent, peak and descent" is true by construction rather than by
 * tuning. What is left is choosing how round the crest is and how gently it leaves the horizon,
 * and those are the two exponents:
 *
 *  • **P = 1.6** sets the crest. Curvature varies 1.76× across the crest region, against 4.59×
 *    for the old pair and 1.06× for the stretched half-ellipse Hasan named as the ideal — so it
 *    is a dome that keeps doming, not a flat run. Higher P sharpens the crest toward a point;
 *    lower P rounds it but drags the flanks up steeper, and the gentle start is worth more.
 *  • **K = 0.835** slides the summit to 0.436 of the width, left of centre. That is what makes
 *    the descent the longer, gentler half — at 0.2W either side the climb has fallen 0.289 of
 *    the band and the descent only 0.250.
 *
 * Both horizons are approached with a slope that TENDS to zero, which is the "starts low,
 * gradually accelerates" the description opens with. Only in the limit, though: by the first
 * few rendered pixels the left edge is already leaving at about 20°, and the honest description
 * is a curve that starts gently and gathers pace, not one that lies flat for a while.
 *
 * Near x = 0 the curve behaves as H − c·(x/W)^(K·P), and since K·P is 1.336 rather than 2 its
 * CURVATURE is unbounded right at the horizon — real maths, not a bug, confined to about two
 * pixels where a 2.5-unit round-capped stroke swallows it whole. Checked at 3× zoom: the left
 * edge draws clean. Worth knowing before anyone "fixes" the sharp angle a sampler reports there. It is also the one thing given up from the earlier
 * pass, where the right edge dropped away more sharply; a single smooth function cannot both
 * leave the horizon gently on the left and dive into it on the right, and the seven properties
 * in the newer description are the ones being built to.
 */
const CURVE_P = 1.6;
const CURVE_K = 0.835;

type Pt = { x: number; y: number };

/** The curve at a fraction of the WIDTH. */
export function curve(u: number): Pt {
  const x = Math.min(1, Math.max(0, u));
  return { x: x * W, y: H - H * Math.sin(Math.PI * x ** CURVE_K) ** CURVE_P };
}

/**
 * Sampled once into a polyline, which is both the drawn path and the table everything is
 * placed against.
 *
 * A polyline rather than fitted Béziers because it cannot lie: what is measured for the dots is
 * the same geometry that is stroked.
 *
 * 160 samples is not justified by the chord LENGTH — each chord spans two units of a 320-unit
 * box, which is about 2.4px on a 390px screen, nowhere near "below a pixel". What matters is how
 * far a chord departs from the curve it cuts across, and that is measured: **0.038px at the
 * worst point.** `stroke-linejoin: round` takes care of the joins.
 */
const ARC = (() => {
  const N = 160;
  const pts: Pt[] = [];
  const cum: number[] = [0];
  // Rounded to the same two decimals the path string carries. Measuring full-precision samples
  // against a path the browser parsed from rounded text would leave the dots a hair off the
  // line they sit on — small, but it is the exact class of drift this table exists to remove.
  for (let i = 0; i <= N; i += 1) {
    const q = curve(i / N);
    pts.push({ x: +q.x.toFixed(2), y: +q.y.toFixed(2) });
  }
  for (let i = 1; i < pts.length; i += 1) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  const d = pts.map((q, i) => `${i === 0 ? 'M' : 'L'} ${q.x.toFixed(2)} ${q.y.toFixed(2)}`).join(' ');
  return { pts, cum, total: cum[cum.length - 1], d };
})();

export const ARC_D = ARC.d;
export const ARC_BAND = { W, H };

/**
 * The point a given fraction of the way ALONG the curve.
 *
 * The progress stroke is drawn with `pathLength="1"` and a `stroke-dasharray`, which the
 * browser measures by LENGTH. Placing the dots and the "now" marker by anything else left the
 * marker floating past the end of the very line it caps — and length is doubly not the same as
 * position here, since the climb is shorter than the descent.
 */
export function pointAtFraction(f: number): Pt {
  const { pts, cum, total } = ARC;
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
