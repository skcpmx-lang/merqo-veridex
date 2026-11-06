/**
 * The stress runner: what it will start, what it refuses, and what it reports.
 *
 * These tests never pin a real CPU. The load generator is injected, so the controller's decisions
 * — consent, duration, thermal stop, cancellation, cleanup — are exercised exactly as they are in
 * production while a fake worker stands in for the real one. One test runs the real worker for a
 * few hundred milliseconds to prove the generator itself starts and stops.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runCpuStress, stressCapabilities, UNSUPPORTED_STRESS_KINDS } from '../../src/benchmarking/stress-run.js';
import { runInWorker } from '../../src/benchmarking/cpu-bench.js';
import { Status } from '../../src/core/status.js';

/** A fake clock that advances by `stepMs` every time the controller waits. */
function fakeClock(stepMs) {
  let current = 1_700_000_000_000;
  return {
    now: () => current,
    wait: async () => {
      current += stepMs;
    },
    advance: (ms) => {
      current += ms;
    }
  };
}

/** A load generator that records whether it was stopped. */
function fakeLoad() {
  const handle = { stopped: 0, spawns: 0, threads: null };
  handle.spawnLoad = ({ threads }) => {
    handle.spawns += 1;
    handle.threads = threads;
    return {
      stop: async () => {
        handle.stopped += 1;
      }
    };
  };
  return handle;
}

const base = {
  durationSec: 10,
  maxDurationSec: 300,
  threads: 1,
  thermalLimitC: 90,
  logicalCpus: 2,
  consentGiven: true,
  sampleIntervalMs: 1
};

test('a stress run without consent is refused before any load is started', async () => {
  const load = fakeLoad();
  const result = await runCpuStress({ ...base, consentGiven: false, spawnLoad: load.spawnLoad, ...fakeClock(1000) });
  assert.equal(result.started, false);
  assert.equal(result.refused, true);
  assert.match(result.reason, /consent/i);
  assert.equal(load.spawns, 0, 'no worker may be created for a refused run');
});

test('a duration above the configured ceiling is refused rather than clamped silently', async () => {
  const result = await runCpuStress({ ...base, durationSec: 600, maxDurationSec: 300, spawnLoad: fakeLoad().spawnLoad, ...fakeClock(1000) });
  assert.equal(result.started, false);
  assert.match(result.reason, /exceeds the configured maximum/);
});

test('the run stops at its duration and says so, and the workers are torn down', async () => {
  const load = fakeLoad();
  const clock = fakeClock(1000);
  const result = await runCpuStress({ ...base, durationSec: 10, spawnLoad: load.spawnLoad, readTemperature: () => 40, ...clock });

  assert.equal(result.started, true);
  assert.equal(result.state, 'STOPPED_DURATION');
  assert.match(result.stopReason, /10s duration/);
  assert.equal(result.completed, true);
  assert.equal(load.spawns, 1);
  assert.ok(load.stopped >= 1, 'the load must be stopped whether the run completed or not');
  assert.ok(result.samples.length > 0, 'a run that reports how hot the machine got needs samples');
});

test('a temperature at the ceiling stops the run before the duration elapses', async () => {
  const load = fakeLoad();
  const clock = fakeClock(1000);
  let reading = 60;
  const result = await runCpuStress({
    ...base,
    durationSec: 300,
    maxDurationSec: 300,
    spawnLoad: load.spawnLoad,
    // Crosses the 90 °C ceiling on the third sample.
    readTemperature: () => {
      reading += 20;
      return reading;
    },
    ...clock
  });

  assert.equal(result.state, 'STOPPED_THERMAL');
  assert.match(result.stopReason, /thermal limit/);
  assert.equal(result.samples.at(-1).temperatureC >= 90, true);
  assert.equal(load.stopped, 1);
});

test('without a sensor the run says the thermal stop was inactive instead of inventing a temperature', async () => {
  const result = await runCpuStress({
    ...base,
    durationSec: 10,
    spawnLoad: fakeLoad().spawnLoad,
    readTemperature: () => null,
    ...fakeClock(1000)
  });

  assert.equal(result.started, true);
  assert.equal(result.fields.thermalLimitApplied.status, Status.UNAVAILABLE);
  assert.match(result.fields.thermalLimitApplied.error, /could not be applied/);
  assert.equal(result.fields.thermalMax.status, Status.UNAVAILABLE);
  assert.ok(
    result.warnings.some((warning) => /thermal stop is inactive/.test(warning)),
    'the user must be told the stop condition is missing'
  );
});

test('a sensor that throws is treated as missing, not as a zero reading', async () => {
  const result = await runCpuStress({
    ...base,
    durationSec: 10,
    spawnLoad: fakeLoad().spawnLoad,
    readTemperature: () => {
      throw new Error('WMI unavailable');
    },
    ...fakeClock(1000)
  });
  assert.equal(result.fields.thermalMax.status, Status.UNAVAILABLE);
  assert.ok(result.samples.every((sample) => sample.temperatureC === null));
});

test('cancellation stops the load and is recorded as stopped by the user, not as completed', async () => {
  const load = fakeLoad();
  const clock = fakeClock(500);
  const controller = new AbortController();
  // Cancel after a few samples rather than before the run starts.
  let calls = 0;
  const result = await runCpuStress({
    ...base,
    durationSec: 300,
    maxDurationSec: 300,
    spawnLoad: load.spawnLoad,
    readTemperature: () => 45,
    signal: controller.signal,
    onSample: () => {
      calls += 1;
      if (calls === 2) controller.abort();
    },
    ...clock
  });

  assert.equal(result.state, 'STOPPED_USER');
  assert.equal(result.completed, false);
  assert.equal(load.stopped, 1);
  assert.ok(result.elapsedSec < 300);
});

test('a stress run never reports a PASS verdict', async () => {
  const result = await runCpuStress({ ...base, durationSec: 10, spawnLoad: fakeLoad().spawnLoad, readTemperature: () => 41, ...fakeClock(1000) });
  assert.equal(result.fields.verdict.status, Status.UNRATED);
  assert.equal(result.fields.verdict.value, null);
  assert.match(result.fields.verdict.error, /no verdict/i);
});

test('memory, GPU, disk and combined stress are refused with the reason, not approximated', async () => {
  for (const kind of ['memory', 'gpu', 'disk', 'combined']) {
    const result = await runCpuStress({ ...base, kind, spawnLoad: fakeLoad().spawnLoad, ...fakeClock(1000) });
    assert.equal(result.started, false, `${kind} must not start`);
    assert.equal(result.refused, true);
    assert.ok(result.reason.length > 40, `${kind} needs a real explanation`);
    assert.ok(UNSUPPORTED_STRESS_KINDS[kind]);
  }
});

test('capabilities state the supported kinds and the sensor reality', () => {
  const withoutSensor = stressCapabilities({ thermalSensorAvailable: false, logicalCpus: 8 });
  assert.deepEqual(withoutSensor.kinds, ['cpu']);
  assert.equal(withoutSensor.thermalSensorAvailable, false);
  assert.ok(Object.keys(withoutSensor.unsupported).length >= 4);
});

test('the real load generator runs and stops itself inside its budget', async () => {
  const started = Date.now();
  const result = await runInWorker({ kind: 'stress', payload: { budgetMs: 250 } }, 10_000);
  const elapsed = Date.now() - started;
  assert.equal(result.ok, true);
  assert.ok(result.iterations > 0, 'the loop must actually execute work');
  assert.ok(elapsed < 5_000, `the worker took ${elapsed}ms; it must honour its own deadline`);
});
