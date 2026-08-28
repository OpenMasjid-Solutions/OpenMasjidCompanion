// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The masjid's appeals, under the prayer times.
 *
 * **Nothing here takes money** (CLAUDE.md §2). Each tile is a picture, a title, a progress bar
 * and a link that leaves for the masjid's own OpenMasjidDonations page. There is no amount
 * field, no card, no Stripe, and no attempt to look like there is — the tap-through is the
 * whole interaction, and pretending otherwise would put this app somewhere it has no business
 * being.
 *
 * WHY THIS SITS UNDER THE TIMES rather than on a page of its own: someone opened this to find
 * out when Maghrib is. They have their answer, they are already looking at the screen, and a
 * masjid's appeal in that moment is a reminder rather than an interruption. A separate tab
 * would be visited by nobody, and a modal would be an ambush.
 *
 * The section is absent, not empty, when there are no appeals — which is most masjids most of
 * the year. A heading over nothing reads as something broken.
 */
import { useEffect, useState } from 'react';
import { ExternalLink, Repeat } from 'lucide-react';
import { api } from './api';

export interface Tile {
  slug: string;
  title: string;
  description: string;
  coverImage: string;
  goalAmount: number;
  raised: number;
  currency: string;
  allowMonthly: boolean;
  /** The Donations donor page. Absolute, and from another app — never rewritten here. */
  href: string;
}

/**
 * Money, in the currency the appeal is denominated in.
 *
 * `Intl` is given the currency from the payload rather than a symbol of our own, because a
 * masjid raising in one currency and a musalli reading in another country must both see the
 * appeal's own — £1,200 raised is not $1,200 raised. Whole units: the pence on a fundraising
 * total are noise, and "£12,480" fits a phone where "£12,480.00" wraps.
 */
function amount(value: number, currency: string, language: string): string {
  try {
    return new Intl.NumberFormat(language || undefined, {
      style: 'currency',
      currency: currency || 'GBP',
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    // An unknown currency code from another app is not a reason to render nothing.
    return `${Math.round(value)}`;
  }
}

export function Appeals({ language }: { language: string }): JSX.Element | null {
  const [tiles, setTiles] = useState<Tile[] | null>(null);

  useEffect(() => {
    let alive = true;
    void api.get<{ tiles: Tile[] }>('/api/public/campaigns').then((r) => {
      // A failure here is silence, deliberately. The prayer times are the page; an error
      // message about appeals underneath them would be this app's problem, not the reader's.
      if (alive && r.ok) setTiles(r.data.tiles);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!tiles || tiles.length === 0) return null;

  return (
    <section className="appeals" aria-labelledby="appeals-head">
      <h2 className="appeals__head" id="appeals-head">
        Appeals
      </h2>
      <div className="appeals__list">
        {tiles.map((t) => (
          <Appeal key={t.href} tile={t} language={language} />
        ))}
      </div>
    </section>
  );
}

function Appeal({ tile, language }: { tile: Tile; language: string }): JSX.Element {
  const pct = tile.goalAmount > 0 ? Math.min(100, Math.round((tile.raised / tile.goalAmount) * 100)) : 0;

  return (
    // `rel="noopener"` is not optional on a target="_blank" to another app: without it the
    // opened page gets a handle on this one. `target` also means an INSTALLED app hands off to
    // the browser to give and the musalli comes back to their prayer times, rather than the
    // donation flow happening inside a standalone window with no address bar.
    <a className="appeal" href={tile.href} target="_blank" rel="noopener noreferrer">
      {tile.coverImage && (
        // Decorative: the title says what this is, so an alt text would repeat it to a screen
        // reader. Lazy, because an appeal is below the fold by definition.
        <img className="appeal__cover" src={tile.coverImage} alt="" loading="lazy" decoding="async" />
      )}
      <div className="appeal__body">
        <div className="appeal__title">{tile.title}</div>
        {tile.description && <p className="appeal__text">{tile.description}</p>}

        {tile.goalAmount > 0 && (
          <>
            <div
              className="appeal__bar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              aria-label={`${pct}% of the goal raised`}
            >
              <span className="appeal__fill" style={{ inlineSize: `${pct}%` }} />
            </div>
            <div className="appeal__nums tnum">
              <b>{amount(tile.raised, tile.currency, language)}</b>{' '}
              {/* The space is real, not just the margin: a screen reader reads the text, and
                  "£8,450of £20,000" is what it says without it. */}
              <span className="appeal__goal">of {amount(tile.goalAmount, tile.currency, language)}</span>
            </div>
          </>
        )}

        <div className="appeal__foot">
          <span className="appeal__go">
            Donate
            <ExternalLink size={13} aria-hidden="true" />
          </span>
          {tile.allowMonthly && (
            <span className="appeal__monthly">
              <Repeat size={12} aria-hidden="true" />
              Monthly available
            </span>
          )}
        </div>
      </div>
    </a>
  );
}
