/**
 * What the providers actually invoke.
 *
 * Every other test in this suite supplies parsed output, so the argv and the PowerShell text
 * are never examined. That is how two defects survived 441 passing tests:
 *
 *   - `runReadOnly(runner, 'directx-dxdiag.gpu', ...)` passed a provider id as the program
 *     name, so dxdiag could never run and the failure was reported as a GPU fault;
 *   - a script contained `(try { ... } catch { ... })`, which is not a valid PowerShell
 *     expression, so the storage reliability probe failed on every machine.
 *
 * These tests drive the real providers with a recording runner and assert on what they send.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { CommandRunner } from '../../src/platform/runner.js';
import { registerStorage } from '../../src/diagnostics/storage.js';
import { registerGpu } from '../../src/diagnostics/gpu.js';
import { ProviderRegistry } from '../../src/engine/provider-registry.js';
import { readFileSync } from 'node:fs';

/**
 * A spawn stand-in that records argv and replays a canned result.
 * @param {{stdout?: string, code?: number}} [response]
 */
function makeSpawn(response = {}) {
  const calls = [];
  const spawnFn = (file, args) => {
    calls.push({ file, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.end(response.stdout ?? '');
      child.stderr.end('');
      child.emit('close', response.code ?? 0);
    });
    return child;
  };
  return { calls, spawnFn };
}

const windowsPermissions = Object.freeze({ mode: 'standard', isAdmin: false, isWindows: true, detail: 'test double' });

test('dxdiag is invoked as dxdiag, not as a provider id', async () => {
  const { calls, spawnFn } = makeSpawn({ stdout: '' });
  const runner = new CommandRunner({ platform: 'win32', spawnFn });
  const registry = new ProviderRegistry();
  registerGpu(registry);

  await registry.provider('directx-dxdiag.gpu').collect({ runner, permissions: windowsPermissions, logger: null, timeoutMs: 5_000 });

  const invocation = calls.find((call) => call.file.includes('dxdiag'));
  assert.ok(invocation, `dxdiag was never spawned; calls were ${JSON.stringify(calls.map((c) => c.file))}`);
  assert.match(invocation.file, /dxdiag(\.exe)?$/i);

  for (const call of calls) {
    assert.doesNotMatch(
      call.file,
      /^[a-z0-9-]+\.[a-z0-9-]+$/i,
      `"${call.file}" looks like a provider id passed as an executable`
    );
  }
});

test('no provider passes an id-shaped string as the program to run', async () => {
  // A general guard: a program name is a file, never a dotted identifier like `gpu.info`.
  const { calls, spawnFn } = makeSpawn({ stdout: '' });
  const runner = new CommandRunner({ platform: 'win32', spawnFn });
  const registry = new ProviderRegistry();
  registerStorage(registry);
  registerGpu(registry);

  const elevated = { ...windowsPermissions, isAdmin: true, mode: 'elevated' };
  for (const provider of registry.providers.values()) {
    await provider.collect({ runner, permissions: elevated, logger: null, timeoutMs: 2_000 }).catch(() => ({}));
  }

  const idShaped = calls.filter((call) => /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(call.file) && !/\.(exe|com|bat|cmd|ps1)$/i.test(call.file));
  assert.deepEqual(idShaped, [], `these invocations used an identifier as a program: ${JSON.stringify(idShaped)}`);
});

