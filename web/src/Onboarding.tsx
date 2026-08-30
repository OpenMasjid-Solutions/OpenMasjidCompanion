// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The page behind the QR code on the noticeboard.
 *
 * Asked for by Hasan on 2026-08-29, and the reasoning is worth keeping: the poster's three
 * printed steps have to be right for every phone that will ever scan it, so they say the
 * generic thing. **A web page does not have that problem.** It already knows which phone and
 * which browser is reading it, so it can say the one true sentence instead of six that might
 * apply — and it can put a real button under the sentence when the browser has one to offer.
 *
 * The three things it exists to prevent, each of which sends somebody away for good:
 *
 *  1. **Hunting for a button that is not there.** "Share → Add to Home Screen" is Safari's, not
 *     iOS's. In Chrome on an iPhone, or in the in-app browser that opens when a link is tapped
 *     inside WhatsApp, that row simply does not exist in the Share sheet. Somebody following
 *     the poster in good faith finds nothing, twice, and concludes the masjid's app is broken.
 *  2. **Installing into a container nobody can find again.** An in-app webview can sometimes
 *     add a home-screen icon that opens back inside that app. It is worse than failing.
 *  3. **A permission prompt nobody asked for.** Notifications are a step here, offered after
 *     the install and never fired on load — a page that asks on arrival is how a browser learns
 *     to block a site permanently, and it would burn the one chance this masjid gets.
 *
 * **Once the app is on the home screen this page is not the destination.** Launched standalone,
 * it redirects straight into the prayer times: somebody who has already done the thing must
 * never be shown the instructions for doing it.
 */
import { useEffect, useState } from 'react';
import {
  ArrowUpFromLine,
  BellRing,
  Check,
  Clock3,
  Copy,
  EllipsisVertical,
  ExternalLink,
  Plus,
  Share,
  TriangleAlert,
} from 'lucide-react';
import { navigate } from './App';
import { withBase } from './base';
import { MasjidLogo } from './ui';
import { Blocked } from './Notify';
import { useReminders } from './reminders';
import { BROWSER_LABEL, preferredBrowser, type Os } from './platform';
import type { Install } from './pwa';

/** Where a step is. Only two states, and the missing third is deliberate: an earlier draft
 *  greyed the reminders step out until the app was installed, which is a rule that is only TRUE
 *  on iOS — and on iOS the reminders step already says so in its own words, because the platform
 *  rule is what produces that text. On Android, notifications work perfectly well in a browser
 *  tab, so dimming the step would have refused something real to make a funnel look tidy. */
type StepState = 'done' | 'now';

export function Onboarding({ install, secure, name }: { install: Install; secure: boolean; name: string }): JSX.Element {
  const reminders = useReminders(secure);
  const [copied, setCopied] = useState(false);

  /**
   * Already installed → the app, not the instructions.
   *
   * `replace`, so the back gesture from the prayer times leaves the app rather than bouncing
   * back here and forward again. This is the "post-install redirect": the home-screen icon
   * opens `start_url`, which is the app root, but somebody may still reach this URL from a
   * bookmark or a second scan of the same poster.
   */
  useEffect(() => {
    if (install.route === 'installed') navigate('/', true);
  }, [install.route]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  };

  // The wrong browser entirely. Nothing else on the page can be done until this is, so it is
  // the only thing on the page — a list of steps under a warning reads as optional.
  if (install.route === 'switch') {
    return (
      <Frame name={name}>
        <WrongBrowser
          os={install.os}
          browser={BROWSER_LABEL[install.browser]}
          inApp={install.inApp}
          copied={copied}
          onCopy={() => void copy()}
        />
        <Skip />
      </Frame>
    );
  }

  // On iOS nothing ever tells us it worked — Safari fires no `appinstalled` and a Safari tab
  // never reports standalone — so step 1 cannot tick itself there and must not pretend to. It
  // says what to do and what will be true afterwards.
  const installed = install.route === 'installed' || install.installed;

  return (
    <Frame name={name}>
      <Step n={1} state={installed ? 'done' : 'now'} title={installed ? 'Added to your home screen' : 'Add it to your home screen'}>
        {installed ? (
          <p className="ob__text">It&rsquo;s on your home screen. Open it from there and it works with no signal.</p>
        ) : (
          <InstallStep install={install} />
        )}
      </Step>

      <Step n={2} state={reminders.on ? 'done' : 'now'} title={reminders.on ? 'Reminders are on' : 'Get a reminder before each jamāʿah'}>
        {reminders.blocker ? (
          <Blocked blocker={reminders.blocker} />
        ) : reminders.on ? (
          <p className="ob__text">
            You&rsquo;ll be reminded before each jamāʿah. Change which prayers, or turn it off, in <b>Settings</b>.
          </p>
        ) : (
          <>
            <p className="ob__text">
              Optional, and only on this phone. The masjid never sees who signed up &mdash; only how many.
            </p>
            {reminders.error && <p className="form-error">{reminders.error}</p>}
            <button className="btn btn--primary" onClick={() => void reminders.enable()} disabled={reminders.busy}>
              {reminders.busy ? <span className="spinner" /> : <BellRing size={15} aria-hidden="true" />}
              Turn on reminders
            </button>
          </>
        )}
      </Step>

      <Step n={3} state="now" title="Open your prayer times">
        <button className="btn" onClick={() => navigate('/')}>
          <Clock3 size={15} aria-hidden="true" />
          Show me the times
        </button>
      </Step>
    </Frame>
  );
}

