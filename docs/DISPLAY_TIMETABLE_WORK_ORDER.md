<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Work order — OpenMasjidDisplay: provide `timetable` over the Fabric app-to-app broker

> **Audience:** the maintainers/agent of the **OpenMasjidDisplay** repo. This is **not** a change
> the Companion app made to Display — it is a request, in the same spirit as
> `docs/PLATFORM_WIDGET_PATH_INGRESS.md` was a request to the platform. A copy lives in the
> OpenMasjidCompanion repo at `docs/DISPLAY_TIMETABLE_WORK_ORDER.md`; if the contract changes on
> either side, both copies change together.

## Why

**OpenMasjidCompanion** (app id `companion`, new catalog app) is an installable PWA musallis add
to their phones from a QR code. Its home screen is the masjid's prayer timetable, and its push
notifications fire from those times. **Display owns prayer-time correctness** — Companion is
forbidden by its own CLAUDE.md from calculating times or Hijri dates itself — so it needs to
*read* a timetable from Display, server-to-server, through the platform's sanctioned channel:
the **Fabric app-to-app broker** (`OpenMasjidOS/docs/APP_MANIFEST_SPEC.md`, "Fabric app-to-app
broker"; Donations ↔ Students `billing` is the shipped precedent).

Today Display declares **no** `fabric.provides`. Its only public data surface is the per-
timetable embed widget (`/w/<id>` + `/w/<id>.json`), which is (correctly) gated on
`widget.enabled` per timetable and shaped for an iframe, not for a consuming app. This work
order adds a first-class provider capability instead.

## The ask

1. **Manifest** — add to `manifest.yaml`:

   ```yaml
   fabric:
     provides:
       - capability: timetable
   ```

   (Everything else already declared stays as is. `commands` remains outside `fabric.provides`
   — reserved, as today.)

2. **Serve two methods** on the app's **first published port** (the control-panel port — the
   same one `POST /fabric/commands/run` lives on), mounted at the **exact, unprefixed** paths:

   ```
   POST /fabric/timetable/list
   POST /fabric/timetable/get
   ```

   The platform proxies `POST ${OPENMASJID_BASE_URL}/api/fabric/app/display/timetable/<method>`
   to these, injecting Display's **own** `OPENMASJID_APP_SECRET` as `X-OpenMasjid-App-Secret`
   and the trusted caller id as `X-OpenMasjid-Caller-App` (here: `companion`).

## Contract v1 (versioned; additive changes bump nothing, breaking changes bump `v`)

All requests and responses are JSON. Every success body carries `"v": 1`.

### `POST /fabric/timetable/list`

Request body: `{}` (ignored fields tolerated).

Response `200`:

```jsonc
{
  "v": 1,
  "timetables": [
    { "id": "tt_6e46aea7", "name": "Main hall" }
  ]
}
```

- Every timetable the admin has created, `id` + display `name` only. **Not** gated on
  `widget.enabled` — the widget flag governs the *public iframe*, and this is a different,
  admin-granted channel (see Security). If Display's model has a natural "archived/disabled"
  state, exclude those; otherwise list all.

### `POST /fabric/timetable/get`

Request body:

```jsonc
{ "id": "tt_6e46aea7", "from": "2026-08-23", "days": 35 }
```

- `id` — required. `from` — required, `YYYY-MM-DD` in the timetable's own calendar/zone.
- `days` — required integer, **1–45**; reject outside the range with `400`.

