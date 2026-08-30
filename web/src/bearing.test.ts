// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The Qibla bearing, against places whose direction is published and agreed.
 *
 * This is the one part of the Qibla screen that cannot be checked by holding the phone up. A
 * compass pointing at the car park is self-evidently wrong; a bearing that is 40° out because
 * the great circle was confused with a straight line on a flat map looks perfectly reasonable
 * and is wrong for every masjid in North America.
 *
 * So the numbers here come from outside: each one is the figure the well-known Qibla references
 * give for that city, to a tenth of a degree. If a change to this file's maths moves any of
 * them, it is the maths that is wrong.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALIGNED_DEG,
  angleDelta,
  compassPoint,
  distanceToKaaba,
  headingFrom,
  isAligned,
  norm360,
  qiblaBearing,
} from './bearing';

/** Published Qibla directions, in degrees clockwise from true north. */
const PLACES: [string, number, number, number][] = [
  ['London', 51.5074, -0.1278, 119.0],
  ['New York', 40.7128, -74.006, 58.5],
  ['Toronto', 43.6532, -79.3832, 54.6],
  ['Jakarta', -6.2088, 106.8456, 295.2],
  ['Cape Town', -33.9249, 18.4241, 23.4],
  ['Cairo', 30.0444, 31.2357, 136.1],
  ['Sydney', -33.8688, 151.2093, 277.5],
  ['Tokyo', 35.6762, 139.6503, 293.0],
  ['Karachi', 24.8607, 67.0011, 267.7],
  ['Istanbul', 41.0082, 28.9784, 151.6],
];

test('THE PUBLISHED DIRECTION FOR TEN CITIES, TO A TENTH OF A DEGREE', () => {
  for (const [name, lat, lon, want] of PLACES) {
    const got = qiblaBearing(lat, lon);
    assert.ok(got !== null, `${name} has no bearing`);
    assert.ok(Math.abs(angleDelta(got!, want)) < 0.15, `${name}: expected ~${want}°, got ${got!.toFixed(2)}°`);
  }
});

test('A GREAT CIRCLE, NOT A LINE ON A FLAT MAP', () => {
  // The difference is the whole reason this is not two subtractions. From New York the naive
  // "rhumb line" bearing to Makkah is a little south of east; the great circle leaves at 58°,
  // north of east, which is the one that is right and the one that surprises people.
  const ny = qiblaBearing(40.7128, -74.006)!;
  assert.ok(ny > 45 && ny < 70, `got ${ny}`);
  // A flat-map bearing would be atan2(Δlon, Δlat) ≈ 96°, comfortably south of east. If this
  // assertion ever fails, somebody has replaced the maths with the intuitive version.
  const flat = norm360((Math.atan2(39.8262 - -74.006, 21.4225 - 40.7128) * 180) / Math.PI);
  assert.ok(Math.abs(angleDelta(ny, flat)) > 30, 'the two must not agree, or the great circle has been lost');
});

test('the degenerate positions have no answer, rather than a wrong one', () => {
  // Both make atan2(0, 0) return 0, which would confidently claim "due north".
  assert.equal(qiblaBearing(21.4225, 39.8262), null, 'standing on the Kaaba');
  assert.equal(qiblaBearing(-21.4225, -140.1738), null, 'its exact antipode');
  assert.equal(qiblaBearing(Number.NaN, 0), null);
  assert.equal(qiblaBearing(0, Number.POSITIVE_INFINITY), null);
});

test('on the Kaaba’s own meridian the answer is due north or due south', () => {
  // The cases where the arithmetic degenerates to a sign, and where an error would be a clean
  // 180° rather than a few degrees — invisible in a spot check of a city.
  assert.equal(Math.round(qiblaBearing(50, 39.8262)!), 180, 'north of Makkah, so face south');
  assert.equal(Math.round(qiblaBearing(0, 39.8262)!), 0, 'south of Makkah, so face north');
});

test('the distance is a sanity check somebody can actually perform', () => {
  assert.ok(Math.abs(distanceToKaaba(51.5074, -0.1278) - 4794) < 15, 'London');
  assert.ok(Math.abs(distanceToKaaba(30.0444, 31.2357) - 1287) < 15, 'Cairo');
  assert.equal(Math.round(distanceToKaaba(21.4225, 39.8262)), 0, 'at the Kaaba');
});

// ── Angles ───────────────────────────────────────────────────────────────────

test('angles fold into [0, 360), including negative ones', () => {
  // `%` on a negative gives a negative in JavaScript, which is the bug this exists to prevent:
  // a heading of −5° would rotate the dial the wrong way by 355°.
  assert.equal(norm360(0), 0);
  assert.equal(norm360(360), 0);
  assert.equal(norm360(-5), 355);
  assert.equal(norm360(-370), 350);
  assert.equal(norm360(725), 5);
});

