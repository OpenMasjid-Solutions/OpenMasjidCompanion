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

## Slice 10 — announcements (0.1.0-dev.12)

An admin types a notice, confirms it, and it goes to every phone that has not turned notices
off. CLAUDE.md §4 had this under *Later*; Hasan pulled it forward on 2026-08-29. The half that
needed a Display capability (automatic Iqamah-change notices) is still Later — the two were
separable, and the admin-authored half needs nothing from anybody.

**Announcements are a separate choice from the prayer reminders.** A musalli who unticked every
prayer wants silence at prayer times, not to be unreachable when the masjid has something to
say. Broadcasting to them anyway on the grounds that they "opted into notifications" is the
reasoning that trains people to block a site. The field defaults to `true`, which is also the
right value for every subscription written before it existed.

**It is the only thing in this app that reaches a musalli unbidden, and it cannot be recalled.**
So it is hard to do by accident and easy to do deliberately:

- The Send button does not send. It **asks** — naming the real audience size, not the subscriber
  count — and **quotes the message back**, because the thing being confirmed is the words.
- **Editing after asking cancels the confirmation**, so an edit can never go out under a
  confirmation given for different words.
- The server requires `confirm: true` explicitly. An absent flag is a refusal, so a mis-fired
  request or a curl typed from memory cannot broadcast on its own.
- A **60-second cooldown**, claimed *before* the first send so two simultaneous requests cannot
  both pass it. Not a policy about how much a masjid may say to its congregation — an accident
  guard, because a double-tap is not undoable.
- Refused rather than truncated when too long: half a sentence, unrecallably, on every phone.
- The **text is never logged.** It is the masjid's message to its congregation and a log is a
  file someone else may read. The counts are what an operator needs.

`sentThrough` is deliberately **not** advanced by a broadcast — otherwise a notice sent at 19:35
would silently swallow a Maghrib reminder due in the same second. And the staleness rule does
not apply: it exists so this app never states a prayer TIME it cannot stand behind, and an
admin's own words are not a prayer time. A closure notice matters most when things are going
wrong.

### A bug this found in slice 9

Watching a broadcast take forty seconds to reach two phones exposed that **the jitter was
sequential**: `await sleep(random(20s))` inside a `for` loop over subscriptions. A tick cost
`subscribers × up to 20 s`. Fifty subscribers is seventeen minutes — far past the five-minute
grace window — so prayer reminders would have quietly stopped arriving for exactly the masjids
where they were working. It never showed up in testing because the tests inject a no-op sleep.

Fixed with `fanOut`: a fixed pool of ten workers pulling from a shared cursor (not batches — a
batch runs at the speed of its slowest member), and the per-send jitter cut to 800 ms and
applied per *subscription* rather than per notification, since the point is to decorrelate
phones from each other, not a phone from itself. Sixty phones now take ~3 s where they took
minutes, and there are wall-clock tests on both the tick and the broadcast so it cannot come
back quietly.

## Slice 11 — the day view, closer to the reference (0.1.0-dev.13)

A batch of wording and layout corrections from Hasan against the reference app's screenshots.

### The arc

Three things were wrong with it and each had a different cause:

- **It stopped short of the screen.** The path was inset 4 units at each end AND sat inside the
  page's 1.1rem of text padding. The path now runs 0…W and `.arc` is pulled back out through
  that padding with logical margins, so it is full-bleed and still full-bleed under RTL.
- **It sat too far below the countdown.** Not a margin — the `viewBox` was `0 -40 320 144`
  while the path only occupied y 31…96, so **71 units of the SVG were empty space above the
  peak**. The box is now the path's own bounds plus the "now" marker's radius.
- **The shape.** A quadratic's single control point gives a parabola. A cubic with controls at
  0.28W and 0.72W flattens the top and steepens the shoulders — the "arched in" look. Sampled
  against the reference: at a quarter of the width ours sits 0.284 of the way down from the
  peak where the reference sits 0.282.

The band is 0.275 of the width, taken from the reference, and the "TODAY" chip is pulled up to
float between the two descending limbs the way the reference composes it — verified at 320, 390,
430 and 480px that it never touches the line.

### Colouring a changed Iqamah

`changedOn()` returns the same set `changedPrayers()` renders as the month's tooltip sentences,
so the two screens cannot disagree. The number goes coral — the Hijri date's accent, measured at
5.4–9.4 : 1 across all six skies — with no badge, note or asterisk.

**On a Friday it can name a prayer with no row to colour.** Jumu'ah *replaces* Dhuhr in
`slotsFor`, so a changed Dhuhr jamā'ah appears in the month's tooltip and has nothing on the day
to attach to. That is the honest outcome: the Dhuhr jamā'ah is not being held that day, so
colouring the Jumu'ah time — a different number, set by a different decision — would be a lie.
Pinned by a test so nobody "fixes" it into one.

### The small ones

- `.time-row:last-child { border-block-end: 0 }` beat `.time-row--now` on specificity, so **Isha
  at Isha time lost the bottom of its outline**. Now `:last-child:not(.time-row--now)`.
- The Iqamah column is wider and the Adhan sits further left, because "10:15 PM" wrapped its
  "PM" and that pushed the row's baseline out of line with every other row. Both time cells are
  `nowrap` so it cannot come back at a larger text scale.
- The date never wraps: three round buttons and their gaps were eating 144px of a 355px row,
  which left "Wednesday, September 2" without room for its last word. Smaller buttons, tighter
  gaps, and a font that scales down rather than a line that breaks.
- Shurūq's time spans both time columns and centres, rather than sitting under one of two
  headings that do not apply to it.
- The month view swipes between months, and refuses at the ends of the fetched window rather
  than swiping into a month it has no times for.

### A note on the contrast harness

It sampled a few pixels **above** each element and called that the background. Once the date
stepper tightened up, "above the Hijri date" became the Gregorian date's own glyphs, and it
reported the Hijri line at 1.3 : 1 against its neighbour. It now hides the element's text, takes
the frame, and reads the pixel at the element's own centre — the colour the glyphs are actually
drawn onto. Every previous number in this file was measured the old way; the current worst
across the six skies is **5.45 : 1**.

### Four things the review caught that testing had not

A four-dimension adversarial review over this diff (completeness, correctness, CSS, a11y/RTL),
with every finding handed to a separate agent told to refute it. Ten survived. Four were real
defects rather than nits, and all four share a shape: **they were invisible in the exact test I
had run.**

