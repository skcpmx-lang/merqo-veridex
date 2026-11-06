/**
 * VERIDEX — System responsiveness composite (R-08-06).
 *
 * The requirement asks for "a system responsiveness composite score from measured subsystems"
 * with a "documented weighted aggregation". Two things follow from the words:
 *
 *   1. **measured** — every input is a figure some part of the application actually took. Nothing
 *      is estimated from a model name, a core count or a specification sheet.
 *   2. **documented** — the weights, the reference points and the arithmetic are here, in one
 *      function, and printed with the result. A composite whose formula is hidden is a number a
 *      user cannot argue with, which is the worst property a diagnostic figure can have.
 *
 * Gating: fewer than two measured subsystems produces UNRATED, not a score. A "responsiveness
 * score" built from one number is that number wearing a different name.
 *
 * Subsystems and weights (each normalised to 0..1, higher is better):
 *
 *   cpu     35%   single-core ops/s against a reference of 20M ops/s
 *   memory  20%   sequential bandwidth against a reference of 20 GB/s
 *   disk    25%   random-read latency, inverted, against a reference of 0.2 ms
 *   gpu     20%   frame time from the WebGL workload, inverted, against a reference of 16.7 ms
 *   loop     -    event-loop lag is *reported* and used as a **penalty**, not a weighted input:
 *                 it measures the application's own health during the run, not the machine.
 *
 * The reference points are deliberately generous and clearly arbitrary: they exist to turn a
 * measurement into a comparable 0..100, and the result field says so.
 */

import { Status } from '../core/status.js';
import { field, available, unavailable } from '../core/field.js';

/** Weights and reference points, exported so the documentation and the tests read the same values. */
export const RESPONSIVENESS_MODEL = Object.freeze({
  weights: Object.freeze({ cpu: 0.35, memory: 0.2, disk: 0.25, gpu: 0.2 }),
  reference: Object.freeze({
    cpuSingleOpsPerSec: 20_000_000,
    memoryBandwidthGbps: 20,
    diskRandomReadMs: 0.2,
    gpuFrameTimeMs: 16.7
  }),
  minimumInputs: 2,
  eventLoopPenaltyPerMs: 4,
  eventLoopPenaltyCap: 30
});

const clamp01 = (value) => Math.min(1, Math.max(0, value));

/**
 * @typedef {object} ResponsivenessInputs
 * @property {number|null} [cpuSingleOpsPerSec]
 * @property {number|null} [memoryBandwidthGbps]
 * @property {number|null} [diskRandomReadMs]
 * @property {number|null} [gpuFrameTimeMs]
 * @property {number|null} [eventLoopLagMs]
 */

/**
 * Compute the composite.
 * @param {ResponsivenessInputs} inputs
 * @returns {{
 *   score: number|null,
 *   rating: string,
 *   status: string,
 *   measured: string[],
 *   missing: string[],
 *   contributions: {id:string, weight:number, normalized:number, points:number}[],
 *   penalty: number,
 *   statement: string,
 *   model: typeof RESPONSIVENESS_MODEL
 * }}
 */
