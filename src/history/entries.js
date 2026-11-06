/**
 * VERIDEX — history entries for runs that are not scans.
 *
 * `HistoryStore` documents six kinds and only scans were ever written: a benchmark or a stress
 * run finished, its numbers stayed in memory, and the History page never learned they happened.
 * R-24-01 names benchmarks and stress runs explicitly, so this module builds those entries.
 *
 * It is pure and unit-tested, and it lives here rather than in `main.js` because the shapes it
 * reads (a CPU result, a disk result, a stress result) are the parts most likely to drift. A
 * summary that silently reads a field the runner has renamed is worse than no summary: it
 * produces a history row full of nulls that looks like a run which measured nothing.
 */

/**
 * The peak temperature a stress run observed, or null when it never read a sensor.
 *
 * Null is not zero. A run on a machine with no readable thermal sensor did not run at 0 °C, and
 * writing 0 would make "no sensor" indistinguishable from "impossibly cold".
 *
 * @param {Array<{temperatureC?: number|null}>} samples
 * @returns {number|null}
 */
export function peakTemperatureOf(samples) {
  const readings = (Array.isArray(samples) ? samples : [])
    .map((sample) => sample?.temperatureC)
    .filter((value) => typeof value === 'number' && Number.isFinite(value));
  return readings.length > 0 ? Math.max(...readings) : null;
}

/**
 * Flatten a computed field map into the snapshot shape the comparison reads.
 *
 * The comparison works on `path -> value` pairs built from what the page rendered, so a history
 * entry built this way describes exactly the numbers the user saw.
 *
 * @param {Record<string, {value?: unknown}>} fields
 */
export function fieldsSnapshot(fields) {
  /** @type {Record<string, unknown>} */
  const flat = {};
  for (const [key, field] of Object.entries(fields ?? {})) flat[key] = field?.value ?? null;
  return flat;
}

/**
 * A CPU benchmark entry.
 *
 * @param {{mode?: string, results?: any, durationMs?: number|null, at?: string|null}} run
 * @param {{appVersion?: string|null, finishedAt?: string}} options
 */
export function cpuBenchmarkEntry(run, options = {}) {
  const results = run?.results ?? {};
  return {
    kind: 'benchmark',
    startedAt: run?.at ?? null,
    finishedAt: options.finishedAt ?? new Date().toISOString(),
    durationMs: run?.durationMs ?? null,
    appVersion: options.appVersion ?? null,
    summary: {
      benchmark: 'cpu',
      mode: run?.mode ?? null,
      singleCoreOpsPerSec: results.single?.opsPerSecond ?? null,
      multiCoreOpsPerSec: results.multi?.opsPerSecond ?? null,
      memoryGbps: results.memory?.sequentialGbps ?? null,
      threads: results.multi?.threads ?? null
    },
    snapshot: fieldsSnapshot(run?.fields)
  };
}

/**
 * A disk benchmark entry.
 *
 * @param {{fields?: any, cleanup?: {removed?: boolean}, sizeMb?: number|null, allowWrite?: boolean, at?: string|null}} run
 * @param {{appVersion?: string|null, finishedAt?: string, durationMs?: number|null}} options
 */
export function diskBenchmarkEntry(run, options = {}) {
  const fields = run?.fields ?? {};
  return {
    kind: 'benchmark',
    startedAt: run?.at ?? null,
    finishedAt: options.finishedAt ?? new Date().toISOString(),
    durationMs: options.durationMs ?? null,
    appVersion: options.appVersion ?? null,
    summary: {
      benchmark: 'disk',
      sizeMb: run?.sizeMb ?? null,
      writeTested: run?.allowWrite === true,
      sequentialReadMbps: fields.sequentialRead?.value ?? null,
      sequentialWriteMbps: fields.sequentialWrite?.value ?? null,
      randomReadIops: fields.randomReadIops?.value ?? null,
      randomReadLatencyMs: fields.randomReadLatency?.value ?? null,
      tempFileRemoved: run?.cleanup?.removed === true
    },
    snapshot: fieldsSnapshot(fields)
  };
}

/**
 * A GPU benchmark entry, or null when the probe could not measure.
 *
 * @param {{measurement?: any, fields?: any, at?: string|null}} run
 * @param {{appVersion?: string|null, finishedAt?: string}} options
 */
export function gpuBenchmarkEntry(run, options = {}) {
  const measurement = run?.measurement ?? null;
  if (!measurement || measurement.supported !== true) return null;
  const fields = run?.fields ?? {};
  return {
    kind: 'benchmark',
    startedAt: run?.at ?? null,
    finishedAt: options.finishedAt ?? new Date().toISOString(),
    durationMs: measurement.durationMs ?? null,
    appVersion: options.appVersion ?? null,
    summary: {
      benchmark: 'gpu',
      frameTimeMs: fields.gpuFrameTime?.value ?? measurement.frameTimeMs ?? null,
      fillRatePixelsPerSecond: fields.gpuFillRate?.value ?? measurement.pixelsPerSecond ?? null,
      adapter: measurement.renderer ?? measurement.adapter ?? null
    },
    snapshot: fieldsSnapshot(fields)
  };
}

/**
 * A stress-run entry, or null when the guard refused to start the run.
 *
 * @param {any} result
 * @param {{appVersion?: string|null, requestedDurationSec?: number|null, threads?: number|null, at?: string|null}} options
 */
export function stressEntry(result, options = {}) {
  if (!result || result.started !== true) return null;
  const samples = Array.isArray(result.samples) ? result.samples : [];
  return {
    kind: 'stress',
    startedAt: options.at ?? null,
    finishedAt: new Date().toISOString(),
    durationMs: typeof result.elapsedSec === 'number' ? Math.round(result.elapsedSec * 1000) : null,
    appVersion: options.appVersion ?? null,
    summary: {
      kind: result.kind ?? 'cpu',
      state: result.state ?? null,
      stopReason: result.stopReason ?? null,
      threads: result.threads ?? options.threads ?? null,
      requestedDurationSec: options.requestedDurationSec ?? result.requestedSec ?? null,
      peakTemperatureC: peakTemperatureOf(samples),
      temperatureObserved: samples.some((sample) => typeof sample?.temperatureC === 'number'),
      completed: result.completed === true
    },
    snapshot: {
      'stress.state': result.state ?? null,
      'stress.stopReason': result.stopReason ?? null,
      'stress.elapsedSec': typeof result.elapsedSec === 'number' ? Math.round(result.elapsedSec) : null,
      'stress.peakTemperatureC': peakTemperatureOf(samples)
    }
  };
}
