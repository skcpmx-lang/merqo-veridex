import test from 'node:test';
import assert from 'node:assert/strict';

import { Series, SeriesSet, formatDuration } from '../../src/monitoring/series.js';
import { readSensors, sanitiseReading, sensorDefinition, SENSORS, Monitor } from '../../src/monitoring/monitor.js';
import { Status } from '../../src/core/status.js';

test('a series keeps bounds, statistics and gaps', () => {
  const series = new Series({ id: 'cpu', label: 'CPU', unit: '%', capacity: 3 });
  [10, 20, null, 40].forEach((value) => series.push(value));
  assert.equal(series.samples.length, 3, 'capacity evicts the oldest sample');
  const stats = series.stats();
  assert.equal(stats.current, 40);
  assert.equal(stats.min, 20);
  assert.equal(stats.max, 40);
  assert.equal(stats.samples, 3);
  assert.equal(stats.gaps, 1, 'a null sample is counted as a gap, not interpolated');
});

test('a series with only gaps reports no statistics rather than zeros', () => {
  const series = new Series({ id: 'x', label: 'X', capacity: 5 });
  series.push(null).push(null);
  const stats = series.stats();
  assert.equal(stats.current, null);
  assert.equal(stats.min, null);
  assert.equal(stats.average, null);
  assert.equal(stats.gaps, 2);
  assert.equal(series.availability(), 0);
});

test('sensor readings outside their plausible range are discarded, not clamped', () => {
  assert.equal(sanitiseReading(55, 'cpu.temp'), 55);
  assert.equal(sanitiseReading(0, 'cpu.temp'), null, '0 °C is the no-sensor sentinel');
  assert.equal(sanitiseReading(-5, 'cpu.temp'), null);
  assert.equal(sanitiseReading(143, 'cpu.load'), null);
  assert.equal(sanitiseReading(Number.NaN, 'cpu.load'), null);
  assert.equal(sanitiseReading(null, 'gpu.temp'), null);
  assert.equal(sanitiseReading(900, 'network.rx'), 900, 'a high but valid network rate is kept');
});

test('every sensor in the registry has a provider and a range', () => {
  for (const sensor of SENSORS) {
    assert.ok(sensor.id && sensor.label && sensor.source, sensor.id);
    assert.ok(Array.isArray(sensor.range) && sensor.range.length === 2, sensor.id);
  }
  assert.equal(sensorDefinition('cpu.temp').unit, '°C');
  assert.equal(sensorDefinition('nope'), null);
});

test('sensor reads report absences with their reason, never a zero', async () => {
  const runner = { isWindows: false, run: async () => ({ ok: false, code: 1, stdout: '', stderr: 'not windows', timedOut: false, durationMs: 0, command: '' }), powershellJson: async () => ({ ok: false, data: null, error: 'not windows', durationMs: 0, raw: '' }) };
  const result = await readSensors({ runner, includePrivileged: false });
  assert.ok(Object.keys(result.readings).length >= 10);
  for (const [id, reading] of Object.entries(result.readings)) {
    if (reading.value === null) {
      assert.equal(reading.status, Status.UNAVAILABLE, id);
      assert.ok(reading.reason.length > 0, `${id} must explain its absence`);
    }
  }
  assert.equal(result.readings['cpu.temp'].status, Status.UNAVAILABLE);
  assert.match(result.readings['cpu.temp'].reason, /administrator rights|ACPI/);
});

test('privileged sensors are refused in standard-user mode rather than silently attempted', async () => {
  const runner = { isWindows: true, run: async () => ({ ok: false, code: 1, stdout: '', stderr: '', timedOut: false, durationMs: 0, command: '' }), powershellJson: async () => ({ ok: false, data: null, error: 'access denied', durationMs: 0, raw: '' }) };
  const result = await readSensors({ runner, includePrivileged: false });
  assert.match(result.readings['storage.temp'].reason, /administrator rights/);
});

test('the monitor samples on an interval and stops cleanly', async () => {
  const runner = { isWindows: false, run: async () => ({ ok: false, code: 1, stdout: '', stderr: '', timedOut: false, durationMs: 0, command: '' }), powershellJson: async () => ({ ok: false, data: null, error: '', durationMs: 0, raw: '' }) };
  const monitor = new Monitor({ runner, intervalMs: 500 });
  let callbacks = 0;
  monitor.onSample = () => { callbacks += 1; };
  monitor.start();

  // Wait for a sample to arrive rather than for 1200 ms to pass. A fixed wait assumes the
  // first poll completes quickly, which is true of a Linux container with no sensors to
  // read and false of a Windows runner where every sensor is actually queried — the
  // Windows CI job failed here while Linux passed.
  const deadline = Date.now() + 10_000;
  while (callbacks === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  monitor.stop();
  assert.ok(callbacks >= 1, 'at least one sample is delivered');
  assert.equal(monitor.running, false);
  const status = monitor.status();
  assert.ok(status.length === SENSORS.length);
  for (const entry of status) assert.ok(entry.reason.length > 0 || entry.value !== null);
});

test('duration formatting is compact and never negative', () => {
  assert.equal(formatDuration(45), '45s');
  assert.equal(formatDuration(125), '2m 5s');
  assert.equal(formatDuration(3700), '1h 1m');
  assert.equal(formatDuration(90000), '1d 1h 0m');
  assert.equal(formatDuration(-5), '0s');
});

test('a series set keeps one series per sensor id', () => {
  const set = new SeriesSet({ capacity: 10 });
  set.ensure({ id: 'a', label: 'A' }).push(1);
  set.ensure({ id: 'a', label: 'A' }).push(2);
  assert.equal(set.list().length, 1);
  assert.equal(set.get('a').stats().current, 2);
  assert.equal(set.snapshot()[0].id, 'a');
});
