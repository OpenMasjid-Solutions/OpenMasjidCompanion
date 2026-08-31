<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Changelog

Release notes for OpenMasjid Companion, newest first. These ship **inside** the app — the
admin panel's account menu → **What's new** shows them with no internet needed.

**`## Unreleased`** is the working log on the `dev` branch and lists *every* change, in
plain language, as it lands. A release condenses it into a `## X.Y.Z` section carrying
only what a masjid would actually notice. A released section is never rewritten.

## 0.2.0

- **A screen that fails now says so.** If something goes wrong while the app is drawing a
  page, it shows a short message and a Reload button instead of going blank. Your prayer
  times are not affected by this — it is about the app, never your timetable.

Behind the scenes: unused code and one unused package removed, and the documentation brought
back in line with what the app actually does.

## 0.1.0

The first release. **OpenMasjid Companion puts your masjid in your congregation's pocket** —
put a QR code on the noticeboard, and anyone who scans it gets your prayer times on their phone
and can keep them there like an app, with no app store and nothing to sign up for.

### What it does

- **Your timetable, never a calculated one.** Today, this week and this month come straight from
  **OpenMasjid Display**, so the times on a phone are the times on your wall — including any
  Iqamah change you have scheduled, which is marked on the month view and shown in a different
  colour on the day it takes effect. This app never works out a prayer time of its own.
- **A countdown to the next Iqamah**, with Jumuʿah, the Hijri date, and a page that looks like
  the time of day — dark before Fajr, light by mid-morning, dark again after Maghrib. Swipe
  between days and months. It works with no signal, and says plainly when it last checked.
- **Prayer reminders on a musalli's phone.** They choose which prayers, and whether to be told at
  the adhan or a set number of minutes before the Iqamah. Jumuʿah has its own switch, and if you
  hold more than one they can pick which. It is per phone and off until somebody turns it on.
  **You are shown how many phones signed up and nothing else** — this app keeps no name, number
  or address for anybody who does, and reminders come from your own box with no outside service
  involved.
- **Announcements.** Type a notice — a funeral, a closure, a changed Iqamah — and it reaches every
  phone signed up, with your masjid's name on it. It asks you to confirm first, showing how many
  phones and quoting your words back, because it cannot be taken back. You can also set one to
  send itself: once on a date, every day, or on chosen days at a chosen time, on your masjid's
  own clock. Musallis have a separate switch for notices, so somebody who wants silence at prayer
  times can still hear from you.
- **A Qibla compass**, from the phone's own location — which never leaves it and is never stored.
- **Your appeals.** Paste the share link of any appeal from **OpenMasjid Donations** and it
  appears as a tile with its progress. Tapping **Donate** opens your Donations page to give; this
  app never handles money.
- **Your contact details** — phone, email, address, website and links to WhatsApp, Instagram,
  Facebook, X, YouTube or Telegram. Fill in as much or as little as you like; anything blank is
  simply not shown.
- **A page that walks people through installing it**, which is what the QR code points at. It
  knows which phone and browser is reading it, so it gives the steps that are actually true for
  that phone — including what to do when *Add to Home Screen* is missing from an iPhone's Share
  sheet, and what to do if the link was opened inside WhatsApp or Instagram, where it cannot work
  at all.
- **"Who's using it"** in the admin panel: how many phones opened your app in the last month,
  iPhone or Android, and how many opened it from their **home screen** rather than a browser —
  which is the number that tells you whether the poster is working. It counts phones, never
  people, keeps nothing about anybody, and forgets after 90 days.

### Before it can reach a phone

**Turn on Remote access in OpenMasjidOS and share this app.** A QR code pointing at an address
inside your building works for nobody outside it, so until that is done the app says so plainly
rather than printing a poster that cannot work. There is nothing to fill in at install; open it
and it walks you through the rest.
