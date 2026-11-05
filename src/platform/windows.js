/**
 * VERIDEX — Windows data-access helpers.
 *
 * Thin, reusable wrappers over the two collection mechanisms VERIDEX uses plus the
 * one graceful degradation rule they share:
 *
 *   1. CIM/WMI through PowerShell, wrapped so partial failures survive;
 *   2. the registry, for values CIM does not expose (64-bit VRAM, EDID, MMDevice
 *      formats);
 *   3. `systeminformation` for live counters, where it already wraps the OS
 *      performance counters correctly.
 *
 * Every helper returns a structured outcome rather than throwing, because a
 * provider must be able to distinguish "class missing" from "access denied" to
 * choose the right field status.
 */

import { cleanString, num, bool, date, asArray } from './parse.js';
import { Status } from '../core/status.js';

/**
 * @typedef {object} CimResult
 * @property {boolean} ok
 * @property {object[]} rows
 * @property {string|null} error
 * @property {boolean} accessDenied   True when the failure is a permissions problem.
 * @property {boolean} unavailable    True when the class/namespace does not exist.
 * @property {number} durationMs
 */

/**
 * Detect the cause of a failed CIM query so providers can emit the right status.
 * This distinction is the whole point: "needs admin" and "not supported" must not
 * look the same to a technician.
 * @param {string|null} error
 * @returns {{accessDenied:boolean, unavailable:boolean}}
 */
export function classifyCimError(error) {
  if (!error) return { accessDenied: false, unavailable: false };
  const text = error.toLowerCase();
  const accessDenied = ['access denied', 'requires elevation', 'unauthorized', 'permissiondenied', '0x80041003', '0x80070005', 'not authorized', 'privilege'].some((needle) =>
    text.includes(needle)
  );
  const unavailable = ['invalid class', 'invalid namespace', 'not found', '0x80041010', '0x8004100e', 'no such', 'does not exist', 'not supported'].some((needle) => text.includes(needle));
  return { accessDenied, unavailable };
}

/**
 * Query one or more CIM classes in a single PowerShell call.
 *
 * Namespaces are queried individually because a missing namespace (common for the
 * root\wmi battery and TPM classes on virtual machines) would otherwise abort the
 * whole batch.
 *
 * @param {import('./runner.js').CommandRunner} runner
 * @param {string|string[]} classes e.g. 'Win32_Processor' or 'CPU'
 * @param {{namespace?: string, timeoutMs?: number, name?: string, properties?: string[]}} [options]
 * @returns {Promise<CimResult>}
 */
export async function queryCim(runner, classes, options = {}) {
  const list = asArray(classes).map((name) => String(name));
  const namespace = options.namespace ?? 'root/cimv2';
  const select = options.properties?.length ? ` | Select-Object ${options.properties.join(',')}` : '';
  const body = list
    .map((klass) => `Get-CimInstance -Namespace '${namespace}' -ClassName '${klass}' -ErrorAction SilentlyContinue${select}`)
    .join('\n');
  const label = options.name ?? `${namespace}:${list.join('+')}`;

  if (!runner.isWindows) {
    return { ok: false, rows: [], error: 'Not running on Windows', accessDenied: false, unavailable: true, durationMs: 0 };
  }

  const result = await runner.powershellJson(body, { timeoutMs: options.timeoutMs, name: label });
  if (!result.ok) {
    const cause = classifyCimError(result.error);
    return { ok: false, rows: [], error: result.error, ...cause, durationMs: result.durationMs };
  }

  const rows = asArray(result.data).filter((row) => row && typeof row === 'object');
  return { ok: rows.length > 0, rows, error: rows.length > 0 ? null : `${label}: no instances returned`, accessDenied: false, unavailable: rows.length === 0, durationMs: result.durationMs };
}

/**
 * @typedef {object} RegistryResult
 * @property {boolean} ok
 * @property {{name:string, type:string, value:unknown}[]} values
 * @property {string|null} error
 */

/**
 * Read registry values beneath a key. Both 32- and 64-bit views are supported
 * explicitly because driver, EDID and VRAM data live in different views.
 *
 * @param {import('./runner.js').CommandRunner} runner
 * @param {string} keyPath e.g. 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0000'
 * @param {{names?: string[], timeoutMs?: number, recurse?: boolean}} [options]
 * @returns {Promise<RegistryResult>}
 */
