/**
 * R-18-02 — opening the window on the right display, at a size that fits.
 *
 * Every case here is a machine somebody has actually used: a 125 % laptop where the work area
 * is smaller than the design minimum, a second monitor to the left with a negative origin, a
 * monitor unplugged between runs, a taskbar that eats the bottom 40 pixels. The window is the
 * one thing a user cannot work around, so the arithmetic is pinned rather than eyeballed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  containsPoint,
  overlapArea,
  chooseDisplay,
  fitToWorkArea,
  placeOnDisplay,
  resolvePlacement,
  isStranded,
  describePlacement
} from '../../src/app/window-placement.js';
import { WINDOW_DEFAULTS } from '../../src/app/ipc-contract.js';

const LIMITS = { minWidth: WINDOW_DEFAULTS.minWidth, minHeight: WINDOW_DEFAULTS.minHeight };
const PREFERRED = { width: WINDOW_DEFAULTS.width, height: WINDOW_DEFAULTS.height };

/** A 1920x1080 monitor with a 40 px taskbar, in device-independent pixels. */
const PRIMARY = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  scaleFactor: 1,
  label: 'Primary'
};

/** The same panel to the left of it, which is where negative coordinates come from. */
const LEFT = {
  id: 2,
  bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
  workArea: { x: -1920, y: 0, width: 1920, height: 1080 },
  scaleFactor: 1.25,
  label: 'Left'
};

/** A 1366x768 laptop at 125 %: 1093x614 DIP, and no room for the design minimum. */
const SMALL = {
  id: 3,
  bounds: { x: 0, y: 0, width: 1093, height: 614 },
  workArea: { x: 0, y: 0, width: 1093, height: 574 },
  scaleFactor: 1.25,
  label: 'Laptop'
};

// ═══ Geometry ══════════════════════════════════════════════════════════════

test('a display contains the point on its own origin', () => {
  assert.equal(containsPoint(LEFT.bounds, { x: -1920, y: 0 }), true);
  assert.equal(containsPoint(LEFT.bounds, { x: -1, y: 1079 }), true);
  assert.equal(containsPoint(LEFT.bounds, { x: 0, y: 0 }), false, 'x=0 belongs to the primary display');
  assert.equal(containsPoint(null, { x: 0, y: 0 }), false);
});

test('overlap is the area two rectangles share, and zero when they do not', () => {
  assert.equal(overlapArea({ x: 0, y: 0, width: 100, height: 100 }, { x: 50, y: 50, width: 100, height: 100 }), 2500);
  assert.equal(overlapArea({ x: 0, y: 0, width: 10, height: 10 }, { x: 100, y: 100, width: 10, height: 10 }), 0);
  assert.equal(overlapArea(null, LEFT.bounds), 0);
});

// ═══ Which display ═════════════════════════════════════════════════════════

test('the window opens on the display under the pointer', () => {
  const { display, reason } = chooseDisplay([PRIMARY, LEFT], { primaryId: 1, cursor: { x: -500, y: 300 } });
  assert.equal(display.id, 2);
  assert.equal(reason, 'cursor');
});

test('with the pointer on the primary display it opens there, not on the secondary', () => {
  const { display } = chooseDisplay([PRIMARY, LEFT], { primaryId: 1, cursor: { x: 10, y: 10 } });
  assert.equal(display.id, 1);
});

test('without a cursor point it falls back to the primary display', () => {
  const { display, reason } = chooseDisplay([LEFT, PRIMARY], { primaryId: 1 });
  assert.equal(display.id, 1);
  assert.equal(reason, 'primary');
});

test('a display set with no primary still yields a display rather than nothing', () => {
  const { display, reason } = chooseDisplay([LEFT], {});
  assert.equal(display.id, 2);
  assert.ok(reason === 'first' || reason === 'primary');
  const empty = chooseDisplay([], {});
  assert.equal(empty.display, null);
  assert.equal(empty.reason, 'no-displays');
});

// ═══ Sizing ════════════════════════════════════════════════════════════════

test('the preferred size is used when it fits the work area', () => {
  const fitted = fitToWorkArea(PREFERRED, PRIMARY.workArea, LIMITS);
  assert.deepEqual({ width: fitted.width, height: fitted.height }, { width: 1360, height: 860 });
  assert.equal(fitted.belowMinimum, false);
});

test('a work area smaller than the design minimum wins over the minimum', () => {
  const fitted = fitToWorkArea(PREFERRED, SMALL.workArea, LIMITS);
  assert.equal(fitted.width, 1093);
  assert.equal(fitted.height, 574);
  assert.equal(fitted.belowMinimum, true, 'the caller must be told, so the log can say why');
  assert.deepEqual(fitted.minimum, { width: 1024, height: 574 }, 'the window minimum is lowered to what fits');
});

test('the taskbar is respected: the window is centred in the work area, not the screen', () => {
  const bounds = placeOnDisplay(PRIMARY, { width: 1360, height: 860 });
  assert.equal(bounds.x, 280);
  assert.equal(bounds.y, 90, 'centred in 1040, not in 1080');
  assert.ok(bounds.y + bounds.height <= 1040, 'the bottom edge is above the taskbar');
});

test('a second monitor with a negative origin places the window at a negative x, inside it', () => {
  const bounds = placeOnDisplay(LEFT, { width: 1360, height: 860 });
  assert.equal(bounds.x, -1640);
  assert.equal(bounds.y, 110);
  assert.ok(bounds.x >= LEFT.workArea.x, 'the left edge is not off the left of that display');
  assert.ok(bounds.x + bounds.width <= LEFT.workArea.x + LEFT.workArea.width);
});

