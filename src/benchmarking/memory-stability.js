/**
 * VERIDEX — memory stability check.
 *
 * R-08-03 asked for "RAM performance, bandwidth and stability tests". Bandwidth was measured
 * from the first phase; the stability half was never built, and the requirement stayed `IP` for
 * exactly that reason.
 *
 * What this does, and what it refuses to claim:
 *
 *   - It allocates a bounded buffer, writes a deterministic pattern into it, reads it back and
 *     counts the words that do not match, once per pass. A mismatch is real evidence: the value
 *     that went in did not come out.
 *   - It does **not** claim the memory is healthy when there is no mismatch. Zero mismatches over
 *     a few hundred megabytes for a few seconds catches gross faults and nothing else — not a
 *     marginal cell, not an error that needs heat or hours to appear. The verdict field is
 *     `UNRATED` for that reason, and the note says so in those words.
 *   - It cannot say *which* module failed. Consumer hardware offers no such attribution without
 *     an error-correcting platform, and inventing one would be the worst thing this file could do.
 *
 * The measurement runs in a worker so the window stays responsive and a runaway pass can be
 * terminated rather than waited for.
 */

import { field, available, unavailable, failed } from '../core/field.js';
import { Status } from '../core/status.js';
import { runInWorker } from './cpu-bench.js';

/** Hard bounds. A stability check that could exhaust RAM is a denial-of-service, not a test. */
export const MEMORY_STABILITY_LIMITS = Object.freeze({
  minMegabytes: 64,
  maxMegabytes: 1024,
  defaultMegabytes: 256,
  minPasses: 1,
  maxPasses: 20,
  defaultPasses: 3,
  deadlineMs: 60_000
});

/**
 * Decide whether a stability check may start.
 *
 * Consent is required for the same reason it is required for the disk write test: the check
 * takes real memory and real time, and a diagnostic tool that quietly allocates a gigabyte
 * because someone closed a dialog is not a diagnostic tool.
 *
 * @param {{megabytes?: number, passes?: number, consentGiven?: boolean}} options
 * @returns {{ok: boolean, reason?: string, effective?: {megabytes: number, passes: number}}}
 */
export function validateStabilityOptions(options = {}) {
  if (options.consentGiven !== true) {
    return { ok: false, reason: 'A memory stability check needs explicit consent: it allocates real memory and holds it for several seconds.' };
  }
  const megabytes = options.megabytes === undefined || options.megabytes === null ? MEMORY_STABILITY_LIMITS.defaultMegabytes : Number(options.megabytes);
  if (!Number.isFinite(megabytes) || !Number.isInteger(megabytes)) {
    return { ok: false, reason: 'The buffer size must be a whole number of megabytes.' };
  }
  if (megabytes < MEMORY_STABILITY_LIMITS.minMegabytes || megabytes > MEMORY_STABILITY_LIMITS.maxMegabytes) {
    return {
      ok: false,
      reason: `The buffer size must be between ${MEMORY_STABILITY_LIMITS.minMegabytes} and ${MEMORY_STABILITY_LIMITS.maxMegabytes} MB. A larger buffer would compete with the operating system for memory.`
    };
  }
  const passes = options.passes === undefined || options.passes === null ? MEMORY_STABILITY_LIMITS.defaultPasses : Number(options.passes);
  if (!Number.isFinite(passes) || !Number.isInteger(passes)) {
    return { ok: false, reason: 'The pass count must be a whole number.' };
  }
  if (passes < MEMORY_STABILITY_LIMITS.minPasses || passes > MEMORY_STABILITY_LIMITS.maxPasses) {
    return {
      ok: false,
      reason: `The pass count must be between ${MEMORY_STABILITY_LIMITS.minPasses} and ${MEMORY_STABILITY_LIMITS.maxPasses}.`
    };
  }
  return { ok: true, effective: { megabytes, passes } };
}

/**
 * Run the check through a worker (the default) or an injected runner.
 *
 * @param {{megabytes?: number, passes?: number, consentGiven?: boolean, signal?: AbortSignal|null,
 *          runner?: (task: {kind: string, payload: Record<string, unknown>}, timeoutMs: number, signal: AbortSignal|null) => Promise<any>,
 *          now?: () => number}} options
 */
