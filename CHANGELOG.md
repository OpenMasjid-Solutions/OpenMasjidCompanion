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
