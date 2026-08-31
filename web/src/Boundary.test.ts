// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * What the crash screen is allowed to say.
 *
 * The boundary itself needs a DOM to render and the web suite has none, so what is pinned here
 * is the part that can be got wrong without a browser: turning an unknown thrown value into a
 * string. `crashDetail` runs at the exact moment the app is already broken, which is the worst
 * possible time for it to throw a second error of its own.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { crashDetail, crashMessage } from './Boundary';

test('the reader is told the same plain thing whatever threw', () => {
  // Not "TypeError: undefined is not a function". A musalli cannot act on that, and the page
  // it replaced was a prayer timetable.
  assert.equal(crashMessage(), 'This page could not be drawn.');
});

test('ANYTHING can be thrown, and none of it may throw again', () => {
  // JavaScript lets you throw any value at all, and a crash handler that assumes it was handed
  // an Error turns one broken page into an unrecoverable one.
  const thrown: unknown[] = [
    new Error('boom'),
    new TypeError('nope'),
    'a bare string',
    42,
    null,
    undefined,
    { message: { not: 'a string' } },
    [1, 2, 3],
    Symbol('s'),
    123n,
  ];
  for (const value of thrown) {
    assert.doesNotThrow(() => crashDetail(value), `crashDetail threw on ${String(value)}`);
    assert.equal(typeof crashDetail(value), 'string');
  }
});

test('a real Error keeps its stack, because that is the whole point of the expander', () => {
  const e = new Error('the timetable had no days');
  assert.match(crashDetail(e), /the timetable had no days/);
});

test('a circular object does not defeat it', () => {
  // JSON.stringify throws on a cycle. React state can easily hold one.
  const cyclic: Record<string, unknown> = { name: 'loop' };
  cyclic.self = cyclic;
  assert.doesNotThrow(() => crashDetail(cyclic));
  assert.equal(typeof crashDetail(cyclic), 'string');
});
