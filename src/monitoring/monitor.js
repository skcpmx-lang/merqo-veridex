/**
 * VERIDEX — Live sensor monitoring (MODULE 09).
 *
 * Polls the sensors that actually exist and reports the ones that do not. The
 * sensor registry is deliberately explicit about which provider supplies each
 * reading and what its absence means, so the UI never shows a zero where a sensor is
 * missing.
 *
 * Polling is pause-aware and bounded: no timer runs while the window is hidden
 * (unless the user opts in), which keeps VERIDEX from competing with the machine it
 * is measuring.
 */

import { available, unavailable } from '../core/field.js';
import { Status } from '../core/status.js';
import { loadSystemInformation, queryCim } from '../platform/windows.js';
import { num, nonNegative } from '../platform/parse.js';
import { SeriesSet } from './series.js';

/**
 * The sensor registry. `probe` names the function used, which is what the UI and the
 * report print as the source.
 */
export const SENSORS = Object.freeze([
  { id: 'cpu.load', label: 'CPU utilisation', unit: '%', source: 'systeminformation.currentLoad', range: [0, 100] },
  { id: 'cpu.temp', label: 'CPU temperature', unit: '°C', source: 'MSAcpi_ThermalZoneTemperature / LibreHardwareMonitor WMI', range: [0, 130] },
  { id: 'cpu.clock', label: 'CPU clock', unit: 'MHz', source: 'systeminformation.cpuCurrentSpeed', range: [100, 7000] },
  { id: 'gpu.load', label: 'GPU utilisation', unit: '%', source: 'systeminformation.graphics', range: [0, 100] },
  { id: 'gpu.temp', label: 'GPU temperature', unit: '°C', source: 'systeminformation.graphics', range: [0, 130] },
  { id: 'gpu.power', label: 'GPU power draw', unit: 'W', source: 'systeminformation.graphics', range: [0, 1000] },
  { id: 'memory.used', label: 'Memory used', unit: '%', source: 'systeminformation.mem', range: [0, 100] },
  { id: 'storage.temp', label: 'Drive temperature', unit: '°C', source: 'Get-StorageReliabilityCounter', range: [0, 100] },
  { id: 'network.rx', label: 'Network received', unit: 'KB/s', source: 'systeminformation.networkStats', range: [0, 1e9] },
  { id: 'network.tx', label: 'Network sent', unit: 'KB/s', source: 'systeminformation.networkStats', range: [0, 1e9] },
  { id: 'fan.speed', label: 'Fan speed', unit: 'RPM', source: 'CIM Win32_Fan', range: [0, 12000] },
  { id: 'battery.percent', label: 'Battery charge', unit: '%', source: 'root\\wmi BatteryStatus', range: [0, 100] }
]);

/**
 * @param {string} id
 */
export function sensorDefinition(id) {
  return SENSORS.find((sensor) => sensor.id === id) ?? null;
}

/**
 * Validate a reading against its sensor's plausible range.
 * An out-of-range value is treated as a missing reading, because a sensor that
 * returns 0 °C or 7000 % is broken or uninitialised, not reporting a fact.
 *
 * @param {number|null} value
 * @param {string} id
 * @returns {number|null}
 */
export function sanitiseReading(value, id) {
  const definition = sensorDefinition(id);
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  if (definition?.range) {
    const [min, max] = definition.range;
    if (value < min || value > max) return null;
    // CPU/GPU temperatures of exactly 0 are the classic "no sensor" sentinel.
    if (definition.unit === '°C' && value <= 0) return null;
  }
  return value;
}

/**
 * Read every sensor once.
 *
 * @param {object} context
 * @param {import('../platform/runner.js').CommandRunner} context.runner
 * @param {boolean} [context.includePrivileged] Whether ACPI thermal zones may be queried.
 * @returns {Promise<{readings: Record<string, {value:number|null, source:string|null, status:string, reason:string|null}>, cpuTemperatureAvailable:boolean}>}
 */

/**
 * Honest deadline for a live counter.
 *
 * `systeminformation` shells out for several of these, and a WMI provider that has stopped
 * answering does not fail - it waits. Without a deadline the monitoring page sits on its first
 * sample forever, which looks exactly like an application that has hung. A timed-out counter is
 * recorded as unavailable with a reason, which is the same treatment every other missing value
 * gets.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<{ok:true, value:T} | {ok:false, reason:string}>}
 */
export function within(promise, ms, label) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, reason: `${label} did not answer within ${Math.round(ms / 1000)}s and was skipped` });
    }, ms);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: true, value });
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, reason: `${label} failed: ${error instanceof Error ? error.message : String(error)}` });
      }
    );
  });
}

