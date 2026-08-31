// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The day arc's geometry.
 *
 * Every constant in it was tuned by eye against a description, which is exactly the kind of
 * thing that drifts back the moment somebody "tidies" it. These are the properties Hasan asked
 * for, written down: a curve that starts low, gathers pace, keeps curving into a rounded crest,
 * never flattens at the top, and comes down the far side more gently than it went up.
 *
 * The measurements are on the FUNCTION rather than on the rendered SVG, because the drawn path
 * is a polyline sampled from it — finite differences taken across a chord measure the facet,
 * not the shape. That the polyline follows the function is checked separately, below.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ARC_BAND, ARC_D, curve, pointAtFraction } from './Today';

const { W, H } = ARC_BAND;

/** How far below the crest the curve is at a given fraction of the width, as a fraction of the
 *  band. 0 at the summit, 1 at the horizons. */
const apex = (() => {
  let best = { u: 0, y: Infinity };
  for (let i = 0; i <= 20000; i += 1) {
    const u = i / 20000;
    const y = curve(u).y;
    if (y < best.y) best = { u, y };
  }
  return best;
})();
const down = (u: number) => (curve(u).y - apex.y) / H;

/** Curvature of the curve at a fraction of the width, in real units. */
function curvature(u: number): number {
  const h = 1e-4;
  const y1 = (curve(u + h).y - curve(u - h).y) / (2 * h * W);
  const y2 = (curve(u + h).y - 2 * curve(u).y + curve(u - h).y) / (h * W) ** 2;
  return Math.abs(y2) / (1 + y1 ** 2) ** 1.5;
}

test('the arc touches the horizon at both ends and peaks in between', () => {
  assert.equal(curve(0).y, H);
  assert.ok(Math.abs(curve(1).y - H) < 0.001);
  assert.equal(curve(0).x, 0);
  assert.equal(curve(1).x, W);
  assert.ok(apex.y < 0.001, 'the summit reaches the top of the band');
});

test('THE SUMMIT IS LEFT OF CENTRE, which is what makes the descent the longer half', () => {
  assert.ok(apex.u > 0.40 && apex.u < 0.47, `summit at ${apex.u.toFixed(3)}`);
});

test('it climbs, then falls — no wobble either side', () => {
  // A wiggle would be a "visible break" of exactly the kind the shape is meant to avoid.
  for (let u = 0.002; u < apex.u - 0.01; u += 0.002) {
    assert.ok(curve(u + 0.002).y <= curve(u).y + 1e-9, `not monotone climbing at ${u.toFixed(3)}`);
  }
  for (let u = apex.u + 0.01; u < 0.998; u += 0.002) {
    assert.ok(curve(u + 0.002).y >= curve(u).y - 1e-9, `not monotone falling at ${u.toFixed(3)}`);
  }
});

test('THE CREST NEVER GOES FLAT — it keeps curving through the top', () => {
  // The fault this shape replaced: two joined cubics whose curvature VARIED 4.59x across the
  // crest and STEPPED 78% at the summit itself. A curve that goes slack either side of its own
  // peak reads as a table top however smooth its tangents are.
  let min = Infinity;
  let max = 0;
  for (let u = apex.u - 0.12; u <= apex.u + 0.12; u += 0.002) {
    const k = curvature(u);
    min = Math.min(min, k);
    max = Math.max(max, k);
  }
  assert.ok(min > 0, 'there is a straight run beside the crest');
  assert.ok(max / min < 2.4, `curvature varies ${(max / min).toFixed(2)}x across the crest`);
  // And no step at the summit: one analytic function, so there is nothing to step.
  const l = curvature(apex.u - 0.005);
  const r = curvature(apex.u + 0.005);
  assert.ok(Math.abs(l - r) / Math.max(l, r) < 0.05, 'a curvature step at the apex is a visible break');
});

test('THE DESCENT IS THE GENTLER HALF', () => {
  for (const d of [0.1, 0.2, 0.3]) {
    const climbed = down(Math.max(0, apex.u - d));
    const fallen = down(Math.min(1, apex.u + d));
    assert.ok(fallen < climbed, `at ${d} either side: climb ${climbed.toFixed(3)}, descent ${fallen.toFixed(3)}`);
  }
});

test('it starts low and gathers pace rather than leaping off the horizon', () => {
  const slope = (u: number) => (curve(u + 1e-4).y - curve(u - 1e-4).y) / (2e-4 * W);
  assert.ok(Math.abs(slope(0.01)) < 0.6, `leaves the left horizon at slope ${slope(0.01).toFixed(2)}`);
  // Accelerating: steeper a fifth of the way in than right at the edge.
  assert.ok(Math.abs(slope(0.2)) > Math.abs(slope(0.01)));
});

test('THE DRAWN PATH IS THE FUNCTION, to well under a pixel', () => {
  // The path is a polyline. If it ever drifts from the curve the dots are placed on, the dots
  // stop sitting on the line.
  const pts = ARC_D.split(/[ML]\s*/).slice(1).map((p) => p.trim().split(/\s+/).map(Number));
  assert.ok(pts.length > 100, 'sampled finely enough to be smooth');
  let worst = 0;
  let worstAt = 0;
  for (let i = 1; i < pts.length; i += 1) {
    // The midpoint of each chord against the curve — the sagitta, which is where a chord is
    // furthest from the arc it cuts across.
    const mx = (pts[i - 1][0] + pts[i][0]) / 2;
    const my = (pts[i - 1][1] + pts[i][1]) / 2;
    const off = Math.abs(my - curve(mx / W).y);
    if (off > worst) { worst = off; worstAt = mx / W; }
  }
  // 0.1 viewBox units is 0.12px on a 390px screen. The worst chord is the FIRST one: the curve
  // behaves as H − c·u^1.336 at the left horizon, so its curvature is unbounded right there and
  // no finite sampling follows it exactly. It is two pixels wide under a 2.5-unit round-capped
  // stroke, and checked by eye at 3x zoom.
  assert.ok(worst < 0.1, `a chord departs the curve by ${worst.toFixed(3)} units at u=${worstAt.toFixed(3)}`);
  assert.ok(worstAt < 0.02 || worst < 0.02, `the worst departure moved to u=${worstAt.toFixed(3)} — the sampling no longer follows the curve`);
});

test('everything is placed by LENGTH along the path, not by position across it', () => {
  // The progress stroke uses pathLength=1 with a dasharray, which the browser measures by
  // length. Placing the dots any other way left the marker floating past the end of the line
  // it caps — and length is doubly not position here, since the climb is shorter than the fall.
  assert.deepEqual(pointAtFraction(0), curve(0));
  const end = pointAtFraction(1);
  assert.ok(Math.abs(end.x - W) < 0.01 && Math.abs(end.y - H) < 0.01);

  // Half the LENGTH is past the summit, because the descent is the longer side.
  const half = pointAtFraction(0.5);
  assert.ok(half.x / W > apex.u, `half the length lands at ${(half.x / W).toFixed(3)}, summit at ${apex.u.toFixed(3)}`);

  // Every point it returns is on the curve.
  for (let f = 0; f <= 1; f += 0.02) {
    const p = pointAtFraction(f);
    assert.ok(Math.abs(p.y - curve(p.x / W).y) < 0.05, `off the curve at f=${f.toFixed(2)}`);
  }
});
