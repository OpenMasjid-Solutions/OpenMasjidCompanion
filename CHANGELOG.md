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

- **Your masjid's contact details in the app.** Add a phone number, email, address, website and
  links to WhatsApp, Instagram, Facebook, X, YouTube or Telegram in the admin panel, and they
  appear at the top of **Settings** for everyone. Fill in as much or as little as you like &mdash;
  a phone number on its own is a perfectly good answer, and anything left blank simply isn't
  shown. The address gets a **Directions** button, the phone number dials, and the email opens a
  message.

- **A small buzz when you tap.** Tabs, buttons, swiping between days and months, and &mdash; the
  useful one &mdash; the moment the Qibla lines up, so you can feel it without looking at the
  screen. There's a switch to turn it off in Settings. **This only works on Android**: iPhones
  give web apps no way to vibrate at all, so nothing on screen ever depends on it.

- **On an iPhone, Directions asks which map.** Sending an iPhone straight to Google Maps is a
  guess about somebody else's phone; half of them land on a page asking them to install it. Every
  other phone still goes straight there, because there is only one answer.

### Changed

- **Reminders now say "Iqamah"** rather than "Jamāʿah", matching the column heading on your own
  timetable. One word for one time.
- **The Qibla asks where you are each time you open the app**, instead of remembering it. Moving
  between tabs won't ask again, and nothing about your location is stored anywhere.
- **The Qibla screen opens with just the button.** The paragraph explaining that your location
  stays on your phone is gone &mdash; it's still true, and your browser is about to ask you the
  same question in its own words.
- **The bell has gone from the top of the screen.** Reminders live in **Settings**, which is
  always one tap away at the bottom.

### Fixed

- **The Kaaba could cover a compass letter.** For a masjid whose Qibla happens to point close to
  north, south, east or west &mdash; Karachi, Sydney, Nairobi, Mombasa &mdash; the Kaaba was drawn
  on top of that letter and hid most of it.
- **The masjid&rsquo;s contact details were indented** further than everything else on the
  Settings screen.

- **The compass has been redrawn** as a proper compass face &mdash; a white card with a fine
  bezel, a marked ring, and the Kaaba turned to face the Qibla rather than to face the top of
  your phone. The long line across the dial is now a single needle showing which way you are
  pointing: turn until the Kaaba sits under it.

- **Qibla.** A new tab showing which way Makkah is from wherever you are standing &mdash; the
  direction in degrees, in words, and how far away the Kaaba is, with a dial you can line up.
  Tap **Use my compass** and the dial follows your phone, telling you which way to turn until it
  says *Facing the Qibla*. **Your location never leaves your phone**: the masjid never sees it,
  nothing is sent anywhere, and the only thing kept is the direction itself, on your own device.
  Saying no to the location prompt is a normal answer and gets a proper explanation rather than
  an error.

- **Announcements that send themselves.** In the admin panel you can now set a notice to go out
  once on a date, every day, or on chosen days of the week at a chosen time &mdash; a Jumuʿah
  reminder every Friday morning, a nightly notice through Ramadan. It uses **your masjid's own
  clock**, shows you when each one will next go out, and can be paused and started again without
  retyping it. Before saving it reads the schedule back to you (&ldquo;Every Friday at
  11:00&rdquo;) and says it will keep going until you pause it. If this app has been off, a
  missed one is skipped rather than delivered late.

- **Real photographs in the "add to your home screen" steps**, instead of a drawing &mdash;
  including what to do when **Add to Home Screen isn't in your Share sheet at all**, which is the
  point most people give up at.

### Fixed

- **The Qibla and the compass button could fail to appear** on a perfectly capable phone, because
  the page decided what it was capable of a fraction of a second before it knew whether the app
  was reachable from the internet.

- **A page that walks people through putting the app on their phone**, and the QR code now points
  at it. A printed poster has to give instructions that suit every phone that will ever scan it;
  this page knows which phone and which browser is actually reading it, so it says the one thing
  that is true — the buttons to press on an iPhone, a real "Add to home screen" button on
  Android, and, for anyone who tapped the link inside WhatsApp or Instagram, that they need to
  open it in Safari or Chrome first, with the address ready to paste. It offers reminders as a
  second step, and skips itself entirely once the app is on the home screen.

