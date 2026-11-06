/**
 * Cross-module consistency for the export and capability surfaces.
 *
 * Three things can silently drift here, and each drift is a lie the user would only discover at
 * the worst moment: a task that declares a capability nobody defined (so it is never permission-
 * checked), an elevated task whose capability is not declared as requiring elevation (so it
 * claims to run at standard privilege), and the export provider disagreeing with the export card
 * about whether an export is possible.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CAPABILITIES, capability, requiresAdmin } from '../../src/platform/permissions.js';
import { Status } from '../../src/core/status.js';
import { ELEVATED_TASKS, capabilityOf } from '../../src/app/elevate.js';
import { ProviderRegistry } from '../../src/engine/provider-registry.js';
import { registerDrivers } from '../../src/diagnostics/drivers.js';
import { registerBattery } from '../../src/diagnostics/battery.js';
import { registerStorage } from '../../src/diagnostics/storage.js';
import { registerWindowsHealth } from '../../src/diagnostics/windowshealth.js';
import { registerSecurity } from '../../src/diagnostics/security.js';

/** A registry with the modules that declare capabilities, and nothing that runs. */
function createRegistry() {
  const registry = new ProviderRegistry();
  for (const register of [registerDrivers, registerBattery, registerStorage, registerWindowsHealth, registerSecurity]) register(registry);
  return registry;
}

const adminCtx = { permissions: { isAdmin: true, isWindows: true, mode: 'elevated' }, runner: { run: async () => ({ ok: true, stdout: '' }) }, timeoutMs: 5000, logger: { info() {}, warn() {}, error() {} } };
const standardCtx = { permissions: { isAdmin: false, isWindows: true, mode: 'standard' }, runner: { run: async () => ({ ok: true, stdout: '' }) }, timeoutMs: 5000, logger: { info() {}, warn() {}, error() {} } };

test('every capability a task asks for is declared', () => {
  const registry = createRegistry();
  const missing = [];
  for (const task of registry.taskList()) {
    if (task.requiresCapability && !capability(task.requiresCapability)) missing.push(`${task.id} → ${task.requiresCapability}`);
  }
  assert.deepEqual(missing, [], 'a task may not require a capability that has no definition');
});

test('every elevated task is declared as requiring elevation', () => {
  const wrong = [];
  for (const [taskId, entry] of Object.entries(ELEVATED_TASKS)) {
    const declared = capabilityOf(taskId);
    if (!declared) {
      wrong.push(`${taskId} → (no capability)`);
      continue;
    }
    if (requiresAdmin(declared) !== true) wrong.push(`${taskId} → ${declared}`);
    if (entry.capability && entry.capability !== declared) wrong.push(`${taskId} → ${declared} ≠ ${entry.capability}`);
  }
  assert.deepEqual(wrong, [], 'an elevated task whose capability says "no elevation needed" contradicts itself');
});

test('the battery report capability agrees with the elevated allowlist', () => {
  const entry = CAPABILITIES['battery.report'];
  assert.equal(entry.requiresAdmin, true, 'it is in ELEVATED_TASKS, so the capability may not claim otherwise');
  assert.match(entry.reason, /standard privilege/i, 'the in-scan fallback must be stated, not implied');
});

test('driver export reports itself unavailable without elevation, and never pretends to have run', async () => {
  const registry = createRegistry();
  const provider = registry.provider('driver-export.drivers');
  const fields = await provider.collect(standardCtx);

  assert.equal(fields.exportStatus.status, Status.UNAVAILABLE);
  assert.equal(fields.exportStatus.value, null, 'no export result may be invented at standard privilege');
  assert.match(fields.exportStatus.error, /administrator/i);
  assert.equal(fields.commandTemplate.value, 'pnputil /export-driver * <folder>');
});

test('driver export reports itself ready with elevation, without exporting anything', async () => {
  const registry = createRegistry();
  const provider = registry.provider('driver-export.drivers');
  const fields = await provider.collect(adminCtx);

  assert.notEqual(fields.exportStatus.status, Status.UNAVAILABLE);
  assert.equal(typeof fields.exportStatus.value, 'string', 'the ready state is a sentence, not an export result');
  assert.doesNotMatch(String(fields.exportStatus.value), /\d+ packages exported/, 'describing an export is not performing one');
  assert.match(fields.exportStatus.value, /folder you choose/i);
  assert.match(fields.exportStatus.notes.join(' '), /only when you choose/i, 'the scan must never export on its own');
  assert.match(fields.exportStatus.notes.join(' '), /cannot reinstall/i, 'the promise must be repeated wherever export is described');
});

test('the export provider touches no runner and writes nothing', async () => {
  const registry = createRegistry();
  const provider = registry.provider('driver-export.drivers');
  let calls = 0;
  const spy = { ...adminCtx, runner: { run: async () => { calls += 1; return { ok: true, stdout: '' }; } } };
  await provider.collect(spy);
  assert.equal(calls, 0, 'describing an export must not shell out to pnputil');
});