/** The masjid's name and logo above the steps, so it is obvious whose app this is before
 *  anybody is asked to put it on their phone. */
function Frame({ name, children }: { name: string; children: React.ReactNode }): JSX.Element {
  return (
    <main className="ob">
      <header className="ob__head">
        <MasjidLogo size={54} />
        <h1 className="ob__title">{name}</h1>
        <p className="ob__lead">Prayer times on your phone, in two taps.</p>
      </header>
      {children}
    </main>
  );
}

function Skip(): JSX.Element {
  return (
    <button className="ob__skip" onClick={() => navigate('/')}>
      Just show me the times
    </button>
  );
}

function Step({ n, state, title, children }: { n: number; state: StepState; title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="ob__step">
      <span className={state === 'done' ? 'ob__num ob__num--done' : 'ob__num'} aria-hidden="true">
        {state === 'done' ? <Check size={15} /> : n}
      </span>
      <div className="ob__body">
        <h2 className="ob__step-title">{title}</h2>
        {children}
      </div>
    </section>
  );
}

/** The install instruction, which is a different sentence for every route. */
function InstallStep({ install }: { install: Install }): JSX.Element {
  if (install.route === 'prompt') {
    return (
      <>
        <p className="ob__text">One tap, and it sits with your other apps. No app store, nothing to sign up for.</p>
        <button className="btn btn--primary" onClick={() => void install.install()}>
          <ArrowUpFromLine size={15} aria-hidden="true" />
          Add to home screen
        </button>
        {/* What happens NEXT, shown before it happens. The system dialog is the moment somebody
            hesitates — an unexpected "Install app" box on a phone looks like the thing everyone
            is told to be careful of — and having already seen the picture is what carries them
            through it. */}
        <Shot name="install-android-1.jpg" w={560} h={349} caption="Your phone will ask. Tap Install." />
      </>
    );
  }

  if (install.route === 'ios-safari') {
    return (
      <>
        <p className="ob__text">
          Tap <Glyph label="the Share button"><Share size={15} aria-hidden="true" /></Glyph> at the bottom of the screen,
          scroll down, then tap{' '}
          <Glyph label="Add to Home Screen">
            <Plus size={14} aria-hidden="true" /> Add to Home Screen
          </Glyph>
        </p>
        <Shot name="install-ios-1-share.jpg" w={560} h={604} caption="Scroll down the Share sheet to find it." />
        <MissingRow />
      </>
    );
  }

  if (install.route === 'menu') {
    return (
      <>
        <p className="ob__text">
          Open your browser&rsquo;s menu &mdash;{' '}
          <Glyph label="the menu button"><EllipsisVertical size={15} aria-hidden="true" /></Glyph> in the corner &mdash;
          and choose <b>Install app</b>, or <b>Add to Home screen</b>.
        </p>
        <Shot name="install-android-1.jpg" w={560} h={349} caption="Then tap Install when your phone asks." />
      </>
    );
  }

  if (install.route === 'desktop') {
    return (
      <p className="ob__text">
        You&rsquo;re on a computer. This works fine here, but it&rsquo;s built for a pocket &mdash; scan the code on the
        noticeboard with your phone, or send yourself this page&rsquo;s address.
      </p>
    );
  }

  // `unavailable`: no secure context. Reached on the masjid's own wifi, which is a legitimate
  // way to open this app (a hallway screen) and must not be told it is broken.
  return (
    <p className="ob__text">
      This address only works inside the building, so it can&rsquo;t be added to a home screen. Ask the masjid for the
      link from their noticeboard.
    </p>
  );
}

/**
 * A screenshot of the thing being described.
 *
 * Real photographs of real phones (Hasan supplied them on 2026-08-30), which replaced a drawing
 * of a browser toolbar this file used to carry. The drawing was defensible when there was
 * nothing to license — every screenshot of an iOS Share sheet on the internet is Apple's — and
 * it is simply worse: somebody hunting for a row in a long grey list matches a photograph of
 * that list instantly and an abstraction of it not at all.
 *
 * They are the masjid's own images now, contributed under the CLA and therefore AGPL like the
 * rest of the repository. The other masjid's name and address are BLURRED out of them, which is
 * not about branding: somebody installing "Masjid An-Noor" who reads a different masjid's URL in
 * the instructions reasonably concludes they are installing the wrong thing.
 *
 * `width`/`height` are given so the page does not jump when the image lands — on a step-by-step
 * page, content moving under a thumb mid-read is how somebody taps the wrong thing. `lazy`
 * because on iOS the second and third are inside a closed disclosure most people never open.
 */
