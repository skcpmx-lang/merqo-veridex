/**
 * VERIDEX — NVMe health-log decoding.
 *
 * NVMe exposes a far cleaner health record than SATA: the SMART / Health
 * Information log (log page 0x02) is a fixed 512-byte structure defined in the NVM
 * Express Base Specification. Windows returns it through
 * IOCTL_STORAGE_QUERY_PROPERTY with a StorageDeviceProtocolSpecificProperty query
 * (STORAGE_PROTOCOL_NVME_DATA_TYPE 0x02).
 *
 * Field offsets below follow the NVMe 1.4/2.0 specification, table "SMART / Health
 * Information Log". All multi-byte values are little-endian.
 */

/**
 * "Percentage Used" is a uint8 whose full range is 0–255, where 100 means the drive
 * has consumed its rated endurance. The specification explicitly states the value
 * can exceed 100, and firmware frequently reports 255 to mean "unknown / not
 * supported". Treating 255 as 255% used would be a fabricated crisis.
 */
export const PERCENTAGE_USED_UNKNOWN = 0xff;

/**
 * Decode the NVMe SMART/Health Information log.
 *
 * @param {Uint8Array|ArrayBuffer|number[]} buffer
 * @returns {{
 *   criticalWarning: {raw:number, bits:string[]},
 *   temperatureK: number|null,
 *   temperatureC: number|null,
 *   availableSpare: number|null,
 *   availableSpareThreshold: number|null,
 *   percentageUsed: number|null,
 *   percentageUsedRaw: number,
 *   dataUnitsRead: number|null,
 *   dataUnitsWritten: number|null,
 *   hostReads: number|null,
 *   hostWrites: number|null,
 *   controllerBusyMinutes: number|null,
 *   powerCycles: number|null,
 *   powerOnHours: number|null,
 *   unsafeShutdowns: number|null,
 *   mediaErrors: number|null,
 *   errorLogEntries: number|null,
 *   warningTemperatureMinutes: number|null,
 *   criticalTemperatureMinutes: number|null,
 *   temperatureSensorsK: number[],
 *   thermalTransition1: number|null,
 *   thermalTransition2: number|null
 * }}
 */
export function parseNvmeHealthLog(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer ?? []);
  const empty = {
    criticalWarning: { raw: 0, bits: [] },
    temperatureK: null,
    temperatureC: null,
    availableSpare: null,
    availableSpareThreshold: null,
    percentageUsed: null,
    percentageUsedRaw: 0,
    dataUnitsRead: null,
    dataUnitsWritten: null,
    hostReads: null,
    hostWrites: null,
    controllerBusyMinutes: null,
    powerCycles: null,
    powerOnHours: null,
    unsafeShutdowns: null,
    mediaErrors: null,
    errorLogEntries: null,
    warningTemperatureMinutes: null,
    criticalTemperatureMinutes: null,
    temperatureSensorsK: [],
    thermalTransition1: null,
    thermalTransition2: null
  };
  if (bytes.length < 512) return empty;

  const u8 = (offset) => bytes[offset] ?? 0;
  const u16 = (offset) => (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
  const u32 = (offset) => (bytes[offset] ?? 0) + (bytes[offset + 1] ?? 0) * 256 + (bytes[offset + 2] ?? 0) * 65536 + (bytes[offset + 3] ?? 0) * 16777216;
  // 64-bit counters in this log are small enough to stay within Number's safe
  // range; reading the low 53 bits is exact.
  const u64 = (offset) => u32(offset) + u32(offset + 4) * 4294967296;

  const criticalRaw = u8(0);
  const CRITICAL_BITS = [
    [0, 'Available spare capacity has fallen below the threshold'],
    [1, 'Temperature has exceeded a critical threshold'],
    [2, 'NVM subsystem reliability has degraded'],
    [3, 'Media has been placed in read-only mode'],
    [4, 'Volatile memory backup device has failed'],
    [5, 'Persistent memory region is read-only'],
    [6, 'Reserved bit set'],
    [7, 'Reserved bit set']
  ];

  const temperatureK = u16(1);
  const percentageUsedRaw = u8(5);

  // Data units are 512,000 bytes (1000 × 512) each, per the NVMe specification.
  const dataUnitsRead = u64(32);
  const dataUnitsWritten = u64(48);

  /** @type {number[]} */
  const sensors = [];
  for (let index = 0; index < 8; index += 1) {
    const kelvin = u16(200 + index * 2);
    if (kelvin > 0 && kelvin < 1000) sensors.push(kelvin);
  }

  return {
    criticalWarning: {
      raw: criticalRaw,
      bits: CRITICAL_BITS.filter(([bit]) => (criticalRaw & (1 << bit)) !== 0).map(([, text]) => text)
    },
    temperatureK: temperatureK > 0 && temperatureK < 1000 ? temperatureK : null,
    temperatureC: temperatureK > 0 && temperatureK < 1000 ? Math.round((temperatureK - 273.15) * 10) / 10 : null,
    availableSpare: u8(3),
    availableSpareThreshold: u8(4),
    percentageUsed: percentageUsedRaw === PERCENTAGE_USED_UNKNOWN ? null : percentageUsedRaw,
    percentageUsedRaw,
    dataUnitsRead: dataUnitsRead > 0 ? dataUnitsRead : null,
    dataUnitsWritten: dataUnitsWritten > 0 ? dataUnitsWritten : null,
    hostReads: dataUnitsRead > 0 ? Math.round((dataUnitsRead * 512000) / 1024 ** 4 * 100) / 100 : null,
    hostWrites: dataUnitsWritten > 0 ? Math.round((dataUnitsWritten * 512000) / 1024 ** 4 * 100) / 100 : null,
    controllerBusyMinutes: u64(64),
    powerCycles: u64(112),
    powerOnHours: u64(120),
    unsafeShutdowns: u64(128),
    mediaErrors: u64(144),
    errorLogEntries: u64(152),
    warningTemperatureMinutes: u32(168),
    criticalTemperatureMinutes: u32(176),
    temperatureSensorsK: sensors,
    thermalTransition1: u16(180) || null,
    thermalTransition2: u16(182) || null
  };
}

