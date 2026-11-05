/**
 * VERIDEX — Battery diagnostics (MODULE 02).
 *
 * The rules that shape this module, straight from the brief and from what battery
 * firmware actually reports:
 *
 *  - Health = fullCharge / design × 100, computed ONLY when both capacities are
 *    present, positive and mutually plausible. Firmware frequently reports 0, or a
 *    full-charge capacity larger than the design capacity on a replaced pack. Both
 *    cases must produce "cannot be calculated", never a number.
 *  - Cycle count is reported only when firmware exposes it. It is never estimated
 *    from power-on hours, wear or usage patterns.
 *  - Runtime is split into "reported by firmware" and "measured by VERIDEX". A
 *    predicted runtime and an observed runtime are different facts and are labelled
 *    as such.
 *  - Every collection method's success and failure is logged individually, because
 *    "battery data failed" is useless to a technician when the fix is "run as admin
 *    so the WMI battery classes load".
 *
 * Desktop machines with no battery produce NOT_APPLICABLE, not an error.
 */

import { available, unavailable, notApplicable, field, failed, unsupported } from '../core/field.js';
import { Status } from '../core/status.js';
import { cleanString, num, nonNegative, bool, date } from '../platform/parse.js';
import { queryCim, runReadOnly, loadSystemInformation, failureToStatus, readRegistry } from '../platform/windows.js';

/** Plausibility window for a computed health percentage. */
export const HEALTH_PLAUSIBLE_RANGE = Object.freeze({ min: 5, max: 115 });

/**
 * Compute battery health from capacities.
 *
 * @param {unknown} designCapacity  mWh or mWh-equivalent
 * @param {unknown} fullChargeCapacity
 * @returns {{health:number|null, wear:number|null, status:string, reason:string|null, notes:string[]}}
 */
export function computeHealth(designCapacity, fullChargeCapacity) {
  const design = nonNegative(designCapacity);
  const full = nonNegative(fullChargeCapacity);
  const notes = [];

  if (design === null || design === 0) {
    return {
      health: null,
      wear: null,
      status: Status.UNAVAILABLE,
      reason: 'Design capacity was not reported by the battery firmware, so health cannot be calculated.',
      notes
    };
  }
  if (full === null || full === 0) {
    return {
      health: null,
      wear: null,
      status: Status.UNAVAILABLE,
      reason: 'Full-charge capacity was not reported (or reported as zero), so health cannot be calculated.',
      notes
    };
  }

  const health = Math.round((full / design) * 1000) / 10;
  const wear = Math.round((100 - health) * 10) / 10;

  if (health > HEALTH_PLAUSIBLE_RANGE.max) {
    // Keep the computed figure but state why it cannot be taken as a real health
    // reading. Some controllers over-report a freshly calibrated pack by a few
    // percent, so a small overshoot is normal; a large one is not.
    notes.push(
      `Full-charge capacity (${full} mWh) exceeds the design capacity (${design} mWh) by more than the plausible range. This usually means the pack was replaced with a larger one, or the design capacity was never updated by the firmware.`
    );
  }

  // Below the minimum plausible value the reading is more likely a firmware fault
  // than a genuinely destroyed battery, so it is reported as UNKNOWN rather than a
  // dramatic number the user would act on.
  if (health < HEALTH_PLAUSIBLE_RANGE.min) {
    return {
      health: null,
      wear: null,
      status: Status.UNKNOWN,
      reason: `The computed health of ${health}% is below ${HEALTH_PLAUSIBLE_RANGE.min}%, which is more likely a firmware reporting fault than real capacity. Reporting it as a figure would be misleading.`,
      notes: [...notes, `Raw capacities: design ${design} mWh, full charge ${full} mWh.`]
    };
  }

  if (wear > 90) notes.push('Capacity has fallen by more than 90%: the pack will provide very little runtime.');

  // A health figure above 100% is not a healthy battery, it is an inconsistent
  // report; surfacing it as PASS would be a false positive.
  const status = health > HEALTH_PLAUSIBLE_RANGE.max ? Status.WARNING : wear >= 80 ? Status.FAIL : wear >= 20 ? Status.WARNING : Status.PASS;

  return {
    health,
    wear,
    status,
    reason: null,
    notes
  };
}

