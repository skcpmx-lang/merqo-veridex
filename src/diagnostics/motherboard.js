/**
 * VERIDEX — Motherboard, firmware and platform security (MODULE 01).
 *
 * Board and BIOS identity come from SMBIOS through CIM. UEFI mode is read from the
 * firmware-boot-type registry value; Secure Boot is read through
 * `Confirm-SecureBootUEFI`, which is the only reliable read when the platform is
 * in UEFI mode (the CIM value is unreliable and already-deprecated on several
 * builds). TPM lives here too because it is a platform-firmware property.
 *
 * Where a read is unavailable the field says why: "no UEFI" and "needs admin" are
 * different answers and both differ from "unknown".
 */

import { available, unavailable, unsupported, field } from '../core/field.js';
import { Status } from '../core/status.js';
import { cleanString, num, bool, date, nonNegative, kbToGiB } from '../platform/parse.js';
import { queryCim, readRegistry, runReadOnly, failureToStatus } from '../platform/windows.js';
import { gate } from '../platform/permissions.js';

/** BIOS characteristic bit for UEFI support (SMBIOS 2.6+). */
const BIOS_CHARACTERISTIC_UEFI = 8;

/**
 * Map Win32_BaseBoard.
 * @param {object} board
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function mapBaseBoard(board) {
  const source = 'cim-win32';
  if (!board || typeof board !== 'object') return { board: unavailable('Win32_BaseBoard returned no instance', source) };

  return {
    boardManufacturer: cleanString(board.Manufacturer) ? available(cleanString(board.Manufacturer), source) : unavailable('Motherboard manufacturer not reported', source),
    boardProduct: cleanString(board.Product) ? available(cleanString(board.Product), source) : unavailable('Motherboard product name not reported', source),
    boardVersion: cleanString(board.Version) ? available(cleanString(board.Version), source) : unavailable('Board revision not reported', source),
    boardSerial: cleanString(board.SerialNumber)
      ? available(cleanString(board.SerialNumber), source, { notes: ['Sensitive identifier: redacted from reports unless enabled.'] })
      : unavailable('Motherboard serial number not reported', source),
    boardTag: cleanString(board.Tag) ? available(cleanString(board.Tag), source) : unavailable('Board tag not reported', source)
  };
}

/**
 * Map Win32_BIOS.
 * @param {object} bios
 * @param {{bootMode?:'UEFI'|'Legacy'|null}} [context]
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function mapBios(bios, context = {}) {
  const source = 'cim-win32';
  if (!bios || typeof bios !== 'object') return { bios: unavailable('Win32_BIOS returned no instance', source) };

  const releaseDate = date(bios.ReleaseDate);
  const characteristics = Array.isArray(bios.BiosCharacteristics) ? bios.BiosCharacteristics.map(Number) : [];
  const uefiFromCharacteristics = characteristics.includes(BIOS_CHARACTERISTIC_UEFI);

  let bootMode = null;
  if (context.bootMode) {
    bootMode = available(context.bootMode, 'registry', {
      notes: ['Read from HKLM\\SYSTEM\\CurrentControlSet\\Control\\SecureBoot\\State\\UEFISecureBootEnabled\'s parent key (PEFirmwareType), which reflects how Windows was booted.']
    });
  } else if (uefiFromCharacteristics) {
    bootMode = available('UEFI (firmware reports UEFI support)', source);
  } else {
    bootMode = unavailable('Firmware boot mode not reported', source);
  }

  return {
    biosManufacturer: cleanString(bios.Manufacturer) ? available(cleanString(bios.Manufacturer), source) : unavailable('BIOS vendor not reported', source),
    biosVersion: cleanString(bios.SMBIOSBIOSVersion) ?? cleanString(bios.Version) ? available(cleanString(bios.SMBIOSBIOSVersion) ?? cleanString(bios.Version), source) : unavailable('BIOS version not reported', source),
    biosReleaseDate: releaseDate ? available(releaseDate.slice(0, 10), source, { notes: ['SMBIOS release date, not the date the update was installed.'] }) : unavailable('BIOS release date not reported or not parseable', source),
    biosVersionRaw: cleanString(bios.Version) ? available(cleanString(bios.Version), source) : unavailable('Raw BIOS version string not reported', source),
    biosSerial: cleanString(bios.SerialNumber) ? available(cleanString(bios.SerialNumber), source, { notes: ['Sensitive identifier: redacted from reports unless enabled.'] }) : unavailable('BIOS serial number not reported', source),
    bootMode
  };
}

/**
 * Map TPM state from `Get-Tpm` output.
 * @param {object|null} tpm
 * @param {string|null} error
 * @param {boolean} permissionBlocked
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function mapTpm(tpm, error = null, permissionBlocked = false) {
  const source = 'cim-win32';
  if (permissionBlocked) {
    return {
      tpmPresent: field(null, { status: Status.PERMISSION_REQUIRED, permissionRequired: true, source, error: 'TPM status requires administrative rights' }),
      tpmVersion: field(null, { status: Status.PERMISSION_REQUIRED, permissionRequired: true, source, error: 'TPM status requires administrative rights' })
    };
  }
  if (!tpm || typeof tpm !== 'object') {
    return {
      tpmPresent: unavailable(error ?? 'TPM information not returned by Get-Tpm. On Windows 10/11 this usually means the platform has no enabled TPM.', source),
      tpmVersion: unavailable(error ?? 'TPM version not available', source)
    };
  }

  const present = bool(tpm.TpmPresent);
  const ready = bool(tpm.TpmReady);
  const enabled = bool(tpm.TpmEnabled);
  const version = cleanString(tpm.SpecVersion) ?? (tpm.ManufacturerIdTxt ? null : null);
  const manufacturerText = cleanString(tpm.ManufacturerIdTxt);

  /** @type {Record<string, import('../core/field.js').FieldValue>} */
  const fields = {
    tpmPresent: present === true ? available('Present', source) : present === false ? field('Not present', { status: Status.WARNING, source }) : unavailable('TPM presence not reported', source),
    tpmVersion: version ? available(version, source) : unavailable('TPM specification version not reported', source),
    tpmEnabled: enabled === true ? available('Enabled', source) : enabled === false ? field('Disabled', { status: Status.WARNING, source }) : unavailable('TPM enabled state not reported', source),
    tpmReady: ready === true ? available('Ready', source) : ready === false ? field('Not ready', { status: Status.WARNING, source }) : unavailable('TPM ready state not reported', source),
    tpmManufacturer: manufacturerText ? available(manufacturerText, source) : unavailable('TPM manufacturer not reported', source),
    tpmActivated: bool(tpm.TpmActivated) === true ? available('Activated', source) : bool(tpm.TpmActivated) === false ? field('Not activated', { status: Status.WARNING, source }) : unavailable('TPM activation state not reported', source)
  };

  if (present === false) {
    fields.tpmNote = field('This platform reports no TPM. Windows 11 requires TPM 2.0, so this is expected on older Windows 10 hardware.', { status: Status.NOT_APPLICABLE, source });
  }

  return fields;
}

