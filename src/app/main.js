/**
 * VERIDEX — main process.
 *
 * Responsibilities, deliberately narrow:
 *   - create one hardened BrowserWindow;
 *   - own every privileged operation (file dialogs, child processes, settings,
 *     history) and expose them only through the validated IPC contract;
 *   - install the outbound guard before any diagnostic code runs.
 *
 * What is deliberately NOT here: any diagnostic logic, any parsing, any rendering.
 * Those live in modules that do not import Electron, so they can be tested on a
 * machine with no display — which is the only reason this project can claim test
 * coverage for its diagnostics at all.
 *
 * VERIFICATION STATUS: this file cannot be executed in the development environment
 * (no Electron binary, no Windows, no display). It is type-checked by import in
 * `scripts/check.mjs` only where possible, and its *logic* is extracted into
 * testable modules (`ipc-contract.js`, `scan.js`, `settings-wiring.js`). Anything
 * that can only be verified by launching the app on Windows is listed in
 * docs/RELEASE_VERIFICATION.md as NOT VERIFIED.
 */

import { app, BrowserWindow, dialog, ipcMain, shell, session as electronSession } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { Logger } from '../core/logger.js';
import { Monitor, SENSORS } from '../monitoring/monitor.js';
import { detectPermissionState } from '../platform/permissions.js';
import { CommandRunner } from '../platform/runner.js';
import { SettingsStore } from '../core/settings.js';
import {
  CHANNELS, EVENT_CHANNELS, fail, isEvent, isInvokable, ok, validateRequest,
  WINDOW_DEFAULTS, WINDOW_SECURITY
} from './ipc-contract.js';
import { wireAll, uiPayload } from './settings-wiring.js';
import { runScan, reportInputFromScan } from './scan.js';
import { buildReport } from '../reporting/model.js';
import { projectScan } from './scan-projection.js';
import { planExport, describeExport, verifyExport, EXPORT_PROMISE, formatBytes } from './driver-export.js';
import { runElevatedTask } from './elevated-runner.js';
import { onboardingState, advanceOnboarding, skipOnboarding, resetOnboarding } from './onboarding.js';
import { benchmarkSingleCore, benchmarkMultiCore, benchmarkMemoryBandwidth, mapCpuBenchmarkResults } from '../benchmarking/cpu-bench.js';
import { runDiskBenchmark } from '../benchmarking/disk-bench.js';
import { runCpuStress, stressCapabilities, UNSUPPORTED_STRESS_KINDS } from '../benchmarking/stress-run.js';
import { mapGpuBenchmarkResults, gpuFrameTimeOf } from '../benchmarking/gpu-bench.js';
import { computeResponsiveness, responsivenessFields } from '../benchmarking/responsiveness.js';
import { writeMarker, readMarker, clearMarker, markerPath, describeInterrupted, markerIsStale } from './crash-marker.js';
import { readSensors } from '../monitoring/monitor.js';
import { parseLogText, filterRecords, summariseLog, buildExport, describeRetention, DEFAULT_LEVEL } from './logs.js';
import { spawn as spawnChild } from 'node:child_process';
import { readdir, readFile as readTextFile, rm, statfs, mkdir, writeFile } from 'node:fs/promises';
import { renderPdf } from '../reporting/pdf.js';
import { renderHtml } from '../reporting/html.js';
import { renderCsv } from '../reporting/csv.js';
import { renderJson } from '../reporting/json.js';
import { buildCertificate } from '../reporting/certificate.js';
import { SecurityGuard } from '../security/guard.js';
import { applyPrivacyPreset } from '../security/privacy.js';
import { InspectionSession } from '../manual/session.js';
import { HistoryStore } from '../history/store.js';
import { compareEntries } from '../history/compare.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

/** @type {BrowserWindow|null} */
let window = null;
/** @type {Logger|undefined} */
let logger;
/** @type {SettingsStore|undefined} */
let settings;
/** @type {AbortController|null} */
let scanController = null;
/** @type {Awaited<ReturnType<typeof runScan>>|null} */
let lastScan = null;
/** @type {InspectionSession|null} */
let session = null;

/** Absolute path inside the per-user data directory. Single user, single file. */
const dataDir = () => app.getPath('userData');
const logDir = () => path.join(dataDir(), 'logs');
const settingsFile = () => path.join(dataDir(), 'settings.json');
const historyFile = () => path.join(dataDir(), 'history.json');

// ── Single instance ────────────────────────────────────────────────────────────
// A second copy would fight the first for the settings file and start a second
// sweep against the same machine, skewing any benchmark in progress.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
}

/**
 * Send an event to the renderer, if there is one and it is still alive.
 * @param {string} channel
 * @param {unknown} payload
 */
function emit(channel, payload) {
  if (!EVENT_CHANNELS.includes(channel)) return;
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
  window.webContents.send(channel, payload);
}

