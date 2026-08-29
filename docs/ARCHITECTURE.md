<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Architecture

The decisions behind OpenMasjid Companion, and *why* — kept current as the app is built.
[`CLAUDE.md`](../CLAUDE.md) is the specification; this is the record of what was actually done and
what it cost. Where the two disagree, the code wins and both documents get fixed.

---

## The shape

One container. A Fastify server that is the API, the static host for the built web app, the SQLite
store, and (from a later slice) the push scheduler. One image to install, one to update.

```
server/   Node 22 + Fastify 5 + better-sqlite3 + zod
web/      React 18 + Vite + Tailwind (utilities only) over Display's design tokens
```

The web half is one bundle serving two very different audiences — a musalli's phone and a
volunteer's admin panel — so the admin half is lazy-loaded and never lands in a musalli's first
load.

## The data-flow doctrine

The musalli's phone only ever talks to **this** app. Everything else is server-to-server:

| upstream                 | how                                                       | when it fails                                                              |
| ------------------------ | --------------------------------------------------------- | -------------------------------------------------------------------------- |
| OpenMasjid **Display**   | the platform's app-to-app broker (LAN-only, by design)     | serve the cached timetable with a visible "last updated"; never invent one   |
| OpenMasjid **Donations** | public HTTPS to the masjid's own donor site                | serve the cached tile, or drop the tile; the rest of the app is unaffected   |
| **OpenMasjidOS** core    | the Fabric (`/api/auth/session`, `/api/fabric/site`, …)    | "no Fabric this request" — never a crash, never a lock-out                   |

Every upstream is optional at runtime. That is not politeness; it is the only way a phone-facing
page on a Raspberry Pi is dependable.

---

## Decisions

### Base-path awareness is in slice 1, not "later"

*Decision.* The tunnel's path prefix is stripped once, in Fastify's `rewriteUrl`, before routing —
and injected back into `index.html` twice, as `<base href>` and as `window.__OMOS_BASE__`. See
[`server/src/basePath.ts`](../server/src/basePath.ts).

*Why first.* This app is reached at **two addresses simultaneously**: `/api/app` from the LAN and
`/companion/api/app` (or whatever the masjid renamed the path to) from a phone. The LAN form is the
one a developer sees, and it keeps working perfectly while the tunnelled form serves a blank page —
so the failure is invisible in exactly the place it would be found. Retrofitting it would mean
auditing every route, every asset URL, every fetch and every link in the app at once. Doing it
first means no route in the app is ever written in a way that needs auditing.

*Why two injections and not one.* `<base href>` fixes RELATIVE URLs, which is what Vite emits for
assets. It does nothing for `fetch('/api/app')`, which is root-absolute and would leave this app
entirely. Both are needed and they solve different problems.

*Why the prefix comes from the platform and is never assumed.* The admin can rename the path in
Settings → Remote access. `GET /api/fabric/site` is the live source of truth; `OPENMASJID_PUBLIC_URL`
is its convenience mirror. Nothing is derived from the request's `Host` header — that is
attacker-controlled on any request and simply absent in a background job like the push scheduler.

### Non-root and read-only rootfs from day one

*Decision.* `user: "1000:1000"` + `read_only: true` in the compose, with `/data` created and chowned
in the Dockerfile.

*Why.* Both sibling apps record "full non-root + read-only rootfs" as a known gap they did not
close, because closing it on a live app means migrating volumes that are already root-owned on real
masjids' boxes. A new app has no such installed base: a fresh named volume inherits the ownership of
the image's directory, so it costs one `chown` line here and nothing at all later. The window to do
this for free closes the moment the app is listed.

### The store holds nothing the platform owns

*Decision.* `OPENMASJID_BASE_URL`, `OPENMASJID_APP_SECRET` and `OPENMASJID_PUBLIC_URL` are read from
the environment on every process start and never written to `/data`. A test asserts the settings
table contains nothing resembling them.

*Why.* The platform rewrites all three across a restore onto a new machine, a domain change and a
secret rotation. A cached copy would survive the change and point at the old box — and the symptom
would be sign-in, prayer times and every link on the poster breaking at once, for a reason nothing
in the app reports.

### A key/value settings table, and real tables for rows

*Decision.* One `settings(key, value)` table for the dozen unrelated scalars this app's
configuration amounts to; a real table for anything with rows (push subscriptions, curated appeals).

