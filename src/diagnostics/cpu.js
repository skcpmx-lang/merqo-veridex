/**
 * VERIDEX — CPU diagnostics (MODULE 01).
 *
 * Three independent providers, in priority order:
 *   1. `cim-win32`        — Win32_Processor + Win32_CacheMemory (authoritative identity)
 *   2. `systeminformation`— live clocks, per-core load, CPUID flags
 *   3. `model-table`      — derived generation/socket decoding (never a raw claim)
 *
 * Identity comes from CIM because it is the OS's own record. Live utilisation and
 * per-core load come from `systeminformation` because reading performance counters
 * directly is exactly the job that library already does correctly. Generation is
 * derived and labelled as derived.
 */

import { available, unavailable, unsupported, failed, field } from '../core/field.js';
import { Status } from '../core/status.js';
import { cleanString, num, nonNegative, bool, asArray } from '../platform/parse.js';
import { queryCim, loadSystemInformation, failureToStatus } from '../platform/windows.js';
import { decodeCpuName, decodeArchitecture, normaliseInstructionSets, validateCoreCounts } from './cpu-model.js';

/** Socket hint for common desktop platforms, keyed by a model-number family. */
const SOCKET_HINTS = Object.freeze([
  { test: /i[3579]-(\d{4,5})/, intel: true, map: (digits) => socketForIntelDigits(digits) },
  { test: /Ultra\s*[579]\s*(\d{3})/, intel: true, map: () => 'LGA1851 / LGA1700 (Core Ultra)' },
  { test: /Ryzen\s*[3579]\s*([3579])\d{3}/, intel: false, map: (series) => socketForAmdSeries(series) }
]);

/**
 * @param {string} digits
 * @returns {string|null}
 */
function socketForIntelDigits(digits) {
  const generation = /^(10|11|12|13|14)/.test(digits) && digits.length >= 4 ? Number(digits.slice(0, 2)) : Number(digits[0]);
  switch (generation) {
    case 2:
    case 3:
      return 'LGA1155';
    case 4:
    case 5:
      return 'LGA1150';
    case 6:
    case 7:
      return 'LGA1151';
    case 8:
    case 9:
      return 'LGA1151';
    case 10:
    case 11:
      return 'LGA1200';
    case 12:
    case 13:
    case 14:
      return 'LGA1700';
    default:
      return null;
  }
}

/**
 * @param {string} series
 * @returns {string|null}
 */
function socketForAmdSeries(series) {
  switch (Number(series)) {
    case 1:
      return 'AM4';
    case 2:
    case 3:
      return 'AM4';
    case 4:
    case 5:
      return 'AM4';
    case 7:
    case 8:
    case 9:
      return 'AM5';
    default:
      return null;
  }
}

/**
 * Derive a socket hint. Deskop/LGA parts are distinguishable from mobile parts by
 * the model suffix, so a mobile SKU ("1165G7", "5800H") yields no socket rather
 * than a misleading desktop socket.
 * @param {string|null} name
 * @returns {{socket:string, rule:string}|null}
 */
export function deriveSocket(name) {
  if (!name) return null;
  const text = String(name);

  const intel = text.match(/i[3579]-(\d{4,5})([A-Z]{0,3}\d?[A-Z]?)\s/i) || text.match(/i[3579]-(\d{4,5})([A-Z]{0,3}\d?[A-Z]?)$/i);
  if (intel) {
    const suffix = (intel[2] ?? '').toUpperCase();
    if (!isDesktopIntelSuffix(suffix)) return null;
    const socket = socketForIntelDigits(intel[1]);
    return socket ? { socket, rule: `intel-desktop-model-number (suffix "${suffix || 'none'}")` } : null;
  }

  const amd = text.match(/Ryzen\s*[3579]\s*(?:PRO\s*)?(\d{4})([A-Z]{0,3}\d?) /i) || text.match(/Ryzen\s*[3579]\s*(?:PRO\s*)?(\d{4})([A-Z]{0,3}\d?)$/i);
  if (amd) {
    const suffix = (amd[2] ?? '').toUpperCase();
    if (!isDesktopAmdSuffix(suffix)) return null;
    const socket = socketForAmdSeries(amd[1][0]);
    return socket ? { socket, rule: `amd-desktop-sku-series (series ${amd[1][0]}000, suffix "${suffix || 'none'}")` } : null;
  }

  return null;
}