/** TBW = data units × 512,000 bytes, expressed in TiB. */
export const DATA_UNIT_BYTES = 512_000;

/**
 * Interpret the NVMe health log into findings and a health statement.
 *
 * Endurance maths: without the datasheet TBW we cannot state "X% of rated
 * endurance consumed" from `percentageUsed` alone — that number IS the drive's own
 * answer, so it is used directly and labelled as firmware-reported.
 *
 * @param {ReturnType<typeof parseNvmeHealthLog>} health
 * @returns {{status:string, findings:string[], notes:string[], enduranceWording:string|null}}
 */
export function interpretNvmeHealth(health) {
  const findings = [];
  const notes = [];
  let status = 'PASS';
  let enduranceWording = null;

  if (!health || health.temperatureK === null) {
    return { status: 'UNAVAILABLE', findings: [], notes: ['The NVMe health log could not be read from this drive.'], enduranceWording: null };
  }

  const escalate = (level) => {
    const order = ['PASS', 'WARNING', 'FAIL'];
    if (order.indexOf(level) > order.indexOf(status)) status = level;
  };

  if (health.criticalWarning.bits.length > 0) {
    findings.push(`Drive is reporting a critical warning: ${health.criticalWarning.bits.join('; ')}.`);
    escalate('FAIL');
  }

  if (health.percentageUsed !== null) {
    if (health.percentageUsed >= 100) {
      findings.push(`Firmware reports ${health.percentageUsed}% of rated endurance consumed: the drive has reached the end of its warranted write life.`);
      escalate('FAIL');
    } else if (health.percentageUsed >= 80) {
      findings.push(`Firmware reports ${health.percentageUsed}% of rated endurance consumed, so the drive is approaching the end of its warranted write life.`);
      escalate('WARNING');
    } else {
      findings.push(`Firmware reports ${health.percentageUsed}% of rated endurance consumed.`);
    }
    enduranceWording = `${health.percentageUsed}% of rated endurance used, as reported by the drive firmware.`;
  } else if (health.percentageUsedRaw === PERCENTAGE_USED_UNKNOWN) {
    findings.push('The drive reports 255 for percentage used, which the NVMe specification defines as "unknown"; no endurance figure can be derived from it.');
    notes.push('This is common on some OEM drives and does not indicate a problem.');
  }

  if (health.mediaErrors !== null && health.mediaErrors > 0) {
    findings.push(`${health.mediaErrors} unrecovered data-integrity error(s) recorded by the controller.`);
    escalate(health.mediaErrors > 100 ? 'FAIL' : 'WARNING');
  }

  if (health.availableSpare !== null) {
    if (health.availableSpare === 0) {
      findings.push('Available spare capacity is exhausted: the drive has no reserve blocks left to remap failing media.');
      escalate('FAIL');
    } else if (health.availableSpareThreshold !== null && health.availableSpare < health.availableSpareThreshold) {
      findings.push(`Available spare (${health.availableSpare}%) is below the drive's own threshold (${health.availableSpareThreshold}%).`);
      escalate('WARNING');
    }
  }

  if (health.temperatureC !== null && health.temperatureC >= 70) {
    findings.push(`Composite temperature is ${health.temperatureC} °C, above the range where most NVMe controllers throttle.`);
    escalate(health.temperatureC >= 80 ? 'FAIL' : 'WARNING');
  }

  if (health.unsafeShutdowns !== null && health.unsafeShutdowns > 0) {
    notes.push(`${health.unsafeShutdowns} unsafe shutdown(s) have been recorded by the controller; each one risks data loss but is not itself evidence of failing hardware.`);
  }

  if (health.hostWrites !== null) {
    findings.push(`${health.hostWrites.toLocaleString('en-US')} TiB written to the drive over ${health.powerOnHours?.toLocaleString('en-US') ?? 'an unknown number of'} power-on hours.`);
  }

  notes.push('Endurance figures are reported by the drive firmware. VERIDEX does not model expected lifetime, because that depends on the drive\'s rated terabytes-written and your workload.');

  return { status, findings, notes, enduranceWording };
}

/**
 * Decode an NVMe `percentageUsed` value for display, preserving the "unknown"
 * distinction the specification defines.
 * @param {number|null} percentageUsed
 * @param {number} rawValue
 */
export function describePercentageUsed(percentageUsed, rawValue) {
  if (percentageUsed === null) {
    return rawValue === PERCENTAGE_USED_UNKNOWN
      ? { text: 'Unknown (drive returned 0xFF)', status: 'UNAVAILABLE', reason: 'The NVMe specification defines 0xFF as "percentage used is unknown".' }
      : { text: 'Not reported', status: 'UNAVAILABLE', reason: 'The drive did not report an endurance figure.' };
  }
  const status = percentageUsed >= 100 ? 'FAIL' : percentageUsed >= 80 ? 'WARNING' : 'PASS';
  return { text: `${percentageUsed}%`, status, reason: null };
}

/**
 * Convert NVMe data units to a human byte quantity.
 * @param {number|null} units
 * @returns {{bytes:number, tib:number}|null}
 */
export function dataUnitsToBytes(units) {
  if (units === null || units === undefined || !Number.isFinite(units) || units <= 0) return null;
  const bytes = units * DATA_UNIT_BYTES;
  return { bytes, tib: Math.round((bytes / 1024 ** 4) * 100) / 100 };
}