// ═══ The whole decision ════════════════════════════════════════════════════

test('a fresh start centres the window on the cursor display', () => {
  const placement = resolvePlacement({ displays: [PRIMARY, LEFT], primaryId: 1, cursor: { x: -200, y: 200 }, preferred: PREFERRED, limits: LIMITS });
  assert.equal(placement.displayId, 2);
  assert.deepEqual(placement.bounds, { x: -1640, y: 110, width: 1360, height: 860 });
});

test('a saved position that is still visible is honoured exactly', () => {
  const saved = { x: 40, y: 60, width: 1200, height: 800 };
  const placement = resolvePlacement({ displays: [PRIMARY], primaryId: 1, saved, preferred: PREFERRED, limits: LIMITS });
  assert.deepEqual(placement.bounds, saved);
  assert.equal(placement.reason, 'restored');
});

test('a saved position that hangs off the edge is pulled back inside it', () => {
  // 80 % of this window is still visible, so it is honoured and brought inside the work area
  // rather than thrown away.
  const saved = { x: 700, y: 400, width: 1200, height: 800 };
  const placement = resolvePlacement({ displays: [PRIMARY], primaryId: 1, saved, preferred: PREFERRED, limits: LIMITS });
  assert.equal(placement.reason, 'restored-clamped');
  assert.equal(placement.bounds.x, 700);
  assert.equal(placement.bounds.y, 240, 'the bottom edge is pulled up above the taskbar');
});

test('a saved position with a sliver visible counts as lost, not as restored', () => {
  // 120 of 1200 pixels is a strip of border: nobody can grab that, so it is re-placed.
  const saved = { x: 1800, y: 1000, width: 1200, height: 800 };
  const placement = resolvePlacement({ displays: [PRIMARY], primaryId: 1, saved, preferred: PREFERRED, limits: LIMITS });
  assert.equal(placement.reason, 'saved-offscreen');
  assert.deepEqual(placement.bounds, { x: 280, y: 90, width: 1360, height: 860 });
});

test('a saved position on a monitor that is gone opens on a connected one instead', () => {
  // The window would otherwise open off-screen, where a user cannot drag it back.
  const saved = { x: -1800, y: 200, width: 1360, height: 860 };
  const placement = resolvePlacement({ displays: [PRIMARY], primaryId: 1, saved, preferred: PREFERRED, limits: LIMITS });
  assert.equal(placement.reason, 'saved-offscreen');
  assert.equal(placement.displayId, 1);
  assert.ok(placement.bounds.x >= 0);
});

test('the small laptop produces a usable window and says it is below the design minimum', () => {
  const placement = resolvePlacement({ displays: [SMALL], primaryId: 3, preferred: PREFERRED, limits: LIMITS });
  assert.deepEqual(placement.bounds, { x: 0, y: 0, width: 1093, height: 574 });
  assert.equal(placement.belowMinimum, true);
  assert.deepEqual(placement.minimum, { width: 1024, height: 574 });
  assert.match(describePlacement(placement, SMALL), /smaller than the design minimum/);
});

test('no display data at all is reported, not guessed', () => {
  const placement = resolvePlacement({ displays: [], preferred: PREFERRED, limits: LIMITS });
  assert.equal(placement.displayId, null);
  assert.equal(placement.bounds.width, 1360);
  assert.match(describePlacement(placement, null), /without display data/);
});

test('a window left with less than two thirds of itself visible is stranded', () => {
  // This is the state after a monitor is unplugged while the application runs.
  const visible = { x: 100, y: 100, width: 1000, height: 600 };
  assert.equal(isStranded(visible, [PRIMARY]), false);
  const gone = { x: -3000, y: 100, width: 1000, height: 600 };
  assert.equal(isStranded(gone, [PRIMARY]), true);
  const half = { x: 1400, y: 100, width: 1000, height: 600 };
  assert.equal(isStranded(half, [PRIMARY]), true, '400 of 1000 pixels is less than two thirds');
  assert.equal(isStranded(gone, []), false, 'with no display information nothing is claimed');
});

// ═══ The sentence ══════════════════════════════════════════════════════════

test('the description quotes the display, its scale and the work area', () => {
  const placement = resolvePlacement({ displays: [PRIMARY, LEFT], primaryId: 1, cursor: { x: -50, y: 50 }, preferred: PREFERRED, limits: LIMITS });
  const sentence = describePlacement(placement, LEFT);
  assert.match(sentence, /1360x860 at -1640,110 under the pointer/);
  assert.match(sentence, /"Left" at 125 % \(1920x1080 work area\)/);
});

test('the design minimum still fits a 1366x768 laptop at 100 %', () => {
  // The requirement this protects: the window must open fully visible on a small laptop.
  const laptop = { id: 9, bounds: { x: 0, y: 0, width: 1366, height: 768 }, workArea: { x: 0, y: 0, width: 1366, height: 728 }, scaleFactor: 1 };
  const placement = resolvePlacement({ displays: [laptop], primaryId: 9, preferred: PREFERRED, limits: LIMITS });
  assert.equal(placement.belowMinimum, false);
  assert.equal(placement.bounds.height, 728);
  assert.ok(placement.bounds.y + placement.bounds.height <= 728);
});