1. **The changed-Iqamah coral never appeared on today.** `.time-row__iqamah--changed` is
   (0,1,0); `.time-row--past .time-row__iqamah` and `.time-row--now .time-row__iqamah` are both
   (0,2,0) *and* later in the file. So the mark worked on every day except the one anybody
   opens the app on. My own check had used a future day, where no row carries a state class.
   Fixed by moving the rule below the state rules and naming them explicitly — a tie on
   specificity is decided by source order, which is why the first attempt at the fix still lost.
2. **The "now" marker floated up to 8px off the end of the line it caps.** `pathLength="1"` +
   `stroke-dasharray` is measured by ARC LENGTH; the dots and the marker were placed at the
   BÉZIER PARAMETER. The two only coincide on a straight line, and the new cubic is further from
   uniform than the quadratic was. Everything is now placed through a sampled arc-length table,
   measured at 0.00 units of gap across the whole day.
3. **The outlined current row sat 2px inside every other row.** The 2px border eats the content
   box, so the current prayer's time did not line up with the column above and below it. Two
   pixels reads as bad kerning rather than a bug, which is exactly why it would never have been
   reported.
4. **Colour was the only signal, and coral sits within 1.08 : 1 of the muted ink in luminance.**
   As pure hue it is invisible to a red-green colour blind reader and to every screen reader.
   The ask was "no note anywhere", which is about what is *visible* — so the changed time holds
   its weight instead of receding with its row, and carries an `.sr-only` ", Iqamah changed".
   Nothing was added that a sighted reader can see.

The month view also had no `touch-action: pan-y`, the companion rule the day-view swipe depends
on, and the longest English date ("Wednesday, September 30") overflowed its box onto the arrows
at 320px — the narrowest phone still in use.

## Slice 12 — the arc is a trajectory, not an arch (0.1.0-dev.14)

Hasan described the reference curve in words rather than pointing at it, which turned out to be
the more useful thing: **flat along the horizon at the far left; a quick, steep climb through
the morning; flattening as it approaches the top; almost LEVEL across the middle rather than a
peak; a descent that is gentler and more stretched than the climb; and a sharper drop again into
the right edge.**

**One cubic cannot be that shape.** A single segment has one tangent at each end and no way to
be steeper on one side of its maximum than the other — every quadratic, and every cubic with
symmetric controls, is a hill with matching flanks. Two segments meeting at the summit have four
tangents to spend, which is exactly the number that description needs: horizontal at the far
left, horizontal arriving at the top, horizontal leaving it, and still descending at the right.

The numbers are a **least-squares fit** to ten points sampled off the reference screenshot, not
a guess — 1.8% RMS against a band of 1.0, worst point 3.8%. The summit sits at 0.436 of the
width, left of centre, which is what makes the descent the longer half. A sweep of the exit
steepness showed that forcing a visibly descending right edge costs 0.006 RMS, so the
description won over the marginally better fit.

Each clause is a test rather than a screenshot: the entry slope, the climb, the levelness of the
top, the mid-descent, the exit, and the asymmetry (at 0.2 either side of the summit the climb is
0.365 of the band down and the descent 0.120).

**The arc-length table now spans both segments.** With one curve, parameter and length merely
disagreed; with two they are not even continuous — the summit is halfway along by parameter but
not by distance, because the climb is shorter than the descent. Re-measured: the "now" marker
sits 0.00 units from the end of the line it caps, all day.

### The rest

The month grid slides on a month change, from whichever side it came from — the same motion as
the day's table for the same gesture, so the keyframes are now named `slideInFrom*` rather than
`dayInFrom*` and both views share them. The arrows route through the same `step()` as the swipe,
or the buttons would move the month with no motion while the swipe animated.

The column headings sat 6px under the Hijri date and a long way above the row they label, so
they read as part of the date block. Now 22px below the date and 20px above the first row —
they belong to what is under them.

## Slice 13 — one curve, and Jumuʿah reminders (0.1.0-dev.15)

### The plateau was a curvature discontinuity

Hasan: *"too much flattening near the apex. The top feels like a plateau instead of a continuous
curve."* Measuring the two-Bézier version explained both halves of that sentence:

| | crest radius | curvature variation across the crest | curvature step at the apex |
| --- | --- | --- | --- |
| two cubics | 96 | **4.59×** | **78%** |
| stretched half-ellipse (the "egg top" named as the ideal) | 291 | 1.06× | 0 |
| now: `H·sin^1.6((x/W)^0.835)` | 80 | **1.75×** | ~0 |

Two segments can be given matching **tangents** at the summit but not matching **curvature**, and
the 78% step is the "visible break". The 4.59× variation is the plateau proper: the curve went
slack either side of its own peak, ballooning from a radius of 96 to 268 within ±12% of the
width. A dome that stops doming reads as a table top however smooth its tangents are.

**An analytic curve cannot have that fault.** One C-infinity function over the whole span makes
"no visible break between ascent, peak and descent" true by construction rather than by tuning,
and leaves only two things to choose:

- **P = 1.6** sets how round the crest is. Higher sharpens it toward a point; lower rounds it
  but drags the flanks up steeper, and the gentle start is worth more.
- **K = 0.835** slides the summit to 0.436 of the width, which is what makes the descent the
  longer, gentler half — at 0.2W either side the climb has fallen 0.289 of the band, the descent
  0.250.

**What this gives up**, and it is worth naming: the previous pass had the right edge dropping
away more sharply, taken from the reference screenshot. A single smooth function cannot both
leave the horizon gently on the left and dive into it on the right. The seven properties in the
newer description won.

The path is now a **160-point polyline sampled from that function**, which is both what is
stroked and what everything is measured against — so the dots cannot drift from the line they
sit on. Verified against the function it comes from: worst deviation 0.038px on a 390px screen.

The old harness (`shots/s12.js`) encoded the reference SCREENSHOT — a levelled top and a steep
right edge — so it now fails by design. Its curve checks were retired to `s13b.js`, which tests
the seven properties instead. A test that pins a superseded spec is worse than no test.

### Jumuʿah reminders

Its own choice, not a rider on Dhuhr, because on a Friday it is not Dhuhr: a different time, the
prayer people plan their week around, and a masjid may hold two or three hours apart.

**Jumuʿah stands in for Dhuhr on the day it is held**, exactly as `slotsFor` does in the day
view. A Dhuhr reminder on a Friday would name a jamāʿah the masjid is not holding, at an hour
nobody is gathering.

Which one is stored **by position** (`jumuah: number[] | null`), not by the masjid's label: a
label is editable text — "1st Jumuʿah" can become "Early Jumuʿah" — and a stored preference that
silently stops matching is worse than one that is a little blunt. Position is also what somebody
means when they say "I go to the second one". `null` means all of them, which is the default and
what every subscription written before this field existed reads as.

