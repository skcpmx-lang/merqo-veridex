import test from 'node:test';
import assert from 'node:assert/strict';

import { benchmarkSingleCore, benchmarkMultiCore, benchmarkMemoryBandwidth, median, relativeSpread, mapCpuBenchmarkResults, WORKLOAD } from '../../src/benchmarking/cpu-bench.js';
import { integerWorkload, hashWorkload, memoryWorkload, runTask } from '../../src/benchmarking/worker.js';
import { Status } from '../../src/core/status.js';

test('median and spread are computed correctly, including even-length lists', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 2]), 3);
  assert.equal(median([]), null);
  assert.equal(relativeSpread([100, 110, 90]), 20);
  assert.equal(relativeSpread([100]), null);
  assert.equal(relativeSpread([]), null);
});

test('integer workload is deterministic for the same input', () => {
  assert.equal(integerWorkload(10_000), integerWorkload(10_000));
  assert.notEqual(integerWorkload(10_000), integerWorkload(10_001));
});

test('hash workload chains rounds, so more rounds change the digest', () => {
  const one = hashWorkload(1);
  const two = hashWorkload(2);
  assert.equal(one.length, 16);
  assert.notEqual(one, two);
  assert.equal(hashWorkload(50), hashWorkload(50));
});

test('memory workload traverses both sequentially and with a stride', () => {
  const buffer = new Float64Array(64).fill(1);
  const result = memoryWorkload(buffer);
  assert.equal(result.sum, 64);
  assert.equal(result.stridedSum, 8);
});

test('runTask rejects an unknown workload instead of returning a fake result', () => {
  assert.throws(() => runTask({ kind: 'quantum' }), /Unknown benchmark task/);
});

test('runTask reports the checksum and duration for each supported workload', () => {
  for (const kind of ['integer', 'hash', 'memory', 'noise']) {
    const result = runTask({ kind, payload: { iterations: 1000, rounds: 10, elements: 1000 } });
    assert.equal(result.kind, kind);
    assert.ok(Number.isFinite(result.durationMs));
    assert.ok(Number.isFinite(result.checksum));
  }
});

test('single-core benchmark produces samples, a median and a stable checksum', async () => {
  const result = await benchmarkSingleCore({ repeats: 2 });
  assert.equal(result.error, null);
  assert.equal(result.samples.length, 2);
  assert.ok(result.opsPerSecond > 0);
  assert.equal(result.checksumStable, true, 'identical work must produce identical checksums');
  assert.ok(result.spreadPercent !== null);
});

test('multi-core benchmark runs one worker per thread and totals throughput', async () => {
  const result = await benchmarkMultiCore({ threads: 2 });
  assert.equal(result.threads, 2);
  assert.ok(result.opsPerSecond > 0);
  assert.equal(result.perThread.length, 2);
});

test('memory bandwidth benchmark returns a measured figure, not a zero', async () => {
  const result = await benchmarkMemoryBandwidth();
  assert.equal(result.error, null);
  assert.ok(result.sequentialGbps > 0);
});

test('report fields state that the units are VERIDEX-specific and not cross-tool', async () => {
  const single = await benchmarkSingleCore({ repeats: 2 });
  const multi = await benchmarkMultiCore({ threads: 2 });
  const memory = await benchmarkMemoryBandwidth();
  const fields = mapCpuBenchmarkResults({ single, multi, memory, durationMs: 4000 });

  assert.equal(fields.singleCore.unit, 'ops/s');
  assert.ok(fields.singleCore.notes.some((note) => note.includes("not comparable to other tools")));
  assert.ok(fields.scaling.value > 0);
  assert.ok(fields.scaling.notes.some((note) => note.includes('Efficiency below about 60%')));
  assert.ok(fields.memoryBandwidth.notes.some((note) => note.includes('run-to-run comparison')));
  assert.equal(fields.singleCoreChecksum.value, 'Identical across samples');
});

test('a failed benchmark becomes an ERROR field, never a zero score', () => {
  const fields = mapCpuBenchmarkResults({
    single: { opsPerSecond: null, samples: [], spreadPercent: null, checksumStable: false, error: 'worker failed' },
    multi: { threads: 1, opsPerSecond: null, perThread: [], scaling: null, error: 'worker failed' },
    memory: { sequentialGbps: null, stridedGbps: null, error: 'worker failed' }
  });
  assert.equal(fields.singleCore.status, Status.ERROR);
  assert.equal(fields.singleCore.value, null);
  assert.equal(fields.scaling.status, Status.UNAVAILABLE);
  assert.equal(fields.sampleSpread.status, Status.UNAVAILABLE);
});

test('high run-to-run spread is flagged as an unstable measurement', () => {
  const fields = mapCpuBenchmarkResults({
    single: { opsPerSecond: 1000, samples: [800, 1200, 1000], spreadPercent: 40, checksumStable: true, error: null },
    multi: { threads: 2, opsPerSecond: 1800, perThread: [900, 900], scaling: null, error: null },
    memory: { sequentialGbps: 5, stridedGbps: 1, error: null },
    thermal: { before: 45, after: 78 }
  });
  assert.equal(fields.sampleSpread.status, Status.WARNING);
  assert.ok(fields.sampleSpread.notes.some((note) => note.includes('not idle')));
  assert.equal(fields.thermalDelta.value, 33);
});

test('missing temperature sensor during a benchmark is stated, not filled with a number', () => {
  const fields = mapCpuBenchmarkResults({
    single: { opsPerSecond: 1000, samples: [1000], spreadPercent: 0, checksumStable: true, error: null },
    multi: { threads: 2, opsPerSecond: 2000, perThread: [1000, 1000], scaling: null, error: null },
    memory: { sequentialGbps: 5, stridedGbps: 1, error: null },
    thermal: { before: null, after: null }
  });
  assert.equal(fields.thermalDelta.status, Status.UNAVAILABLE);
  assert.match(fields.thermalDelta.error, /No temperature sensor/);
});

test('the workload definition is bounded so a benchmark cannot run for minutes', () => {
  assert.ok(WORKLOAD.integerIterations > 0 && WORKLOAD.integerIterations < 100_000_000);
  assert.ok(WORKLOAD.repeats >= 1 && WORKLOAD.repeats <= 5);
});
