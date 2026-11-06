/**
 * VERIDEX — ATA SMART decoding.
 *
 * SATA drives expose SMART through the ATA SMART READ DATA command (0xB0, subcommand
 * 0xD0), returned by Windows as a 512-byte structure via DeviceIoControl
 * SMART_RCV_DRIVE_DATA (0x7C). Vendor-specific offset layouts are a classic source
 * of fabricated readings, so this module:
 *
 *  - parses the *standard* 12-byte attribute table starting at offset 2;
 *  - uses raw values only, not the normalised 1–253 value, for wear figures;
 *  - names only attributes whose meaning is standardised (IDs 5, 9, 12, 187, 188,
 *    190, 194, 197, 198, 199, 241) and marks the rest as vendor-specific;
 *  - treats "raw bytes" as little-endian 48-bit as the ATA spec defines, with the
 *    special case for temperature attributes that some vendors store in fewer bytes.
 *
 * The parser is pure so it can be unit-tested against captured real payloads.
 */

/** SMART attribute IDs with standardised meanings. */
export const ATA_ATTRIBUTES = Object.freeze({
  1: { name: 'Read Error Rate', vendorSpecific: true, note: 'Encoding is vendor-specific; the raw value is not a plain error count on most drives.' },
  3: { name: 'Spin-Up Time', vendorSpecific: true },
  4: { name: 'Start/Stop Count', vendorSpecific: false, unit: 'count' },
  5: { name: 'Reallocated Sectors Count', vendorSpecific: false, unit: 'sectors', critical: true },
  7: { name: 'Seek Error Rate', vendorSpecific: true },
  9: { name: 'Power-On Hours', vendorSpecific: false, unit: 'hours' },
  10: { name: 'Spin Retry Count', vendorSpecific: false, unit: 'count', critical: true },
  11: { name: 'Recalibration Retries', vendorSpecific: true },
  12: { name: 'Power Cycle Count', vendorSpecific: false, unit: 'count' },
  13: { name: 'Soft Read Error Rate', vendorSpecific: true },
  177: { name: 'Wear Leveling Count', vendorSpecific: false, unit: 'count' },
  179: { name: 'Used Reserved Block Count', vendorSpecific: false, unit: 'count' },
  181: { name: 'Program Fail Count', vendorSpecific: false, unit: 'count' },
  182: { name: 'Erase Fail Count', vendorSpecific: false, unit: 'count' },
  187: { name: 'Reported Uncorrectable Errors', vendorSpecific: false, unit: 'count', critical: true },
  188: { name: 'Command Timeout', vendorSpecific: false, unit: 'count', critical: true },
  190: { name: 'Airflow Temperature', vendorSpecific: false, unit: '°C', isTemperature: true },
  192: { name: 'Power-Off Retract Count', vendorSpecific: false, unit: 'count' },
  194: { name: 'Temperature', vendorSpecific: false, unit: '°C', isTemperature: true },
  196: { name: 'Reallocation Event Count', vendorSpecific: false, unit: 'count' },
  197: { name: 'Current Pending Sector Count', vendorSpecific: false, unit: 'sectors', critical: true },
  198: { name: 'Offline Uncorrectable Sector Count', vendorSpecific: false, unit: 'sectors', critical: true },
  199: { name: 'UltraDMA CRC Error Count', vendorSpecific: false, unit: 'count', critical: true },
  231: { name: 'SSD Life Left', vendorSpecific: false, unit: '%' },
  233: { name: 'Media Wearout Indicator', vendorSpecific: true },
  241: { name: 'Total LBAs Written', vendorSpecific: false, unit: 'LBAs' },
  242: { name: 'Total LBAs Read', vendorSpecific: false, unit: 'LBAs' }
});

/**
 * Decode a 6-byte little-endian raw value from an attribute entry.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {number}
 */
export function readRaw48(bytes, offset) {
  let value = 0;
  for (let index = 5; index >= 0; index -= 1) {
    value = value * 256 + (bytes[offset + index] ?? 0);
  }
  return value;
}

/**
 * Extract the temperature in °C from a temperature attribute.
 *
 * Drives disagree: some store the value in the low byte of the raw field, some in
 * the second byte, and some in both (high byte as a min/max history). The rule used
 * here is the one the smartmontools project documents: if the low 16 bits fit two
 * plausible byte-values, prefer the low byte, but prefer the second byte when the
 * low byte is zero and the second byte is plausible.
 *
 * @param {Uint8Array} raw6
 * @returns {number|null}
 */
export function decodeTemperature(raw6) {
  const low = raw6[0] ?? 0;
  const second = raw6[1] ?? 0;
  const plausible = (value) => value > 0 && value < 120;
  if (plausible(low)) return low;
  if (plausible(second)) return second;
  return null;
}

/**
 * Parse the 512-byte SMART READ DATA structure.
 *
 * Layout (ATA-8):
 *   0..1    revision
 *   2..361  30 attribute entries × 12 bytes
 *   362     offline data collection status
 *   367..368 total power-on hours (when the drive reports no attribute 9)
 *   372..373 vendor specific
 *
 * @param {Uint8Array|ArrayBuffer|number[]} buffer
 * @returns {{attributes: Array<{id:number, name:string, flag:number, normalized:number, worst:number, raw:number, rawHex:string, unit:string|null, vendorSpecific:boolean, critical:boolean, note:string|null}>, temperature:number|null, powerOnHours:number|null, powerCycleCount:number|null, reallocatedSectors:number|null, uncorrectableErrors:number|null, pendingSectors:number|null, crcErrors:number|null, healthPassed:boolean|null, standardAttributes:number, vendorAttributes:number}}
 */
