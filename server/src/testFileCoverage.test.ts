// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * `npm test` names every test file explicitly rather than globbing, and that is a trap
 * with no warning attached: add a `*.test.ts` and forget the list, and you get a file
 * that passes when you run it by hand and never runs in CI again.
 *
 * A silent gap in the safety net is worse than no safety net, because it is trusted. So
 * the list is checked against the tree, here, by the very run it is a list for. (Copied
 * from OpenMasjidDisplay, where two files had already slipped through the gap — one of
 * them covering a shipped bug — before anyone noticed.)
 *
 * If this fails: add the named file to the `test` script in server/package.json.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const SERVER_DIR = path.resolve(__dirname, '..');

/** Every *.test.ts under src/, as repo-relative POSIX paths — the form the script uses. */
function testFilesOnDisk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...testFilesOnDisk(full));
    } else if (entry.name.endsWith('.test.ts')) {
      out.push(path.relative(SERVER_DIR, full).split(path.sep).join('/'));
    }
  }
  return out;
}

function testScript(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, 'package.json'), 'utf8')) as { scripts: { test: string } };
  return pkg.scripts.test;
}

test('every test file on disk is one npm test actually runs', () => {
  // Split on whitespace so a path can never match as a substring of a longer one.
  const listed = new Set(testScript().split(/\s+/));
  const missing = testFilesOnDisk(path.join(SERVER_DIR, 'src')).filter((f) => !listed.has(f));
  assert.deepEqual(
    missing,
    [],
    `these test files exist but npm test never runs them — add them to the "test" script in ` +
      `server/package.json:\n  ${missing.join('\n  ')}`,
  );
});

test('the test script does not name a file that no longer exists', () => {
  // The other direction of the same drift. Node's test runner treats a missing file as
  // an error rather than skipping it, so this would break the whole suite, not one case.
  const named = testScript()
    .split(/\s+/)
    .filter((t) => t.endsWith('.test.ts'));
  const gone = named.filter((f) => !fs.existsSync(path.join(SERVER_DIR, f)));
  assert.deepEqual(gone, [], `the test script names files that do not exist: ${gone.join(', ')}`);
});
