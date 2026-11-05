/**
 * VERIDEX — scan orchestration.
 *
 * One place that assembles the registry, runs the sweep, records history and hands
 * back everything a report needs. Kept free of Electron so the whole pipeline can
 * be exercised on a machine with no display and no Windows.
 *
 * The `main.js` main process calls `runScan()` and forwards progress over IPC.
 * Tests call it with an injected runner and a fake registry.
 */

import { ProviderRegistry, DiagnosticRunner } from '../engine/provider-registry.js';
import { assessFromDiagnostics } from '../engine/health.js';
import { detectPermissionState, capabilityMatrix } from '../platform/permissions.js';
import { CommandRunner, NoopRunner } from '../platform/runner.js';
import { HistoryStore } from '../history/store.js';
import { guardFromSettings } from '../security/guard.js';
import { Status } from '../core/status.js';
import { InspectionSession } from '../manual/session.js';
import { runnerOptions, historyOptions } from './settings-wiring.js';

/**
 * @typedef {object} ScanOptions
 * @property {import('../platform/runner.js').CommandRunner} [runner]
 * @property {import('../core/logger.js').Logger|null} [logger]
 * @property {import('../core/settings.js').SettingsStore|Record<string, unknown>} [settings]
 * @property {ProviderRegistry} [registry]
 * @property {string[]|null} [tasks]        Null means every registered task.
 * @property {boolean} [quick]              Run only tasks marked `quick`.
 * @property {(progress:object) => void} [onProgress]
 * @property {AbortSignal} [signal]
 * @property {InspectionSession|null} [session]
 * @property {string|null} [historyFile]
 */

/**
 * Run one diagnostic sweep.
 *
 * @param {ScanOptions} [options]
 */
export async function runScan(options = {}) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const logger = options.logger ?? null;
  const settings = options.settings ?? {};

  // On a non-Windows host the real runner would fail every command, so the caller
  // gets a NoopRunner that returns an explicit "not available here" result instead
  // of a wall of spawn errors. The report then says so, per field.
  const baseRunner = options.runner ?? (process.platform === 'win32' ? new CommandRunner() : new NoopRunner());
  const guard = guardFromSettings(settings, { logger });

  // Every command the engine issues is offered to the guard first. The runner is
  // wrapped rather than the engine modified, so a new diagnostic module cannot
  // bypass the read-only policy by forgetting to ask.
  const runner = wrapRunner(baseRunner, guard);

  const permissions = await detectPermissionState(runner);
  const registry = options.registry ?? buildDefaultRegistry();

  const { timeoutMs } = runnerOptions(settings);
  const diagnostic = new DiagnosticRunner({ registry, permissions, logger, runner, timeoutMs });

  const allTasks = registry.taskList().map((task) => task.id);
  const requested = options.tasks && options.tasks.length > 0 ? options.tasks : allTasks;
  // Silently dropping an unknown task id would hide a wiring bug; surface it.
  const unknown = requested.filter((id) => !allTasks.includes(id));
  const known = requested.filter((id) => allTasks.includes(id));
  const selected = options.quick ? known.filter((id) => registry.task(id).quick) : known;

  const { results, byModule, cancelled, durationMs } = await diagnostic.runTasks(selected, {
    signal: options.signal,
    onProgress: options.onProgress
  });

  const modules = Object.fromEntries(Object.entries(byModule).map(([id, section]) => [id, section.fields]));
  const sectionTitles = Object.fromEntries(Object.entries(byModule).map(([id, section]) => [id, section.title]));
  const assessment = assessFromDiagnostics(modules);

  const attempts = results.flatMap((result) =>
    result.attempts.map((attempt) => ({
      providerId: attempt.providerId,
      task: result.taskId,
      ok: attempt.ok,
      // The status travels with the attempt. Classifying a permission problem by
      // regex-matching the error text was wrong: a provider reporting "blocked for
      // standard users" does not contain the word "permission", so an elevation
      // issue was being filed as an application error.
      status: attempt.status,
      error: attempt.error ?? null
    }))
  );
  const conflicts = results.flatMap((result) => result.conflicts);
  const validationProblems = results.flatMap((result) => result.validationProblems);

  const session = options.session ?? null;
  const manual = session ? session.toIssues() : { warnings: [], errors: [], conflicts: [] };

  // Blocked-by-elevation is a fact about the session, not a bug: it belongs in
  // warnings, where the UI shows it as "relaunch as administrator for this". A
  // genuine provider failure belongs in errors.
  const permissionBlocked = (attempt) =>
    attempt.status === Status.PERMISSION_REQUIRED || (attempt.skipReason === 'permission');

  /** @type {string[]} */
  const warnings = [
    ...attempts.filter((attempt) => !attempt.ok && permissionBlocked(attempt)).map((attempt) => `${attempt.task}: ${attempt.error}`),
    ...validationProblems,
    ...manual.warnings
  ];
  /** @type {string[]} */
  const errors = attempts
    .filter((attempt) => !attempt.ok && attempt.error && !permissionBlocked(attempt))
    .map((attempt) => `${attempt.task}: ${attempt.error}`);

  if (unknown.length > 0) errors.push(`Requested tasks that are not registered: ${unknown.join(', ')}`);

  const finishedAt = new Date().toISOString();
  const scan = {
    startedAt,
    finishedAt,
    durationMs: durationMs ?? Date.now() - started,
    cancelled,
    quick: Boolean(options.quick),
    permissions,
    capabilityMatrix: capabilityMatrix(permissions),
    guard: guard.summary(),
    modules,
    sectionTitles,
    assessment,
    attempts,
    results,
    issues: { warnings, errors, conflicts },
    manualSession: session,
    taskCount: selected.length,
    providersAttempted: attempts.length
  };

  // History is written only if the user keeps it, and only when the sweep finished.
  const history = historyOptions(settings);
  if (history.persist && !cancelled && options.historyFile !== null) {
    try {
      const store = new HistoryStore({ file: options.historyFile ?? null, ...history.storeOptions, logger });
      if (options.historyFile) await store.load();
      scan.historyEntry = await store.add?.({
        id: undefined,
        startedAt,
        finishedAt,
        assessment,
        coverage: { fields: Object.keys(modules).length },
        issues: scan.issues,
        platform: process.platform
      });
    } catch (error) {
      // A history failure must never lose the scan the user just ran.
      await logger?.warn('history write failed', { scope: 'app', error: error instanceof Error ? error.message : String(error) });
      scan.historyError = error instanceof Error ? error.message : String(error);
    }
  }

  return scan;
}

