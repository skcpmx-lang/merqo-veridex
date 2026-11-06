/**
 * Regression tests for the two defects that only a real Windows host exposed.
 *
 * Both were invisible to 430 passing tests for the same reason: every fixture was written
 * by someone who knew what "normal" looked like. A 0-byte device and a 21-second command
 * were simply never in the data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { measured, available, unavailable, field } from '../../src/core/field.js';
import { Status } from '../../src/core/status.js';
import { bytesToGiB, kbToGiB } from '../../src/platform/parse.js';
import { mapMemoryTotals } from '../../src/diagnostics/memory.js';
import { ProviderRegistry, DiagnosticRunner } from '../../src/engine/provider-registry.js';
import { NoopRunner } from '../../src/platform/runner.js';
import { mapVideoController } from '../../src/diagnostics/gpu.js';

test('a zero-byte measurement becomes an honest UNAVAILABLE, not a contradiction', () => {
  // `available(bytesToGiB(0))` is `available(null)`, which throws. On a real machine one
  // 0-byte device took down the entire memory task with an invariant violation.
  assert.equal(bytesToGiB(0), null, 'precondition: a zero measurement does not convert');

  const result = measured(0, bytesToGiB, 'test', { unit: 'GB', missing: 'No capacity reported' });
  assert.equal(result.status, Status.UNAVAILABLE);
  assert.equal(result.value, null);
  assert.equal(result.error, 'No capacity reported');
  assert.equal(result.unit, 'GB');
});

test('measured() passes a real value through with its unit intact', () => {
  const result = measured(16 * 1024 ** 3, bytesToGiB, 'test', { unit: 'GB' });
  assert.equal(result.status, Status.PASS);
  assert.equal(result.value, 16);
  assert.equal(result.unit, 'GB');
});

test('measured() treats a non-finite conversion as absent rather than as a number', () => {
  for (const input of [null, undefined, 'not a number', NaN, Infinity]) {
    const result = measured(input, bytesToGiB, 'test', { missing: 'absent' });
    assert.equal(result.status, Status.UNAVAILABLE, `${String(input)} must not claim a value`);
    assert.equal(result.value, null);
  }
});

test('a machine reporting zero physical memory produces no invariant violation', () => {
  // The real failure: a runner whose memory counters all read 0.
  const fields = mapMemoryTotals({ total: 0, used: 0, available: 0, active: 0 });
  for (const [key, value] of Object.entries(fields)) {
    assert.notEqual(value.status, Status.PASS, `${key} claims a value at zero`);
    assert.ok(value.error, `${key} must explain why it has no value`);
  }
});

test('a machine reporting real memory still produces real numbers', () => {
  const fields = mapMemoryTotals({ total: 16 * 1024 ** 3, used: 8 * 1024 ** 3, available: 8 * 1024 ** 3 });
  assert.equal(fields.totalPhysical.value, 16);
  assert.equal(fields.usedMemory.value, 8);
  assert.equal(fields.utilization.value, 50);
});

test('a video controller with zero AdapterRAM does not take down the GPU task', () => {
  // AdapterRAM is a uint32 that overflows above 4 GB, so a broken adapter reports 0.
  const fields = mapVideoController({ Name: 'Test Adapter', AdapterRAM: 0, DriverVersion: '1.0' });
  assert.ok(fields, 'mapping must return fields rather than throw');
  const vram = fields.dedicatedVram;
  assert.notEqual(vram.status, Status.PASS, 'a zero VRAM reading must not be presented as a value');
  assert.ok(vram.error, 'the absence must be explained');
});

test('the field invariant still rejects a hand-built contradiction', () => {
  // The guard is right; the callers were wrong. Keep the guard.
  assert.throws(() => available(null, 'test'), /invariant violated/);
  assert.throws(() => field(undefined, { status: Status.WARNING }), /invariant violated/);
});

test('a provider that declares its own budget gets it; others keep the default', async () => {
  // The defect: `system-features.windows` asked its three sub-commands for 60 s and 30 s,
  // but the runner raced the whole collect() against a flat 20 s, so on a real machine it
  // was killed and reported ERROR. A provider may now declare a larger budget.
  const seen = new Map();
  const built = buildRunner({
    defaultTimeoutMs: 1_000,
    providers: [
      { id: 'declared', timeoutMs: 7_500 },
      { id: 'undeclared' }
    ]
  });
  for (const provider of built.registry.providers.values()) {
    const original = provider.collect;
    provider.collect = async (ctx) => {
      seen.set(provider.id, ctx.timeoutMs);
      return original(ctx);
    };
  }

  await built.runner.runTask('t.declared');
  await built.runner.runTask('t.undeclared');

  assert.equal(seen.get('declared'), 7_500, 'a declared budget must reach the provider');
  assert.equal(seen.get('undeclared'), 1_000, 'the default must still apply to everyone else');
});

test('a provider that hangs is still killed at its declared budget', async () => {
  // The budget is a ceiling, not an exemption from one.
  //
  // The elapsed-time assertion is deliberately loose. A first version demanded the cut-off
  // land "near 120 ms" and failed at 4.8 s on a loaded CI runner, where a queue of test
  // files starves the event loop. A timer that fires late is not a broken timeout; asserting
  // on wall-clock precision tests the machine, not the product. What matters is that the
  // provider is stopped at its own declared budget rather than the much larger default.
  const built = buildRunner({
    defaultTimeoutMs: 30_000,
    providers: [{ id: 'hangs', timeoutMs: 250, collect: () => new Promise(() => {}) }]
  });
  // The budget timer is unref'd, so a hanging provider cannot keep a process alive on its
  // own - correct for the app, but it means an idle test process would exit before the
  // timer fires. Hold the loop open explicitly rather than removing the unref.
  const keepAlive = setTimeout(() => {}, 30_000);
  const started = Date.now();
  const result = await built.runner.runTask('t.hangs');
  const elapsed = Date.now() - started;
  clearTimeout(keepAlive);

  assert.match(JSON.stringify(result.attempts), /exceeded its 250ms budget/, 'the cut-off must name the declared budget');
  assert.ok(elapsed < 20_000, `must be cut off well before the 30s default, took ${elapsed}ms`);
});

/**
 * Build a runner over generated providers. `timeoutMs` on a provider is only present when
 * the test wants to exercise the declared-budget path.
 */
function buildRunner({ defaultTimeoutMs, providers }) {
  const registry = new ProviderRegistry();
  for (const spec of providers) {
    const definition = {
      id: spec.id,
      title: spec.id,
      collect: spec.collect ?? (async () => ({ [`value_${spec.id}`]: available(1, spec.id) }))
    };
    if (spec.timeoutMs !== undefined) definition.timeoutMs = spec.timeoutMs;
    registry.registerProvider(definition);
    registry.registerTask({ id: `t.${spec.id}`, module: 'm', providers: [spec.id], quick: true });
  }
  const runner = new DiagnosticRunner({
    registry,
    permissions: { mode: 'standard', isAdmin: false, isWindows: true, detail: 'test' },
    logger: null,
    runner: new NoopRunner(),
    timeoutMs: defaultTimeoutMs
  });
  return { registry, runner };
}