/**
 * Map a `Win32_Battery` instance.
 * @param {object} battery
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function mapWin32Battery(battery) {
  const source = 'cim-win32';
  if (!battery || typeof battery !== 'object') return { present: unavailable('Win32_Battery returned no instance', source) };

  const statusCode = num(battery.BatteryStatus);
  /** Win32_Battery.BatteryStatus meanings (CIM schema). */
  const STATUS_TEXT = {
    1: 'Discharging (AC not connected)',
    2: 'AC connected, not charging',
    3: 'Fully charged',
    4: 'Low',
    5: 'Critical',
    6: 'Charging',
    7: 'Charging and high',
    8: 'Charging and low',
    9: 'Charging and critical',
    10: 'Undefined',
    11: 'Partially charged'
  };
  const chemistryCode = num(battery.Chemistry);
  const CHEMISTRY = { 1: 'Other', 2: 'Unknown', 3: 'Lead acid', 4: 'Nickel cadmium', 5: 'Nickel metal hydride', 6: 'Lithium-ion', 7: 'Zinc air', 8: 'Lithium polymer' };

  const estimatedRuntime = nonNegative(battery.EstimatedRunTime);
  const fields = {
    present: available('Present', source),
    name: cleanString(battery.Name) ? available(cleanString(battery.Name), source) : unavailable('Battery name not reported', source),
    deviceId: cleanString(battery.DeviceID) ? available(cleanString(battery.DeviceID), source) : unavailable('Battery device id not reported', source),
    manufacturer: cleanString(battery.Manufacturer) ? available(cleanString(battery.Manufacturer), source) : unavailable('Battery manufacturer not exposed by this firmware', source),
    chemistry: chemistryCode !== null && CHEMISTRY[chemistryCode] ? available(CHEMISTRY[chemistryCode], source) : unavailable('Battery chemistry not reported', source),
    statusText: statusCode !== null && STATUS_TEXT[statusCode] ? available(STATUS_TEXT[statusCode], source) : unavailable('Battery status not reported', source),
    chargePercent: nonNegative(battery.EstimatedChargeRemaining) !== null ? available(nonNegative(battery.EstimatedChargeRemaining), source, { unit: '%' }) : unavailable('Charge level not reported', source),
    designVoltage: nonNegative(battery.DesignVoltage) !== null ? available(nonNegative(battery.DesignVoltage) / 1000, source, { unit: 'V' }) : unavailable('Design voltage not reported', source),
    // 71582788 minutes is CIM's "unknown" sentinel for EstimatedRunTime.
    estimatedRuntime: estimatedRuntime !== null && estimatedRuntime > 0 && estimatedRuntime < 525600
      ? available(Math.round(estimatedRuntime), source, { unit: 'min', notes: ['Reported by Windows from the current drain. It is a live estimate and changes as load changes; it is not a measured capacity test.'] })
      : unavailable('Windows did not report a runtime estimate (this is normal when charging or coping with a rapidly changing load)', source),
    chargeRate: num(battery.ChargeRate) !== null ? available(num(battery.ChargeRate), source, { unit: 'mA', notes: ['Positive values indicate charging, negative discharging, as defined by the CIM schema. Drivers do not always follow the sign convention, so treat the direction as indicative.'] }) : unavailable('Charge rate not reported', source),
    timeOnBattery: nonNegative(battery.TimeOnBattery) !== null ? available(nonNegative(battery.TimeOnBattery), source, { unit: 's' }) : unavailable('Time-on-battery not reported', source),
    powerOnline: bool(battery.PowerOnline) === true ? available('AC power connected', source) : bool(battery.PowerOnline) === false ? available('Running on battery', source) : unavailable('AC state not reported', source)
  };

  if (estimatedRuntime !== null && estimatedRuntime >= 525600) {
    // Windows uses 71582788 for "unknown"; showing it as 119,000 hours would be a
    // fabricated runtime.
    fields.estimatedRuntime = unavailable('Windows reported its "unknown runtime" sentinel rather than a value', source);
  }

  return fields;
}

