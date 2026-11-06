/**
 * The elevated helper.
 *
 * Elevation is the one part of this application that can affect a machine beyond reading it, so
 * the tests here are mostly about refusal: refusing an unknown task, refusing a destination that
 * is a system folder, refusing an argument containing a quote, and reporting a declined UAC
 * prompt as a decline rather than as a failure or — worse — as a success.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ELEVATED_TASKS,
  UAC_CANCELLED,
  isElevatedTask,
  validateDestination,
  buildElevationScript,
  interpretElevationOutcome,
  capabilityOf
} from '../../src/app/elevate.js';

// ── The allowlist ──────────────────────────────────────────────────────────

test('only named tasks exist, and every one of them is read-only or explicitly consented', () => {
  const ids = Object.keys(ELEVATED_TASKS);
  assert.deepEqual(ids.sort(), ['battery.report', 'drivers.export', 'windows.componentHealth']);

  for (const [id, task] of Object.entries(ELEVATED_TASKS)) {
    assert.ok(task.title.length > 10, `${id} needs a title a user can read`);
    assert.ok(task.reason.length > 20, `${id} needs a reason for existing`);
    assert.ok(task.timeoutMs >= 60_000, `${id} needs a timeout`);
    assert.ok(capabilityOf(id), `${id} must map to a permission capability`);
  }

  assert.equal(isElevatedTask('shell.exec'), false);
  assert.equal(isElevatedTask('drivers.export'), true);
  assert.equal(isElevatedTask('constructor'), false, 'prototype keys are not tasks');
});

test('the component-store task carries no repair switch', () => {
  const args = ELEVATED_TASKS['windows.componentHealth'].args({});
  assert.deepEqual(args, ['/Online', '/Cleanup-Image', '/CheckHealth']);
  for (const forbidden of ['/RestoreHealth', '/ScanHealth', '/StartComponentCleanup']) {
    assert.ok(!args.includes(forbidden), `${forbidden} modifies the store and must not be here`);
  }
});

// ── Destination validation ─────────────────────────────────────────────────

test('a destination must be absolute, sane and not a system folder', () => {
  assert.equal(validateDestination('D:\\DriverBackup').ok, true);
  assert.equal(validateDestination('\\\\NAS\\share\\drivers').ok, true);

  for (const bad of ['', '   ', 'drivers', 'C:drivers', null, 42, 'D:\\a\u0000b']) {
    assert.equal(validateDestination(bad).ok, false, `${JSON.stringify(bad)} must be refused`);
  }

  for (const forbidden of ['C:\\Windows', 'c:\\windows', 'C:\\Windows\\System32', 'C:\\Program Files', 'C:\\ProgramData', 'C:\\Users']) {
    const result = validateDestination(forbidden);
    assert.equal(result.ok, false, `${forbidden} must be refused`);
    assert.match(result.reason, /system folder|your own/i);
  }

  assert.equal(validateDestination('C:\\Backups\\..\\Windows').ok, false, 'a traversal must be refused');
  assert.equal(validateDestination(`C:\\${'a'.repeat(300)}`).ok, false, 'an absurd path must be refused');
});

// ── Script construction ────────────────────────────────────────────────────

test('the elevation script refuses an unknown task and an unsafe argument', () => {
  assert.equal(buildElevationScript({ taskId: 'shell.exec', appPath: 'C:\\app.exe', resultPath: 'C:\\r.json' }).ok, false);
  assert.equal(buildElevationScript({ taskId: 'drivers.export', appPath: '', resultPath: 'C:\\r.json' }).ok, false);
  assert.equal(buildElevationScript({ taskId: 'drivers.export', appPath: 'C:\\app.exe', resultPath: '' }).ok, false);

  // A quote in the destination would end the PowerShell literal. It is refused, not escaped.
  const quoted = buildElevationScript({
    taskId: 'drivers.export',
    appPath: 'C:\\app.exe',
    params: { destination: 'D:\\bad"; Remove-Item C:\\ -Recurse' },
    resultPath: 'C:\\r.json'
  });
  assert.equal(quoted.ok, false);
  assert.match(quoted.reason, /unsafe character/);
});

test('arguments reach Start-Process as an array, never as a concatenated string', () => {
  const built = buildElevationScript({
    taskId: 'drivers.export',
    appPath: 'C:\\Program Files\\VERIDEX\\VERIDEX.exe',
    params: { destination: 'D:\\Driver Backup' },
    resultPath: 'C:\\Temp\\veridex-result.json'
  });
  assert.equal(built.ok, true);

  assert.match(built.script, /\$argumentList = @\('\/export-driver','\*','D:\\Driver Backup'\)/, 'the arguments must be an array of quoted literals');
  assert.match(built.script, /-Verb RunAs/, 'UAC is raised by RunAs');
  assert.match(built.script, /-Wait/, 'the parent must wait so it can read the exit code');
  assert.match(built.script, /-PassThru/, 'the exit code is only visible through PassThru');
  assert.match(built.script, new RegExp(String(UAC_CANCELLED)), 'a dismissed prompt must be recognised');
  assert.match(built.script, /pnputil\.exe/);
  assert.ok(!/iex|Invoke-Expression|cmd \/c/i.test(built.script), 'nothing may evaluate a string');
});

test('the battery report task writes to the path it is given, and only that path', () => {
  const built = buildElevationScript({
    taskId: 'battery.report',
    appPath: 'C:\\app.exe',
    params: { outputPath: 'C:\\Users\\demo\\AppData\\Local\\Temp\\battery.html' },
    resultPath: 'C:\\Temp\\r.json'
  });
  assert.equal(built.ok, true);
  assert.match(built.script, /powercfg\.exe/);
  assert.match(built.script, /\/batteryreport/);
  assert.ok(!/\/output.*\/output/.test(built.script), 'the output path appears once');
});

// ── Interpreting the outcome ───────────────────────────────────────────────

test('a declined UAC prompt is a decline, not a failure and never a success', () => {
  const outcome = interpretElevationOutcome({ code: UAC_CANCELLED });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.cancelled, true);
  assert.match(outcome.reason, /declined/i);
  assert.match(outcome.reason, /continues at standard privilege/i);
});

test('every other outcome is classified distinctly', () => {
  assert.equal(interpretElevationOutcome({ code: 0, result: { items: [] } }).ok, true);
  assert.equal(interpretElevationOutcome({ code: 1, result: { message: 'The driver store is read-only.' } }).ok, false);
  assert.match(interpretElevationOutcome({ code: 1, result: { message: 'The driver store is read-only.' } }).reason, /read-only/);
  assert.equal(interpretElevationOutcome({ code: 0 }).ok, false, 'a zero exit with no result proves nothing');
  assert.match(interpretElevationOutcome({ code: 0 }).reason, /no result/i);
  assert.equal(interpretElevationOutcome({ code: null, timedOut: true }).ok, false);
  assert.match(interpretElevationOutcome({ code: null, timedOut: true }).reason, /time limit/i);
  assert.equal(interpretElevationOutcome({ code: undefined }).ok, false);
  assert.equal(interpretElevationOutcome(null).ok, false);
});

test('a failed task carries the tool\'s own words, truncated', () => {
  const outcome = interpretElevationOutcome({ code: 5, result: { message: 'x'.repeat(500) } });
  assert.equal(outcome.ok, false);
  assert.ok(outcome.reason.length < 260, 'a tool message must not become the log');
  assert.match(outcome.reason, /code 5/);
});