*Why.* A column and a migration per scalar is a lot of ceremony for a value read once per request.
Rows are different: they need indexes, constraints and deletion semantics, and a JSON blob would
make pruning a dead push subscription a read-modify-write of every subscription the masjid has.

### The `/api/setup` guard, and why reachability is a separate answer

*Decision.* `probePlatform()` returns `{ username, reachable }`, not a username. `POST
/api/setup` refuses with 403 while the platform is **reachable** and SSO is configured, and
allows a password to be set the moment it is not.

*Why both halves.* `hasAdmin()` is false for the entire life of a normal SSO install — the admin
never needs a local password — so without the guard there is a window lasting *for ever* in which
anyone who can reach the box, over the LAN or the tunnel, can claim the admin account before the
real admin thinks to. And without the exception, a masjid restoring a backup onto a new machine
is locked out of their own app with on-screen advice ("press Open in your dashboard") that cannot
possibly work. The two failures pull in opposite directions and only a reachability signal
separates them.

The `session.test.ts` suite runs a real HTTP server as a stand-in platform rather than stubbing
the probe, so the routes are asserted against a platform rather than against a mock of our own
assumptions — including the case where the platform is switched off mid-test.

### An SSO session is capped at an hour; a password session lasts 30 days

*Why the asymmetry.* The platform's answer is a snapshot taken at one moment. An admin who signs
out of the dashboard should not remain signed in here for a month on the strength of one
45-second-old "yes". A password session is different in kind: whoever holds the password *is* the
credential, and someone using it is by definition unable to use the front door, so making them
retype it hourly buys nothing.

### The admin panel is lazy-loaded, and must stay that way

*Decision.* `const Admin = lazy(() => import('./admin/Admin'))` — its own Vite chunk.

*Why.* The two halves of this app have opposite constraints. The musalli page is opened on a
phone, on masjid wifi or one bar of mobile data, by someone who wants one number; the panel is
opened by one volunteer at a desk. Letting the panel into the first load makes every musalli pay
for it. The relative `base` in the Vite config means the chunk's URL resolves against the injected
`<base href>`, so it loads correctly under the tunnel prefix too.

### The licence is a test, not a convention

*Decision.* [`licenseHeaders.test.ts`](../server/src/licenseHeaders.test.ts) walks the whole
repository — the web half, the workflows and the compose included — and fails if a file is missing
its AGPL-3.0 header or declares a different licence.

*Why.* "Every file carries a header" is a rule people follow until the day they are in a hurry, and
the consequence is a file shipped inside an image under a licence it never declared. It costs
nothing to assert, and the assertion is the only version of the rule that is actually enforced.

### Two contract-with-code tests instead of two conventions

[`testFileCoverage.test.ts`](../server/src/testFileCoverage.test.ts) fails if a `*.test.ts` on disk
is missing from the explicit `test` script, because a test that silently never runs is worse than no
test — it is trusted. [`manifest.test.ts`](../server/src/manifest.test.ts) asserts the things about
`manifest.yaml` and `docker-compose.yml` that fail *silently* on a real box: a missing
`${OPENMASJID_*}` reference (which makes every Fabric call a no-op with nothing in any log), a
compose tag that has drifted from the manifest version (which makes the dev channel install a build
that is not this commit), and the capability set itself.

---

## Deliberate absences

| not here                     | why                                                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| any prayer-time calculation  | Display owns it. A time invented here would look completely plausible and be acted on by a congregation.                                                             |
| any payment code             | Donations owns it. This app reads public appeal metadata and links out.                                                                                              |
| an inbound `/fabric/*` route | v1 declares no `fabric.provides`, so no such route exists in the server to get wrong. Adding one later means adopting Display's envelope rules exactly — see its `fabricInbound.ts`. |
| `cloudflared` in the image   | Remote access is the platform's job — one tunnel for every app, visible in the dashboard. A second tunnel from inside this container would be a public entrance to the masjid that nobody can see or turn off. |
| a router library             | A handful of flat routes and a `switch`. The musalli bundle is the product.                                                                                          |
| a websocket                  | Nothing here needs a live channel; the countdown ticks in the browser.                                                                                               |

---

## Decisions taken outside CLAUDE.md

Recorded here because both are small, deliberate departures from the letter of the spec.

### Shurūq is shown, though §4 does not list it

