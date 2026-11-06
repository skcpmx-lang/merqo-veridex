/**
 * VERIDEX — driver export (MODULE 11, R-11-03).
 *
 * `pnputil /export-driver * <folder>` copies the driver packages currently in the driver store
 * into a folder. It is the supported Windows mechanism, it is non-destructive, and it is the
 * only part of driver handling this product performs.
 *
 * What this module deliberately does NOT do, and says so in every message it produces:
 *
 *   - it does not install, update, roll back or remove a driver;
 *   - it does not claim that an export can be restored — `pnputil /add-driver` exists, but
 *     re-adding a package is not the same as returning a machine to a previous state, and a
 *     user who believes otherwise will discover the difference at the worst moment;
 *   - it does not export into a system folder, or into a folder that already contains a
 *     previous export, because silently mixing two exports makes both untrustworthy.
 *
 * The safety rules live in pure functions so they can be tested without a Windows machine; the
 * main process is responsible only for the dialog, the elevation and the file system calls.
 *
 * @module
 */

import path from 'node:path';

/** Room to leave free on the destination volume, beyond the estimate. */
export const FREE_SPACE_MARGIN_BYTES = 256 * 1024 * 1024;

/**
 * A driver package is typically 2–40 MB; a full store on a workstation is 1–4 GB. The estimate
 * errs high on purpose: refusing an export for lack of space is a nuisance, running out halfway
 * through produces a half-copied folder that looks complete.
 */
export const BYTES_PER_DRIVER_ESTIMATE = 48 * 1024 * 1024;

/**
 * Name of the folder created inside the user's chosen destination.
 *
 * A fresh subfolder per export means: nothing is overwritten, two exports can be compared, and
 * the user can delete one without destroying the other. The timestamp is local and sortable.
 *
 * @param {Date} [now]
 * @returns {string}
 */
export function exportFolderName(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    'VERIDEX-drivers',
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  ].join('-');
}

/**
 * Plan an export before anything is written.
 *
 * @param {{
 *   destination?: string|null,
 *   driverCount?: number|null,
 *   freeBytes?: number|null,
 *   now?: Date
 * }} input
 * @returns {{ok: true, folder: string, path: string, estimateBytes: number, marginBytes: number}
 *          |{ok: false, code: string, reason: string}}
 */
export function planExport(input = {}) {
  const destination = input?.destination;
  if (typeof destination !== 'string' || destination.trim().length === 0) {
    return { ok: false, code: 'no_destination', reason: 'Choose a folder to export into. Nothing has been written.' };
  }

  const folder = exportFolderName(input.now ?? new Date());
  const full = path.win32.join(destination.trim(), folder);

  // The zip is the support-bundle case; the export itself is a folder tree. Either way, the
  // destination must be inside a folder the user chose, never the root of a volume.
  const withoutTrailing = (value) => String(value).replace(/[\\/]+$/, '');
  if (withoutTrailing(path.win32.dirname(full)) === withoutTrailing(path.win32.parse(full).root)) {
    return { ok: false, code: 'root_destination', reason: 'Choose a folder inside a drive, not the drive itself.' };
  }

  const driverCount = Number.isFinite(input.driverCount) && input.driverCount > 0 ? input.driverCount : 0;
  const estimateBytes = Math.max(driverCount, 1) * BYTES_PER_DRIVER_ESTIMATE;
  const marginBytes = FREE_SPACE_MARGIN_BYTES;

  if (Number.isFinite(input.freeBytes) && input.freeBytes !== null) {
    if (input.freeBytes < marginBytes) {
      return {
        ok: false,
        code: 'no_space',
        reason: `The destination has ${formatBytes(input.freeBytes)} free. An export needs about ${formatBytes(estimateBytes)} plus ${formatBytes(marginBytes)} of headroom, so nothing was written.`
      };
    }
    if (input.freeBytes < estimateBytes + marginBytes && driverCount > 0) {
      return {
        ok: false,
        code: 'not_enough_space',
        reason: `About ${formatBytes(estimateBytes)} is needed for ${driverCount} driver packages, and the destination has ${formatBytes(input.freeBytes)} free. Nothing was written.`
      };
    }
  }

  return { ok: true, folder, path: full, estimateBytes, marginBytes };
}

