<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Copyright (C) 2026 OpenMasjid-Solutions -->

# Contributing to OpenMasjid Companion

Thanks for helping! A few ground rules.

## Branch: work on `dev`, never on `main`

This repo runs **two channels**, and they are not interchangeable:

| branch | version       | CI publishes                  | installed by                 |
| ------ | ------------- | ----------------------------- | ---------------------------- |
| `dev`  | `X.Y.Z-dev.N` | `:X.Y.Z-dev.N` **and** `:dev` | the OpenMasjidOS dev channel |
| `main` | `X.Y.Z`       | `:X.Y.Z` **and** `:latest`    | every masjid (stable)        |

**Branch from `dev` and open your pull request against `dev`.** A push to `main` publishes the
container image every masjid installs, so `main` only ever moves as a deliberate release by a
maintainer. A PR against `main` will be asked to retarget. (Dependabot is configured the same way
— every entry sets `target-branch: dev`.)

CI enforces the difference: the `channel` job fails if `docker-compose.yml` references a dev image
on `main`, an un-pinned image on `main`, or a stale/moving tag on `dev`. Don't "fix" a red
`channel` job by relaxing the check — it is guarding what a masjid installs.

## The two things this app must never do

Both are in [`CLAUDE.md`](CLAUDE.md) §2 and both override any other consideration:

- **It never calculates a prayer time.** Not as a fallback, not "just for the countdown", not with
  a library. Every time shown or notified comes from the masjid's own **OpenMasjid Display** over
  the Fabric. If Display is unavailable, the app serves what it last fetched with a visible
  "last updated", or says it has nothing. A wrong prayer time silently invented here is the worst
  failure this app can have — worse than showing nothing.
- **It never touches money.** No Stripe, no card fields, no amounts collected. Appeals link out to
  the masjid's **OpenMasjid Donations** page, which owns all of that.

If a change seems to need either, stop and open an issue rather than finding a way.

## Note your change in the changelog

`CHANGELOG.md` has an **`## Unreleased`** section at the top. Add a line there describing your
change in plain language — what a masjid admin or a musalli would notice, not the implementation.
Every change gets an entry: fixes, small behaviour changes and internal work all count, because
that section is also how the next release is written.

The admin panel serves this file as "What's new" (it ships inside the image), so keep it readable:
no ticket numbers, no commit hashes, no internal jargon.

## Licensing

This project is licensed **AGPL-3.0-only** (see [`LICENSE`](LICENSE)) and contributions are
governed by the **Contributor License Agreement** ([`CLA.md`](CLA.md), the canonical text). By
submitting a contribution you agree it is licensed under **AGPL-3.0-only**, you certify the
[Developer Certificate of Origin](https://developercertificate.org/) (the work is yours to
contribute), and you accept the CLA. Sign your commits off:

```
git commit -s -m "..."
```

**Signing the CLA.** You sign **once**, automatically, on your first pull request: the CLA bot
comments with a link to [`CLA.md`](CLA.md) and asks you to reply with the exact sentence

> I have read the CLA Document and I hereby sign the CLA

The CLA keeps the public tree AGPL-3.0 while letting OpenMasjid-Solutions also offer
commercial/dual licenses; you keep your copyright. If you cannot accept the relicensing grant
(§2 of the CLA), say so in your PR and we'll take it AGPL-only or discuss.

## Code

- Keep it **AGPL-3.0-only** — every source file carries an SPDX header
  (`// SPDX-License-Identifier: AGPL-3.0-only`, in the right comment syntax for the file type),
  followed by `Copyright (C) 2026 OpenMasjid-Solutions`. Add one to new files; never remove or
  alter an existing one. **A test enforces this** across the whole repository, so a missing header
  fails the suite rather than an audit two years later.
- Never add code, assets or dependencies under a licence incompatible with AGPL-3.0. In
  particular, never copy from umbrelOS / `umbrel-apps` (PolyForm-Noncommercial) — reimplement from
  behaviour.
- Match the surrounding style; the UI follows the OpenMasjidOS design language (dark default,
  WCAG AA in both themes, logical properties so RTL works, honours `prefers-reduced-motion`).
- **The musalli bundle stays light.** It is opened on a phone, on masjid wifi, sometimes on one
  bar of mobile data. The admin panel is lazy-loaded so it never lands in the first load; keep it
  that way, and ask before adding a dependency to the web half.
- Don't weaken the security invariants: base-path stripping happens once before routing and
  nowhere else; nothing derives a URL from the request's `Host` header; every outbound call sets
  `redirect: 'error'` and an `AbortController` timeout and never throws; the platform's secret and
  the VAPID private key are never logged or persisted anywhere they don't belong; a push endpoint
  is never logged in full.
- **`/api/setup` stays guarded while the platform is reachable.** The local password is a recovery
  route for when OpenMasjidOS is *down*, not a second front door.

## Run it locally

```bash
cd server && npm ci && npm run build && npm test
cd web    && npm ci && npm run build && npm test
```

For a live loop, run `cd server && npm run dev` alongside `cd web && npm run dev` — the Vite dev
server proxies `/api` and `/healthz` to the server on :8080.

> **npm 11 and the native module.** `better-sqlite3` needs its install script to fetch a prebuilt
> binary, and npm 11 requires that to be approved. `server/package.json` carries an `allowScripts`
> block that grants it, deliberately WITHOUT a version pin so a Dependabot bump doesn't silently
> produce an unbuilt module. Older npm (including the one in the image and in CI) ignores the
> field and behaves as it always did.

## Before you open the PR

Everything below is what CI runs, so running it first saves a round trip:

```bash
cd server && npm run build && npm run typecheck:tests && npm test
cd web    && npm run build && npm test && npm audit --audit-level=high
```

- `npm run build` (server) compiles, but **deliberately excludes `*.test.ts`** — tests are never
  emitted into the image. `npm run typecheck:tests` is what typechecks them; the runner (tsx)
  strips types without checking, so without it a broken test can still pass.
- **A new test file must be added to the `test` script** — in `server/package.json` or
  `web/package.json`, whichever half it belongs to. Both are explicit lists, not globs, and a test
  that quietly never runs is worse than no test because it is trusted. Each half has a
  `testFileCoverage.test.ts` that fails the suite if you forget, and also if the list names a file
  that no longer exists.
- `web`'s `npm run build` is `tsc --noEmit && vite build`, so it typechecks as well as bundles.
  `noUnusedLocals` is on, so an import left behind by a deletion fails the build rather than
  riding along.
- New behaviour wants a test. The server suite is plain `node:test` — no framework to learn.
