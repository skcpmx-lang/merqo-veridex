/**
 * VERIDEX — Stress run controller.
 *
 * The safety rules live in `stress-guard.js`; this module is the part that actually applies load,
 * samples the machine while it does, and stops. The split matters: the guard decides, this runs.
 *
 * Design decisions, all of them deliberate:
 *
 *   - **CPU only.** CPU load is the one stress test VERIDEX can generate in-process, bound in
 *     time, and stop on request. Memory stress risks the swap file and the whole desktop; disk
 *     stress is the disk benchmark under a different name; GPU stress would be a canvas animation
 *     whose "load" cannot be verified from inside Electron. Those are refused with the reason
 *     rather than approximated.
 *   - **Nothing runs unless the guard allows it.** Consent, a bounded duration and a thermal
 *     ceiling are all validated before a worker starts.
 *   - **A thermal stop only exists when a sensor exists.** No sensor means the guard says so and
 *     the run is bounded by duration alone.
 *   - **No PASS.** A run reports what was measured: duration, temperatures, threads, and the
 *     complete transition log. A stress test that "passed" certifies nothing, so this module has
 *     no verdict to give.
 *   - **Workers are terminated, never abandoned.** Every path — completion, cancellation,
 *     thermal stop, error — tears down the whole pool before returning.
 *
 * Dependencies are injectable so the controller can be tested without pinning a real CPU for a
 * minute: `spawnLoad`, `readTemperature`, `now`, and `sampleIntervalMs`.
 */

import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { StressGuard, validateStressRequest, StressState } from './stress-guard.js';
import { field, available, unavailable } from '../core/field.js';
import { Status } from '../core/status.js';

const WORKER_PATH = new URL('./worker.js', import.meta.url);

/** Kinds VERIDEX can actually generate and stop. Anything else is refused, not faked. */
export const SUPPORTED_STRESS_KINDS = Object.freeze(['cpu']);

/** Refusal text for the kinds that are named in the specification but not implemented. */
export const UNSUPPORTED_STRESS_KINDS = Object.freeze({
  memory: 'Memory stress is not implemented: filling RAM on Windows forces paging and can freeze the desktop before any stop condition is reached. The memory benchmark measures bandwidth instead.',
  gpu: 'GPU stress is not implemented: a canvas animation inside Electron cannot be verified as GPU load, and on switchable-graphics laptops it usually drives the integrated GPU. Reporting it as a GPU test would be a claim the application cannot support.',
  disk: 'Disk stress is not implemented as a stress test: sustained write load is what the disk benchmark already measures, and it does so with a documented temporary file and a cleanup guarantee.',
  combined: 'Combined stress is not implemented: it would run the kinds above at once, including the ones that are refused.'
});

/**
 * Start a CPU stress run.
 *
 * @param {{
 *   durationSec?: number,
 *   threads?: number,
 *   thermalLimitC?: number,
 *   maxDurationSec?: number,
 *   consentGiven?: boolean,
 *   kind?: string,
 *   isOnBattery?: boolean|null,
 *   signal?: AbortSignal,
 *   onSample?: (sample: {elapsedSec:number, temperatureC:number|null, state:string}) => void,
 *   readTemperature?: () => Promise<number|null>|number|null,
 *   logicalCpus?: number,
 *   spawnLoad?: (options: {threads:number, budgetMs:number}) => {stop: () => Promise<void>},
 *   now?: () => number,
 *   sampleIntervalMs?: number,
 *   wait?: (ms:number) => Promise<void>
 * }} [options]
 */
