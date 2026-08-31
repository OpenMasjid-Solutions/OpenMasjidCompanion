// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * A changelog parser is not hypothetical code to get wrong. OpenMasjid Students shipped a
 * "What's new" that rendered only bullet lines, so every plain paragraph in its release notes
 * was silently dropped — the notes looked fine in the repo and were missing in the panel, which
 * is the worst shape a bug like this can take.
 *
 * So this tests the awkward shapes explicitly, and then runs the parser against THIS repo's
 * real CHANGELOG.md — because the format the parser has to handle is whatever we actually
 * write, not whatever the fixtures happen to say.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { changelogCandidates, parseChangelog, readChangelog } from './changelog';

test('sections are split on "## " headings, newest first, in file order', () => {
  const md = ['# Changelog', '', '## Unreleased', '- a thing', '', '## 0.1.0', '- the first thing'].join('\n');
  assert.deepEqual(parseChangelog(md), [
    { version: 'Unreleased', items: [{ text: 'a thing' }] },
    { version: '0.1.0', items: [{ text: 'the first thing' }] },
  ]);
});

test('everything above the first heading belongs to no release and is dropped', () => {
  // The licence header, the title and the intro paragraph are not release notes.
  const md = [
    '<!-- SPDX-License-Identifier: AGPL-3.0-only -->',
    '# Changelog',
    'Release notes, newest first.',
    '',
    '## 0.1.0',
    '- shipped',
  ].join('\n');
  assert.deepEqual(parseChangelog(md), [{ version: '0.1.0', items: [{ text: 'shipped' }] }]);
});

test('a wrapped bullet is ONE item — a continuation line is not a new bullet', () => {
  // This is the rule that matters. Dropping the continuation loses the text; making it its own
  // item breaks a sentence in half in the middle of a word.
  const md = ['## 0.1.0', '- a bullet that runs on', '  across two lines', '- a second bullet'].join('\n');
  assert.deepEqual(parseChangelog(md), [
    { version: '0.1.0', items: [{ text: 'a bullet that runs on across two lines' }, { text: 'a second bullet' }] },
  ]);
});

test('a blank line ENDS a bullet, so the next line is a paragraph of its own', () => {
  // The other half of the same rule, and the direction that welds unrelated sentences together
  // if you get it wrong.
  const md = ['## 0.1.0', '- a bullet', '', 'A standalone paragraph.', '', '- another bullet'].join('\n');
  assert.deepEqual(parseChangelog(md), [
    { version: '0.1.0', items: [{ text: 'a bullet' }, { text: 'A standalone paragraph.' }, { text: 'another bullet' }] },
  ]);
});

test('a plain paragraph with no bullets at all is still shown', () => {
  // The Students bug: a section written as prose rendered as nothing.
  const md = ['## 0.1.0', 'We rewrote the thing. Nothing you set up needs redoing.'].join('\n');
  assert.deepEqual(parseChangelog(md), [
    { version: '0.1.0', items: [{ text: 'We rewrote the thing. Nothing you set up needs redoing.' }] },
  ]);
});

test('a "### Added" subheading is kept AND marked as a heading, not flattened into a bullet', () => {
  // Rendering "Added" as a bullet puts a category into the list of changes and reads as though
  // the app added something called "Added". The parser knows which it saw, so it says so.
  const md = ['## Unreleased', '', '### Added', '- a thing', '', '### Fixed', '- a fix'].join('\n');
  assert.deepEqual(parseChangelog(md), [
    {
      version: 'Unreleased',
      items: [{ text: 'Added', heading: true }, { text: 'a thing' }, { text: 'Fixed', heading: true }, { text: 'a fix' }],
    },
  ]);
});

test('a heading is never continued by the line after it', () => {
  // A heading is a label, not a sentence with a wrap. Appending the next line to it would
  // produce "Added A paragraph…" as one run-on group label.
  const md = ['## Unreleased', '### Added', 'A paragraph directly under the heading.'].join('\n');
  assert.deepEqual(parseChangelog(md), [
    { version: 'Unreleased', items: [{ text: 'Added', heading: true }, { text: 'A paragraph directly under the heading.' }] },
  ]);
});

test('both bullet markers work, and inline markdown is left intact for the client to format', () => {
  const md = ['## 0.1.0', '* starred bullet', '- **bold** and `code` survive'].join('\n');
  assert.deepEqual(parseChangelog(md)[0].items, [{ text: 'starred bullet' }, { text: '**bold** and `code` survive' }]);
});

test('an empty section is dropped rather than rendered as a bare heading', () => {
  const md = ['## Unreleased', '', '## 0.1.0', '- something'].join('\n');
  assert.deepEqual(parseChangelog(md), [{ version: '0.1.0', items: [{ text: 'something' }] }]);
});

