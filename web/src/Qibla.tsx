// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Which way to face.
 *
 * The design is set in `docs/DESIGN_LANGUAGE.md` (Hasan, 2026-08-24) and the ordering in it is
 * the whole screen: **the bearing and a north-up dial first, the compass offered as a button
 * afterwards.** That is not a fallback arrangement, it is the right way round —
 *
 *  - A compass needs a magnetometer, a permission on iOS, a user gesture, and somewhere that is
 *    not next to a steel door frame. A screen that led with it would be blank on a laptop, blank
 *    until a permission dialog was answered, and confidently wrong in a basement prayer hall.
 *  - A bearing needs only a position. "119°, east-southeast, 4,794 km" is useful on its own:
 *    it can be checked against a room somebody already knows the shape of, and it is what an
 *    imam would tell you over the phone.
 *
 * **Position comes from the device and only from the device.** Asking Display for the masjid's
 * coordinates was drafted as a work order and withdrawn: it is not worth a cross-repo change
 * for a bearing that shifts by a fraction of a degree across a whole city.
 *
 * That has two consequences, and both are built for rather than worked around. It needs a
 * secure context, so this is a tunnel-only feature like install and push. And **declining is a
 * normal outcome** — plenty of people say no to a location prompt, and plenty of phones simply
 * cannot get a fix indoors, which is exactly where this is used. Both are designed screens with
 * a way forward, not error toasts.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Compass, LocateFixed, RotateCcw, TriangleAlert } from 'lucide-react';
import {
  angleDelta,
  compassPoint,
  distanceToKaaba,
  headingFrom,
  isAligned,
  norm360,
  qiblaBearing,
  recallVisit,
  rememberForVisit,
  type OrientationLike,
} from './bearing';
import { haptic } from './haptics';

type Phase = 'idle' | 'locating' | 'ready' | 'denied' | 'failed' | 'unsupported';

/**
 * Deliberately NOT high accuracy.
 *
 * `enableHighAccuracy: true` turns on GPS: slower, flatter battery, and it fails indoors, which
 * is where a prayer hall is. Coarse positioning from wifi and cell towers is accurate to a few
 * hundred metres, and a few hundred metres moves this bearing by roughly a thousandth of a
 * degree. The cheaper option is also the better one here, which is rare enough to write down.
 */
const GEO: PositionOptions = { enableHighAccuracy: false, timeout: 12_000, maximumAge: 10 * 60_000 };

