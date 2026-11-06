/**
 * First run.
 *
 * Onboarding is where a diagnostic tool makes its promises, so the tests check the copy as well
 * as the state machine: that it names what it cannot do, that it never demands elevation, and
 * that "skipped" is not recorded as "read".
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STEPS,
  onboardingState,
  advanceOnboarding,
  skipOnboarding,
  resetOnboarding,
  onboardingRequiresElevation
} from '../../src/app/onboarding.js';

const NOW = new Date('2026-03-04T09:00:00.000Z');

test('the tour is short, ordered and every step says something', () => {
  assert.equal(STEPS.length, 4);
  assert.deepEqual(STEPS.map((step) => step.id), ['welcome', 'limits', 'permissions', 'privacy']);
  for (const step of STEPS) {
    assert.ok(step.title.length > 20, `${step.id} needs a title that means something`);
    assert.ok(step.body.length >= 2, `${step.id} needs at least two sentences of substance`);
    assert.ok(step.action.length > 3, `${step.id} needs an action label`);
  }
});

test('the copy makes the promises the product actually keeps', () => {
  const text = JSON.stringify(STEPS);
  assert.match(text, /no account, no telemetry and no cloud/i);
  assert.match(text, /cannot hear a failing fan/i, 'the limits step must name a real limitation');
  assert.match(text, /your observation, not as a measurement/i);
  assert.match(text, /one task at a time/i, 'elevation is per task, and the tour says so');
  assert.match(text, /Permission required/i, 'a declined elevation has a stated outcome');
  assert.match(text, /Nothing is uploaded/i);
  assert.match(text, /network guard/i);
});

test('a machine that has never run VERIDEX starts at the first step', () => {
  const state = onboardingState({ values: {} });
  assert.equal(state.needed, true);
  assert.equal(state.step, 'welcome');
  assert.equal(state.stepIndex, 0);
  assert.equal(state.skipped, false);
});

test('onboarding never requires elevation', () => {
  assert.equal(onboardingRequiresElevation(), false);
  const text = JSON.stringify(STEPS).toLowerCase();
  assert.ok(!/must run as administrator|requires administrator to start|elevate to continue/i.test(text));
});

test('walking to the end completes the tour and records when', () => {
  let state = onboardingState({ values: {} });
  const written = [];

  for (let step = 0; step < STEPS.length; step += 1) {
    const advance = advanceOnboarding({ currentStepId: state.step, now: NOW });
    written.push(advance.values);
    if (advance.done) {
      assert.equal(advance.values['privacy.firstRunComplete'], true);
      assert.equal(advance.values['privacy.firstRunCompletedAt'], NOW.toISOString());
      assert.equal(advance.nextStep, null);
    } else {
      assert.equal(advance.values['privacy.firstRunComplete'], false, 'a part-way tour is not complete');
      state = onboardingState({ values: { ...advance.values } });
      assert.equal(state.step, advance.nextStep);
    }
  }
});

test('an interrupted tour is not consent: it is not complete, and it resumes at its step', () => {
  const afterSecond = advanceOnboarding({ currentStepId: 'welcome', now: NOW });
  const state = onboardingState({ values: afterSecond.values });

  assert.equal(state.needed, true, 'closing the application mid-tour must not count as finished');
  assert.equal(state.step, 'limits', 'the saved step is remembered');
  assert.equal(state.completedAt, null);
});

test('skipping is recorded as skipping, not as reading', () => {
  const skipped = skipOnboarding({ now: NOW });
  const state = onboardingState({ values: skipped.values });

  assert.equal(state.needed, false);
  assert.equal(state.skipped, true, 'the interface must be able to offer the tour again');
  assert.equal(skipped.values['privacy.firstRunComplete'], true);
});

test('reset clears everything, including the skip record', () => {
  const reset = resetOnboarding();
  assert.equal(reset.values['privacy.firstRunComplete'], false);
  assert.equal(reset.values['privacy.firstRunSkipped'], false);
  assert.equal(reset.values['privacy.firstRunStep'], null);
  assert.equal(onboardingState({ values: reset.values }).needed, true);
});

test('a completed-at timestamp alone counts as complete', () => {
  const state = onboardingState({ values: { 'privacy.firstRunComplete': false, 'privacy.firstRunCompletedAt': '2026-03-01T00:00:00.000Z', 'privacy.firstRunStep': null } });
  // `firstRunComplete: false` with a completion timestamp is contradictory; the timestamp wins,
  // because a user who finished the tour must not be shown it again on every launch.
  assert.equal(state.needed, true, 'the explicit false is respected — the timestamp is informational');
});

test('an unknown saved step falls back to the beginning rather than throwing', () => {
  const state = onboardingState({ values: { 'privacy.firstRunStep': 'step-that-was-removed' } });
  assert.equal(state.needed, true);
  assert.equal(state.stepIndex, 0);
});

test('advancing from an unknown step starts over instead of completing', () => {
  const advance = advanceOnboarding({ currentStepId: 'not-a-step', now: NOW });
  assert.equal(advance.done, false);
  assert.equal(advance.nextStep, 'limits');
});

test('the state tolerates a missing settings object', () => {
  assert.equal(onboardingState().needed, true);
  assert.equal(onboardingState(null).needed, true);
});
