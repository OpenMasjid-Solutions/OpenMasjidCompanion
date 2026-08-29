// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The masjid's appeals — their own tab.
 *
 * **Nothing here takes money** (CLAUDE.md §2). Each tile is a picture, a title, a progress bar
 * and a link that leaves for the masjid's own OpenMasjidDonations page. There is no amount
 * field, no card, no Stripe, and no attempt to look like there is — the tap-through is the
 * whole interaction, and pretending otherwise would put this app somewhere it has no business
 * being.
 *
 * These were a section under the prayer times until 2026-08-29, on the reasoning that someone
 * who has just read Maghrib is the right moment for a reminder. Hasan asked for tabs, which is
 * the better shape: an appeal is a thing you go to, and a phone-shaped app puts the places you
 * can go along the bottom rather than at the end of a scroll.
 *
 * **The tab does not exist when there are no appeals.** Most masjids, most of the year — and an
 * empty "Donate" page is a worse answer than no tab at all. `useCampaigns` is therefore lifted
 * to the shell, which needs the count to decide whether to draw the bar; this file renders it.
 */
import { useEffect, useState } from 'react';
import { ExternalLink, HandCoins, Repeat } from 'lucide-react';
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

/**
 * The masjid's appeals, fetched once for the whole app.
 *
 * Lifted out of the page because the TAB BAR needs the answer too — it does not draw a Donate
 * tab for a masjid with no appeals — and because fetching per page would re-request on every
 * switch between Salah and Donate.
 *
 * `null` means "not asked yet", which is different from `[]` ("asked, and there are none").
 * The bar must not flash a tab in and out while the first request is in flight.
 */
export function useCampaigns(enabled: boolean): Tile[] | null {
  const [tiles, setTiles] = useState<Tile[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void api.get<{ tiles: Tile[] }>('/api/public/campaigns').then((r) => {
      // A failure here is silence, deliberately. The prayer times are the app; an error about
      // appeals would be this app's problem, not the reader's — and with no answer there is
      // simply no Donate tab, which is the same as a masjid that has no appeals.
      if (alive && r.ok) setTiles(r.data.tiles);
    });
    return () => {
      alive = false;
    };
  }, [enabled]);
  return tiles;
}

export function Give({ tiles, language }: { tiles: Tile[] | null; language: string }): JSX.Element {
  return (
    <main className="give">
      <h1 className="give__head">Appeals</h1>

      {tiles === null ? (
        <div className="centre-wrap">
          <span className="spinner" />
        </div>
      ) : tiles.length === 0 ? (
        // Reachable by a bookmark or a back button after the last appeal ended. A blank page
        // would read as broken; this reads as "nothing on at the moment", which is the truth.
        <div className="give__empty">
          <HandCoins size={28} aria-hidden="true" />
          <p>Your masjid doesn&rsquo;t have any appeals running just now.</p>
        </div>
      ) : (
        <div className="appeals__list">
          {tiles.map((t) => (
            <Appeal key={t.href} tile={t} language={language} />
          ))}
        </div>
      )}
    </main>
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
