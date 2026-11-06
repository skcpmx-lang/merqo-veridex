/**
 * VERIDEX — CPU benchmarking (MODULE 08).
 *
 * Single-core and multi-core measurements using the deterministic workloads in
 * worker.js, with a bounded worker pool.
 *
 * Honesty requirements baked in:
 *  - The unit is *operations per second reported by this build on this machine*.
 *    It is not comparable to any other tool's score, and VERIDEX says so in the
 *    result rather than implying a universal rating.
 *  - The measurement is repeated three times and the median is reported, with the
 *    spread disclosed. A single run on a thermally throttled laptop is noise.
 *  - If a temperature sensor is readable, the run records it before and after, so a
 *    throttle during the test is visible rather than guessed at.
 */

import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { available, unavailable, failed, field } from '../core/field.js';
import { Status } from '../core/status.js';

const WORKER_PATH = fileURLToPath(new URL('./worker.js', import.meta.url));

/** Iteration counts chosen so a single core takes roughly 200–600 ms on modern hardware. */
export const WORKLOAD = Object.freeze({
  integerIterations: 12_000_000,
  hashRounds: 4000,
  memoryElements: 4_000_000,
  repeats: 3
});

/**
 * Run one task in a fresh worker.
 * @param {{kind:string, payload:Record<string, unknown>}} task
 * @param {number} timeoutMs
 * @returns {Promise<{ok:boolean, checksum:number, durationMs:number, error?:string}>}
 */
export function runInWorker(task, timeoutMs = 60_000, signal = null) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const worker = new Worker(WORKER_PATH, { workerData: task });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
      worker.terminate().catch(() => {});
      resolve({ ...result, wallMs: Date.now() - started });
    };

    // A benchmark the user has cancelled must stop *now*: the worker holding a core at full
    // load is the whole cost of the measurement, and there is nothing left to measure once the
    // request is withdrawn.
    const onAbort = () => finish({ ok: false, checksum: 0, durationMs: Date.now() - started, error: 'cancelled', cancelled: true });
    if (signal) {
      if (signal.aborted) {
        worker.terminate().catch(() => {});
        resolve({ ok: false, checksum: 0, durationMs: 0, error: 'cancelled', cancelled: true, wallMs: 0 });
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const timer = setTimeout(() => finish({ ok: false, checksum: 0, durationMs: Date.now() - started, error: `worker exceeded ${timeoutMs}ms` }), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    worker.once('message', (message) => finish(message));
    worker.once('error', (error) => finish({ ok: false, checksum: 0, durationMs: Date.now() - started, error: error.message }));
    worker.once('exit', (code) => {
      if (!settled) finish({ ok: false, checksum: 0, durationMs: Date.now() - started, error: `worker exited with code ${code} without reporting` });
    });
  });
}

/**
 * Median of a numeric list.
 * @param {number[]} values
 * @returns {number|null}
 */
export function median(values) {
  const list = (Array.isArray(values) ? values : []).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (list.length === 0) return null;
  const middle = Math.floor(list.length / 2);
  return list.length % 2 === 0 ? (list[middle - 1] + list[middle]) / 2 : list[middle];
}

/**
 * Spread of a numeric list, as a percentage of the median.
 * @param {number[]} values
 * @returns {number|null}
 */
export function relativeSpread(values) {
  const list = (Array.isArray(values) ? values : []).filter((value) => Number.isFinite(value));
  if (list.length < 2) return null;
  const centre = median(list);
  if (!centre) return null;
  return Math.round(((Math.max(...list) - Math.min(...list)) / centre) * 1000) / 10;
}

/**
 * Run the single-core benchmark: `repeats` integer workloads on one worker.
 * @param {{repeats?:number, onProgress?:(p:{done:number,total:number})=>void}} [options]
 * @returns {Promise<{opsPerSecond:number|null, samples:number[], spreadPercent:number|null, checksumStable:boolean, error:string|null}>}
 */
