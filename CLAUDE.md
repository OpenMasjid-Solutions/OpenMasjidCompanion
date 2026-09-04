<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# CLAUDE.md — OpenMasjidCompanion

> Single source of truth for the **OpenMasjidCompanion** app. Read it fully before writing any
> code. When in doubt, follow this document and the reference repos over your own assumptions;
> if something is ambiguous, **ask before guessing**.

---

## 0. Branching policy — check this before your first edit

**This repo has two branches and they are not interchangeable. `main` is what every masjid
installs (once the app is listed).**

**Session-start check — run it before changing anything:**

```sh
git branch --show-current      # must print: dev
```

If it prints anything else, `git checkout dev` first. On a fresh clone with no branches yet,
create `main`, then create `dev` from it, and never touch `main` again.

### The rules

1. **All development happens on `dev`.** Every feature, every fix, every experiment, every docs
   change — this session and every future one.
2. **Never commit to `main`.** Not directly, not "just this once", not for a one-line typo, not
   for a hotfix.
3. **Never merge, rebase onto, or cherry-pick into `main` autonomously.** Not for a Critical
   security finding — that is what a fast `dev` → *"merge to main"* turnaround is for.
4. **`main` moves only when Hasan says the words "merge to main"** (or "push to main"). Nothing
   else authorises it: not a green CI run, not an urgent-looking bug, not an inference that he'd
   obviously want it. This app **starts on `dev` and stays there** until he decides it is ready.
5. **That merge is a release**, not a merge. It carries the full release chain in §17.

### The push protocol — every turn, without being asked

Work on `dev`, push to `dev`, and then **ask**:

> After finishing a piece of work and pushing it to `dev`, **end the reply by asking whether to
> push to `main`.** Keep working and keep pushing to `dev` for every following request. Do not
> push to `main` — and do not stop asking — until Hasan replies **"push to main"** (or "merge to
> main").

So the loop is: change → commit on `dev` → push `dev` → *"Do you want me to push this to
`main`?"* → carry on on `dev`. The question is a prompt for a decision, never permission you can
assume you already have: an unanswered ask, or silence, means the answer is still no. When the
answer does come, treat it as the release in §17 — not a fast-forward of `main`.

Point Dependabot at `dev` (`.github/dependabot.yml`, `target-branch: dev` on every entry) so
automated bumps arrive where work belongs.

### Channels: `dev` and `main` are wired to different images

OpenMasjidOS has an Update Channel toggle, and the dev catalog resolves this app from the `dev`
branch. The branch you are on decides which image real devices pull:

| branch | `manifest.yaml` version | compose references        | CI publishes                  | who installs it              |
| ------ | ----------------------- | ------------------------- | ----------------------------- | ---------------------------- |
| `dev`  | `X.Y.Z-dev.N`           | `…:X.Y.Z-dev.N`           | `:X.Y.Z-dev.N` **and** `:dev` | the OpenMasjidOS dev channel |
| `main` | `X.Y.Z`                 | `…:X.Y.Z@sha256:<digest>` | `:X.Y.Z` **and** `:latest`    | every masjid (stable)        |

**Every dev build gets its own version: `X.Y.Z-dev.N`.** Start at **`0.1.0-dev.1`** and
increment `N` on every dev build you publish. A dev version must never equal a stable one, and
an unbumped dev push is a no-op as far as the platform is concerned — OpenMasjidOS detects an
update by comparing the catalog's `version` with the installed one, so a moving `:dev` tag under
an unchanged version string reaches nobody. Bump the version and the compose `image:` reference
**together, in the same commit**, for **every** service.

Copy Display's **`channel` CI job** (`OpenMasjidDisplay/.github/workflows/checks.yml`) so all of
this is enforced, not remembered: it must fail on a dev image or prerelease version on `main`, a
non-digest-pinned image on `main`, a non-prerelease version on `dev`, and a `dev` compose tag
that doesn't match `manifest.yaml`.

### Releases, in one paragraph (full chain in §17)

Only on Hasan's words. The order is **publish → pin → tag → announce**: bump the version
everywhere, merge to `main`, let CI publish the image, commit the **manifest-list** `@sha256`
digest into `docker-compose.yml` in a compose-only commit, then **tag `vX.Y.Z` at that digest-pin
commit** — never its parent. Display has shipped this mistake three times; its `CLAUDE.md §0` is
the authoritative runbook and this repo follows it exactly, including `verify-release-tag.yml`.

**Then publish the GitHub release, because a tag is not a release** — OpenMasjidOS shows those
notes to the admin as *"What's new"* after it updates the app, so stopping at the tag hands a
masjid new software with no explanation. Propose the catalog entry, merge `main` back into `dev`,
restore the dev compose form, open the next `-dev.1`, re-open an empty `## Unreleased` — and then
**verify**: `gh release view` shows the notes, and the catalog's `main` actually serves the new
version. Full numbered chain in §17; it has ten steps and the tag is the sixth.

### The catalog is somebody else's `main` — you may only propose

Publishing an image is not the release. Masjids install from `catalog.json` in
**OpenMasjidAPPS**. What we may do — and the whole of it — is open a **PR against the catalog's
`dev` branch** changing only this app's entry in `registry.yaml` (`ref:` = the new tag,
`commit:` = the SHA of the **tagged digest-pin commit**, `dev_ref: dev`). Never push to the
catalog's `main`; never merge its `dev` into its `main`; a catalog maintainer runs that release.
The dev channel needs no PR at all once the entry exists — `dev_ref: dev` follows our branch
hourly, which is exactly why nothing lands on `dev` that a real masjid's test box shouldn't run,
and why the image must be **published before** the version bump is pushed (the catalog pins an
exact tag; an entry whose image doesn't exist yet is a pull failure on someone's phone-facing
server).

