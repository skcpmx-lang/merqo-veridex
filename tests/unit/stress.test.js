import test from 'node:test';
import assert from 'node:assert/strict';

import { StressGuard, StressState, validateStressRequest } from '../../src/benchmarking/stress-guard.js';
import { Status } from '../../src/core/status.js';

/** A controlled clock so transitions are deterministic. */
function makeClock(start = 1_700_000_000_000, stepMs = 1000) {
  let now = start;
  return { now: () => new Date((now += stepMs)), peek: () => now };
}

const baseConfig = { kind: 'cpu', durationSec: 60, maxDurationSec: 300, thermalLimitC: 90, threads: 2, consentGiven: true };

test('a request without explicit consent is refused', () => {
  const result = validateStressRequest({ ...baseConfig, consentGiven: false }, { logicalCpus: 4, thermalSensorAvailable: true });
  assert.equal(result.allowed, false);
  assert.ok(result.problems.some((problem) => problem.includes('consent')));
});

test('a duration beyond the configured ceiling is refused with the numbers', () => {
  const result = validateStressRequest({ ...baseConfig, durationSec: 900 }, { logicalCpus: 4, thermalSensorAvailable: true });
  assert.equal(result.allowed, false);
  assert.ok(result.problems.some((problem) => problem.includes('900s') && problem.includes('300s')));
});

test('an implausible thermal threshold is refused', () => {
  assert.equal(validateStressRequest({ ...baseConfig, thermalLimitC: 20 }, { logicalCpus: 4, thermalSensorAvailable: true }).allowed, false);
  assert.equal(validateStressRequest({ ...baseConfig, thermalLimitC: 150 }, { logicalCpus: 4, thermalSensorAvailable: true }).allowed, false);
});

test('a missing thermal sensor does not block the run, but the warning is explicit', () => {
  const result = validateStressRequest(baseConfig, { logicalCpus: 4, thermalSensorAvailable: false });
  assert.equal(result.allowed, true);
  assert.ok(result.warnings.some((warning) => warning.includes('thermal stop is inactive')));
  assert.ok(result.warnings.some((warning) => warning.includes('will not invent a temperature')));
});

test('the thread count is capped at the number of logical CPUs', () => {
  const result = validateStressRequest({ ...baseConfig, threads: 64 }, { logicalCpus: 8, thermalSensorAvailable: true });
  assert.equal(result.effective.threads, 8);
});

test('running on battery produces a warning but is allowed', () => {
  const result = validateStressRequest(baseConfig, { logicalCpus: 4, thermalSensorAvailable: true, isOnBattery: true });
  assert.equal(result.allowed, true);
  assert.ok(result.warnings.some((warning) => warning.includes('drain it quickly')));
});

test('the guard only enters RUNNING when validation passes, and records the refusal', () => {
  const guard = new StressGuard({ config: { ...baseConfig, consentGiven: false }, thermalSensorAvailable: true, now: makeClock().now });
  const begin = guard.begin({ logicalCpus: 4 });
  assert.equal(begin.started, false);
  assert.equal(guard.state, StressState.IDLE);
  assert.match(guard.transitions[0].reason, /refused to start: .*consent/);
});

test('a thermal breach stops the run and names the threshold the user set', () => {
  const guard = new StressGuard({ config: baseConfig, thermalSensorAvailable: true, now: makeClock().now });
  assert.equal(guard.begin({ logicalCpus: 4 }).started, true);
  assert.equal(guard.tick({ temperatureC: 70, elapsedSec: 5 }).continue, true);

  const breach = guard.tick({ temperatureC: 91, elapsedSec: 10 });
  assert.equal(breach.continue, false);
  assert.equal(guard.state, StressState.STOPPED_THERMAL);
  assert.match(breach.reason, /91 °C/);
  assert.match(breach.reason, /90 °C threshold you set/);
  assert.equal(guard.thermal.max, 91);
});

test('pause stops the thermal check from firing and resume re-arms it', () => {
  const guard = new StressGuard({ config: baseConfig, thermalSensorAvailable: true, now: makeClock().now });
  guard.begin({ logicalCpus: 4 });
  guard.pause();
  assert.equal(guard.state, StressState.PAUSED);
  const whilePaused = guard.tick({ temperatureC: 110, elapsedSec: 10 });
  assert.equal(whilePaused.continue, true, 'a paused run does not stop');
  assert.equal(guard.state, StressState.PAUSED);
  guard.resume();
  assert.equal(guard.state, StressState.RUNNING);
  assert.equal(guard.tick({ temperatureC: 110, elapsedSec: 11 }).continue, false);
});

