/**
 * VERIDEX — Driver inspection (MODULE 11).
 *
 * Reads the PnP device tree with each device's driver metadata and classifies
 * health from **evidence only**: the Windows Config Manager error code, the
 * device status string, and the presence of a signed driver. Nothing is inferred
 * from the driver's version number, because "outdated" requires a comparison
 * against a manufacturer catalogue that VERIDEX deliberately does not bundle
 * (it would go stale within weeks and turn a fact into a guess).
 *
 * The one version-related judgement offered is *age*: a signed driver whose date is
 * more than five years old is flagged as worth checking, with the threshold and the
 * reason shown. That is a verifiable statement about the date, not a claim about
 * availability of updates.
 *
 * No driver is ever installed, updated, removed or replaced. Backup/export requires
 * an explicit user action and elevation.
 */

import { available, unavailable, failed, field, unsupported } from '../core/field.js';
import { Status } from '../core/status.js';
import { cleanString, num, date, asArray, bool } from '../platform/parse.js';
import { queryCim, runReadOnly, failureToStatus } from '../platform/windows.js';

/** Windows Config Manager error codes worth naming for a technician. */
export const CONFIG_MANAGER_ERRORS = Object.freeze({
  0: 'Working properly',
  1: 'Device is not configured correctly',
  3: 'Driver is corrupted or the system is low on memory',
  10: 'Device cannot start',
  12: 'Device cannot find enough free resources',
  14: 'Device cannot work properly until the computer is restarted',
  16: 'Device resources are not fully detected',
  18: 'Device drivers must be reinstalled',
  19: 'Registry configuration is incomplete or damaged',
  21: 'Windows is removing the device',
  22: 'Device is disabled',
  24: 'Device is not present, not working, or missing its drivers',
  28: 'Device drivers are not installed',
  29: 'Device firmware did not provide required resources',
  31: 'Device is not working properly because Windows cannot load its drivers',
  32: 'Driver service for this device has been disabled',
  37: 'Windows cannot initialise the device driver',
  39: 'Windows cannot load the device driver (corrupted or missing)',
  43: 'Driver has reported that the device has failed',
  45: 'Device is not currently connected'
});

/** Age threshold beyond which a driver date is worth a look. */
export const DRIVER_AGE_WARNING_YEARS = 5;

/**
 * Classify a device's health from its error code, status and signing state.
 *
 * @param {{errorCode:number|null, status:string|null, signed:boolean|null}} input
 * @returns {{health:'OK'|'WARNING'|'FAILED'|'UNKNOWN'|'DISABLED', explanation:string, requiresUpdate:boolean, requiresReinstall:boolean, disabled:boolean}}
 */
