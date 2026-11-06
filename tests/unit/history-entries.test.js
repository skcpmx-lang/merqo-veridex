/**
 * History entries for benchmarks and stress runs (R-24-01).
 *
 * The store documents six entry kinds and only scans were ever written, so the History page
 * could not show a benchmark even after one had run. These tests hold the builders to the result
 * shapes the runners actually return, and to two rules that matter more than the field list: a
 * run that was refused is not filed, and a temperature that was never read is null, not zero.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cpuBenchmarkEntry,
  diskBenchmarkEntry,
  fieldsSnapshot,
  gpuBenchmarkEntry,
  peakTemperatureOf,
  stressEntry
} from '../../src/history/entries.js';
import { HistoryStore } from '../../src/history/store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const field = (value) => ({ value, status: 'PASS', source: 'test', confidence: 'HIGH' });

test('a CPU entry carries the three CPU figures the runner measured', () => {
  const entry = cpuBenchmarkEntry(
    {
      mode: 'all',
      at: '2026-11-06T10:00:00.000Z',
      durationMs: 4321,
      fields: { singleCore: field(1200), multiCore: field(8000), memoryBandwidth: field(18.4) },
      results: {
        single: { opsPerSecond: 1200 },
        multi: { opsPerSecond: 8000, threads: 8 },
        memory: { sequentialGbps: 18.4 }
      }
    },
    { appVersion: '1.0.0', finishedAt: '2026-11-06T10:00:05.000Z' }
  );

  assert.equal(entry.kind, 'benchmark');
  assert.equal(entry.summary.benchmark, 'cpu');
  assert.equal(entry.summary.singleCoreOpsPerSec, 1200);
  assert.equal(entry.summary.multiCoreOpsPerSec, 8000);
  assert.equal(entry.summary.memoryGbps, 18.4);
  assert.equal(entry.summary.threads, 8);
  assert.equal(entry.durationMs, 4321);
  assert.equal(entry.startedAt, '2026-11-06T10:00:00.000Z');
  assert.equal(entry.snapshot.singleCore, 1200, 'the snapshot must mirror the fields the page rendered');
});

test('a mode that did not measure a figure records null, not a guess', () => {
  const entry = cpuBenchmarkEntry({ mode: 'single', results: { single: { opsPerSecond: 900 }, multi: null, memory: null }, fields: {} });
  assert.equal(entry.summary.singleCoreOpsPerSec, 900);
  assert.equal(entry.summary.multiCoreOpsPerSec, null);
  assert.equal(entry.summary.memoryGbps, null);
});

test('a disk entry records what the benchmark wrote and whether it cleaned up', () => {
  const entry = diskBenchmarkEntry(
    {
      at: '2026-11-06T10:10:00.000Z',
      sizeMb: 256,
      allowWrite: true,
      cleanup: { removed: true, path: 'C:/tmp/x.bin' },
      fields: {
        sequentialRead: field(2400),
        sequentialWrite: field(1100),
        randomReadIops: field(48000),
        randomReadLatency: field(0.02)
      }
    },
    { appVersion: '1.0.0', durationMs: 9000 }
  );
  assert.equal(entry.summary.benchmark, 'disk');
  assert.equal(entry.summary.sizeMb, 256);
  assert.equal(entry.summary.sequentialReadMbps, 2400);
  assert.equal(entry.summary.randomReadLatencyMs, 0.02);
  assert.equal(entry.summary.tempFileRemoved, true);
});

test('a disk entry says so when the temporary file was left behind', () => {
  const entry = diskBenchmarkEntry({ fields: {}, cleanup: { removed: false } });
  assert.equal(entry.summary.tempFileRemoved, false);
});

test('an unsupported GPU probe produces no entry and a supported one does', () => {
  assert.equal(gpuBenchmarkEntry({ measurement: { supported: false, reason: 'no WebGL' }, fields: {} }), null);
  assert.equal(gpuBenchmarkEntry({ measurement: null, fields: {} }), null);

  const entry = gpuBenchmarkEntry(
    {
      at: '2026-11-06T10:20:00.000Z',
      measurement: { supported: true, frameTimeMs: 6.5, pixelsPerSecond: 1.2e9, renderer: 'NVIDIA RTX 3060', durationMs: 400 },
      fields: { gpuFrameTime: field(6.5), gpuFillRate: field(1.2e9), gpuAdapter: field('NVIDIA RTX 3060') }
    },
    { appVersion: '1.0.0' }
  );
  assert.equal(entry.summary.frameTimeMs, 6.5);
  assert.equal(entry.summary.adapter, 'NVIDIA RTX 3060');
  assert.equal(entry.summary.fillRatePixelsPerSecond, 1.2e9);
});

test('a refused stress run is not filed', () => {
  assert.equal(stressEntry({ started: false, reason: 'no consent' }, {}), null);
  assert.equal(stressEntry(null, {}), null);
});

test('a stress entry records the stop reason and the peak only when a sensor answered', () => {
  const withSensor = stressEntry(
    {
      started: true,
      kind: 'cpu',
      threads: 4,
      elapsedSec: 30.5,
      state: 'STOPPED_DURATION',
      stopReason: 'duration reached',
      completed: true,
      samples: [
        { elapsedSec: 1, temperatureC: 61 },
        { elapsedSec: 2, temperatureC: null },
        { elapsedSec: 3, temperatureC: 74 }
      ]
    },
    { appVersion: '1.0.0', requestedDurationSec: 30, at: '2026-11-06T10:30:00.000Z' }
  );
  assert.equal(withSensor.summary.peakTemperatureC, 74);
  assert.equal(withSensor.summary.temperatureObserved, true);
  assert.equal(withSensor.summary.state, 'STOPPED_DURATION');
  assert.equal(withSensor.durationMs, 30500);

  const withoutSensor = stressEntry(
    { started: true, elapsedSec: 10, state: 'STOPPED_DURATION', samples: [{ elapsedSec: 1, temperatureC: null }] },
    {}
  );
  assert.equal(withoutSensor.summary.peakTemperatureC, null, 'no reading is null, never zero');
  assert.equal(withoutSensor.summary.temperatureObserved, false);
});

test('peakTemperatureOf ignores nulls and non-numbers', () => {
  assert.equal(peakTemperatureOf([{ temperatureC: null }, { temperatureC: undefined }, { temperatureC: Number.NaN }]), null);
  assert.equal(peakTemperatureOf([{ temperatureC: 40 }, { temperatureC: 55 }, { temperatureC: null }]), 55);
  assert.equal(peakTemperatureOf(null), null);
});

test('a snapshot keeps an unavailable field as null rather than dropping the key', () => {
  const snapshot = fieldsSnapshot({ a: field(1), b: { value: null }, c: null });
  assert.deepEqual(snapshot, { a: 1, b: null, c: null });
});

test('the store accepts and returns these entries, newest first', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'veridex-history-'));
  try {
    const store = new HistoryStore({ file: path.join(dir, 'history.json') });
    await store.add(cpuBenchmarkEntry({ mode: 'all', results: {}, fields: {} }, { finishedAt: '2026-11-06T10:00:00.000Z' }));
    await store.add(stressEntry({ started: true, elapsedSec: 5, state: 'STOPPED_DURATION', samples: [] }, { at: '2026-11-06T11:00:00.000Z' }));
    assert.equal(store.entries[0].kind, 'stress');
    assert.equal(store.entries[1].kind, 'benchmark');

    const reloaded = new HistoryStore({ file: path.join(dir, 'history.json') });
    await reloaded.load();
    assert.equal(reloaded.entries.length, 2, 'the entries must survive a reload, or the page shows nothing');
    assert.equal(reloaded.latest('benchmark').summary.benchmark, 'cpu');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