export function computeResponsiveness(inputs = {}) {
  const finite = (value) => typeof value === 'number' && Number.isFinite(value);

  const candidates = [
    {
      id: 'cpu',
      label: 'Single-core speed',
      weight: RESPONSIVENESS_MODEL.weights.cpu,
      raw: finite(inputs.cpuSingleOpsPerSec) ? inputs.cpuSingleOpsPerSec : null,
      normalized: finite(inputs.cpuSingleOpsPerSec)
        ? clamp01(inputs.cpuSingleOpsPerSec / RESPONSIVENESS_MODEL.reference.cpuSingleOpsPerSec)
        : null
    },
    {
      id: 'memory',
      label: 'Memory bandwidth',
      weight: RESPONSIVENESS_MODEL.weights.memory,
      raw: finite(inputs.memoryBandwidthGbps) ? inputs.memoryBandwidthGbps : null,
      normalized: finite(inputs.memoryBandwidthGbps)
        ? clamp01(inputs.memoryBandwidthGbps / RESPONSIVENESS_MODEL.reference.memoryBandwidthGbps)
        : null
    },
    {
      id: 'disk',
      label: 'Random-read latency',
      weight: RESPONSIVENESS_MODEL.weights.disk,
      raw: finite(inputs.diskRandomReadMs) ? inputs.diskRandomReadMs : null,
      // Lower latency is better: the reference is the point that scores full marks.
      normalized: finite(inputs.diskRandomReadMs) && inputs.diskRandomReadMs > 0
        ? clamp01(RESPONSIVENESS_MODEL.reference.diskRandomReadMs / inputs.diskRandomReadMs)
        : null
    },
    {
      id: 'gpu',
      label: 'Frame time',
      weight: RESPONSIVENESS_MODEL.weights.gpu,
      raw: finite(inputs.gpuFrameTimeMs) ? inputs.gpuFrameTimeMs : null,
      normalized: finite(inputs.gpuFrameTimeMs) && inputs.gpuFrameTimeMs > 0
        ? clamp01(RESPONSIVENESS_MODEL.reference.gpuFrameTimeMs / inputs.gpuFrameTimeMs)
        : null
    }
  ];

  const measured = candidates.filter((entry) => entry.normalized !== null);
  const missing = candidates.filter((entry) => entry.normalized === null).map((entry) => entry.id);

  if (measured.length < RESPONSIVENESS_MODEL.minimumInputs) {
    return {
      score: null,
      rating: 'Unrated',
      status: Status.UNRATED,
      measured: measured.map((entry) => entry.id),
      missing,
      contributions: [],
      penalty: 0,
      statement: `A responsiveness score needs at least ${RESPONSIVENESS_MODEL.minimumInputs} measured subsystems; this run has ${measured.length}. Run the CPU and disk benchmarks, or the full set, and the composite appears.`,
      model: RESPONSIVENESS_MODEL
    };
  }

  // Weights are renormalised over what was measured, so a machine is not penalised for a
  // benchmark that was not run — and the result names which subsystems it covers.
  const weightSum = measured.reduce((total, entry) => total + entry.weight, 0);
  const contributions = measured.map((entry) => {
    const weight = entry.weight / weightSum;
    return {
      id: entry.id,
      label: entry.label,
      weight,
      normalized: Math.round(entry.normalized * 1000) / 1000,
      points: Math.round(entry.normalized * weight * 1000) / 10
    };
  });

  const base = contributions.reduce((total, entry) => total + entry.points, 0);
  const lag = finite(inputs.eventLoopLagMs) ? Math.max(0, inputs.eventLoopLagMs) : null;
  const penalty = lag === null
    ? 0
    : Math.min(RESPONSIVENESS_MODEL.eventLoopPenaltyCap, Math.round(lag * RESPONSIVENESS_MODEL.eventLoopPenaltyPerMs * 10) / 10);
  const score = Math.max(0, Math.min(100, Math.round(base - penalty)));

  const rating = score >= 85 ? 'Excellent' : score >= 70 ? 'Good' : score >= 50 ? 'Fair' : 'Poor';

  return {
    score,
    rating,
    status: measured.length === candidates.length ? Status.PASS : Status.WARNING,
    measured: measured.map((entry) => entry.id),
    missing,
    contributions,
    penalty,
    statement:
      `Weighted over ${measured.length} of ${candidates.length} subsystems (${measured.map((entry) => entry.label).join(', ')})` +
      (missing.length > 0 ? `; ${missing.join(', ')} not measured and excluded rather than assumed` : '') +
      (penalty > 0 ? `; ${lag} ms event-loop lag while measuring cost ${penalty} points` : '') +
      '. The reference points are documented in src/benchmarking/responsiveness.js and are not a hardware specification.',
    model: RESPONSIVENESS_MODEL
  };
}

/**
 * The composite as report fields.
 * @param {ResponsivenessInputs} inputs
 */
export function responsivenessFields(inputs = {}) {
  const result = computeResponsiveness(inputs);
  /** @type {Record<string, import('../core/field.js').FieldValue>} */
  const fields = {};

  if (result.score === null) {
    fields.responsiveness = unavailable(result.statement, 'computed');
  } else {
    fields.responsiveness = available(result.score, 'computed', {
      unit: 'of 100',
      status: result.status,
      notes: [result.statement, ...result.contributions.map((entry) => `${entry.label}: ${Math.round(entry.normalized * 100)}% of its reference, worth ${entry.points} of 100 at weight ${entry.weight.toFixed(2)}.`)]
    });
  }
  fields.responsivenessRating = result.score === null ? unavailable('No composite was computed', 'computed') : available(result.rating, 'computed');
  fields.responsivenessInputs = available(result.measured.join(', ') || 'none', 'computed', {
    notes: result.missing.length > 0 ? [`Not measured: ${result.missing.join(', ')}.`] : []
  });
  return fields;
}