test('the storage reliability script uses no `(try { ... })` expression', async () => {
  // PowerShell has no try-expression; the runner also wraps the body in @(...), so a
  // parenthesised try block makes the whole script a parse error. The provider only runs
  // when elevated, which is why no unprivileged test had ever reached the script.
  const { calls, spawnFn } = makeSpawn({ stdout: JSON.stringify({ ok: true, error: null, data: [] }) });
  const runner = new CommandRunner({ platform: 'win32', spawnFn });
  const registry = new ProviderRegistry();
  registerStorage(registry);

  const elevated = { ...windowsPermissions, isAdmin: true, mode: 'elevated' };
  await registry.provider('ata-smart.storage').collect({ runner, permissions: elevated, logger: null, timeoutMs: 5_000 });

  const script = calls.map((call) => call.args.join(' ')).join('\n');
  assert.match(script, /Get-StorageReliabilityCounter/, 'precondition: the probe still reads reliability counters');
  assert.doesNotMatch(script, /\(\s*try\s*\{/, 'a parenthesised try block is a PowerShell parse error');
});

test('an unprivileged run refuses the privileged probes instead of invoking them', async () => {
  // The counterpart to the test above: the gate must come before the command, not after.
  const { calls, spawnFn } = makeSpawn({ stdout: '{}' });
  const runner = new CommandRunner({ platform: 'win32', spawnFn });
  const registry = new ProviderRegistry();
  registerStorage(registry);

  const fields = await registry.provider('ata-smart.storage').collect({ runner, permissions: windowsPermissions, logger: null, timeoutMs: 2_000 });
  assert.deepEqual(calls, [], 'a standard session must not run the SMART probe at all');
  assert.equal(fields.smart.status, 'PERMISSION_REQUIRED');
  assert.ok(fields.smart.error, 'the refusal must say why');
});

test('every registered provider builds a plausible command line', async () => {
  // Nothing here asserts on output quality - only that what reaches spawn() could run.
  const { calls, spawnFn } = makeSpawn({ stdout: '{"ok":true,"error":null,"data":[]}' });
  const runner = new CommandRunner({ platform: 'win32', spawnFn });
  const registry = new ProviderRegistry();
  registerStorage(registry);
  registerGpu(registry);

  const elevated = { ...windowsPermissions, isAdmin: true, mode: 'elevated' };
  for (const provider of registry.providers.values()) {
    calls.length = 0;
    await provider.collect({ runner, permissions: elevated, logger: null, timeoutMs: 2_000 }).catch(() => ({}));
    for (const call of calls) {
      assert.ok(call.file && call.file.trim().length > 0, `${provider.id} spawned an empty program name`);
      assert.ok(Array.isArray(call.args), `${provider.id} spawned with non-array args`);
      assert.ok(!call.file.includes(' '), `${provider.id} spawned "${call.file}" — a path with spaces must be quoted by the caller, not embedded`);
    }
  }
});

test('a failed tool invocation carries the tool\'s own words, not just an exit code', async () => {
  // On a real image dxdiag failed with exit 127 and no explanation, because the runner
  // reports the exit code and drops nothing else. "Exit 127" cannot tell a missing program
  // from a broken GPU; the tool's stderr usually can.
  const registry = new ProviderRegistry();
  registerGpu(registry);

  const { spawnFn } = makeSpawn({ stdout: '', code: 127 });
  const failing = new CommandRunner({ platform: 'win32', spawnFn });
  const fields = await registry.provider('directx-dxdiag.gpu').collect({
    runner: failing,
    permissions: windowsPermissions,
    logger: null,
    timeoutMs: 5_000
  });

  // Silent failure: the method could not be used here. Not a GPU fault, and not proof the
  // tool is absent - on the runner dxdiag.exe exists and still will not execute.
  assert.equal(fields.directxVersion.status, 'UNSUPPORTED');
  assert.match(fields.directxVersion.error, /could not be run on this installation/);
  assert.match(fields.directxVersion.error, /exit 127/);
});

test('a tool that fails with output says what it said — every provider that runs one', async () => {
  // This branch had never executed in CI: with a NoopRunner the providers bail out earlier
  // (non-Windows, or unprivileged), so a missing import inside it survived 448 passing tests
  // and only surfaced on a real Windows host.
  const { registerBattery } = await import('../../src/diagnostics/battery.js');
  const { registerSecurity } = await import('../../src/diagnostics/security.js');
  // The tool's stderr is what must reach the user, so make the spawn helper emit it.
  const runner = new CommandRunner({
    platform: 'win32',
    spawnFn: (file, args) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      setImmediate(() => {
        child.stdout.end('');
        child.stderr.end(`${file} is not available on this system`);
        child.emit('close', 5);
      });
      return child;
    }
  });

  const registry = new ProviderRegistry();
  registerBattery(registry);
  registerSecurity(registry);

  const elevated = { ...windowsPermissions, isAdmin: true, mode: 'elevated' };
  const results = [];
  for (const [id, provider] of registry.providers) {
    const fields = await provider.collect({ runner, permissions: elevated, logger: null, timeoutMs: 3_000 });
    results.push([id, fields]);
  }

  const errored = results.flatMap(([id, fields]) => Object.entries(fields ?? {})
    .filter(([, value]) => value?.status === 'ERROR')
    .map(([key, value]) => ({ id, key, error: value.error })));

  assert.ok(errored.length > 0, 'precondition: at least one provider reports an ERROR for a failing tool');
  for (const entry of errored) {
    assert.ok(entry.error && entry.error.length > 10, `${entry.id}.${entry.key} reports ERROR with no explanation`);
    assert.match(entry.error, /not available on this system/, `${entry.id}.${entry.key} dropped the tool's own words`);
  }
});

test('a machine with no battery is NOT_APPLICABLE, not ERROR', async () => {
  // Observed on a real Windows host: a runner with no battery reported
  //   battery.designCapacity: ERROR — powercfg /batteryreport did not complete (exit 1)
  //   "Unable to perform operation: The system cannot find the file specified."
  // A tool failing because there is nothing to report is not a fault in the machine.
  const { registerBattery } = await import('../../src/diagnostics/battery.js');
  const registry = new ProviderRegistry();
  registerBattery(registry);

  const runner = new CommandRunner({ platform: 'win32', spawnFn: makeSpawn({ stdout: '', code: 1 }).spawnFn });
  const provider = registry.provider('powercfg-report.battery');

  // systeminformation is a real dependency here; it reports hasBattery=false on this host
  // only if a battery exists, so drive the branch by checking whichever answer it gives.
  const fields = await provider.collect({ runner, permissions: windowsPermissions, logger: null, timeoutMs: 5_000 });
  assert.notEqual(fields.designCapacity.status, 'PASS');
  assert.ok(fields.designCapacity.error || fields.designCapacity.notes.length > 0, 'the answer must be explained');
  assert.notEqual(fields.designCapacity.status, 'ERROR', 'a failed powercfg is an absence of evidence, not a machine fault');
});

test('the battery applicability gate is actually called by the provider', async () => {
  // It was exported, unit-tested and invoked by nobody, so a desktop still walked the rest
  // of the provider chain and collected errors from sources that could never answer.
  const { registerBattery } = await import('../../src/diagnostics/battery.js');
  const source = readFileSync(new URL('../../src/diagnostics/battery.js', import.meta.url), 'utf8');
  assert.ok(source.includes('batteryApplicability({'), 'the gate must be invoked somewhere, not merely defined');
});

test('a failed manage-bde is unknown, not a security fault', async () => {
  // A real host returned exit 2147942487 with a clean banner and no volume rows. The field
  // said ERROR, which reads as "something is wrong with this machine". The truthful answer
  // is that the BitLocker state could not be read.
  const { registerSecurity } = await import('../../src/diagnostics/security.js');
  const registry = new ProviderRegistry();
  registerSecurity(registry);

  const runner = new CommandRunner({
    platform: 'win32',
    spawnFn: (file, args) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      setImmediate(() => {
        child.stdout.end('');
        child.stderr.end('BitLocker Drive Encryption: Configuration Tool version 10.0.26100');
        child.emit('close', 2147942487);
      });
      return child;
    }
  });

  const elevated = { ...windowsPermissions, isAdmin: true, mode: 'elevated' };
  const fields = await registry.provider('cim-win32.security').collect({ runner, permissions: elevated, logger: null, timeoutMs: 5_000 });

  assert.ok(fields.bitlocker, 'the BitLocker answer must exist');
  assert.notEqual(fields.bitlocker.status, 'ERROR', 'an unreadable tool is not a machine fault');
  assert.match(fields.bitlocker.error ?? '', /exited|unknown|could not/i, 'the answer must explain itself');
});