export function Qibla({ secure }: { secure: boolean }): JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle');
  const [bearing, setBearing] = useState<number | null>(null);
  const [km, setKm] = useState(0);

  /**
   * Whatever this phone worked out last time. Shown at once and without asking anybody anything
   * — a bearing does not change unless the reader travels, and re-prompting a congregation for
   * their location every Friday is how a permission gets denied for good.
   *
   * **`secure` arrives late, and this used to get stuck on it.** It comes from `/api/app`, so on
   * the first render it is false for everybody; an earlier version set `unsupported` then and
   * never took it back, which meant the Qibla tab opened onto "this browser can't work out where
   * you are" on a perfectly capable phone. So the decision is made in BOTH directions, and it is
   * made with a functional update that leaves any state the reader reached by acting alone: a
   * refusal must not be quietly reset into a fresh prompt.
   */
  useEffect(() => {
    const seen = recallVisit();
    if (seen) {
      setBearing(seen.bearing);
      setKm(seen.km);
      setPhase('ready');
      return;
    }
    const usable = secure && typeof navigator !== 'undefined' && 'geolocation' in navigator;
    setPhase((p) => (p === 'idle' || p === 'unsupported' ? (usable ? 'idle' : 'unsupported') : p));
  }, [secure]);

  const locate = useCallback(() => {
    if (!secure || typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setPhase('unsupported');
      return;
    }
    setPhase('locating');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const b = qiblaBearing(pos.coords.latitude, pos.coords.longitude);
        if (b === null) {
          // Standing on the Kaaba, or at its exact antipode. Neither is a failure and neither
          // has an answer; saying so is better than pointing north and meaning nothing.
          setPhase('failed');
          return;
        }
        const d = distanceToKaaba(pos.coords.latitude, pos.coords.longitude);
        setBearing(b);
        setKm(Math.round(d));
        setPhase('ready');
        haptic('success');
        // For this visit only, and only the bearing — see bearing.ts.
        rememberForVisit(b, d);
      },
      (err) => setPhase(err.code === err.PERMISSION_DENIED ? 'denied' : 'failed'),
      GEO,
    );
  }, [secure]);

  const compass = useCompass(secure);
  const facing = compass.heading;
  const aligned = bearing !== null && facing !== null && isAligned(facing, bearing);

  /**
   * A buzz the moment it lines up, and only on the moment.
   *
   * The best haptic in this app by some distance: somebody turning on the spot with a phone held
   * out is not looking at the screen, they are looking at the room. `wasAligned` is a ref rather
   * than state because it exists to suppress a repeat, and putting it in state would re-render
   * the dial on every reading to store something nothing renders.
   */
  const wasAligned = useRef(false);
  useEffect(() => {
    if (aligned && !wasAligned.current) haptic('success');
    wasAligned.current = aligned;
  }, [aligned]);
  // Where the rose is drawn. With no compass it is north-up, which is a map; with one it turns
  // under the phone so that "up" is where the reader is actually pointing.
  const rose = facing === null ? 0 : -facing;

  return (
    <main className="qibla">
      <h1 className="qibla__title">Qibla</h1>

      {phase === 'unsupported' && (
        <section className="set-card">
          <p className="set-lead">
            {secure
              ? 'This browser can’t work out where you are, so it can’t point to Makkah. Opening the app in Chrome or Safari usually does it.'
              : 'The Qibla needs this app to be opened over the internet rather than on the masjid’s own wifi — a browser will not share your location otherwise. Scan the QR code on the noticeboard, or ask the masjid for the link.'}
          </p>
        </section>
      )}

      {/* One button, and nothing to read first (Hasan, 2026-08-30). The paragraph that used to
          be here explained that the location never leaves the phone — true, and still true, and
          nobody standing in a prayer hall is reading it. The browser's own prompt is about to
          ask the question anyway, in words the reader already trusts. */}
      {phase === 'idle' && (
        <section className="set-card qibla__start">
          <button className="btn btn--primary" onClick={locate}>
            <LocateFixed size={15} aria-hidden="true" />
            Point me to Makkah
          </button>
        </section>
      )}

      {phase === 'locating' && (
        <section className="set-card">
          <p className="set-lead">
            <span className="spinner" /> Finding where you are&hellip;
          </p>
        </section>
      )}

      {/* Declining is an ordinary answer, not an error. It gets a screen that says what happened,
          what it costs, and the one thing that would change it — and it never nags. */}
      {phase === 'denied' && (
        <section className="set-card">
          <h2 className="set-title">
            <TriangleAlert size={16} aria-hidden="true" />
            Location is turned off for this app
          </h2>
          <p className="set-lead">
            That&rsquo;s a perfectly reasonable thing to say no to &mdash; but without it there is no way to know which
            way Makkah is from where you are standing. If you change your mind, allow location for this site in your
            browser&rsquo;s settings and come back.
          </p>
          <button className="btn" onClick={locate}>
            <RotateCcw size={15} aria-hidden="true" />
            Try again
          </button>
        </section>
      )}

      {phase === 'failed' && (
        <section className="set-card">
          <h2 className="set-title">
            <TriangleAlert size={16} aria-hidden="true" />
            Couldn&rsquo;t place you
          </h2>
          <p className="set-lead">
            Your phone couldn&rsquo;t work out where it is. That happens indoors, especially in a hall with thick walls
            &mdash; stepping outside for a moment is usually enough.
          </p>
          <button className="btn" onClick={locate}>
            <RotateCcw size={15} aria-hidden="true" />
            Try again
          </button>
        </section>
      )}

      {phase === 'ready' && bearing !== null && (
        <>
          <Dial bearing={bearing} rose={rose} live={facing !== null} aligned={aligned} />

          <section className="set-card qibla__read">
            <p className="qibla__deg tnum">{Math.round(bearing)}&deg;</p>
            <p className="qibla__point">from north &mdash; {compassPoint(bearing)}</p>
            {km > 0 && <p className="hint">{km.toLocaleString()} km to the Kaaba</p>}

            {/* The only part a screen reader needs to hear change. Announcing the heading itself
                would be a stream of numbers nobody can act on; "facing the Qibla" is the one
                event worth interrupting for. */}
            <p className={facing === null ? 'qibla__state qibla__state--quiet' : 'qibla__state'} role="status">
              {facing === null
                ? ''
                : aligned
                  ? 'Facing the Qibla'
                  : `Turn ${angleDelta(facing, bearing) > 0 ? 'right' : 'left'} ${Math.abs(Math.round(angleDelta(facing, bearing)))}°`}
            </p>

            {facing === null && (
              <>
                <p className="set-lead">
                  {compass.blocked === 'denied'
                    ? 'Your phone won’t share its compass with this app. The direction above is still right — line it up with a compass app, or anything else you know points north.'
                    : compass.blocked === 'unsupported'
                      ? 'This device has no compass, so the dial stays north-up. Line the top of the dial up with north and the marker points to Makkah.'
                      : 'Turn on the compass and the dial will follow your phone.'}
                </p>
                {!compass.blocked && (
                  <button className="btn btn--primary" onClick={() => void compass.enable()} disabled={compass.busy}>
                    {compass.busy ? <span className="spinner" /> : <Compass size={15} aria-hidden="true" />}
                    Use my compass
                  </button>
                )}
              </>
            )}

            {compass.uncalibrated && (
              <p className="hint">Wave the phone in a figure of eight to settle the compass.</p>
            )}
          </section>
        </>
      )}
    </main>
  );
}

