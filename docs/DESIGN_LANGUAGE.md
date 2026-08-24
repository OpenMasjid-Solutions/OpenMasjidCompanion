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

**1. The sky is the background.** Day is a pale blue with a warm sun glow in the top corner;
night is deep navy with stars and a moon. Nothing about it is decorative — it makes a
prayer-times app feel like it is about the actual sky rather than about a table.

*Revised 2026-08-24.* The first build of this moved the sky through **five phases** across the
day (night → dawn → morning → day → dusk) and planned to drive those boundaries off the masjid's
real Fajr, Shurūq and Maghrib. Hasan reviewed it and cut it: **one design throughout, matching
the screenshots.** So there are exactly two looks — a day one and a night one — chosen by the
reader's light/dark setting, and nothing about the page changes as the hours pass. It is less
clever and more consistent, which for a page someone opens twice a day is the better trade.

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

**~~The accent colour.~~ Superseded 2026-08-24 — we DID take it.** The original plan was to
inherit the masjid's own OpenMasjidOS accent, so a masjid that picked teal got a teal Companion.
Hasan chose the reference's fixed coral instead, for the musalli page only:

> **Musalli page: fixed coral on navy. Admin panel: still inherits the dashboard's accent.**

The split is the point. The page a musalli opens is always the same app, however many masjids
they have on their phone; the volunteer's settings screen still feels like part of OpenMasjidOS.
This is a deliberate departure from `CLAUDE.md` §6.2/§12, scoped to one half of the app, and it
is why `app.css` scopes the whole musalli palette under `[data-surface="musalli"]`.

**The tracker tab.** Out of scope, and it is a personal-worship log — this app stores nothing
about a musalli beyond an anonymous push subscription (`CLAUDE.md` §4).

**A location picker.** The reference is a personal app, so it asks where you are. This is a
*masjid's* app: the times are the masjid's, from the masjid's timetable, and offering to change
the location would imply this app can compute times for somewhere else. It cannot, and must
never look like it can (`CLAUDE.md` §2).

**Its exact composition.** We are taking structure and one strong idea, not making a copy. No
code, no assets, and no pixel-matching — our tokens, our glass, our type, our accent.

## How the sky actually works

Two looks, keyed off `data-theme` and nothing else:

- **Dark** — deep navy, a moon glow in the top corner, a faint star field.
- **Light** — pale blue, a warm sun glow in the same corner, no stars (they would be white on
  white).

`data-theme` still owns ink and contrast; the sky only supplies the ground behind them, so
WCAG AA holds in both and the background has no way to break it. Verified rather than assumed:
a harness samples the *rendered pixels* behind every text element in both themes and reports the
ratio. It has caught two real failures so far — the footer's AGPL source link at 2.8:1 against
the old midday sky, and the light-theme Hijri coral at 4.57:1, which passed but with no headroom.

All of it is CSS: gradients, a radial glow, and a star field made of repeating
`radial-gradient`s rather than an image. No bytes on a phone, no work on a Pi, and the drift
animation is behind `prefers-reduced-motion` like every other moving thing here.

**Whose clock, then?** The masjid's — for everything that is actually a time. The sky no longer
depends on the clock at all, but the countdown, the current-prayer highlight and the date all
resolve through the IANA zone in Display's payload, never the device's. See
`web/src/prayerTimes.ts` and `CLAUDE.md` §7.

## Qibla

Added to v1 by Hasan on 2026-08-24 — `CLAUDE.md` §4 listed it under "Later" and that section
needs updating to match. It is **not** a prayer-time calculation and does not touch the §2 rule:
a Qibla bearing is a great-circle heading to Makkah, wrong by a degree at worst, and self-evident
on screen. A wrong prayer time is silent and unfalsifiable; a compass pointing the wrong way is
neither.

**Position comes from the device**, and only from the device (Hasan, 2026-08-24). Asking Display
for the masjid's coordinates was drafted as work order #3 and **withdrawn** — it is not worth a
cross-repo change for a bearing that shifts by a fraction of a degree across a whole city.

That decision has two consequences, and both have to be built for rather than worked around:

1. **It needs a secure context**, so Qibla works over the tunnel and not on the plain-HTTP LAN —
   the same rule as install and notifications. The LAN page hides it rather than showing a
   button that cannot work.
2. **Declining is a normal outcome.** Plenty of people say no to a location prompt, and some
   phones simply fail to get a fix indoors — which is exactly where this app is used. The
   "we could not place you" state is a real screen with a retry, not an error toast.

The compass itself needs `DeviceOrientationEvent`, which on iOS requires both HTTPS and a user
gesture to request. So the screen is: show the bearing as a number and a static dial first, and
offer "use my compass" as a button. That ordering also means it degrades to something useful on
a desktop, which the reference app's design does not.

## Ordering

The sky shipped in slice 3. The arc, the date stepper, the prayer list and the big
current-prayer header landed in slice 4 with the timetable that feeds them. Qibla follows the
PWA work, since it is meaningless outside an installed app on a phone.

Two things the reference does that we do differently, both forced by the data:

- **Jumu'ah leads with its jamā'ah time**, not its Adhan. Display has no per-Jumu'ah Adhan field
  at all, so every Jumu'ah on a Friday carries that day's single Dhuhr Adhan — leading with it
  prints the same time down two or three rows and hides the only thing telling them apart.
- **A masjid with two Jumu'ahs gets two rows**, each placed on the timeline by its own jamā'ah,
  so "44 min until Second Jumu'ah" is possible at all.

The tab bar is not built. With one real destination it would be chrome around nothing; it
arrives when Qibla gives it a second.