export async function readSensors(context) {
  /** @type {Record<string, {value:number|null, source:string|null, status:string, reason:string|null}>} */
  const readings = {};
  const record = (id, value, reason = null) => {
    const definition = sensorDefinition(id);
    const sanitised = sanitiseReading(value, id);
    readings[id] = {
      value: sanitised,
      source: sanitised !== null ? definition?.source ?? null : null,
      status: sanitised !== null ? Status.PASS : Status.UNAVAILABLE,
      reason: sanitised !== null ? null : reason ?? `${definition?.label ?? id} is not exposed by any available provider on this system`
    };
  };

  // A counter that does not answer is unavailable, not a hang.
  const guarded = async (call, ms, label) => {
    const outcome = await within(Promise.resolve().then(call), ms, label);
    if (!outcome.ok) throw new Error(outcome.reason);
    return outcome.value;
  };

  const loaded = await loadSystemInformation();
  if (loaded.ok) {
    const si = loaded.si;
    try {
      const load = await guarded(() => si.currentLoad(), 4_000, 'The CPU load counter');
      record('cpu.load', num(load?.currentLoad) === null ? null : Math.round((num(load.currentLoad) ?? 0) * 10) / 10);
    } catch {
      record('cpu.load', null, 'CPU load counters could not be read');
    }

    try {
      const speed = await guarded(() => si.cpuCurrentSpeed(), 4_000, 'The CPU clock counter');
      const avg = num(speed?.avg);
      record('cpu.clock', avg !== null && avg > 0 ? Math.round(avg * 1000) : null, 'The OS did not report a current CPU clock');
    } catch {
      record('cpu.clock', null, 'CPU clock could not be read');
    }

    try {
      const graphics = await guarded(() => si.graphics(), 5_000, 'Graphics counters');
      const controllers = Array.isArray(graphics?.controllers) ? graphics.controllers : [];
      const utilisation = controllers.map((controller) => num(controller.utilizationGpu)).filter((value) => value !== null);
      record('gpu.load', utilisation.length > 0 ? Math.round((utilisation[0] ?? 0) * 10) / 10 : null, 'This GPU driver does not expose a utilisation counter');
      const temperatures = controllers.map((controller) => num(controller.temperatureGpu)).filter((value) => value !== null);
      record('gpu.temp', temperatures.length > 0 ? temperatures[0] : null, 'No GPU temperature sensor is available on this system');
      const power = controllers.map((controller) => num(controller.powerDraw)).filter((value) => value !== null);
      record('gpu.power', power.length > 0 ? power[0] : null, 'This GPU driver does not report power draw');
    } catch {
      record('gpu.load', null, 'Graphics counters could not be read');
    }

    try {
      const mem = await guarded(() => si.mem(), 4_000, 'Memory counters');
      const total = nonNegative(mem?.total);
      const used = nonNegative(mem?.used);
      record('memory.used', total && used !== null && total > 0 ? Math.round((used / total) * 1000) / 10 : null, 'Memory counters could not be read');
    } catch {
      record('memory.used', null, 'Memory counters could not be read');
    }

    try {
      const stats = await guarded(() => si.networkStats(), 5_000, 'Network statistics');
      const first = Array.isArray(stats) ? stats[0] : null;
      const rx = nonNegative(first?.rx_sec);
      const tx = nonNegative(first?.tx_sec);
      record('network.rx', rx !== null ? Math.round(rx / 1024) : null, 'No active network interface is reporting statistics');
      record('network.tx', tx !== null ? Math.round(tx / 1024) : null, 'No active network interface is reporting statistics');
    } catch {
      record('network.rx', null, 'Network statistics could not be read');
      record('network.tx', null, 'Network statistics could not be read');
    }

    try {
      const battery = await guarded(() => si.battery(), 5_000, 'Battery state');
      const percent = num(battery?.percent);
      // A machine with no battery reports percent 0; that is an absence, not a
      // charge level, so it must not appear as "0 %".
      const hasBattery = battery?.hasBattery !== false && battery?.hasBattery !== null && battery?.hasBattery !== undefined;
      record('battery.percent', percent !== null && percent > 0 && hasBattery ? Math.round(percent * 10) / 10 : null, 'No battery is present on this system');
    } catch {
      record('battery.percent', null, 'Battery state could not be read');
    }
  } else {
    for (const id of ['cpu.load', 'cpu.clock', 'gpu.load', 'gpu.temp', 'gpu.power', 'memory.used', 'network.rx', 'network.tx', 'battery.percent']) {
      record(id, null, `systeminformation is unavailable: ${loaded.error}`);
    }
  }

  // ACPI thermal zone: the only temperature source available without a licensed
  // kernel driver. It requires elevation and many firmware implementations expose a
  // zone whose value is a fixed placeholder, so a value is only accepted when it is
  // plausible and *changes* would be needed to trust it fully — we accept it but
  // label the source precisely.
  if (context.includePrivileged) {
    const thermal = await queryCim(context.runner, 'MSAcpi_ThermalZoneTemperature', { namespace: 'root/wmi', name: 'sensor:thermalzone', timeoutMs: 8000 });
    if (thermal.ok) {
      const temperatures = thermal.rows
        .map((row) => num(row.CurrentTemperature))
        .filter((value) => value !== null)
        .map((tenthsKelvin) => Math.round((tenthsKelvin / 10 - 273.15) * 10) / 10);
      const plausible = temperatures.filter((value) => value > 0 && value < 130);
      record(
        'cpu.temp',
        plausible.length > 0 ? plausible[0] : null,
        plausible.length === 0 ? 'The ACPI thermal zone exists but returned an implausible value, which many firmware implementations do' : null
      );
    } else {
      record('cpu.temp', null, thermal.accessDenied ? 'ACPI thermal zones require administrator rights' : 'This firmware does not expose an ACPI thermal zone');
    }
  } else {
    record('cpu.temp', null, 'ACPI thermal zones require administrator rights, so CPU temperature is unavailable in standard-user mode');
  }

  // Drive temperature comes from the storage reliability counters, which are also
  // privileged.
  if (context.includePrivileged) {
    const storage = await context.runner.powershellJson('(Get-PhysicalDisk | Get-StorageReliabilityCounter | Where-Object { $_.Temperature -gt 0 } | Select-Object -First 1).Temperature', { name: 'sensor:drivetemp', timeoutMs: 12_000 });
    const value = Array.isArray(storage.data) ? storage.data[0] : storage.data;
    record('storage.temp', num(value), 'No drive reported a temperature');
  } else {
    record('storage.temp', null, 'Drive temperature requires administrator rights');
  }

  // Fan speed: genuinely rare through WMI, and often returns a static value.
  const fans = await queryCim(context.runner, 'Win32_Fan', { namespace: 'root/cimv2', name: 'sensor:fan', timeoutMs: 8000 });
  if (fans.ok) {
    const speeds = fans.rows.map((row) => num(row.DesiredSpeed) ?? num(row.ActiveCooling)).filter((value) => value !== null && value > 0);
    record('fan.speed', speeds.length > 0 ? speeds[0] : null, 'Windows does not expose fan speed on this system; that is normal for most laptops.');
  } else {
    record('fan.speed', null, 'This system does not expose fan speed through WMI');
  }

  return {
    readings,
    cpuTemperatureAvailable: readings['cpu.temp']?.value !== null
  };
}