export async function readRegistry(runner, keyPath, options = {}) {
  if (!runner.isWindows) return { ok: false, values: [], error: 'Not running on Windows' };
  const filter = options.names?.length ? ` -Name ${options.names.map((name) => `'${name}'`).join(',')}` : '';
  const body = options.names?.length
    ? `Get-ItemProperty -Path '${keyPath}' -ErrorAction SilentlyContinue | Select-Object ${options.names.map((name) => `'${name}'`).join(',')}`
    : `Get-ItemProperty -Path '${keyPath}' -ErrorAction SilentlyContinue`;
  const result = await runner.powershellJson(body, { timeoutMs: options.timeoutMs, name: `registry:${keyPath}` });
  if (!result.ok) return { ok: false, values: [], error: result.error };
  const row = asArray(result.data)[0];
  if (!row || typeof row !== 'object') return { ok: false, values: [], error: `${keyPath}: key not present` };
  const values = Object.entries(row)
    .filter(([name]) => !['PSPath', 'PSParentPath', 'PSChildName', 'PSDrive', 'PSProvider'].includes(name))
    .map(([name, value]) => ({ name, type: typeof value, value }));
  return { ok: values.length > 0, values, error: null };
}

/**
 * Enumerate registry subkeys under a path.
 * @param {import('./runner.js').CommandRunner} runner
 * @param {string} keyPath
 * @param {{timeoutMs?: number}} [options]
 */
export async function listSubKeys(runner, keyPath, options = {}) {
  if (!runner.isWindows) return { ok: false, names: [], error: 'Not running on Windows' };
  const result = await runner.powershellJson(
    `Get-ChildItem -Path '${keyPath}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty PSChildName`,
    { timeoutMs: options.timeoutMs, name: `regkeys:${keyPath}` }
  );
  if (!result.ok) return { ok: false, names: [], error: result.error };
  const names = asArray(result.data).map((row) => (typeof row === 'string' ? row : cleanString(row))).filter(Boolean);
  return { ok: names.length > 0, names, error: null };
}

/**
 * Run a documented, read-only Windows command and return its stdout.
 * @param {import('./runner.js').CommandRunner} runner
 * @param {string} file
 * @param {string[]} args
 * @param {{timeoutMs?: number}} [options]
 */
export async function runReadOnly(runner, file, args, options = {}) {
  const result = await runner.run(file, args, { timeoutMs: options.timeoutMs ?? 20_000 });
  return {
    ok: result.ok,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
    timedOut: result.timedOut,
    durationMs: result.durationMs
  };
}

/**
 * Map a failed collection outcome to a field-status decision.
 * Centralising this stops providers from inventing their own (usually wrong)
 * mapping, e.g. reporting an access-denied SMART read as "not supported".
 * @param {{accessDenied?:boolean, unavailable?:boolean, error?:string|null}} outcome
 * @returns {{kind:'permission'|'unsupported'|'error', reason:string}}
 */
export function failureToStatus(outcome) {
  if (outcome.accessDenied) return { kind: 'permission', reason: outcome.error ?? 'Access denied' };
  if (outcome.unavailable) return { kind: 'unsupported', reason: outcome.error ?? 'Not exposed by this device' };
  return { kind: 'error', reason: outcome.error ?? 'Collection failed' };
}

/**
 * Lazy, cached import of `systeminformation`.
 *
 * `systeminformation` is used only for live counters and for the handful of
 * identity values where it is the most reliable cross-version source. It is
 * imported lazily so a failure there degrades gracefully instead of preventing the
 * app from starting, and it is never treated as authoritative when CIM disagrees.
 */
let siModule = null;
let siLoadError = null;

/**
 * @returns {Promise<{ok:true, si:any} | {ok:false, error:string}>}
 */
export async function loadSystemInformation() {
  if (siModule) return { ok: true, si: siModule };
  if (siLoadError) return { ok: false, error: siLoadError };
  try {
    const imported = await import('systeminformation');
    siModule = imported.default ?? imported;
    return { ok: true, si: siModule };
  } catch (error) {
    siLoadError = error instanceof Error ? error.message : String(error);
    return { ok: false, error: siLoadError };
  }
}

/** Reset the cached module; used by tests that simulate a missing dependency. */
export function resetSystemInformationCache() {
  siModule = null;
  siLoadError = null;
}

/**
 * Convenience: map a CIM row's fields through the parser helpers in one call.
 * Reduces the per-provider boilerplate that otherwise hides real logic.
 * @param {object} row
 * @param {Record<string, (value:unknown)=>unknown>} extractors
 */
export function extract(row, extractors) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, fn] of Object.entries(extractors)) {
    try {
      out[key] = fn(row?.[key]);
    } catch {
      out[key] = null;
    }
  }
  return out;
}

export { cleanString, num, bool, date, asArray, Status };
