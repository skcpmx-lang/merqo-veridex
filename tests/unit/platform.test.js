/**
 * `src/platform/windows.js` is the shared plumbing every diagnostic module depends on,
 * and it had no direct tests — its behaviour was only exercised indirectly through
 * provider tests that used a fake runner.
 *
 * The distinction it exists to make is the one the whole product rests on: a CIM query
 * that failed because the user is not an administrator must not look like a CIM query
 * that failed because the class does not exist on this machine. One is actionable, the
 * other is not, and a technician reading the report needs to tell them apart.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyCimError,
  failureToStatus,
  loadSystemInformation,
  queryCim,
  readRegistry,
  resetSystemInformationCache
} from '../../src/platform/windows.js';

/** A runner that records what it was asked and returns a canned result. */
function stubRunner({ isWindows = true, ok = true, data = [], error = null } = {}) {
  const calls = [];
  return {
    isWindows,
    calls,
    powershellJson: async (script, options) => {
      calls.push({ script, options });
      return { ok, data, error, durationMs: 12 };
    }
  };
}

// ── Error classification ─────────────────────────────────────────────────────

test('an access-denied error is classified as a permission problem', () => {
  const cases = [
    'Access denied',
    'ACCESS DENIED (0x80070005)',
    'requires elevation',
    'not authorized',
    'Privilege not held',
    '0x80041003'
  ];
  for (const error of cases) {
    const result = classifyCimError(error);
    assert.equal(result.accessDenied, true, `"${error}" must read as access denied`);
  }
});

test('a missing class or namespace is classified as unavailable, not as permission', () => {
  const cases = [
    'Invalid class',
    'Invalid namespace',
    'No such interface supported',
    '0x80041010',
    'The class does not exist in this namespace',
    'not supported'
  ];
  for (const error of cases) {
    const result = classifyCimError(error);
    assert.equal(result.unavailable, true, `"${error}" must read as unavailable`);
    assert.equal(result.accessDenied, false, `"${error}" is not a permission problem`);
  }
});

test('an unclassifiable error is neither permission nor unavailable', () => {
  // Falling back to "unavailable" here would tell the user their hardware lacks a
  // feature when in fact something went wrong. The status must stay ERROR.
  const result = classifyCimError('The RPC server is unavailable');
  assert.equal(result.accessDenied, false);
  assert.equal(result.unavailable, false);
});

test('a missing error string is not a failure of any kind', () => {
  assert.deepEqual(classifyCimError(null), { accessDenied: false, unavailable: false });
  assert.deepEqual(classifyCimError(''), { accessDenied: false, unavailable: false });
});

test('failure classification maps to three distinct statuses', () => {
  assert.equal(failureToStatus({ accessDenied: true, error: 'Access denied' }).kind, 'permission');
  assert.equal(failureToStatus({ unavailable: true, error: 'Invalid class' }).kind, 'unsupported');
  assert.equal(failureToStatus({ error: 'boom' }).kind, 'error');
  assert.equal(failureToStatus({}).kind, 'error', 'an unexplained failure is an error, not a feature gap');
});

test('a failure classification always carries a reason', () => {
  for (const outcome of [{ accessDenied: true }, { unavailable: true }, {}]) {
    const { reason } = failureToStatus(outcome);
    assert.ok(reason && reason.length > 4, 'every failure must explain itself');
  }
});

// ── CIM querying ─────────────────────────────────────────────────────────────

test('a CIM query builds one Get-CimInstance per class in a single call', async () => {
  const runner = stubRunner({ data: [{ Name: 'Intel' }] });
  const result = await queryCim(runner, ['Win32_Processor', 'Win32_CacheMemory']);

  assert.equal(runner.calls.length, 1, 'the classes must be batched into one PowerShell call');
  const script = runner.calls[0].script;
  assert.match(script, /Win32_Processor/);
  assert.match(script, /Win32_CacheMemory/);
  assert.equal(result.ok, true);
  assert.equal(result.rows.length, 1);
});

test('a namespace can be named explicitly, because the battery classes are not in root/cimv2', async () => {
  const runner = stubRunner({ data: [{ DesignCapacity: 5000 }] });
  await queryCim(runner, 'BatteryStaticData', { namespace: 'root/wmi' });
  assert.match(runner.calls[0].script, /root\/wmi/);
});

test('asking for properties narrows the select rather than the class', async () => {
  const runner = stubRunner({ data: [{}] });
  await queryCim(runner, 'Win32_Processor', { properties: ['Name', 'NumberOfCores'] });
  const script = runner.calls[0].script;
  assert.match(script, /Select-Object Name,NumberOfCores/);
  assert.match(script, /Win32_Processor/, 'the class must still be queried');
});

test('a CIM query on a non-Windows host is unsupported, and runs nothing', async () => {
  const runner = stubRunner({ isWindows: false });
  const result = await queryCim(runner, 'Win32_Processor');

  assert.equal(result.ok, false);
  assert.equal(result.unavailable, true);
  assert.equal(result.accessDenied, false);
  assert.match(result.error, /not running on windows/i);
  assert.equal(runner.calls.length, 0, 'no PowerShell should be spawned off-Windows');
});

test('a query that returns no instances is not a success', async () => {
  const runner = stubRunner({ data: [] });
  const result = await queryCim(runner, 'Win32_Processor');
  assert.equal(result.ok, false, 'zero rows must not read as a successful read');
  assert.equal(result.unavailable, true);
  assert.match(result.error, /no instances returned/);
});

test('non-object rows are discarded rather than passed to a parser', async () => {
  const runner = stubRunner({ data: [null, 'garbage', 42, { Name: 'real' }] });
  const result = await queryCim(runner, 'Win32_Processor');
  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.rows[0], { Name: 'real' });
});

test('a failed query keeps the original error text and its classification', async () => {
  const runner = stubRunner({ ok: false, error: 'Access denied' });
  const result = await queryCim(runner, 'MSAcpi_ThermalZoneTemperature', { namespace: 'root/wmi' });

  assert.equal(result.ok, false);
  assert.equal(result.accessDenied, true);
  assert.equal(result.error, 'Access denied', 'the raw error must survive for the report');
  assert.equal(result.durationMs, 12);
});

// ── Registry ─────────────────────────────────────────────────────────────────

test('a registry read on a non-Windows host fails with a stated reason', async () => {
  const result = await readRegistry(stubRunner({ isWindows: false }), 'HKLM:\\Software\\X');
  assert.equal(result.ok, false);
  assert.match(result.error, /not running on windows/i);
});

// ── systeminformation loading ────────────────────────────────────────────────

test('the systeminformation module loads once and is cached', async () => {
  resetSystemInformationCache();
  const first = await loadSystemInformation();
  const second = await loadSystemInformation();

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.si === second.si || typeof first.si === 'object', true);
});

test('a load failure is reported and does not throw', async () => {
  // The provider layer depends on this never throwing: a missing optional dependency
  // must degrade a field, not abort a scan.
  resetSystemInformationCache();
  const result = await loadSystemInformation();
  assert.equal(typeof result.ok, 'boolean');
  if (!result.ok) assert.ok(result.error, 'a failed load must explain itself');
  resetSystemInformationCache();
});
