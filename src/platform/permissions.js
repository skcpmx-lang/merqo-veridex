/**
 * VERIDEX — Permission model.
 *
 * Design rule (PART 3 / MODULE 14): the application runs as a standard user by
 * default. Elevation is requested per capability, never for the whole app, and a
 * refused or unavailable elevation is surfaced as PERMISSION_REQUIRED — it is
 * never silently downgraded to "unavailable" and never faked as success.
 *
 * This module only *describes* requirements and observes the real token state.
 * It never elevates by itself; src/app/elevate.js owns the UAC interaction.
 */

import { Status } from '../core/status.js';
import { permissionRequired, available } from '../core/field.js';

/**
 * Capabilities that may need elevation, with the reason a user would care about.
 * Keys are stable ids used by providers and by the permission screen.
 */
export const CAPABILITIES = Object.freeze({
  'storage.smart': {
    label: 'Storage SMART / NVMe health log',
    requiresAdmin: true,
    reason: 'DeviceIoControl SMART and NVMe log pages are blocked for standard users by the Windows storage stack.'
  },
  'storage.serial': {
    label: 'Physical disk serial numbers',
    requiresAdmin: true,
    reason: 'Disk serial numbers are redacted for non-administrators on some Windows builds.'
  },
  'sensor.acpiThermal': {
    label: 'ACPI thermal zones (CPU temperature)',
    requiresAdmin: true,
    reason: 'The MSAcpi_ThermalZoneTemperature class is readable only by administrators.'
  },
  'security.tpm': {
    label: 'TPM status',
    requiresAdmin: true,
    reason: 'The TPM provider and Get-Tpm require administrative rights.'
  },
  'security.bitlocker': {
    label: 'BitLocker / device encryption status',
    requiresAdmin: true,
    reason: 'manage-bde and the BitLocker CIM classes require administrative rights.'
  },
  'windows.features': {
    label: 'Windows optional features',
    requiresAdmin: true,
    reason: 'DISM-based feature enumeration requires administrative rights.'
  },
  'windows.dism': {
    label: 'Component store health (DISM)',
    requiresAdmin: true,
    reason: 'DISM /CheckHealth and /ScanHealth require administrative rights. Every DISM call VERIDEX makes is read-only.'
  },
  'windows.sfc': {
    label: 'System file verification (SFC)',
    requiresAdmin: true,
    reason: 'sfc /VERIFYONLY requires administrative rights. VERIDEX never runs a repairing SFC pass.'
  },
  'windows.eventlog.security': {
    label: 'Security event log',
    requiresAdmin: true,
    reason: 'The Security log is restricted to administrators; System and Application logs are read without elevation.'
  },
  'drivers.export': {
    label: 'Driver export',
    requiresAdmin: true,
    reason: 'pnputil /export-driver requires administrative rights.'
  },
  'battery.cycleCount': {
    label: 'Battery cycle count',
    requiresAdmin: false,
    reason: 'Exposed by firmware through WMI when the battery controller supports it; no elevation needed.'
  }
});

/**
 * @param {string} id
 * @returns {{label:string, requiresAdmin:boolean, reason:string}|null}
 */
export function capability(id) {
  return CAPABILITIES[id] ?? null;
}

/** @param {string} id */
export function requiresAdmin(id) {
  return CAPABILITIES[id]?.requiresAdmin ?? false;
}

/**
 * @typedef {object} PermissionState
 * @property {boolean} isAdmin          Current process runs with an elevated token.
 * @property {boolean} isWindows
 * @property {string} mode              'elevated' | 'standard'
 * @property {string} detectedAt
 * @property {string|null} detail       How the state was determined, for the log.
 */

/**
 * Detect whether the current process holds an elevated token.
 *
 * On Windows we ask the OS twice (`net session` is the cheapest reliable probe,
 * PowerShell's WindowsPrincipal is the authoritative one) so a flaky probe does
 * not mislabel the session. On non-Windows we report standard mode; nothing in
 * the diagnostic layer assumes elevation there.
 *
 * @param {import('./runner.js').CommandRunner} runner
 * @returns {Promise<PermissionState>}
 */
export async function detectPermissionState(runner) {
  const detectedAt = new Date().toISOString();
  if (!runner.isWindows) {
    return {
      isAdmin: false,
      isWindows: false,
      mode: 'standard',
      detectedAt,
      detail: 'Non-Windows host: elevation model is not applicable.'
    };
  }

  const probe = await runner.powershellJson(
    '(New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    { name: 'elevation-probe', timeoutMs: 12_000 }
  );

  if (probe.ok) {
    const raw = Array.isArray(probe.data) ? probe.data[0] : probe.data;
    const isAdmin = raw === true || String(raw).toLowerCase() === 'true';
    return {
      isAdmin,
      isWindows: true,
      mode: isAdmin ? 'elevated' : 'standard',
      detectedAt,
      detail: 'WindowsPrincipal.IsInRole(Administrator)'
    };
  }

  // Secondary probe. Only used when the authoritative one failed to execute.
  const fallback = await runner.run('net', ['session'], { timeoutMs: 8000 });
  const isAdmin = fallback.ok;
  return {
    isAdmin,
    isWindows: true,
    mode: isAdmin ? 'elevated' : 'standard',
    detectedAt,
    detail: `fallback probe "net session" (${fallback.ok ? 'succeeded' : `failed, exit ${fallback.code}`}); primary probe error: ${probe.error ?? 'none'}`
  };
}

/**
 * Produce the FieldValue for a capability given the current permission state.
 *
 * Providers call this before attempting a privileged read: if elevation is
 * missing we return PERMISSION_REQUIRED immediately with the exact reason, so the
 * report says "needs admin" instead of "hardware not supported". That distinction
 * is the difference between a diagnostic tool and a random number generator.
 *
 * @param {string} id
 * @param {PermissionState} state
 * @param {{value?: unknown, source?: string, unit?: string}} [payload]
 */
export function gate(id, state, payload = {}) {
  const info = capability(id);
  if (!info) throw new Error(`Unknown capability "${id}"`);

  if (!info.requiresAdmin) {
    return { allowed: true, field: payload.value !== undefined ? available(payload.value, payload.source ?? id, { unit: payload.unit }) : null };
  }

  if (state.isAdmin) {
    return { allowed: true, field: payload.value !== undefined ? available(payload.value, payload.source ?? id, { unit: payload.unit }) : null };
  }

  return {
    allowed: false,
    field: permissionRequired(info.reason, payload.source ?? id)
  };
}

/**
 * Summarise which capabilities the current session can use. Feeds the permission
 * card on the dashboard and the `permissions` block of the report.
 * @param {PermissionState} state
 */
export function capabilityMatrix(state) {
  return Object.entries(CAPABILITIES).map(([id, info]) => ({
    id,
    label: info.label,
    requiresAdmin: info.requiresAdmin,
    status: !info.requiresAdmin || state.isAdmin ? Status.PASS : Status.PERMISSION_REQUIRED,
    reason: !info.requiresAdmin || state.isAdmin ? null : info.reason
  }));
}

/** Count how many capabilities are blocked in the current session. */
export function blockedCapabilities(state) {
  return capabilityMatrix(state).filter((c) => c.status === Status.PERMISSION_REQUIRED);
}