export function parseSmartData(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer ?? []);
  const result = {
    attributes: [],
    temperature: null,
    powerOnHours: null,
    powerCycleCount: null,
    reallocatedSectors: null,
    uncorrectableErrors: null,
    pendingSectors: null,
    crcErrors: null,
    healthPassed: null,
    standardAttributes: 0,
    vendorAttributes: 0
  };

  if (bytes.length < 362) return result;

  for (let index = 0; index < 30; index += 1) {
    const offset = 2 + index * 12;
    const id = bytes[offset];
    if (!id || id === 0) continue;

    const flag = bytes[offset + 1] ?? 0;
    const normalized = bytes[offset + 3] ?? 0;
    const worst = bytes[offset + 4] ?? 0;
    const rawBytes = bytes.slice(offset + 5, offset + 11);
    const raw = readRaw48(bytes, offset + 5);
    const meta = ATA_ATTRIBUTES[id];

    const entry = {
      id,
      name: meta?.name ?? `Vendor-specific attribute ${id}`,
      flag,
      normalized,
      worst,
      raw,
      rawHex: Array.from(rawBytes, (byte) => byte.toString(16).padStart(2, '0')).join(' '),
      unit: meta?.unit ?? null,
      vendorSpecific: meta ? meta.vendorSpecific : true,
      critical: meta?.critical ?? false,
      note: meta?.note ?? null
    };
    result.attributes.push(entry);
    if (meta) result.standardAttributes += 1;
    else result.vendorAttributes += 1;

    switch (id) {
      case 5:
        result.reallocatedSectors = raw;
        break;
      case 9:
        result.powerOnHours = raw > 0 ? raw : null;
        break;
      case 12:
        result.powerCycleCount = raw > 0 ? raw : null;
        break;
      case 187:
        result.uncorrectableErrors = raw;
        break;
      case 190:
        result.temperature ??= decodeTemperature(rawBytes);
        break;
      case 194:
        result.temperature ??= decodeTemperature(rawBytes);
        break;
      case 197:
        result.pendingSectors = raw;
        break;
      case 199:
        result.crcErrors = raw;
        break;
      default:
        break;
    }
  }

  // Fall back to the structure's own power-on-hours field when attribute 9 is
  // absent (some SSDs omit it).
  if (result.powerOnHours === null && bytes.length >= 369) {
    const stored = (bytes[367] ?? 0) | ((bytes[368] ?? 0) << 8);
    if (stored > 0 && stored < 0xffff) result.powerOnHours = stored;
  }

  return result;
}

/**
 * Interpret raw SMART counters into a health statement.
 *
 * Only counters with standardised semantics are used. A non-zero value for a
 * critical counter is a warning; a large one is a failure. The thresholds are
 * deliberately conservative and are disclosed in the notes, because drive vendors
 * publish different tolerances.
 *
 * @param {ReturnType<typeof parseSmartData>} parsed
 * @returns {{status:string, findings:string[], notes:string[]}}
 */
export function interpretSmart(parsed) {
  const findings = [];
  const notes = [];
  let status = 'PASS';

  if (!parsed || parsed.attributes.length === 0) {
    return { status: 'UNAVAILABLE', findings: [], notes: ['No SMART attributes could be read from this drive.'] };
  }

  const escalate = (level) => {
    const order = ['PASS', 'WARNING', 'FAIL'];
    if (order.indexOf(level) > order.indexOf(status)) status = level;
  };

  if (parsed.reallocatedSectors !== null) {
    if (parsed.reallocatedSectors > 0) {
      findings.push(`${parsed.reallocatedSectors} reallocated sector(s): the drive has already remapped failing sectors.`);
      escalate(parsed.reallocatedSectors >= 32 ? 'FAIL' : 'WARNING');
    } else {
      findings.push('No reallocated sectors reported.');
    }
  }

  if (parsed.pendingSectors !== null && parsed.pendingSectors > 0) {
    findings.push(`${parsed.pendingSectors} sector(s) are pending reallocation, meaning the drive could not read them and has not yet remapped them.`);
    escalate(parsed.pendingSectors >= 8 ? 'FAIL' : 'WARNING');
  }

  if (parsed.uncorrectableErrors !== null && parsed.uncorrectableErrors > 0) {
    findings.push(`${parsed.uncorrectableErrors} reported uncorrectable error(s).`);
    escalate('WARNING');
  }

  if (parsed.crcErrors !== null && parsed.crcErrors > 0) {
    findings.push(
      `${parsed.crcErrors} UDMA CRC error(s). These indicate a cabling or controller problem on the SATA link rather than a failing disk surface, so check or reseat the cable before condemning the drive.`
    );
    escalate('WARNING');
  }

  if (parsed.temperature !== null && parsed.temperature >= 55) {
    findings.push(`Drive temperature is ${parsed.temperature} °C, which is at or above the range where most drives reduce performance or shorten their life.`);
    escalate(parsed.temperature >= 65 ? 'FAIL' : 'WARNING');
  }

  if (parsed.powerOnHours !== null && parsed.powerOnHours > 0) {
    findings.push(`${parsed.powerOnHours.toLocaleString('en-US')} power-on hours recorded.`);
  }

  notes.push('Thresholds for reallocated and pending sectors are conservative advisory values, not vendor specifications; drive vendors publish different tolerances.');

  return { status, findings, notes };
}
