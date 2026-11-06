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
 * Sustained CPU load for a stress run.
 *
 * The loop burns for 25 ms, then yields so a `stop` message can be delivered: a synchronous
 * busy loop would ignore the stop button for its whole duration, which is the opposite of what a
 * stress test with an emergency stop has to do. It also stops itself on its own deadline, so a
 * parent that dies takes the load with it instead of leaving every core pinned.
 *
 * @param {number} budgetMs
 * @param {{onChunk?:(iterations:number)=>void, shouldStop?:()=>boolean}} [options]
 */
export async function stressWorkload(budgetMs, options = {}) {
  const deadline = Date.now() + Math.max(0, budgetMs);
  let iterations = 0;
  let acc = 0x2545f491;

  while (Date.now() < deadline && options.shouldStop?.() !== true) {
    const chunkEnd = Date.now() + 25;
    while (Date.now() < chunkEnd) {
      for (let index = 0; index < 20_000; index += 1) {
        acc = (acc * 1664525 + 1013904223) | 0;
        acc ^= acc >>> 13;
      }
      iterations += 1;
      if (iterations % 8 === 0 && options.shouldStop?.() === true) break;
    }
    options.onChunk?.(iterations);
    // Yield so a message from the parent can be delivered.
    await new Promise((resolve) => setImmediate(resolve));
  }

  return { iterations, checksum: acc >>> 0 };
}

/**
 * Write a deterministic pattern into a buffer, read it back, and count what changed.
 *
 * The pattern is computed from the index and never stored twice: comparing against a second copy
 * would double the memory cost and let one fault corrupt both copies the same way. Recomputation
 * means a mismatch means "the word read is not the word this index must hold".
 *
 * @param {{megabytes:number, passes:number, shouldStop?: () => boolean,
 *          onPass?: (info: {pass:number, mismatches:number}) => void}} options
 */
export async function memoryStabilityWorkload({ megabytes, passes, shouldStop = () => false, onPass = () => {} }) {
  const bytes = Math.round(megabytes) * 1024 * 1024;
  const words = Math.max(1, Math.floor(bytes / 4));
  const buffer = new Uint32Array(words);
  const pattern = (index) => ((index * 2654435761) ^ 0x9e3779b9) >>> 0;

  let mismatches = 0;
  let passesCompleted = 0;
  let bytesVerified = 0;

  for (let pass = 0; pass < passes; pass += 1) {
    if (shouldStop()) break;
    // Fill in chunks and yield between them: one 1 GB loop would hold the thread for hundreds of
    // milliseconds and make the stop button feel broken.
    for (let start = 0; start < words; start += 65536) {
      const end = Math.min(words, start + 65536);
      for (let index = start; index < end; index += 1) buffer[index] = pattern(index);
      await new Promise((resolve) => setImmediate(resolve));
      if (shouldStop()) break;
    }
    if (shouldStop()) break;

    let passMismatches = 0;
    for (let start = 0; start < words; start += 65536) {
      const end = Math.min(words, start + 65536);
      for (let index = start; index < end; index += 1) {
        if (buffer[index] !== pattern(index)) passMismatches += 1;
      }
      await new Promise((resolve) => setImmediate(resolve));
      if (shouldStop()) break;
    }

    mismatches += passMismatches;
    passesCompleted += 1;
    bytesVerified += bytes;
    onPass({ pass: pass + 1, mismatches: passMismatches });
    if (shouldStop()) break;
  }

  return { mismatches, passesCompleted, bytesVerified, megabytes };
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
    case 'stress': {
      // Handled asynchronously below; a synchronous case here would block the message port.
      throw new Error('stress tasks are dispatched asynchronously');
    }
    case 'memory-stability': {
      // Also asynchronous: it yields between passes so a stop message can be delivered.
      throw new Error('memory-stability tasks are dispatched asynchronously');
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
  if (workerData?.kind === 'memory-stability') {
    memoryStabilityWorkload({
      megabytes: Number(workerData?.payload?.megabytes ?? 256),
      passes: Number(workerData?.payload?.passes ?? 3)
    })
      .then((result) => parentPort.postMessage({ ok: true, ...result, kind: 'memory-stability' }))
      .catch((error) => parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  } else if (workerData?.kind === 'stress') {
    let stopRequested = false;
    parentPort.on('message', (message) => {
      if (message?.type === 'stop') stopRequested = true;
    });
    const started = process.hrtime.bigint();
    stressWorkload(Number(workerData?.payload?.budgetMs ?? 0), { shouldStop: () => stopRequested })
      .then((result) => {
        parentPort.postMessage({
          ok: true,
          ...result,
          durationMs: Number(process.hrtime.bigint() - started) / 1e6,
          kind: 'stress'
        });
      })
      .catch((error) => {
        parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });
  } else {
    try {
      const result = runTask(workerData);
      parentPort.postMessage({ ok: true, ...result });
    } catch (error) {
      parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
}
