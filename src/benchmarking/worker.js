/**
 * VERIDEX — Benchmark workers.
 *
 * Benchmarks run in worker threads so the UI stays responsive and the measurement
 * is not distorted by render work. Each worker performs a fixed, deterministic
 * amount of work and reports how long it took, so the result is reproducible and
 * comparable across runs and machines.
 *
 * The workloads are deliberately simple and stable:
 *   - integer/float mixed arithmetic loop (ALU + FPU + branch prediction)
 *   - memory-bandwidth walk over a typed array
 *   - a hash round (dependency-chained ops, hard to optimise away)
 *
 * Every loop accumulates into a value that is returned, which prevents the JIT from
 * eliminating the work as dead code — the classic way CPU benchmarks lie.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { createHash, randomBytes } from 'node:crypto';

/**
 * Mixed integer/float workload.
 * @param {number} iterations
 * @returns {number} checksum, returned so the work cannot be optimised away
 */
export function integerWorkload(iterations) {
  let acc = 0x2545f491;
  let f = 1.0000001;
  for (let index = 0; index < iterations; index += 1) {
    acc = (acc * 1664525 + 1013904223) | 0;
    acc ^= acc >>> 13;
    f = f * 1.000001 + 0.000001;
    if ((index & 1023) === 0) f = f - Math.floor(f) + 1;
  }
  return (acc >>> 0) + Math.floor(f * 1e6);
}

/**
 * Dependency-chained hash rounds: each result feeds the next, so it cannot be
 * parallelised inside a core.
 * @param {number} rounds
 * @returns {string}
 */
export function hashWorkload(rounds) {
  let value = 'veridex-benchmark-seed';
  for (let index = 0; index < rounds; index += 1) {
    value = createHash('sha256').update(value).digest('hex');
  }
  return value.slice(0, 16);
}

/**
 * Sequential and strided memory traversal over a Float64Array.
 * @param {Float64Array} buffer
 * @returns {{sum:number, stridedSum:number}}
 */
export function memoryWorkload(buffer) {
  let sum = 0;
  for (let index = 0; index < buffer.length; index += 1) sum += buffer[index];

  let stridedSum = 0;
  const stride = 8;
  for (let index = 0; index < buffer.length; index += stride) stridedSum += buffer[index];

  return { sum, stridedSum };
}

/**
 * Dispatcher used by the worker entry point.
 * @param {{kind:string, payload:Record<string, unknown>}} task
 */
export function runTask(task) {
  const started = process.hrtime.bigint();
  let checksum = 0;

  switch (task?.kind) {
    case 'integer':
      checksum = integerWorkload(Number(task.payload?.iterations ?? 1_000_000));
      break;
    case 'hash': {
      const digest = hashWorkload(Number(task.payload?.rounds ?? 1000));
      checksum = digest.length;
      break;
    }
    case 'memory': {
      const size = Number(task.payload?.elements ?? 1_000_000);
      const buffer = new Float64Array(size);
      // Fill with a deterministic pattern so two runs are comparable.
      let seed = 0x9e3779b9;
      for (let index = 0; index < size; index += 1) {
        seed = (seed * 1103515245 + 12345) >>> 0;
        buffer[index] = (seed % 1000) / 1000;
      }
      const result = memoryWorkload(buffer);
      checksum = Math.round((result.sum + result.stridedSum) % 1_000_000);
      break;
    }
    case 'noise': {
      // Generates unpredictable bytes so a hash/entropy measurement is not
      // measuring a cache-resident constant.
      checksum = randomBytes(32).length;
      break;
    }
    default:
      throw new Error(`Unknown benchmark task "${task?.kind}"`);
  }

  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  return { checksum, durationMs, kind: task.kind };
}

// Only wire up the message port when actually loaded as a worker.
if (parentPort) {
  try {
    const result = runTask(workerData);
    parentPort.postMessage({ ok: true, ...result });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}