/**
 * The dial.
 *
 * North-up until there is a compass, then the whole rose turns under the phone so that "up" is
 * where the reader is pointing. The Kaaba marker is drawn at the bearing INSIDE the rose and
 * carried round with it, so there is one rotation on screen rather than two that have to agree.
 *
 * `aria-hidden`: everything it shows is said in words beside it, and a screen reader that also
 * described the dial would read the same fact three times.
 */
function Dial({ bearing, rose, live, aligned }: { bearing: number; rose: number; live: boolean; aligned: boolean }): JSX.Element {
  /** Polar → cartesian with 0° at the TOP and turning clockwise, which is what a bearing is and
   *  what SVG's own angles are not (they start at three o'clock and turn the other way). */
  const at = (degrees: number, r: number) => {
    const a = ((degrees - 90) * Math.PI) / 180;
    return { x: r * Math.cos(a), y: r * Math.sin(a) };
  };

  const marks: [number, string][] = [
    [0, 'N'],
    [90, 'E'],
    [180, 'S'],
    [270, 'W'],
  ];

  return (
    <div className={aligned ? 'qibla__dial qibla__dial--on' : 'qibla__dial'} aria-hidden="true">
      <svg viewBox="-110 -110 220 220" className="qibla__svg">
        {/* A physical compass face: a pale bezel with a near-white card inside it, after the
            reference Hasan supplied on 2026-08-30. Drawn as an OBJECT rather than in the page's
            ink tokens, which is a deliberate exception to "never hardcode a colour" — a compass
            is a thing sitting on the page, and one whose face inverted with the sky would stop
            reading as a thing at all. The colours are in app.css all the same, so they are not
            loose in the component. */}
        <circle r="100" className="qibla__bezel" />
        <circle r="92" className="qibla__face" />

        {/* Rotated by the SVG ATTRIBUTE, not by CSS.
         *
         * `transform: rotate()` in CSS pivots about `transform-origin`, and what that resolves to
         * for an SVG group is not something to be confident about: the default box put the pivot
         * on the viewport's corner and swung the whole rose off the bottom of the card, and
         * spelling out `transform-box: view-box` moved it somewhere else again. The attribute has
         * one meaning and has had it since SVG 1.1 — rotate about user-space (0, 0), which this
         * viewBox is centred on by construction.
         *
         * There is no CSS transition on it either, and none is wanted: the low-pass filter on the
         * heading is what makes this move smoothly, and it runs at the magnetometer's own rate.
         * A transition on top would be a second smoothing fighting the first. */}
        <g className="qibla__rose" transform={`rotate(${rose})`}>
          {/* A tick every 6°, longer on the cardinals — the density of the reference, and close
              enough that a reader can count round to an angle if they want one. */}
          {Array.from({ length: 60 }, (_, i) => i * 6).map((d) => (
            <line
              key={d}
              x1="0"
              y1="-86"
              x2="0"
              y2={d % 90 === 0 ? '-72' : '-79'}
              transform={`rotate(${d})`}
              className={d % 90 === 0 ? 'qibla__tick qibla__tick--card' : 'qibla__tick'}
            />
          ))}

          {/* Placed by trig rather than by a rotate-and-counter-rotate, which is how the letters
              ended up on their sides: nesting an SVG rotation inside another puts the pivot
              somewhere neither of them meant. They still turn WITH the rose, as the printed card
              of a real compass does — and as the reference does. */}
          {marks.map(([deg, label]) => {
            const p = at(deg, 62);
            return (
              <text key={label} x={p.x} y={p.y} className="qibla__card" dominantBaseline="central">
                {label}
              </text>
            );
          })}

          {/**
           * The Kaaba, at the bearing, TURNED TO FACE IT (Hasan, 2026-08-30).
           *
           * There is no counter-rotation here at all any more, and the two earlier versions were
           * both wrong in ways worth recording. The first cancelled the pointer's own turn, so
           * the tile stayed square to a card that was itself rotating and leaned by however far
           * the reader had turned. The second cancelled the whole screen rotation, which stood it
           * up — and standing it up is what made it a picture of a box rather than a building
           * somebody is facing.
           *
           * Turning with the bearing is what the reference does and it is also the more truthful
           * drawing: the Kaaba is a cube with a face towards you, not an icon pinned to a map.
           */}
          <g transform={`rotate(${norm360(bearing)}) translate(0 -72)`}>
            <rect x="-13" y="-13" width="26" height="26" rx="4" className="qibla__kaaba" />
            {/* The kiswa's band, and the door below it. Two shapes, because the band alone reads
                as a stripe on a square and the pair reads as a building — at this size that is
                the whole of the difference between an icon and a flag. */}
            <rect x="-13" y="-4" width="26" height="3.5" className="qibla__kiswa" />
            <rect x="-4.5" y="2" width="6" height="8" rx="0.8" className="qibla__door" />
          </g>
        </g>

        {/**
         * Where the phone is pointing. Fixed to the SCREEN, outside the rose, because "the way
         * you are facing" is up by definition — the card turns underneath it.
         *
         * A leaf rather than the thin line and hub this replaced (Hasan, 2026-08-30, after the
         * reference). The line ran from the middle out to the Kaaba, which said "the Kaaba is
         * over there" — true, and already said by the Kaaba being over there. What the screen was
         * missing is the other half of the sentence: where YOU are pointing. Lining the two up is
         * the whole gesture.
         *
         * Only with a live compass. Without one the card cannot turn, so there is no "you" to
         * mark and a needle would be claiming a direction the phone does not know.
         */}
        {live && (
          <path
            d="M0 -46 C 6 -28 13 -10 13 4 C 13 26 7 42 0 42 C -7 42 -13 26 -13 4 C -13 -10 -6 -28 0 -46 Z"
            className="qibla__needle"
          />
        )}
      </svg>
    </div>
  );
}