The notification `tag` carries the label for Jumuʿah only. Without that, a masjid's two Jumuʿah
reminders would share a tag and the second would silently REPLACE the first on the lock screen —
they are different gatherings an hour apart.

The labels the sheet offers come from the next day in the window that has any, not from the day
on screen: on a Tuesday `day.jumuah` is empty, and the choice still has to be offerable.

### What the review caught in the Jumuʿah work

Three dimensions of adversarial review, every finding handed to a separate agent told to refute
it. Four survived that were real defects, and two of them **were pinned as correct behaviour by
the tests I had just written** — a test can entrench a bug as easily as it catches one.

1. **A Friday went silent for every existing subscriber.** Jumuʿah standing in for Dhuhr is
   right, but a stored row that asked for Dhuhr and knew nothing about Jumuʿah then matched
   neither — so somebody reminded every week would simply have stopped being, with nothing
   anywhere to say why. `PrefsSchema` now carries such a row forward: an ABSENT `jumuah` field
   is the signal (every version that knows about it sends it, as `null` or a list), and an old
   row that wanted Dhuhr wanted the midday jamāʿah. An explicit refusal is untouched.
2. **Two or three identical adhan notifications in the same second.** Display sends no
   per-Jumuʿah adhan — there is one that day and it is Dhuhr's — so one reminder per chosen
   jamāʿah meant the same event alerting N times, each claiming an adhan for a jamāʿah whose
   adhan field is null. One adhan now, named for the day rather than for any one gathering.
3. **A masjid dropping from two Jumuʿah to one silenced everyone who picked the second** —
   permanently, and unfixably: the picker only appears when there is more than one to pick
   between, so off-and-on-again re-posted the same dead list. Both halves fixed: the scheduler
   falls back to the jamāʿah actually being held, and re-ticking Jumuʿah clears the stale choice.
4. **The notification tag was keyed on the masjid's editable label**, which Display does not
   require to be distinct. Two Jumuʿah both named "Jumuʿah" would have collapsed into one on the
   lock screen. Keyed on position now.

Also: `MAX_JUMUAH` was 10 while the feed schema accepts 16, so a masjid's later jamāʿāt could
never be notified and a picker tap on one would have failed the whole save silently — there is
now a test that reads `timetable.ts` and fails if the two ever disagree. And a failed save no
longer leaves the sheet showing a choice the server never received.

The arc gained the tests it did not have (`web/src/arc.test.ts`): the summit left of centre,
monotone flanks, curvature that never goes slack across the crest and never steps at the apex,
a descent gentler than the climb, and the drawn polyline tracking the function to 0.077px. Three
claims in its comments were also wrong and are corrected — "each chord spans two units, far
below a pixel" (2 units is 2.4px; it is the DEPARTURE that is sub-pixel), "near-zero slope at
both horizons" (true only in the limit — by the first rendered pixels it is already 20°), and a
sentence that ran two different measurements together as if they were one.

## Slice 14 — the QR lands somewhere useful (0.1.0-dev.17)

Three things Hasan asked for on 2026-08-29: an onboarding page behind the QR code, a device and
browser breakdown for the admin, and a Settings screen holding a theme choice and the
notification switches.

### One user-agent table, and why there has to be exactly one

`web/src/platform.ts` is now the only place in the repository that reads a user agent, and
`pwa.ts` re-expresses its answers rather than sniffing again. Two tables that disagree is not a
tidiness problem: the onboarding page would tell somebody to press a button the install code has
already decided not to offer, and each would be right about a different set of browsers.

Sniffing at all is a last resort, used because there is nothing to feature-detect. **Every
browser on iOS is WebKit**, so Chrome, Firefox and the in-app browser that opens inside Instagram
are indistinguishable from Safari to any API a page can call — and only Safari's own Share sheet
installs a web app. The absence of `beforeinstallprompt` says nothing either: a Chromium browser
that will fire it in a second looks exactly like one that never will.

`installRoute` collapses all of it into the seven answers a screen can act on, and the ORDER of
its checks is the content:

- `standalone` first, before everything — already installed beats every other consideration.
- `secure` next: on the masjid's own wifi there is no install API at all, and a kiosk on the LAN
  is a legitimate way to open this app rather than a fault.
- **`inapp` before `prompt`**, which is the one that is not obvious. Some in-app webviews *do*
  fire `beforeinstallprompt`, and taking it adds a home-screen icon that opens back inside that
  app. That is worse than failing, because it looks like it worked.
- Then iOS (Safari → instructions, anything else → switch browser), then the prompt, then
  Android's menu, then desktop.

`menu` and `desktop` are new answers to cases that used to be silent. A Chromium browser that has
not offered a prompt still has "Install app" in its own menu, and saying so beats the nothing
this used to show. Neither is `ASKABLE` — the modal over the prayer times still only interrupts
for the three cases it always did, because `menu` cannot be told apart from "already installed,
opened in a tab" and nobody adds a masjid timetable to a laptop.

### The onboarding page

`/onboarding`, and the QR code and poster now point at it (`onboardingUrl` in `base.ts`, so the
admin chunk gets the string without importing a musalli-facing component).

The argument for it in one line: **a printed poster has to give instructions that suit every
phone that will ever scan it, and a web page does not.** It knows which phone and which browser
is reading it, so it can say the one true sentence — including the one no poster could ever
print, which is *"this browser can't; open it in Safari."*

- The in-app-browser screen is the one that saves the most people, and it **names the app**
  ("inside Instagram") rather than saying "in-app browser", which is a phrase somebody would have
  to be told the meaning of first. It cannot open the other browser for us — no web page can hand
  itself to another app on either platform, and a `googlechrome://` link would fail silently on
  the phones that matter — so it offers the address, on the clipboard, and prints it in full
  underneath because a clipboard is refused more often inside a webview than anywhere else.
- Notifications are a second step, offered after the install and **never on load**. A page that
  asks on arrival is how a browser learns to block a site permanently, and it would burn the one
  chance the masjid gets.
- The Share-sheet hint is **our own drawing**, not a screenshot: every real screenshot of an iOS
  Share sheet is Apple's, and this repository can only ship assets it can license under AGPL-3.0.
  It has no letters in it either, so it mirrors under RTL with one CSS rule and needs no
  translating — the caption below already says what it is.
- Launched standalone it redirects into the app with `replace`, not `push`: somebody who has
  already done the thing must never be shown the instructions for doing it, and a pushed entry
  would make the back gesture bounce off the instructions and forward again.