test('manage-bde output with no volume table is reported as unknown, not as zero volumes', async () => {
  const { mapBitlocker } = await import('../../src/diagnostics/security.js');
  // A header with no rows: no volume is reported, so the encryption state is unknown.
  const fields = mapBitlocker('Volume,Conversion Status,Protection Status\n', true);
  assert.notEqual(fields.bitlocker.status, 'PASS');
  assert.match(fields.bitlocker.error, /no volume rows|no parseable volume table/i);

  // Output that is not a table at all - the shape a banner-only failure produces.
  const garbage = mapBitlocker('BitLocker Drive Encryption: Configuration Tool version 10.0.26100', true);
  assert.notEqual(garbage.bitlocker.status, 'PASS');
  assert.match(garbage.bitlocker.error, /no volume rows/i);

  // A real table still parses.
  const real = mapBitlocker('Volume,Conversion Status,Protection Status\nC:,Fully Decrypted,Protection Off\n', true);
  assert.equal(real.bitlockerVolumeCount.value, 1);
});

test('a tool that runs and fails is an ERROR; one that cannot run is UNSUPPORTED', async () => {
  const { registerGpu } = await import('../../src/diagnostics/gpu.js');
  const registry = new ProviderRegistry();
  registerGpu(registry);

  const withOutput = new CommandRunner({
    platform: 'win32',
    spawnFn: (file, args) => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      setImmediate(() => {
        child.stdout.end('');
        child.stderr.end('Access is denied.');
        child.emit('close', 5);
      });
      return child;
    }
  });

  const fields = await registry.provider('directx-dxdiag.gpu').collect({
    runner: withOutput,
    permissions: windowsPermissions,
    logger: null,
    timeoutMs: 5_000
  });

  assert.equal(fields.directxVersion.status, 'ERROR', 'a tool that spoke and failed is an error');
  assert.match(fields.directxVersion.error, /Access is denied/);
});

