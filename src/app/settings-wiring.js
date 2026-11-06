/**
 * VERIDEX — Settings wiring.
 *
 * The modules in `src/engine`, `src/benchmarking`, `src/monitoring`, `src/history`
 * and `src/reporting` deliberately receive *values*, never a settings store. That
 * keeps them testable and free of global state, but it means something must own the
 * translation from "keys a user toggles" to "arguments a module takes". This file is
 * that something, and it exists so that no setting can be decorative:
 * `npm run check` verifies every key declared in `SETTINGS_SPEC` is referenced by
 * real code, and this module is the reference for the engine-side keys.
 *
 * Hard rule: a value read here is always *used* by the consumer this file hands it
 * to. If a setting cannot be honoured on the current platform, the wiring says so
 * through `notes` rather than silently ignoring it.
 */

import { buildPrivacyPolicy } from '../security/privacy.js';

/**
 * @typedef {object} WiringResult
 * @property {string} key
 * @property {unknown} value
 * @property {string} consumedBy  Module that behaves differently because of it.
 * @property {string|null} note   Anything the user needs to know about this value.
 */

/**
 * Read a setting through the store, tolerating a plain values object so the same
 * code path works in tests and in the app bootstrap.
 * @param {import('../core/settings.js').SettingsStore|Record<string, unknown>} settings
 * @param {string} key
 * @param {unknown} fallback
 */