Response `200` (field names may be adapted to Display's real model — the *requirements* below
are the contract; the exact shape Display ships becomes the recorded contract, so write it down
in Display's docs and Companion will match it):

```jsonc
{
  "v": 1,
  "id": "tt_6e46aea7",
  "name": "Main hall",
  "masjidName": "Masjid An-Noor",
  "timezone": "America/New_York",       // IANA — REQUIRED
  "language": "en",
  "hourCycle": "12",                     // "12" | "24" — the timetable's own display setting
  "days": [
    {
      "date": "2026-08-23",
      "hijri": { "label": "9 Rabīʿ al-Awwal 1448" },
      "prayers": {
        "fajr":    { "adhan": "04:58", "iqamah": "05:30" },
        "dhuhr":   { "adhan": "12:58", "iqamah": "13:30" },
        "asr":     { "adhan": "17:12", "iqamah": "17:45" },
        "maghrib": { "adhan": "19:42", "iqamah": "19:47" },
        "isha":    { "adhan": "21:05", "iqamah": "21:30" }
      },
      "jumuah": [ { "label": "Jumu'ah", "adhan": "13:00", "iqamah": "13:30" } ]
    }
  ]
}
```

**Hard requirements (not adaptable):**

- **`timezone` is present and IANA.** The consumer schedules push notifications from these
  times; without the zone every conversion is a guess.
- **Times are the masjid's local wall clock**, `HH:mm` 24-hour on the wire regardless of
  `hourCycle` (which is presentation).
- **Scheduled Iqamah changes are already applied** per day — the payload for a date is what a
  musalli standing in the masjid on that date should see, the same rule the widget and poster
  follow.
- **The range cap (≤ 45 days) is enforced server-side**, and the response fits the broker's
  256 KB ceiling with margin at the cap.
- **Read-only.** Neither method changes any state.

Errors: `404 { "error": "unknown_timetable" }` for an id that doesn't exist;
`400 { "error": "bad_request" }` for malformed input; `503 { "error": "not_ready" }` before the
app has its secret/config — mirroring the `commands` handler's conventions.

## Security requirements (mirror `fabricCommands.ts`, which got these right)

- **Verify the secret**: `X-OpenMasjid-App-Secret` must equal Display's **own**
  `OPENMASJID_APP_SECRET`, length-checked then constant-time compared. That is how you know the
  call came through the platform, not directly from another container.
- **Read `X-OpenMasjid-Caller-App`** for the caller's id (the platform sets it; a caller can't
  spoof it). Grant enforcement is the **platform's** job (static manifest grants:
  `companion` declares `consumes: [display/timetable]`); do not maintain a second allow-list
  here — but do log the caller id (and nothing else) on refusals.
- **Exact path only — that IS the LAN-only enforcement.** Behind the tunnel Display is served
  under `/<basePath>/…` with the prefix kept, so a tunnelled request arrives as
  `/display/fabric/timetable/get` and must match **nothing**. Never register the prefixed form;
  there is no header to trust for this.
- **Answer fast from what you already have**: 10 s platform timeout, so serve from the same
  in-memory model the widget/poster use — no per-request recomputation heavy enough to miss the
  window. Cap the request body small (the commands handler uses 8 KB; same is fine).
- The timetable is not secret on this channel's terms (the masjid publishes it on TVs), but the
  **channel** is: nothing here weakens the rule that `/fabric/*` never serves over the tunnel.

## Versioning, channels & rollout

- Ship on Display's **dev channel first** (`X.Y.Z-dev.N`, exact-tag image, the usual §0 rules),
  and add the `fabric.provides` manifest change in the **same** dev build as the routes — a
  manifest that advertises a capability an older image doesn't serve is a 404 the broker will
  faithfully deliver.
- Note in `docs/USING_THE_FABRIC.md` that `timetable` is Display's first **provides**, alongside
  the existing inbound `commands` route, and record the shipped payload shape there.
- Companion **fails soft** throughout: until this ships (or if the masjid never updates
  Display), Companion shows its "times not set up yet" / stale-cache states. Nothing on the
  Companion side hard-depends on a Display release date.
- Capability grants are re-read on app **update** as well as install (platform behaviour) — so a
  masjid gets this working by updating both apps, no reinstall.

## Acceptance test (the whole chain)

On a real OpenMasjidOS box with both apps installed from the dev channel:

1. From the platform host, a broker call succeeds:
   `POST /api/fabric/app/display/timetable/list` with **Companion's** secret → `200`, `v: 1`,
   at least one timetable.
2. `get` for that id with `days: 35` returns every day with the five prayers, Jumuʿah where the
   timetable defines it, `timezone`, and any scheduled Iqamah change on the correct day.