/**
 * The magnetometer, and the three ways it declines to be one.
 *
 * Never started on its own. iOS requires `DeviceOrientationEvent.requestPermission()` from a
 * user gesture, and a page that calls it on load gets a rejection it can never ask about again
 * — the same rule as the notification prompt, for the same reason.
 */
function useCompass(secure: boolean): {
  heading: number | null;
  enable: () => Promise<void>;
  busy: boolean;
  blocked: '' | 'denied' | 'unsupported';
  uncalibrated: boolean;
} {
  const [heading, setHeading] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  /** What the DEVICE or the reader said no to — a refused permission, or three seconds of
   *  silence from an API that exists but has nothing behind it. */
  const [refused, setRefused] = useState<'' | 'denied' | 'unsupported'>('');
  const [uncalibrated, setUncalibrated] = useState(false);

  /**
   * DERIVED, not seeded.
   *
   * This was a `useState` initialiser, and initialisers run exactly once — on the first render,
   * when `secure` is still false for everybody because `/api/app` has not answered yet. So it
   * latched to "unsupported" and the "Use my compass" button never appeared on any phone at
   * all. The same shape of bug as the one above it, found the same way: by opening the page.
   */
  const hasApi = typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
  const blocked: '' | 'denied' | 'unsupported' = refused || (secure && hasApi ? '' : 'unsupported');
  const [on, setOn] = useState(false);
  /** The smoothed reading, held in a ref so a fast event stream does not re-render on the
   *  previous value and reintroduce the jitter this is removing. */
  const smooth = useRef<number | null>(null);

  useEffect(() => {
    if (!on) return;
    const screenAngle = () => (typeof screen !== 'undefined' && screen.orientation ? screen.orientation.angle || 0 : 0);

    const onEvent = (raw: Event) => {
      const e = raw as unknown as OrientationLike;
      const h = headingFrom(e, screenAngle());
      if (h === null) {
        // A reading arrived and was not usable. On iOS that is an uncalibrated magnetometer,
        // which the reader can actually fix; elsewhere it is a non-absolute event, which they
        // cannot, so only the fixable case is mentioned.
        if (typeof e.webkitCompassAccuracy === 'number' && e.webkitCompassAccuracy < 0) setUncalibrated(true);
        return;
      }
      setUncalibrated(false);
      // Low-pass, THROUGH the shortest angular difference. Averaging the raw numbers instead
      // would swing the dial the long way round every time the reading crossed north — 359° and
      // 1° are two degrees apart, and their mean is not 180.
      const prev = smooth.current;
      smooth.current = prev === null ? h : norm360(prev + angleDelta(prev, h) * 0.25);
      setHeading(smooth.current);
    };

    // `deviceorientationabsolute` where it exists (Chromium), plain `deviceorientation`
    // otherwise (Safari, which fires the absolute reading through the standard name).
    const name = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
    window.addEventListener(name, onEvent);
    return () => window.removeEventListener(name, onEvent);
  }, [on]);

  const enable = useCallback(async () => {
    setBusy(true);
    try {
      const D = window.DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<PermissionState | string> };
      if (typeof D?.requestPermission === 'function') {
        const res = await D.requestPermission();
        if (res !== 'granted') {
          setRefused('denied');
          setBusy(false);
          return;
        }
      }
      setOn(true);
      // A device with the API but no magnetometer fires nothing at all, for ever. Without this
      // the screen sits on a spinner that will never stop, which reads as broken rather than as
      // "this laptop has no compass".
      setTimeout(() => {
        if (smooth.current === null) setRefused('unsupported');
      }, 3000);
    } catch {
      setRefused('denied');
    }
    setBusy(false);
  }, []);

  return { heading, enable, busy, blocked, uncalibrated };
}
