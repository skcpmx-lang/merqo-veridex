import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyDriverHealth, assessDriverAge, mapSignedDriver, summariseDrivers, CONFIG_MANAGER_ERRORS, DRIVER_AGE_WARNING_YEARS } from '../../src/diagnostics/drivers.js';
import { Status } from '../../src/core/status.js';

test('a working, signed device is OK and demands nothing', () => {
  const result = classifyDriverHealth({ errorCode: 0, status: 'OK', signed: true });
  assert.equal(result.health, 'OK');
  assert.equal(result.requiresUpdate, false);
  assert.equal(result.requiresReinstall, false);
});

test('missing and corrupted drivers are failures with the right remedy', () => {
  const missing = classifyDriverHealth({ errorCode: 28, status: 'Error', signed: null });
  assert.equal(missing.health, 'FAILED');
  assert.equal(missing.requiresUpdate, true);
  assert.match(missing.explanation, /no driver installed/);

  const corrupted = classifyDriverHealth({ errorCode: 39, status: 'Error', signed: null });
  assert.equal(corrupted.health, 'FAILED');
  assert.equal(corrupted.requiresReinstall, true);
});

test('a disabled device is reported as disabled, not as failed', () => {
  const disabled = classifyDriverHealth({ errorCode: 22, status: 'Error', signed: null });
  assert.equal(disabled.health, 'DISABLED');
  assert.equal(disabled.disabled, true);
  assert.match(disabled.explanation, /often deliberate/);
  assert.match(disabled.explanation, /disabled in Device Manager/);
});

test('an unsigned but working driver is a warning', () => {
  const result = classifyDriverHealth({ errorCode: 0, status: 'OK', signed: false });
  assert.equal(result.health, 'WARNING');
  assert.equal(result.requiresUpdate, true);
});

test('a device with no error code and no status is UNKNOWN, never OK', () => {
  const result = classifyDriverHealth({ errorCode: null, status: null, signed: null });
  assert.equal(result.health, 'UNKNOWN');
  assert.equal(classifyDriverHealth({ errorCode: undefined, status: 'Error', signed: null }).health, 'FAILED');
});

test('every documented Config Manager code has a human explanation', () => {
  for (const [code, text] of Object.entries(CONFIG_MANAGER_ERRORS)) {
    assert.ok(text.length > 0, `code ${code}`);
  }
  const undocumented = classifyDriverHealth({ errorCode: 88, status: 'Error', signed: true });
  assert.match(undocumented.explanation, /not in VERIDEX's documented code list/);
});

test('driver age is advisory, states its threshold, and never claims an update exists', () => {
  const old = assessDriverAge('2015-06-01', new Date('2026-11-05'));
  assert.equal(old.old, true);
  assert.ok(old.years > 11);
  assert.match(old.text, new RegExp(`${DRIVER_AGE_WARNING_YEARS} years`));
  assert.match(old.text, /not a fault/);

  assert.equal(assessDriverAge('2025-01-01', new Date('2026-11-05')).old, false);
  assert.equal(assessDriverAge(null).old, false);
  assert.equal(assessDriverAge('not-a-date').old, false);
});

test('signed driver mapping keeps provenance for each field', () => {
  const { fields, health } = mapSignedDriver({
    DeviceName: 'NVIDIA GeForce RTX 3060',
    DriverProviderName: 'NVIDIA',
    DriverVersion: '31.0.15.3623',
    DriverDate: '20230115000000.000000-000',
    DeviceClass: 'DISPLAY',
    DeviceID: 'PCI\\VEN_10DE&DEV_2504',
    IsSigned: true,
    ConfigManagerErrorCode: 0
  }, new Date('2026-11-05'));
  assert.equal(health, 'OK');
  assert.equal(fields.deviceName.value, 'NVIDIA GeForce RTX 3060');
  assert.equal(fields.driverDate.value, '2023-01-15');
  assert.equal(fields.signed.value, 'Signed');
  assert.equal(fields.deviceClass.value, 'DISPLAY');
});

test('driver summary counts states and names critical-class problems', () => {
  const summary = summariseDrivers([
    { health: 'OK', critical: true, fields: { deviceName: { value: 'Intel UHD 620' } } },
    { health: 'FAILED', critical: true, fields: { deviceName: { value: 'Intel Wi-Fi 6' } } },
    { health: 'WARNING', critical: false, fields: { deviceName: { value: 'Some peripheral' } } },
    { health: 'DISABLED', critical: false, fields: { deviceName: { value: 'Touchpad' } } }
  ]);
  assert.equal(summary.driverCount.value, 4);
  assert.equal(summary.driversOk.value, 1);
  assert.equal(summary.driversFailed.value, 1);
  assert.equal(summary.driversDisabled.value, 1);
  assert.deepEqual(summary.criticalIssues.value, ['Intel Wi-Fi 6']);
  assert.equal(summary.criticalIssues.status, Status.WARNING);
});

test('no drivers enumerated is an explicit absence', () => {
  const summary = summariseDrivers([]);
  assert.equal(summary.driverCount.status, Status.UNAVAILABLE);
  assert.deepEqual(summary.criticalIssues.value, []);
});
