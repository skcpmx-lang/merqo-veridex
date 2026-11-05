/**
 * VERIDEX — Device identity (MODULE 01 & 16).
 *
 * Establishes what machine we are inspecting: manufacturer, model, SKU, chassis
 * type, and the vendor family used by the compatibility heuristics.
 *
 * Vendor detection matters beyond cosmetics: battery cycle-count paths, fan
 * sensors and driver tooling differ per vendor, and the compatibility report must
 * state which vendor-specific paths were actually attempted. The heuristics here
 * are therefore an explicit table with a stated match rule, never a hidden guess.
 */

import { available, unavailable, failed, field } from '../core/field.js';
import { Status } from '../core/status.js';
import { cleanString, num, bool, asArray } from '../platform/parse.js';
import { queryCim, loadSystemInformation, failureToStatus } from '../platform/windows.js';

/** SMBIOS chassis type codes worth naming. */
const CHASSIS_TYPES = Object.freeze({
  3: 'Desktop',
  4: 'Low-profile desktop',
  5: 'Pizza box',
  6: 'Mini tower',
  7: 'Tower',
  8: 'Portable',
  9: 'Laptop',
  10: 'Notebook',
  11: 'Handheld',
  12: 'Docking station',
  13: 'All-in-one',
  14: 'Sub-notebook',
  17: 'Main server chassis',
  23: 'Rack mount chassis',
  30: 'Tablet',
  31: 'Convertible',
  32: 'Detachable'
});

/**
 * Known Windows OEMs, with the SMBIOS strings they actually ship. Matching is
 * case-insensitive on manufacturer first, then model as a secondary signal
 * (some whitebox boards report a generic manufacturer but a branded model).
 */
export const OEM_TABLE = Object.freeze([
  { id: 'dell', name: 'Dell', patterns: [/dell/i, /alienware/i], modelPatterns: [/latitude/i, /inspiron/i, /xps/i, /vostro/i, /precision/i, /optiplex/i, /alienware/i, /g15/i, /g16/i] },
  { id: 'hp', name: 'HP', patterns: [/hewlett[- ]?packard/i, /\bhp\b/i, /\bhp inc\b/i], modelPatterns: [/elitebook/i, /probook/i, /pavilion/i, /envy/i, /spectre/i, /omen/i, /victus/i, /zbook/i, /prodesk/i, /elitedesk/i] },
  { id: 'lenovo', name: 'Lenovo', patterns: [/lenovo/i, /ibm/i], modelPatterns: [/thinkpad/i, /ideapad/i, /legion/i, /yoga/i, /thinkbook/i, /thinkcentre/i, /loq/i] },
  { id: 'asus', name: 'ASUS', patterns: [/asus/i, /asustek/i], modelPatterns: [/zenbook/i, /vivobook/i, /rog/i, /tuf/i, /expertbook/i, /proart/i] },
  { id: 'acer', name: 'Acer', patterns: [/acer/i, /\bacer\b/i], modelPatterns: [/aspire/i, /nitro/i, /predator/i, /swift/i, /travelmate/i, /extensa/i] },
  { id: 'msi', name: 'MSI', patterns: [/micro-star/i, /\bmsi\b/i], modelPatterns: [/katana/i, /raider/i, /stealth/i, /cyborg/i, /modern/i, /prestige/i, /gf\d/i, /ge\d\d/i] },
  { id: 'microsoft', name: 'Microsoft Surface', patterns: [/microsoft/i], modelPatterns: [/surface/i] },
  { id: 'samsung', name: 'Samsung', patterns: [/samsung/i], modelPatterns: [/notebook/i, /galaxy book/i, /odyssey/i] },
  { id: 'toshiba', name: 'Toshiba / Dynabook', patterns: [/toshiba/i, /dynabook/i], modelPatterns: [/satellite/i, /portege/i, /tecra/i, /dynabook/i] },
  { id: 'gigabyte', name: 'Gigabyte', patterns: [/gigabyte/i, /\bgiga-byte\b/i], modelPatterns: [/aorus/i, /aero/i, /gaming/i] },
  { id: 'apple', name: 'Apple (Boot Camp)', patterns: [/apple/i], modelPatterns: [/macbook/i, /imac/i, /macmini/i, /mac pro/i] },
  { id: 'razer', name: 'Razer', patterns: [/razer/i], modelPatterns: [/blade/i] },
  { id: 'huawei', name: 'Huawei', patterns: [/huawei/i], modelPatterns: [/matebook/i] },
  { id: 'xiaomi', name: 'Xiaomi', patterns: [/xiaomi/i], modelPatterns: [/redmibook/i, /mi notebook/i] },
  { id: 'framework', name: 'Framework', patterns: [/framework/i], modelPatterns: [/laptop \d/i] },
  { id: 'clevo', name: 'Clevo / Tongfang (whitebox)', patterns: [/clevo/i, /tongfang/i, /notebook computer/i], modelPatterns: [] }
]);