function Shot({ name, w, h, caption }: { name: string; w: number; h: number; caption: string }): JSX.Element {
  return (
    <figure className="ob__shot">
      <img
        src={withBase(`/${name}`)}
        width={w}
        height={h}
        loading="lazy"
        decoding="async"
        // Decorative: the caption below and the instruction above say everything the picture
        // does. A screen reader that also described it would read the same step three times.
        alt=""
      />
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

/**
 * "It isn't there" — the dead end that ends the most installs.
 *
 * **Add to Home Screen can be missing from the Share sheet entirely.** It lives in the sheet's
 * actions list, that list is editable, and on a phone where somebody once tidied it — or where
 * enough share extensions are installed to push it under the fold — the row the instructions
 * name is genuinely absent. Somebody following our directions in good faith then scrolls a list
 * that does not contain the thing they were told to tap, twice, and gives up.
 *
 * Behind a disclosure rather than in the step, because it is wrong for most people and a step
 * with two branches in it is a step nobody reads. `<details>` rather than our own toggle: it is
 * keyboard-operable, screen-reader-announced and findable by the browser's own in-page search
 * for free, and this is exactly the content somebody searches a page for.
 */
function MissingRow(): JSX.Element {
  return (
    <details className="ob__more">
      <summary>Can&rsquo;t see &ldquo;Add to Home Screen&rdquo;?</summary>
      <p className="ob__text">
        It can be switched off in the Share sheet. Scroll to the very bottom of the sheet and tap{' '}
        <b>Edit Actions</b>.
      </p>
      <Shot name="install-ios-2-actions.jpg" w={560} h={539} caption="Right at the bottom, under everything else." />
      <p className="ob__text">
        Find <b>Add to Home Screen</b> in the list, add it to your <b>Favorites</b>, then tap the tick. It will be in
        the Share sheet from then on.
      </p>
      <Shot name="install-ios-3-add.jpg" w={560} h={596} caption="Add it to Favorites, then tap ✓." />
    </details>
  );
}

/** An icon or phrase quoted as it appears on the reader's own screen. */
function Glyph({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <span className="ob__glyph" role="img" aria-label={label}>
      {children}
    </span>
  );
}

/**
 * "This browser can't do it" — the screen that saves the most people.
 *
 * It cannot open the other browser for us. **No web page can hand itself to another app**, on
 * either platform, and pretending otherwise with a `googlechrome://` link would fail silently
 * on the phones that matter. So the useful thing is the address, on the clipboard, and one
 * sentence about where to paste it.
 */
function WrongBrowser({
  os,
  browser,
  inApp,
  copied,
  onCopy,
}: {
  os: Os;
  browser: string;
  /** The app this page is trapped inside, by name, or ''. */
  inApp: string;
  copied: boolean;
  onCopy: () => void;
}): JSX.Element {
  const target = preferredBrowser(os);
  return (
    <section className="ob__step ob__step--warn">
      <span className="ob__num ob__num--warn" aria-hidden="true">
        <TriangleAlert size={16} />
      </span>
      <div className="ob__body">
        <h2 className="ob__step-title">Open this in {target} first</h2>
        <p className="ob__text">
          {/* Named where we know the name. "Inside Instagram" is something a reader can check
              against what is on their own screen; "in-app browser" is a phrase they would have
              to be told the meaning of first. */}
          {inApp
            ? `You tapped this link inside ${inApp === 'another app' ? 'another app' : inApp}, and its built-in browser can’t add anything to your home screen.`
            : `${browser} can’t add a web app to the home screen on ${os === 'ios' ? 'an iPhone or iPad' : 'this phone'}.`}{' '}
          {os === 'ios' ? (
            <>
              On an iPhone that&rsquo;s something only <b>Safari</b> can do.
            </>
          ) : (
            <>
              Open it in <b>{target}</b> and it will offer to.
            </>
          )}
        </p>

        <ol className="ob__steps">
          <li>Copy this page&rsquo;s address with the button below.</li>
          <li>
            Open <b>{target}</b>.
          </li>
          <li>Paste it into the address bar and go.</li>
        </ol>

        <button className="btn btn--primary" onClick={onCopy}>
          {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
          {copied ? `Copied — now paste it in ${target}` : 'Copy this page’s address'}
        </button>

        <p className="ob__text ob__text--small">
          <ExternalLink size={13} aria-hidden="true" style={{ verticalAlign: '-0.15em', marginInlineEnd: '0.3rem' }} />
          Some apps also have <b>Open in browser</b> in their own menu, which does the same thing.
        </p>

        {/* The address in full, because a clipboard is refused more often inside an in-app
            browser than anywhere else and a reader who cannot copy can still read it out. */}
        <p className="ob__addr">{typeof location === 'undefined' ? '' : location.href}</p>
      </div>
    </section>
  );
}