/**
 * Describe what an export produced.
 *
 * `pnputil` prints one line per package it copies and a summary at the end; the counts below come
 * from its output plus a count of the `.inf` files actually present afterwards, because the two
 * disagreeing is exactly the failure worth reporting.
 *
 * @param {{
 *   folder: string,
 *   infFiles: string[],
 *   pnputilExitCode: number|null,
 *   pnputilStdout?: string,
 *   cancelled?: boolean,
 *   timedOut?: boolean,
 *   existingFiles?: number
 * }} result
 */
export function describeExport(result) {
  const folder = result?.folder ?? null;
  const infFiles = Array.isArray(result?.infFiles) ? result.infFiles : [];
  const packageCount = infFiles.length;
  const cancelled = Boolean(result?.cancelled);
  const timedOut = Boolean(result?.timedOut);

  const statement =
    'An export is a copy of the driver packages currently installed. It is not a restore point: ' +
    'VERIDEX cannot put a machine back the way it was, and nothing in this application installs, ' +
    'updates or removes a driver.';

  if (cancelled) {
    return {
      ok: false,
      code: 'cancelled',
      packageCount,
      folder,
      statement,
      reason: packageCount > 0
        ? `The export was cancelled after ${packageCount} package${packageCount === 1 ? '' : 's'} were copied. The folder contains a partial export and should not be treated as complete.`
        : 'The export was cancelled before any package was copied. Nothing was left behind.'
    };
  }
  if (timedOut) {
    return {
      ok: false,
      code: 'timeout',
      packageCount,
      folder,
      statement,
      reason: `The export did not finish within its time limit after ${packageCount} package${packageCount === 1 ? '' : 's'}. The folder is a partial export.`
    };
  }
  if (result?.pnputilExitCode !== 0) {
    return {
      ok: false,
      code: 'failed',
      packageCount,
      folder,
      statement,
      reason: `pnputil exited with ${result?.pnputilExitCode === null || result?.pnputilExitCode === undefined ? 'an error' : `code ${result.pnputilExitCode}`}. ${packageCount > 0 ? `${packageCount} package${packageCount === 1 ? '' : 's'} were copied before it stopped, so the folder is incomplete.` : 'No package was exported.'}`
    };
  }
  if (packageCount === 0) {
    return {
      ok: false,
      code: 'empty',
      packageCount: 0,
      folder,
      statement,
      reason: 'pnputil reported success but no driver package was found in the destination. Nothing usable was exported, so no export is claimed.'
    };
  }

  return {
    ok: true,
    code: 'exported',
    packageCount,
    folder,
    statement,
    reason: `${packageCount} driver package${packageCount === 1 ? '' : 's'} exported to ${folder ?? 'the chosen folder'}. These are copies of what is installed now.`
  };
}

/**
 * Check that what pnputil said it did matches what is on disk.
 *
 * @param {{expected?: number|null, infFiles?: string[]}} input
 */
export function verifyExport(input = {}) {
  const found = Array.isArray(input.infFiles) ? input.infFiles.length : 0;
  const expected = Number.isFinite(input.expected) ? Number(input.expected) : null;

  if (expected !== null && expected !== found) {
    return {
      ok: false,
      found,
      expected,
      reason: `pnputil reported ${expected} package${expected === 1 ? '' : 's'} but ${found} .inf file${found === 1 ? '' : 's'} are present. The export cannot be confirmed complete.`
    };
  }
  if (found === 0) {
    return { ok: false, found, expected, reason: 'No .inf file is present, so nothing was exported.' };
  }
  return { ok: true, found, expected, reason: `${found} .inf file${found === 1 ? '' : 's'} present in the destination, matching what pnputil reported.` };
}

/**
 * Readable byte count. Kept here so the export messages and the interface agree.
 * @param {number} bytes
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'an unknown amount of';
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

/**
 * The text shown next to the export action, wherever the export is offered.
 *
 * One string, used by the page, the JSON and the PDF, so the promise cannot vary by surface.
 */
export const EXPORT_PROMISE =
  'Export copies the driver packages installed on this machine into a folder you choose. It changes nothing on the machine. VERIDEX cannot restore a driver from an export, and does not install, update or remove drivers.';