export function read(settings, key, fallback) {
  try {
    if (settings && typeof (/** @type {any} */ (settings).get) === 'function') {
      const value = /** @type {any} */ (settings).get(key);
      return value === undefined ? fallback : value;
    }
    const value = /** @type {Record<string, unknown>} */ (settings ?? {})[key];
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

/**
 * Options for `DiagnosticRunner`.
 * @param {import('../core/settings.js').SettingsStore|Record<string, unknown>} settings
 */
export function runnerOptions(settings) {
  return {
    timeoutMs: Number(read(settings, 'diagnostics.providerTimeoutMs', 20_000)) || 20_000,
    /** @type {WiringResult[]} */
    applied: [
      { key: 'diagnostics.providerTimeoutMs', value: read(settings, 'diagnostics.providerTimeoutMs', 20_000), consumedBy: 'src/engine/provider-registry.js', note: 'Abandoned providers are recorded with a timeout error and the chain continues.' }
    ]
  };
}

/**
 * Options for `LiveMonitor`.
 * @param {import('../core/settings.js').SettingsStore|Record<string, unknown>} settings
 */
export function monitorOptions(settings) {
  const intervalMs = Number(read(settings, 'monitoring.intervalMs', 1500)) || 1500;
  const historyPoints = Number(read(settings, 'monitoring.historyPoints', 120)) || 120;
  const keepInBackground = read(settings, 'monitoring.keepMonitoringInBackground', false) === true;
  return {
    intervalMs,
    historyPoints,
    keepInBackground,
    applied: [
      { key: 'monitoring.intervalMs', value: intervalMs, consumedBy: 'src/monitoring/monitor.js', note: null },
      { key: 'monitoring.historyPoints', value: historyPoints, consumedBy: 'src/monitoring/series.js', note: null },
      {
        key: 'monitoring.keepMonitoringInBackground',
        value: keepInBackground,
        consumedBy: 'src/monitoring/monitor.js',
        note: keepInBackground ? 'Sensors keep polling while the window is hidden, which adds a small load to the machine being measured.' : 'Polling pauses while the window is hidden so it does not disturb a benchmark.'
      }
    ]
  };
}

/**
 * Options for the disk benchmark.
 * @param {import('../core/settings.js').SettingsStore|Record<string, unknown>} settings
 */
export function diskBenchmarkOptions(settings) {
  const allowWrite = read(settings, 'benchmark.diskWriteTest', true) !== false;
  const sizeMb = Number(read(settings, 'benchmark.diskTestSizeMb', 256)) || 256;
  return {
    allowWrite,
    sizeMb,
    applied: [
      { key: 'benchmark.diskWriteTest', value: allowWrite, consumedBy: 'src/benchmarking/disk-bench.js', note: allowWrite ? null : 'The write half is disabled, so the disk benchmark runs read-only tests only.' },
      { key: 'benchmark.diskTestSizeMb', value: sizeMb, consumedBy: 'src/benchmarking/disk-bench.js', note: null }
    ]
  };
}

/**
 * Options for `StressGuard`.
 * @param {import('../core/settings.js').SettingsStore|Record<string, unknown>} settings
 */
export function stressOptions(settings) {
  const thermalLimitC = Number(read(settings, 'stress.thermalLimitC', 90)) || 90;
  const maxDurationSec = Number(read(settings, 'stress.maxDurationSec', 300)) || 300;
  const requireConsent = read(settings, 'stress.requireConsent', true) !== false;
  return {
    thermalLimitC,
    maxDurationSec,
    requireConsent,
    applied: [
      { key: 'stress.thermalLimitC', value: thermalLimitC, consumedBy: 'src/benchmarking/stress-guard.js', note: 'This is your chosen ceiling, not the processor\'s rated limit, which VERIDEX cannot read reliably.' },
      { key: 'stress.maxDurationSec', value: maxDurationSec, consumedBy: 'src/benchmarking/stress-guard.js', note: null },
      { key: 'stress.requireConsent', value: requireConsent, consumedBy: 'src/benchmarking/stress-guard.js', note: requireConsent ? null : 'The safety dialog is skipped, but the explicit Start action on the stress page is still required.' }
    ]
  };
}

/**
 * Options for `HistoryStore`.
 *
 * `diagnostics.persistHistory` is honoured by the *caller* deciding not to construct
 * a store at all, so this returns a `persist` flag as well as the store options.
 * @param {import('../core/settings.js').SettingsStore|Record<string, unknown>} settings
 */
export function historyOptions(settings) {
  const persist = read(settings, 'diagnostics.persistHistory', true) !== false;
  const limit = Number(read(settings, 'diagnostics.historyLimit', 50)) || 50;
  const pruneDays = Number(read(settings, 'storage.autoPruneDays', 0)) || 0;
  return {
    persist,
    storeOptions: { limit, pruneDays },
    applied: [
      { key: 'diagnostics.persistHistory', value: persist, consumedBy: 'src/history/store.js', note: persist ? null : 'No diagnostic history is written to disk at all.' },
      { key: 'diagnostics.historyLimit', value: limit, consumedBy: 'src/history/store.js', note: null },
      { key: 'storage.autoPruneDays', value: pruneDays, consumedBy: 'src/history/store.js', note: pruneDays === 0 ? 'Age-based pruning is off.' : `Runs older than ${pruneDays} day(s) are deleted on startup.` }
    ]
  };
}

/**
 * Options for the log.
 * @param {import('../core/settings.js').SettingsStore|Record<string, unknown>} settings
 */
export function loggerOptions(settings) {
  const level = String(read(settings, 'storage.logLevel', 'info'));
  return {
    level,
    applied: [{ key: 'storage.logLevel', value: level, consumedBy: 'src/core/logger.js', note: null }]
  };
}

/**
 * Options for report building and rendering.
 * @param {import('../core/settings.js').SettingsStore|Record<string, unknown>} settings
 */
export function reportOptions(settings) {
  const defaultFormat = String(read(settings, 'reports.defaultFormat', 'pdf'));
  const includeManualResults = read(settings, 'reports.includeManualResults', true) !== false;
  const includeCertificate = read(settings, 'reports.includeCertificate', true) !== false;
  const brandLine = String(read(settings, 'reports.brandLine', ''));
  const includeSensitive = read(settings, 'diagnostics.includeSensitiveInReport', false) === true;
  return {
    defaultFormat,
    includeManualResults,
    includeCertificate,
    brandLine,
    includeSensitive,
    applied: [
      { key: 'reports.defaultFormat', value: defaultFormat, consumedBy: 'src/app/export.js', note: null },
      { key: 'reports.includeManualResults', value: includeManualResults, consumedBy: 'src/reporting/model.js', note: includeManualResults ? null : 'Manual observations are omitted, and the manual programme summary is omitted with them.' },
      { key: 'reports.includeCertificate', value: includeCertificate, consumedBy: 'src/reporting/certificate.js', note: includeCertificate ? null : 'No inspection certificate page is generated.' },
      { key: 'reports.brandLine', value: brandLine, consumedBy: 'src/reporting/model.js', note: brandLine ? null : 'No footer note is printed.' },
      { key: 'diagnostics.includeSensitiveInReport', value: read(settings, 'diagnostics.includeSensitiveInReport', false) === true, consumedBy: 'src/security/privacy.js', note: includeSensitive ? 'Exports will contain serial numbers, addresses and account names.' : 'Identifiers are redacted from every export.' }
    ]
  };
}

/**
 * Everything the app bootstrap needs, in one call, with every applied key recorded
 * so the About screen can show the user exactly which settings are in force.
 * @param {import('../core/settings.js').SettingsStore|Record<string, unknown>} settings
 */
export function wireAll(settings) {
  const runner = runnerOptions(settings);
  const monitor = monitorOptions(settings);
  const disk = diskBenchmarkOptions(settings);
  const stress = stressOptions(settings);
  const history = historyOptions(settings);
  const logger = loggerOptions(settings);
  const report = reportOptions(settings);
  const privacy = buildPrivacyPolicy(settings);

  return {
    runner,
    monitor,
    disk,
    stress,
    history,
    logger,
    report,
    privacy,
    applied: [
      ...runner.applied,
      ...monitor.applied,
      ...disk.applied,
      ...stress.applied,
      ...history.applied,
      ...logger.applied,
      ...report.applied,
      // Guard-level keys: the values are consumed by src/security/guard.js, which is
      // constructed from the same store, so they are listed here for the About screen.
      { key: 'privacy.allowNetwork', value: privacy.allowNetwork, consumedBy: 'src/security/guard.js', note: privacy.allowNetwork ? 'Outbound requests are permitted to the allowlist only.' : 'All outbound requests are refused and logged.' },
      { key: 'diagnostics.autoQuickScan', value: read(settings, 'diagnostics.autoQuickScan', true) !== false, consumedBy: 'src/app/settings-wiring.js', note: 'Decides whether a read-only quick scan starts on launch.' }
    ]
  };
}

/**
 * Settings that change how the *interface* behaves. They are consumed in
 * `src/renderer`, which is a browser context and cannot import this module, so the
 * main process forwards the resolved values to the renderer on every change. This
 * function is the single definition of that payload.
 * @param {import('../core/settings.js').SettingsStore|Record<string, unknown>} settings
 */
export function uiPayload(settings) {
  const dashboardWidgets = read(settings, 'dashboard.widgets', []);
  return {
    theme: String(read(settings, 'appearance.theme', 'dark')),
    accent: String(read(settings, 'appearance.accent', 'cyan')),
    density: String(read(settings, 'appearance.density', 'compact')),
    language: String(read(settings, 'appearance.language', 'en')),
    reduceMotion: read(settings, 'appearance.reduceMotion', false) === true,
    showGlyphs: read(settings, 'appearance.showGlyphs', true) !== false,
    widgets: Array.isArray(dashboardWidgets) ? dashboardWidgets : [],
    greetingName: String(read(settings, 'dashboard.greetingName', '')),
    autoQuickScan: read(settings, 'diagnostics.autoQuickScan', true) !== false,
    openTo: String(read(settings, 'startup.openTo', 'dashboard')),
    checkRecovery: read(settings, 'startup.checkRecovery', true) !== false,
    firstRunComplete: read(settings, 'privacy.firstRunComplete', false) === true,
    shortcutOverrides: read(settings, 'shortcuts.overrides', {})
  };
}