3. The same two paths requested **over the tunnel**
   (`https://<domain>/<display-basePath>/fabric/timetable/list`) return **404**.
4. A call with a wrong secret → `401`-class refusal; a day-range of `46` → `400`.
5. Companion's musalli page renders the times, and its admin panel's "Timetable" screen lists
   and picks from `list`.

## Non-goals (v1)

- No announcements / Iqamah-change **event feed** (a later additive method — Companion's
  "Later" list has it; design nothing for it now beyond not painting the URL space into a
  corner).
- No write methods of any kind.
- No change to the public widget, the volunteer page, or `commands`.
- No new platform work — the broker as shipped in OpenMasjidOS ≥ v0.40.0 carries this as-is.

---

# Addendum — SHIPPED. What Display actually built (2026-08-23)

> **This section, not the ask above, is the contract Companion is written against.** The ask
> stays as written because it is the history of the request; this records the answer. Display
> shipped `timetable` on its **dev channel** (`0.70.0-dev.83`), with the `fabric.provides`
> manifest entry in the same build as the routes, as asked.
>
> **The authoritative shape is the `Fabric*` interfaces in Display's
> `server/src/fabricTimetable.ts`**, written up in its `docs/USING_THE_FABRIC.md` §8. This
> addendum is Companion's copy of that, kept in step per CLAUDE.md §2. **The Display repo's copy
> of this work order needs the same addendum** — that is a note for a maintainer, not something
> this repo may do.

## Six deliberate divergences, and what each means for the client

1. **`jumuah[].adhan` is always `null`.** Not an omission: a Display timetable configures
   Jumu'ah as **jamā'ah times only** — there is no per-Jumu'ah Adhan field anywhere in its
   model. The example earlier in this document showed `13:00` and was wrong to. On the wall, the
   Friday countdown runs to the calculated **Dhuhr** adhan relabelled "Jumu'ah".
   → *Companion reads that day's `prayers.dhuhr.adhan` when it needs an adhan time for Jumu'ah,
   and never renders `jumuah[].adhan`.*

2. **`jumuah` is `[]` on every day that is not a Friday** *in the masjid's own timezone* (which
   is not always UTC's Friday). Display's screens carry a standing Jumu'ah strip on all seven
   days as a reference; repeating that here would assert a jamā'ah on a Tuesday.
   → *Companion shows Jumu'ah on the day it is sent, and does not carry it forward.*

3. **`sunrise` is present per day** — astronomical Shurūq, additive to the ask, free for Display
   to compute. Display offered to drop it if unwanted.
   → *Kept. Companion shows it. See "Decided" at the end of this addendum — Display should not
   drop the field.*