test('one slow sub-query must not cost the whole Windows inventory', async () => {
  // On a real runner `Get-WindowsOptionalFeature -Online` exceeded 90 s and the provider's
  // budget killed the entire task, discarding services and hotfix data that had been ready
  // in seconds. A slow field must cost only itself.
  const { registerWindows } = await import('../../src/diagnostics/windows.js');
  const registry = new ProviderRegistry();
  registerWindows(registry);

  let featuresTimeout = null;
  const runner = new CommandRunner({
    platform: 'win32',
    spawnFn: (file, args) => {
      const script = args.join(' ');
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => {};
      if (/WindowsOptionalFeature/.test(script)) {
        featuresTimeout = true;
        setImmediate(() => child.emit('close', -1)); // a timeout, as the runner reports it
        return child;
      }
      setImmediate(() => {
        child.stdout.end('{"ok":true,"error":null,"data":[]}');
        child.stderr.end('');
        child.emit('close', 0);
      });
      return child;
    }
  });

  const elevated = { ...windowsPermissions, isAdmin: true, mode: 'elevated' };
  const fields = await registry.provider('system-features.windows').collect({
    runner,
    permissions: elevated,
    logger: null,
    timeoutMs: 5_000
  });

  assert.ok(featuresTimeout, 'precondition: the optional-feature query was attempted');
  assert.ok(fields.windowsFeatures, 'the slow field must still produce an answer');
  assert.notEqual(fields.windowsFeatures.status, 'PASS', 'it must not claim data it does not have');
  assert.notEqual(fields.windowsFeatures.status, 'ERROR', 'a slow query is not a fault');
  assert.ok(fields.servicesSummary, 'the fast queries must survive the slow one');
  assert.ok(fields.updates, 'the fast queries must survive the slow one');
});