export async function runCpuStress(options = {}) {
  const kind = String(options.kind ?? 'cpu');
  if (!SUPPORTED_STRESS_KINDS.includes(kind)) {
    return {
      started: false,
      refused: true,
      reason: UNSUPPORTED_STRESS_KINDS[kind] ?? `Stress kind "${kind}" is not supported.`,
      fields: {}
    };
  }

  const now = options.now ?? (() => Date.now());
  const wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const logicalCpus = options.logicalCpus ?? Math.max(1, os.cpus()?.length ?? 1);
  const readTemperature = options.readTemperature ?? (() => null);
  const thermalSensorAvailable = options.thermalSensorAvailable ?? typeof options.readTemperature === 'function';

  const config = {
    kind,
    durationSec: Number(options.durationSec ?? 60),
    maxDurationSec: Number(options.maxDurationSec ?? 300),
    thermalLimitC: Number(options.thermalLimitC ?? 90),
    consentGiven: options.consentGiven === true,
    threads: Number(options.threads ?? logicalCpus)
  };

  const environment = {
    logicalCpus,
    thermalSensorAvailable: Boolean(thermalSensorAvailable),
    isOnBattery: options.isOnBattery ?? null
  };

  const validation = validateStressRequest(config, environment);
  if (!validation.allowed) {
    return { started: false, refused: true, reason: validation.problems.join(' '), problems: validation.problems, warnings: validation.warnings, fields: {} };
  }

  const guard = new StressGuard({
    config: validation.effective,
    thermalSensorAvailable: Boolean(thermalSensorAvailable),
    now: () => new Date(now())
  });
  guard.begin(environment);

  const spawnLoad = options.spawnLoad ?? defaultSpawnLoad;
  const threads = validation.effective.threads;
  const budgetMs = validation.effective.durationSec * 1000;
  let load = null;
  let stopReason = null;
  let temperatureReadings = 0;
  /** @type {{elapsedSec:number, temperatureC:number|null, state:string}[]} */
  const samples = [];

  const stopLoad = async () => {
    if (!load) return;
    const current = load;
    load = null;
    await current.stop().catch(() => {});
  };

  try {
    load = spawnLoad({ threads, budgetMs });

    const interval = Math.max(100, Number(options.sampleIntervalMs ?? 1_000));
    for (;;) {
      if (options.signal?.aborted) {
        guard.stop('stopped by user');
        break;
      }
      if (guard.elapsedSec() * 1000 >= budgetMs) {
        // The guard decides completion, on its own clock, so the reported duration is the one the
        // safety rules measured rather than one assembled here.
        const decision = guard.tick({ temperatureC: null, elapsedSec: guard.elapsedSec() });
        if (!decision.continue) break;
      }

      await wait(interval);

      let temperatureC = null;
      try {
        const reading = await readTemperature();
        temperatureC = typeof reading === 'number' && Number.isFinite(reading) ? reading : null;
        if (temperatureC !== null) temperatureReadings += 1;
      } catch {
        // A sensor that throws is a missing sensor, not a zero reading.
        temperatureC = null;
      }

      const decision = guard.tick({ temperatureC, elapsedSec: guard.elapsedSec() });
      const sample = { elapsedSec: guard.elapsedSec(), temperatureC, state: decision.state };
      samples.push(sample);
      options.onSample?.(sample);

      if (!decision.continue) {
        stopReason = decision.reason;
        break;
      }
    }
  } catch (error) {
    guard.tick({ temperatureC: null, elapsedSec: guard.elapsedSec(), aborted: error instanceof Error ? error.message : String(error) });
    stopReason = guard.stopReason;
  } finally {
    await stopLoad();
  }

  const fields = guard.toFields();
  fields.threads = available(threads, 'computed', { notes: ['One worker per thread; each runs the same deterministic integer loop.'] });
  fields.loadKind = available('CPU, integer workload, isolated worker threads', 'computed');
  fields.sampleCount = available(samples.length, 'computed');
  // A sensor that exists but never reported a number is not a working thermal stop. The
  // difference is reported rather than smoothed over: this is the one safety condition that
  // depends on hardware the application cannot guarantee.
  const thermalApplied = thermalSensorAvailable && temperatureReadings > 0;
  if (!thermalApplied) {
    fields.thermalLimitApplied = field(null, {
      status: Status.UNAVAILABLE,
      source: 'computed',
      error: 'The thermal limit was configured but could not be applied: no temperature reading arrived during this run.',
      notes: ['The run was bounded by its duration instead.']
    });
  } else {
    fields.thermalLimitApplied = available('Yes', 'computed', { notes: [`Threshold: ${validation.effective.thermalLimitC} °C.`] });
  }
  const effectiveWarnings = [...validation.warnings];
  if (!thermalApplied && !effectiveWarnings.some((warning) => /thermal stop/.test(warning))) {
    effectiveWarnings.push('The thermal stop is inactive for this run: no temperature reading was available, so the run was bounded by its duration alone.');
  }
  fields.verdict = field(null, {
    status: Status.UNRATED,
    source: 'computed',
    error: 'A stress run has no verdict. It reports how long the load ran, how hot the machine got while it did, and why it stopped. That is not a pass and it is not a certification.',
    notes: ['Hardware faults are intermittent; surviving one run of one workload proves nothing about a future one.']
  });

  return {
    started: true,
    refused: false,
    kind,
    threads,
    requestedSec: validation.effective.durationSec,
    elapsedSec: guard.elapsedSec(),
    state: guard.state,
    completed: guard.state === StressState.STOPPED_DURATION || guard.state === StressState.COMPLETED,
    stopReason: stopReason ?? guard.stopReason,
    warnings: effectiveWarnings,
    samples,
    transitions: guard.transitions,
    fields
  };
}

/**
 * The real load: one worker per thread, each with the same hard deadline as the session.
 * @param {{threads:number, budgetMs:number}} options
 */
export function defaultSpawnLoad({ threads, budgetMs }) {
  const workers = Array.from({ length: threads }, () => new Worker(WORKER_PATH, { workerData: { kind: 'stress', payload: { budgetMs } } }));
  return {
    async stop() {
      await Promise.all(
        workers.map(async (worker) => {
          try {
            worker.postMessage({ type: 'stop' });
          } catch {
            // The worker may already be gone; terminating below is the fallback.
          }
          await worker.terminate().catch(() => {});
        })
      );
    }
  };
}

/** Whether this machine can produce a temperature reading at all, for the UI to state honestly. */
export function stressCapabilities({ thermalSensorAvailable = false, logicalCpus = null } = {}) {
  return {
    kinds: [...SUPPORTED_STRESS_KINDS],
    unsupported: { ...UNSUPPORTED_STRESS_KINDS },
    thermalSensorAvailable: Boolean(thermalSensorAvailable),
    logicalCpus: logicalCpus ?? Math.max(1, os.cpus()?.length ?? 1)
  };
}

export { unavailable };