An earlier draft greyed the notification step out until the app was installed. That rule is only
TRUE on iOS — and on iOS the step already says so in its own words, because the platform rule is
what produces that text. On Android, notifications work in a browser tab, so dimming the step
refused something real to make a funnel look tidy. Dropped, along with the `later` state.

### Settings, and what a pinned theme actually means

`/settings`, and the tab bar is now unconditional as a result. The rule in `Tabs.tsx` — draw
nothing below two — is unchanged and simply no longer fires, and `landing.test.ts` says so, so
the guard comes back if Settings ever goes.

The reminders moved out of the sheet that opened over the prayer times. They are SETTINGS — six
switches somebody sets once and revisits twice a year — and a modal is a shape for a question.
The bell in the header stays as a shortcut *to* them, because notifications are the one feature a
musalli has to find on purpose; it is hidden on the Settings tab, where it would point at the
screen already open. `reminders.ts` holds the state and the subscribe flow, because the
onboarding page can turn them on too and two copies of that flow is two chances to get the order
wrong (tell the server to forget the row BEFORE unsubscribing at the browser, or a failure leaves
a row nothing can reach again).

**"Always dark" does not mean one night sky.** The obvious implementation pins a single period
and throws away what this page is: the sun crosses it. So each mode keeps moving through the day
inside the polarity it was given — always-dark runs Fajr → Maghrib → Isha, always-light runs
Duha → Dhuhr → Asr. `periodTheme.test.ts` asserts the property rather than the table: every
period in every mode lands on a sky of the right polarity, and neither mode may collapse to one.

The appearance options are **real radios inside a fieldset**, not chips and not buttons carrying
`role="radio"`. Chips would be wrong twice over — three answers to one question where only one
can be true, in the shape this app uses for "pick as many as you like". And a `<button
role="radio">` looks right to a screen reader while behaving wrongly for a keyboard: the group
should be one tab stop that the arrows move within, which is a dozen lines to implement badly and
free from a real `<input>`. Verified: one tab stop, arrows move the selection, the theme changes
live.

### A shipped contrast bug, found by looking at a light-mode screenshot

