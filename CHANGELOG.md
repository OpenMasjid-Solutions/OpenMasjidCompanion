<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Changelog

Release notes for OpenMasjid Companion, newest first. These ship **inside** the app — the
admin panel's account menu → **What's new** shows them with no internet needed.

**`## Unreleased`** is the working log on the `dev` branch and lists *every* change, in
plain language, as it lands. A release condenses it into a `## X.Y.Z` section carrying
only what a masjid would actually notice. A released section is never rewritten.

## Unreleased

### Added

- **The app knows its own address on the internet, and keeps knowing it.** It asks
  OpenMasjidOS where it is published and follows the answer, so turning on Remote access —
  or renaming the app's web address — is picked up without restarting anything. The setup
  panel now has a real first step: it tells you whether your app is reachable from outside
  the building, shows the address a musalli's phone would actually use, and gives you the
  three things to click in OpenMasjidOS if it isn't. "We couldn't check" and "it's switched
  off" are shown as different things, because they need different fixes.
- **The masjid's own logo on the prayer times page.** If you've set a logo in OpenMasjidOS
  it now appears at the top of the page people see, falling back to the Companion mark when
  you haven't. This is also what the app's icon on a phone's home screen will be built from.
- **A sky behind the prayer times.** The page's background follows the time of day — deep
  and quiet at night, warm at first light, open at midday. It is not decoration: before
  you've read a word it tells you which end of the day you're looking at. It works in both
  light and dark, holds its contrast in both, and stays still if your phone is set to reduce
  motion. Once you connect a timetable it will turn over at your actual Fajr, Shurūq and
  Maghrib rather than at round clock hours.
- **A way to check your alerts actually reach you.** Send a test alert from the panel and
  find out now — rather than the first time something goes wrong — that your alert routing
  works. If you've switched that alert off in OpenMasjidOS, it says so plainly instead of
  reporting a failure; that's your setting, not a fault.
- **A settings panel, and a way into it.** Press **Open** on the Companion app in your
  OpenMasjidOS dashboard and you are signed straight in — no second password to remember.
  The panel shows what still needs doing before anyone can use the app on their phone, and
  an account menu with the version, **What's new**, and a link to the source code.
- **A way in when OpenMasjidOS isn't answering.** If the dashboard can't be reached — a
  backup restored onto a new machine, the box briefly down — the panel says so plainly and
  lets you use a password for this app instead, setting one then and there if you never
  had one. It deliberately will *not* let anyone set that password while the dashboard is
  working: signing in through OpenMasjidOS is the normal way in, and a second front door
  standing permanently open is not the same thing as a spare key.
- **What's new, inside the app.** OpenMasjidOS updates apps in the background, so this
  build's release notes ship inside it and are readable from the account menu with no
  internet needed.
- **Installable on the OpenMasjidOS Development channel.** The app is listed in the
  OpenMasjid app catalog's dev channel, so a masjid running Update Channel → Development
  can install it from the App Store like any other app. It is deliberately **not** on the
  stable channel and will not be until there is something worth a congregation's time —
  see the README's status note.
- **The app exists.** First skeleton: the container builds and runs, serves its themed
  shell, and answers a health check. Nothing musalli-facing works yet — prayer times,
  notifications, appeals and the QR code all arrive in the slices after this one.
- **It is correct at both of its addresses from the first commit.** OpenMasjidOS serves
  every app on one public hostname under a path the masjid chooses, and forwards that
  path to the app without removing it — so this app is reached as `/api/app` on the local
  network and `/companion/api/app` (or whatever the masjid renamed it to) from a phone,
  at the same time, by the same running process. The prefix is stripped once before
  routing and injected back into the page, so both work and neither is a special case.
  This is the thing that is painful to retrofit, so it is here first and has tests for
  every shape of it.
- **The honest empty state.** With no timetable connected, the page says prayer times
  aren't set up yet — calmly, and permanently, rather than pretending to load. This app
  never calculates a prayer time and never will; if it has nothing from the masjid's
  OpenMasjid Display, it says so.
- **Least privilege from day one.** The container runs as an unprivileged user with a
  read-only root filesystem, no capabilities, and a single named volume for its data.
- **The licence is enforced, not just documented.** A test walks the whole repository and
  fails if any file is missing its AGPL-3.0 header, so a file cannot be shipped in an
  image under a licence it never declared.
- **Nothing the platform owns is ever written to disk.** The platform's address, this
  app's secret and its public URL are read from the environment on every start, so a
  backup restored onto a different machine picks up the new values instead of the old
  ones. A test asserts the data volume holds nothing that looks like them.

### Fixed

- **The app no longer disappears from the internet when OpenMasjidOS restarts.** If the
  dashboard briefly stops answering, the app keeps serving on the web address it already
  knows instead of forgetting it — a restart of the dashboard is not an outage of the
  prayer times.
- **The source-code link at the foot of the page is readable on every background.** Against
  the brightest skies it was faint enough to fail the contrast standard, on the one link
  the licence requires to be reachable.
