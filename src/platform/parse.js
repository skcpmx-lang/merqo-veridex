/**
 * VERIDEX — Parser primitives.
 *
 * Providers receive loosely-typed JSON from PowerShell/CIM, where every number
 * may arrive as a string, an empty string, `$null`, or a localized date. These
 * helpers turn that soup into a definite value or a definite "no value" — never
 * into a guess. This is the boundary where fabricated-looking data would sneak
 * in, so the rules are strict and individually unit-tested.
 */

/** Values that CIM/PowerShell use to mean "no data". */
const NULLISH = new Set(['', 'null', 'undefined', 'n/a', 'na', '(null)', 'none', 'not available', 'not specified', 'unknown', 'to be filled by o.e.m.', 'default string', 'o.e.m.', 'system manufacturer', 'system product name', 'invalid']);

/**
 * Treat CIM placeholder strings as absent. OEM boards routinely report
 * "To be filled by O.E.M." as the serial number; showing that as fact would be
 * a lie, so it becomes absent.
 * @param {unknown} value
 * @returns {string|null}
 */
export function cleanString(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (NULLISH.has(trimmed.toLowerCase())) return null;
    return trimmed;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/**
 * Parse a number from CIM's mixed representations.
 * Rejects NaN, Infinity and localized junk instead of coercing to 0.
 * @param {unknown} value
 * @returns {number|null}
 */
export function num(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || NULLISH.has(trimmed.toLowerCase())) return null;
    // CIM sometimes returns "1,024" or "1024 bytes".
    const match = trimmed.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    if (!match) return null;
    const parsed = Number(match[0]);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Parse a non-negative number; a negative capacity/clock is a provider fault and
 * must not be silently clamped.
 * @param {unknown} value
 * @returns {number|null}
 */
export function nonNegative(value) {
  const parsed = num(value);
  if (parsed === null || parsed < 0) return null;
  return parsed;
}

/**
 * Parse a CIM/PowerShell boolean, which arrives as true/false, "True"/"False",
 * 1/0 or $null.
 * @param {unknown} value
 * @returns {boolean|null}
 */
export function bool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1 ? true : value === 0 ? false : null;
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase();
    if (['true', 'yes', '1', 'enabled', 'on'].includes(t)) return true;
    if (['false', 'no', '0', 'disabled', 'off'].includes(t)) return false;
  }
  return null;
}

/**
 * Parse a date into ISO-8601. Handles ISO strings, WMI datetime
 * (`20240115000000.000000+000`) and PowerShell `\/Date(…)\/` epochs.
 * A date that cannot be parsed confidently returns null rather than "now".
 * @param {unknown} value
 * @returns {string|null}
 */
export function date(value) {
  const text = cleanString(value);
  if (!text) return null;

  const wmi = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (wmi) {
    const [, y, mo, d, h, mi, s] = wmi;
    const parsed = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  const dotnet = text.match(/\/Date\((-?\d+)\)\//);
  if (dotnet) {
    const parsed = new Date(Number(dotnet[1]));
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  // Guard against "1970-01-01" style sentinels used for "never".
  if (parsed.getUTCFullYear() < 1980) return null;
  return parsed.toISOString();
}

/**
 * Normalise whatever CIM produced into an array.
 * @template T
 * @param {T|T[]|null|undefined} value
 * @returns {T[]}
 */
export function asArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value.filter((v) => v !== null && v !== undefined) : [value];
}

/**
 * First defined value from a list of candidate readings, preserving which key
 * supplied it so provenance can be attached.
 * @param {Record<string, unknown>} source
 * @param {string[]} keys
 * @returns {{key:string, value:unknown}|null}
 */
export function firstDefined(source, keys) {
  if (!source || typeof source !== 'object') return null;
  for (const key of keys) {
    const candidate = /** @type {Record<string, unknown>} */ (source)[key];
    if (cleanString(candidate) !== null || num(candidate) !== null) return { key, value: candidate };
  }
  return null;
}

/** Convert bytes to gibibytes, rounded to one decimal. */
export function bytesToGiB(bytes) {
  const value = num(bytes);
  if (value === null || value <= 0) return null;
  return Math.round((value / 1024 ** 3) * 10) / 10;
}

/** Convert kilobytes to gibibytes. */
export function kbToGiB(kb) {
  const value = num(kb);
  if (value === null || value <= 0) return null;
  return Math.round((value / 1024 ** 2) * 10) / 10;
}

/** Convert megabytes to gibibytes. */
export function mbToGiB(mb) {
  const value = num(mb);
  if (value === null || value <= 0) return null;
  return Math.round((value / 1024) * 10) / 10;
}

/** Clamp a number into an inclusive range; used only for presentation maths. */
export function clamp(value, min, max) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, value));
}

/** Round to a fixed number of decimals without producing -0. */
export function round(value, decimals = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Decode an SMBIOS memory type code into a DDR generation label.
 * Unmapped codes return null so the UI shows Unavailable rather than a guess.
 * @param {unknown} code
 * @returns {string|null}
 */
export function smbiosMemoryType(code) {
  const value = num(code);
  if (value === null) return null;
  const map = {
    18: 'DDR',
    19: 'DDR',
    20: 'DDR2',
    21: 'DDR2',
    22: 'DDR2',
    23: 'DDR2',
    24: 'DDR3',
    26: 'DDR4',
    27: 'LPDDR',
    28: 'LPDDR2',
    29: 'LPDDR3',
    30: 'LPDDR4',
    34: 'DDR5',
    35: 'LPDDR5'
  };
  return map[value] ?? null;
}

/**
 * Decode an SMBIOS form factor code for memory modules.
 * @param {unknown} code
 * @returns {string|null}
 */
export function memoryFormFactor(code) {
  const value = num(code);
  if (value === null) return null;
  const map = { 1: 'Other', 2: 'Unknown', 8: 'DIMM', 9: 'SIP', 10: 'Chip', 11: 'DIP', 12: 'ZIP', 13: 'Proprietary Card', 14: 'DIMM', 15: 'TSOP', 16: 'Row of chips', 17: 'RIMM', 18: 'SODIMM', 19: 'SRIMM', 20: 'FB-DIMM' };
  return map[value] ?? null;
}

/**
 * Human-readable byte size with binary units.
 * @param {unknown} bytes
 */
export function formatBytes(bytes) {
  const value = num(bytes);
  if (value === null || value < 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const rounded = size >= 100 ? Math.round(size) : Math.round(size * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/**
 * Split a PowerShell `Win32_PnPEntity` hardware id list into a chipset hint.
 * Deliberately narrow: it only recognises vendor ids it can name.
 * @param {string[]} hardwareIds
 * @returns {string|null}
 */
export function chipsetFromHardwareIds(hardwareIds) {
  const list = asArray(hardwareIds).map((h) => String(h).toUpperCase());
  for (const id of list) {
    if (id.includes('VEN_8086') && id.includes('DEV_A')) return 'Intel Series 600/700 (PCIe root complex)';
    if (id.includes('VEN_1022') && id.includes('DEV_14')) return 'AMD 500/600 Series (FCH)';
  }
  return null;
}
