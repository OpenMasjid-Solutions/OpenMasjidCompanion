// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The sky is only a background — but the way it works out what time it is, is the way every
 * time in this app is going to work out what time it is.
 *
 * So the timezone handling gets tested here properly, before the countdown and the push
 * scheduler are built on the same idea. CLAUDE.md §7 and §14 make this non-negotiable: date +
 * "HH:mm" + an IANA zone, resolved with a real timezone implementation, never the device's
 * zone and never a hand-rolled offset. An offset computed by hand is wrong twice a year in
 * most of the world, and permanently wrong in the places that do not do DST the way you
 * assumed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { CLOCK_BOUNDARIES, minutesOfDay, skyPhase, skyPhaseAt, type SkyBoundaries } from './sky';

const at = (h: number, m = 0) => h * 60 + m;

// ── Phases ────────────────────────────────────────────────────────────────────

test('each phase covers the part of the day it is named for', () => {
  assert.equal(skyPhase(at(0, 30)), 'night');
  assert.equal(skyPhase(at(4, 59)), 'night');
  assert.equal(skyPhase(at(5, 0)), 'dawn', 'the boundary belongs to the phase it opens');
  assert.equal(skyPhase(at(6, 59)), 'dawn');
  assert.equal(skyPhase(at(7, 0)), 'morning');
  assert.equal(skyPhase(at(9, 59)), 'morning');
  assert.equal(skyPhase(at(10, 0)), 'day', 'morning runs three hours from sunrise');
  assert.equal(skyPhase(at(16, 29)), 'day');
  assert.equal(skyPhase(at(16, 30)), 'dusk');
  assert.equal(skyPhase(at(18, 59)), 'dusk');
  assert.equal(skyPhase(at(19, 0)), 'night');
  assert.equal(skyPhase(at(23, 59)), 'night');
});

test('the day wraps rather than falling off either end', () => {
  // A clock that has been nudged, or arithmetic that produced a negative, must still land on
  // a real phase — this value becomes an attribute selector, and an undefined one would drop
  // the background to nothing.
  assert.equal(skyPhase(at(24, 0)), skyPhase(0), 'midnight tomorrow is midnight');
  assert.equal(skyPhase(-30), skyPhase(at(23, 30)));
  assert.equal(skyPhase(at(48, 30)), skyPhase(at(0, 30)));
});

test('custom boundaries drive the phases, which is how the timetable will take over', () => {
  // Once a masjid has picked a timetable, the sky turns over at the actual Fajr, Shurūq and
  // Maghrib for that day rather than at round clock hours. This is that path.
  const ramadanish: SkyBoundaries = { dawn: at(3, 40), sunrise: at(5, 10), dusk: at(17, 0), night: at(20, 45) };
  assert.equal(skyPhase(at(3, 0), ramadanish), 'night');
  assert.equal(skyPhase(at(4, 0), ramadanish), 'dawn', 'still dark at 4am by the clock, but Fajr has come in');
  assert.equal(skyPhase(at(20, 0), ramadanish), 'dusk', 'and it is still dusk at 8pm');
  assert.equal(skyPhase(at(21, 0), ramadanish), 'night');
});

test('the fallback boundaries are ordered and inside one day', () => {
  // A mis-ordered set would silently make a phase unreachable rather than fail.
  const b = CLOCK_BOUNDARIES;
  assert.ok(0 < b.dawn && b.dawn < b.sunrise && b.sunrise < b.dusk && b.dusk < b.night && b.night < 1440);
});

// ── Timezones ─────────────────────────────────────────────────────────────────

test('the masjid’s timezone decides the time of day, not the device’s', () => {
  // The failure: a musalli travelling, or a phone left on the wrong zone, makes the MASJID's
  // page claim it is the middle of the night.
  const noonUtc = new Date('2026-06-15T12:00:00Z');
  assert.equal(minutesOfDay(noonUtc, 'UTC'), at(12, 0));
  assert.equal(minutesOfDay(noonUtc, 'America/New_York'), at(8, 0), 'EDT is UTC-4 in June');
  assert.equal(minutesOfDay(noonUtc, 'Asia/Riyadh'), at(15, 0));
  assert.equal(minutesOfDay(noonUtc, 'Australia/Sydney'), at(22, 0));
});

test('half-hour and quarter-hour zones are handled, because minutes are not optional', () => {
  // Any code that stores an offset in whole hours gets these wrong, and a large number of
  // masjids are in them.
  const t = new Date('2026-06-15T12:00:00Z');
  assert.equal(minutesOfDay(t, 'Asia/Kolkata'), at(17, 30), 'UTC+5:30');
  assert.equal(minutesOfDay(t, 'Asia/Kathmandu'), at(17, 45), 'UTC+5:45');
});

test('DST: the same zone gives different local times either side of the change', () => {
  // US clocks go forward at 2am local on 2026-03-08. A hand-rolled offset gets one of these
  // two wrong, and would put every prayer time an hour out for everybody who installed the
  // app — silently, and only for part of the year.
  const beforeChange = new Date('2026-03-08T06:30:00Z');
  const afterChange = new Date('2026-03-08T08:30:00Z');
  assert.equal(minutesOfDay(beforeChange, 'America/New_York'), at(1, 30), 'EST, UTC-5');
  assert.equal(minutesOfDay(afterChange, 'America/New_York'), at(4, 30), 'EDT, UTC-4 — the clock jumped');
});

test('DST in the other direction, in a zone whose change is on a different date', () => {
  // The UK changes on the last Sunday in March, three weeks after the US — so a zone offset
  // cached from "the last time we looked" is wrong for that whole window.
  assert.equal(minutesOfDay(new Date('2026-03-15T12:00:00Z'), 'Europe/London'), at(12, 0), 'still GMT');
  assert.equal(minutesOfDay(new Date('2026-04-15T12:00:00Z'), 'Europe/London'), at(13, 0), 'BST');
});

test('a zone that does not observe DST is not "corrected" into observing it', () => {
  const t = (iso: string) => minutesOfDay(new Date(iso), 'Asia/Riyadh');
  assert.equal(t('2026-01-15T12:00:00Z'), at(15, 0));
  assert.equal(t('2026-07-15T12:00:00Z'), at(15, 0), 'UTC+3 all year');
});

test('an unknown or missing zone falls back to the device rather than throwing', () => {
  // A background is never worth taking the page down for. This runs before a timetable has
  // been picked, when there genuinely is no masjid zone to use.
  const t = new Date('2026-06-15T12:00:00Z');
  const device = t.getHours() * 60 + t.getMinutes();
  assert.equal(minutesOfDay(t, undefined), device);
  assert.equal(minutesOfDay(t, ''), device);
  assert.equal(minutesOfDay(t, 'Not/AZone'), device);
  assert.equal(minutesOfDay(t, 'nonsense'), device);
});

test('skyPhaseAt puts the two halves together', () => {
  const t = new Date('2026-06-15T12:00:00Z');
  assert.equal(skyPhaseAt(t, 'Asia/Riyadh'), 'day', '3pm');
  assert.equal(skyPhaseAt(t, 'Australia/Sydney'), 'night', '10pm the same instant');
  assert.equal(skyPhaseAt(t, 'UTC', { dawn: at(11), sunrise: at(11, 30), dusk: at(13), night: at(14) }), 'morning');
});
