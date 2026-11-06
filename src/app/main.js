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
import { buildReport, computeCoverage, aggregateStatus } from '../reporting/model.js';
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
    try {
      const scan = await runScan({
        logger,
        settings,
        tasks: tasks.length > 0 ? tasks : null,
        session,
        historyFile: settings.get('diagnostics.persistHistory') ? historyFile() : null,
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

  handle('manual:suites', () => ({
    suites: session.suites,
    coverage: session.coverage(),
    results: session.resultsForReport()
  }));

  handle('manual:record', ({ testId, verdict, detail }) => session.record(testId, verdict, detail));

  handle('manual:coverage', () => ({ coverage: session.coverage(), progress: session.progress(), issues: session.toIssues() }));

  // What the interface renders after a run.
  //
  // The renderer previously had no channel to ask for the results: `scan:finished` carried
  // five summary numbers, `scan:state` carried three, and the module pages read
  // `state.scan.modules`, which nothing ever assigned. The result was an application that
  // ran a full sweep and then showed "Not collected yet" on every diagnostic page. This
  // channel exists so the pages have real data, and it is deliberately a projection: it
  // carries fields, assessment, coverage and issues, and none of the internal attempt
  // records or the manual session.
  handle('scan:last', () => {
    if (!lastScan) return { scan: null };

    const modules = Object.fromEntries(
      Object.entries(lastScan.modules ?? {}).map(([id, fields]) => {
        const aggregated = aggregateStatus(fields);
        return [
          id,
          {
            title: lastScan.sectionTitles?.[id] ?? id,
            status: aggregated.status,
            note: aggregated.note,
            fields: fields ?? {}
          }
        ];
      })
    );

    // Coverage is computed with the same function the report uses. A second implementation
    // here would eventually disagree with the PDF, and the disagreement would be invisible.
    const sections = Object.values(lastScan.modules ?? {}).map((fields) => ({ rows: Object.values(fields ?? {}) }));

    return {
      scan: {
        startedAt: lastScan.startedAt,
        finishedAt: lastScan.finishedAt,
        durationMs: lastScan.durationMs,
        cancelled: lastScan.cancelled,
        quick: lastScan.quick,
        assessment: lastScan.assessment,
        coverage: computeCoverage(sections, []),
        issues: lastScan.issues,
        taskCount: lastScan.taskCount,
        providersAttempted: lastScan.providersAttempted,
        modules
      }
    };
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

app.whenReady().then(async () => {
  logger = new Logger({ dir: logDir(), level: 'info' });
  settings = new SettingsStore({ file: settingsFile(), logger });
  await settings.load();
  logger.setLevel(settings.get('storage.logLevel'));

  guard = new SecurityGuard({ policy: { allowNetwork: settings.get('privacy.allowNetwork') }, logger });
  // Installed before any diagnostics run, so nothing can reach the network even if
  // a future dependency tries.
  guard.install();

  session = new InspectionSession({ inspector: null });

  await createWindow();
  registerHandlers();

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
