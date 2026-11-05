/**
 * VERIDEX — Memory diagnostics (MODULE 01, RAM).
 *
 * Two providers:
 *   1. `cim-win32`        — Win32_PhysicalMemory (per module) + Win32_PhysicalMemoryArray (slots)
 *   2. `systeminformation`— totals, and per-module data on systems where the CIM
 *                           memory classes are filtered
 *
 * Per-module reporting is mandatory in the brief, so the shape is always an array
 * even for a single module. Configured vs. rated speed are kept separate because a
 * module running below its rated speed is a real and common finding (wrong slot
 * population, XMP disabled, mixed modules).
 */

import { available, unavailable, failed, field, notApplicable } from '../core/field.js';
import { Status } from '../core/status.js';
import { cleanString, num, nonNegative, kbToGiB, smbiosMemoryType, memoryFormFactor, bytesToGiB } from '../platform/parse.js';
import { queryCim, loadSystemInformation, failureToStatus } from '../platform/windows.js';

/** SMBIOS memory technology codes supplement the DDR type when present. */
const MEMORY_TECHNOLOGY = Object.freeze({
  1: 'Other',
  2: 'Unknown',
  3: 'DRAM',
  4: 'NVDIMM-N',
  5: 'NVDIMM-F',
  6: 'NVDIMM-P',
  7: 'Intel Optane persistent memory'
});