export function classifyDriverHealth(input) {
  const { errorCode, status, signed } = input;
  const normalisedStatus = (status ?? '').toLowerCase();

  if (normalisedStatus.includes('disabled')) {
    return {
      health: 'DISABLED',
      explanation: 'The device is disabled in Device Manager. This is usually deliberate, but it means the hardware is not in use.',
      requiresUpdate: false,
      requiresReinstall: false,
      disabled: true
    };
  }

  if (errorCode === null || errorCode === undefined) {
    if (normalisedStatus.includes('ok') || normalisedStatus.includes('error')) {
      // Win32_PnPEntity.Status is "OK" or "Error"; without an error code we can
      // still state that much.
      if (normalisedStatus === 'ok') return { health: 'OK', explanation: 'Windows reports the device as working.', requiresUpdate: false, requiresReinstall: false, disabled: false };
      return { health: 'FAILED', explanation: 'Windows reports the device in an error state but did not supply a Config Manager code.', requiresUpdate: false, requiresReinstall: true, disabled: false };
    }
    return { health: 'UNKNOWN', explanation: 'No device status or error code was reported.', requiresUpdate: false, requiresReinstall: false, disabled: false };
  }

  if (errorCode === 0) {
    if (signed === false) {
      return { health: 'WARNING', explanation: 'The device works, but its driver is not digitally signed, which Windows may block after a driver-signing policy change.', requiresUpdate: true, requiresReinstall: false, disabled: false };
    }
    return { health: 'OK', explanation: 'Windows reports the device as working properly.', requiresUpdate: false, requiresReinstall: false, disabled: false };
  }

  const known = CONFIG_MANAGER_ERRORS[errorCode];
  const requiresReinstall = [3, 18, 19, 39].includes(errorCode);
  const missing = [24, 28].includes(errorCode);
  const explanation = known
    ? `Windows Config Manager error code ${errorCode}: ${known}.`
    : `Windows Config Manager error code ${errorCode} (not in VERIDEX's documented code list).`;

  const health = errorCode === 22 ? 'DISABLED' : missing || requiresReinstall ? 'FAILED' : 'WARNING';

  // A disabled device is a state, not a fault, and saying so prevents a
  // technician from "fixing" a deliberately disabled touchpad or radio.
  if (health === 'DISABLED') {
    return {
      health,
      explanation: `${explanation} The device is disabled in Device Manager. This is often deliberate, but the hardware is not in use while it stays disabled.`,
      requiresUpdate: false,
      requiresReinstall: false,
      disabled: true
    };
  }

  return {
    health,
    explanation: missing ? `${explanation} The device has no driver installed.` : explanation,
    requiresUpdate: missing,
    requiresReinstall,
    disabled: errorCode === 22
  };
}

/**
 * Decide whether a driver's date is old enough to mention.
 * @param {string|null} driverDate ISO date
 * @param {Date} [now]
 * @returns {{old:boolean, years:number|null, text:string|null}}
 */
export function assessDriverAge(driverDate, now = new Date()) {
  if (!driverDate) return { old: false, years: null, text: null };
  const parsed = Date.parse(driverDate);
  if (Number.isNaN(parsed)) return { old: false, years: null, text: null };
  // Tolerate a caller that passes something other than a Date (clock injection in
  // tests, or a serialised timestamp) instead of throwing mid-report.
  const reference = now instanceof Date && Number.isFinite(now.getTime()) ? now.getTime() : Date.now();
  const years = Math.round(((reference - parsed) / (365.25 * 86_400_000)) * 10) / 10;
  if (years < 0) return { old: false, years: null, text: null };
  if (years < DRIVER_AGE_WARNING_YEARS) return { old: false, years, text: null };
  return {
    old: true,
    years,
    text: `Driver date is ${years} years old. Driver age alone is not a fault, but a driver older than ${DRIVER_AGE_WARNING_YEARS} years is worth checking against the manufacturer's current release, especially for graphics, chipset and network devices.`
  };
}

/**
 * Map a `Win32_PnPSignedDriver` instance, which carries driver identity and
 * signing information.
 * @param {object} driver
 * @param {Date} [now]
 * @returns {{key:string, fields:Record<string, import('../core/field.js').FieldValue>, health:string, critical:boolean}}
 */