/**
 * Intel model suffixes that appear on socketed desktop parts. Anything else
 * (H, HK, HX, U, Y, P, G7, M, MQ, HQ ...) marks a soldered mobile part, whose
 * socket name is not published in a machine-readable form, so no claim is made.
 * @param {string} suffix
 * @returns {boolean}
 */
export function isDesktopIntelSuffix(suffix) {
  const upper = (suffix ?? '').toUpperCase();
  if (!upper) return true;
  // Strip a trailing digit that belongs to integrated-graphics numbering (G7).
  if (/^G\d$/.test(upper)) return false;
  return ['K', 'KF', 'F', 'X', 'XE', 'T', 'S', 'E', 'KS'].includes(upper) || /^\d+$/.test(upper) === false && upper.length === 0;
}

/**
 * AMD desktop SKU suffixes. G parts (APUs like the 5600G) are socketed AM4/AM5;
 * H/HS/HX/U/C parts are mobile.
 * @param {string} suffix
 * @returns {boolean}
 */
export function isDesktopAmdSuffix(suffix) {
  const upper = (suffix ?? '').toUpperCase();
  if (!upper) return true;
  if (['H', 'HS', 'HX', 'U', 'C', 'E'].includes(upper)) return false;
  return ['X', 'XT', 'X3D', 'G', 'GE', 'GX', 'PRO'].includes(upper) || /X3D|XT/.test(upper);
}

/**
 * Map a Win32_Processor instance (plus cache instances) to fields.
 * Exported for testing against captured real-world payloads.
 *
 * @param {object} cpu
 * @param {{l2?:unknown, l3?:unknown, l1?:unknown}} [caches] Sizes in bytes.
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function mapCimProcessor(cpu, caches = {}) {
  const source = 'cim-win32';
  if (!cpu || typeof cpu !== 'object') {
    return { name: unavailable('Win32_Processor returned no instance', source) };
  }

  const name = cleanString(cpu.Name);
  const manufacturer = cleanString(cpu.Manufacturer);
  const identity = decodeCpuName(name, manufacturer);
  const cores = nonNegative(cpu.NumberOfCores);
  const threads = nonNegative(cpu.NumberOfLogicalProcessors);
  const maxClock = nonNegative(cpu.MaxClockSpeed);
  const currentClock = nonNegative(cpu.CurrentClockSpeed);
  const socket = deriveSocket(name);

  /** @type {Record<string, import('../core/field.js').FieldValue>} */
  const fields = {
    name: name ? available(name, source) : unavailable('Processor name not reported', source),
    manufacturer: manufacturer ? available(normaliseVendor(manufacturer), source) : unavailable('Manufacturer not reported', source),
    modelNumber: identity.modelNumber
      ? available(identity.modelNumber, 'model-table', { notes: [`Decoded from the processor name using rule "${identity.rule}".`] })
      : unavailable('Model number could not be decoded from the processor name', 'model-table'),
    productLine: identity.productLine ? available(identity.productLine, 'model-table') : unavailable('Product line not decoded', 'model-table'),
    generation: identity.generationLabel
      ? available(identity.generationLabel, 'model-table', { notes: [`Derived by rule "${identity.rule}" from the model number, not read from firmware.`] })
      : unavailable('Generation could not be decoded from the model number', 'model-table'),
    architecture: decodeArchitecture(cpu.Architecture)
      ? available(decodeArchitecture(cpu.Architecture), source)
      : unavailable(`Unrecognised architecture code ${String(cpu.Architecture)}`, source),
    physicalCores: cores !== null ? available(cores, source) : unavailable('Core count not reported', source),
    logicalCores: threads !== null ? available(threads, source) : unavailable('Thread count not reported', source),
    baseClock: maxClock !== null ? available(maxClock, source, { unit: 'MHz' }) : unavailable('Nominal clock not reported', source),
    currentClock: currentClock !== null ? available(currentClock, source, { unit: 'MHz' }) : unavailable('Current clock not reported', source),
    maxClock: maxClock !== null ? available(maxClock, source, { unit: 'MHz', notes: ['Win32_Processor.MaxClockSpeed reports the nominal/maximum configured clock, not a measured boost ceiling.'] }) : unavailable('Maximum clock not reported', source),
    boostClock: cpu.MaxClockSpeed && cpu.CurrentClockSpeed && num(cpu.CurrentClockSpeed) > num(cpu.MaxClockSpeed)
      ? available(num(cpu.CurrentClockSpeed), source, { unit: 'MHz', notes: ['Observed above the nominal clock at collection time, which indicates boost was active. This is an observation, not a rated boost frequency.'] })
      : unavailable('Rated boost frequency is not exposed by Windows; VERIDEX does not infer it', source),
    l1Cache: describeCache(caches.l1, source),
    l2Cache: describeCache(caches.l2, source),
    l3Cache: describeCache(caches.l3, source),
    virtualization: bool(cpu.VirtualizationFirmwareEnabled) === true
      ? available('Enabled in firmware', source)
      : bool(cpu.VirtualizationFirmwareEnabled) === false
        ? field('Reported as disabled in firmware', { status: Status.WARNING, source })
        : unavailable('Virtualisation status not reported by this firmware', source),
    socket: socket
      ? available(socket.socket, 'model-table', { notes: [`Derived from the desktop model number using rule "${socket.rule}". Mobile socket names are not published by Intel/AMD in a way Windows exposes, so they are left unavailable.`] })
      : unavailable('Socket is not exposed by Windows and could not be derived confidently', 'model-table'),
    processorId: cleanString(cpu.ProcessorId) ? available(cleanString(cpu.ProcessorId), source) : unavailable('Processor ID not reported', source),
    maxClockSpeedTolerance: num(cpu.CurrentVoltage) !== null ? available(num(cpu.CurrentVoltage) / 10, source, { unit: 'V' }) : unavailable('Core voltage not reported', source)
  };

  return fields;
}