4. **Two extra statuses.** `409 {error:'no_location'}` — the timetable exists but the admin
   never set coordinates, so there is nothing to compute times *for*; answering anyway would
   return plausible-looking times for latitude 0, longitude 0. `405 {error:'method_not_allowed'}`
   on a non-POST. And the envelope refuses with **`403`, not `401`** (a 401 without
   `WWW-Authenticate` is wrong, and it matches Display's existing inbound route).
   → *`409` is Companion's "prayer times aren't set up yet" state, named precisely in the admin
   panel. Retrying it changes nothing, so it must not be treated as a transient failure.*

5. **`hijri` is `{ label }` only**, already localised to the timetable's own language. Structured
   day/month/year is available additively if asked for.
   → *Companion renders the label. It does not parse it, and it never computes a Hijri date.*

6. **`name` is the admin's PRIVATE label** ("Name (for you)" — e.g. "Women's section"), never
   shown on a Display screen.
   → *Exactly right for Companion's admin timetable picker. It must never be rendered on the
   musalli page, which shows `masjidName`.*

## The full error set a client has to branch on

| status | body                           | meaning for Companion                                                            |
| ------ | ------------------------------ | -------------------------------------------------------------------------------- |
| `400`  | `{error:'bad_request'}`        | our bug — a malformed `id`/`from`, or `days` outside 1–45. Not retryable.          |
| `403`  | `{error:'forbidden'}`          | the envelope refused, deliberately not saying which part. Not retryable.           |
| `404`  | `{error:'unknown_timetable'}`  | the admin deleted it in Display → ask them to pick again; serve the stale cache.   |
| `405`  | `{error:'method_not_allowed'}` | our bug — both methods are POST.                                                   |
| `409`  | `{error:'no_location'}`        | **not an error to retry.** The admin must set coordinates in Display.              |
| `429`  | `{error:'too_many_requests'}`  | Display's own 60/min socket-keyed limiter. Back off.                               |
| `503`  | `{error:'not_ready'}`          | Display has no secret yet (still starting). Retry.                                 |
| `5xx`  | anything                       | "ask again later".                                                                 |

Plus the **platform's** own `{ "fabric_error": { "code": … } }` — `not_granted`,
`target_not_installed`, `target_unreachable`, `timeout`, `rate_limited` — which never reaches
Display at all. Every one of these means *"feature unavailable, app still fine"*.

## Two properties worth relying on

- **`timezone` is the zone the times were actually COMPUTED in**, not the stored config string.
  Display's stored field is `''` for "this box's zone", and its engine also falls back to the
  host zone for a name `Intl` does not recognise — so passing the config string through would be
  silently an hour or more out, on every prayer, for everyone who installed this app. Companion
  schedules push notifications from this field and must never substitute anything else for it.
- **The answer contains no clock**, so it is deterministic and Companion may cache it freely.

## LAN-only: implemented differently, and more strictly

This document asked for Display's own commands-route doctrine — *"exact path only… there is no
header to trust for it"* — and Display kept the **intent** while rejecting the literal form,
correctly. Its router derives `pathname` with `new URL()`, which **normalises**, so nine
different request lines all arrive as `pathname === '/fabric/timetable/list'`
(`/display/../…`, `%2e%2e`, `.%2e`, an absolute-form target, a protocol-relative one, a
backslash separator, …). Matching the parsed pathname would therefore have let a tunnelled
request through. The shipped route compares the **raw request line** instead, which is strictly
stronger: the tunnel does not strip the prefix, so every one of those shapes is a *rewrite* of
the prefix rather than a way to remove it, and no tunnelled spelling can equal the bare path. A
query string is tolerated in case the platform ever appends a trace id.

Display also deliberately did **not** copy the commands route's `x-forwarded-*` refusal: the
broker *is* a proxy, so a route that refused `X-Forwarded-For` would be dead on arrival,
silently, and only discoverable on real hardware.

Read-only is **asserted, not intended** — a test reads the module and fails if `store.update`
ever appears in it.

## Acceptance test: steps 1–5 are still outstanding

Display could not run them: they need a real OpenMasjidOS box with **both** apps installed from
the dev channel, and Companion did not exist. Everything on the Display side is unit-tested, and
its equivalent of step 3 (tunnelled → 404) is the nine-shape table above, verified against Node's
URL parser.

**Step 3 is the one to confirm on real hardware**, and it is now Companion's turn to be the other
half of steps 1, 2 and 5. Those are the acceptance test for this repo's timetable slice.

## Sizing, confirmed

The worst case a masjid can configure — 45 days, eight Jumu'ah jamā'āt, the longest names the
store allows, Arabic labels — measures **18.5 KB**, so the broker's 256 KB ceiling has a factor
of about 14 in hand. The 45-day cap is really about CPU: every day is a fresh solar computation
in the same process that draws the masjid's screens at 1 fps.

## Decided

- **Shurūq: keep it, and show it** (Hasan, 2026-08-23). Companion renders `sunrise` as a row on
  the today, week and month views, visually distinct from the five jamā'āt because it is not one
  — it is a sun event, with no Iqamah. It is what a printed masjid timetable normally carries and
  a musalli timetable without it looks incomplete. **Display should NOT drop the field.** This is
  a small addition to `CLAUDE.md` §4's v1 list, made deliberately.

## Still open

- **Structured Hijri.** Available additively (`formatToParts`) if Companion ever needs to
  reformat the date rather than render Display's label. Nothing in v1 needs it, and asking for it
  would mean this app was formatting a Hijri date, which is close to computing one. Leave it.

---

# Work order #2 — OpenMasjidDisplay: add the masjid logo to the `timetable` capability

> **Status: REQUESTED, not built.** Raised by Companion 2026-08-24, after Hasan asked that a
> musalli's home-screen icon be the masjid's own logo. Companion ships the fallback chain without
> it and simply skips the first link until this exists — nothing here is blocking.

## Why

When a musalli adds OpenMasjid Companion to their home screen, the icon should be **their masjid's
logo**, not ours. Companion's own mark is the last resort, not the default: the app on somebody's
phone belongs to the masjid.

There are two masjid logos on a box and they are not the same thing:

| source | what it is | reachable today |
| ------ | ---------- | ---------------- |
| `GET ${OPENMASJID_BASE_URL}/api/public/logo` | the platform-wide logo, set once in OpenMasjidOS → Settings → Customize. Raster only, CORS-open, 404 when unset. | **yes** |
| Display's per-timetable `logoImage` | the logo actually **on the prayer screens** — the one a masjid uploads when they set their TV up | **no** — not on the `timetable` contract |

The second is the better answer and the one Hasan asked for, because it is the logo a musalli
already associates with the masjid: it is on the wall in front of them. It is also the more likely
of the two to be set at all — a masjid configures Display's screens long before anyone visits
Settings → Customize.

So Companion resolves in this order, and needs the first link built:

```
Display's timetable logo  →  the platform's /api/public/logo  →  Companion's own mark
```

## The ask

A **third method** on the same capability, at the same exact unprefixed path shape, under the same
envelope (`checkBrokerEnvelope`, read-only, no clock):

```
POST /fabric/timetable/logo      ← { "id": "tt_6e46aea7" }
```

Response `200`:

```jsonc
{
  "v": 1,
  "id": "tt_6e46aea7",
  "logo": {
    "mime": "image/png",          // the raster types Display already accepts
    "bytes": 48213,               // decoded length, so a consumer can sanity-check before decoding
    "data": "iVBORw0KGgo…"        // base64, no data: prefix
  }
}
```

…or `{ "v": 1, "id": "…", "logo": null }` when that timetable has no `logoImage` (the built-in
mark). `null` is a normal answer, not an error.

**A separate method rather than a field on `get`, deliberately.** `get` is polled on a cadence
(~every 15 minutes) and its whole virtue is that it is small — 18.5 KB at the 45-day cap. A logo
is 10–200 KB, changes maybe once in the life of an install, and inlining it would multiply the
steady-state cost of the feed by an order of magnitude for a payload that is identical every time.
Fetched separately it can be cached until the masjid changes it.

**Requirements:**

- **Raster only.** Refuse SVG even if `logoImage` holds one — an SVG is a script container, and
  this one ends up rendered as an app icon and re-encoded by the consumer. The platform's own
  `/api/public/logo` takes exactly this position and says so.
- **Cap the response.** The broker's ceiling is 256 KB each way and base64 costs 33%, so anything
  over ~180 KB decoded should answer `413 {error:'logo_too_large'}` rather than a truncated image
  or a broker-level failure. Companion treats that as "no logo" and falls through.
- `404 {error:'unknown_timetable'}` for an unknown id, as `get` already does.
- Read-only, like the rest of the capability.

**Versioning:** additive — a new method does not change `v`. Companion probes it and treats every
error, including a 404 from an older Display that has no such route, as "no logo, fall through".

## What Companion does with it

Once, at the point the admin picks a timetable and whenever they ask for a refresh: fetch, validate
it really is a raster of the declared type, re-encode to the 512/192/maskable PWA sizes server-side,
and store the derived icons on Companion's own volume. The masjid can always override it with an
upload in Companion's own settings — this only decides the **default**.

## If this is not wanted

Say so and Companion will fall back to the platform's `/api/public/logo` alone, which already works.
The result is simply that a masjid whose logo is on their screens but not in Settings → Customize
gets Companion's mark on the home screen instead of their own.