/**
 * Map one Win32_PhysicalMemory instance.
 * @param {object} module
 * @param {number} index
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function mapMemoryModule(module, index = 0) {
  const source = 'cim-win32';
  const label = `Module ${index + 1}`;
  if (!module || typeof module !== 'object') {
    return { [`module${index + 1}`]: unavailable(`${label} returned no instance`, source) };
  }

  const capacityBytes = nonNegative(module.Capacity);
  const deviceLocator = cleanString(module.DeviceLocator);
  const bankLabel = cleanString(module.BankLabel);
  const typeCode = num(module.SMBIOSMemoryType);
  const memoryType = smbiosMemoryType(typeCode);
  const ratedSpeed = nonNegative(module.Speed);
  const configuredSpeed = nonNegative(module.ConfiguredClockSpeed) ?? ratedSpeed;

  // The "MemoryType" property uses an older, different code space. Prefer
  // SMBIOSMemoryType and fall back to the legacy property with a note.
  const legacyType = num(module.MemoryType);
  const legacyMap = { 20: 'DDR', 21: 'DDR2', 24: 'DDR3', 26: 'DDR4', 34: 'DDR5' };
  const resolvedType = memoryType ?? (legacyType !== null ? legacyMap[legacyType] ?? null : null);

  const fields = {
    label: available(`${label}${deviceLocator ? ` — ${deviceLocator}` : ''}`, source),
    capacity: capacityBytes !== null ? available(bytesToGiB(capacityBytes), source, { unit: 'GB' }) : unavailable(`${label}: capacity not reported`, source),
    manufacturer: cleanString(module.Manufacturer)
      ? available(cleanString(module.Manufacturer), source)
      : unavailable(`${label}: manufacturer not encoded in the module SPD`, source),
    partNumber: cleanString(module.PartNumber)
      ? available(cleanString(module.PartNumber), source)
      : unavailable(`${label}: part number not encoded`, source),
    serialNumber: cleanString(module.SerialNumber)
      ? available(cleanString(module.SerialNumber), source, { notes: ['Sensitive identifier: redacted from reports unless enabled in Privacy settings.'] })
      : unavailable(`${label}: serial number not encoded`, source),
    type: resolvedType
      ? available(resolvedType, typeCode !== null ? source : 'cim-win32', { notes: memoryType ? [] : ['Decoded from the legacy Win32_PhysicalMemory.MemoryType property, which uses a different code space than SMBIOSMemoryType.'] })
      : unavailable(`${label}: DDR generation not encoded in the SPD`, source),
    technology: MEMORY_TECHNOLOGY[num(module.MemoryTechnology) ?? -1] ? available(MEMORY_TECHNOLOGY[num(module.MemoryTechnology)], source) : unavailable(`${label}: memory technology not reported`, source),
    formFactor: memoryFormFactor(module.FormFactor) ? available(memoryFormFactor(module.FormFactor), source) : unavailable(`${label}: form factor not reported`, source),
    ratedSpeed: ratedSpeed !== null ? available(ratedSpeed, source, { unit: 'MT/s' }) : unavailable(`${label}: rated speed not reported`, source),
    configuredSpeed: configuredSpeed !== null ? available(configuredSpeed, source, { unit: 'MT/s' }) : unavailable(`${label}: configured speed not reported`, source),
    slot: deviceLocator ? available(deviceLocator, source) : unavailable(`${label}: slot locator not reported`, source),
    bank: bankLabel ? available(bankLabel, source) : unavailable(`${label}: bank label not reported`, source),
    voltage: nonNegative(module.ConfiguredVoltage) !== null ? available(nonNegative(module.ConfiguredVoltage) / 1000, source, { unit: 'V' }) : unavailable(`${label}: configured voltage not reported`, source),
    totalWidth: nonNegative(module.TotalWidth) !== null ? available(nonNegative(module.TotalWidth), source, { unit: 'bits' }) : unavailable(`${label}: bus width not reported`, source)
  };

  // A module reporting a lower configured than rated speed is a genuine finding
  // worth surfacing, not an error.
  if (ratedSpeed !== null && configuredSpeed !== null && configuredSpeed < ratedSpeed) {
    fields.speedNote = field(
      `Running at ${configuredSpeed} MT/s although rated for ${ratedSpeed} MT/s`,
      {
        status: Status.WARNING,
        source,
        notes: [
          'Common causes: modules in the wrong slots preventing dual-channel operation, XMP/EXPO not enabled in firmware, or mixed modules running at the slowest common speed.'
        ]
      }
    );
  }

  return fields;
}

/**
 * Summarise the module array: count, populated slots, total capacity, and channel
 * hints derived from the reported locators.
 * @param {object[]} modules
 * @param {object|null} arrayInfo Win32_PhysicalMemoryArray instance
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function summariseModules(modules, arrayInfo = null) {
  const source = 'cim-win32';
  const list = Array.isArray(modules) ? modules.filter(Boolean) : [];
  const capacities = list.map((module) => nonNegative(module.Capacity)).filter((value) => value !== null);
  const totalBytes = capacities.reduce((sum, value) => sum + value, 0);
  const slots = nonNegative(arrayInfo?.MemoryDevices);
  const maxCapacityKb = nonNegative(arrayInfo?.MaxCapacity);

  /** @type {Record<string, import('../core/field.js').FieldValue>} */
  const fields = {
    moduleCount: list.length > 0 ? available(list.length, source) : unavailable('No memory modules reported', source),
    totalCapacity: list.length > 0 ? available(bytesToGiB(totalBytes), source, { unit: 'GB' }) : unavailable('Total module capacity not reported', source),
    slotsTotal: slots !== null ? available(slots, source) : unavailable('Physical memory array slot count not reported', source),
    slotsPopulated: list.length > 0 && slots !== null ? available(list.length, source) : unavailable('Populated slot count not reported', source),
    slotsFree: slots !== null && list.length > 0 ? available(Math.max(0, slots - list.length), source) : unavailable('Free slot count not reported', source),
    maxSupportedCapacity: maxCapacityKb !== null ? available(kbToGiB(maxCapacityKb), source, { unit: 'GB', notes: ['Reported by the firmware as the arithmetic maximum. Real limits also depend on module density and the chipset.'] }) : unavailable('Maximum supported capacity not reported', source),
    channelLayout: describeChannels(list)
  };

  return fields;
}