test('junk input degrades to nothing rather than throwing', () => {
  // This feeds an endpoint. A malformed or missing file is a cosmetic gap in one menu item,
  // never a 500.
  for (const input of ['', '   ', '#', '##', undefined, null, 123]) {
    assert.deepEqual(parseChangelog(input as never), []);
  }
});

test('CRLF line endings parse the same as LF', () => {
  const md = '## 0.1.0\r\n- a bullet\r\n  continued\r\n';
  assert.deepEqual(parseChangelog(md), [{ version: '0.1.0', items: [{ text: 'a bullet continued' }] }]);
});

test('the candidate paths cover both ways this app actually runs', () => {
  // From the repo under tsx, __dirname is server/src → the repo root is two up.
  // In the image the entrypoint is /app/dist/index.js → CHANGELOG.md is one up at /app.
  const fromRepo = changelogCandidates('/repo/server/src');
  assert.ok(fromRepo.includes(path.resolve('/repo/CHANGELOG.md')), 'repo layout (tsx)');
  const fromImage = changelogCandidates('/app/dist');
  assert.ok(fromImage.includes(path.resolve('/app/CHANGELOG.md')), 'image layout');
});

test('a missing file reads as empty rather than throwing', () => {
  assert.equal(readChangelog(['/definitely/not/here/CHANGELOG.md']), '');
});

test('THIS repo\'s real CHANGELOG.md parses into something worth showing an admin', () => {
  // The parser only has to handle the format we actually write, so the real file is the
  // authoritative fixture — and this fails the moment someone writes a section shape it
  // silently drops.
  const md = readChangelog();
  assert.ok(md.length > 0, 'the changelog should be findable from the test run');
  const releases: { version: string; items: { text: string; heading?: true }[] }[] = parseChangelog(md);
  assert.ok(releases.length > 0, 'at least one section');
  /**
   * Which section is at the top depends on the branch, and the assertion has to say so.
   *
   * It used to be a bare `=== 'Unreleased'`, which meant this test could only ever pass on dev:
   * cutting a release turns `## Unreleased` into `## X.Y.Z`, so the release chain would fail
   * here, on main, for a reason with nothing to do with the release.
   *
   * There are three legitimate states and only one of them is worth asserting hard:
   *
   *  - **A stable build MUST ship its own notes.** If this build calls itself 0.1.0, the newest
   *    section has to be 0.1.0 — otherwise the panel's "What's new" describes a different build
   *    to somebody deciding whether to update, which is the one thing this file exists to get
   *    right.
   *  - On dev with work in progress, the top is `Unreleased`.
   *  - On dev immediately after a release, `Unreleased` has been re-opened EMPTY and the parser
   *    drops it (by design — an empty section is not a change), so the top is the release that
   *    was just cut, one version behind the prerelease this build now calls itself. That is
   *    correct and must not fail.
   */
  const top = releases[0].version;
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')) as { version: string };
  if (!pkg.version.includes('-dev.')) {
    assert.equal(top, pkg.version, `this build is ${pkg.version} but the newest section is "${top}" — an admin would read the wrong release notes`);
  } else {
    assert.ok(
      top === 'Unreleased' || /^\d+\.\d+\.\d+$/.test(top),
      `on a prerelease the top section should be the working log or the last release, got "${top}"`,
    );
  }

  for (const r of releases) {
    assert.ok(r.items.length > 0, `"${r.version}" parsed to no items`);
    for (const item of r.items) {
      assert.equal(typeof item.text, 'string');
      assert.ok(item.text.trim().length > 0, `"${r.version}" has an empty item`);
    }
    // Our own sections group their bullets under "### Added" / "### Fixed", and those must
    // arrive marked — otherwise the panel renders the group label as a change.
    for (const item of r.items) {
      if (/^(Added|Fixed|Changed|Removed|Security)$/.test(item.text)) {
        assert.equal(item.heading, true, `"${item.text}" in "${r.version}" should be marked as a heading`);
      }
    }
  }
  // Nothing in the file should be lost: every bullet in the source turns into an item.
  const bulletsInFile = md.split(/\r?\n/).filter((l) => /^\s*[-*]\s+\S/.test(l) && !l.trim().startsWith('<!--')).length;
  const items = releases.reduce((n, r) => n + r.items.length, 0);
  assert.ok(items >= bulletsInFile, `parsed ${items} items but the file has ${bulletsInFile} bullets — content was dropped`);
});

test('the changelog file this build would ship is the repo\'s own', () => {
  const found = changelogCandidates().find((p) => fs.existsSync(p));
  assert.ok(found, 'a candidate path resolves during a test run');
  assert.match(fs.readFileSync(found!, 'utf8'), /# Changelog/);
});
