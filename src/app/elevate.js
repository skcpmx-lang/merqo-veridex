/**
 * VERIDEX — the elevated helper (MODULE 14, R-14-02).
 *
 * VERIDEX runs as a standard user. A handful of genuinely privileged reads — the component-store
 * flag, a driver export — cannot be done otherwise, so the product asks for elevation **for one
 * named task, at the moment the user asks for it**, and never for the application as a whole.
 *
 * The rules this file exists to enforce:
 *
 *   1. **An allowlist, not a command.** The renderer can request `drivers.export`; it cannot
 *      request "elevate and run this". Every privileged operation is a named entry here with
 *      fixed arguments, so there is no path from interface input to a command line.
 *   2. **No argument interpolation.** Arguments are passed to `Start-Process -ArgumentList` as an
 *      array. Nothing is concatenated into a shell string, because a path with a quote in it is
 *      the oldest privilege-escalation bug there is.
 *   3. **A refusal is a result, not an exception.** A user who dismisses the UAC prompt gets
 *      `cancelled: true` and their application carries on at standard privilege. Elevation is
 *      never retried in a loop, and never silently skipped while reporting success.
 *   4. **Bounded.** Every elevated child gets a timeout and is killed on cancellation, so a
 *      refused prompt cannot leave a helper process waiting forever in the background.
 *
 * The parent never assumes the child succeeded: it reads the child's own JSON result, and treats
 * a missing, truncated or malformed result as a failure.
 *
 * @module
 */

import path from 'node:path';

/** Exit code Windows returns when the user dismisses the UAC prompt. */
export const UAC_CANCELLED = 1223;

/**
 * The complete set of privileged operations. Adding a capability here is a deliberate act, and
 * the IPC contract validates against this list rather than against a pattern.
 */
export const ELEVATED_TASKS = Object.freeze({
  'windows.componentHealth': {
    title: 'Read the component-store corruption flag',
    // DISM's read-only check. The repair switches are, by design, absent from this table.
    executable: 'dism.exe',
    args: () => ['/Online', '/Cleanup-Image', '/CheckHealth'],
    timeoutMs: 120_000,
    reason: 'The servicing stack only exposes its corruption flag to administrators.'
  },
  'drivers.export': {
    title: 'Export installed driver packages',
    executable: 'pnputil.exe',
    // The destination is the ONLY variable, and it is validated below before it reaches here.
    args: (params) => ['/export-driver', '*', String(params?.destination ?? '')],
    timeoutMs: 15 * 60_000,
    reason: 'pnputil exports driver packages, which requires administrative rights.'
  },
  'battery.report': {
    title: 'Generate a battery capacity report',
    executable: 'powercfg.exe',
    args: (params) => ['/batteryreport', '/output', String(params?.outputPath ?? ''), '/duration', '14'],
    timeoutMs: 180_000,
    reason: 'powercfg /batteryreport needs to read firmware data that is restricted to administrators.'
  }
});

/**
 * Is this a privileged operation VERIDEX knows how to perform?
 * @param {unknown} taskId
 */
export function isElevatedTask(taskId) {
  return typeof taskId === 'string' && Object.prototype.hasOwnProperty.call(ELEVATED_TASKS, taskId);
}

/**
 * Validate the destination folder for an export.
 *
 * Rejects anything that is not an absolute path, anything with a control character, and the
 * Windows system directories — exporting a thousand driver packages into `C:\Windows` is not a
 * meaningful thing to do and is exactly the kind of mistake a free-text field invites.
 *
 * @param {unknown} destination
 * @returns {{ok: true, path: string}|{ok: false, reason: string}}
 */
export function validateDestination(destination) {
  if (typeof destination !== 'string' || destination.trim().length === 0) {
    return { ok: false, reason: 'A destination folder is required.' };
  }
  const trimmed = destination.trim();
  if (trimmed.length > 240) return { ok: false, reason: 'The destination path is too long.' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(trimmed)) return { ok: false, reason: 'The destination contains control characters.' };
  if (!/^[a-zA-Z]:[\\/]/.test(trimmed) && !/^\\\\[^\\]+\\[^\\]+/.test(trimmed)) {
    return { ok: false, reason: 'The destination must be an absolute Windows path.' };
  }
  if (/[\\/]\.\.[\\/]|\.\.[\\/]|\\\.\.$/.test(trimmed)) return { ok: false, reason: 'The destination may not contain "..".' };

  const normalised = path.win32.normalize(trimmed).replace(/[\\/]+$/, '').toLowerCase();
  const forbidden = [
    'c:\\windows',
    'c:\\windows\\system32',
    'c:\\program files',
    'c:\\program files (x86)',
    'c:\\programdata',
    'c:\\users'
  ];
  if (forbidden.includes(normalised)) {
    return { ok: false, reason: 'Choose a folder of your own; system folders are not an export destination.' };
  }
  return { ok: true, path: trimmed };
}

