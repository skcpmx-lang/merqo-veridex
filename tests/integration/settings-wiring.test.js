/**
 * Settings must change behaviour, not just paint a switch.
 *
 * The brief's MODULE 23 rule is that no setting may exist that does not change real
 * behaviour. That is easy to claim and easy to break: a UI checkbox is added, the
 * value is stored, and nobody ever reads it. These tests fail if that happens.
 *
 * Two angles:
 *   1. every key in SETTINGS_SPEC is referenced by the module its `appliesTo` names;
 *   2. for the engine-side keys, changing the value actually produces different
 *      arguments for the consuming module — asserted by comparing wiring outputs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { SETTINGS_SPEC, defaultSettings, SettingsStore } from '../../src/core/settings.js';
import { NullLogger } from '../../src/core/logger.js';
import {
  wireAll, uiPayload, runnerOptions, monitorOptions, diskBenchmarkOptions,
  stressOptions, historyOptions, reportOptions, loggerOptions
} from '../../src/app/settings-wiring.js';
import { guardFromSettings } from '../../src/security/guard.js';
import { buildPrivacyPolicy } from '../../src/security/privacy.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

test('every setting names a consumer module that references its key', async () => {
  const cache = new Map();
  const offenders = [];

  for (const spec of SETTINGS_SPEC) {
    let source = cache.get(spec.appliesTo);
    if (source === undefined) {
      try {
        source = await readFile(path.join(ROOT, spec.appliesTo), 'utf8');
      } catch {
        offenders.push(`${spec.key}: ${spec.appliesTo} does not exist`);
        continue;
      }
      cache.set(spec.appliesTo, source);
    }
    if (!source.includes(spec.key)) {
      offenders.push(`${spec.key}: ${spec.appliesTo} never mentions the key`);
    }
  }

  assert.deepEqual(offenders, [], `decorative settings found:\n${offenders.join('\n')}`);
});

test('the wiring layer consumes every engine-side key', () => {
  const wired = wireAll(defaultSettings());
  const keys = new Set(wired.applied.map((entry) => entry.key));

  // Every setting whose behaviour lives in the main process must appear here. The first-run keys
  // are bookkeeping owned by `src/app/onboarding.js` — they record how far the tour got, and no
  // engine behaviour depends on them — so they are excluded by prefix rather than one by one.
  const mainProcessKeys = SETTINGS_SPEC.map((spec) => spec.key).filter((key) => !/^(appearance|dashboard|shortcuts|privacy\.firstRun|startup\.)/.test(key));
  const missing = mainProcessKeys.filter((key) => !keys.has(key));
  assert.deepEqual(missing, [], `these settings are never applied: ${missing.join(', ')}`);
});

test('each applied setting names the module that behaves differently because of it', () => {
  const wired = wireAll(defaultSettings());
  for (const entry of wired.applied) {
    assert.ok(entry.consumedBy.startsWith('src/'), `${entry.key} has no consumer`);
    assert.ok(entry.key in defaultSettings(), `${entry.key} is not a declared setting`);
  }
});

test('changing a monitoring setting changes the monitor arguments', () => {
  const slow = monitorOptions({ 'monitoring.intervalMs': 10000, 'monitoring.historyPoints': 60 });
  const fast = monitorOptions({ 'monitoring.intervalMs': 500, 'monitoring.historyPoints': 600 });
  assert.equal(slow.intervalMs, 10000);
  assert.equal(fast.intervalMs, 500);
  assert.equal(slow.historyPoints, 60);
  assert.equal(fast.historyPoints, 600);
  assert.notDeepEqual([slow.intervalMs, slow.historyPoints], [fast.intervalMs, fast.historyPoints]);
});

test('disabling background monitoring is reflected in the argument and explained', () => {
  const off = monitorOptions({ 'monitoring.keepMonitoringInBackground': false });
  const on = monitorOptions({ 'monitoring.keepMonitoringInBackground': true });
  assert.equal(off.keepInBackground, false);
  assert.equal(on.keepInBackground, true);
  const note = on.applied.find((entry) => entry.key === 'monitoring.keepMonitoringInBackground');
  assert.match(note.note, /adds a small load/);
});

test('disabling the disk write test really disables writes and says so', () => {
  const readOnly = diskBenchmarkOptions({ 'benchmark.diskWriteTest': false, 'benchmark.diskTestSizeMb': 128 });
  assert.equal(readOnly.allowWrite, false);
  assert.equal(readOnly.sizeMb, 128);
  const note = readOnly.applied.find((entry) => entry.key === 'benchmark.diskWriteTest');
  assert.match(note.note, /read-only/);
});

test('stress settings reach the guard with the user ceiling, not an invented one', () => {
  const stress = stressOptions({ 'stress.thermalLimitC': 78, 'stress.maxDurationSec': 120, 'stress.requireConsent': false });
  assert.equal(stress.thermalLimitC, 78);
  assert.equal(stress.maxDurationSec, 120);
  assert.equal(stress.requireConsent, false);
  const note = stress.applied.find((entry) => entry.key === 'stress.thermalLimitC');
  assert.match(note.note, /not the processor's rated limit/);
});

test('turning off history yields a persist flag of false, so no store is written', () => {
  const off = historyOptions({ 'diagnostics.persistHistory': false });
  assert.equal(off.persist, false);
  const on = historyOptions({ 'diagnostics.persistHistory': true, 'diagnostics.historyLimit': 20 });
  assert.equal(on.persist, true);
  assert.equal(on.storeOptions.limit, 20);
});

test('history limits reach the store that actually enforces them', () => {
  const options = historyOptions({ 'diagnostics.historyLimit': 12, 'storage.autoPruneDays': 30 });
  assert.equal(options.storeOptions.limit, 12);
  assert.equal(options.storeOptions.pruneDays, 30);
  const prune = options.applied.find((entry) => entry.key === 'storage.autoPruneDays');
  assert.match(prune.note, /older than 30 day/);
});

test('report settings reach the report builder', () => {
  const options = reportOptions({
    'reports.defaultFormat': 'csv',
    'reports.includeManualResults': false,
    'reports.includeCertificate': false,
    'reports.brandLine': 'MERQO Workshop, Chattogram',
    'diagnostics.includeSensitiveInReport': true
  });
  assert.equal(options.defaultFormat, 'csv');
  assert.equal(options.includeManualResults, false);
  assert.equal(options.includeCertificate, false);
  assert.equal(options.brandLine, 'MERQO Workshop, Chattogram');
  assert.equal(options.includeSensitive, true);
});

test('the network setting is the only thing that can open the outbound path', () => {
  const closed = guardFromSettings(defaultSettings());
  assert.equal(closed.networkAllowed, false);

  const opened = guardFromSettings({ 'privacy.allowNetwork': true });
  assert.equal(opened.networkAllowed, true);
  // Even opened, the allowlist still applies.
  assert.equal(opened.checkUrl('https://example.com/x').allowed, false);
});

test('the privacy policy built from a store follows the same key the export gate uses', () => {
  const store = new SettingsStore({ logger: new NullLogger() });
  const before = buildPrivacyPolicy(store);
  assert.equal(before.includeSensitive, false);
  assert.equal(before.allowNetwork, false);
});

test('a corrupt or missing settings object degrades towards privacy, not away from it', () => {
  for (const broken of [undefined, null, {}, { 'diagnostics.includeSensitiveInReport': 'yes' }]) {
    const policy = buildPrivacyPolicy(broken);
    assert.equal(policy.includeSensitive, false, `input ${JSON.stringify(broken)} must not enable sensitive export`);
    assert.equal(policy.allowNetwork, false);
  }
});

test('the UI payload carries every key the interface needs', () => {
  const payload = uiPayload({
    'appearance.theme': 'light',
    'appearance.accent': 'violet',
    'appearance.reduceMotion': true,
    'dashboard.widgets': ['health', 'cpu'],
    'startup.openTo': 'last'
  });
  assert.equal(payload.theme, 'light');
  assert.equal(payload.accent, 'violet');
  assert.equal(payload.reduceMotion, true);
  assert.deepEqual(payload.widgets, ['health', 'cpu']);
  assert.equal(payload.openTo, 'last');
});

test('an invalid value stored on disk is rejected and the default kept', async () => {
  const store = new SettingsStore({ logger: new NullLogger() });
  const result = await store.set('monitoring.intervalMs', 1);
  assert.equal(result.ok, false, 'a value below the declared minimum must be refused');
  assert.equal(store.get('monitoring.intervalMs'), 1500);

  const withinRange = await store.set('monitoring.intervalMs', 2000);
  assert.equal(withinRange.ok, true);
  assert.equal(monitorOptions(store).intervalMs, 2000, 'a valid change must reach the consumer');
});

test('every setting can store its own default, null included', async () => {
  // Found in the Windows portable-smoke log, not here: "setting rejected ... privacy.firstRunStep:
  // expected a string up to 400 characters". The tour writes null when it finishes and when it
  // is reset, and the validator refused null for every string setting - so a completed tour
  // could not clear the step it had reached. The general rule is the one asserted: a default
  // that the validator rejects is not a usable default.
  const { SETTINGS_SPEC, coerce } = await import('../../src/core/settings.js');
  const unusable = SETTINGS_SPEC.filter((spec) => !coerce(spec, spec.default).ok)
    .map((spec) => `${spec.key} (${coerce(spec, spec.default).reason})`);
  assert.deepEqual(unusable, [], `these settings reject their own default: ${unusable.join(', ')}`);
});