/**
 * Map the `root\wmi` battery classes, which carry the capacities Windows does not
 * expose through Win32_Battery.
 *
 * BatteryStaticData.DesignedCapacity and BatteryFullChargedCapacity are in mWh on
 * every mainstream Windows laptop. BatteryStatus.Rate is in mW.
 *
 * @param {{staticData?:object|null, fullCharged?:object|null, status?:object|null, cycleCount?:object|null, temperature?:object|null}} payload
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function mapWmiBattery(payload = {}) {
  const source = 'battery-firmware';
  const staticData = payload.staticData ?? null;
  const fullCharged = payload.fullCharged ?? null;
  const status = payload.status ?? null;
  const cycle = payload.cycleCount ?? null;
  const temperature = payload.temperature ?? null;

  /** @type {Record<string, import('../core/field.js').FieldValue>} */
  const fields = {};

  const design = nonNegative(staticData?.DesignedCapacity ?? staticData?.DesignedCapacityMWh);
  const full = nonNegative(fullCharged?.FullChargedCapacity ?? fullCharged?.FullChargedCapacityMWh);

  fields.designCapacity = design !== null && design > 0
    ? available(design, source, { unit: 'mWh', notes: ['Read from root\\wmi BatteryStaticData.DesignedCapacity, which is the capacity the pack was built with.'] })
    : unavailable('The battery firmware did not report a design capacity', source);

  fields.fullChargeCapacity = full !== null && full > 0
    ? available(full, source, { unit: 'mWh', notes: ['Read from root\\wmi BatteryFullChargedCapacity, which is what the pack holds now when full.'] })
    : unavailable('The battery firmware did not report a full-charge capacity', source);

  const health = computeHealth(design, full);
  fields.health = health.health !== null
    ? available(health.health, 'computed', { unit: '%', status: health.status, notes: ['Computed as full-charge capacity ÷ design capacity × 100.', ...health.notes] })
    : field(null, { status: health.status, source: 'computed', error: health.reason, notes: health.notes });

  fields.wear = health.wear !== null
    ? available(health.wear, 'computed', { unit: '%', status: health.status, notes: ['Computed as 100 − health.'] })
    : field(null, { status: health.status, source: 'computed', error: health.reason });

  if (cycle) {
    const value = nonNegative(cycle.CycleCount ?? cycle.CycleCountValue ?? cycle.PowerCycleCount);
    fields.cycleCount = value !== null && value > 0 && value < 100000
      ? available(value, source, { unit: 'cycles', notes: ['Reported by the battery controller. Not all controllers expose this; when they do not, VERIDEX reports nothing rather than estimating.'] })
      : unavailable('The battery controller does not expose a cycle count on this device', source);
  } else {
    fields.cycleCount = unavailable('No battery cycle-count class is available on this device', source);
  }

  if (status) {
    const remaining = nonNegative(status.RemainingCapacity);
    fields.remainingCapacity = remaining !== null && remaining > 0 ? available(remaining, source, { unit: 'mWh' }) : unavailable('Remaining capacity not reported', source);

    const voltage = nonNegative(status.Voltage);
    fields.voltage = voltage !== null && voltage > 0 ? available(voltage, source, { unit: 'mV' }) : unavailable('Battery voltage not reported', source);

    const rate = num(status.Rate);
    // Rate is signed: negative while discharging on most controllers.
    fields.dischargeRate = rate !== null && rate < 0 ? available(Math.abs(rate), source, { unit: 'mW' }) : unavailable('No discharge rate is being reported right now', source);
    fields.chargeRate = rate !== null && rate > 0 ? available(rate, source, { unit: 'mW' }) : unavailable('No charge rate is being reported right now', source);

    const powerOnline = bool(status.PowerOnline);
    fields.acConnected = powerOnline === true ? available('Yes', source) : powerOnline === false ? available('No', source) : unavailable('AC state not reported', source);

    const charging = bool(status.Charging);
    fields.charging = charging === true ? available('Charging', source) : charging === false ? available('Not charging', source) : unavailable('Charging state not reported', source);

    const discharging = bool(status.Discharging);
    fields.discharging = discharging === true ? available('Discharging', source) : discharging === false ? available('Not discharging', source) : unavailable('Discharging state not reported', source);

    // Measured runtime: remaining mWh ÷ discharge mW gives hours. Only offered when
    // both are real readings and the load is a plausible figure.
    if (remaining !== null && remaining > 0 && rate !== null && rate < 0 && Math.abs(rate) > 100) {
      const hours = remaining / Math.abs(rate);
      if (hours > 0.05 && hours < 30) {
        fields.measuredRuntime = available(Math.round(hours * 60), 'computed', {
          unit: 'min',
          notes: [
            'Computed from the current remaining capacity and instantaneous discharge rate. This is a measurement of the present moment, not a full-capacity test, and it will fall as load rises.'
          ]
        });
      }
    } else {
      fields.measuredRuntime = unavailable('A runtime cannot be computed without a simultaneous remaining-capacity and discharge-rate reading', 'computed');
    }
  }

  if (temperature) {
    // BatteryTemperature is in tenths of a degree Kelvin.
    const raw = nonNegative(temperature.BatteryTemperature ?? temperature.Temperature);
    if (raw !== null && raw > 0) {
      const celsius = Math.round((raw / 10 - 273.15) * 10) / 10;
      fields.temperature = celsius > -20 && celsius < 80
        ? available(celsius, source, { unit: '°C', notes: ['Reported by the battery controller, converted from tenths of a kelvin.'] })
        : unavailable(`The reported battery temperature (${celsius} °C) is outside a plausible range and is treated as invalid`, source);
    } else {
      fields.temperature = unavailable('The battery controller did not report a temperature', source);
    }
  } else {
    fields.temperature = unavailable('No battery temperature sensor is exposed on this device', source);
  }

  if (staticData) {
    fields.chemistry = cleanString(staticData.Chemistry)
      ? available(cleanString(staticData.Chemistry), source)
      : unavailable('Battery chemistry not reported by the controller', source);
    const designedVoltage = nonNegative(staticData.DesignedVoltage);
    fields.designVoltage = designedVoltage !== null && designedVoltage > 0 ? available(designedVoltage, source, { unit: 'mV' }) : unavailable('Design voltage not reported', source);
    const cycleSupported = bool(staticData.CycleCount);
    if (cycleSupported === false) fields.cycleCountSupport = notApplicable('The controller reports that it does not support cycle counting', source);
  }

  return fields;
}