/**
 * Map Secure Boot state.
 * @param {{supported:boolean|null, enabled:boolean|null, error:string|null, permissionBlocked?:boolean}} input
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function mapSecureBoot(input) {
  const source = 'cim-win32';
  const { supported, enabled, error, permissionBlocked = false } = input;

  if (permissionBlocked) {
    return { secureBoot: field(null, { status: Status.PERMISSION_REQUIRED, permissionRequired: true, source, error: error ?? 'Secure Boot state requires administrative rights' }) };
  }
  if (supported === false) {
    return { secureBoot: unsupported('This system booted in legacy BIOS/CSM mode, where Secure Boot does not exist.', source) };
  }
  if (enabled === true) return { secureBoot: available('Enabled', source) };
  if (enabled === false) return { secureBoot: field('Disabled', { status: Status.WARNING, source, notes: ['Secure Boot is available but turned off. Windows 11 requires it to be enabled.'] }) };
  return { secureBoot: unavailable(error ?? 'Secure Boot state not reported', source) };
}

/**
 * Register motherboard/firmware providers and task.
 * @param {import('../engine/provider-registry.js').ProviderRegistry} registry
 */
export function registerMotherboard(registry) {
  registry.registerProvider({
    id: 'cim-win32',
    title: 'Windows CIM (Win32_BaseBoard / Win32_BIOS / TPM)',
    priority: 1,
    capability: 'security.tpm',
    collect: async (ctx) => {
      const [board, bios, firmwareType, secureBootProbe, tpmProbe] = await Promise.all([
        queryCim(ctx.runner, 'Win32_BaseBoard', { name: 'board', timeoutMs: ctx.timeoutMs }),
        queryCim(ctx.runner, 'Win32_BIOS', { name: 'bios', timeoutMs: ctx.timeoutMs }),
        queryCim(ctx.runner, 'Get-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\SecureBoot\\State" -Name PEFirmwareType -ErrorAction SilentlyContinue', { name: 'pefirmwaretype', timeoutMs: ctx.timeoutMs }),
        readRegistry(ctx.runner, 'HKLM:\\SYSTEM\\CurrentControlSet\\Control', { names: ['PEFirmwareType'], timeoutMs: ctx.timeoutMs }),
        ctx.runner.powershellJson('Get-Tpm -ErrorAction SilentlyContinue', { name: 'tpm', timeoutMs: ctx.timeoutMs })
      ]).catch(() => [{ ok: false, rows: [] }, { ok: false, rows: [] }, { ok: false, rows: [] }, { ok: false, values: [] }, { ok: false, data: null, error: 'probe failed' }]);

      /** @type {Record<string, import('../core/field.js').FieldValue>} */
      const fields = {};

      if (board.ok) Object.assign(fields, mapBaseBoard(board.rows[0]));
      else fields.boardManufacturer = unavailable(board.error ?? 'Motherboard identity unavailable', 'cim-win32');

      // PEFirmwareType: 2 = UEFI, 1 = BIOS/legacy.
      const firmwareValue = firmwareType.rows?.[0]?.PEFirmwareType ?? firmwareProbe.values?.find((entry) => entry.name === 'PEFirmwareType')?.value;
      const firmwareCode = num(firmwareValue);
      const bootMode = firmwareCode === 2 ? 'UEFI' : firmwareCode === 1 ? 'Legacy (BIOS/CSM)' : null;

      if (bios.ok) Object.assign(fields, mapBios(bios.rows[0], { bootMode }));
      else fields.biosVersion = unavailable(bios.error ?? 'BIOS identity unavailable', 'cim-win32');

      // Secure Boot: only meaningful in UEFI mode.
      if (bootMode === 'Legacy (BIOS/CSM)' || bootMode === null) {
        Object.assign(fields, mapSecureBoot({ supported: bootMode === 'Legacy (BIOS/CSM)' ? false : null, enabled: null, error: bootMode === null ? 'Firmware boot mode could not be determined, so Secure Boot state is not meaningful' : null }));
      } else {
        const secureBoot = await ctx.runner.powershellJson('Confirm-SecureBootUEFI', { name: 'secureboot', timeoutMs: 12_000 });
        const value = Array.isArray(secureBoot.data) ? secureBoot.data[0] : secureBoot.data;
        const enabled = value === true || String(value).toLowerCase() === 'true' ? true : value === false || String(value).toLowerCase() === 'false' ? false : null;
        const permissionBlocked = !ctx.permissions.isAdmin && String(secureBoot.error ?? '').toLowerCase().includes('access');
        Object.assign(fields, mapSecureBoot({ supported: enabled === null ? null : true, enabled, error: secureBoot.error, permissionBlocked }));
      }

      // TPM requires elevation.
      if (!ctx.permissions.isAdmin) {
        Object.assign(fields, mapTpm(null, null, true));
      } else if (tpmProbe.ok) {
        Object.assign(fields, mapTpm(Array.isArray(tpmProbe.data) ? tpmProbe.data[0] : tpmProbe.data));
      } else {
        Object.assign(fields, mapTpm(null, tpmProbe.error));
      }

      return fields;
    }
  });

  registry.registerProvider({
    id: 'chipset-heuristic',
    title: 'VERIDEX chipset heuristic',
    priority: 3,
    collect: async (ctx) => {
      // Chipset is genuinely not exposed by Windows. The only defensible source is
      // the PCI root-complex vendor/device ids, which identify a family at best.
      const pnp = await queryCim(ctx.runner, 'Win32_PnPEntity', { namespace: 'root/cimv2', name: 'chipset:pnp', timeoutMs: ctx.timeoutMs });
      if (!pnp.ok) return { chipset: unavailable('PCI root complex not enumerable', 'chipset-heuristic') };
      const ids = pnp.rows
        .map((row) => cleanString(row.DeviceID))
        .filter(Boolean)
        .filter((id) => /PCI\\VEN_/i.test(id));
      const intel = ids.some((id) => /VEN_8086.*DEV_(A|7A|51|9B|43)/i.test(id));
      const amd = ids.some((id) => /VEN_1022.*DEV_(14|79|74)/i.test(id));
      if (intel) return { chipset: available('Intel platform controller (PCI root complex identified)', 'chipset-heuristic', { notes: ['Windows does not expose the chipset model. This is inferred from the PCI root-complex vendor and device identifier, so it names the family, not the exact part.'] }) };
      if (amd) return { chipset: available('AMD platform controller (PCI root complex identified)', 'chipset-heuristic', { notes: ['Windows does not expose the chipset model. This is inferred from the PCI root-complex vendor and device identifier, so it names the family, not the exact part.'] }) };
      return { chipset: unavailable('Chipset is not exposed by Windows and could not be inferred from the PCI root complex', 'chipset-heuristic') };
    }
  });

  registry.registerTask({
    id: 'motherboard.info',
    module: 'motherboard',
    title: 'Motherboard, firmware & platform security',
    quick: true,
    providers: ['cim-win32', 'chipset-heuristic']
  });
}