export async function benchmarkSingleCore(options = {}) {
  const repeats = options.repeats ?? WORKLOAD.repeats;
  const results = [];

  for (let index = 0; index < repeats; index += 1) {
    if (options.signal?.aborted) {
      return { opsPerSecond: null, samples: [], spreadPercent: null, checksumStable: false, error: 'cancelled', cancelled: true };
    }
    const result = await runInWorker({ kind: 'integer', payload: { iterations: WORKLOAD.integerIterations } }, 60_000, options.signal);
    if (!result.ok) {
      return {
        opsPerSecond: null,
        samples: [],
        spreadPercent: null,
        checksumStable: false,
        error: result.error ?? 'worker failed',
        cancelled: result.cancelled === true
      };
    }
    results.push({ durationMs: result.durationMs, checksum: result.checksum });
    options.onProgress?.({ done: index + 1, total: repeats });
  }

  const samples = results.map((entry) => (entry.durationMs > 0 ? Math.round((WORKLOAD.integerIterations / entry.durationMs) * 1000) : 0));
  const opsPerSecond = median(samples);
  const checksums = new Set(results.map((entry) => entry.checksum));

  return {
    opsPerSecond,
    samples,
    spreadPercent: relativeSpread(samples),
    checksumStable: checksums.size === 1,
    error: null
  };
}

/**
 * Run the multi-core benchmark across all logical processors in a bounded pool.
 * One worker per logical CPU, capped to avoid oversubscribing a heavily loaded
 * machine and to keep memory sane.
 *
 * @param {{threads?:number, onProgress?:(p:{done:number,total:number})=>void}} [options]
 * @returns {Promise<{threads:number, opsPerSecond:number|null, perThread:number[], scaling:number|null, error:string|null}>}
 */
export async function benchmarkMultiCore(options = {}) {
  const logical = Math.max(1, os.cpus()?.length ?? 1);
  const threads = Math.min(options.threads ?? logical, 64);

  const results = await Promise.all(
    Array.from({ length: threads }, () =>
      runInWorker({ kind: 'integer', payload: { iterations: WORKLOAD.integerIterations } }, 120_000, options.signal)
    )
  );
  if (results.some((result) => result.cancelled)) {
    return { threads: 0, opsPerSecond: null, perThread: [], scaling: null, error: 'cancelled', cancelled: true };
  }

  const healthy = results.filter((result) => result.ok);
  if (healthy.length === 0) {
    return { threads, opsPerSecond: null, perThread: [], scaling: null, error: results[0]?.error ?? 'all workers failed' };
  }

  const perThread = healthy.map((result) => (result.durationMs > 0 ? Math.round((WORKLOAD.integerIterations / result.durationMs) * 1000) : 0));
  const total = perThread.reduce((sum, value) => sum + value, 0);

  return {
    threads: healthy.length,
    opsPerSecond: Math.round(total),
    perThread,
    scaling: null,
    error: healthy.length < threads ? `${threads - healthy.length} of ${threads} workers failed` : null
  };
}

/**
 * Memory bandwidth measurement: sequential versus strided traversal.
 * @returns {Promise<{sequentialGbps:number|null, stridedGbps:number|null, error:string|null}>}
 */
export async function benchmarkMemoryBandwidth(options = {}) {
  const result = await runInWorker({ kind: 'memory', payload: { elements: WORKLOAD.memoryElements } }, 120_000, options.signal);
  if (!result.ok) {
    return {
      sequentialGbps: null,
      stridedGbps: null,
      error: result.error ?? 'worker failed',
      cancelled: result.cancelled === true
    };
  }

  const bytes = WORKLOAD.memoryElements * 8;
  const gbps = (fraction) => (result.durationMs > 0 ? Math.round(((bytes * fraction) / (result.durationMs / 1000) / 1e9) * 100) / 100 : null);

  // The workload walks the buffer twice: once sequentially (every element) and once
  // strided (1 in 8). The reported figures attribute the full traversal time to each
  // pass so they are comparable in shape, not summed.
  return { sequentialGbps: gbps(1), stridedGbps: gbps(1 / 8), error: null };
}

