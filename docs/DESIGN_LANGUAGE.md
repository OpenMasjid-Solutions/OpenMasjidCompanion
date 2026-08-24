<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# The musalli page — design language

> Direction set by Hasan on 2026-08-24 from a salah app he uses, with four screenshots. This
> file is the durable record of what we took, what we deliberately did not, and the parts that
> are ours. Read it with `CLAUDE.md` §12, which it refines rather than replaces.

## What this is for

The admin panel can look like the rest of the OpenMasjid family and be done. The musalli page
cannot: it is opened on a phone, at Fajr, in a dark room, by someone who wants one number and
will decide in about two seconds whether this app is worth keeping on their home screen. It is
the only screen in the family that competes with the App Store rather than with a dashboard.

So the musalli half gets a stronger visual identity than a masjid admin tool would normally
justify, and this file is what that identity is.

## What we took from the reference

**1. The sky is the background, and it knows what time it is.** The single best idea in the
reference. Day is a pale blue with a warm sun glow in the top corner; night is deep navy with
stars and a moon. Nothing about it is decorative — it tells you, before you have read a word,
whether it is morning or night, and it makes a prayer-times app feel like it is about the
actual sky rather than about a table.

**2. The arc as the hero.** A curve across the top with the day's prayers as dots along it and
a marker at *now*. The passed prayers are behind you, the coming ones ahead. It answers "where
am I in the day" faster than any list can.

**3. The big current state.** The prayer name at display size, and one calm line underneath —
"1 hr 1 min until Dhuhr". Not a grid of equal-weight numbers.

**4. Passed prayers dim; the current one is outlined, not filled.** A filled highlight row
shouts. A rounded outline says "here" and keeps the list even.

**5. A date stepper with the Hijri date under it**, in the accent colour, and `< >` to walk
days.

**6. Tabular numerals, times right-aligned in a column** so the eye falls straight down them.

## What we deliberately did not take

**The accent colour.** The reference is coral throughout. Ours comes from the masjid's own
OpenMasjidOS appearance (`CLAUDE.md` §6.2) — a masjid that picked teal in their dashboard gets
teal here. Hardcoding a palette would break the one thing that makes this feel like *their*
app rather than ours.

**The tracker tab.** Out of scope, and it is a personal-worship log — this app stores nothing
about a musalli beyond an anonymous push subscription (`CLAUDE.md` §4).

**A location picker.** The reference is a personal app, so it asks where you are. This is a
*masjid's* app: the times are the masjid's, from the masjid's timetable, and offering to change
the location would imply this app can compute times for somewhere else. It cannot, and must
never look like it can (`CLAUDE.md` §2).

**Its exact composition.** We are taking structure and one strong idea, not making a copy. No
code, no assets, and no pixel-matching — our tokens, our glass, our type, our accent.

## How the sky actually works

The tension to resolve: the reference's background is dictated by the **time of day**, while our
theme system is dictated by the **viewer's light/dark preference**. Both have to hold.

So they are two layers, not one:

- **Theme** (`data-theme`) owns ink, contrast and the glass — everything legibility depends on.
  WCAG AA in both themes stays a hard requirement and is unaffected by the sky.
- **Sky** (`data-sky`) is a tint layer over the scene: `night | dawn | morning | day | dusk`.
  It moves the hue and the celestial glow, never the text contrast.

At night in the light theme you therefore get a soft dusk-blue rather than pure navy — the page
still reads as light, but it is not pretending it is noon.

**Whose clock?** The masjid's, not the phone's. A musalli travelling, or a phone with the wrong
zone set, must not make the masjid's page claim it is night. Until the timetable lands (it
carries the IANA `timezone`) the sky follows the device clock; the moment a timetable is picked
it follows the masjid's zone. This is the same rule as every other time on the page —
`CLAUDE.md` §7.

The sky is CSS only: gradients and a radial glow, with the star field a repeating
`radial-gradient` rather than an image. It costs no bytes on a phone and no work on a Pi, and
the drift animation is behind `prefers-reduced-motion` like every other moving thing here.

## Qibla

Added to v1 by Hasan on 2026-08-24 — `CLAUDE.md` §4 listed it under "Later" and that section
needs updating to match. It is **not** a prayer-time calculation and does not touch the §2 rule:
a Qibla bearing is a great-circle heading to Makkah, wrong by a degree at worst, and self-evident
on screen. A wrong prayer time is silent and unfalsifiable; a compass pointing the wrong way is
neither.

Two sources of position, in this order:

1. **The masjid's own coordinates**, which is the honest default for a masjid's app and needs no
   permission prompt, no HTTPS and no signal. Display holds them — that is what its
   `409 no_location` is about — but does **not** expose them on the `timetable` capability
   today. Requested as **work order #3**.
2. **The device's location**, for a musalli using the app away from the masjid. Requires HTTPS
   (so: the tunnel, not the LAN) and an explicit permission the musalli can decline.

Declining must leave a working screen, which is exactly why (1) is worth asking Display for.

The compass itself needs `DeviceOrientationEvent`, which on iOS requires both HTTPS and a user
gesture to request. So the screen is: show the bearing as a number and a static dial first, and
offer "use my compass" as a button. That ordering also means it degrades to something useful on
a desktop, which the reference app's design does not.

## Ordering

The sky ships with slice 3, because it needs only a clock and it is what makes the honest
"not set up yet" state feel like this app rather than a placeholder. The arc, the stepper, the
prayer list and the tab bar need real times and land with them in slice 4. Qibla follows the
PWA work, since it is meaningless outside an installed app on a phone.