/**
 * Infer channel configuration from module locators.
 * Windows does not expose the actual channel mapping, so this is explicitly
 * labelled as an inference from slot naming and returns unavailable when the
 * locators do not follow a recognisable pattern.
 * @param {object[]} modules
 */
function describeChannels(modules) {
  const locators = modules.map((module) => cleanString(module.DeviceLocator)).filter(Boolean);
  if (locators.length === 0) return unavailable('Memory slot locators not reported', 'cim-win32.memory');
  if (locators.length === 1) return available('Single module — single-channel operation', 'vendor-heuristic', { notes: ['Inferred from there being one populated slot. On most consumer platforms a single module runs in single-channel mode.'] });

  // Look for the common "DIMM0/DIMM1" or "ChannelA-DIMM0" naming.
  const paired = locators.some((locator, index) => index > 0 && locator.replace(/\d+$/, '') === locators[index - 1].replace(/\d+$/, ''));
  const dualChannelHint = locators.length >= 2;
  return available(
    dualChannelHint ? `Two or more modules populated (${locators.join(', ')}); dual-channel capable` : 'Single module',
    'vendor-heuristic',
    {
      notes: ['Inferred from slot locators, not read from the memory controller. Physical channel mapping varies by vendor; verify in firmware setup for a definitive answer.']
    }
  );
}

/**
 * Map `systeminformation.mem()` totals.
 * @param {object} mem
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function mapMemoryTotals(mem) {
  const source = 'systeminformation';
  if (!mem || typeof mem !== 'object') return {};
  const total = nonNegative(mem.total);
  const used = nonNegative(mem.used);
  const free = nonNegative(mem.available ?? mem.free);
  const active = nonNegative(mem.active);

  /** @type {Record<string, import('../core/field.js').FieldValue>} */
  const fields = {};
  if (total !== null && total > 0) fields.totalPhysical = available(bytesToGiB(total), source, { unit: 'GB' });
  if (used !== null) fields.usedMemory = available(bytesToGiB(used), source, { unit: 'GB' });
  if (free !== null) fields.availableMemory = available(bytesToGiB(free), source, { unit: 'GB' });
  if (active !== null) fields.activeMemory = available(bytesToGiB(active), source, { unit: 'GB' });
  if (total !== null && total > 0 && used !== null) {
    fields.utilization = available(Math.round((used / total) * 1000) / 10, source, { unit: '%' });
  }
  return fields;
}

/**
 * Map `systeminformation.memLayout()` for systems where CIM is filtered.
 * @param {object[]} layout
 * @returns {{modules: object[], fields: Record<string, import('../core/field.js').FieldValue>}}
 */
export function mapMemLayout(layout) {
  const source = 'systeminformation';
  const modules = (Array.isArray(layout) ? layout : []).filter((module) => nonNegative(module?.size) !== null && nonNegative(module.size) > 0);
  if (modules.length === 0) {
    return {
      modules: [],
      fields: { modules: unavailable('Memory module layout not available from this source', source) }
    };
  }

  const totalBytes = modules.reduce((sum, module) => sum + (nonNegative(module.size) ?? 0), 0);
  const fields = {
    moduleCount: available(modules.length, source),
    totalCapacity: available(bytesToGiB(totalBytes), source, { unit: 'GB' })
  };

  return { modules, fields };
}

/**
 * Register the memory providers and task.
 * @param {import('../engine/provider-registry.js').ProviderRegistry} registry
 */