`surfaceFor` exists because of it. When the period is unknown — a fresh install with no timetable
chosen, Display not granted, or simply any page opened before the day view has mounted — the app
removed `data-period` and set no theme override, so `data-theme` fell back to the reader's own
light/dark preference. But the fallback sky in `app.css` is the NIGHT gradient ("dark is the safe
unknown", as the stylesheet puts it). On a phone set to light mode that is near-black ink on a
midnight background: **on the fresh-install screen an admin sees first, and on every deep link
into the app.**

The fix is that the sky and the ink are now decided together, by one pure function, with a test
asserting they can never disagree for any (period, mode) pair including the unknown one. The bug
was reachable before this slice; the onboarding page only made it easy to photograph.

### Analytics, built as a schema rather than a promise

CLAUDE.md §4 had "analytics beyond a plain count of push subscriptions" out of scope. The reason
was to stop this app growing a visitor log, and that reason has not gone away — so what was built
is the shape that answers a masjid's question without one ever existing.

**The entire schema is a counter.** One row per (day, device, browser, mode), holding a number.
No row per visit, no session, no id, no IP, no user agent, no path, no timestamp finer than the
date. "How many iPhones opened this in September" is answerable; "did Yusuf open it" is not, and
cannot be made to be without adding a column — which is a thing a reviewer can see, so
`analytics.test.ts` asserts the column list **exhaustively**, as an allowlist rather than a
denylist. Retention is 90 days and pruning happens on every write, so it is a property of writing
rather than of remembering to.

The three fields are closed enums, duplicated in `web/src/platform.ts` and asserted equal by a
test that parses that file. Two lists in two languages that must agree: one decides what is sent
and the other what is accepted, and a value only one of them knows is silently dropped at the 400
— a whole category of phone missing from the figures with nothing anywhere saying so.

Counting is **once a day per browser**, not once per page load; the signature includes the mode,
so installing the app shows up in both columns on the same day, which is the transition that
answers "did the poster work?". The signature lives in that browser's own localStorage and never
leaves it. It is written only on a successful report, so a phone that was offline is counted
tomorrow rather than never.

Two things the panel says out loud rather than leaving to be discovered: it counts **phones,
roughly**, never people (a cleared cache counts twice, a shared phone counts once); and the
endpoint is public, like every page a musalli opens, so the counts are **inflatable by anyone
holding the link**. That is inherent to counting a public page. The visit limiter is 600/min
rather than sharing the push budget of 30, because behind the tunnel every request arrives from
cloudflared's address — a per-peer limit is really a per-masjid limit, and 429ing a busy Jumuʿah
would drop counts on precisely the day worth counting.

## Slice 15 — Qibla, and notices that send themselves (0.1.0-dev.18)

Three things, and two bugs of the same shape found by opening the pages rather than by reading
them.

### Real screenshots, and what had to happen to them

Hasan supplied four phone captures on 2026-08-30, which replaced the drawing of a browser
toolbar the onboarding page carried. The drawing was defensible when there was nothing to
license — every screenshot of an iOS Share sheet on the internet is Apple's — and it was simply
worse: somebody hunting for a row in a long grey list matches a photograph of that list
instantly and an abstraction of it not at all.

They needed three things doing to them, none cosmetic. **Cropped**, because a full-height Share
sheet is mostly rows nobody is being asked to tap and the one that matters ends up eight pixels
tall. **Downscaled** — 553 KB of PNG for one instruction on a page opened on mobile data is a
reason to close the tab; the four are 9–25 KB now. And **the other masjid's name and address
blurred out**, which is not about branding: somebody installing "Masjid An-Noor" who reads
`app.rifusa.org` in the instructions reasonably concludes they are installing the wrong thing.
There was no image library on the machine, so the processing ran through Chromium's canvas — the
outputs are committed, not built.

The third and fourth carry the case that ends the most installs: **Add to Home Screen can be
missing from the Share sheet entirely.** It lives in the sheet's editable actions list, and on a
phone where somebody once tidied it, the row our instructions name is genuinely absent. It is
behind a `<details>` rather than in the step — wrong for most people, and a step with two
branches in it is a step nobody reads — and native rather than a toggle of ours, so the
browser's own in-page search can find it, which is exactly how somebody looks for this.

### Standing announcements

Every guard in `schedules.ts` is load-bearing rather than defensive, because a scheduled notice
reaches a congregation again next week without anybody deciding to.

- **The masjid's clock, never the container's.** "Every Friday at 11:00" is a wall-clock time in
  the masjid's own zone; the container runs in UTC. There is deliberately **no fallback**: with
  no timetable there is no IANA zone, so nothing is scheduled and the panel says why. A masjid in
  New York whose notice went out at 6am would not report it as a bug — they would turn
  notifications off.
- **Never a backlog.** A box off from Thursday to Sunday must not deliver three days of "reminder:
  halaqa tonight" when it comes back. A missed occurrence is marked as dealt with *without*
  sending. The grace window is 20 minutes rather than the prayer scheduler's five, and that
  difference is the point: a prayer reminder is about a moment that has passed, so five minutes
  late makes it wrong; an announcement is about a fact, which is as true twenty minutes later.
- **`firedThrough` holds the OCCURRENCE, not the time we noticed.** Storing "now" would drift the
  window forward on every tick.
- **Marked before the send, not after.** A crash part-way through a broadcast must not leave the
  occurrence looking undelivered: re-running it would send the same notice to everyone who
  already had it, and that is the half that cannot be taken back. Under-delivering to some phones
  is recoverable; double-sending is not.
- **A new or resumed schedule starts with `firedThrough = now`**, so setting "every day at 08:00"
  at nine in the morning does not fire immediately, and coming back from a pause does not deliver
  what the pause skipped.

Two decisions about where it sits in the tick:

**Standing announcements run BEFORE the staleness gate.** Rule 1 exists because a prayer reminder
computed from two-day-old times may be wrong by minutes and somebody acts on it. An announcement
is not computed from the times at all — "the masjid is closed on Saturday" is exactly as true
when Display has been unreachable since Thursday — so applying that rule to both would silence
the masjid's own voice at the moment it has lost its other one. The feed is still *required*,
for its `timezone` and nothing else.

**A schedule is not blocked by the manual cooldown.** `announce()` was split, with `broadcast()`
underneath it: the cooldown is about a human pressing Send twice in a second, and a schedule
firing forty seconds after somebody pressed Send is two intentions. Swallowing the second would
be a notice that silently never went out, which is the failure scheduling exists to prevent.

The admin's confirm step names the **repetition**, not just the audience — "send this to 40
phones" is the wrong question for something that will do it again every Friday. The sentence it
reads back ("Every Friday at 11:00") is the only chance anybody has to notice they meant
Thursday, which is why `scheduleText.ts` is a module with tests rather than JSX. Days are sorted
into week order before being named, because the picker appends in tap order. The hour's padding
follows the locale's own clock: a 12-hour locale wants "8:00 PM", a 24-hour one wants "00:05",
and neither answer is right for both, so `hour12` is asked rather than assumed.

`Intl.ListFormat` brought `ES2021.Intl` into the web tsconfig's `lib`. Declared rather than cast
around, for one API, so "Friday and Sunday" is joined in the reader's own language instead of
with a comma this app would then have to translate.

### Qibla

`docs/DESIGN_LANGUAGE.md` set the ordering on 2026-08-24 and the ordering is the whole screen:
**the bearing and a north-up dial first, the compass offered as a button afterwards.** Not a
fallback arrangement — a compass needs a magnetometer, a permission on iOS, a user gesture and
somewhere that is not next to a steel door frame, where "119°, east-southeast, 4,794 km" needs
only a position and can be checked against a room somebody already knows.

The bearing is the initial **great-circle** heading, and `bearing.test.ts` pins ten cities against
their published Qibla directions to a tenth of a degree — because this is the one part that
cannot be checked by holding the phone up. A flat-map bearing from New York is 96°; the great
circle is 58.5°, and the wrong one looks perfectly reasonable while being wrong for every masjid
in North America. There is a test asserting the two must *disagree*, so the intuitive version
cannot quietly replace this one.

Details that are decisions:

- **`enableHighAccuracy: false`**, and the cheap option is the better one: GPS is slower, flatter
  on the battery, and fails indoors, which is where a prayer hall is. A few hundred metres of
  error moves this bearing by about a thousandth of a degree.
- **The BEARING is remembered, never the position.** One number, on the reader's own phone, kept
  for a month so a congregation is not asked for their location every Friday. Refusing to write
  the coordinates down is cheaper than protecting them.
- **`absolute` is checked on the orientation event**, and that check is the difference between a
  compass and a decoration: a non-absolute reading is relative to wherever the phone was pointing
  when the page loaded, so an arrow built on it turns correctly and points at nothing. The worst
  possible failure here, because it looks like it is working.
- **The heading is smoothed through `angleDelta`.** Averaging raw numbers would swing the dial
  the long way round every time the reading crossed north — 359° and 1° are two degrees apart and
  their mean is not 180.
- Apple's `webkitCompassAccuracy` of −1 means "needs calibrating" and is treated as **no reading**
  rather than as a number, so the screen can ask for the figure-of-eight instead of pointing due
  north and meaning nothing.
- `qiblaBearing` returns **null at the Kaaba and at its antipode** rather than the 0 that
  `atan2(0, 0)` gives, which would confidently claim "due north".

Two things went wrong in the drawing and both were only visible on a real page:

The cardinal letters were placed with a rotation nested inside another rotation, which puts the
pivot somewhere neither of them meant — E and W came out on their sides. They are positioned by
trig now. And the rose was rotated with a **CSS** transform, whose `transform-origin` for an SVG
group depends on a `transform-box` default that is not agreed between engines: the pivot landed
on the viewport's corner and swung the whole dial off the bottom of the card *only once a heading
arrived*, which is why every still screenshot looked perfect. Spelling out `transform-box:
view-box` moved it somewhere else again. It rotates by the SVG **attribute** now, which has had
exactly one meaning since SVG 1.1 — about user-space (0, 0), which this viewBox is centred on by
construction. The CSS transition went with it: the low-pass filter already runs at the
magnetometer's rate, and a transition on top would be a second smoothing fighting the first.

### The bug that appeared twice

`secure` comes from `/api/app`, so on the first render it is false for **everybody**. Two pieces
of Qibla state were decided at that moment and never revisited:

1. The phase, set to `unsupported` in a mount effect, so the tab opened onto "this browser can't
   work out where you are" on a perfectly capable phone.
2. `blocked`, seeded in a `useState` initialiser — and initialisers run exactly once — so the
   **"Use my compass" button would never have appeared on any device at all.**

Neither is visible to a typechecker, and neither would have been caught by a unit test of the
functions involved, which are all correct. Both were found by loading the page. The first is
fixed with a functional update that leaves any state the reader reached by acting (a refusal must
not be quietly reset into a fresh prompt); the second by deriving the value at render time
instead of seeding it.

### Test count

Server 335 → 363: 19 for the schedule arithmetic in its own file, 9 more driving them through a
real tick. Web 128 → 155: 14 for the bearing, 11 for the wording a schedule is confirmed by, and
the tab-bar rules.

## Slice 16 — contact details, haptics, and the Qibla's second pass (0.1.0-dev.19)

A list of small things from Hasan on 2026-08-30, two of which turned out to have real bugs
underneath them.

### One word for one time

The lock screen said "Jamāʿah in 15 minutes"; the app's own timetable has always headed that
column "Iqamah". They are not the same word — the iqamah is the call, the jamāʿah is the
gathering it calls to — but a notification that names a time differently from the screen it came
from is a second name for one thing, and the reader has to work out that it is not a third
prayer. It is "Iqamah" everywhere a reader sees it now.

### The header bell

Removed. It was a shortcut to the reminder switches from before Settings existed as a tab; with a
permanent Settings tab at the bottom of every screen it was a second door to the same room, and
the top-right of a prayer-times page is the most valuable corner it has.

### Contact details

The smallest feature here and the one with the clearest reason to exist: somebody who has just
installed a masjid's prayer times is exactly the person who will later need its phone number.

The shape of it is "nothing is invented". Every field is optional, an empty one draws nothing,
and a masjid that filled none of them in gets no card — `hasContact` is checked against what
SURVIVES sanitising rather than against what is stored, so a masjid whose only entry is a link
this app will not render gets no card either, instead of an empty one headed with their name
that looks like something failed to load.

**Validated on the way in and again on the way out**, in two languages, and both files say why:
the data volume outlives any one build, so a value a looser version once accepted has to be
refused again when it is read, and the page must never be the first thing to notice a
`javascript:` URL. `web/src/contactLinks.ts` is named that way rather than `contact.ts` for the
case-collision reason `bearing.ts` already exists for.

Two bugs the tests found, both of which had passed a reading of the code:

1. **`+44 (0)20 7946 0000` dialled `+4402079460000`, which reaches nobody.** The bracketed zero
   is the trunk prefix — you dial it *instead of* the country code, never as well as it — and
   stripping punctuation while keeping digits produces a number that cannot connect. It is also
   how a very large number of British masjids write their number down, so this is not an edge
   case. Removed only when the number is in international form: without a `+`, a leading zero is
   the thing that makes it dialable.
2. **One unreadable field emptied the whole record on read.** `getContact` parsed the row as a
   unit, so a value of the wrong type — from a future build, or a corrupted row — cost the masjid
   the phone number they had typed correctly. It parses field by field now. The WRITE path
   deliberately keeps the whole-object schema: there, a bad email is something to tell the admin
   about while they are looking at the form, not something to drop quietly.

It rides on `/api/app` rather than a route of its own, and the existing bootstrap allowlist test
did exactly what it was built to do — failed, and made the new key be argued for. The contact
object's own field list is now pinned there too, since it is the one part of the bootstrap an
admin types freely into.

### Haptics

One delegated `pointerdown` listener on the document rather than a call at forty sites. "Haptics
on buttons, throughout" is a property of the app rather than of any one component, and threading
it through every `onClick` guarantees the forty-first is missed — it is also how the platforms
themselves do it, with the OS deciding what a press feels like rather than each button.
`pointerdown` and not `click`, because feedback on release, after the screen has already changed,
feels like a fault rather than a confirmation.

**It does nothing on an iPhone.** Safari has never shipped the Vibration API, on any Apple
platform, and there is no permission to ask for and no polyfill. So every haptic in this app is a
confirmation of something already visible — the Qibla says "Facing the Qibla" on screen *and*
buzzes, and the buzz is the half that is allowed to be missing. The switch in Settings only
appears where there is a vibrator to switch off, because a control for nothing is worse than a
missing one: somebody will use it and conclude the app ignores them.

The swipes buzz only when they *move*. A swipe into the end of the timetable window, or into a
month with no data, is a gesture that was understood and refused, and a buzz there would confirm
nothing. Both `step` functions now return whether anything happened, which is a better shape
regardless.

### The Qibla, second pass

- **The Kaaba sat at an angle.** It was counter-rotated against the pointer's own `bearing` but
  not against the rose's rotation, so it stayed upright relative to a card that was itself
  tilted. Cancelling the whole screen rotation fixes it; a cube that is not sitting flat does not
  read as a building. Asserted now by reading the element's real screen matrix rather than by
  looking at it.
- **The opening screen is one button.** The paragraph explaining that the location never leaves
  the phone was true, is still true, and was not being read by anybody standing in a prayer hall
  — the browser's own prompt asks the same question a second later, in words the reader already
  trusts.
- **It asks again every visit.** The bearing was in localStorage for a month, on the reasoning
  that a congregation should not be re-prompted every Friday. Hasan overruled it, and he is right
  for a reason that is not about accuracy: a stored bearing is a fact about where somebody was,
  sitting in a browser store for whoever next picks up the phone, and this app has spent a lot of
  effort not writing that down anywhere else. It is a module-level variable now — so moving
  between tabs does not re-ask within one visit, and the page dying takes it with it, which is
  what "leaving the app" means for an installed PWA.

### Test count

Server 373, web 163.

## Slice 17 — the compass face, after the reference (0.1.0-dev.20)

A second pass over yesterday's work, from a reference image and a list of small corrections.

### The Kaaba faces the Qibla

Three versions of one line, and the two wrong ones are worth keeping because they were each a
reasonable-looking answer to a differently-framed question.

The tile sits inside two rotations: the pointer's own `bearing`, and the rose's `rose`. The first
version cancelled the inner one, so it stayed square to a card that was itself turning and leaned
by however far the reader had turned — that read as a mistake, and it was. The second cancelled
both, standing it up on screen — which was what "it's not straight up" asked for, and which made
it a picture of a box rather than of a building somebody is facing. The third cancels neither:
the Kaaba turns with the bearing, so its face is towards the Qibla. That is what the reference
does, and it is also the more truthful drawing.

Asserted by reading the element's real `getScreenCTM()` rather than by looking at a screenshot —
59° of tile rotation at 59° of bearing offset, which is a claim a picture cannot make.

### The needle

The thin ray from the centre to the Kaaba said "the Kaaba is over there", which was already said
by the Kaaba being over there. What the screen was missing is the other half: **where the reader
is pointing.** So it is one leaf-shaped needle, fixed to the screen outside the rotating group,
and lining the two up is the whole gesture. It is drawn only with a live compass — with no
heading there is no "you" to mark, and a needle would be claiming a direction the phone does not
know.

The face itself is now an object: a pale bezel and a near-white card, with the colours hardcoded
in app.css. That is a deliberate exception to §12's "never hardcode a colour", and the reason is
that a compass whose card inverted between Fajr and Duha would stop reading as a compass at all —
you would not know whether you were looking at an object or at a hole in the screen. Checked on
both skies.

### The gap nobody put there

The Directions button sat 30px under the address when the CSS asked for 14. Neither
`.contact__maps` nor `.set-card .btn` was wrong: a `<ul>` carries a 1em bottom margin by default
and this app's reset only zeroes the body's. It is the kind of gap you tune the wrong rule to fix
twice before measuring the pieces, so the pieces were measured.

### Two maps, because an iPhone has two

Sending an iPhone straight to Google Maps is a guess about somebody else's phone: a large share of
them do not have it installed and land on a web page asking them to, having pressed a button that
promised directions. Which to open is a question only the reader can answer, so on iOS it is
asked — expanding in place rather than opening a dialog, because two links are not worth stopping
the page for and the reader has already said what they want by pressing. Everywhere else there is
one answer and it is not worth asking.

Both links are built from one `mapQuery`, so the choice can never become a trap where the two
apps search for different things — which is the one way an offered choice is worse than no
choice. Asserted, including that an `&` in an address cannot start a second URL parameter.

### The phone field

`type`, `inputMode` and `autoComplete` are three different things doing three different jobs, and
only the first was set. The type is what the browser validates and what a keyboard reads, the
input mode is which keyboard actually appears — a keypad, not a QWERTY somebody has to switch out
of — and the autocomplete token is what lets a volunteer fill their own masjid's details with one
tap instead of typing a postcode from memory.

## Slice 17a — what the review caught (0.1.0-dev.21)

An adversarial pass over slice 17's diff: four dimensions, every finding handed to a separate
agent told to refute it. Seven claims, two survived, and both were real. Both were also verified
here by measurement before being acted on — an agent's confidence is not evidence.

### The Kaaba was painting over a cardinal letter

Three numbers moved together in slice 17 and collided. The letters went from r=68 to r=62 and
from 13px to 15px; the Kaaba went from r=78 to r=72 and from 22 units square to 26. Their radial
spans became 55–69 and 59–85 — overlapping — and because the Kaaba group is the last child of the
rose it paints last, opaque, over the letter.

It is invisible for most masjids and total for some, because **which** masjid gets it is decided
by the qibla bearing: anything within about ±17° of a cardinal. Measured live, Karachi (267.7°,
two degrees off due west) lost **70% of its W**. Sydney, Auckland, Nairobi, Mombasa and Dar es
Salaam are all inside the same window. On screen it reads as a rendering fault rather than as a
marker sitting on a card.

The letters are at r=52 now and the Kaaba at r=76, 22 units square — the two rings are separated
by 7 units at the closest point, and the tile's corners reach 91.6 against a face of 92. Asserted
by measuring the rendered boxes at eight real cities, four of them chosen because their bearings
sit on a cardinal: worst overlap anywhere, 0%.

Worth noting: **the reference image has the letters and the Kaaba at the same radius** (0.79 and
0.75 of the face) and would do this too. It happens to be drawn at a bearing where nothing
collides. Matching a reference exactly is not the same as matching it correctly.

### The list padding — the half of a fix that was missed

Slice 17 found a 16px gap under the address, traced it to the user agent's `<ul>` bottom margin,
and set `margin-block: 0.8rem 0`. The user agent also puts **`padding-inline-start: 40px`** on a
`ul`, and that survived: every contact row was indented 32px past the card's own title.

Preflight is off (`corePlugins: { preflight: false }`, and `@tailwind base` is never imported at
all), so the only base rules in this app are the body's margin and the headings'. `.picker` in
the same stylesheet already spells out `padding: 0` for exactly this reason — the precedent was
in the file. It is `margin: 0.8rem 0 0; padding: 0` now.

The lesson is the one about the first fix: the gap was found by measuring a vertical distance, so
the vertical half got fixed, and the horizontal half was in the same screenshot the whole time.

## Slice 18 — the dark afternoon, and an arrow that points (0.1.0-dev.22)

### The sky only knew what time it was on one screen

Reload while looking at Settings, Qibla or the appeals and the app came up in its night colours
at two in the afternoon, with "Follow the day" selected. It was not the theme code: `surfaceFor`
was doing exactly what it was written to do, which is fall back to dark when the period is
unknown.

The period was unknown because **`Today` was the only thing that computed it.** It reported
upward through an `onPeriod` prop on mount, so the answer existed only on the one screen that
mounted it, and every other route got the "we do not know what time it is at this masjid"
fallback — correct in a fresh install, and wrong on every reload of three of the five tabs.

`App` fetches the timetable anyway and the masjid's IANA zone arrives with it, so there was never
a reason for the answer to live further down. It is `periodOf(positionAt(...))` in `App` now, on
a minute tick so a page left open through Maghrib goes dark on its own, and `Today` no longer has
the prop. Verified by reloading each of the four musalli routes at 13:00 New York and asserting
`data-theme="light"`, and again at 02:00 asserting it is still dark.

The general shape is worth naming: **a value that themes the whole document should not be
produced by one of the documents' children.** The bug was invisible for as long as the only route
anybody reloaded on was the one that happened to own it.

### An arrow instead of a leaf

A leaf points less than an arrow does — the eye reads a taper as a shape and a straight edge
running to a point as a direction. It is two triangles now, split down the centre line with one
face lighter than the other, which is the whole of the "3D": a folded blade catching light from
one side, the way a real compass needle is made. Two flat fills rather than a gradient or an SVG
filter, because both of those cost a low-end phone something to say the same thing. The notched
base is what makes it a dart rather than a triangle sitting on the dial, and it gives the fold
somewhere to end.

### A masjid, not a second map pin

lucide has `Church`, `Landmark` and `Castle` and no masjid, and heading a masjid's own details
with a church is worse than heading them with nothing — so `Masjid.tsx` is our own line drawing
of a generic building form (dome, crescent, two minarets), which is nobody's mark and is
therefore an asset this repository can license like the rest of it.

It is deliberately simpler than the reference: at the 16–17px this is actually used at, the
windows and the doorway's inner arch resolve to two grey pixels, and detail that becomes noise
makes an icon read worse rather than better.

### The footer

The AGPL §13 source offer is on the Settings screen only now. The requirement is that the offer
REACHES a network user, not that it is on every screen, and Settings is one tap away from all of
them on a tab bar that is always drawn. It was under the prayer times, which is the one screen
somebody opens to read a single number.

## The 0.1.0 release — and what a FIRST release needs that later ones do not

Hasan said the words on 2026-08-31. The chain in CLAUDE.md §17 was followed exactly —
**publish → pin → tag** — and two things came up that only ever come up once.

**The `channel` job cannot be green on a first release's merge commit.** It requires every image
on `main` to be `@sha256`-pinned, and the digest does not exist until `main` has published. Every
later release resolves compose to the *previous* release's pin and stays green throughout; the
first has nothing to resolve to. So `main` carried `:0.1.0` unpinned for exactly one commit —
`Checks` red on `channel` only, `server` and `web` both green — and went green again on the
digest-pin commit that followed.

The alternative was writing a digest that had not been read out of the registry for this version,
which is the mistake §0 tells three war stories about. A red job for one commit is the cheaper
error.

**The changelog test could only ever pass on `dev`.** It asserted `releases[0].version ===
'Unreleased'`, so the release chain — which turns `## Unreleased` into `## X.Y.Z` — would have
failed it on `main`, in the middle of a release, for a reason with nothing to do with the
release. It now asserts the thing that actually matters, and there are three legitimate states:

- a **stable** build must ship its own notes (asserted hard: `top === package.json version`, or
  the panel's "What's new" describes a different build to somebody deciding whether to update);
- on dev with work in progress the top is `Unreleased`;
- on dev *immediately after* a release the re-opened `## Unreleased` is empty, the parser drops
  it by design, and the top is the release just cut — one version behind the prerelease the build
  now calls itself. Correct, and it must not fail.

### What was verified rather than assumed

- The digest was read from GHCR, not from the build log, and confirmed to be an **OCI image
  index** carrying `linux/amd64` and `linux/arm64`. A per-architecture digest pins amd64 and
  breaks every Raspberry Pi in the catalog.
- `git rev-list -n1 v0.1.0` prints the digest-pin commit, not its parent. That is the off-by-one
  Display has shipped three times, and the check is not "did I tag after publishing".
- The tagged tree's digest was compared against what GHCR serves, locally, **before** the tag was
  pushed — after the push, a red CI run is all that is left to tell you.
- No `Build image` run exists for the digest-pin commit, so the pin cannot have been invalidated
  by the commit that created it.
- `verify-release-tag.yml` then asserted the same thing independently on the pushed tag.


## The 0.2.0 cleanup — an audit, and the failure with no screen behind it

A sweep across documentation, security, dead code and bugs, asked for after 0.1.0 shipped.
Most of it found nothing, which is worth recording as plainly as what it did find.

### The error boundary, and why its absence was the real finding

This app has a designed answer for every upstream failure it can name: Display unreachable, an
appeal that 404s, remote access off, a timetable too stale to notify from. It had none for the
failure it cannot name — a component that throws while rendering. React answers that by
unmounting the whole tree, so the reader gets a white page: no times, no explanation, and on an
installed PWA no address bar to reload from.

That is the second-worst thing this app can do to somebody, after showing a wrong prayer time,
and it was the only failure mode in the app with no screen behind it. `Boundary.tsx` is that
screen. It is deliberately not styled as an error, for the same reason `Note` is not: a red
panel on a prayer-times page tells a reader the masjid is broken, when what is true is only
that this app could not draw a page.

It reports nowhere. There is no error-reporting endpoint here and adding one would quietly turn
a page with no visitor log into a page with one (§4). The details go to the browser console and
to a collapsed expander, for whoever is being asked "what does it say?" over the phone.

What is tested is `crashDetail`: JavaScript lets any value be thrown, including a string, a
symbol, a bigint or an object with a cyclic reference, and a crash handler that assumes it was
handed an `Error` turns one broken page into an unrecoverable one. The boundary itself needs a
DOM the web suite does not have; the part that can be got wrong without a browser is pinned.

### `motion` was a dependency of the documentation, not of the app

CLAUDE.md §12 promised "Motion (the library) for gentle entrances and the countdown tick" and
§14 listed it among the web dependencies. Nothing imported it — the only occurrence of the word
in `web/src` was the English word in a comment. It was declared, installed, locked, and
tree-shaken straight back out of every build.

Alongside it, `prefs.ts` exported a `useReducedMotion` hook that nothing called, duplicating
in JavaScript what the stylesheet already does in eleven `@media (prefers-reduced-motion: reduce)`
blocks. Both are gone and §12 now describes the mechanism that actually runs. The bundle came
out byte-identical, which is the proof the dependency was never in it.

### What the audit did not find, recorded so it is not re-run from scratch

- **No vulnerabilities**, either half, at `--audit-level=high`.
- **No missing authorisation.** Every `/api/admin/*` route carries `requireAdmin`; verified again
  against a running container, where `/api/admin/status` answers 401 unauthenticated.
- **No injection.** The one interpolated SQL identifier (`analytics.tally`) is a private method
  taking a three-literal union, with a runtime allow-list behind the type. No `innerHTML`, no
  `eval`, nowhere.
- **No secret in a log.** The VAPID public key is truncated, push endpoints go through
  `safeEndpoint` (host + an 8-character hash), and the private key is never touched.
- **The missing CSP and `X-Frame-Options` are deliberate**, not an oversight. OpenMasjidOS embeds
  its apps in a frame — Donations documents the same absence for the same reason — and the
  session cookie is `SameSite=Lax`, which is what actually closes the clickjacking route.
- **The container is hardened as §13 asks and Donations is not**: `user: "1000:1000"`,
  `read_only: true`, `cap_drop: ALL`, `no-new-privileges`, `tmpfs: /tmp`. Confirmed at runtime:
  `docker exec … id` reports uid 1000.

### A documentation bug that mattered more than it looked

CONTRIBUTING said "everything below is what CI runs, so running it first saves a round trip",
and then listed a web block with no `npm test` in it. CI has run `web`'s 165 tests all along.
Anyone following the file exactly would have pushed without running them and discovered the
failure from a red run — which is precisely the round trip the sentence promised to save. The
same omission was in README and CLAUDE.md §16. All three now match `checks.yml`.

### The dependency that is not ours to fix

`display/timetable` — the capability this app's entire purpose rests on — ships in **Display
v0.70.0**, which is not released. Stable Display is v0.69.0, and the capability is on Display's
dev branch. Companion on an all-stable box installs, opens, and honestly reports it has no
timetable, which is the designed degraded state working exactly as intended and not a bug.

It does mean the two stable releases want ordering, and the order is Display first. That is a
cross-repo fact, so it is written down here and in the README and flagged to Hasan, and it is
not fixed from this repo (§2).
