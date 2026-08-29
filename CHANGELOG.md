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

- **Tabs along the bottom**, the way an app on a phone works: **Salah** and **Donate**, with
  Qibla to come. The appeals have moved off the end of the prayer times onto their own tab. If
  your masjid has no appeals running there is no Donate tab and no bar at all &mdash; nothing to
  tap that leads nowhere.

- **Your appeals, in the app.** Paste an appeal's share link from OpenMasjid Donations in the
  admin panel and it appears under the prayer times &mdash; picture, title and how far along it
  is &mdash; with "Donate" opening your own donation page to give. Companion never handles money;
  it shows the appeal and hands over. Appeals that have been deleted, or that aren't taking
  donations at the moment, quietly stop showing and the panel tells you why.
- **The page now looks like the time of day.** Each prayer has its own sky, and the sun moves
  with it — low and to the side at Fajr, high overhead at Dhuhr, at the horizon by Maghrib, with
  the moon and stars at Isha. It is light through the day and dark at either end, following the
  masjid's own times rather than your phone's dark-mode setting.
- **The jamāʿah time is now the one you see first**, with the Adhan beside it and both under
  proper column headings. It is the time you are actually deciding by.
- **A month view.** Tap the calendar to see the whole month, with the days your jamāʿah times
  change marked — the one thing on a month of prayer times worth spotting, and the day people
  otherwise turn up at the wrong time. Tap a day to jump to it.
- **Swipe between days**, the way you swipe through photos. Scrolling still scrolls.
- **A "Today" button** to get back after browsing ahead.

### Fixed

- **The "a new version is ready" notice is now across the top of the screen** rather than at the
  foot of the page, where on a phone it was below the fold and most people never saw it. It
  doesn't shift the page while you're reading, and you can dismiss it &mdash; the new version
  arrives on your next visit either way.
- **When an appeal won't load, the app now says why.** It used to answer "we couldn't reach this
  appeal" to every possible cause &mdash; including on a link that opens perfectly in your own
  browser, which is the least helpful thing it could have said. It now tells you whether the
  server couldn't look up your address, couldn't connect, was refused, timed out, was redirected
  to a login page, or got something back that wasn't an appeal &mdash; each with the technical
  line underneath for whoever looks after the box.
- **Appeal links that go through a redirect now work.** Cloudflare and similar often redirect a
  link to its canonical address, and the app was refusing to follow, which looked exactly like a
  broken link.
- **On an iPhone, the "add to your phone" prompt now says to open the page in Safari** when
  you're in Chrome, Firefox, or the browser that opens inside WhatsApp or Instagram. Adding to
  the Home Screen only works in Safari, and the old wording sent people looking for a button
  their browser doesn't have. The masjid's logo is centred in that prompt now too.
- **The month view was marking every single day as a jamāʿah change.** If your Maghrib jamāʿah
  is set a few minutes after the adhan, its time moves every day on its own &mdash; and the app
  was calling each of those a change, so every day was marked and the marks meant nothing. It now
  tells the difference between a time that moved with the sun and one your committee actually
  changed. Maghrib is left out by default, and there's a switch on the Prayer timetable panel to
  put it back if your Maghrib jamāʿah is a fixed time you set.
- **The "add this to your phone" prompt is now a proper dialog** in the middle of the screen
  rather than a strip at the bottom of the page, where most people never scrolled to see it. It
  waits until your times are on screen, and once you dismiss it, it stays dismissed.

- **Browsing to another day used to show the weekday with a stray comma** where it now offers a
  way back to today. It was also redundant — the full date sits directly beneath it.
- The foot of the page says **OpenMasjid Solutions** rather than a build number, which meant
  nothing to anyone reading it.

- **A QR code and a poster for the noticeboard.** Print it, put it up, and anyone who scans it
  gets your prayer times and can keep them on their phone. The poster carries your masjid's name,
  the code, and three short lines — with the iPhone and Android steps spelled out, because those
  two are different and nobody remembers which. The code always points at your real public
  address, and if Remote access isn't on yet the app refuses to draw one rather than give you a
  poster that only works on your own wifi.
- **Pressing Open in your dashboard now takes you straight to the settings.** It used to land on
  the prayer times, which is the page everyone else sees, not the one you came for. Anyone
  arriving from a QR code still goes to the prayer times, as they should.
- **It's an app now.** Open it on a phone and you can add it to the home screen — your masjid's
  name under your masjid's icon, opening straight to the prayer times with no browser bar. On an
  iPhone it explains where the Share button is, because Apple gives no other way.
- **It works with no signal.** Once someone has opened it, today's times are on their phone. In a
  basement prayer hall, on the underground, on a dead phone network — the times are still there,
  with the note of when they were last checked so nobody is misled about how fresh they are.
- **Your logo becomes the icon, by itself.** It's taken from the logo on your timetable in
  OpenMasjid Display, or your masjid logo in OpenMasjidOS, whichever you have — nothing to do.
  You can upload your own in the panel if you'd rather, see exactly which one it picked, and
  change the name that appears under it.
- **Prayer times.** The app now shows your masjid's timetable: which prayer is on now, how long
  until the next one, and the whole day's times with the jamāʿah beside each. Shurūq is there,
  Fridays show your Jumuʿah jamāʿāt in place of Dhuhr — each one on its own line, so "44 minutes
  until the second Jumuʿah" is something the app can actually say — and you can step forward and
  back through the days. The Hijri date is the one your Display already shows.
- **Choose your timetable in the panel.** Pick from the timetables you have in OpenMasjid
  Display, see when they were last read, and refresh straight away after changing an Iqamah. If
  something is wrong — Display not installed, no location set on that timetable, the timetable
  deleted — the panel says which, in words, and what to do about it.
- **The times keep working when Display doesn't.** They are stored and re-read on start, so a
  reboot does not blank the page, and if Display stops answering the app keeps showing the last
  times it received with a clear note of when they were checked. It never fills a gap with a
  time of its own. If that goes on for more than six hours you get one alert — one, not one per
  attempt.
- **A design that stays put.** The page has one look by day and one by night, following your
  phone's own light/dark setting, rather than shifting through the hours as an earlier build
  did.
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