/**
 * Register a handler for one channel. The contract validation happens here, on
 * the main-process side, so a compromised renderer cannot skip it.
 * @param {string} channel
 * @param {(payload:unknown) => Promise<unknown>|unknown} handler
 */
function handle(channel, handler) {
  if (!isInvokable(channel)) throw new Error(`Refusing to register unknown channel "${channel}"`);
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      const validated = validateRequest(channel, args);
      if (!validated.ok) return fail(new Error(validated.reason), 'invalid_request');
      return ok(await handler(validated.value));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = /permission|administrat|elevat/i.test(message) ? 'permission_required' : 'app_error';
      await logger?.error('ipc handler failed', { scope: 'ipc', channel, error: message });
      emit('app:error', { channel, message });
      return fail(error, code);
    }
  });
}

async function createWindow() {
  window = new BrowserWindow({
    ...WINDOW_DEFAULTS,
    minWidth: WINDOW_DEFAULTS.minWidth,
    minHeight: WINDOW_DEFAULTS.minHeight,
    icon: path.join(ROOT, 'assets', 'icons', 'icon.png'),
    title: 'VERIDEX',
    backgroundColor: WINDOW_DEFAULTS.backgroundColor,
    autoHideMenuBar: true,
    webPreferences: {
      ...WINDOW_SECURITY,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });

  // Sampling must not outlive the window that displays it: a timer running with no
  // consumer would keep issuing WMI queries forever.
  window.on('closed', () => {
    monitor?.stop();
    monitor = null;
  });

  // No navigation, ever. The app is a single local document; any attempt to
  // navigate is a bug or an attack, so it is refused and logged.
  window.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    void logger?.warn('blocked in-app navigation', { scope: 'security', url });
  });

  // Deny every permission request: a diagnostic tool has no need for camera,
  // microphone, geolocation or notifications, and denying by default means a
  // renderer compromise gains nothing.
  electronSession.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    void logger?.warn('permission request denied', { scope: 'security', permission });
    callback(false);
  });
  electronSession.defaultSession.setPermissionCheckHandler(() => false);

  window.webContents.setWindowOpenHandler(({ url }) => {
    // External links go to the system browser, never to an in-app window.
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Startup is logged step by step because a window that exists, whose page has loaded, and
  // which never becomes visible has no other witness. The lines are small, they are useful to
  // anyone debugging their own machine, and they were what distinguished "the application
  // never asked to be shown" from "the desktop refused to show it".
  await logger?.info('window created', { scope: 'startup', bounds: window.getBounds() });
  window.webContents.once('did-finish-load', () => {
    void logger?.info('renderer finished loading', { scope: 'startup', url: window.webContents.getURL() });
  });
  await window.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
  await logger?.info('renderer loaded', { scope: 'startup', readyState: 'complete' });

  // A window that loads and is never shown is useless, so this is not allowed to fail quietly:
  // whatever happens here is logged, and a failure to show is reported as such.
  try {
    window.show();
    await logger?.info('window show requested', {
      scope: 'startup',
      visible: window.isVisible(),
      minimised: window.isMinimized()
    });
  } catch (error) {
    await logger?.error('the window could not be shown', {
      scope: 'startup',
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      destroyed: window.isDestroyed()
    });
  }
}

/** Render the report for one format. Shared by build and save. */
function renderFormat(scan, format, options) {
  const input = reportInputFromScan(scan, {
    includeSensitive: options.includeSensitive,
    brandLine: options.brandLine,
    kind: 'full'
  });
  input.settings = {
    includeManualResults: options.includeManualResults,
    includeCertificate: options.includeCertificate
  };
  const report = buildReport(input);
  const certificate = options.includeCertificate ? buildCertificate(report) : null;

  switch (format) {
    case 'pdf':
      return renderPdf(report, { certificate });
    case 'html':
      return renderHtml(report, { certificateHtml: certificate ? undefined : '' });
    case 'csv':
      return renderCsv(report);
    case 'json':
      return renderJson(report);
    default:
      throw new Error(`Unsupported format "${format}"`);
  }
}

function registerHandlers() {
  handle('app:info', () => ({
    product: 'VERIDEX',
    brand: 'MERQO',
    version: app.getVersion(),
    founder: 'Shohan Khan',
    contact: 'merqoonline@gmail.com',
    platform: process.platform,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    dataDir: dataDir(),
    signed: app.isPackaged ? null : false,
    windowsVerified: false
  }));

  handle('app:settings', () => ({
    values: settings.all(),
    specs: settings.specs(),
    ui: uiPayload(settings),
    applied: wireAll(settings).applied
  }));

  handle('app:setSetting', async ({ key, value }) => {
    const result = await settings.set(key, value);
    if (result.ok) emit('settings:changed', { key, value: result.value });
    // A live monitor or guard must pick up the change immediately.
    if (key === 'privacy.allowNetwork') guard.setPolicy({ allowNetwork: result.value === true });
    return result;
  });

  handle('app:applyPrivacyPreset', async ({ presetId }) => {
    const result = await applyPrivacyPreset(settings, presetId);
    emit('settings:changed', { key: 'privacy', value: presetId });
    return result;
  });

  handle('app:guardSummary', () => guard.summary());

  handle('scan:start', async ({ tasks }) => {
    if (scanController) return { alreadyRunning: true, startedAt: lastScan?.startedAt ?? null };
    scanController = new AbortController();
    // The marker is written before the first provider runs and removed after the last. If this
    // process dies in between, the next start knows the run was interrupted instead of pretending
    // nothing happened.
    const markerFile = markerPath(dataDir());
    await writeMarker(markerFile, { kind: 'scan', startedAt: new Date().toISOString(), appVersion: app.getVersion() })
      .catch((error) => logger?.warn('could not write the recovery marker', { scope: 'recovery', error: error.message }));
    try {
      const scan = await runScan({
        logger,
        settings,
        tasks: tasks.length > 0 ? tasks : null,
        session,
        historyFile: settings.get('diagnostics.persistHistory') ? historyFile() : null,
        appVersion: app.getVersion(),
        signal: scanController.signal,
        onProgress: (progress) => emit('scan:progress', {
          done: progress.done,
          total: progress.total,
          taskId: progress.taskId,
          status: progress.section?.status ?? null,
          title: progress.section?.title ?? null
        })
      });
      lastScan = scan;
      emit('scan:finished', {
        cancelled: scan.cancelled,
        durationMs: scan.durationMs,
        score: scan.assessment.score,
        rating: scan.assessment.rating,
        coveragePercent: scan.assessment.coveragePercent,
        warnings: scan.issues.warnings.length,
        errors: scan.issues.errors.length
      });
      return { startedAt: scan.startedAt, tasks: scan.taskCount, cancelled: scan.cancelled };
    } finally {
      scanController = null;
      await clearMarker(markerFile).catch(() => null);
    }
  });

  handle('scan:cancel', () => {
    if (!scanController) return { cancelled: false, reason: 'No scan is running.' };
    scanController.abort();
    return { cancelled: true };
  });

  handle('scan:state', () => ({
    running: scanController !== null,
    lastScanAt: lastScan?.finishedAt ?? null,
    score: lastScan?.assessment?.score ?? null
  }));

  handle('report:build', async ({ format }) => {
    if (!lastScan) throw new Error('Run a scan before building a report.');
    const options = {
      includeSensitive: settings.get('diagnostics.includeSensitiveInReport'),
      includeManualResults: settings.get('reports.includeManualResults'),
      includeCertificate: settings.get('reports.includeCertificate'),
      brandLine: settings.get('reports.brandLine')
    };
    const bytes = await renderFormat(lastScan, format, options);
    return { format, bytes: Buffer.isBuffer(bytes) ? bytes.length : Buffer.byteLength(bytes) };
  });

  handle('report:save', async ({ format }) => {
    if (!lastScan) throw new Error('Run a scan before saving a report.');
    const options = {
      includeSensitive: settings.get('diagnostics.includeSensitiveInReport'),
      includeManualResults: settings.get('reports.includeManualResults'),
      includeCertificate: settings.get('reports.includeCertificate'),
      brandLine: settings.get('reports.brandLine')
    };

    const extension = format;
    const { canceled, filePath } = await dialog.showSaveDialog(window, {
      title: 'Save VERIDEX report',
      defaultPath: path.join(app.getPath('documents'), `VERIDEX-report-${lastScan.finishedAt.slice(0, 10)}.${extension}`),
      filters: [{ name: format.toUpperCase(), extensions: [extension] }]
    });
    if (canceled || !filePath) return { saved: false };

    const bytes = await renderFormat(lastScan, format, options);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, bytes);
    await logger?.info('report saved', { scope: 'report', format, bytes: Buffer.isBuffer(bytes) ? bytes.length : 0 });
    return { saved: true, path: filePath };
  });

  /**
   * Measure how far a timer drifts from its deadline over a short window.
   *
   * This is the application's own responsiveness, not the machine's: a machine with a busy CPU and
   * a healthy application still has low lag, and that distinction is why the composite uses lag as
   * a penalty rather than as a weighted input.
   * @param {number} [windowMs]
   */
  async function measureEventLoopLag(windowMs = 200) {
    const started = process.hrtime.bigint();
    await new Promise((resolve) => setTimeout(resolve, windowMs));
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    return Math.max(0, Math.round((elapsedMs - windowMs) * 100) / 100);
  }

  /**
   * Run a benchmark under a single controller, with a deadline and a cancel path.
   * @param {'cpu'|'disk'} kind
   * @param {(signal: AbortSignal) => Promise<any>} body
   */
  async function runBenchmark(kind, body) {
    if (benchmarkRunning) throw new Error('A benchmark is already running.');
    benchmarkRunning = true;
    benchmarkAbort = new AbortController();
    const controller = benchmarkAbort;
    const startedAt = new Date().toISOString();
    const deadline = setTimeout(() => {
      controller.abort();
      controller.deadlineReached = true;
    }, BENCHMARK_DEADLINE_MS[kind]);
    try {
      const value = await body(controller.signal);
      return { ...value, startedAt, cancelled: value?.cancelled === true, timedOut: controller.deadlineReached === true };
    } finally {
      clearTimeout(deadline);
      benchmarkRunning = false;
      benchmarkAbort = null;
    }
  }

  // ── Benchmarks ────────────────────────────────────────────────────────────
  // The CPU and disk benchmark engines have existed since the first phase and were reachable
  // only from tests: the Performance page said so in as many words. A tested engine behind no
  // button is not a feature, it is a library.
  handle('bench:cpu', async ({ mode }) => runBenchmark('cpu', async (signal) => {
    const startedAt = new Date().toISOString();
    const started = Date.now();
    {
      emit('bench:progress', { kind: 'cpu', stage: 'started', mode, startedAt });
      const onProgress = (progress) => emit('bench:progress', { kind: 'cpu', stage: progress.stage ?? 'running', done: progress.done, total: progress.total });
      const single = mode === 'multi' || mode === 'memory' ? null : await benchmarkSingleCore({ onProgress, signal });
      const multi = mode === 'single' || mode === 'memory' || signal.aborted ? null : await benchmarkMultiCore({ signal });
      const memory = mode !== 'memory' && mode !== 'all' || signal.aborted ? null : await benchmarkMemoryBandwidth({ signal });
      const measured = [single, multi, memory].some((entry) => entry && entry.error === 'cancelled');
      if (measured) {
        emit('bench:progress', { kind: 'cpu', stage: 'cancelled', mode });
        return { mode, cancelled: true, at: startedAt, durationMs: Date.now() - started, results: null, fields: {} };
      }
      const results = {
        single: single ?? { opsPerSecond: null, samples: [], spreadPercent: null, checksumStable: false, error: 'not measured in this mode' },
        multi: multi ?? { threads: 0, opsPerSecond: null, perThread: [], scaling: null, error: 'not measured in this mode' },
        memory: memory ?? { sequentialGbps: null, stridedGbps: null, error: 'not measured in this mode' },
        startedAt,
        durationMs: Date.now() - started
      };
      benchmarkResults.cpu = { mode, at: startedAt, durationMs: results.durationMs, results, fields: mapCpuBenchmarkResults(results), cancelled: false };
      emit('bench:progress', { kind: 'cpu', stage: 'finished', durationMs: results.durationMs });
      return benchmarkResults.cpu;
    }
  }));

  handle('bench:disk', async () => runBenchmark('disk', async (signal) => {
    const startedAt = new Date().toISOString();
    {
      const allowWrite = settings.get('benchmark.diskWriteTest') !== false;
      const sizeMb = settings.get('benchmark.diskTestSizeMb');
      emit('bench:progress', { kind: 'disk', stage: 'started', allowWrite, sizeMb });
      const result = await runDiskBenchmark({
        allowWrite,
        sizeMb,
        signal,
        onProgress: (progress) => emit('bench:progress', { kind: 'disk', stage: progress.stage, done: progress.done, total: progress.total })
      });
      benchmarkResults.disk = { at: startedAt, allowWrite, sizeMb, ...result };
      emit('bench:progress', {
        kind: 'disk',
        stage: result.cancelled ? 'cancelled' : 'finished',
        cleanupRemoved: result.cleanup?.removed === true
      });
      // The benchmark writes a file. Whether it was removed is part of the result, not a detail.
      if (!result.cleanup?.removed) await logger?.warn('disk benchmark left a temporary file behind', { scope: 'benchmark', path: result.cleanup?.path ?? null });
      return benchmarkResults.disk;
    }
  }));

  // ── Stress testing ────────────────────────────────────────────────────────
  // The guard, the limits and the refusals were written and tested in the first phase; nothing
  // ever applied load. This is that part, kept deliberately small: CPU only, bounded, and
  // reported without a verdict.
  handle('stress:start', async ({ durationSec, threads, consent }) => {
    if (stressRun) throw new Error('A stress run is already in progress.');
    const permission = await detectPermissionState(new CommandRunner()).catch(() => ({ isAdmin: false }));
    stressAbort = new AbortController();
    const controller = stressAbort;
    const runId = `stress-${Date.now()}`;
    const markerFile = markerPath(dataDir());
    await writeMarker(markerFile, { kind: 'stress', startedAt: new Date().toISOString(), id: runId, appVersion: app.getVersion() })
      .catch(() => null);
    try {
      const result = await runCpuStress({
        durationSec,
        threads,
        consentGiven: consent === true,
        maxDurationSec: settings.get('stress.maxDurationSec') ?? 300,
        thermalLimitC: settings.get('stress.thermalLimitC') ?? 90,
        isOnBattery: null,
        signal: controller.signal,
        // The thermal stop is only real if the reading is real. A sensor that cannot be read
        // returns null here, and the guard then says the thermal stop was inactive rather than
        // pretending a temperature.
        readTemperature: async () => {
          const readings = await readSensors({ runner: new CommandRunner(), includePrivileged: permission.isAdmin }).catch(() => null);
          const value = readings?.['cpu.temp']?.value;
          return typeof value === 'number' && Number.isFinite(value) ? value : null;
        },
        thermalSensorAvailable: true,
        onSample: (sample) => emit('stress:sample', { runId, ...sample }),
        logicalCpus: os.cpus()?.length ?? 1
      });
      stressLast = { runId, at: new Date().toISOString(), ...result };
      emit('stress:finished', { runId, started: result.started, state: result.state, stopReason: result.stopReason ?? null });
      if (!result.started) await logger?.warn('stress run refused', { scope: 'stress', reason: result.reason });
      return stressLast;
    } finally {
      stressAbort = null;
      await clearMarker(markerFile).catch(() => null);
    }
  });

  handle('stress:stop', () => {
    if (!stressAbort) return { stopped: false, reason: 'No stress run is running.' };
    stressAbort.abort();
    return { stopped: true };
  });

  handle('stress:state', async () => {
    const permission = await detectPermissionState(new CommandRunner()).catch(() => ({ isAdmin: false }));
    const readings = await readSensors({ runner: new CommandRunner(), includePrivileged: permission.isAdmin }).catch(() => ({}));
    const temperature = readings?.['cpu.temp']?.value;
    return {
      running: Boolean(stressAbort),
      last: stressLast,
      capabilities: stressCapabilities({
        thermalSensorAvailable: typeof temperature === 'number' && Number.isFinite(temperature),
        logicalCpus: os.cpus()?.length ?? 1
      }),
      currentTemperatureC: typeof temperature === 'number' ? temperature : null,
      thermalSensorReason: readings?.['cpu.temp']?.reason ?? null,
      unsupported: { ...UNSUPPORTED_STRESS_KINDS },
      limits: {
        minDurationSec: 10,
        maxDurationSec: settings.get('stress.maxDurationSec') ?? 300,
        thermalLimitC: settings.get('stress.thermalLimitC') ?? 90,
        requireConsent: settings.get('stress.requireConsent') !== false
      }
    };
  });

  handle('bench:gpu', ({ measurement }) => {
    const at = new Date().toISOString();
    benchmarkResults.gpu = { at, measurement, fields: mapGpuBenchmarkResults(measurement) };
    return benchmarkResults.gpu;
  });

  handle('bench:responsiveness', async () => {
    const cpu = benchmarkResults.cpu?.results ?? null;
    const disk = benchmarkResults.disk ?? null;
    const gpu = benchmarkResults.gpu?.measurement ?? null;
    // Event-loop lag is measured now, at rest, so a figure that says "the application was busy"
    // comes from an actual observation rather than from the fact that a benchmark just ran.
    const lag = await measureEventLoopLag();
    const inputs = {
      cpuSingleOpsPerSec: cpu?.single?.opsPerSecond ?? null,
      memoryBandwidthGbps: cpu?.memory?.sequentialGbps ?? null,
      diskRandomReadMs: disk?.fields?.randomReadLatency?.value ?? null,
      gpuFrameTimeMs: gpuFrameTimeOf(gpu),
      eventLoopLagMs: lag
    };
    const composite = computeResponsiveness(inputs);
    return { inputs, eventLoopLagMs: lag, composite, fields: responsivenessFields(inputs) };
  });

  handle('bench:cancel', () => {
    if (!benchmarkAbort) return { cancelled: false, reason: 'No benchmark is running.' };
    benchmarkAbort.abort();
    emit('bench:progress', { kind: 'any', stage: 'cancelling' });
    return { cancelled: true };
  });

  handle('bench:state', () => ({ cpu: benchmarkResults.cpu, disk: benchmarkResults.disk, running: benchmarkRunning }));

  handle('manual:suites', () => ({
    suites: session.suites,
    coverage: session.coverage(),
    results: session.resultsForReport()
  }));

  handle('manual:record', ({ testId, verdict, detail }) => session.record(testId, verdict, detail));

  handle('manual:coverage', () => ({ coverage: session.coverage(), progress: session.progress(), issues: session.toIssues() }));

  // ── First run (R-20-01) ──
  //
  // Completion is a setting, so it is visible, resettable and recorded honestly: a tour that was
  // skipped is recorded as skipped rather than as read.
  handle('app:onboarding', () => onboardingState({ values: settings.all() }));

  handle('app:onboardingAdvance', async ({ step }) => {
    const advance = advanceOnboarding({ currentStepId: step });
    for (const [key, value] of Object.entries(advance.values)) await settings.set(key, value);
    return { ...onboardingState({ values: settings.all() }), done: advance.done };
  });

  handle('app:onboardingSkip', async () => {
    const skip = skipOnboarding();
    for (const [key, value] of Object.entries(skip.values)) await settings.set(key, value);
    return onboardingState({ values: settings.all() });
  });

  handle('app:onboardingReset', async () => {
    const reset = resetOnboarding();
    for (const [key, value] of Object.entries(reset.values)) await settings.set(key, value);
    return onboardingState({ values: settings.all() });
  });

  // ── Driver export (R-11-03) ──
  //
  // Three separate steps, because they fail differently and a user needs to know which one did:
  // choosing a folder (dialog), planning (space and path checks, nothing written), and exporting
  // (a privileged copy). The export never installs, updates or removes a driver.
  let exportAbort = null;
  let lastExport = null;

  const freeBytesAt = async (target) => {
    try {
      const stats = await statfs(path.parse(target).root || target);
      return stats.bavail * stats.bsize;
    } catch {
      return null; // A missing measurement is not a reason to refuse the export.
    }
  };

  const countInfFiles = async (folder) => {
    try {
      const entries = await readdir(folder, { withFileTypes: true });
      const found = [];
      for (const entry of entries) {
        if (entry.isFile() && /\.inf$/i.test(entry.name)) found.push(entry.name);
        else if (entry.isDirectory()) {
          const nested = await readdir(path.join(folder, entry.name)).catch(() => []);
          for (const name of nested) if (/\.inf$/i.test(name)) found.push(name);
        }
      }
      return found;
    } catch {
      return [];
    }
  };

  handle('drivers:chooseDestination', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose a folder for the driver export',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Export here'
    });
    if (result.canceled || !result.filePaths?.[0]) return { chosen: false };
    return { chosen: true, path: result.filePaths[0] };
  });

  handle('drivers:plan', async ({ destination }) => {
    const freeBytes = await freeBytesAt(destination);
    const driverCount = lastScan ? Object.keys(lastScan.modules?.drivers ?? {}).length : null;
    const plan = planExport({ destination, driverCount, freeBytes });
    return { ...plan, freeBytes, driverCount, promise: EXPORT_PROMISE, freeLabel: Number.isFinite(freeBytes) ? formatBytes(freeBytes) : null };
  });

  handle('drivers:export', async ({ destination }) => {
    if (exportAbort) return { ok: false, code: 'already_running', reason: 'An export is already running.' };

    const freeBytes = await freeBytesAt(destination);
    const driverCount = lastScan ? Object.keys(lastScan.modules?.drivers ?? {}).length : null;
    const plan = planExport({ destination, driverCount, freeBytes });
    if (!plan.ok) {
      lastExport = { ...plan, promise: EXPORT_PROMISE };
      return lastExport;
    }

    // The folder is created by us, at standard privilege, so pnputil writes into a folder that
    // already exists and the user can see where the export is going before the prompt appears.
    try {
      await mkdir(plan.path, { recursive: true });
    } catch (error) {
      lastExport = {
        ok: false,
        code: 'destination_unwritable',
        reason: `The folder could not be created (${error instanceof Error ? error.message : String(error)}). Nothing was written.`,
        promise: EXPORT_PROMISE
      };
      return lastExport;
    }

    exportAbort = new AbortController();
    const resultPath = path.join(app.getPath('temp'), `veridex-elevated-${Date.now()}.json`);
    let outcome;
    try {
      outcome = await runElevatedTask({
        taskId: 'drivers.export',
        params: { destination: plan.path },
        appPath: process.execPath,
        resultPath,
        spawn: spawnChild,
        readFile: (target) => readTextFile(target, 'utf8'),
        unlink: (target) => rm(target, { force: true }),
        timeoutMs: 15 * 60_000,
        signal: exportAbort.signal
      });
    } finally {
      exportAbort = null;
    }

    if (!outcome.ok) {
      // A cancelled or declined export may still have copied files, so the folder is checked
      // before anything is claimed about it.
      const copied = await countInfFiles(plan.path);
      lastExport = {
        ...describeExport({ folder: plan.folder, infFiles: copied, pnputilExitCode: outcome.exitCode, cancelled: outcome.cancelled }),
        reason: outcome.reason,
        path: plan.path,
        promise: EXPORT_PROMISE
      };
      return lastExport;
    }

    const infFiles = await countInfFiles(plan.path);
    const described = describeExport({ folder: plan.folder, infFiles, pnputilExitCode: 0 });
    const verified = verifyExport({ expected: described.packageCount, infFiles });
    lastExport = {
      ...described,
      ok: described.ok && verified.ok,
      verification: verified,
      path: plan.path,
      promise: EXPORT_PROMISE
    };
    logger?.info?.('driver export finished', { scope: 'export', packages: described.packageCount, verified: verified.ok });
    return lastExport;
  });

  handle('drivers:cancelExport', () => {
    if (!exportAbort) return { cancelled: false, reason: 'No export is running.' };
    exportAbort.abort();
    return { cancelled: true };
  });

  handle('drivers:lastExport', () => lastExport);

  // ── Logging surface (R-24-03) ──
  const logDir = () => path.join(dataDir(), 'logs');

  const readAllLogs = async () => {
    const files = await logger.files();
    let text = '';
    for (const file of files.slice(0, 10)) {
      text += `${await readTextFile(file, 'utf8').catch(() => '')}\n`;
    }
    return { ...parseLogText(text), fileCount: files.length };
  };

  handle('logs:recent', async (options = {}) => {
    const { records, unparseable } = await readAllLogs();
    const retention = describeRetention({ level: settings.get('storage.logLevel') ?? DEFAULT_LEVEL });
    return {
      entries: filterRecords(records, options),
      unparseable,
      summary: summariseLog(records),
      retention
    };
  });

  handle('logs:stats', async () => {
    const { records, fileCount } = await readAllLogs();
    return {
      summary: summariseLog(records, { fileCount }),
      retention: describeRetention({ maxBytes: logger.maxBytes, maxFiles: logger.maxFiles, level: logger.level })
    };
  });

  handle('logs:export', async () => {
    const { records } = await readAllLogs();
    const result = await dialog.showSaveDialog({
      defaultPath: path.join(app.getPath('documents'), `VERIDEX-log-${new Date().toISOString().slice(0, 10)}.txt`),
      filters: [{ name: 'Text', extensions: ['txt', 'log'] }]
    });
    if (result.canceled || !result.filePath) return { saved: false };
    await writeFile(result.filePath, buildExport(records, { version: app.getVersion(), platform: process.platform } ), 'utf8');
    return { saved: true, path: result.filePath, entries: records.length };
  });

  handle('logs:clear', async () => {
    const files = await logger.files();
    let removed = 0;
    for (const file of files) {
      try {
        await rm(file, { force: true });
        removed += 1;
      } catch {
        /* reported by the count */
      }
    }
    return { removed, remaining: files.length - removed };
  });

  // What the interface renders after a run.
  //
  // The renderer previously had no channel to ask for the results: `scan:finished` carried
  // five summary numbers, `scan:state` carried three, and the module pages read
  // `state.scan.modules`, which nothing ever assigned. The result was an application that
  // ran a full sweep and then showed "Not collected yet" on every diagnostic page.
  //
  // The projection itself lives in `scan-projection.js` so it can be tested against a real
  // scan without an Electron process, and so the interface and the report provably share one
  // definition of module status and coverage.
  handle('scan:last', () => ({ scan: lastScan ? projectScan(lastScan) : null }));

  handle('app:recovery', async () => {
    const file = markerPath(dataDir());
    const marker = await readMarker(file);
    if (!marker) return { interrupted: null, hadMarker: false };
    const interrupted = describeInterrupted(marker);
    const stale = markerIsStale(marker);
    // Reported once, then cleared: a marker that never goes away would greet the user with the
    // same crash on every start. The interruption is also written to the activity log, which is
    // where someone looks a week later.
    const cleared = await clearMarker(file);
    if (marker.corrupt) {
      await logger?.error('recovery marker was unreadable', { scope: 'recovery', error: marker.error });
    } else {
      await logger?.warn('previous session ended during a run', { scope: 'recovery', kind: marker.kind, startedAt: marker.startedAt, stale });
    }
    return { interrupted, hadMarker: true, stale, cleared, marker };
  });

  handle('history:list', async () => {
    const store = new HistoryStore({ file: historyFile(), ...wireAll(settings).history.storeOptions, logger });
    await store.load();
    return { entries: store.entries };
  });

  handle('history:compare', async ({ aId, bId }) => {
    const store = new HistoryStore({ file: historyFile(), logger });
    await store.load();
    const a = store.entries.find((entry) => entry.id === aId);
    const b = store.entries.find((entry) => entry.id === bId);
    if (!a || !b) throw new Error('One or both runs are not in the history.');
    return compareEntries(a, b);
  });

  // Live monitoring is driven here, in the main process, because sampling needs the
  // runner and the guard — neither of which exists in the sandboxed renderer. The
  // previous version replied `{ started: true }` without starting anything, which the
  // interface would have shown as a running monitor producing no samples forever.
  handle('monitor:start', async () => {
    if (monitor) monitor.stop();

    const state = await detectPermissionState(new CommandRunner());
    monitor = new Monitor({
      runner: new CommandRunner(),
      intervalMs: 1500,
      onSample: (sample) => emit('monitor:sample', sample),
      onError: (error) => {
        // A sampling failure ends the session rather than silently skipping ticks: the
        // interface must not keep showing stale numbers as if they were live.
        monitor = null;
        emit('app:error', { scope: 'monitor', message: error.message });
        emit('monitor:stopped', { reason: error.message });
      }
    });
    monitor.setPrivileged(state.isAdmin);
    monitor.start();

    return {
      started: true,
      intervalMs: monitor.intervalMs,
      elevated: state.isAdmin,
      sensors: SENSORS.map(({ id, label, unit }) => ({ id, label, unit })),
      note: state.isAdmin
        ? 'Sampling every 1.5 seconds with an elevated token, so privileged sensors are included.'
        : 'Sampling every 1.5 seconds as a standard user. Temperature and fan sensors usually need elevation, so they may report as unavailable.'
    };
  });

  handle('monitor:stop', () => {
    const wasRunning = Boolean(monitor?.running);
    monitor?.stop();
    monitor = null;
    return { stopped: true, wasRunning };
  });

  handle('shell:openDataFolder', async () => {
    await shell.openPath(dataDir());
    return { opened: dataDir() };
  });
}