- **A Settings tab**, with two things in it. **Appearance**: keep the way the app follows the
  time of day, or hold it dark or light all day &mdash; and even held one way it still moves
  through the day, so an "always dark" evening still looks like the evening. **Prayer reminders**
  have moved here from the sheet that used to open over the times, which is where anyone would
  look for them; the bell at the top now takes you straight to them.

- **"Who's using it" in the admin panel** &mdash; how many phones have opened your app in the
  last month, whether they are iPhones or Android, which browsers, and how many opened it from
  their **home screen** rather than a browser. That last number is the one that tells you whether
  the poster on your noticeboard is working. **It counts phones, never people**: nothing is
  stored about anybody who opens the app &mdash; no name, no number, no address, no record of a
  visit &mdash; only these totals, and only for 90 days.

### Fixed

- **Light-coloured text on a night sky.** If your phone was set to light mode, any screen the app
  reached before it knew your masjid's prayer times &mdash; a fresh install with no timetable
  chosen yet, or a link straight to the appeals page &mdash; drew dark text on the dark
  background it falls back to. It now keeps the two in step.

- **Jumuʿah reminders.** Jumuʿah now has its own switch in the reminder settings, separate from
  Dhuhr &mdash; and if your masjid holds more than one, you can pick which one you want to be
  reminded about. On a Friday the Dhuhr reminder steps aside for it, since that is the jamāʿah
  actually being held.

- **Swipe between months** in the month view, the same way you swipe between days.
- **The day a jamāʿah time changes, that time is shown in a different colour** on the prayer
  times themselves &mdash; so you can see at a glance which one moved, not just that something did.

- **Send an announcement to everyone.** Type a notice in the admin panel &mdash; a funeral, a
  closure, a changed jamāʿah &mdash; and it goes to every phone signed up for reminders, with your
  masjid’s name on it. It asks you to confirm first, showing how many phones it will reach and
  quoting your message back, because it can’t be taken back once sent. Musallis have their own
  switch for these, separate from the prayer reminders.

- **Prayer reminders on a musalli's phone.** Tap the bell on the prayer times and pick which
  prayers, and whether to be told at the adhan or a set number of minutes before the jamāʿah.
  It is per phone and off until someone turns it on, and turning it off removes it completely.
  **The masjid is shown how many phones signed up and nothing else** &mdash; this app keeps no
  name, number or address for anybody who does. Reminders come straight from your own box; no
  outside service is involved.
- **The admin panel can send a test reminder to your own phone**, so you can prove it works
  before it matters, and it reports how many phones are signed up and whether anything is
  stopping reminders going out.

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

- **The arc curves smoothly all the way over the top.** It had gone flat across the middle,
  like the top of a table; it is now one continuous curve with a rounded crest.
- **The arc now follows the sun rather than being a plain arch** &mdash; flat along the horizon at
  dawn, a quick climb through the morning, level across the middle of the day, then a longer,
  gentler afternoon and a steeper drop into the evening.
- **The month view slides when you change month**, the same way the day view does.
- The Adhan and Iqamah headings sit with the times they label rather than with the date above them.
- **The marker showing where you are in the day now sits exactly on the end of the line**
  rather than a little ahead of it.
- **The arc above the prayer times now runs to the edges of the screen**, sits closer under the
  countdown, and has the shape it was always meant to have.
- **Isha at Isha time kept losing the bottom of its highlight box.** It no longer does.
- **Long dates and long times no longer break onto a second line** &mdash; “Wednesday, September 2”
  and “10:15 PM” both fit.
- The Sunrise time is centred between the two columns, since it is neither an Adhan nor an Iqamah.
- Clearer wording in the month view and in the reminder settings.

- **Prayer reminders would have stopped arriving at masjids with more than a handful of
  people signed up.** Reminders were sent one phone at a time with a pause between each, so a
  round for fifty phones could take longer than the reminders were valid for. They now go out
  together and a round for sixty phones takes about three seconds.

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