/**
 * Map the XML from `powercfg /batteryreport /XML`, which is a third independent
 * source for the capacities and the design/full-charge history.
 *
 * @param {string} xml
 * @returns {{designCapacity:number|null, fullChargeCapacity:number|null, cycleCount:number|null, manufacturer:string|null, chemistry:string|null, serialNumber:string|null, history:Array<{date:string, fullCharge:number|null, design:number|null}>}}
 */
export function parseBatteryReportXml(xml) {
  const text = typeof xml === 'string' ? xml : '';
  const empty = { designCapacity: null, fullChargeCapacity: null, cycleCount: null, manufacturer: null, chemistry: null, serialNumber: null, history: [] };
  if (!text.trim()) return empty;

  const pick = (tag) => {
    const match = text.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'));
    const value = match?.[1]?.trim();
    return value ? value : null;
  };
  const pickNumber = (tag) => {
    const value = pick(tag);
    return value === null ? null : num(value);
  };

  // The report nests <Battery> blocks; the first is the system battery.
  const firstBattery = text.match(/<Battery>[\s\S]*?<\/Battery>/i)?.[0] ?? text;

  const design = nonNegative(pickNumberFrom(firstBattery, 'DesignCapacity'));
  const full = nonNegative(pickNumberFrom(firstBattery, 'FullChargeCapacity'));
  const cycles = nonNegative(pickNumberFrom(firstBattery, 'CycleCount'));

  /** @type {Array<{date:string, fullCharge:number|null, design:number|null}>} */
  const history = [];
  const historyBlock = text.match(/<CapacityHistory>[\s\S]*?<\/CapacityHistory>/i)?.[0] ?? '';
  for (const entry of historyBlock.matchAll(/<CapacityHistoryEntry>[\s\S]*?<\/CapacityHistoryEntry>/gi)) {
    const block = entry[0];
    const stamp = block.match(/<LocalTimestamp>([^<]*)<\/LocalTimestamp>/i)?.[1]?.trim() ?? null;
    const fullCharge = num(block.match(/<FullChargeCapacity>([^<]*)<\/FullChargeCapacity>/i)?.[1]);
    const designCapacity = num(block.match(/<DesignCapacity>([^<]*)<\/DesignCapacity>/i)?.[1]);
    if (stamp) history.push({ date: stamp, fullCharge: fullCharge !== null && fullCharge > 0 ? fullCharge : null, design: designCapacity !== null && designCapacity > 0 ? designCapacity : null });
  }

  return {
    designCapacity: design,
    fullChargeCapacity: full,
    cycleCount: cycles,
    manufacturer: pickFrom(firstBattery, 'Manufacturer'),
    chemistry: pickFrom(firstBattery, 'Chemistry'),
    serialNumber: pickFrom(firstBattery, 'SerialNumber'),
    history
  };
}

