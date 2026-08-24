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
