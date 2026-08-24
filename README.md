<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

<h1 align="center"><b>OpenMasjid Companion</b></h1>

<p align="center"><i>Prayer times and giving, on every musalli's phone.</i></p>

<p align="center">
  <a href="#what-it-does">What it does</a> |
  <a href="#how-it-works">How it works</a> |
  <a href="#what-it-needs">What it needs</a> |
  <a href="#install">Install</a> |
  <a href="#license">License</a>
</p>

---

> **Status: early development.** This app is on its `dev` branch and is **not listed in the
> OpenMasjid app catalog yet**. It is being built one working slice at a time; see
> [`CHANGELOG.md`](CHANGELOG.md) for what is actually in a build today. Nothing here is ready for
> a masjid's congregation.

**OpenMasjid Companion** is an app for
[OpenMasjidOS](https://github.com/OpenMasjid-Solutions/OpenMasjidOS) that puts the masjid in a
musalli's pocket. Put a QR code on the noticeboard; anyone who scans it gets your prayer timetable
on their phone, and can add it to their home screen like an app — no app store, no account, nothing
to sign up for.

It runs in **one container** on the masjid's own machine, alongside the rest of OpenMasjidOS.

## What it does

- **Your timetable, not a calculated one.** Today, this week and this month come straight from
  **[OpenMasjid Display](https://github.com/OpenMasjid-Solutions/OpenMasjidDisplay)**, so the times
  on a phone are the same times that are on the wall — including any Iqamah change you have
  scheduled, on the day it takes effect.
- **A countdown to the next jamā'ah**, with Jumu'ah and the Hijri date, laid out to be read
  one-handed in a dark prayer hall.
- **Works with no signal.** The last timetable it fetched stays on the phone, and it says plainly
  when it was last updated rather than guessing.
- **Optional prayer reminders.** A musalli chooses which prayers to be notified about, at the Adhan
  or a few minutes before the Iqamah. Per device, per person. The masjid sees a count, never a list.
- **Your appeals, in the app.** Paste the share link of any appeal from
  **[OpenMasjid Donations](https://github.com/OpenMasjid-Solutions/OpenMasjidDonations)** and it
  appears as a tile with its progress. Tapping **Donate** opens your Donations page to give.
- **A QR code and a printable poster**, generated for you, pointing at your real public address.

### Two things it deliberately does not do

- **It never calculates a prayer time.** No calculation method, no astronomy library, no "fallback"
  when Display is unreachable. Display owns prayer-time correctness in this family of apps and this
  app only *reads* from it. If it has nothing, it says so — a wrong prayer time confidently shown
  to a whole congregation is the worst thing this app could do.
- **It never handles money.** No card fields, no payment setup, no amounts collected. Giving happens
  on your Donations page; this app reads public appeal information and links out to it.

## How it works

```
 A musalli's phone  ──HTTPS via your Cloudflare tunnel──▶  OpenMasjid Companion (one container)
                                                                │
                                        ┌───────────────────────┴──────────────────────┐
                                        │                                              │
                    OpenMasjidOS Fabric (server-to-server, on your LAN)      your Donations page
                                        │                                     (public appeal info)
                                        ▼
                              OpenMasjid Display  ── your prayer timetable
```

The phone only ever talks to Companion. Companion's **backend** reads your timetable from Display
through the platform's app-to-app broker, reads your appeals from your Donations page, caches both,
and serves the caches. If either is unavailable, that part of the app degrades to an honest state —
it never takes the app down and it never invents anything.

## What it needs

- **OpenMasjidOS** with the app installed from the catalog.
- **OpenMasjid Display**, with a timetable set up and the `timetable` capability available (Display
  v0.70.0 or newer). Without it, Companion has no prayer times and says so.
- **Remote access turned on** in OpenMasjidOS → Settings → Remote access, with this app shared.
  This one is not optional: an installable app, push notifications and a QR code all need a public
  HTTPS address, and none of them can work from an address inside your building. Until it is on,
  the admin panel blocks on that step and the public page hides install and notifications rather
  than offering buttons that cannot work.
- **OpenMasjid Donations** — only if you want appeals in the app. Everything else works without it.

## Install

Through **OpenMasjidOS → App Store**, once the app is listed. There is nothing to fill in at
install; the platform will ask one question — whether to share the app over the internet — and
everything else is set up inside the app afterwards.

Running it by hand is possible for development (`docker compose up -d --build`), but without
OpenMasjidOS there is no Fabric, so there is no timetable to read and no public address to publish.

## Development

See [`CONTRIBUTING.md`](CONTRIBUTING.md). In short:

```bash
cd server && npm ci && npm run build && npm run typecheck:tests && npm test
cd web    && npm ci && npm run build && npm audit --audit-level=high
```

All development happens on the **`dev`** branch; `main` is what masjids install.
[`CLAUDE.md`](CLAUDE.md) is the full specification this app is built against.

## License

**AGPL-3.0-only** — see [`LICENSE`](LICENSE). This app is reached over a network by people who
never installed it, which is exactly what AGPL §13 is about: every page carries a link back to this
source.

Contributions are governed by the **Contributor License Agreement**
([`CLA.md`](CLA.md)) — you sign once, automatically, on your first pull request. The CLA keeps the
public tree AGPL-3.0 while letting OpenMasjid-Solutions also offer commercial/dual licences; you
keep your copyright. Details in [`CONTRIBUTING.md`](CONTRIBUTING.md).
