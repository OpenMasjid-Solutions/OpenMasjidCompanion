// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * A month at a glance, with the days the jamā'ah times change marked.
 *
 * That marking is the whole reason this view exists. Adhan times move a minute or two every
 * single day because they are astronomical — nobody needs telling. Jamā'ah times do not: a
 * committee sets them, they hold for a week or two, and then they are revised. **The day they
 * are revised is the day somebody turns up at the wrong time**, and a list of thirty days of
 * near-identical numbers is the worst possible way to find it.
 *
 * Only the days the masjid actually sent are shown as available. A month view that let someone
 * tap into a day this app has no times for would be inviting them to a blank page — so days
 * outside the window are visibly inert rather than quietly broken.
 */
import { useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useSwipe } from './swipe';
import {
  type Day,
  type Masjid,
  type MonthMarks,
  changedPrayers,
  formatMonth,
  iqamahChanges,
  monthGrid,
  weekdayLabels,
} from './prayerTimes';

export function Month({
  days,
  masjid,
  marks,
  today,
  anchor,
  onAnchor,
  onPick,
  onClose,
}: {
  days: Day[];
  masjid: Masjid;
  /** Which jamā'āt count as a change — the masjid's own setting. */
  marks: MonthMarks;
  /** The masjid's today, so it can be ringed. */
  today: string;
  /** Any date inside the month being shown. */
  anchor: string;
  onAnchor: (date: string) => void;
  onPick: (date: string) => void;
  onClose: () => void;
}): JSX.Element {
  const changes = iqamahChanges(days, marks);
  const available = new Set(days.map((d) => d.date));
  const weeks = monthGrid(anchor, masjid.language);
  /** How many marks are actually on THIS month, which is what the legend is about. */
  const visibleChanges = weeks.flat().filter((c) => c.date && changes.has(c.date)).length;
  const labels = weekdayLabels(masjid.language);

  // Only offer a month that has any days in the window at all. The feed is about five weeks
  // long, so there is one month behind and one ahead at most.
  const monthOf = (date: string) => date.slice(0, 7);
  const monthsWithData = new Set([...available].map(monthOf));
  const shift = (by: number) => {
    const [y, m] = anchor.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + by, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
  };
  const canGo = (by: number) => monthsWithData.has(monthOf(shift(by)));

  /** Which way the last month change went, so the new grid slides in from the side it came
   *  from — the same gesture and the same motion as the day view, because to a thumb it is the
   *  same action. Held here rather than passed down: only this component knows which of its own
   *  controls was used. */
  const [slide, setSlide] = useState<'next' | 'prev' | null>(null);
  const step = (by: number) => {
    if (!canGo(by)) return;
    setSlide(by === 1 ? 'next' : 'prev');
    onAnchor(shift(by));
  };

  // The same gesture as the day view, because a month grid is the same kind of thing to a
  // thumb. `canGo` is checked inside `step` rather than by not binding the handler: a swipe
  // into a month with no times should do nothing, not scroll the page sideways.
  const swipe = useSwipe(
    () => step(1),
    () => step(-1),
  );

  return (
    <main className="month" {...swipe}>
      <div className="month__bar">
        <button className="datebar__btn" onClick={() => step(-1)} disabled={!canGo(-1)} aria-label="Previous month">
          <ChevronLeft size={22} aria-hidden="true" />
        </button>
        <div className="month__title">{formatMonth(anchor, masjid.language)}</div>
        <button className="datebar__btn" onClick={() => step(1)} disabled={!canGo(1)} aria-label="Next month">
          <ChevronRight size={22} aria-hidden="true" />
        </button>
        <button className="datebar__btn" onClick={onClose} aria-label="Back to the day">
          <X size={20} aria-hidden="true" />
        </button>
      </div>

      {/* Keyed on the month so a change remounts the grid and replays the slide, exactly as the
          day view keys its table on the date. */}
      <div
        className="month__grid"
        key={anchor.slice(0, 7)}
        data-slide={slide ?? undefined}
        role="grid"
        aria-label={formatMonth(anchor, masjid.language)}
      >
        <div className="month__week month__week--head" role="row">
          {labels.map((l, i) => (
            <div key={i} className="month__wd" role="columnheader">
              {l}
            </div>
          ))}
        </div>

        {weeks.map((week, wi) => (
          <div className="month__week" key={wi} role="row">
            {week.map((cell, ci) => {
              if (!cell.date) return <div className="month__cell month__cell--pad" key={ci} role="gridcell" />;
              const has = available.has(cell.date);
              const changed = changes.has(cell.date);
              const isToday = cell.date === today;
              const cls = [
                'month__cell',
                has ? '' : 'month__cell--empty',
                changed ? 'month__cell--changed' : '',
                isToday ? 'month__cell--today' : '',
              ]
                .filter(Boolean)
                .join(' ');

              // The tooltip names what actually changed, so a marked day answers "changed how?"
              // without a trip into the day view.
              const what = changed ? changedPrayers(days, cell.date, masjid.hourCycle, masjid.language, marks) : [];
              const title = [isToday ? 'Today' : '', ...what].filter(Boolean).join(' · ');

              return (
                <button
                  key={ci}
                  className={cls}
                  role="gridcell"
                  disabled={!has}
                  title={title || undefined}
                  aria-label={`${cell.dayOfMonth}${changed ? ', Iqamah times change' : ''}${isToday ? ', today' : ''}`}
                  onClick={() => onPick(cell.date!)}
                >
                  <span className="month__num tnum">{cell.dayOfMonth}</span>
                  {changed && <span className="month__dot" aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* The legend explains a mark, so it only earns its place when there IS one on screen.
          Scoped to the VISIBLE month rather than the whole feed: a legend pointing at nothing,
          in a month with no marks, reads as though the feature is broken. */}
      {visibleChanges > 0 ? (
        <p className="month__key">
          <span className="month__dot month__dot--key" aria-hidden="true" />
          <span>Iqamah times change on this day.</span>
        </p>
      ) : (
        <p className="month__key">
          <CalendarDays size={15} aria-hidden="true" />
          <span>No Iqamah changes this month.</span>
        </p>
      )}
    </main>
  );
}