**Listing status (2026-09-04) — SHIPPED.** History, not a task. The entry has been in
`registry.yaml` with `dev_ref: dev` since PR #28, so the dev channel follows this branch.
[Catalog PR #29](https://github.com/OpenMasjid-Solutions/OpenMasjidAPPS/pull/29) merged on
2026-09-04 and a catalog maintainer has cut the release, so the catalog's `main` now serves
**companion 0.2.0** pinned to its manifest-list digest: real masjids on the stable channel are
being offered this app.

That took two moves that are **not** interchangeable, and the distinction is the one §17 step 10
exists to enforce. Merging the PR put the entry on the catalog's `dev`. Only the maintainer's
release moved the catalog's `main`, which is what a masjid actually reads. Until that second move
happened, "released" meant only that the tag and the image existed — never that anybody was being
offered them. Check the live `catalog.json`; never infer shipping from a merged PR.

**The Display dependency, resolved (2026-09-04).** `display/timetable` ships in **Display
v0.70.0**, which was released on 2026-09-04 and is what the stable catalog now serves. Both halves
of the grant therefore exist on the stable channel, and the ordering this section used to worry
about resolved itself in the order it wanted: Display first, Companion second.

Keep the shape of the lesson, because the next cross-repo dependency will repeat it. A capability
this app consumes can be **merged, tagged and even released** in the other repo and still not be
on a masjid's box — what settles it is the live `catalog.json`, never the other repo's `dev`
branch and never a doc in this one. This paragraph asserted "stable Display is v0.69.0" for five
days after it stopped being true. **Re-check before repeating a version claim**; never "fix" the
other repo from here (§2).

---

## 1. What we are building (one paragraph)

**OpenMasjidCompanion** is an app for
[OpenMasjidOS](https://github.com/OpenMasjid-Solutions/OpenMasjidOS) that puts the masjid in a
musalli's pocket: an installable **PWA**, reached through the masjid's own **Cloudflare tunnel**
and added to phones with a **QR code** on the noticeboard. It shows the masjid's **prayer
timetable** (today, this week, this month — with a live next-prayer countdown, Jumuʿah and the
Hijri date), sends optional **web-push prayer notifications**, and surfaces the masjid's
**donation appeals** with a tap-through to the OpenMasjidDonations page to give. It holds no
money, calculates no prayer times, and stores nothing about a musalli beyond an anonymous push
subscription: **Display owns the times, Donations owns the giving, this app owns the phone.** It
runs as **one Docker container** (a `server/` + `web/` split), is **AGPL-3.0**, and looks and
feels like the rest of the OpenMasjid family.

---

## 2. Prime directives — read the references first

You are building an OpenMasjidOS app. Three repositories define how that is done. **Read them
before and during the build; mirror them.**

1. **`OpenMasjid-Solutions/OpenMasjidDisplay`** — the reference implementation and the
   structural template. Copy its shape: the `server/` + `web/` split, the one-container
   `Dockerfile`, the compose conventions, the `manifest.yaml` layout, the CI that builds and
   publishes the image, the changelog machinery, and the CLA/licensing files. When this
   CLAUDE.md and Display's real code disagree on a mechanism, **read Display's code and follow
   it**, then fix this file.
2. **`OpenMasjid-Solutions/OpenMasjidDonations`** — the closer sibling for everything this app
   does with the Fabric: SSO with the reachable-vs-signed-in split, the appearance **relay**
   through our own server, the base-path handling (`rewriteUrl` strip + injected `<base href>` +
   `window.__OMOS_BASE__`), the fail-soft outbound-fetch posture (`redirect: 'error'`, short
   `AbortController` timeouts, never throw), and the alerts model. `OpenMasjidDonations/
   server/src/fabric.ts` and `web/src/base.ts` are the files to study line by line.
3. **`OpenMasjid-Solutions/OpenMasjidAPPS`** — the catalog contract: `CLAUDE.md` §2/§4,
   `docs/BUILDING_AN_APP.md`, `docs/DESIGN.md`, and the platform's `docs/APP_MANIFEST_SPEC.md`.
   The compose safety gate is real — a compose that trips it will not install anywhere.

**Hard rules that override everything except safety:**

- **License: AGPL-3.0 + CLA (hard rule for all future code).** The full AGPL-3.0 `LICENSE` plus
  the Contributor License Agreement (`CLA.md`, enforced by `.github/workflows/cla.yml`) — copy
  both from Display per `OpenMasjidAPPS/docs/APP_LICENSING.md`, changing only the app name.
  *Every line written here is AGPL-3.0 and CLA-covered.* **Every new file must start with the
  SPDX header** in its comment syntax — `// SPDX-License-Identifier: AGPL-3.0-only`
  (ts/tsx/js/css), `# …` (yml/sh/Dockerfile), `<!-- … -->` (md/html) — followed by
  `Copyright (C) 2026 OpenMasjid-Solutions`. Never strip a header; never add AGPL-incompatible
  code/assets/deps. Include a visible **"Source code"** link to this repo in the admin UI.
- **Never copy code from umbrelOS / `umbrel-apps` (PolyForm-Noncommercial).** Reimplement from
  behaviour.
- **This app never touches money.** No Stripe SDK, no card fields, no payment intents, no
  `stripe:`/`https:` manifest flags. Giving happens on the **OpenMasjidDonations** public page;
  this app only reads public campaign metadata and links out. If a feature seems to need a
  payment, stop and ask.
- **This app never calculates prayer times.** No adhan/astronomy library, no calculation-method
  settings, no "fallback calculation". Display is the single source of truth for times; if
  Display is unavailable, this app says so honestly and shows the last data it has, clearly
  marked stale. A wrong prayer time silently invented here is the worst failure this app can
  have.
- **Cross-repo needs are work orders, not edits.** The Display-side provider this app depends on
  is specified in [`docs/DISPLAY_TIMETABLE_WORK_ORDER.md`](docs/DISPLAY_TIMETABLE_WORK_ORDER.md)
  and is built by the Display agent in the Display repo. Never "fix" Display, Donations, the
  platform, or the catalog from here.

---

## 3. Repository & identity

- This is its **own repository**, **`OpenMasjidCompanion`** (separate from the platform, the
  catalog, and the other apps).
- App **`id`: `companion`** (kebab-case; the manifest id, the compose project `omos-companion`,
  and the registry id).
- Display name **"OpenMasjid Companion"**; category **`community`**; suggested tagline:
  *"Prayer times and giving, on every musalli's phone."* (The **installed** app on a phone is
  named for the masjid, not for us — §10.)
- Container image on **GHCR**: `ghcr.io/openmasjid-solutions/openmasjidcompanion:<version>`
  (mirror Display's naming; confirm its exact casing and copy it). Public, multi-arch
  (`linux/amd64,linux/arm64`).
- Registered later in OpenMasjidAPPS `registry.yaml` as:
  ```yaml
  - id: companion
    repo: OpenMasjid-Solutions/OpenMasjidCompanion
    ref: vX.Y.Z            # the human label
    commit: <40-char SHA>  # what is actually fetched — the tagged digest-pin commit
    dev_ref: dev           # the development channel, tracked automatically
  ```
  Changed **only by a PR against the catalog's `dev`** — see §0.

---

## 4. Scope

### ✅ In scope (v1.0)

- **Bottom tab bar:** Salah, Donate (only when the masjid has appeals), Settings, and Qibla
  when it lands. Drawn only when there are two or more places to go — one lit tab over the only
  page there is is a label, not navigation. That rule is unchanged and simply no longer fires:
  Settings (added 2026-08-29) means every install has a second place to go. `/give` is a real
  route, so it is bookmarkable, so it needs a real empty state.

- **Settings, a musalli's own** (`/settings`, added by Hasan 2026-08-29): **the masjid's own
  contact details at the top** (added 2026-08-30 — phone, email, address, website and links to
  WhatsApp, Instagram, Facebook, X, YouTube and Telegram; every field optional, nothing drawn for
  an empty one, and no card at all for a masjid that filled none of them in), then the things a
  reader may want to change, and nothing else. **Appearance** — keep the time-of-day look, or
  hold it dark or light all day; a pinned polarity still moves through the day inside it
  (always-dark runs Fajr → Maghrib → Isha), because "always dark" was a request about contrast,
  not a request to switch the design off. **Prayer reminders**, moved here from the sheet over
  the prayer times: these are settings, and a modal is a shape for a question. The bell in the
  header stays as a shortcut *to* this screen, because notifications are the one feature a
  musalli has to find on purpose. **The bell that used to be in the header was removed on
  2026-08-30**: with a permanent Settings tab, a second door to the same room is a second thing
  to explain. Everything here is per-browser, in localStorage, and never leaves the phone —
  except the reminder switches, which have to reach the server because the server is what sends
  them.

- **Haptics** (added 2026-08-30): a short buzz on a tap, on a swipe that actually moves, and when
  the Qibla lines up. One delegated `pointerdown` listener rather than forty call sites
  (`haptics.ts`), a switch in Settings shown only where there is a vibrator to switch off, and
  the phone's own setting always wins. **It does nothing at all on an iPhone** — Safari has never
  shipped the Vibration API and there is no route to the Taptic Engine from a web page — so
  haptics are only ever a confirmation of something already on screen, never the signal itself.

- **The onboarding page** (`/onboarding`, added by Hasan 2026-08-29) — **what the QR code
  points at.** A poster has to print instructions that are right for every phone that will ever
  scan it, so it prints the generic ones; a web page knows which phone and which browser is
  reading it and can say the one true sentence, including the one no poster could ever print:
  *"this browser can't — open it in Safari."* It detects the OS and the browser (`platform.ts`,
  the only user-agent table in the repo), offers the real `beforeinstallprompt` where there is
  one, names the buttons on iOS Safari, sends an in-app webview to a real browser with the
  address on the clipboard, and then offers notifications as a second step — never on load,
  which is how a browser learns to block a site for good. Launched standalone it redirects
  straight into the app: somebody who has already done the thing must never be shown the
  instructions for doing it.

- **Who's using it** (admin, added by Hasan 2026-08-29) — see the amended out-of-scope line
  below, and `server/src/analytics.ts` for why the schema is the constraint.
- **Musalli home (public, no login):** today's Adhan + Iqamah times for the five prayers,
  Jumuʿah, the Hijri and Gregorian dates, a live next-prayer countdown, and the masjid's name
  and logo. Big, calm, one-hand-usable, tabular numerals.
- **Week and month views** of the timetable, browsable, from the same Display data.
- **Offline:** the service worker caches the app shell and the last-fetched timetable window, so
  opening the app with no signal still shows times — with an honest "last updated" marker.
- **Web-push prayer notifications (v1, not later):** per-device opt-in; per-prayer on/off;
  notify at Adhan and/or N minutes before Iqamah. Self-hosted VAPID — no third-party push
  relay. §9. **Plus admin-authored announcements** (added 2026-08-29): one notice, typed and
  confirmed, to every phone that has not opted out of notices. A separate musalli-facing switch
  from the prayer reminders — someone who wants silence at prayer times may still want to hear
  about a funeral — and the only thing in this app that reaches a musalli unbidden, so it is
  admin-only, needs an explicit `confirm`, and is cooldown-guarded against a double-tap.
  **Standing announcements** (added 2026-08-30) let one be set to send itself — once on a date,
  every day, or on chosen weekdays at a chosen time. The masjid's own wall clock, from the
  timetable's IANA zone, with no fallback: with no timetable there is no hour, so nothing is
  scheduled rather than something being sent at the wrong one. A missed occurrence is written
  off rather than delivered late, and they are the one thing a **stale** timetable does not
  silence — Rule 1 exists because a prayer reminder computed from old times may be wrong, and
  "we are closed on Saturday" is not computed from the times at all.
- **Donation appeals:** admin-curated tiles (title, cover image, goal/raised progress) fetched
  from the **Donations app's public campaign API**, each linking out to the Donations donor page
  to actually give. §8.
- **Qibla (added to v1 by Hasan 2026-08-24; built 2026-08-30):** a compass pointing to Makkah,
  from the **device's own geolocation** — no Display change, and work order #3 was withdrawn on
  the same day rather than ask for the masjid's coordinates. This is **not** a prayer-time
  calculation and does not touch the §2 rule: a bearing is self-evidently right or wrong the
  moment you hold the phone up, where a wrong prayer time is silent. It needs a secure context,
  so the tab is drawn only over the tunnel, like install and push, and "location declined" is a
  designed screen rather than an error. **It asks again every visit** (Hasan, 2026-08-30): the
  bearing is held in memory for as long as the page lives, so moving between tabs does not
  re-prompt, and nothing is written to storage — a stored bearing is a fact about where somebody
  was, and this app does not write that down. **The bearing leads and the compass is offered second**
  — a magnetometer needs a permission, a gesture and somewhere that is not a basement, where
  "119°, east-southeast, 4,794 km" needs only a position. Only the BEARING is remembered on the
  phone, never the position. See `docs/DESIGN_LANGUAGE.md`.
- **Installability:** a server-generated web manifest + service worker, correct under the
  tunnel's base path, named and iconed for the masjid. §10.
- **QR + printable poster:** the admin panel renders a QR of the app's public URL **plus
  `/onboarding`** and a print-ready poster page ("Scan → Add to Home Screen", with iPhone/Android
  hints kept as the printed fallback). One value builds the code and the copy button, so the
  address on screen can never disagree with the one that was printed.
- **Admin panel** (login-protected; OpenMasjidOS SSO with a local-password fallback, mirroring
  Donations): guided first-run setup, timetable picker (via the broker), campaign curation, app
  name + icon, notification defaults + status, Share (QR/poster), and an account menu with the
  version, **"What's new"**, and the AGPL **"Source code"** link.
- **The tunnel is a prerequisite, stated plainly.** This app's purpose — installation, push, the
  QR — only exists over the masjid's Cloudflare tunnel (`tunnel: true`). Until Remote access is
  on and this app is shared, the admin panel shows a blocking setup step and the public side
  shows a friendly "this masjid hasn't finished setting up the app yet" state. Nothing pretends.
- **One container**, least-privilege, Pi-friendly, `/healthz`, translation-ready + RTL-ready
  (English first).

### ❌ Out of scope (v1.0)

- Payments of any kind in this app (hard rule, §2).
- Prayer-time calculation of any kind in this app (hard rule, §2).
- Musalli accounts, profiles, sign-in, or any personal data beyond an anonymous push
  subscription.
- Chat, feeds, event RSVPs, or community features.
- Native iOS/Android apps.
- Modifying OpenMasjidOS, Display, Donations, or the catalog (work orders only).
- ~~Analytics beyond a plain count of push subscriptions shown to the admin.~~ **Amended
  2026-08-29** (Hasan asked for a device/browser breakdown). The reason this line existed was to
  stop the app growing a visitor log, and that reason has not gone away — so what was built is
  the shape that answers a masjid's question without one ever existing: **the entire schema is a
  counter.** One row per (day, device, browser, mode), holding a number. No row per visit, no
  session, no id, no IP, no user agent, no path, no timestamp finer than the date; 90 days and
  then gone. The three fields are closed enums duplicated in `web/src/platform.ts` and asserted
  equal by `analytics.test.ts`, so an unauthenticated endpoint that lands in an admin panel has
  no free text in it anywhere. `analytics.test.ts` asserts the column list **exhaustively** — a
  future column has to be argued for in that test first. What stays out of scope is everything
  the old line was about: per-visitor records, paths, referrers, dwell time, or anything that
  could be joined against a push subscription.

### 🔭 Later (design for, don't build now)

- **Iqamah-change notices** pushed to musallis automatically — an additive method on the
  Display capability (`v` bump). *(Admin-authored announcements were here until 2026-08-29 and
  are now in v1: they need nothing from Display, so the two halves were separable. The admin
  types a notice and confirms it; it reaches every phone that has not turned notices off.)*
- Nearby-masjid handoff, events, multiple timetables (e.g. men's/women's halls). *(Qibla was
  here until 2026-08-24 and is now in v1, above.)*
- Admin WhatsApp `commands:` (e.g. subscriber counts).
- Full translations beyond the English strings (the scaffolding ships in v1).

---

## 5. Architecture

Mirror Display/Donations: everything in **one container** — the API server, the static web
build, and the SQLite store.

```
 Musalli's phone (installed PWA / browser)
        │ HTTPS via the masjid's Cloudflare tunnel: https://omos.<domain>/<basePath>/…
        ▼
 ┌───────────────────────────── omos-companion (one container) ─────────────────────────────┐
 │  web/  React + Vite — musalli app (/, /week, /month, /give) + /admin panel               │
 │  server/  Node 22 + Fastify 5                                                            │
 │   • base-path aware ingress (rewriteUrl strip; <base href> + __OMOS_BASE__ injection)     │
 │   • /manifest.webmanifest + /sw.js + icons — generated/served per §10                    │
 │   • /api/public/* — timetable cache, campaigns cache, push subscribe, appearance relay    │
 │   • /api/admin/* — behind SSO/local login                                                │
 │   • push scheduler (web-push, VAPID) driven by the timetable cache                       │
 │   • better-sqlite3 at /data (settings, campaigns, subscriptions, caches, VAPID keys)     │
 └────────┬──────────────────────────────┬──────────────────────────────────────────────────┘
          │ Fabric (server→server, LAN)  │ HTTPS (server→server, over the tunnel domain)
          ▼                              ▼
  OpenMasjidOS core                OpenMasjidDonations public API
  • /api/auth/session (SSO)        • GET <donationsBase>/api/public/campaign/<slug>
  • /api/fabric/site (URL/path)    • donor page at <donationsBase>/<slug>  ← where giving happens
  • /api/public/appearance (relay)
  • /api/fabric/alert
  • /api/fabric/app/display/timetable/*  ──▶ OpenMasjidDisplay (the broker; grants required)
```

**Data-flow doctrine.** The musalli's phone only ever talks to *this* app. This app's **backend**
talks to Display over the platform's app-to-app broker (LAN-only, by design) and to Donations
over its public API, caches both, and serves the caches. Every upstream is optional at runtime:
an unreachable Display or Donations degrades a section to its honest empty/stale state and
**never** takes the app down or invents data.

---

## 6. The Fabric, as this app uses it

The canonical spec is `OpenMasjidAPPS/docs/BUILDING_AN_APP.md` §7 + the platform's
`APP_MANIFEST_SPEC.md`. This section records what Companion declares and the rules that are not
ours to bend.

**Wire identifiers (never rename):** env `OPENMASJID_BASE_URL`, `OPENMASJID_APP_ID`,
`OPENMASJID_APP_SECRET`, `OPENMASJID_PUBLIC_URL`; header `X-OpenMasjid-App-Secret`; cookie
`omos_session`.

**Golden rules:** read those env vars **every process start** and never persist them (or
anything fetched with them) to the data volume — the platform changes them across restarts and
migrations. Every outbound Fabric/HTTP call sets `redirect: 'error'` and a 3–8 s
`AbortController` timeout, and **never throws** — a Fabric failure must never stop the app. The
compose **must reference** every injected `${VAR}` in `environment:` or it never reaches the
container and the Fabric silently no-ops (the exact trap that disabled Display's SSO for several
releases).

### What the manifest declares

```yaml
sso: true          # admin panel signs in with the dashboard login (local fallback kept)
domain: true       # GET /api/fabric/site → our public URL + base path (webmanifest, QR, push origin)
tunnel: true       # REQUEST internet exposure — this app's whole purpose; admin confirms at install
fabric:
  consumes:
    - display/timetable        # salah timings, via the app-to-app broker (see the work order)
alerts:
  - id: timetable-unavailable  # Display unreachable / not granted for a sustained period
    label: Prayer times source unavailable
    description: The Companion app hasn't been able to read the timetable from OpenMasjid Display.
  - id: push-failing
    label: Prayer notifications failing
    description: Push notifications to musallis' phones are being rejected in bulk.
  - id: test
    label: Test alert
# NO settings: — but tunnel:true still opens the install dialog with the pre-ticked
# "Share this app over the internet" checkbox, which is exactly the question this app needs asked.
# NO https:  — reserved for Stripe apps; this app takes no payments. HTTPS comes from the tunnel.
# NO stripe / email / whatsapp / notifications / commands — nothing here needs them (v1).
# NO fabric.provides — this app serves NO inbound /fabric/* surface at all in v1.
```

### 6.1 Single sign-on (mirror Donations)

Forward the request's `omos_session` cookie — read **only** from the incoming `Cookie` header,
never a query/header/body — to `GET ${OPENMASJID_BASE_URL}/api/auth/session` with
`X-OpenMasjid-App-Secret`. On `authenticated: true`, mint our own short-lived local admin
session (~1 h, vs ~30 d for a password login); cache positives ~45 s; treat `username` as
untrusted display text. `probePlatform` must report **reachable separately from signed-in**:
"you are not signed in" and "OpenMasjidOS is unreachable" need different screens, and conflating
them is what locks an admin out after a restore. **While the platform is reachable and SSO is
configured, `POST /api/setup` refuses an anonymous local-admin claim (403)** — the local
password is a recovery path for when the platform is *down*, never a parallel front door
(Display's `RESTORE_SSO_FIX.md` is the history; keep the guard).

### 6.2 Appearance

The dashboard appends `#omos=<base64url(JSON)>` on open; the web reads, sanitises, applies,
persists, and clears it. For live sync, poll `GET /api/public/appearance` **through our own
server relay** (our page is HTTPS behind the tunnel; the platform endpoint is plain HTTP on the
LAN — a direct browser fetch is mixed content). Relay `/api/public/logo` the same way; the
masjid logo seeds the default app icon (§10) and brands the poster.

### 6.3 Public URL + base path (`domain: true`)

`GET /api/fabric/site` → `{ enabled, domain, publicUrl, basePath }` is the live source of truth;
`OPENMASJID_PUBLIC_URL` is the convenience mirror. **Read `basePath`; never hardcode
`companion`** — the admin can rename it. Cloudflare and the OS front door forward the **full**
path without stripping, so the server is base-path aware exactly like Donations: Fastify
`rewriteUrl` strips the prefix before routing, and `index.html` is served with an injected
`<base href>` plus `window.__OMOS_BASE__` (copy `web/src/base.ts`). Never persist `publicUrl`;
never derive absolute URLs from the `Host` header (attacker-controlled, absent in background
jobs like the push scheduler).

### 6.4 The tunnel is required — and honesty about it

`tunnel: true` is a **request**; the admin confirms at install (pre-ticked) or later in Settings
→ Remote access / this app's page. Until `GET /api/fabric/site` says `enabled: true` **and**
`OPENMASJID_PUBLIC_URL` is non-empty:

- the admin panel's first-run flow blocks on a "Turn on Remote access in OpenMasjidOS" step with
  a link and plain instructions;
- QR, poster, install prompts, and push subscription are hidden, not broken;
- the public page (still reachable on the LAN — a kiosk or TV may use it) renders times
  normally but offers no install/notification UI, since neither can work over plain HTTP.

Nothing fakes a public URL, and nothing shows a LAN address to a musalli — a LAN URL on a poster
is a QR code that works for nobody outside the building.

### 6.5 Consuming `display/timetable` over the broker

```
POST ${OPENMASJID_BASE_URL}/api/fabric/app/display/timetable/<method>
  X-OpenMasjid-App-Secret: <our OPENMASJID_APP_SECRET>
  Content-Type: application/json
```

The platform authenticates us, checks the static grants (our `consumes` + Display's `provides`),
and proxies to Display, injecting Display's own secret and `X-OpenMasjid-Caller-App: companion`.
Limits are the platform's: JSON only, ≤256 KB each way, 10 s timeout, per-caller rate limit,
LAN-only. The **contract** (methods `list` and `get`, the day model, the versioned envelope) is
specified in [`docs/DISPLAY_TIMETABLE_WORK_ORDER.md`](docs/DISPLAY_TIMETABLE_WORK_ORDER.md) and
implemented by the Display agent; this repo builds the **client** against it.

**Fail-soft doctrine (required):** every `fabric_error` — `not_granted`,
`target_not_installed`, `target_unreachable`, `timeout`, `rate_limited` — means "feature
unavailable, app still fine", never a crash. Behaviour:

- Serve the **cached** timetable with a visible "last updated" staleness marker.
- Retry with backoff; refresh the cache on a steady cadence (~every 15 min) plus on admin
  demand.
- After a **sustained** outage (≥ 6 h of failures with musallis being served stale data), raise
  the `timetable-unavailable` alert **once per outage**, not per failure.
- If there has *never* been data (fresh install, Display absent, grant missing), the musalli
  page shows a calm "prayer times aren't set up yet" state and the admin panel names the actual
  cause (Display not installed / capability not available yet / not granted) in plain words.
- **Never fabricate a time. Never extrapolate a day Display didn't send.**

~~Until Display ships the capability, develop against a local stub behind `COMPANION_DEV_STUB=1`.~~
**Not needed, and deliberately not built** (2026-08-24): Display shipped `timetable` before this
app's client was written, so the condition never arrived. There is no branch anywhere in this
server that can produce a prayer time — which is a stronger form of "a masjid must never see stub
times" than a flag that ships disabled. Development without a Display container drives a fake
**platform** instead, so the real broker client, the real zod schemas and the real error mapping
all still run; a stub would have bypassed exactly the code most worth exercising.

### 6.6 Alerts

`POST /api/fabric/alert` with a **declared** id only; `disabled_by_admin` is a normal answer,
not an error; the admin routes each alert to email/webhook in OpenMasjidOS → Settings → Alerts
and we can never read that choice. Alerts go to the **admin**; there is nothing in this app that
emails or messages a musalli, ever.

---

## 7. Salah timings — how the data is used

- The admin picks **one timetable** from Display's `list` in the Companion admin panel; the
  chosen **id** (a non-secret) is stored in `/data`. If it later 404s (deleted in Display), the
  admin panel says so and asks them to pick again; the musalli page falls back to the stale
  cache with its marker.
- `get` is fetched as a rolling window (today − 1 day … today + ~35 days, respecting the work
  order's range cap) so the month view and the push scheduler always have runway. Cache the raw
  response in `/data` with its fetch timestamp.
- **All times are the masjid's wall clock in the payload's IANA `timezone`.** Every rendering
  and every push computation converts date + "HH:mm" + that timezone into an instant with a
  proper tz library — never the server's clock's zone, never a hand-rolled offset. DST
  transitions must be covered by tests.
- Respect the payload's `hourCycle` (12/24 h) and `language` for formatting; the countdown and
  "current prayer" highlight are derived, presentational, and must agree with the table on
  screen (one model, two views — Display's poster code follows the same rule for the same
  reason).
- Hijri comes from Display's payload. Do not compute it here.
- **A jamāʿah "change" is not a moved time** (the month view mark, `prayerChanged`). A masjid sets
  a jamāʿah either as a **clock time** (holds; the gap to the adhan drifts daily) or as an
  **offset** ("Maghrib + 5"; the printed time moves daily and nobody decided anything). Nothing
  changed if **either** the time held **or** the gap held — comparing only printed times marked
  every day of an offset Maghrib, and comparing only gaps would mark every day of a fixed Fajr.
  A **rounded** offset is indistinguishable from a small revision from the outside, which is why
  Maghrib is excluded by default with an admin switch (`month.maghrib`) rather than a cleverer
  rule. The setting is masjid-wide, rides in the public payload, and **is part of that payload's
  ETag** — otherwise a phone 304s and keeps the old marks.

---

## 8. Donation campaigns — read from Donations' public surface, give on Donations

**Zero Donations-side changes.** Donations already exposes, per campaign, a public JSON view at
`GET <donationsPublicBase>/api/public/campaign/<slug>` (title, description, `coverImage`,
`goalAmount`, `raised`, `currency`, `allowMonthly`, `masjidName`, …) and the donor page itself
at `<donationsPublicBase>/<slug>`. Companion consumes exactly that:

- **Curation is by pasted links.** In the admin panel the masjid pastes each campaign's **share
  link** (copied from the Donations admin), e.g. `https://omos.example.org/donations/ramadan`.
  Companion parses `<base>` + `<slug>`, requires **https**, sanity-checks that all links share
  one base (warn, don't refuse — a standalone Donations on its own domain is legitimate), and
  stores the ordered list. There is no public list endpoint in Donations and none is needed —
  curation is the feature: the masjid chooses what appears in the app.
- **The server fetches and caches** each slug's public JSON (server→server over HTTPS,
  `redirect: 'error'`, ~5 s timeout, cache ~60 s, serve-stale-on-error) and the musalli page
  renders tiles: cover, title, goal/raised progress bar, "Monthly available" hint when
  `allowMonthly`.
- **"Donate" opens the Donations donor page** (`<base>/<slug>`) with
  `target="_blank" rel="noopener"` so an installed PWA hands off to the browser and the musalli
  can come back. Money, cards, receipts, Stripe — all Donations' business, none of ours.
- **Fail soft, per tile:** a 404/inactive slug disappears from the musalli page silently and is
  flagged in the admin panel ("this appeal is no longer available"); a transient error serves
  the cached tile. If the public JSON reports `testMode`, show a plain warning **in the admin
  panel only** — a test-mode appeal featured to a congregation is a mistake the admin should
  hear about from us, not from a confused donor.
- Sanitise everything rendered from this feed (titles, descriptions, image URLs — http(s) only)
  exactly as if it were untrusted, because operationally it is a cross-app input.
- **Name the failure, never shrug at it.** This fetch leaves the building: the masjid's public
  address resolves on the internet and comes back through the tunnel, so it can fail at DNS, at
  the connection, at TLS, on a timeout, on a redirect we will not follow, on an HTTP status, or
  on a body that is not a campaign. **Those are seven different problems with seven different
  fixes**, and the admin panel must say which — a single "we couldn't reach this appeal" names
  the one explanation an admin has already ruled out by opening the link in their own browser.
  `describeProblem` carries the sentence and `problemDetail` the technical line, and a test
  asserts every branch has both.

---

## 9. Web-push prayer notifications

Self-hosted end to end: the **`web-push`** npm library with **VAPID** keys generated on first
boot and stored in `/data` (they are this app's own long-lived identity toward push services —
the one secret that *does* belong on the volume; never log the private key).

- **Subscribe flow:** musalli enables notifications in the app → SW
  `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` →
  `POST /api/public/push/subscribe` with the subscription + preferences. Preferences: per-prayer
  on/off (five + Jumuʿah), **at Adhan** and/or **N minutes before Iqamah** (0–60), and the
  timetable id they follow (v1: the one timetable). Re-posting the same endpoint updates in
  place; `POST /api/public/push/unsubscribe` (and the SW's `pushsubscriptionchange`) removes it.
- **Storage & privacy:** a subscription row is endpoint + keys + prefs + created/last-success
  timestamps. **That is all.** No name, no phone, no IP retained, no analytics. The endpoint is
  treated as a pseudo-identifier and never logged in full. The admin sees a **count**, never a
  list of endpoints.
- **Scheduler:** derived from the timetable cache and its IANA timezone (§7). Compute the next
  send instants per subscription pref; deliver with small jitter (don't stampede a push
  service); mark last-success. **410/404 → prune the subscription immediately.** Repeated
  provider errors across the fleet (not one dead phone) → `push-failing` alert, once per
  episode.
- **Never notify from stale data.** If the timetable cache is older than a hard threshold
  (e.g. 48 h), skip sends and surface the reason in the admin panel — a confidently wrong
  "Maghrib in 10 minutes" is worse than silence.
- **Payloads** are minimal and non-sensitive ("Maghrib — Adhan 7:42 pm", masjid name, tag per
  prayer+date so re-delivery collapses); `notificationclick` opens/focuses the app. Nothing
  auth-critical, nothing personal, ever.
- **Platform truths, stated in the UI:** push requires the app to be **installed** from the
  tunnel URL; on iOS (16.4+) it must be added to the Home Screen first. The enable-notifications
  screen detects and explains these plainly instead of failing mutely.
- Rate-limit `POST /api/public/push/*` (it is an unauthenticated write endpoint), validate with
  zod, and cap stored subscriptions at a sane ceiling with the admin told when it's hit.

---

## 10. The PWA itself — installability invariants

- **The web manifest is generated server-side, per request** — never a static file — because
  everything in it is dynamic: `name`/`short_name` come from the admin's **App name** setting
  (default: the masjid name if known, else "Masjid Companion" — the installed icon on a phone
  says *the masjid's* name, not ours), `start_url` and `scope` are `<basePath>/`, icons point at
  our icon routes, `display: standalone`, `dir`/`lang` follow the appearance, theme/background
  colors come from the design tokens.
- **Icon:** admin uploads a square PNG (≥ 512 px; validated, size-capped, re-encoded); the
  server derives the 512/192 and maskable variants **once at upload time** (a pure-JS resizer is
  fine — it's a one-off, not a hot path) and stores them in `/data`. Default: the masjid logo
  relayed from the platform when one exists, else a bundled generic mark.
- **Service worker at `/sw.js`** (the browser-visible path is `<basePath>/sw.js`, which makes
  the scope correct with no `Service-Worker-Allowed` games — this is the payoff of the
  strip-the-prefix pattern in §6.3). It precaches the app shell, uses stale-while-revalidate for
  the timetable/campaign JSON, serves an offline page, handles `push` /
  `notificationclick` / `pushsubscriptionchange`, and **never caches `/admin` or
  `/api/admin/*`**. Cache names are versioned with the app version; updates use the
  "new version ready — refresh" prompt pattern, never a silent forced reload mid-use.
- On the LAN (plain HTTP) the SW and manifest are quietly inert and the page still works as a
  normal website — correct, not a bug (§6.4).
- The QR encodes `OPENMASJID_PUBLIC_URL`/`publicUrl` exactly; the poster is a print-styled admin
  route (A4/Letter) with the masjid name, the QR, and three plain steps, with the iPhone
  ("Share → Add to Home Screen") and Android ("Install app") hints.

---

## 11. Admin panel

Screens (keep it this small): **Setup** (first-run wizard: tunnel check → pick timetable → paste
campaign links → app name + icon → Share), **Home** (status: tunnel, timetable freshness,
campaigns health, subscriber count, last push), **Who's using it** (the device/browser/installed
breakdown — under Share on purpose, because it is the answer to "did the poster work?" and reads
as that question only when it sits under the poster), **Timetable** (picker + preview + refresh now),
**Donations** (link list, reorder, per-link health, test-mode warnings), **Notifications**
(enabled state, defaults, subscriber count, "send a test notification to this device", the
one-off announcement, and the **standing announcements** list with its next-send times),
**Share** (QR + poster), **Settings** (app name/icon, local password management, language), and
the account menu (version, **What's new** from the changelog, **Source code** link).

Wording throughout is for a masjid volunteer: plain, warm, non-technical; errors say what
happened and what to do next; never a raw stack trace (log it; show a tidy message with an
optional details expander).

---

## 12. Design & theming

Match the family — the polish bar is Display, Donations, and the dashboard.

**The musalli page's visual direction lives in [`docs/DESIGN_LANGUAGE.md`](docs/DESIGN_LANGUAGE.md)**
(set by Hasan on 2026-08-24 from a reference app he uses): the time-of-day sky, the day arc with
the prayers along it, the big current-prayer header, the dimmed-past/outlined-present list, and
what was deliberately *not* taken from it — chiefly the accent colour, which comes from the
masjid's own OpenMasjidOS appearance, not from a palette of ours. Read it before touching the
musalli half; it refines this section rather than replacing it.

- **Tokens via CSS variables**, copied verbatim from Display (`tokens.css`, `glass.css`) with
  Tailwind utilities only (preflight off) mapped onto them. Dark default; light and
  follow-system first-class; never hardcode hex in components. No component library.
- **Inherit the live appearance via the Fabric** (§6.2) so the app tracks the dashboard's
  theme/wallpaper/accent; standalone falls back to its own setting.
- The musalli page is the identity of this app: calm, generous type, `font-variant-numeric:
  tabular-nums` for every time and countdown, Sakīna Glass cards, subtle geometric texture. A
  phone screen at Fajr in a dark room — light on the eyes, obvious at a glance.
- **Motion is done in CSS**, not a library. `prefers-reduced-motion` is honoured in the
  stylesheet — every animation and `:active` transform sits behind a `@media (prefers-reduced-motion:
  reduce)` block — which is why the `motion` package was dropped in 0.2.0: it was declared, never
  imported, and a JS `useReducedMotion` hook duplicated what the CSS already did. Reach for a
  library only when CSS genuinely cannot express the movement, and honour the query either way.
  **RTL** via logical properties only; i18n-ready strings (English
  first). **No Quranic/sacred text in decorative chrome** — prayer names and dates are content,
  ornaments are geometric.
- WCAG AA in both themes; visible `focus-visible`; icon-only buttons labelled.

---

## 13. Security

- **No inbound Fabric surface.** v1 declares no `fabric.provides` and no `commands:`, so no
  `/fabric/*` route exists in this server at all. If one is ever added, it follows Display's
  invariants to the letter (own-secret constant-time check **and** the caller header, exact
  unprefixed path only = the LAN enforcement).
- **SSO is an identity assertion, never a credential** (§6.1). The session check gates our
  admin panel and nothing else; this app never calls the platform's admin/tRPC API.
- **`/api/setup` is guarded while the platform is reachable** (§6.1). Keep the guard.
- **Secrets hygiene:** `OPENMASJID_APP_SECRET` read from env each start, never persisted, never
  logged. VAPID private key stored in `/data`, never logged, never sent to any browser. Push
  endpoints never logged in full.
- **One deliberate exception to `redirect: 'error'`: the campaign fetch** (`campaigns.ts`).
  The rule exists because every other outbound call presents `X-OpenMasjid-App-Secret` and a
  redirect would hand it to whatever host the redirect named. The campaign fetch presents
  **nothing** — it is the same anonymous GET a browser makes to a public donor page — so
  refusing a redirect buys no secrecy and breaks real deployments (a canonical-host rule or a
  trailing-slash normalisation at the Cloudflare edge). It follows at most 3 hops **manually**,
  and a hop is allowed only if it is **same-origin** (safe by construction) or a **public https**
  host. A public link may never bounce us onto a private address: that would make the admin's
  paste box a port scanner for the masjid's own network.
- **Outbound fetch posture everywhere:** `redirect: 'error'`, `AbortController` timeouts,
  https-only for anything crossing the tunnel domain, response-size caps on the campaign and
  timetable fetches, and no URL ever built from a request's `Host` header.
- **The visit counter is the third unauthenticated write** (`POST /api/public/visit`), and it
  gets its own, much larger budget rather than sharing the push one. Behind the tunnel every
  request arrives from the same peer — cloudflared's — so a per-peer limit is really a
  per-masjid limit, and 429ing a busy Jumuʿah would drop counts on precisely the day worth
  counting. The table can only ever hold a few dozen rows a day whatever happens, so what the
  limit bounds is write load, not growth. It follows that the counts are **inflatable by anyone
  holding the public link**, which is inherent to counting a public page and is said out loud on
  the admin's own screen rather than left to be discovered when a number looks wrong.
- **Unauthenticated writes are rate-limited and validated** (push subscribe/unsubscribe; the
  login endpoint gets attempt limiting like Donations). Everything external is parsed with
  **zod**; cross-app content (campaign JSON, timetable payloads) is sanitised before rendering.
- **Uploads** (the icon) are type/size-validated and re-encoded server-side; nothing is served
  back byte-for-byte from an upload.
- Behind the OS proxy, trust `X-Forwarded-*` **only** because the platform's ingress sanitises
  them; never when reached directly.
- Compose ships hardened: `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`,
  `tmpfs: [/tmp]`, named volume only. Aim for a non-root user + read-only rootfs from day one
  (Donations records not having this as a known gap — don't inherit the gap).

---

## 14. Coding conventions

- **TypeScript everywhere**, `strict` on plus `noUnusedLocals`/`noUnusedParameters`; no `any`
  without a justifying comment.
- **`server/`** — Node 22 + Fastify 5, better-sqlite3, zod, `web-push`, a real IANA-tz date
  library for §7/§9. No WebSockets (nothing here needs a live channel; the countdown is
  client-side).
- **`web/`** — React 18 + Vite + TS, Display's tokens, lucide-react, `qrcode.react`. No
  animation library: motion is CSS (§12).
- **Tests** are `node --test` via tsx, **listed explicitly in the `test` script of BOTH
  `server/package.json` and `web/package.json` — an unlisted test file silently never runs.**
  Each half has a `testFileCoverage.test.ts` that fails the suite when the list and the disk
  disagree, in either direction. Mirror Display's
  `npm run typecheck:tests` (`tsconfig.check.json`) so test files are actually typechecked:
  the build excludes them and tsx strips types without checking. Non-negotiable tests: timezone
  /DST scheduling, base-path routing (LAN and tunnelled forms), broker fail-soft states, the
  manifest generator, subscription pruning.
- Every file starts with the SPDX header (§2). Keep `docs/ARCHITECTURE.md` current with any
  non-trivial decision. When this file and the code disagree, follow the code, then fix this
  file.

---

## 15. Manifest, compose & registry

**`manifest.yaml`** — `id: companion`, `name: OpenMasjid Companion`, `category: community`,
`author: OpenMasjid-Solutions`, `license: AGPL-3.0-only`, `icon: icon.svg`,
`screenshots: [screenshots/1.svg]`, a warm volunteer-voice `description` (what it does, "install
then set up inside", the tunnel prerequisite in one honest sentence), `version` per §0, and
exactly the capability set in §6: `sso`, `domain`, `tunnel`, `fabric.consumes:
[display/timetable]`, `alerts` (three ids). The alert ids are a **contract with code** — a test
must read this file and fail when the server fires an id the manifest doesn't declare (mirror
Donations' `notify.test.ts`).

Deliberate absences, each load-bearing: **no `settings:`** (one-click apart from the tunnel
checkbox the platform itself shows); **no `https:`** (Stripe apps only — hard platform rule);
**no masjid data collected at install** (everything is configured inside, and the platform
injects no profile).

**`docker-compose.yml`** — one service; `image:` pinned per channel (§0);
`restart: unless-stopped`; `ports: ["7880:8080"]` (a default ≥ 1024 — the platform detects
conflicts and remaps, so never depend on the host port); named volume `data:/data`;
`cap_drop: [ALL]`; `security_opt: ["no-new-privileges:true"]`; `tmpfs: [/tmp]`; and an
`environment:` block that **references every injected var**:

```yaml
    environment:
      OPENMASJID_BASE_URL: ${OPENMASJID_BASE_URL:-}
      OPENMASJID_APP_ID: ${OPENMASJID_APP_ID:-}
      OPENMASJID_APP_SECRET: ${OPENMASJID_APP_SECRET:-}
      OPENMASJID_PUBLIC_URL: ${OPENMASJID_PUBLIC_URL:-}
```

Never `privileged`, host namespaces, `cap_add`, devices, the Docker socket, sensitive host
mounts, `extends:`/`include:`, or discovery labels — the catalog build and the platform both
refuse them.

**Registry** — §0 and §3: PR against the catalog's `dev` only, `commit:` pinned to the tagged
digest-pin commit, and only once the app genuinely installs and opens.

---

## 16. Build & run

```sh
# server (API + push + storage). build = tsc; test = node --test via tsx (explicit list).
cd server && npm run build && npm run typecheck:tests && npm test

# web (musalli app + admin). build runs tsc --noEmit, then vite build.
cd web && npm run build && npm test && npm audit --audit-level=high

# everything together (what the App Store runs)
docker compose up -d --build
```

Before any PR/push, run what CI runs — anything less is a weaker signal than it looks.

---

## 17. CI & versioning

- **`build-image.yml`** — on push, builds multi-arch and publishes
  `:X.Y.Z[-dev.N]` plus the branch alias (`:dev` on dev, `:latest` on main); re-checks the
  version format before pushing (a dev build that lost its `-dev.N` would publish over a stable
  tag); `paths-ignore` excludes `docker-compose.yml` so the digest-pin commit publishes nothing.
  Copy Display's, adjust names. Make the GHCR package **Public** after the first run.
- **`checks.yml`** — build + typecheck + tests + the **`channel` job** (§0).
- **`verify-release-tag.yml`** — on any `v*` tag, asserts the tagged tree's compose digest
  equals what GHCR serves for that version. Copy Display's.
- **`cla.yml`** + `CLA.md` + `CONTRIBUTING.md` per `APP_LICENSING.md`.
- **`CHANGELOG.md` ships inside the image** (`/api/changelog` parses it; the account menu shows
  "What's new"), written for two audiences: `## Unreleased` on `dev` logs **everything** as it
  lands, in plain language; a release **condenses** it to what a masjid would notice. Never
  rewrite a released section. Mirror Display §0b, including the parser tests against the real
  file.
- **The release chain** (only on Hasan's words, §0). **Numbered because it has been got wrong by
  stopping early: the tag is step 6 of 10, not the end.** Display's `CLAUDE.md §0` is the full
  runbook with the war stories; the steps below are this repo's, with what it has learned.

  1. **Bump the version** in `manifest.yaml`, both `package.json`s and both lockfiles. In a
     lockfile set the **root version only** — `.version` and `.packages[""].version`, by parsing
     the JSON. A blind `"<old>"` → `"<new>"` replacement also rewrites any **dependency** sitting
     on that version (0.2.0 hit `real-require@0.2.0`, a transitive dependency of pino), leaving a
     lockfile whose `version` and `resolved` URL disagree. It could not have fired at 0.1.0, which
     is what makes it the kind of bug that waits for a version number to collide. Then
     `grep -rn "<old version>"` must come back empty except the compose line.
  2. **Condense `## Unreleased` into `## X.Y.Z`** — only what a masjid would notice. Match the
     heading **line-anchored**: a bare `indexOf('## Unreleased')` also matches the phrase in this
     changelog's own intro paragraph, and has mangled the file once.
  3. **Point compose at the bare `:X.Y.Z` tag** and commit the release on `dev` — **but do not
     push `dev`.** A non-prerelease version on `dev` fails the `channel` job; `dev` catches up
     from the merge-back in step 9. (Compose carries the bare tag, not the *previous* release's
     digest: `manifest.test.ts` asserts the compose tag equals the manifest version, and that
     invariant is worth more than a green `channel` job on a commit that is never tagged.)
  4. **Merge to `main` and push.** CI publishes `:X.Y.Z` and `:latest`. **`Checks` goes red on
     this one commit and that is expected** — `channel` requires every image on `main`
     digest-pinned, and the digest cannot exist before the push that creates it. `server` and
     `web` must both be green; if anything else is red, stop.
  5. **Pin the digest.** Read it from GHCR (`docker buildx imagetools inspect`), **never from the
     build log**, and confirm it is the **manifest-list / OCI image index** carrying `linux/amd64`
     *and* `linux/arm64` — a per-architecture digest pins amd64 and breaks every Raspberry Pi in
     the catalog. Commit `:X.Y.Z@sha256:<digest>` touching **compose only**.
  6. **Tag that commit**, and check both of these **before pushing the tag**: `git rev-list -n1
     v<version>` prints the digest-pin SHA and not its parent (Display has shipped that off-by-one
     three times), and the tagged tree's digest equals what GHCR serves. After the push, a red CI
     run is all that is left to tell you.
  7. **Publish the GitHub release.**
     `gh release create vX.Y.Z --title "vX.Y.Z — <the headline>" --notes-file notes.md`
     **A tag is not a release.** OpenMasjidOS shows these notes to the admin as *"What's new"*
     after it updates the app in the background, so a tag without a release means a masjid gets
     new software and no explanation of what changed. Write for a **volunteer**, not a changelog:
     what they can now do that they could not, what got fixed, and what needs no action. No bullet
     soup of commit subjects. `CHANGELOG.md`'s condensed section is the raw material, not the text.
  8. **Propose the catalog entry** — a PR against the catalog's `dev` only (§0), `ref:` the new
     tag and `commit:` the SHA of the **tagged digest-pin commit**.
  9. **Put `dev` back to work:** merge `main` back, restore the dev compose form, open the next
     `-dev.1`, re-open an empty `## Unreleased`. Not tidying — the catalog only accepts a dev entry
     at or ahead of the stable release, so a `dev` left behind makes the dev channel silently fall
     back to stable while looking perfectly healthy.
  10. **Verify it actually shipped.** Two checks, both required:
      - `gh release view vX.Y.Z` prints the notes, with `draft: false`.
      - `curl -fsSL https://raw.githubusercontent.com/OpenMasjid-Solutions/OpenMasjidAPPS/main/catalog.json | grep '"companion"' -A3`
        reports the new version. **A merged PR against the catalog's `dev` is not shipped** —
        the catalog's `main` moves only when a catalog maintainer cuts a release. If this still
        shows the old version, your part is done and you are waiting on them: **say so plainly
        rather than reporting the release as delivered.**

---

## 18. Definition of done (per feature)

Builds, typechecks (including tests), and tests pass; new test files are in the explicit list;
works in **both** themes and **both** LTR/RTL; honours `prefers-reduced-motion`; the musalli
page works on a phone one-handed and offline where the feature allows; every upstream failure
mode has its honest degraded state (no invented times, no broken buttons); admin routes stay
behind auth; all new strings are translation-ready; wording is plain and friendly; SPDX headers
present; `## Unreleased` has an entry; and the feature installs and works on a real
OpenMasjidOS box through the tunnel — the QR-on-a-phone test is the acceptance test for anything
musalli-facing.

---

## 19. Working agreement for Claude (the coding agent)

- **First command of every session: `git branch --show-current`** — must print `dev` (§0).
  Never touch `main` without the words "merge to main"; **after every push to `dev`, end the
  reply by asking whether to push to `main`**, and keep working on `dev` regardless of the
  answer's absence.
- Read this file first, every session. §2 (licensing + the two "never"s: no payments, no prayer
  calculation), §6 (Fabric rules), §9 (push privacy), §10 (PWA invariants), and §13 (security)
  are hard constraints.
- Build **vertically** — one full slice end-to-end before the next. Suggested order: skeleton +
  licensing + boot; SSO + admin shell; base-path + appearance + honest tunnel states; broker
  client + timetable pick + musalli today view (stubbed per §6.5 until Display ships); week/
  month + SW + manifest + install; campaigns; push; QR + poster; polish + CI + changelog +
  listing.
- Cross-repo needs go through work orders (§2). The Display contract lives in
  `docs/DISPLAY_TIMETABLE_WORK_ORDER.md`; if it must change, change the doc and flag it to Hasan
  — never assume the Display side.
- Ask before adding heavy dependencies; Pi-friendly is a family value. Keep the musalli bundle
  light (lazy-load the admin panel).
- When a task seems to require touching money, calculating a prayer time, or editing another
  repo — **stop and ask.**