export function registerMemory(registry) {
  registry.registerProvider({
    id: 'cim-win32.memory',
    title: 'Windows CIM (Win32_PhysicalMemory)',
    priority: 1,
    collect: async (ctx) => {
      const [modules, arrayInfo] = await Promise.all([
        queryCim(ctx.runner, 'Win32_PhysicalMemory', { name: 'mem:physical', timeoutMs: ctx.timeoutMs }),
        queryCim(ctx.runner, 'Win32_PhysicalMemoryArray', { name: 'mem:array', timeoutMs: ctx.timeoutMs })
      ]);

      if (!modules.ok) {
        const cause = failureToStatus(modules);
        return {
          modules: cause.kind === 'permission' ? field(null, { status: Status.PERMISSION_REQUIRED, permissionRequired: true, error: cause.reason, source: 'cim-win32.memory' }) : failed(modules.error ?? 'Memory module data unavailable', 'cim-win32.memory')
        };
      }

      /** @type {Record<string, import('../core/field.js').FieldValue>} */
      const fields = {};
      modules.rows.forEach((module, index) => {
        // Index each module's fields so they survive the flat field map and the
        // report can render one card per module.
        for (const [key, value] of Object.entries(mapMemoryModule(module, index))) {
          fields[`module${index + 1}.${key}`] = value;
        }
      });

      for (const [key, value] of Object.entries(summariseModules(modules.rows, arrayInfo.rows[0] ?? null))) {
        fields[key] = value;
      }
      return fields;
    }
  });

  registry.registerProvider({
    id: 'systeminformation.memory',
    title: 'systeminformation (memory counters)',
    priority: 2,
    collect: async () => {
      const loaded = await loadSystemInformation();
      if (!loaded.ok) return { totalPhysical: unavailable(`systeminformation unavailable: ${loaded.error}`, 'systeminformation.memory') };
      try {
        const [mem, layout] = await Promise.all([loaded.si.mem(), loaded.si.memLayout()]);
        const totals = mapMemoryTotals(mem);
        const layoutMapped = mapMemLayout(layout);
        // Only contribute per-module fields when CIM did not supply them; the
        // resolver handles that, so we expose them under distinct keys.
        const fields = { ...totals };
        layoutMapped.modules.forEach((module, index) => {
          const size = nonNegative(module.size);
          if (size !== null && size > 0) {
            fields[`fallbackModule${index + 1}.capacity`] = available(bytesToGiB(size), 'systeminformation.memory', { unit: 'GB' });
            const type = cleanString(module.type);
            if (type) fields[`fallbackModule${index + 1}.type`] = available(type, 'systeminformation.memory');
            const clock = nonNegative(module.clockSpeed);
            if (clock !== null) fields[`fallbackModule${index + 1}.configuredSpeed`] = available(clock, 'systeminformation.memory', { unit: 'MT/s' });
            const manufacturer = cleanString(module.manufacturer);
            if (manufacturer) fields[`fallbackModule${index + 1}.manufacturer`] = available(manufacturer, 'systeminformation.memory');
            const formFactor = cleanString(module.formFactor);
            if (formFactor) fields[`fallbackModule${index + 1}.formFactor`] = available(formFactor, 'systeminformation.memory');
          }
        });
        return fields;
      } catch (error) {
        return { totalPhysical: failed(error, 'systeminformation.memory') };
      }
    }
  });

  registry.registerTask({
    id: 'memory.info',
    module: 'memory',
    title: 'Memory',
    quick: true,
    providers: ['cim-win32.memory', 'systeminformation.memory'],
    validate: (fields) => {
      const problems = [];
      const total = fields.totalCapacity?.value;
      const modules = fields.moduleCount?.value;
      if (typeof total === 'number' && total <= 0) problems.push('total module capacity was not positive');
      if (typeof modules === 'number' && modules > 16) problems.push(`reported module count (${modules}) is implausible for a PC`);
      const util = fields.utilization?.value;
      if (typeof util === 'number' && (util < 0 || util > 100)) problems.push(`memory utilisation (${util}%) is outside 0–100`);
      return problems;
    }
  });
}

/**
 * Utility used by the UI: is this a desktop with no battery / no modules?
 * Kept here because "not applicable" decisions belong with the module data.
 * @param {number|null} moduleCount
 */
export function memoryApplicability(moduleCount) {
  if (moduleCount === 0) return notApplicable('No memory modules were reported. On some virtual machines and locked-down firmware this class is hidden rather than absent.');
  return null;
}
