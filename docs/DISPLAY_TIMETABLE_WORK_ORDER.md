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