/** @type {SecurityGuard} */
let guard;

/** The live-sampling session, or null when nothing is running. */
let monitor = null;

/** Benchmark results for this session, and whether one is running. */
const benchmarkResults = { cpu: null, disk: null };
let benchmarkRunning = false;
/** The running benchmark's abort controller, and the reason it was stopped if we stopped it. */
let benchmarkAbort = null;
/** The active stress run: its controller and its last result. */
let stressAbort = null;
let stressLast = null;
/** Ceilings that exist so a benchmark cannot run forever on a machine that never answers. */
const BENCHMARK_DEADLINE_MS = Object.freeze({ cpu: 240_000, disk: 180_000 });

/**
 * Crash handling (R-25-02).
 *
 * There is no handler that logs and carries on: continuing after an uncaught exception leaves the
 * application in a state nobody can describe, and every later figure becomes suspect. The
 * application records the failure, leaves the recovery marker in place for the next start, and
 * exits with a non-zero code. That is the behaviour the warning said had to be decided, and this
 * is the decision.
 */
function installCrashHandlers() {
  const fatal = (kind) => async (error) => {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const stack = error instanceof Error ? error.stack ?? null : null;
    try {
      await logger?.fatal(`${kind}: ${message}`, { scope: 'crash', stack });
    } catch {
      // Logging must not be the reason the process stays alive in a broken state.
    }
    try {
      await writeMarker(markerPath(dataDir()), {
        kind: 'crash',
        startedAt: new Date().toISOString(),
        detail: message.slice(0, 500),
        appVersion: app.getVersion()
      });
    } catch {
      // The marker is best-effort; the exit code below is not.
    }
    app.exit(1);
  };
  process.on('uncaughtException', fatal('uncaught exception'));
  process.on('unhandledRejection', fatal('unhandled rejection'));
}

