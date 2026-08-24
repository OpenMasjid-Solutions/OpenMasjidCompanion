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
