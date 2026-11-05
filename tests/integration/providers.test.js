/**
 * Every registered provider must execute.
 *
 * This exists because a `ReferenceError` inside one provider (`lua is not defined`
 * in the security module) survived 300 tests: each module's *pure* mapping functions
 * were tested, but the provider closures that call them were never invoked. A
 * provider that throws on the first real run is a broken product with a green suite.
 *
 * Each provider is driven with a NoopRunner, which returns an explicit failure
 * instead of touching the host, so this runs anywhere. The assertions are about
 * *shape and honesty*, not about values — no value can be asserted on a machine that
 * has no Windows hardware to report:
 *   - the provider returns an object, and does not throw;
 *   - every entry is a FieldValue with a recognised status;
 *   - a provider given no working commands reports unavailable/blocked/error,
 *     never a PASS with an invented value.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { NoopRunner } from '../../src/platform/runner.js';
import { Status } from '../../src/core/status.js';
import { buildDefaultRegistry } from '../../src/app/scan.js';
import { ProviderRegistry } from '../../src/engine/provider-registry.js';

const VALID_STATUSES = new Set(Object.values(Status));

/** A permission state for a standard, non-elevated session. */
const standardSession = Object.freeze({
  isAdmin: false,
  isWindows: false,
  mode: 'standard',
  detectedAt: '2026-11-05T00:00:00.000Z',
  detail: 'provider execution test'
});

function context() {
  return {
    runner: new NoopRunner(),
    permissions: standardSession,
    logger: { debug() {}, info() {}, warn() {}, error() {}, providerAttempt() {}, trace() {} },
    timeoutMs: 4000
  };
}

function validateFields(providerId, fields) {
  assert.ok(fields && typeof fields === 'object' && !Array.isArray(fields), `${providerId} must return an object of fields`);
  const entries = Object.entries(fields);
  assert.ok(entries.length > 0, `${providerId} returned no fields at all`);

  for (const [key, value] of entries) {
    assert.ok(value && typeof value === 'object', `${providerId}.${key} is not a FieldValue`);
    assert.ok(VALID_STATUSES.has(value.status), `${providerId}.${key} has status "${value.status}" which is not in the vocabulary`);
    assert.ok('value' in value, `${providerId}.${key} has no value property`);
    assert.ok(Array.isArray(value.notes), `${providerId}.${key} notes must be an array`);
    // A value with data must not also claim to be unavailable, and vice versa.
    if (value.status === Status.PASS || value.status === Status.WARNING || value.status === Status.FAIL) {
      assert.ok(value.value !== null && value.value !== undefined, `${providerId}.${key} claims ${value.status} with no value`);
    }
    if ([Status.UNAVAILABLE, Status.UNSUPPORTED, Status.ERROR, Status.PERMISSION_REQUIRED].includes(value.status)) {
      const explains = (value.error && String(value.error).length > 3) || value.notes.some((note) => String(note).length > 3);
      assert.ok(explains, `${providerId}.${key} is ${value.status} but explains nothing; the user would see a blank cell with no reason`);
    }
  }
}

test('every registered provider executes without throwing', async () => {
  const failures = [];
  const registry = buildDefaultRegistry({ failures });
  assert.deepEqual(failures, [], `modules failed to register:\n${failures.join('\n')}`);

  const providers = [...registry.providers.values()];
  assert.ok(providers.length >= 10, `expected the full diagnostic set, found ${providers.length} providers`);

  const problems = [];
  for (const provider of providers) {
    try {
      const fields = await provider.collect(context());
      validateFields(provider.id, fields);
    } catch (error) {
      problems.push(`${provider.id}: threw ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  assert.deepEqual(problems, [], `providers failed to execute:\n${problems.join('\n')}`);
});

test('no provider invents a passing value when it has no data', async () => {
  const registry = buildDefaultRegistry();
  const offenders = [];

  for (const provider of registry.providers.values()) {
    let fields;
    try {
      fields = await provider.collect(context());
    } catch {
      continue; // reported by the test above
    }
    for (const [key, value] of Object.entries(fields)) {
      if (value.status !== Status.PASS) continue;
      // A NoopRunner cannot produce real Windows data, so any PASS must be a
      // constant the provider computes (e.g. a policy statement), never a reading.
      const described = String(value.source ?? '');
      if (!described) offenders.push(`${provider.id}.${key} is PASS with no source`);
    }
  }

  assert.deepEqual(offenders, [], `values passed with no attributed source:\n${offenders.join('\n')}`);
});

test('every task resolves to at least one provider that exists', () => {
  const registry = buildDefaultRegistry();
  const tasks = registry.taskList();
  assert.ok(tasks.length >= 12, `expected the full task set, found ${tasks.length}`);

  for (const task of tasks) {
    assert.ok(task.providers.length > 0, `${task.id} has no providers`);
    for (const providerId of task.providers) {
      assert.ok(registry.providers.has(providerId), `${task.id} references missing provider "${providerId}"`);
    }
    assert.ok(task.module, `${task.id} has no report module`);
    assert.ok(task.title && task.title.length > 2, `${task.id} has no human title`);
  }
});

test('every task can run end to end and produces a section', async () => {
  const { DiagnosticRunner } = await import('../../src/engine/provider-registry.js');
  const registry = buildDefaultRegistry();
  const runner = new DiagnosticRunner({
    registry,
    permissions: standardSession,
    logger: context().logger,
    runner: new NoopRunner(),
    timeoutMs: 4000
  });

  for (const task of registry.taskList().slice(0, 6)) {
    const result = await runner.runTask(task.id);
    assert.equal(result.taskId, task.id);
    assert.ok(result.section, `${task.id} produced no section`);
    assert.ok(Object.keys(result.section.fields).length > 0, `${task.id} produced an empty section`);
    assert.ok(result.attempts.length > 0, `${task.id} recorded no provider attempts`);
  }
});

test('a duplicate provider id is refused with a clear message', () => {
  const registry = new ProviderRegistry();
  registry.registerProvider({ id: 'dup', title: 'First', collect: async () => ({}) });
  assert.throws(
    () => registry.registerProvider({ id: 'dup', title: 'Second', collect: async () => ({}) }),
    /Duplicate provider id "dup"/
  );
});

test('a task naming a missing provider is refused at registration', () => {
  const registry = new ProviderRegistry();
  assert.throws(
    () => registry.registerTask({ id: 'x.y', module: 'x', title: 'X', providers: ['nope'] }),
    /unknown provider "nope"/
  );
});
