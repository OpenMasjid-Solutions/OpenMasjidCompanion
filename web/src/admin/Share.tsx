// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Getting the app onto people's phones — the QR code and the poster for the noticeboard.
 *
 * This is the last step of setting up, and the one that decides whether any of the rest of it
 * was worth doing. Everything before this happens on a screen; this is the piece that leaves the
 * building and goes onto a wall.
 *
 * **The QR encodes the public URL exactly** (CLAUDE.md §10) — never the address the volunteer
 * happens to be looking at. A poster carrying `http://192.168.1.20:7880` is a QR code that
 * works for everybody standing inside the masjid on its wifi and for nobody at all outside it,
 * and posters do not get reprinted.
 */
import { useState } from 'react';
import { Check, Copy, Printer, QrCode, TriangleAlert } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { Note } from '../ui';

export function Share({ publicUrl, enabled, masjidName, onPoster }: { publicUrl: string; enabled: boolean; masjidName: string; onPoster: () => void }): JSX.Element {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // A browser that refuses the clipboard is not worth an error message — the address is on
      // screen and can be selected by hand.
    }
  };

  return (
    <section className="glass panel">
      <div className="card-head">
        <span className="panel-ico">
          <QrCode size={18} aria-hidden="true" />
        </span>
        <div className="card-head__main">
          <div className="row-between">
            <h2 className="section-title">Put it on your noticeboard</h2>
            {enabled && <span className="badge badge--ok">Ready</span>}
          </div>

          {!enabled || !publicUrl ? (
            <>
              <p className="card-body">
                A QR code needs an address that works from outside the building, and this app does not have one yet.
              </p>
              <Note tone="warn" icon={<TriangleAlert size={16} aria-hidden="true" />}>
                Turn on Remote access at the top of this page first. Printing a poster before then would give everyone a
                code that only works on your own wifi.
              </Note>
            </>
          ) : (
            <>
              <p className="card-body">
                Print this and put it up. Anyone who scans it gets your prayer times, and can keep them on their home
                screen.
              </p>

              <div className="share">
                <div className="share__qr">
                  {/* SVG rather than canvas: a poster is printed, and an SVG stays crisp at
                      whatever resolution the printer works at. */}
                  <QRCodeSVG value={publicUrl} size={132} level="M" marginSize={2} bgColor="#ffffff" fgColor="#000000" />
                </div>
                <div className="share__side">
                  <div className="label">This is what it points at</div>
                  <p className="url-chip">{publicUrl}</p>
                  <div className="card-actions">
                    <button className="btn btn--primary" onClick={onPoster}>
                      <Printer size={15} aria-hidden="true" />
                      Poster
                    </button>
                    <button className="btn" onClick={() => void copy()}>
                      {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
                      {copied ? 'Copied' : 'Copy address'}
                    </button>
                  </div>
                </div>
              </div>

              <div style={{ marginBlockStart: '0.8rem' }}>
                <Note>
                  Scan it yourself first, on a phone that is <b>not</b> on the masjid&rsquo;s wifi. That is the only check
                  that proves it works for the people it is for.
                </Note>
              </div>
            </>
          )}
          {enabled && publicUrl && masjidName && <p className="hint" style={{ marginBlockStart: '0.6rem' }}>The poster is headed <b>{masjidName}</b>.</p>}
        </div>
      </div>
    </section>
  );
}

/**
 * The printable poster.
 *
 * A whole page rather than a section, because it is going through a printer: everything else on
 * screen is hidden by the print stylesheet, and this is laid out for a single A4 or Letter sheet
 * in portrait with a generous margin.
 *
 * It is deliberately plain. A noticeboard poster is read from two metres away by someone
 * walking past, so it carries a name, a code, and three short lines — and nothing else.
 */
export function Poster({ publicUrl, masjidName, appName, onBack }: { publicUrl: string; masjidName: string; appName: string; onBack: () => void }): JSX.Element {
  const heading = masjidName || appName || 'Prayer times';
  return (
    <>
      <div className="poster-bar no-print">
        <button className="btn" onClick={onBack}>
          Back to setup
        </button>
        <button className="btn btn--primary" onClick={() => window.print()}>
          <Printer size={15} aria-hidden="true" />
          Print
        </button>
      </div>

      <main className="poster">
        <header className="poster__head">
          <div className="poster__masjid">{heading}</div>
          <h1 className="poster__title">Prayer times on your phone</h1>
        </header>

        <div className="poster__qr">
          {/* Big, black on white, with a wide quiet zone — the three things that decide whether
              a phone camera reads it off a wall in bad light. */}
          <QRCodeSVG value={publicUrl} size={340} level="M" marginSize={4} bgColor="#ffffff" fgColor="#000000" />
        </div>

        <ol className="poster__steps">
          <li>
            <b>Point your camera</b> at the code above.
          </li>
          <li>
            <b>Tap the link</b> that appears.
          </li>
          <li>
            <b>Add it to your home screen</b> so it is always one tap away.
            <div className="poster__hints">
              <span>
                <b>iPhone:</b> tap Share, then Add to Home Screen
              </span>
              <span>
                <b>Android:</b> tap the menu, then Install app
              </span>
            </div>
          </li>
        </ol>

        <p className="poster__url">{publicUrl}</p>
      </main>
    </>
  );
}
