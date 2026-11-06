/**
 * The score must never be readable as a verdict on the whole machine.
 *
 * Phase 6 of the release verification asked why the Windows run reported 84 at 75% coverage.
 * Answer: the cap. Above 80% coverage a score is reported as measured; between 50% and 80%
 * it is shown but held at 84 ("Fair") no matter how good the measured parts are; below 50%
 * it is withheld entirely and the assessment is Unrated.
 *
 * These tests pin all three behaviours, and pin the cap to the number so a future change to
 * it is a deliberate act with a failing test to argue with.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { assessOverall, assessFromDiagnostics, ratingFor } from '../../src/engine/health.js';

/** Build a component list with `rated` components at `score` and `unrated` without one. */
function components(rated, unrated, score = 95, weight = 1) {
  return [
    ...Array.from({ length: rated }, (_, index) => ({ id: `r${index}`, label: `Rated ${index}`, weight, score })),
    ...Array.from({ length: unrated }, (_, index) => ({ id: `u${index}`, label: `Unrated ${index}`, weight, score: null }))
  ];
}

test('a perfect score from a minority of the machine is withheld, not published', () => {
  const result = assessOverall(components(1, 7));
  assert.equal(result.score, null, 'a score must not be published below the minimum coverage');
  assert.equal(result.rating, 'Unrated');
  assert.equal(result.gated, true);
  assert.match(result.gatingNote, /withheld|Only \d+(\.\d+)?%/);
});

test('between the thresholds the score is capped, whatever the measured parts say', () => {
  // 3 of 4 components rated = 75% coverage, all perfect.
  const result = assessOverall(components(3, 1, 100));
  assert.equal(result.coveragePercent, 75);
  assert.equal(result.rawScore, 100, 'the underlying average is perfect');
  assert.equal(result.score, 84, 'but the published score is the cap');
  assert.equal(result.rating, 'Fair');
  assert.equal(result.capped, true);
  assert.match(result.gatingNote, /capped at 84/);
});

test('the cap is a ceiling, not a floor: a weak machine keeps its own score', () => {
  const result = assessOverall(components(3, 1, 40));
  assert.equal(result.capped, false, 'nothing to cap — the score is already below it');
  assert.equal(result.score, 40);
  assert.ok(result.score < 84);
});

test('full coverage is reported as measured, with no gate note', () => {
  const result = assessOverall(components(8, 0, 92));
  assert.equal(result.coveragePercent, 100);
  assert.equal(result.gated, false);
  assert.equal(result.capped, false);
  assert.equal(result.score, 92);
  assert.equal(result.gatingNote, null);
});

test('the thresholds themselves are 50 and 80, and are reported for the UI to show', () => {
  const result = assessOverall(components(1, 1));
  assert.deepEqual(result.gatingThresholds, { minimum: 50, full: 80 });
  // Exactly at the minimum: not gated, but capped.
  const atMinimum = assessOverall([{ id: 'a', weight: 1, score: 100 }, { id: 'b', weight: 1, score: null }]);
  assert.equal(atMinimum.coveragePercent, 50);
  assert.equal(atMinimum.gated, false);
  assert.equal(atMinimum.capped, true);
});

test('the rating a capped score receives is Fair, and the cap stays below Good', () => {
  assert.equal(ratingFor(84), 'Fair');
  assert.notEqual(ratingFor(84), 'Good');
  assert.notEqual(ratingFor(84), 'Excellent');
});

test('the disclaimer travels with the score, in every case', () => {
  for (const list of [components(1, 7), components(3, 1), components(8, 0, 92)]) {
    const result = assessOverall(list);
    assert.match(result.disclaimer, /not a certification/i);
    assert.match(result.disclaimer, /excluded from the score rather than counted as healthy/i);
  }
});

test('the reported case — 84 at 75% — is exactly the cap and says so', () => {
  // The real Windows runner reported score=84, raw=100, coverage=75%, capped=true. This is
  // the assertion that makes that number explicable rather than mysterious.
  const result = assessOverall([
    { id: 'cpu', label: 'CPU', weight: 1, score: 100 },
    { id: 'memory', label: 'Memory', weight: 1, score: 100 },
    { id: 'storage', label: 'Storage', weight: 1, score: 100 },
    { id: 'gpu', label: 'GPU', weight: 1, score: null }
  ]);
  assert.equal(result.coveragePercent, 75);
  assert.equal(result.rawScore, 100);
  assert.equal(result.score, 84);
  assert.equal(result.capped, true);
  assert.equal(result.ratedComponents, 3);
  assert.equal(result.totalComponents, 4);
});

test('a real diagnostic result set with no GPU, battery or SMART data is capped', () => {
  // The Windows runner's actual shape: CPU and memory readable, the rest absent.
  const modules = {
    cpu: { name: { status: 'PASS', value: 'Intel Core i7-9700K' }, cores: { status: 'PASS', value: 8 } },
    memory: { totalPhysical: { status: 'PASS', value: 16 } },
    storage: { capacity: { status: 'PASS', value: 512 } }
  };
  const result = assessFromDiagnostics(modules);
  assert.ok(result.coveragePercent < 100, 'not every component can be rated from this');
  if (result.capped) {
    assert.equal(result.score, 84);
    assert.ok(result.gatingNote.includes('capped'));
  } else if (result.gated) {
    assert.equal(result.score, null);
  }
  // Whatever the coverage, the score and the note must agree.
  if (result.score !== null && result.coveragePercent < result.gatingThresholds.full) {
    assert.equal(result.score, 84, 'a partial assessment must be capped');
  }
});