/**
 * Identify the OEM from SMBIOS strings.
 * @param {{manufacturer?:string|null, model?:string|null, boardManufacturer?:string|null}} input
 * @returns {{id:string, name:string, confidence:'matched-manufacturer'|'matched-model'|'unknown', rule:string}}
 */
export function identifyOem(input = {}) {
  const manufacturer = cleanString(input.manufacturer) ?? '';
  const model = cleanString(input.model) ?? '';
  const board = cleanString(input.boardManufacturer) ?? '';

  for (const vendor of OEM_TABLE) {
    if (vendor.patterns.some((pattern) => pattern.test(manufacturer))) {
      return { id: vendor.id, name: vendor.name, confidence: 'matched-manufacturer', rule: `manufacturer string matched /${vendor.patterns[0].source}/` };
    }
  }
  // Secondary: model name. Used when the manufacturer field is generic.
  for (const vendor of OEM_TABLE) {
    if (vendor.modelPatterns.some((pattern) => pattern.test(model))) {
      return { id: vendor.id, name: vendor.name, confidence: 'matched-model', rule: `model string matched /${vendor.modelPatterns[0].source}/` };
    }
  }
  if (board) {
    for (const vendor of OEM_TABLE) {
      if (vendor.id === 'clevo') continue;
      if (vendor.patterns.some((pattern) => pattern.test(board))) {
        return { id: vendor.id, name: vendor.name, confidence: 'matched-manufacturer', rule: 'motherboard manufacturer matched' };
      }
    }
  }
  return { id: 'generic', name: manufacturer || 'Unrecognised vendor', confidence: 'unknown', rule: 'no table entry matched; generic Windows collection paths apply' };
}

/**
 * Classify the machine as laptop/desktop/tablet from chassis type, falling back to
 * the presence of a battery only when the chassis type is absent.
 * @param {{chassisCode?:unknown, batteryPresent?:boolean|null}} input
 * @returns {{formFactor:string, rule:string}|null}
 */
export function classifyFormFactor(input = {}) {
  const code = num(input.chassisCode);
  if (code !== null && CHASSIS_TYPES[code]) {
    const label = CHASSIS_TYPES[code];
    const portable = ['Portable', 'Laptop', 'Notebook', 'Handheld', 'Sub-notebook', 'Tablet', 'Convertible', 'Detachable'].includes(label);
    return { formFactor: portable ? 'Portable' : label === 'Desktop' || label.includes('tower') || label.includes('desktop') ? 'Desktop' : label, rule: `SMBIOS chassis type ${code}` };
  }
  if (input.batteryPresent === true) return { formFactor: 'Portable', rule: 'inferred from the presence of a battery because the chassis type was not reported' };
  if (input.batteryPresent === false) return { formFactor: 'Desktop', rule: 'inferred from the absence of a battery because the chassis type was not reported' };
  return null;
}

