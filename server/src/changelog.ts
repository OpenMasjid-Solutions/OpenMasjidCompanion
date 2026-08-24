// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * changelog.ts — the release notes this build shipped with, for the admin panel's
 * "What's new".
 *
 * OpenMasjidOS updates apps in the background. An admin whose Companion app changed overnight
 * has no way to find out what changed without leaving for GitHub — which is exactly the kind
 * of thing that has to be answered inside the panel. CHANGELOG.md is copied into the image, so
 * this works on a box with no internet.
 *
 * The parsing lives on the SERVER, not in the web bundle, for one reason: this repo's test
 * runner covers `server/`, and a changelog parser is not hypothetical code to get wrong.
 * OpenMasjid Students shipped a "What's new" that rendered only bullet lines, so every plain
 * paragraph in its notes was silently dropped. So the endpoint returns structured releases and
 * the client only formats them.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * One line of release notes.
 *
 * `heading` marks a `### Added` / `### Fixed` group label. It is carried rather than flattened
 * because the two are not the same thing to a reader: rendering "Added" as a bullet puts a
 * category in a list of changes and reads as though the app added something called "Added".
 * The parser knows which it saw; the client should not have to guess from the text.
 */
export interface ReleaseItem {
  text: string;
  /** True for a `###` group label rather than a bullet or paragraph. */
  heading?: true;
}

/** One release section: its heading text and the paragraphs/bullets under it. */
export interface Release {
  /** The heading exactly as written — "Unreleased", "0.2.0", "0.1.0 (withdrawn)". */
  version: string;
  /** Each bullet, paragraph or group label, in file order, with inline markdown intact. */
  items: ReleaseItem[];
}

/**
 * Pull `## <version>` sections and their contents out of the changelog.
 *
 * Deliberately not a Markdown library: the format is the handful of constructs our own
 * CHANGELOG.md uses, and a dependency here would be a dependency in the image.
 *
 * The rule that actually matters: a non-bullet line CONTINUES the bullet above it only when no
 * blank line separates them; after a blank line it is a paragraph of its own. Getting that
 * wrong in either direction is how content disappears — dropping such lines loses them
 * outright, and blindly appending them welds a standalone paragraph onto an unrelated
 * sentence.
 */
export function parseChangelog(md: string): Release[] {
  const releases: Release[] = [];
  let current: Release | null = null;
  // Whether the previous non-blank line can still be continued (no blank line since).
  let openItem = false;

  for (const raw of String(md ?? '').split(/\r?\n/)) {
    const line = raw.trim();

    if (!line) {
      openItem = false; // a blank line ends the current bullet/paragraph
      continue;
    }

    const head = /^##\s+(.+?)\s*$/.exec(line);
    if (head) {
      current = { version: head[1].trim(), items: [] };
      releases.push(current);
      openItem = false;
      continue;
    }

    // Anything above the first `## ` heading — the licence header, the title, the intro —
    // belongs to no release and is not shown.
    if (!current) continue;

    // A deeper heading ("### Added") groups the bullets under it. Kept, and MARKED — see
    // ReleaseItem. `openItem` stays false: a heading is never continued by the next line.
    const sub = /^#{3,}\s+(.+?)\s*$/.exec(line);
    if (sub) {
      current.items.push({ text: sub[1], heading: true });
      openItem = false;
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      current.items.push({ text: bullet[1] });
      openItem = true;
      continue;
    }

    if (openItem) {
      current.items[current.items.length - 1].text += ` ${line}`;
    } else {
      current.items.push({ text: line });
      openItem = true;
    }
  }

  // Drop sections that ended up with nothing to say, rather than rendering an empty heading.
  return releases.filter((r) => r.items.length > 0);
}

/** A section grows by one entry per version, so this is a sanity ceiling rather than a
 *  limit — it stops a corrupted or hostile file being read into memory unbounded. */
const MAX_BYTES = 256 * 1024;

/**
 * Where CHANGELOG.md sits, depending on how the app is running. Checked in order.
 *
 * The two layouts that actually occur:
 *   • from the repo (tsx) — `__dirname` is `server/src`, so the repo root is two up.
 *   • from the image — tsconfig has rootDir `src` / outDir `dist`, so the entrypoint is
 *     `/app/dist/index.js` and `__dirname` is `/app/dist`; the Dockerfile copies the file to
 *     `/app/CHANGELOG.md`, one up.
 */
export function changelogCandidates(dir: string = __dirname): string[] {
  return [
    path.resolve(dir, '..', '..', 'CHANGELOG.md'), // server/src → repo root (tsx)
    path.resolve(dir, '..', 'CHANGELOG.md'), // /app/dist → /app (the image)
    path.resolve(process.cwd(), 'CHANGELOG.md'),
  ];
}

/** Read the shipped changelog. Returns '' when the image was built without one — a missing
 *  file is a cosmetic gap in one menu item, never a reason to fail a request. */
export function readChangelog(candidates: string[] = changelogCandidates()): string {
  for (const p of candidates) {
    try {
      return fs.readFileSync(p, 'utf8').slice(0, MAX_BYTES);
    } catch {
      // try the next location
    }
  }
  return '';
}