test('the duration ceiling stops a run that never gets hot', () => {
  const guard = new StressGuard({ config: { ...baseConfig, durationSec: 20 }, thermalSensorAvailable: true, now: makeClock().now });
  guard.begin({ logicalCpus: 4 });
  assert.equal(guard.tick({ temperatureC: 60, elapsedSec: 19 }).continue, true);
  const done = guard.tick({ temperatureC: 60, elapsedSec: 20 });
  assert.equal(done.continue, false);
  assert.equal(guard.state, StressState.STOPPED_DURATION);
  assert.match(done.reason, /completed the full 20s/);
});

test('an unexpected abort stops the run and is recorded as an error state', () => {
  const guard = new StressGuard({ config: baseConfig, thermalSensorAvailable: true, now: makeClock().now });
  guard.begin({ logicalCpus: 4 });
  const result = guard.tick({ temperatureC: 60, elapsedSec: 3, aborted: 'worker crashed' });
  assert.equal(result.continue, false);
  assert.equal(guard.state, StressState.STOPPED_ERROR);
  assert.match(result.reason, /worker crashed/);
});

test('a user stop is terminal and further ticks are no-ops', () => {
  const guard = new StressGuard({ config: baseConfig, thermalSensorAvailable: true, now: makeClock().now });
  guard.begin({ logicalCpus: 4 });
  assert.equal(guard.stop().ok, true);
  assert.equal(guard.state, StressState.STOPPED_USER);
  assert.equal(guard.tick({ temperatureC: 50, elapsedSec: 1 }).continue, false);
  assert.equal(guard.stop().ok, false, 'stopping twice is refused');
});

test('every transition is logged with time, from, to and reason', () => {
  const guard = new StressGuard({ config: baseConfig, thermalSensorAvailable: true, now: makeClock().now });
  guard.begin({ logicalCpus: 4 });
  guard.pause();
  guard.resume();
  guard.stop();
  assert.equal(guard.transitions.length, 4);
  for (const transition of guard.transitions) {
    assert.ok(transition.at && transition.to && transition.reason);
    assert.ok(transition.from);
  }
});

test('the report fields record thermal min/max and whether the stop condition was live', () => {
  const guard = new StressGuard({ config: baseConfig, thermalSensorAvailable: true, now: makeClock().now });
  guard.begin({ logicalCpus: 4 });
  guard.tick({ temperatureC: 55, elapsedSec: 1 });
  guard.tick({ temperatureC: 72, elapsedSec: 2 });
  guard.tick({ temperatureC: 91, elapsedSec: 3 });

  const fields = guard.toFields();
  assert.equal(fields.thermalMin.value, 55);
  assert.equal(fields.thermalMax.value, 91);
  assert.equal(fields.outcome.status, Status.WARNING);
  assert.match(fields.outcome.value, /thermal threshold reached/);
  assert.equal(fields.thermalSensorAvailable.value, 'Yes');
  assert.match(fields.disclaimer.value, /does not certify the hardware/);
  assert.equal(fields.transitions.value, 2, 'start plus the thermal stop; uneventful ticks are not transitions');
  assert.equal(fields.transitionLog.value.length, 2);
  assert.ok(fields.transitionLog.value[0].includes('started cpu stress test'));
  assert.ok(fields.transitionLog.value[1].includes('thermal limit reached'));
});

test('without a sensor the run still completes on duration and says the guard was blind', () => {
  const guard = new StressGuard({ config: { ...baseConfig, durationSec: 10 }, thermalSensorAvailable: false, now: makeClock().now });
  guard.begin({ logicalCpus: 4 });
  const result = guard.tick({ temperatureC: null, elapsedSec: 10 });
  assert.equal(result.continue, false);
  assert.equal(guard.state, StressState.STOPPED_DURATION);
  const fields = guard.toFields();
  assert.equal(fields.thermalSensorAvailable.status, Status.UNAVAILABLE);
  assert.match(fields.thermalSensorAvailable.error, /inactive/);
  assert.match(fields.thermalSensorAvailable.notes[0], /does not substitute an estimated temperature/);
  assert.equal(fields.thermalMax.status, Status.UNAVAILABLE);
});

test('elapsed time uses a real clock, not the injected display timestamp', () => {
  const clock = makeClock(1_700_000_000_000, 500);
  const guard = new StressGuard({ config: baseConfig, thermalSensorAvailable: true, now: clock.now });
  guard.begin({ logicalCpus: 4 });
  const elapsed = guard.elapsedSec();
  assert.ok(elapsed >= 0 && elapsed < 10, `expected a small elapsed value, got ${elapsed}`);
});