/**
 * @param {unknown} sizeBytes
 * @param {string} source
 */
function describeCache(sizeBytes, source) {
  const bytes = nonNegative(sizeBytes);
  if (bytes === null || bytes === 0) return unavailable('Cache size not reported', source);
  return available(Math.round((bytes / 1024) * 10) / 10, source, { unit: 'KB' });
}

/**
 * @param {string} manufacturer
 */
function normaliseVendor(manufacturer) {
  const text = manufacturer.trim();
  if (/genuineintel|intel/i.test(text)) return 'Intel';
  if (/authenticamd|advanced micro devices|amd/i.test(text)) return 'AMD';
  if (/qualcomm/i.test(text)) return 'Qualcomm';
  if (/apple/i.test(text)) return 'Apple';
  if (/hygon/i.test(text)) return 'Hygon';
  return text;
}

/**
 * Sum Win32_CacheMemory instances into L1/L2/L3 totals, in bytes.
 * Level 3 in that class is the "unified" level; sizes are reported per instance so
 * summing is the correct aggregation for a per-core breakdown.
 * @param {object[]} cacheRows
 * @returns {{l1:number|null, l2:number|null, l3:number|null}}
 */
export function aggregateCaches(cacheRows) {
  const totals = { l1: 0, l2: 0, l3: 0 };
  const seen = { l1: false, l2: false, l3: false };
  for (const row of asArray(cacheRows)) {
    const level = num(row?.Level ?? row?.level);
    const size = nonNegative(row?.MaxCacheSize ?? row?.maxCacheSize ?? row?.InstalledSize ?? row?.installedSize ?? row?.CacheSize ?? row?.cacheSize);
    if (level === null || size === null) continue;
    if (level === 3) {
      // L3 is a single unified block; take the largest instance rather than
      // summing duplicates reported per cache SRAM block.
      totals.l3 = Math.max(totals.l3, size);
      seen.l3 = true;
    } else if (level === 2) {
      totals.l2 += size;
      seen.l2 = true;
    } else if (level === 1) {
      totals.l1 += size;
      seen.l1 = true;
    }
  }
  return { l1: seen.l1 ? totals.l1 : null, l2: seen.l2 ? totals.l2 : null, l3: seen.l3 ? totals.l3 : null };
}

/**
 * Map `systeminformation.cpu()` to the live fields CIM cannot give us.
 * @param {object} info
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function mapSystemInformationCpu(info) {
  const source = 'systeminformation';
  if (!info || typeof info !== 'object') return {};

  /** @type {Record<string, import('../core/field.js').FieldValue>} */
  const fields = {};
  const speed = nonNegative(info.speed);
  if (speed !== null && speed > 0) fields.currentClock = available(speed, source, { unit: 'GHz', notes: ['Reported by the OS as the current effective clock.'] });

  const flags = normaliseInstructionSets(info.flags);
  fields.instructionSets = flags.length > 0 ? available(flags, source) : unavailable('CPUID flag list not available from this source', source);

  if (typeof info.virtual === 'boolean') {
    fields.virtualization = info.virtual ? available('Enabled', source) : field('Reported as disabled', { status: Status.WARNING, source });
  }

  const cores = nonNegative(info.physicalCores);
  if (cores !== null && cores > 0) fields.physicalCores = available(cores, source);
  const logical = nonNegative(info.cores);
  if (logical !== null && logical > 0) fields.logicalCores = available(logical, source);

  return fields;
}