*Decided by Hasan, 2026-08-23.* Display's shipped feed carries a `sunrise` per day — additive to
the agreed contract, and free for Display to compute. `CLAUDE.md` §4's v1 list does not mention
it. It is shown: one row on the today, week and month views, styled apart from the five jamā'āt
because it is a sun event rather than a prayer and has no Iqamah. A masjid timetable without
Shurūq looks incomplete, and the data is already on the wire.

### The IANA timezone database, without a date library

`CLAUDE.md` §14 asks for "a real IANA-tz date library". This app instead uses a small, heavily
tested helper over `Intl.DateTimeFormat` with an explicit `timeZone`.

*Why.* `Intl` **is** the IANA database — the same tzdata, shipped with Node and kept current by
it, with no dependency to add to a Pi-friendly image and nothing to keep patched. Display, which
owns the far harder version of this problem, does the same thing (`zonedNoon`, `effectiveTimeZone`).

*What it costs.* The conversions this app needs — a date plus "HH:mm" plus an IANA zone, into an
instant — have to be written and tested rather than called. That is exactly where the DST tests
§14 requires already have to live, so the tests are not extra work; the arithmetic is. If this
turns out to be wrong, it is one module to swap for Luxon.

## Slice 3 — the app knows where it lives (0.1.0-dev.3)

**`site.ts` is the only module allowed to decide the base path.** `GET /api/fabric/site` is the
live source of truth for our public URL and path prefix; `OPENMASJID_PUBLIC_URL` is only the
value we had at boot. Its pathname *is* the base path, so it is applied at import — that closes
the window between process start and the first successful lookup, during which every tunnelled
request would otherwise 404.

**A failed site lookup changes nothing.** Not the base path, not the public URL, not `enabled`.
The tunnel is Cloudflare's and this container is ours; both keep working while the OpenMasjidOS
core restarts, so treating "cannot reach the core" as "no remote access" would take the app off
the internet for the duration of a platform hiccup. `site.ts` reports `ok: false` separately
instead, and the admin panel renders that as its own state.

**Appearance and logo are relayed, not fetched by the browser.** Our page is HTTPS behind the
tunnel; the platform is plain HTTP on the LAN. A direct fetch is mixed content — it would work
in dev, work on the LAN, and be blocked in the only place a musalli ever opens the app.

**`cache.ts` is the shape every upstream gets.** TTL + in-flight dedupe + serve-stale-on-error,
with the loader signalling failure by returning `KEEP` rather than throwing (every fetch here is
written not to throw). `at` is the age of the *data*, never of the last attempt, because that is
what a staleness marker has to report. The timetable and campaign caches will use it unchanged.

**`fetchLogo` distinguishes `'none'` from `'unavailable'`.** Both render as "no logo", but only
one should be cached for five minutes: a core that was restarting when the first phone opened
the app must not pin the fallback mark on everyone for the rest of the TTL.