/**
 * @param {string} block
 * @param {string} tag
 */
function pickFrom(block, tag) {
  const match = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'));
  const value = match?.[1]?.trim();
  return value || null;
}

/**
 * @param {string} block
 * @param {string} tag
 */
function pickNumberFrom(block, tag) {
  const value = pickFrom(block, tag);
  return value === null ? null : num(value);
}

/**
 * Map `systeminformation.battery()` — the last-resort source.
 * @param {object} battery
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function mapSiBattery(battery) {
  const source = 'systeminformation';
  if (!battery || typeof battery !== 'object') return {};
  const percent = num(battery.percent);
  const fields = {};
  if (percent !== null && percent >= 0 && percent <= 100) fields.chargePercent = available(Math.round(percent * 10) / 10, source, { unit: '%' });
  if (bool(battery.hasBattery) === false) fields.present = notApplicable('No battery is present in this system', source);
  if (bool(battery.acConnected) === true) fields.acConnected = available('Yes', source);
  if (bool(battery.acConnected) === false) fields.acConnected = available('No', source);
  const timeRemaining = nonNegative(battery.timeRemaining);
  if (timeRemaining !== null && timeRemaining > 0 && timeRemaining < 1440) {
    fields.estimatedRuntime = available(timeRemaining, source, { unit: 'min', notes: ['Windows power estimate, not a measured capacity test.'] });
  }
  if (typeof battery.isCharging === 'boolean') fields.charging = available(battery.isCharging ? 'Charging' : 'Not charging', source);
  return fields;
}

/**
 * Determine whether the machine has a battery at all, and describe the
 * consequences for the section's status.
 * @param {{hasBattery:boolean|null, chassisHint?:string|null}} input
 */
export function batteryApplicability(input) {
  if (input.hasBattery === false) {
    return notApplicable(
      `No battery is present${input.chassisHint ? ` and the chassis reports " ${input.chassisHint}"` : ''}. Battery health, wear and runtime do not apply to this device; nothing here is a fault.`,
      'cim-win32'
    );
  }
  return null;
}