/**
 * Map `systeminformation.currentLoad()` for utilisation. Split out so the
 * monitoring engine can reuse it without duplicating the field construction.
 * @param {object} load
 * @returns {{total: import('../core/field.js').FieldValue, perCore: import('../core/field.js').FieldValue}}
 */
export function mapCurrentLoad(load) {
  const source = 'systeminformation';
  const total = num(load?.currentLoad);
  const perCore = asArray(load?.cpus)
    .map((core) => ({ core: nonNegative(core?.load), speed: nonNegative(core?.speed) }))
    .filter((entry) => entry.core !== null);

  return {
    total: total !== null && total >= 0 && total <= 100 ? available(Math.round(total * 10) / 10, source, { unit: '%' }) : unavailable('Total load not reported', source),
    perCore: perCore.length > 0 ? available(perCore, source, { unit: '%' }) : unavailable('Per-core load not reported', source)
  };
}

/**
 * Register the CPU providers and task.
 * @param {import('../engine/provider-registry.js').ProviderRegistry} registry
 */
export function registerCpu(registry) {
  registry.registerProvider({
    id: 'cim-win32',
    title: 'Windows CIM (Win32_Processor)',
    priority: 1,
    collect: async (ctx) => {
      const [processor, cache] = await Promise.all([
        queryCim(ctx.runner, 'Win32_Processor', { namespace: 'root/cimv2', name: 'cpu:win32_processor', timeoutMs: ctx.timeoutMs }),
        queryCim(ctx.runner, 'Win32_CacheMemory', { namespace: 'root/cimv2', name: 'cpu:win32_cachememory', timeoutMs: ctx.timeoutMs })
      ]);

      if (!processor.ok) {
        const cause = failureToStatus(processor);
        const make = cause.kind === 'permission' ? (reason) => field(null, { status: Status.PERMISSION_REQUIRED, error: reason, source: 'cim-win32', permissionRequired: true }) : cause.kind === 'unsupported' ? (reason) => unsupported(reason, 'cim-win32') : (reason) => failed(reason, 'cim-win32');
        return { name: make(processor.error ?? 'CPU identity unavailable') };
      }

      const caches = aggregateCaches(cache.rows);
      return mapCimProcessor(processor.rows[0], caches);
    }
  });

  registry.registerProvider({
    id: 'systeminformation',
    title: 'systeminformation (OS counters + CPUID)',
    priority: 2,
    collect: async () => {
      const loaded = await loadSystemInformation();
      if (!loaded.ok) return { instructionSets: unavailable(`systeminformation unavailable: ${loaded.error}`, 'systeminformation') };
      try {
        const [info, load] = await Promise.all([loaded.si.cpu(), loaded.si.currentLoad()]);
        const fields = mapSystemInformationCpu(info);
        const utilisation = mapCurrentLoad(load);
        fields.utilization = utilisation.total;
        fields.perCoreUtilization = utilisation.perCore;
        return fields;
      } catch (error) {
        return { instructionSets: failed(error, 'systeminformation') };
      }
    }
  });

  registry.registerProvider({
    id: 'model-table',
    title: 'VERIDEX model-number decoder',
    priority: 3,
    collect: async () => ({})
  });

  registry.registerTask({
    id: 'cpu.info',
    module: 'cpu',
    title: 'Processor',
    quick: true,
    providers: ['cim-win32', 'systeminformation', 'model-table'],
    validate: (fields) => {
      const problems = validateCoreCounts({
        physicalCores: fields.physicalCores?.value ?? null,
        logicalCores: fields.logicalCores?.value ?? null
      });
      const maxClock = fields.maxClock?.value;
      const currentClock = fields.currentClock?.value;
      if (typeof maxClock === 'number' && typeof currentClock === 'number' && currentClock > maxClock * 1.6) {
        problems.push(`current clock (${currentClock}) is implausibly above the nominal clock (${maxClock})`);
      }
      return problems;
    }
  });
}