/**
 * Convert raw CPU benchmark results into report fields.
 * @param {{single: Awaited<ReturnType<typeof benchmarkSingleCore>>, multi: Awaited<ReturnType<typeof benchmarkMultiCore>>, memory: Awaited<ReturnType<typeof benchmarkMemoryBandwidth>>, thermal?: {before:number|null, after:number|null}, startedAt?:string, durationMs?:number}} results
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function mapCpuBenchmarkResults(results) {
  const source = 'computed';
  /** @type {Record<string, import('../core/field.js').FieldValue>} */
  const fields = {};

  fields.singleCore = results.single.opsPerSecond !== null
    ? available(results.single.opsPerSecond, source, {
        unit: 'ops/s',
        notes: [
          'VERIDEX benchmark units. Comparable between runs of VERIDEX on the same workload, not comparable to other tools\' scores.',
          `Median of ${results.single.samples.length} samples; spread ${results.single.spreadPercent ?? 'unknown'}%.`
        ]
      })
    : failed(results.single.error ?? 'single-core benchmark failed', source);

  fields.multiCore = results.multi.opsPerSecond !== null
    ? available(results.multi.opsPerSecond, source, { unit: 'ops/s', notes: [`Measured across ${results.multi.threads} worker threads.`] })
    : failed(results.multi.error ?? 'multi-core benchmark failed', source);

  if (results.single.opsPerSecond && results.multi.opsPerSecond && results.multi.threads > 0) {
    const scaling = Math.round((results.multi.opsPerSecond / results.single.opsPerSecond) * 100) / 100;
    const efficiency = Math.round((scaling / results.multi.threads) * 1000) / 10;
    fields.scaling = available(scaling, source, {
      unit: '×',
      notes: [
        `Multi-core throughput divided by single-core throughput across ${results.multi.threads} threads.`,
        `Threading efficiency is ${efficiency}% of linear. Efficiency below about 60% is normal on laptops with power limits, and is also what thermal throttling looks like.`
      ]
    });
  } else {
    fields.scaling = unavailable('Scaling cannot be computed without both single- and multi-core results', source);
  }

  fields.memoryBandwidth = results.memory.sequentialGbps !== null
    ? available(results.memory.sequentialGbps, source, { unit: 'GB/s', notes: ['Sequential read bandwidth from a managed-code traversal. Real-world bandwidth is higher because managed memory access carries overhead; use this for run-to-run comparison, not as a specification figure.'] })
    : failed(results.memory.error ?? 'memory bandwidth benchmark failed', source);

  fields.sampleSpread = results.single.spreadPercent !== null
    ? field(`${results.single.spreadPercent}%`, {
        status: results.single.spreadPercent > 15 ? Status.WARNING : Status.PASS,
        source,
        notes: results.single.spreadPercent > 15
          ? ['Run-to-run spread above 15% suggests the machine was not idle, was power-limited, or was throttling during the test. The median is still reported, but treat the figure with caution.']
          : ['Run-to-run spread is low, which indicates a stable measurement.']
      })
    : unavailable('Only one sample was taken, so no spread can be reported', source);

  fields.singleCoreChecksum = results.single.checksumStable
    ? available('Identical across samples', source, { notes: ['Confirms the workload performed identical work each run.'] })
    : field('Checksums differed between samples', { status: Status.WARNING, source, notes: ['A differing checksum can indicate memory instability or an interrupted run.'] });

  if (results.thermal && (results.thermal.before !== null || results.thermal.after !== null)) {
    const before = results.thermal.before;
    const after = results.thermal.after;
    fields.thermalDelta = before !== null && after !== null
      ? available(Math.round((after - before) * 10) / 10, source, { unit: '°C', notes: [`Temperature went from ${before} °C before the test to ${after} °C after it.`] })
      : unavailable('A temperature reading was only available on one side of the test', source);
  } else {
    fields.thermalDelta = unavailable('No temperature sensor was readable during the benchmark', source);
  }

  if (results.durationMs) fields.duration = available(Math.round(results.durationMs / 100) / 10, source, { unit: 's' });

  return fields;
}
