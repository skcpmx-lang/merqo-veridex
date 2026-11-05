/**
 * VERIDEX — Stress-test safety guard (MODULE 08, safety requirements).
 *
 * A stress test is the one feature in VERIDEX that can plausibly damage hardware if
 * it is written carelessly, so the safety rules live in their own module with no
 * dependency on the load generators. The guard is a state machine that owns:
 *
 *   1. explicit consent before the first sample;
 *   2. a bounded duration;
 *   3. pause / resume / stop;
 *   4. automatic stop on a thermal threshold, but ONLY when a real sensor exists —
 *      VERIDEX has no universal safe temperature and does not invent one;
 *   5. automatic stop if the machine reports an unexpected error or the monitor
 *      loop fails;
 *   6. a complete log of every state transition, which becomes part of the report.
 *
 * The guard refuses to start when it cannot meet a safety condition, and it says
 * which one. "Starts anyway and hopes" is not an option.
 */

import { Status } from '../core/status.js';
import { available, unavailable, field } from '../core/field.js';

export const StressState = Object.freeze({
  IDLE: 'IDLE',
  AWAITING_CONSENT: 'AWAITING_CONSENT',
  RUNNING: 'RUNNING',
  PAUSED: 'PAUSED',
  STOPPED_USER: 'STOPPED_USER',
  STOPPED_THERMAL: 'STOPPED_THERMAL',
  STOPPED_DURATION: 'STOPPED_DURATION',
  STOPPED_ERROR: 'STOPPED_ERROR',
  COMPLETED: 'COMPLETED'
});

/** States from which no further transition into RUNNING is allowed. */
const TERMINAL = new Set([
  StressState.STOPPED_USER,
  StressState.STOPPED_THERMAL,
  StressState.STOPPED_DURATION,
  StressState.STOPPED_ERROR,
  StressState.COMPLETED
]);

/**
 * @typedef {object} StressConfig
 * @property {'cpu'|'memory'|'gpu'|'disk'|'combined'} kind
 * @property {number} durationSec        Requested duration.
 * @property {number} maxDurationSec     Hard ceiling from settings.
 * @property {number} thermalLimitC      User-chosen ceiling.
 * @property {boolean} consentGiven
 * @property {number} threads            Load threads; capped to logical CPUs.
 */

/**
 * Decide whether a stress run may start, and if not, exactly why.
 *
 * @param {StressConfig} config
 * @param {{logicalCpus:number, thermalSensorAvailable:boolean, isOnBattery?:boolean|null}} environment
 * @returns {{allowed:boolean, problems:string[], warnings:string[], effective: StressConfig}}
 */
export function validateStressRequest(config, environment) {
  const problems = [];
  const warnings = [];

  const logical = Math.max(1, environment.logicalCpus || 1);
  const duration = Number(config.durationSec);
  const maxDuration = Number(config.maxDurationSec);
  const limit = Number(config.thermalLimitC);

  if (!Number.isFinite(duration) || duration < 10) problems.push('Duration must be at least 10 seconds.');
  if (!Number.isFinite(maxDuration) || maxDuration < 10) problems.push('The configured maximum duration is invalid.');
  if (Number.isFinite(duration) && Number.isFinite(maxDuration) && duration > maxDuration) {
    problems.push(`Requested duration (${duration}s) exceeds the configured maximum of ${maxDuration}s. Lower the duration or raise the ceiling in Performance settings.`);
  }
  if (!Number.isFinite(limit) || limit < 60 || limit > 110) problems.push('The thermal threshold must be between 60 °C and 110 °C.');

  // The brief forbids inventing a universal safe temperature. Without a sensor we
  // can still run, but the user must know the thermal stop cannot work.
  if (!environment.thermalSensorAvailable) {
    warnings.push(
      'No temperature sensor could be read, so the automatic thermal stop is inactive for this run. Keep the session short and watch the machine. VERIDEX will not invent a temperature reading to fill the gap.'
    );
  }

  if (environment.isOnBattery === true) {
    warnings.push('The machine is running on battery. A stress test will drain it quickly and may be cut short by the battery controller, so connect the charger first.');
  }

  if (config.kind === 'gpu') {
    warnings.push('GPU load is generated inside the renderer. On a laptop with switchable graphics this may drive the integrated GPU rather than the discrete one.');
  }

  if (config.kind === 'disk') {
    warnings.push('The disk stress test writes temporary files and deletes them. It is not a destructive test of stored data, but it does generate sustained write load.');
  }

  if (!config.consentGiven) problems.push('Explicit consent is required before a stress test can start.');

  const threads = Math.min(Math.max(1, Number(config.threads) || logical), logical);

  return {
    allowed: problems.length === 0,
    problems,
    warnings,
    effective: {
      ...config,
      durationSec: Math.min(Number.isFinite(duration) ? duration : 0, Number.isFinite(maxDuration) ? maxDuration : 0),
      threads,
      thermalLimitC: limit
    }
  };
}