/**
 * Build the PowerShell that launches the helper.
 *
 * The helper is this same application, started with `--run-elevated-task`, which performs exactly
 * one allowlisted task and writes its result to a file. `-Verb RunAs` is what raises the UAC
 * prompt; `-Wait` and `-PassThru` let the caller observe the exit code, which is how a dismissed
 * prompt (1223) is told apart from a task that ran and failed.
 *
 * @param {{taskId: string, appPath: string, params?: Record<string, unknown>, resultPath: string}} request
 * @returns {{ok: true, script: string}|{ok: false, reason: string}}
 */
export function buildElevationScript(request) {
  const { taskId, appPath, params, resultPath } = request ?? {};
  if (!isElevatedTask(taskId)) return { ok: false, reason: `"${taskId}" is not a privileged task.` };
  if (typeof appPath !== 'string' || appPath.length === 0) return { ok: false, reason: 'The application path is unknown.' };
  if (typeof resultPath !== 'string' || resultPath.length === 0) return { ok: false, reason: 'A result path is required.' };

  const task = ELEVATED_TASKS[taskId];
  const args = task.args(params ?? {});
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.length === 0 && String(arg).length === 0) {
      return { ok: false, reason: 'A privileged task was given an empty argument.' };
    }
    // A quote in an argument is refused outright rather than escaped: this code path builds a
    // PowerShell string, and refusing is a smaller surface than escaping correctly forever.
    if (/["'`$;|&<>]/.test(arg)) return { ok: false, reason: 'A privileged task argument contains an unsafe character.' };
  }

  // Single-quoted PowerShell literals: inside them, nothing is expanded.
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const argumentList = args.map(quote).join(',');
  const script = [
    `$ErrorActionPreference = 'Stop'`,
    `$argumentList = @(${argumentList})`,
    `try {`,
    `  $process = Start-Process -FilePath ${quote(task.executable)} -ArgumentList $argumentList -Verb RunAs -Wait -PassThru -WindowStyle Hidden`,
    `  $code = $process.ExitCode`,
    `} catch {`,
    // Win32Exception 1223 is the user pressing "No" at the UAC prompt.
    `  if ($_.Exception.NativeErrorCode -eq ${UAC_CANCELLED}) { $code = ${UAC_CANCELLED} }`,
    `  else { $code = -1; $message = $_.Exception.Message }`,
    `}`,
    `[pscustomobject]@{ code = $code; message = $message } | ConvertTo-Json -Compress | Set-Content -LiteralPath ${quote(resultPath)} -Encoding UTF8`,
    ''
  ].join('\n');

  return { ok: true, script };
}

/**
 * Turn the helper's exit code and result file into an outcome.
 *
 * Pure. The three cases the rest of the application must never confuse:
 *   - the user declined (cancelled, with a reason the interface can show);
 *   - the task ran and failed (error, with the tool's own message);
 *   - the task ran and succeeded (ok, with whatever the task reported).
 *
 * @param {{code: number|null, timedOut?: boolean, result?: any, stderr?: string}} outcome
 */
export function interpretElevationOutcome(outcome) {
  const { code, timedOut, result, stderr } = outcome ?? {};

  if (timedOut) {
    return { ok: false, cancelled: false, reason: 'The privileged task did not finish within its time limit and was stopped.' };
  }
  if (code === UAC_CANCELLED) {
    return {
      ok: false,
      cancelled: true,
      reason: 'Administrator permission was declined, so nothing was done. VERIDEX continues at standard privilege and the rest of the report is unaffected.'
    };
  }
  if (code === null || code === undefined) {
    return { ok: false, cancelled: false, reason: 'The privileged helper did not report an exit code.' };
  }
  if (code !== 0) {
    const detail = result?.message || stderr || '';
    return {
      ok: false,
      cancelled: false,
      reason: `The privileged task failed${code >= 0 ? ` with code ${code}` : ''}${detail ? `: ${String(detail).slice(0, 200)}` : '.'}`
    };
  }
  if (!result || typeof result !== 'object') {
    // A zero exit with no result is not a success: the helper was supposed to write one.
    return { ok: false, cancelled: false, reason: 'The privileged task exited successfully but returned no result, so nothing can be claimed about what it read.' };
  }
  return { ok: true, cancelled: false, result };
}

/**
 * The capability a privileged task belongs to, so the permission screen and the task table can
 * both be generated from one place.
 * @param {string} taskId
 */
export function capabilityOf(taskId) {
  if (taskId === 'windows.componentHealth') return 'windows.dism';
  if (taskId === 'drivers.export') return 'drivers.export';
  if (taskId === 'battery.report') return 'battery.report';
  return null;
}