**The sky is two layers, not one.** `data-theme` owns ink and contrast; `data-sky` owns hue and
the celestial glow. That is what lets the background follow the time of day without ever being
able to break AA — measured across five phases in both themes, and the one element that failed
(the footer's AGPL source link, at 2.8:1 against the midday sky) was given its own ground.

**The web half has tests now.** `node --test` via tsx, mirroring the server, with the same
explicit-file-list guard. It exists because the countdown, the current-prayer highlight and the
push scheduler all rest on the timezone arithmetic that starts in `sky.ts`, and CLAUDE.md §14
makes DST coverage non-negotiable.

## Slice 4 — the prayer times (0.1.0-dev.4)

**`timetable.ts` is transport and validation; `timetableService.ts` is policy.** The split keeps
the zod schemas testable without a clock and the caching testable without a network.

**Every failure carries `retryable`.** `BrokerFailure` in fabric.ts maps the platform's codes and
Display's own onto one shape with a plain-English sentence for the admin. Two of them —
`unknown_timetable` and `no_location` — are *settled*: retrying produces the identical failure
for ever, so they are flagged not-retryable and the panel names the action instead. Getting that
field backwards on any row is either a retry loop against something that cannot succeed, or
giving up on a blip and serving stale times until a human notices.

**The window starts a day early.** "Today" differs by zone, and before the first feed arrives we
do not know the masjid's. One extra day guarantees the masjid's real today is in the window from
any zone on earth. It is also what makes "after Isha, next is tomorrow's Fajr" work at all.

**A feed for the wrong id is refused outright.** Never observed, but rendering it would put
another hall's jamā'ah times under this masjid's name, which is the worst output this app has.

**The dev stub was never built.** CLAUDE.md §6.5 gated it on "until Display ships the
capability", and Display shipped first — so there is no branch anywhere in this server that can
produce a prayer time. Development without a Display container drives a fake *platform*, which
exercises the real broker client, schemas and error mapping instead of bypassing them.

**`slotTime` is the single source of truth for where a row sits on the timeline**, and Jumu'ah is
the reason it exists. Display has no per-Jumu'ah Adhan field, so every Jumu'ah on a Friday
carries that day's one Dhuhr Adhan; placing them by it put two jamā'āt on the same instant —
both rows highlighted, and the countdown skipped the first to name the last. They are placed by
their jamā'ah time, and the row renderer calls the same function so the highlight cannot land on
a different line than the timeline says.

**The sky lost its five phases** (Hasan, 2026-08-24): one design throughout, one look per theme.
The musalli page also stops inheriting the masjid's accent and uses a fixed coral palette scoped
to `[data-surface="musalli"]`; the admin panel still inherits it. See docs/DESIGN_LANGUAGE.md.

**Contrast is measured, not eyeballed.** A harness samples the rendered pixels behind every text
element in both themes. It has caught two real AA failures across slices 3 and 4.

## Slice 5 — the PWA (0.1.0-dev.5)

**`png.ts` is a PNG codec with no dependencies.** Deriving an icon needs read → scale → write,
and nothing else. `sharp` is a native module and a real problem on arm64; the pure-JS libraries
are large. Node already ships zlib, which is the only hard part of PNG — the rest is chunk
framing and unfiltering scanlines. CLAUDE.md §10 explicitly allows a plain resizer because this
runs once at upload, not on a request path. Scope is deliberately narrow: non-interlaced only,
Adam7 refused by name rather than half-supported.

It is also what makes CLAUDE.md §13's "nothing is served back byte-for-byte from an upload"
TRUE rather than aspirational: an upload is decoded to pixels and a fresh file written from
them, so no chunk, comment, colour profile or trailing data survives. There is a test that
splices a payload into a tEXt chunk and asserts it is gone.

**The icon has four sources, in order:** an upload here → the logo on the chosen timetable in
Display (work order #2) → the platform's logo → the bundled mark. Each falls through on any
failure, so it always resolves to something. Derivation is keyed on a sha256 of the SOURCE
bytes, so the hourly re-check costs one hash unless the masjid actually changed their logo.

Only PNG sources can be derived from, and that is a decision rather than an omission: §10
specifies a PNG upload, Display's own uploader re-encodes to PNG, and decoding JPEG would mean
the dependency this file exists to avoid. A source we cannot decode falls through.

**The manifest is generated per request** and every field in it is dynamic — the name is a
setting, `scope`/`start_url` are the tunnel path the admin can rename, the language follows the
timetable. A static manifest would be wrong for every masjid but the first. `scope` missing the
prefix is the failure worth knowing about: the app installs happily and then every navigation
escapes into whatever else the masjid serves at their domain root.

**The name is never the software's.** `installName` falls back to the masjid's name and then to
a generic phrase, never "OpenMasjid Companion". A musalli installed their masjid.

**The service worker is served from `<basePath>/sw.js`**, which is what makes its scope correct
with no `Service-Worker-Allowed` games — the payoff of stripping the prefix before routing. It
is served `no-cache`, because a worker in the browser's HTTP cache is a worker that cannot be
replaced, and it holds the app's shell. Cache names carry the app version so a new build never
reads the previous one's HTML. It never caches `/admin` or `/api/admin`.

**An update never reloads the page on its own.** The new worker waits; the reader presses
Refresh. Swapping it mid-read reloads what someone was looking at.

**`secure` comes from the SERVER, not `location.protocol`.** A kiosk reaching this app at
`http://192.168.1.20:7880` is a normal deployment and must not be told it is broken — it simply
gets no worker and no install strip, which is correct (CLAUDE.md §6.4).

**iOS is detected, not feature-detected.** Safari fires no `beforeinstallprompt` and exposes no
API, and the absence of an event is indistinguishable from one that has not fired yet. An app
that waits shows an iPhone user nothing, for ever — so iOS gets the Share-sheet instructions and
no button.

## Slice 6 — the noticeboard (0.1.0-dev.6)

**Opening from the dashboard lands on `/admin`.** The platform's `openApp` always opens an app at
its ROOT and there is no manifest field for a path, so the app decides for itself: the dashboard
appends `#omos=…`, and only for apps that declared the Fabric. That makes the fragment a
reliable "the admin arrived from their dashboard" signal.

It is captured in `prefs.ts` at MODULE LOAD, not later — `hydrate()` strips the fragment off the
URL once it has read the appearance out of it, so anything asking afterwards always sees a clean
URL and concludes nobody came from the dashboard. Applied in `main.tsx` before the first render,
with `replaceState` so Back does not bounce them straight back in.

The rule is narrow in both directions: only from the root (a deep link already said where it
wanted to go) and only with the fragment (a musalli who scanned the QR must never be thrown into
an admin login).

**The panel keeps its own sub-route.** `routeOf` collapses every `/admin/*` path to one route, so
navigating from the panel to the poster leaves App's state identical, React bails out of the
no-op setState, and nothing re-renders — reading `location` during render goes stale exactly when
it matters. The panel listens for `popstate` itself.

**The QR encodes the platform's public URL and nothing else.** Never the address the volunteer
is looking at: a poster carrying `http://192.168.1.20:7880` works for everyone standing inside
on the masjid's wifi and for nobody outside, and posters do not get reprinted. When remote
access is off, the card refuses to draw one and says why.

Rendered as SVG rather than canvas, black on white whatever the theme, with a wide quiet zone —
the three things that decide whether a phone reads it off a wall in bad light.

**`qrcode.react` is the one new dependency**, pre-approved in CLAUDE.md §14. It lands in the
LAZY admin chunk (49.7 kB), so the musalli bundle is unchanged — which is the whole reason the
panel is code-split.

**The poster is a print target, not a card.** Always light whatever the admin's theme: a dark
poster is a cartridge of ink and an unreadable QR code. The print stylesheet hides the toolbar,
the sky and the chrome, and `break-inside: avoid` keeps a step and its hints off the fold.
Verified under `emulateMedia({ media: 'print' })` rather than by eye.

## Slice 7 — the UI revision (0.1.0-dev.7)

**The Iqamah leads.** A musalli checking their phone is working out when to leave the house, and
that is the jamā'ah time. Three columns under real headings replace the old "Adhan big, Jamā'ah
X small" row — which also quietly fixes a Friday problem: every Jumu'ah that day carries the
same Adhan (Display has no per-Jumu'ah one), so two rows showing an identical Adhan read as a
mistake unlabelled and as exactly what they are under a heading.

**Six skies, one per prayer period.** Reverses the slice-4 decision — see DESIGN_LANGUAGE.md for
why the first reading was wrong. `data-period` selects the sky; `periodTheme.ts` maps period to
light/dark and `setThemeOverride` makes it beat the browser preference. The override lives in
prefs.ts rather than being written straight onto the element, because `applyTheme` is called
from three places (hydrate, a prefs patch, and the live `prefers-color-scheme` listener) and any
one of them would otherwise silently undo it a moment later.

**`--ink-scene-faint` is a large-text-only token.** It cannot reach 4.5:1 against any tinted
sky; three uses at body size were moved to `--ink-scene-muted`.

**Swipe is decided by which axis moves first**, and once decided as a scroll it is left alone
for the rest of the touch. The failure that matters is not a missed swipe but a STOLEN one: a
prayer page that jumps to tomorrow when someone scrolls is worse than one with no swipe at all,
because it happens to people who were not trying. Pointer events, not touch, so a trackpad drag
works and nothing needs a non-passive listener. `swipeResult` is pure so the rule is testable.

**The month view marks only jamā'ah changes.** Adhan times move daily and nobody needs telling;
jamā'ah times hold for a week or two and then change, and that is the day somebody turns up at
the wrong time. `iqamahChanges` deliberately excludes Jumu'ah — it appears on Fridays and only
Fridays, so including it would mark every Friday and every Saturday, fifty-two false marks a
year. The legend is scoped to the VISIBLE month: a legend pointing at nothing reads as broken.

**A fixed warm tint, not `var(--coral)`, marks a change day.** The light theme's coral is a dark
brown-red; at a low alpha over a pale sky it desaturates into grey and the day reads as disabled
rather than flagged.

**The "Today" chip became a button.** It used to print `formatDate(...).split(' ')[0]` — which on
"Saturday, August 29" is "Saturday," with the comma, and was redundant beside the full date
directly below it.

## Slice 8 — appeals, and the month view's offset bug (0.1.0-dev.8)

### The month view was marking every single day

Reported from real data. The cause is that **a masjid sets a jamā'ah in one of two ways, and
both look like "the number moved"** from outside:

- **a clock time** — "Fajr jamā'ah is 5:30", which holds until the committee revises it and has
  a gap to the adhan that drifts a minute a day underneath it;
- **an offset** — "Maghrib is five minutes after the adhan", whose printed time moves EVERY DAY
  because the adhan does, with nobody having decided anything.

The old rule compared printed times, so a masjid with an offset Maghrib had all thirty days
marked — and a mark on every day carries exactly as much information as no mark at all. The new
rule (`prayerChanged` in web/src/prayerTimes.ts) says nothing changed if **either** the clock
time held **or** the gap held. Neither test is sufficient alone: comparing gaps would mark every
day of a fixed Fajr, for the mirror-image reason.

Measured against a feed with a real offset Maghrib: **36 of 36 days marked → 3 of 30.**

**What the rule cannot see, and the reason for a setting.** An offset ROUNDED to the next five
minutes — which is what most masjids actually print for Maghrib — holds for four days and then
jumps five while the adhan moved one. From outside that is indistinguishable from a small
committee revision, and no cleverer rule fixes it because the information is not in the numbers.
So Maghrib is excluded by default and the admin gets a switch (`POST /api/admin/month-marks`,
stored as `month.maghrib`). With the same feed rounded: 3 marks off, 8 on.

The setting is **masjid-wide, not per-phone** — a mark is a claim about this masjid's decisions,
so it travels in `/api/public/timetable`. That payload is ETag-validated, and **the ETag had to
grow the setting**: without it, a phone revalidating after the admin flips the switch gets a 304
because the days did not change, and keeps marking the old days until its cache expires — a
setting that visibly does nothing.

### The install ask is a dialog now

It was a strip at the foot of the page, on the reasoning that an install prompt must not stand
in front of the prayer times. On a phone the foot of the page is below the fold, so that was not
a gentler ask, it was an invisible one. It is now a centred modal that waits ~1.4 s for the
times to paint first, traps Tab, closes on Escape / the backdrop / either button, and stays
closed. The update notice is still a strip: nobody needs stopping to be told a version exists.

### Appeals (CLAUDE.md §8)

`server/src/campaigns.ts` reads Donations' existing public donor-page JSON. Zero Donations-side
changes; no Stripe, no amount, no intent — the tap-through to their donor page is the whole
interaction.

- **Curation is by pasted links**, whole-list-at-once. One endpoint rather than
  add/remove/reorder, because the ORDER is the setting and three endpoints mutating one array
  would have to agree about two open tabs. A bad line refuses the whole submission and quotes
  itself back: saving the nine that parsed and dropping the tenth is how an appeal goes missing.
- **Gone ≠ could-not-ask.** 404 is a settled answer worth caching; a 5xx or a timeout keeps what
  we have. Collapsing them would delete a masjid's Ramadan appeal from the noticeboard because a
  container restarted while one phone was open.
- **Hidden from phones, named to the admin**: an appeal that is gone, or that Donations says
  cannot take a donation. A tile spends the one tap a musalli was going to give it, and a QR
  code on a noticeboard is not where you find out an appeal is switched off.
- **A test-mode appeal is NOT hidden** — the masjid chose to feature it and Donations badges its
  own page — but the admin is warned. §8 asks for exactly this split.
- The whole payload is parsed with per-field `.catch()`, so a field Donations renames loses one
  number rather than emptying the section. Image URLs go through `safeImage`, resolved against
  the DONATIONS base because that is where they were written.
- `https` is required on a public host, with a message that says why (mixed content, and a
  phone that is not in the building). A private address is allowed and **flagged** — a masjid
  testing on their LAN is being reasonable, it just works for nobody else.

## Slice 8a — why an appeal would not load (0.1.0-dev.9)

Reported from a real box: a public https share link, copied from the Donations dashboard, that
opens fine in a browser, and the panel said *"We couldn't reach this appeal."*

**The reporting was the bug, whatever the cause turns out to be.** One sentence covered seven
distinct failures, and the sentence it chose named the one explanation the admin had already
disproved by opening the link. So the fetch now classifies:

| cause | what the admin is told |
| --- | --- |
| `dns` | the server can't look up that hostname, even though a phone can |
| `refused` | something on the network refused the connection |
| `tls` | the certificate could not be verified |
| `timeout` | no answer in time |
| `redirect` | redirected somewhere we won't follow — e.g. a Cloudflare Access login |
| `http` | the status, with 401/403 called out as an access rule rather than a bad link |
| `body` | something answered, but it wasn't an appeal |

Each has a volunteer-readable sentence **and** a one-line technical detail, because the person
fixing a tunnel is not always the person who pasted the link.

### Why this call leaves the building at all

Worth writing down, because it looks like it shouldn't have to. The platform does **not** run a
LAN reverse proxy that routes `/donations/*` — path routing is a Cloudflare **Public Hostname**
rule (`OpenMasjidOS packages/core/src/apps/manager.ts`, `getAppPath`), and the core reaches apps
by their published host port through the Fabric broker, which we have no grant for. So Companion
reaching Donations by its public URL is a genuine round trip out to Cloudflare and back, and it
depends on the box having working outbound DNS and internet. **The durable fix is a Fabric
capability on Donations** (`donations/campaigns`, LAN-only) — a cross-repo work order, not
something to invent from here.

### `redirect: 'error'` has one exception now

Every other outbound call presents `X-OpenMasjid-App-Secret`; that is *why* the rule exists.
The campaign fetch presents nothing, so refusing a redirect buys no secrecy while breaking a
canonical-host or trailing-slash rule at the edge. Up to 3 hops, taken by hand, each allowed
only if **same-origin** or **public https**. A public link may not bounce us onto `192.168.x.x`.
Also sends a real `User-Agent`: an unnamed client is what a WAF blocks first.

## Slice 8b — Add to Home Screen is a Safari feature, not an iOS one

Every browser on iOS is WebKit, so they are indistinguishable to feature detection — but only
Safari's own share sheet installs a web app. Chrome on iOS, and the in-app browser that opens
when someone taps a link in WhatsApp, have no such button, and the old dialog told those users
to look for one. There is no way to tell except the user agent, so `isIosSafari()` is a
**denylist**: every impostor carries its own token *and* "Safari/605", so testing FOR Safari
matches all of them. An unrecognised browser is assumed to be Safari — the safer way round,
since being wrong shows Share-sheet instructions that are at least true of iOS, where being
wrong the other way tells someone already in Safari to go and open Safari. Pinned in
`web/src/pwa.test.ts`: the strings are the whole mechanism.

The dialog's icon is centred with `display: block; margin-inline: auto` rather than the card's
`text-align: center`, which an `<img>` only obeys while nothing makes images blocks.

## Slice 8c — tabs (0.1.0-dev.10)

A phone-shaped app gets phone-shaped navigation. **Salah** and **Donate** along the bottom,
where a thumb already is; **Qibla** joins them when it is built, which is one entry in
`tabsFor` rather than a layout change.

**The bar is drawn only when there are at least two places to go.** A masjid with no appeals —
most masjids, most of the year — gets no bar rather than a single lit tab labelled "Salah" over
the only page there is. That is a label occupying the most valuable strip of a phone screen, not
navigation. So `useCampaigns` is lifted out of the page and into the shell: the bar needs the
count to decide whether to exist, and fetching per page would re-request on every switch.

`null` (not asked yet) and `[]` (asked, none) are kept apart, because drawing a tab on a maybe
would make the bar appear a moment after the page settled — moving the thing under someone's
thumb.

The tabs are real `<a href>`s so a long-press offers "open in new tab" like any link; the
handler only takes the plain left-click. `aria-current="page"`, not `aria-selected`: these are
links to pages, not tabs in a tabpanel widget.

`/give` is a route, so it is bookmarkable — and bookmarkable means reachable after the last
appeal ended, which is why the page has a real empty state rather than rendering nothing.
`.shell--tabs` pays for the height the fixed bar covers, in one rule, rather than every page
inside it remembering to leave room.

### The update notice moved to the top

Hasan's ask, and it is the right way round: at the foot of a phone page it was below the fold.

**Fixed, not in the flow.** It appears while somebody is already reading, so inserting it at the
top of the document would shove the page down under their thumb — on a page of times, that is
how you tap the wrong day.

**Opaque, unlike the frosted tab bar.** At 92% the masjid name behind it read straight through
the words. A tab bar can be translucent because its labels are short and always in the same
place; a sentence cannot. Dismissible, and dismissing is not a refusal — the new build is
already downloaded and takes over on the next visit either way. The button only offers it now.

## Slice 9 — prayer notifications (0.1.0-dev.11)

Self-hosted end to end: our own VAPID keypair, `web-push`, and no third party anywhere in the
loop. `push.ts` holds the keys, the subscriptions and one send; `pushScheduler.ts` decides the
moment; `zoned.ts` turns the masjid's wall clock into an instant.

### What is stored about a musalli, in full

Endpoint, two keys, which prayers, when, two timestamps. **That is the row.** No name, no phone,
no IP, no history. The admin is shown a COUNT and there is **no route in this app that returns
an endpoint** — which is the only way to be sure one is never rendered, and a test asserts the
admin response body contains no endpoint whatever shape a future field takes. In logs an
endpoint appears as `host#8-hex`: enough to see which push service is failing, not enough to
say whose phone.

### Four rules in the scheduler, each preventing a real harm

1. **Never from stale data.** Past 48 hours nothing is sent at all. A confident "Maghrib in 10
   minutes" from two-day-old times is worse than silence *because somebody acts on it* — they
   leave the house.
2. **Never a backlog.** A box that was off for six hours does not deliver six hours of missed
   reminders on the way back up. Anything past `GRACE_MS` is dropped, not queued.
3. **Idempotent by construction.** Each row carries `sentThrough`; a tick considers only
   `(sentThrough, now]` and then advances it. The notification `tag` collapses a duplicate on
   the phone besides.
4. **Jitter.** Fifty phones want Maghrib at the same second; one burst is how a push service
   starts rate-limiting a masjid's box.

410/404 prunes the row at once. Anything else keeps it — a push service having a bad ten minutes
must not empty a masjid's subscriber list. Bulk rejection (≥5 attempts, ≥50% failing) raises
`push-failing` **once per episode**.

### Timezones, and a comment that was wrong

`zonedTimeToEpoch` is the same two-pass algorithm as the web half, deliberately duplicated —
the two are separate builds and a shared module would be a build-time dependency for eleven
lines of arithmetic. Both are tested against real DST transitions, which is what actually keeps
them honest.

Writing those tests found that **both copies carried a comment claiming a behaviour the code
does not have**: a time inside the spring-forward gap resolves to the hour *before*, not the
instant the clock jumps to. It cannot arise from Display, which computes in the masjid's own
zone and so only emits times its wall clock actually showed — but the comment is now what the
code does, and the test pins it.

### The wire is tested for real

Every other test stubs the send. One does not: it stands up an HTTPS listener with a throwaway
self-signed certificate, lets `web-push` sign and encrypt for real, and asserts the body is
`aes128gcm`, the `Authorization` is a well-formed VAPID token, **no plaintext is on the wire**,
and the private key never leaves the process — plus that a real 410 reads as `gone` and a real
503 as `failed`. Skipped where `openssl` is absent rather than failed.

### The platform truths the UI has to say out loud

Each is otherwise a switch that silently does nothing:

- **No secure context** → no PushManager at all. The server says whether we have one; guessing
  from `location.protocol` would break a LAN kiosk, which is a legitimate way to open this app.
- **iOS needs the Home Screen first.** Checked *before* "your browser doesn't support this",
  because iOS Safari in a tab reports no PushManager — and that message would be both wrong and
  unactionable when the same browser works perfectly once installed.
- **Permission can be denied for good.** No amount of asking helps; the way back is the
  browser's own settings, so that is what it says.

Permission is requested on a real tap and never on load. Turning reminders off **removes** the
subscription rather than muting it.

A measured detail: the selected chip's white-on-coral came out at 4.55:1 on the light skies —
over the line with nothing to spare, the same shape as the Hijri coral that nearly failed
earlier. Chip text is small text and has the 4.5 floor, so the light surface uses the darker
tone already in the palette: 5.88:1.