/**
 * Register the battery providers and task.
 * @param {import('../engine/provider-registry.js').ProviderRegistry} registry
 */
export function registerBattery(registry) {
  registry.registerProvider({
    id: 'cim-win32.battery',
    title: 'Windows CIM (Win32_Battery)',
    priority: 1,
    collect: async (ctx) => {
      const battery = await queryCim(ctx.runner, 'Win32_Battery', { name: 'battery:win32', timeoutMs: ctx.timeoutMs });
      if (!battery.ok) {
        if (battery.unavailable) return { present: notApplicable('Win32_Battery returned no instances. On a desktop this means no battery; on a laptop it can also mean the battery driver has not loaded.', 'cim-win32.battery') };
        const cause = failureToStatus(battery);
        return { present: cause.kind === 'permission' ? field(null, { status: Status.PERMISSION_REQUIRED, permissionRequired: true, error: cause.reason, source: 'cim-win32.battery' }) : failed(battery.error, 'cim-win32.battery') };
      }
      return mapWin32Battery(battery.rows[0]);
    }
  });

  registry.registerProvider({
    id: 'battery-firmware.battery',
    title: 'root\\wmi battery classes (capacity + cycles)',
    priority: 2,
    collect: async (ctx) => {
      const [staticData, fullCharged, status, cycle, temperature] = await Promise.all([
        queryCim(ctx.runner, 'BatteryStaticData', { namespace: 'root/wmi', name: 'battery:static', timeoutMs: ctx.timeoutMs }),
        queryCim(ctx.runner, 'BatteryFullChargedCapacity', { namespace: 'root/wmi', name: 'battery:full', timeoutMs: ctx.timeoutMs }),
        queryCim(ctx.runner, 'BatteryStatus', { namespace: 'root/wmi', name: 'battery:status', timeoutMs: ctx.timeoutMs }),
        queryCim(ctx.runner, 'BatteryCycleCount', { namespace: 'root/wmi', name: 'battery:cycles', timeoutMs: ctx.timeoutMs }),
        queryCim(ctx.runner, 'BatteryTemperature', { namespace: 'root/wmi', name: 'battery:temp', timeoutMs: ctx.timeoutMs })
      ]);

      // A desktop has no battery classes at all: that is NOT_APPLICABLE, not an error.
      const anyAvailable = [staticData, fullCharged, status].some((result) => result.ok);
      if (!anyAvailable) {
        return {
          designCapacity: notApplicable('The root\\wmi battery classes are absent, which is normal on a system with no battery', 'battery-firmware.battery'),
          fullChargeCapacity: notApplicable('The root\\wmi battery classes are absent', 'battery-firmware.battery')
        };
      }

      return mapWmiBattery({
        staticData: staticData.rows[0] ?? null,
        fullCharged: fullCharged.rows[0] ?? null,
        status: status.rows[0] ?? null,
        cycleCount: cycle.rows[0] ?? null,
        temperature: temperature.rows[0] ?? null
      });
    }
  });

  registry.registerProvider({
    id: 'powercfg-report.battery',
    title: 'powercfg /batteryreport (XML)',
    priority: 3,
    collect: async (ctx) => {
      // Non-Windows and unreadable states must be stated, not returned as silence.
      if (!ctx.runner.isWindows) {
        return { designCapacity: unsupported('powercfg is a Windows tool and is not available on this platform', 'powercfg-report.battery') };
      }
      const target = `${process.env.TEMP ?? process.env.TMP ?? '.'}\\veridex-battery-${Date.now()}.xml`;
      const run = await runReadOnly(ctx.runner, 'powercfg', ['/batteryreport', '/XML', '/OUTPUT', target], { timeoutMs: Math.max(ctx.timeoutMs, 30_000) });
      if (!run.ok) {
        return { designCapacity: failed(`powercfg /batteryreport did not complete (${run.timedOut ? 'timed out' : `exit ${run.code}`})`, 'powercfg-report') };
      }
      try {
        const { readFile, unlink } = await import('node:fs/promises');
        const xml = await readFile(target, 'utf8');
        await unlink(target).catch(() => {});
        const parsed = parseBatteryReportXml(xml);
        const health = computeHealth(parsed.designCapacity, parsed.fullChargeCapacity);
        return {
          designCapacity: parsed.designCapacity !== null ? available(parsed.designCapacity, 'powercfg-report.battery', { unit: 'mWh', notes: ['Read from the powercfg battery report, a third independent source.'] }) : unavailable('The battery report contains no design capacity', 'powercfg-report.battery'),
          fullChargeCapacity: parsed.fullChargeCapacity !== null ? available(parsed.fullChargeCapacity, 'powercfg-report.battery', { unit: 'mWh' }) : unavailable('The battery report contains no full-charge capacity', 'powercfg-report.battery'),
          cycleCount: parsed.cycleCount !== null && parsed.cycleCount > 0 ? available(parsed.cycleCount, 'powercfg-report.battery', { unit: 'cycles' }) : unavailable('The battery report contains no cycle count', 'powercfg-report.battery'),
          reportChemistry: parsed.chemistry ? available(parsed.chemistry, 'powercfg-report.battery') : unavailable('The battery report contains no chemistry', 'powercfg-report.battery'),
          capacityHistory: parsed.history.length > 0 ? available(parsed.history, 'powercfg-report.battery', { notes: ['Full-charge capacity over time, as recorded by Windows whenever the battery report was generated.'] }) : unavailable('The battery report contains no capacity history', 'powercfg-report.battery'),
          healthFromReport: health.health !== null ? available(health.health, 'computed', { unit: '%', status: health.status }) : field(null, { status: health.status, source: 'computed', error: health.reason })
        };
      } catch (error) {
        return { designCapacity: failed(`Battery report could not be read: ${error instanceof Error ? error.message : String(error)}`, 'powercfg-report') };
      }
    }
  });

  registry.registerProvider({
    id: 'systeminformation.battery',
    title: 'systeminformation (battery counters)',
    priority: 4,
    collect: async () => {
      const loaded = await loadSystemInformation();
      if (!loaded.ok) return { designCapacity: unavailable(`systeminformation unavailable: ${loaded.error}`, 'systeminformation.battery') };
      try {
        const mapped = mapSiBattery(await loaded.si.battery());
        if (Object.keys(mapped).length === 0) {
          return { designCapacity: unavailable('systeminformation reported no battery', 'systeminformation.battery') };
        }
        return mapped;
      } catch (error) {
        return { designCapacity: failed(error instanceof Error ? error.message : String(error), 'systeminformation.battery') };
      }
    }
  });

  registry.registerTask({
    id: 'battery.info',
    module: 'battery',
    title: 'Battery & power',
    quick: true,
    providers: ['cim-win32.battery', 'battery-firmware.battery', 'powercfg-report.battery', 'systeminformation.battery'],
    validate: (fields) => {
      const problems = [];
      const design = fields.designCapacity?.value;
      const full = fields.fullChargeCapacity?.value;
      if (typeof design === 'number' && typeof full === 'number' && design > 0 && full > 0) {
        const ratio = full / design;
        if (ratio > 3) problems.push(`full-charge capacity is ${ratio.toFixed(1)}× the design capacity, which indicates a unit mismatch between providers`);
      }
      const cycles = fields.cycleCount?.value;
      if (typeof cycles === 'number' && cycles > 5000) problems.push(`reported cycle count ${cycles} is implausible`);
      const percent = fields.chargePercent?.value;
      if (typeof percent === 'number' && (percent < 0 || percent > 100)) problems.push(`charge percentage ${percent} is outside 0–100`);
      return problems;
    }
  });
}