/**
 * Map Win32_ComputerSystem + Win32_ComputerSystemProduct into identity fields.
 * @param {object} system
 * @param {object} product
 * @param {object} [bios]
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function mapSystemIdentity(system, product, bios = null) {
  const source = 'cim-win32';
  if (!system && !product) return { identity: unavailable('Win32_ComputerSystem and Win32_ComputerSystemProduct both returned nothing', source) };

  const manufacturer = cleanString(system?.Manufacturer) ?? cleanString(product?.Vendor);
  const model = cleanString(system?.Model) ?? cleanString(product?.Name);
  const boardManufacturer = cleanString(bios?.Manufacturer);
  const oem = identifyOem({ manufacturer, model, boardManufacturer });
  const chassis = num(system?.PCSystemType);

  const fields = {
    manufacturer: manufacturer ? available(manufacturer, source) : unavailable('System manufacturer not reported', source),
    model: model ? available(model, source) : unavailable('System model not reported', source),
    sku: cleanString(system?.SystemSKUNumber) ? available(cleanString(system.SystemSKUNumber), source) : unavailable('System SKU not reported (common on custom-built systems)', source),
    serialNumber: cleanString(product?.IdentifyingNumber)
      ? available(cleanString(product.IdentifyingNumber), source, { notes: ['Sensitive identifier: redacted from reports unless enabled in Privacy settings.'] })
      : unavailable('System serial number not reported, or the firmware returns a placeholder', source),
    systemFamily: cleanString(system?.SystemFamily) ? available(cleanString(system.SystemFamily), source) : unavailable('System family not reported', source),
    systemType: chassis !== null ? available(chassis === 2 ? 'Mobile' : chassis === 1 ? 'Desktop' : `PC system type ${chassis}`, source) : unavailable('PC system type not reported', source),
    vendorFamily: available(`${oem.name} (${oem.confidence})`, 'vendor-heuristic', { notes: [`Matched by ${oem.rule}. Vendor identification drives which vendor-specific collection paths are attempted and is recorded so a wrong match is visible.`] })
  };

  return fields;
}

/**
 * Register device identity providers and task.
 * @param {import('../engine/provider-registry.js').ProviderRegistry} registry
 */
export function registerSystem(registry) {
  registry.registerProvider({
    id: 'cim-win32.system',
    title: 'Windows CIM (Win32_ComputerSystem)',
    priority: 1,
    collect: async (ctx) => {
      const [system, product, bios] = await Promise.all([
        queryCim(ctx.runner, 'Win32_ComputerSystem', { name: 'system:computer', timeoutMs: ctx.timeoutMs }),
        queryCim(ctx.runner, 'Win32_ComputerSystemProduct', { name: 'system:product', timeoutMs: ctx.timeoutMs }),
        queryCim(ctx.runner, 'Win32_BIOS', { name: 'system:bios', timeoutMs: ctx.timeoutMs })
      ]);
      if (!system.ok && !product.ok) {
        const cause = failureToStatus(system);
        if (cause.kind === 'permission') return { identity: field(null, { status: Status.PERMISSION_REQUIRED, permissionRequired: true, error: cause.reason, source: 'cim-win32.system' }) };
        return { identity: failed(system.error ?? 'Device identity unavailable', 'cim-win32.system') };
      }
      return mapSystemIdentity(system.rows[0] ?? null, product.rows[0] ?? null, bios.rows[0] ?? null);
    }
  });

  registry.registerProvider({
    id: 'systeminformation.system',
    title: 'systeminformation (system identity)',
    priority: 2,
    collect: async () => {
      const loaded = await loadSystemInformation();
      if (!loaded.ok) return {};
      try {
        const [osInfo, system] = await Promise.all([loaded.si.osInfo(), loaded.si.system()]);
        return {
          hostname: cleanString(system?.hostname) ? available(cleanString(system.hostname), 'systeminformation.system', { notes: ['Sensitive identifier: redacted from reports unless enabled.'] }) : unavailable('Hostname not reported', 'systeminformation.system'),
          osPlatform: cleanString(osInfo?.platform) ? available(cleanString(osInfo.platform), 'systeminformation') : unavailable('Platform not reported', 'systeminformation.system')
        };
      } catch {
        return {};
      }
    }
  });

  registry.registerTask({
    id: 'system.identity',
    module: 'system',
    title: 'System identity',
    quick: true,
    providers: ['cim-win32.system', 'systeminformation.system']
  });
}

export { CHASSIS_TYPES };