app.whenReady().then(async () => {
  logger = new Logger({ dir: logDir(), level: 'info' });
  settings = new SettingsStore({ file: settingsFile(), logger });
  await settings.load();
  logger.setLevel(settings.get('storage.logLevel'));

  installCrashHandlers();

  guard = new SecurityGuard({ policy: { allowNetwork: settings.get('privacy.allowNetwork') }, logger });
  // Installed before any diagnostics run, so nothing can reach the network even if
  // a future dependency tries.
  guard.install();

  session = new InspectionSession({ inspector: null });

  // Handlers before the window. The renderer's boot sequence invokes `app:onboarding`,
  // `app:info`, `app:settings` and `app:lastScan` the moment its script runs, and Electron
  // rejects an invoke with no handler registered. Registering afterwards created a race that
  // a fast machine loses: on the Windows runner the first-run tour silently never appeared
  // (gui-smoke: "timed out waiting for the first-run tour"), because the renderer's
  // `app:onboarding` call arrived before this line. A fail-open here is a fail-silent - the
  // tour is skipped, nothing is logged, and the state still says the tour is owed.
  registerHandlers();
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  guard?.uninstall();
  scanController?.abort();
});

// A renderer that dies must not take the main process with it; log it and let the
// user reopen the window.
app.on('render-process-gone', (_event, _contents, details) => {
  void logger?.error('renderer process gone', { scope: 'app', reason: details.reason, exitCode: details.exitCode });
});

// The automated GUI smoke test attaches here, and only when a harness asks for it. A
// normal launch never evaluates this import, so the real application is unchanged.
if (process.env.VERIDEX_GUI_SMOKE === '1') {
  await import('./gui-smoke.js');
}

// The installed-application smoke test attaches the same way: install, launch the installed
// build, check that it works, quit. It exists because a passing build of the unpacked
// directory says nothing about whether the installer installs.
if (process.env.VERIDEX_INSTALL_SMOKE === '1') {
  await import('./install-smoke.js');
}

export { CHANNELS };