export async function runMemoryStability(options = {}) {
  const validation = validateStabilityOptions(options);
  if (!validation.ok) {
    return { started: false, refused: true, reason: validation.reason, fields: { memoryStability: failed(validation.reason, 'memory-stability') } };
  }

  const { megabytes, passes } = validation.effective;
  const runner = options.runner ?? runInWorker;
  const startedAt = (options.now ?? Date.now)();
  const worker = await runner(
    { kind: 'memory-stability', payload: { megabytes, passes } },
    MEMORY_STABILITY_LIMITS.deadlineMs,
    options.signal ?? null
  ).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }));

  const durationMs = (options.now ?? Date.now)() - startedAt;
  if (!worker || worker.ok !== true) {
    const reason = worker?.cancelled ? 'The check was cancelled before it finished.' : (worker?.error ?? 'The memory worker did not return a result.');
    return {
      started: true,
      refused: false,
      cancelled: worker?.cancelled === true,
      megabytes,
      passes: 0,
      bytesVerified: 0,
      mismatches: null,
      durationMs,
      reason,
      fields: { memoryStability: failed(reason, 'memory-stability') }
    };
  }

  const mismatches = Number(worker.mismatches ?? 0);
  const passesCompleted = Number(worker.passesCompleted ?? passes);
  return {
    started: true,
    refused: false,
    cancelled: false,
    megabytes,
    passes: passesCompleted,
    bytesVerified: Number(worker.bytesVerified ?? megabytes * 1024 * 1024 * passesCompleted),
    mismatches,
    durationMs,
    reason: null,
    fields: mapMemoryStabilityResults({ megabytes, passes: passesCompleted, bytesVerified: Number(worker.bytesVerified ?? megabytes * 1024 * 1024 * passesCompleted), mismatches, durationMs })
  };
}

/**
 * Turn a completed check into fields.
 *
 * @param {{megabytes: number, passes: number, bytesVerified: number, mismatches: number, durationMs: number}} result
 */
export function mapMemoryStabilityResults(result) {
  const source = 'memory-stability';
  /** @type {Record<string, import('../core/field.js').FieldValue>} */
  const fields = {};

  const mismatchCount = Number(result.mismatches);
  fields.memoryStability = Number.isFinite(mismatchCount) && mismatchCount > 0
    ? field(mismatchCount, {
        unit: 'words',
        status: Status.FAIL,
        source,
        confidence: 'MEDIUM',
        notes: [
          'The pattern did not survive a write/read round trip in the buffer this check allocated.',
          'That is real evidence of a fault, but it does not identify which module: consumer hardware gives no attribution without ECC. It can also be a defect in this check rather than in the memory, which is why the whole run is worth repeating before drawing a conclusion.'
        ]
      })
    : available(0, source, {
        unit: 'words',
        status: Status.UNRATED,
        notes: [
          'A read-back of the buffer this check allocated over ' + `${result.passes} pass${result.passes === 1 ? '' : 'es'} of ${result.megabytes} MB` + ' matched the written pattern at every position.',
          'That is not a clean bill of health. It catches gross faults and nothing else: a marginal cell, a fault that needs heat, or an error the operating system corrected before this process ever saw it will not appear here.',
          'No module is identified, because the hardware offers no such attribution.'
        ]
      });

  fields.memoryStabilityPasses = available(result.passes, source, { unit: 'passes' });
  fields.memoryStabilityBytes = available(result.bytesVerified, source, { unit: 'bytes' });
  fields.memoryStabilityDuration = available(Math.round(result.durationMs), source, { unit: 'ms' });
  fields.verdict = field(null, {
    status: Status.UNRATED,
    source,
    error: 'A stability check has no verdict. It reports how much memory it round-tripped and whether every word matched. Zero mismatches over a few hundred megabytes is not proof that the memory is good.',
    notes: ['Comparable between two VERIDEX runs only at the same buffer size and pass count.']
  });
  return fields;
}

/** Fields a stability check contributes to the responsiveness composite: none. */
export function memoryStabilityOf() {
  return null;
}

export { unavailable };