/**
 * The polling monitor.
 */
export class Monitor {
  /**
   * @param {object} options
   * @param {import('../platform/runner.js').CommandRunner} options.runner
   * @param {number} [options.intervalMs]
   * @param {number} [options.historyPoints]
   * @param {(snapshot: object) => void} [options.onSample]
   * @param {(error: Error) => void} [options.onError]
   */
  constructor(options) {
    this.runner = options.runner;
    this.intervalMs = Math.max(500, options.intervalMs ?? 1500);
    this.series = new SeriesSet({ capacity: options.historyPoints ?? 120 });
    this.onSample = options.onSample ?? (() => {});
    this.onError = options.onError ?? (() => {});
    this.timer = null;
    this.running = false;
    this.samples = 0;
    this.includePrivileged = false;
    this.lastReadings = {};
  }

  /** @param {boolean} value */
  setPrivileged(value) {
    this.includePrivileged = Boolean(value);
  }

  /** Change the polling interval while running. */
  setInterval(intervalMs) {
    this.intervalMs = Math.max(500, Number(intervalMs) || 1500);
    if (this.running) {
      this.#schedule();
    }
  }

  start() {
    if (this.running) return this;
    this.running = true;
    this.#tick();
    return this;
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return this;
  }

  #schedule() {
    if (this.timer) clearTimeout(this.timer);
    if (!this.running) return;
    this.timer = setTimeout(() => this.#tick(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  async #tick() {
    if (!this.running) return;
    try {
      const result = await readSensors({ runner: this.runner, includePrivileged: this.includePrivileged });
      this.lastReadings = result.readings;
      const at = new Date().toISOString();
      for (const definition of SENSORS) {
        const series = this.series.ensure({ id: definition.id, label: definition.label, unit: definition.unit });
        const reading = result.readings[definition.id];
        series.push(reading?.value ?? null, { at, source: reading?.source ?? null });
      }
      this.samples += 1;
      this.onSample({
        at,
        samples: this.samples,
        readings: result.readings,
        series: this.series.snapshot()
      });
    } catch (error) {
      this.onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.#schedule();
    }
  }

  /** Current readings plus which sensors are unavailable and why. */
  status() {
    return SENSORS.map((definition) => {
      const reading = this.lastReadings[definition.id];
      return {
        id: definition.id,
        label: definition.label,
        unit: definition.unit,
        source: definition.source,
        value: reading?.value ?? null,
        status: reading?.status ?? Status.UNTESTED,
        reason: reading?.reason ?? 'No sample has been taken yet'
      };
    });
  }

  /**
   * Report fields from the monitoring session. Unavailable sensors keep their
   * explanation instead of a zero.
   * @returns {Record<string, import('../core/field.js').FieldValue>}
   */
  toFields() {
    /** @type {Record<string, import('../core/field.js').FieldValue>} */
    const fields = {};
    for (const entry of this.status()) {
      const stats = this.series.get(entry.id)?.stats();
      fields[entry.id] = entry.value !== null
        ? available(entry.value, entry.source, { unit: entry.unit ?? undefined, notes: stats ? [`min ${stats.min}, max ${stats.max}, average ${stats.average} over ${stats.samples} samples.`] : [] })
        : unavailable(entry.reason, entry.source);
    }
    fields.sampleCount = available(this.samples, 'monitor');
    return fields;
  }
}
