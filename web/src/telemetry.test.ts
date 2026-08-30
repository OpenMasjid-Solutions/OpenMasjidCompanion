// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * When a browser gets counted, and when it does not.
 *
 * The whole of the client half is one comparison — "is the stored signature the same as this
 * one" — and getting it wrong in either direction is invisible on any screen. Too eager and
 * every reload becomes a person, so a masjid reads five regulars as a hundred and fifty. Too
 * lazy and installing the app never shows up at all, which is the single number the poster was
 * printed for.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldReport, signature, today, type Visit } from './telemetry';

const v = (over: Partial<Visit> = {}): Visit => ({ device: 'ios', browser: 'safari', mode: 'browser', ...over });

test('the same browser on the same day is counted ONCE', () => {
  const sig = signature('2026-08-29', v());
  assert.equal(shouldReport(null, sig), true, 'never seen before');
  assert.equal(shouldReport(sig, sig), false, 'a reload is not a person');
});

test('a new day is a new count', () => {
  assert.equal(shouldReport(signature('2026-08-28', v()), signature('2026-08-29', v())), true);
});

test('INSTALLING THE APP IS COUNTED, on the same day', () => {
  // The mode is in the signature deliberately. Somebody who scans the poster at lunchtime and
  // adds it to their home screen an hour later should appear in both columns that day — that
  // transition is the answer to "did the noticeboard work?", and a plain once-a-day check would
  // swallow the half that matters.
  const inBrowser = signature('2026-08-29', v({ mode: 'browser' }));
  const installed = signature('2026-08-29', v({ mode: 'standalone' }));
  assert.notEqual(inBrowser, installed);
  assert.equal(shouldReport(inBrowser, installed), true);
});

test('the signature carries nothing but the four values', () => {
  // If anything else ever ends up in here it also ends up in localStorage under a key named
  // "seen", which is the shape of the visitor record this app is built not to have.
  assert.equal(signature('2026-08-29', v({ device: 'android', browser: 'chrome' })), '2026-08-29|android|chrome|browser');
});

test('the day stamp is the phone’s own calendar date, not a UTC one', () => {
  // A device clock is untrustworthy for a prayer time (CLAUDE.md §7) and perfectly adequate for
  // "have I already counted this browser today". Local, because somebody in Auckland opening the
  // app after Isha should not be counted against yesterday.
  assert.equal(today(new Date(2026, 0, 5, 23, 30)), '2026-01-05');
  assert.equal(today(new Date(2026, 11, 31, 0, 5)), '2026-12-31');
  assert.match(today(), /^\d{4}-\d{2}-\d{2}$/);
});