test('THE SHORTEST WAY ROUND, ACROSS NORTH', () => {
  // 359° and 1° are two degrees apart. Anything that subtracts them gets 358 and sends the
  // reader — and the dial's smoothing — the long way round.
  assert.equal(angleDelta(359, 1), 2, 'clockwise, over north');
  assert.equal(angleDelta(1, 359), -2, 'and anticlockwise back');
  assert.equal(angleDelta(0, 90), 90);
  assert.equal(angleDelta(90, 0), -90);
  assert.equal(angleDelta(0, 180), 180, 'exactly opposite resolves clockwise');
  assert.equal(angleDelta(180, 0), 180);
});

test('"turn left" and "turn right" are the sign of that difference', () => {
  // Facing 100°, the Qibla at 119°: a small turn to the RIGHT. Getting this backwards is the
  // most embarrassing possible bug in this feature and the cheapest to prevent.
  assert.ok(angleDelta(100, 119) > 0, 'right');
  assert.ok(angleDelta(140, 119) < 0, 'left');
  // And across north, where the intuition fails: facing 350°, the Qibla at 10° is to the right.
  assert.ok(angleDelta(350, 10) > 0, 'right, over north');
});

test('alignment is symmetric and wraps', () => {
  assert.equal(isAligned(119, 119), true);
  assert.equal(isAligned(119 + ALIGNED_DEG - 0.5, 119), true);
  assert.equal(isAligned(119 + ALIGNED_DEG + 0.5, 119), false);
  assert.equal(isAligned(358, 2), true, 'either side of north still counts');
});

test('the compass points name the bearing, and 360 is north again', () => {
  assert.equal(compassPoint(0), 'north');
  assert.equal(compassPoint(360), 'north');
  assert.equal(compassPoint(359), 'north', 'a degree short of north is still north');
  assert.equal(compassPoint(90), 'east');
  assert.equal(compassPoint(119), 'east-southeast');
  assert.equal(compassPoint(295), 'west-northwest');
  assert.equal(compassPoint(-45), 'northwest', 'a negative angle is folded first');
});

// ── Reading the magnetometer ─────────────────────────────────────────────────

test('iOS gives a true heading; everything else gives it backwards', () => {
  // `alpha` turns anticlockwise from north and a compass heading turns clockwise, so one of
  // these two is subtracted and the other is not. Swapping them produces a dial that turns the
  // right amount in the wrong direction, which reads as "the compass is a bit laggy".
  assert.equal(headingFrom({ alpha: null, webkitCompassHeading: 90 }), 90);
  assert.equal(headingFrom({ alpha: 90, absolute: true }), 270);
  assert.equal(headingFrom({ alpha: 0, absolute: true }), 0);
  assert.equal(headingFrom({ alpha: 270, absolute: true }), 90);
});

test('A NON-ABSOLUTE READING IS REFUSED, and that is the whole difference', () => {
  // Without `absolute`, alpha is measured from wherever the phone happened to be pointing when
  // the page loaded. An arrow built on it turns correctly as the phone turns and points
  // somewhere meaningless — the worst failure this screen can have, because it looks right.
  assert.equal(headingFrom({ alpha: 90 }), null);
  assert.equal(headingFrom({ alpha: 90, absolute: false }), null);
  assert.equal(headingFrom({ alpha: null, absolute: true }), null);
  assert.equal(headingFrom({ alpha: Number.NaN, absolute: true }), null);
});

test('an uncalibrated magnetometer is no reading, not a reading of zero', () => {
  // Apple reports -1 for "needs calibrating". Taken as a number it would point the arrow due
  // north and say nothing; the screen can ask for a figure-of-eight instead.
  assert.equal(headingFrom({ alpha: null, webkitCompassHeading: 200, webkitCompassAccuracy: -1 }), null);
  assert.equal(headingFrom({ alpha: null, webkitCompassHeading: 200, webkitCompassAccuracy: 15 }), 200);
});

test('a rotated screen shifts the heading, and portrait shifts it by nothing', () => {
  // Portrait is 0, which is how the app installs (`orientation: portrait`) and the case that is
  // certainly right — the correction cannot make it worse.
  assert.equal(headingFrom({ alpha: null, webkitCompassHeading: 100 }, 0), 100);
  assert.equal(headingFrom({ alpha: null, webkitCompassHeading: 100 }, 90), 190);
  assert.equal(headingFrom({ alpha: null, webkitCompassHeading: 350 }, 90), 80, 'and it wraps');
});