/**
 * Wrap a runner so every command passes the read-only guard.
 * @param {import('../platform/runner.js').CommandRunner} runner
 * @param {import('../security/guard.js').SecurityGuard} guard
 */
export function wrapRunner(runner, guard) {
  /** @param {string} file @param {string[]} args */
  const check = (file, args) => {
    const verdict = guard.checkCommand(file, args, { task: 'diagnostics' });
    if (!verdict.allowed) {
      const reason = verdict.verdict === 'needs-consent' ? `${verdict.reason} (consent not recorded)` : verdict.reason;
      return { blocked: true, reason: reason ?? 'Blocked by the read-only guard.' };
    }
    return { blocked: false, reason: null };
  };

  return new Proxy(runner, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (property === 'run') {
        return async (/** @type {string} */ file, /** @type {string[]} */ args = [], opts) => {
          const verdict = check(file, args);
          if (verdict.blocked) {
            return {
              ok: false,
              code: -1,
              stdout: '',
              stderr: `VERIDEX refused to run this command: ${verdict.reason}`,
              timedOut: false,
              durationMs: 0,
              command: [file, ...args].join(' ')
            };
          }
          return value.call(target, file, args, opts);
        };
      }
      if (property === 'powershellJson' || property === 'powershell') {
        return async (/** @type {string} */ script, opts) => {
          const verdict = check('powershell', [script]);
          if (verdict.blocked) {
            return { ok: false, data: null, error: `VERIDEX refused to run this command: ${verdict.reason}` };
          }
          return value.call(target, script, opts);
        };
      }
      return value.bind(target);
    }
  });
}

/**
 * The registry the app ships with.
 *
 * Providers are registered lazily by the diagnostic modules so a failure in one
 * module cannot prevent the others from loading. Until those registrations land,
 * this returns an empty registry and `runScan` reports zero tasks — an honest
 * "nothing ran" rather than a fabricated sweep.
 *
 * @returns {ProviderRegistry}
 */
export function buildDefaultRegistry() {
  return new ProviderRegistry();
}

/**
 * Turn a finished scan into the arguments `buildReport` expects. One place, so the
 * UI, the CLI and the tests cannot build subtly different reports from the same run.
 * @param {Awaited<ReturnType<typeof runScan>>} scan
 * @param {{reportId?:string, kind?:string, includeSensitive?:boolean, brandLine?:string}} [options]
 */
export function reportInputFromScan(scan, options = {}) {
  const session = scan.manualSession ?? null;
  return {
    modules: scan.modules,
    sectionTitles: scan.sectionTitles,
    assessment: scan.assessment,
    meta: {
      reportId: options.reportId,
      kind: options.kind ?? 'full',
      startedAt: scan.startedAt,
      includeSensitive: options.includeSensitive === true,
      mode: scan.permissions?.mode ?? 'standard',
      platform: process.platform
    },
    manualResults: session ? session.resultsForReport() : [],
    manualCoverage: session ? session.coverage() : null,
    issues: scan.issues,
    providerLog: scan.attempts,
    privacy: { allowNetwork: false, persistHistory: true, guard: scan.guard },
    settings: {
      includeManualResults: true,
      includeCertificate: true
    }
  };
}
