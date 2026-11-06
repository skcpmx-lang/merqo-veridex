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
import { buildSnapshot } from '../history/compare.js';
import { guardFromSettings } from '../security/guard.js';
import { enforceNeverCollect } from '../security/privacy.js';
import { Status } from '../core/status.js';
import { InspectionSession } from '../manual/session.js';
import { runnerOptions, historyOptions } from './settings-wiring.js';
import { registerSystem } from '../diagnostics/system.js';
import { registerCpu } from '../diagnostics/cpu.js';
import { registerMemory } from '../diagnostics/memory.js';
import { registerMotherboard } from '../diagnostics/motherboard.js';
import { registerGpu } from '../diagnostics/gpu.js';
import { registerStorage } from '../diagnostics/storage.js';
import { registerBattery } from '../diagnostics/battery.js';
import { registerNetwork } from '../diagnostics/network.js';
import { registerDrivers } from '../diagnostics/drivers.js';
import { registerWindows } from '../diagnostics/windows.js';
import { registerWindowsHealth } from '../diagnostics/windowshealth.js';
import { registerEvents } from '../diagnostics/events.js';
import { registerSoftware } from '../diagnostics/software.js';
import { registerProcesses } from '../diagnostics/processes.js';
import { registerSecurity } from '../diagnostics/security.js';

/**
 * @typedef {object} ScanOptions
 * @property {import('../platform/runner.js').CommandRunner} [runner]
 * @property {import('../core/logger.js').Logger|null} [logger]
 * @property {import('../core/settings.js').SettingsStore|Record<string, unknown>} [settings]
 * @property {ProviderRegistry} [registry]
 * @property {string[]|null} [tasks]        Null means every registered task.
 * @property {boolean} [quick]              Run only tasks marked `quick`.
 * @property {string} [appVersion]           Recorded in the history entry, not guessed from the host.
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

  // The permission state is auto-detected from the host unless the caller supplies one.
  // Without this seam a test about privilege behaviour silently tests the CI machine
  // instead: it passed on Linux, where the probe reports standard mode, and failed on
  // Windows, where the same probe reports an elevated token.
  const permissions = options.permissions ?? (await detectPermissionState(runner));
  /** @type {string[]} */
  const registrationFailures = [];
  const registry = options.registry ?? buildDefaultRegistry({ failures: registrationFailures });

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

  // `enforceNeverCollect` existed, documented as the thing that keeps "secrets are never
  // collected" true, and the collection path never called it. Redaction at export time covered
  // the formats, but a field named `productKey` sat in the scan in the meantime - in the
  // interface, in the history snapshot and in any consumer added later. The policy is applied
  // here, where the fields enter the application, and the refused key is kept as an UNSUPPORTED
  // placeholder so the report can say why the value is absent.
  const modules = Object.fromEntries(
    Object.entries(byModule).map(([id, section]) => [id, enforceNeverCollect(section.fields)])
  );
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
  // A module that failed to register is a defect, not a machine limitation, so it
  // is an error rather than a warning.
  for (const failure of registrationFailures) errors.push(failure);

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
      // The entry has to carry what comparison and the history list read. It did not:
      // `summary` and `snapshot` were documented on HistoryEntry and never written, so
      // comparing two runs flattened `{}` against `{}` and reported that nothing had changed,
      // and every score in the comparison read as unrated. A comparison feature that always
      // says "no differences" is worse than no comparison feature.
      scan.historyEntry = await store.add?.({
        kind: scan.quick ? 'quick-scan' : 'full-scan',
        startedAt,
        finishedAt,
        durationMs: scan.durationMs,
        appVersion: options.appVersion ?? null,
        assessment,
        summary: {
          overallScore: assessment.score ?? null,
          rating: assessment.rating ?? null,
          coveragePercent: assessment.coveragePercent ?? null,
          modules: Object.keys(modules).length,
          warnings: scan.issues.warnings.length,
          errors: scan.issues.errors.length
        },
        // `modules` is a map of module id -> {field: FieldValue}, not a list of sections.
        snapshot: buildSnapshot(
          Object.fromEntries(
            Object.entries(modules).flatMap(([moduleId, fields]) =>
              Object.entries(fields ?? {}).map(([key, value]) => [`${moduleId}.${key}`, value?.value ?? null])
            )
          )
        ),
        coverage: { fields: Object.values(modules).reduce((total, fields) => total + Object.keys(fields ?? {}).length, 0) },
        issues: scan.issues,
        warnings: scan.issues.warnings,
        errors: scan.issues.errors,
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
 * Every diagnostic module registers its own providers and tasks. Registration is
 * wrapped individually so one module throwing cannot stop the others loading: the
 * scan then runs with the modules that did load, and the failure is reported as an
 * issue rather than presented as "this machine has no GPU".
 *
 * @param {{failures?: string[]}} [report] Receives a message per module that failed.
 * @returns {ProviderRegistry}
 */
export function buildDefaultRegistry(report = {}) {
  const registry = new ProviderRegistry();
  /** @type {Array<[string, (r: ProviderRegistry) => void]>} */
  const modules = [
    ['system', registerSystem],
    ['cpu', registerCpu],
    ['memory', registerMemory],
    ['motherboard', registerMotherboard],
    ['gpu', registerGpu],
    ['storage', registerStorage],
    ['battery', registerBattery],
    ['network', registerNetwork],
    ['drivers', registerDrivers],
    ['windows', registerWindows],
    ['windowsHealth', registerWindowsHealth],
    ['events', registerEvents],
    ['software', registerSoftware],
    ['processes', registerProcesses],
    ['security', registerSecurity]
  ];

  const failures = report.failures ?? (report.failures = []);
  let registered = 0;
  for (const [name, register] of modules) {
    try {
      register(registry);
      registered += 1;
    } catch (error) {
      failures.push(`${name} diagnostics failed to register: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  registry.registeredModuleCount = registered;
  return registry;
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