export function mapSignedDriver(driver, now = new Date()) {
  const source = 'cim-win32';
  const deviceName = cleanString(driver?.DeviceName) ?? cleanString(driver?.Description) ?? 'Unnamed device';
  const deviceClass = cleanString(driver?.DeviceClass);
  const errorCode = num(driver?.ConfigManagerErrorCode);
  const signed = bool(driver?.IsSigned);
  const driverDate = date(driver?.DriverDate);
  const age = assessDriverAge(driverDate, now);
  const health = classifyDriverHealth({ errorCode, status: null, signed });

  /** @type {Record<string, import('../core/field.js').FieldValue>} */
  const fields = {
    deviceName: available(deviceName, source),
    driverProvider: cleanString(driver?.DriverProviderName) ? available(cleanString(driver.DriverProviderName), source) : unavailable('Driver provider not reported', source),
    manufacturer: cleanString(driver?.Manufacturer) ? available(cleanString(driver.Manufacturer), source) : unavailable('Device manufacturer not reported', source),
    driverVersion: cleanString(driver?.DriverVersion) ? available(cleanString(driver.DriverVersion), source) : unavailable('Driver version not reported', source),
    driverDate: driverDate ? available(driverDate.slice(0, 10), source) : unavailable('Driver date not reported', source),
    deviceClass: deviceClass ? available(deviceClass, source) : unavailable('Device class not reported', source),
    deviceId: cleanString(driver?.DeviceID) ? available(cleanString(driver.DeviceID), source) : unavailable('Device instance id not reported', source),
    signed: signed === null ? unavailable('Driver signing state not reported, which usually means no driver is installed', source) : available(signed ? 'Signed' : 'Not signed', source, { status: signed ? Status.PASS : Status.WARNING }),
    errorCode: errorCode !== null ? available(errorCode, source, { status: errorCode === 0 ? Status.PASS : Status.WARNING }) : unavailable('Config Manager error code not reported', source),
    health: field(health.health, { status: health.health === 'OK' ? Status.PASS : health.health === 'FAILED' ? Status.FAIL : health.health === 'UNKNOWN' ? Status.UNAVAILABLE : Status.WARNING, source, notes: [health.explanation] }),
    hardwareId: cleanString(driver?.HardWareID) ?? cleanString(asArray(driver?.HardWareID)[0]) ? available(cleanString(driver?.HardWareID) ?? String(asArray(driver?.HardWareID)[0]), source) : unavailable('Hardware id not reported', source)
  };

  if (age.old) fields.driverAge = field(`${age.years} years old`, { status: Status.WARNING, source, notes: [age.text] });

  return {
    key: cleanString(driver?.DeviceID) ?? deviceName,
    fields,
    health: health.health,
    critical: ['Display', 'Net', 'System', 'HDC', 'SCSIAdapter', 'DiskDrive', 'Bluetooth', 'MEDIA', 'USB'].includes(deviceClass ?? '')
  };
}

/**
 * Summarise driver health across all devices.
 * @param {Array<{health:string, critical:boolean, fields:Record<string, import('../core/field.js').FieldValue>}>} drivers
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function summariseDrivers(drivers) {
  const source = 'computed';
  const list = Array.isArray(drivers) ? drivers : [];
  const count = (health) => list.filter((driver) => driver.health === health).length;
  const failedCritical = list.filter((driver) => driver.critical && (driver.health === 'FAILED' || driver.health === 'WARNING'));

  return {
    driverCount: list.length > 0 ? available(list.length, source) : unavailable('No drivers were enumerated', 'cim-win32.drivers'),
    driversOk: available(count('OK'), source),
    driversWarning: available(count('WARNING'), source, { status: count('WARNING') > 0 ? Status.WARNING : Status.PASS }),
    driversFailed: available(count('FAILED'), source, { status: count('FAILED') > 0 ? Status.FAIL : Status.PASS }),
    driversDisabled: available(count('DISABLED'), source, { notes: ['Disabled devices are often deliberate; this count is informational.'] }),
    driversUnknown: available(count('UNKNOWN'), source),
    criticalIssues: failedCritical.length > 0
      ? field(
          failedCritical.map((driver) => driver.fields.deviceName?.value ?? 'unknown device').slice(0, 12),
          {
            status: Status.WARNING,
            source,
            notes: ['Devices in a core class (display, network, storage, USB, system) are reporting a problem. These usually correspond to visible faults such as no audio, no Wi-Fi or a missing display driver.']
          }
        )
      : available([], source, { notes: ['No core-class device is reporting a problem.'] })
  };
}

/**
 * Register driver providers and task.
 * @param {import('../engine/provider-registry.js').ProviderRegistry} registry
 */