/**
 * @typedef {object} StressTransition
 * @property {string} at        ISO timestamp
 * @property {string} from
 * @property {string} to
 * @property {string} reason
 * @property {number|null} temperatureC
 */

/**
 * The guard. One instance per run. Every transition is recorded, and the record is
 * what the report prints.
 */
export class StressGuard {
  /**
   * @param {{config: StressConfig, thermalSensorAvailable: boolean, now?: () => Date}} options
   */
  constructor(options) {
    this.config = options.config;
    this.thermalSensorAvailable = Boolean(options.thermalSensorAvailable);
    this.now = options.now ?? (() => new Date());
    this.state = StressState.IDLE;
    /** @type {StressTransition[]} */
    this.transitions = [];
    this.startedAt = null;
    this.stoppedAt = null;
    /** Wall-clock start, kept separately from the display timestamp so elapsed time
     *  stays correct even when the injected clock does not advance between ticks. */
    this.startedAtMs = null;
    this.stoppedAtMs = null;
    /** @type {{min:number|null, max:number|null, samples:number}} */
    this.thermal = { min: null, max: null, samples: 0 };
    this.stopReason = null;
  }

  /** @param {string} to @param {string} reason @param {number|null} temperatureC */
  #transition(to, reason, temperatureC = null) {
    const from = this.state;
    this.state = to;
    this.transitions.push({ at: this.now().toISOString(), from, to, reason, temperatureC });
    return this.state;
  }

  /**
   * Attempt to begin. Returns the state plus the reasons when refused.
   * @param {{logicalCpus:number, isOnBattery?:boolean|null}} environment
   */
  begin(environment) {
    const validation = validateStressRequest(this.config, {
      logicalCpus: environment.logicalCpus,
      thermalSensorAvailable: this.thermalSensorAvailable,
      isOnBattery: environment.isOnBattery
    });

    if (!validation.allowed) {
      this.#transition(StressState.IDLE, `refused to start: ${validation.problems.join(' ')}`);
      return { started: false, ...validation };
    }

    this.config = validation.effective;
    this.startedAt = this.now().toISOString();
    this.startedAtMs = this.now().getTime();
    this.#transition(StressState.RUNNING, `started ${this.config.kind} stress test for ${this.config.durationSec}s with ${this.config.threads} thread(s)`);
    return { started: true, ...validation };
  }

  /** @param {string} reason */
  pause(reason = 'paused by user') {
    if (this.state !== StressState.RUNNING) return { ok: false, state: this.state, reason: 'Only a running test can be paused.' };
    this.#transition(StressState.PAUSED, reason);
    return { ok: true, state: this.state };
  }

  resume() {
    if (this.state !== StressState.PAUSED) return { ok: false, state: this.state, reason: 'Only a paused test can be resumed.' };
    this.#transition(StressState.RUNNING, 'resumed by user');
    return { ok: true, state: this.state };
  }

  /** @param {string} reason */
  stop(reason = 'stopped by user') {
    if (TERMINAL.has(this.state)) return { ok: false, state: this.state, reason: 'The run has already finished.' };
    this.stoppedAt = this.now().toISOString();
    this.stoppedAtMs = this.now().getTime();
    this.stopReason = reason;
    this.#transition(StressState.STOPPED_USER, reason);
    return { ok: true, state: this.state };
  }

  /**
   * Feed one sensor sample. Returns the decision the caller must honour.
   *
   * @param {{temperatureC:number|null, elapsedSec:number, aborted?:string|null}} sample
   * @returns {{continue:boolean, state:string, reason:string|null}}
   */
  tick(sample) {
    if (this.state === StressState.PAUSED) return { continue: true, state: this.state, reason: null };
    if (this.state !== StressState.RUNNING) return { continue: false, state: this.state, reason: this.stopReason };

    const temperature = typeof sample.temperatureC === 'number' && Number.isFinite(sample.temperatureC) ? sample.temperatureC : null;
    if (temperature !== null) {
      this.thermal.samples += 1;
      this.thermal.min = this.thermal.min === null ? temperature : Math.min(this.thermal.min, temperature);
      this.thermal.max = this.thermal.max === null ? temperature : Math.max(this.thermal.max, temperature);

      // Only a real sensor can trigger a thermal stop. When there is no sensor the
      // guard says so once and never fabricates a reading.
      if (temperature >= this.config.thermalLimitC) {
        this.stoppedAt = this.now().toISOString();
        this.stoppedAtMs = this.now().getTime();
        this.stopReason = `thermal limit reached: ${temperature} °C is at or above the ${this.config.thermalLimitC} °C threshold you set`;
        this.#transition(StressState.STOPPED_THERMAL, this.stopReason, temperature);
        return { continue: false, state: this.state, reason: this.stopReason };
      }
    }

    if (typeof sample.aborted === 'string' && sample.aborted.length > 0) {
      this.stoppedAt = this.now().toISOString();
      this.stoppedAtMs = this.now().getTime();
      this.stopReason = `aborted: ${sample.aborted}`;
      this.#transition(StressState.STOPPED_ERROR, this.stopReason, temperature);
      return { continue: false, state: this.state, reason: this.stopReason };
    }

    if (sample.elapsedSec >= this.config.durationSec) {
      this.stoppedAt = this.now().toISOString();
      this.stoppedAtMs = this.now().getTime();
      this.stopReason = `completed the full ${this.config.durationSec}s duration`;
      this.#transition(StressState.STOPPED_DURATION, this.stopReason, temperature);
      return { continue: false, state: this.state, reason: this.stopReason };
    }

    return { continue: true, state: this.state, reason: null };
  }

  /** Elapsed wall-clock seconds since the run started. */
  elapsedSec() {
    if (this.startedAtMs === null) return 0;
    const end = this.stoppedAtMs ?? this.now().getTime();
    return Math.max(0, Math.round((end - this.startedAtMs) / 100) / 10);
  }

  /** True when the run reached a terminal state. */
  get finished() {
    return TERMINAL.has(this.state);
  }

  /**
   * Turn the guard's record into report fields.
   * @returns {Record<string, import('../core/field.js').FieldValue>}
   */
  toFields() {
    /** @type {Record<string, import('../core/field.js').FieldValue>} */
    const fields = {
      kind: available(this.config.kind, 'computed'),
      outcome: this.#outcomeField(),
      duration: this.elapsedSec(),
      requestedDuration: this.config.durationSec,
      thermalLimit: this.config.thermalLimitC,
      thermalSensorAvailable: this.thermalSensorAvailable
        ? available('Yes', 'computed', { notes: ['The thermal stop condition was active.'] })
        : field(null, {
            status: Status.UNAVAILABLE,
            source: 'computed',
            error: 'No temperature sensor was readable, so the thermal stop condition was inactive for this run. The run was still bounded by duration.',
            notes: ['VERIDEX does not substitute an estimated temperature for a missing sensor.']
          }),
      transitions: available(this.transitions.length, 'computed', {
        notes: this.transitions.map((entry) => `${entry.at} ${entry.from} → ${entry.to}: ${entry.reason}`)
      }),
      transitionLog: available(this.transitions.map((entry) => `${entry.at} ${entry.from} → ${entry.to}: ${entry.reason}`), 'computed', {
        notes: ['The complete state log for this run, including every stop condition that was evaluated.']
      })
    };

    fields.durationUnit = available('s', 'computed');
    fields.thermalMin = this.thermal.min !== null ? available(this.thermal.min, 'computed', { unit: '°C' }) : unavailable('No temperature sensor was readable', 'computed');
    fields.thermalMax = this.thermal.max !== null ? available(this.thermal.max, 'computed', { unit: '°C' }) : unavailable('No temperature sensor was readable', 'computed');
    fields.thermalSamples = this.thermal.samples > 0 ? available(this.thermal.samples, 'computed') : unavailable('No temperature samples', 'computed');
    fields.stopReason = this.stopReason ? available(this.stopReason, 'computed') : unavailable('The run did not stop', 'computed');
    fields.disclaimer = available('A stress test exercises the cooling system and power delivery. Passing it does not certify the hardware, and a failed run may indicate a thermal or power problem that warrants inspection.', 'documentation');
    return fields;
  }

  #outcomeField() {
    const map = {
      [StressState.COMPLETED]: { status: Status.PASS, text: 'Completed' },
      [StressState.STOPPED_DURATION]: { status: Status.PASS, text: 'Completed the requested duration' },
      [StressState.STOPPED_USER]: { status: Status.WARNING, text: 'Stopped by the user before completion' },
      [StressState.STOPPED_THERMAL]: { status: Status.WARNING, text: 'Stopped early: thermal threshold reached' },
      [StressState.STOPPED_ERROR]: { status: Status.ERROR, text: 'Stopped early because of an error' },
      [StressState.RUNNING]: { status: Status.UNTESTED, text: 'Still running' },
      [StressState.PAUSED]: { status: Status.UNTESTED, text: 'Paused' },
      [StressState.IDLE]: { status: Status.UNTESTED, text: 'Not started' },
      [StressState.AWAITING_CONSENT]: { status: Status.UNTESTED, text: 'Waiting for consent' }
    };
    const entry = map[this.state] ?? { status: Status.UNKNOWN, text: this.state };
    return field(entry.text, { status: entry.status, source: 'computed' });
  }
}