export function registerDrivers(registry) {
  registry.registerProvider({
    id: 'cim-win32.drivers',
    title: 'Windows CIM (Win32_PnPSignedDriver)',
    priority: 1,
    collect: async (ctx) => {
      const signed = await queryCim(ctx.runner, 'Win32_PnPSignedDriver', { name: 'drivers:signed', timeoutMs: Math.max(ctx.timeoutMs, 30_000) });
      if (!signed.ok) {
        const cause = failureToStatus(signed);
        return { drivers: cause.kind === 'permission' ? field(null, { status: Status.PERMISSION_REQUIRED, permissionRequired: true, error: cause.reason, source: 'cim-win32.drivers' }) : failed(signed.error, 'cim-win32.drivers') };
      }

      const now = new Date();
      const mapped = signed.rows
        .filter((row) => cleanString(row?.DeviceName) || cleanString(row?.DeviceID))
        .map((row) => mapSignedDriver(row, now));

      /** @type {Record<string, import('../core/field.js').FieldValue>} */
      const fields = {};
      // The full driver list is large. Keep each device under an index key so the
      // report can render a table without the field map exploding.
      mapped.forEach((driver, index) => {
        for (const [key, value] of Object.entries(driver.fields)) {
          fields[`driver${index + 1}.${key}`] = value;
        }
      });
      Object.assign(fields, summariseDrivers(mapped));
      return fields;
    }
  });

  registry.registerProvider({
    id: 'systeminformation.drivers',
    title: 'systeminformation (device status)',
    priority: 2,
    // This provider exists as a documented fallback slot but performs no collection
    // of its own: the CIM provider is authoritative for driver inventory, and
    // systeminformation exposes no driver-level problem codes. Rather than ship a
    // silent stub, it says so — a provider that pretends to answer is worse than one
    // that states it has nothing to add.
    collect: async () => ({
      deviceStatus: unsupported(
        'Driver inventory and problem codes come from CIM; the systeminformation fallback adds no driver-level detail on Windows.',
        'systeminformation.drivers'
      )
    })
  });

  registry.registerTask({
    id: 'drivers.inventory',
    module: 'drivers',
    title: 'Driver & device status',
    quick: true,
    providers: ['cim-win32.drivers', 'systeminformation.drivers']
  });

  registry.registerProvider({
    id: 'driver-export.drivers',
    title: 'pnputil /export-driver',
    capability: 'drivers.export',
    priority: 1,
    collect: async (ctx) => {
      // This provider describes whether an export *could* be started; it is never the export
      // itself. It reports the same three facts the export card relies on - elevation state,
      // the mechanism, and the promise - so the scan and the card cannot disagree.
      const isAdmin = ctx.permissions?.isAdmin === true;
      const mechanism = 'pnputil /export-driver * <folder>';

      const exportStatus = isAdmin
        ? available(
            'Ready. Exporting will copy every installed driver package into a new folder you choose.',
            'driver-export.drivers',
            {
              notes: [
                'Runs only when you choose "Export drivers"; the scan never exports anything on its own.',
                'An export is a copy, not a restore point: VERIDEX cannot reinstall a driver from it.'
              ]
            }
          )
        : unavailable(
            'Export needs administrator rights, so it is not available in this session. Everything else on this page was read at standard privilege.',
            'driver-export.drivers',
            {
              notes: [
                'VERIDEX does not elevate itself at start-up. Choosing "Export drivers" raises one Windows prompt for that one action, and declining it changes nothing.'
              ]
            }
          );

      return {
        exportStatus,
        commandTemplate: available(mechanism, 'driver-export.drivers', {
          notes: ['pnputil only exports the driver packages that are currently installed. VERIDEX never uses it to install, update or remove a driver.']
        })
      };
    }
  });

  registry.registerTask({
    id: 'drivers.export',
    module: 'driverBackup',
    title: 'Driver export',
    quick: false,
    providers: ['driver-export.drivers'],
    requiresCapability: 'drivers.export'
  });
}
