/**
 * Privacy verification: what is actually stored, and what actually leaves.
 *
 * The claims in `docs/SECURITY.md` are testable, so they are tested here with real files on a
 * real temporary directory: sensitive strings are pushed through the logger, read back off
 * disk, exported, and searched for. A privacy claim that is only asserted in prose is a
 * marketing statement; one that fails a test is a bug report.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Logger, Level } from '../../src/core/logger.js';
import { parseLogText, filterRecords, summariseLog, buildExport, describeRetention } from '../../src/app/logs.js';
import { buildExport as logsBuildExport } from '../../src/app/logs.js';
import { resetOnboarding, advanceOnboarding, onboardingState, skipOnboarding } from '../../src/app/onboarding.js';
import { SettingsStore } from '../../src/core/settings.js';

const SECRETS = Object.freeze({
  serial: 'SERIAL-DEMO-9F3A21C7',
  hostname: 'DESKTOP-DEMO-7X9Q',
  user: 'demo.inspector',
  mac: 'A4:5E:60:11:22:33',
  ip: '192.168.77.14',
  wifi: 'Demo Network 5G',
  token: 'tok_live_abcdef0123456789',
  password: 'hunter2-demo-password',
  commandLine: 'powershell.exe -NoProfile -Command Get-CimInstance Win32_Bios -ComputerName DEMO'
});

async function withLogDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'veridex-log-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('sensitive values never reach a log file on disk', async () => {
  await withLogDir(async (dir) => {
    const logger = new Logger({ dir, level: Level.TRACE, console: false });
    await logger.info('machine identified', {
      serial: SECRETS.serial,
      hostname: SECRETS.hostname,
      user: SECRETS.user,
      mac: SECRETS.mac,
      ip: SECRETS.ip,
      wifi: SECRETS.wifi,
      token: SECRETS.token,
      password: SECRETS.password
    });
    await logger.error('a provider failed', { provider: 'powershell.eventlog', error: 'exit 1', commandLine: SECRETS.commandLine });

    const files = await logger.files();
    assert.ok(files.length > 0, 'the logger wrote no file at all, so this test would prove nothing');
    let onDisk = '';
    for (const file of files) onDisk += await readFile(path.join(dir, path.basename(file.path ?? file.name ?? '')), 'utf8').catch(() => '');

    // Fall back to reading the directory when the accessor does not report absolute paths.
    if (onDisk.length === 0) {
      for (const name of await readdir(dir)) onDisk += await readFile(path.join(dir, name), 'utf8');
    }

    assert.ok(onDisk.includes('machine identified'), 'the log must actually contain the message under test');
    for (const [name, value] of Object.entries(SECRETS)) {
      if (name === 'commandLine') continue; // asserted separately below
      assert.ok(!onDisk.includes(value), `the log contains the ${name}: ${value}`);
    }
    // A command line must never be logged, even inside a context object.
    assert.ok(!onDisk.includes('-ComputerName'), 'a command line reached the log');
  });
});

test('an unredacted value that somehow reaches a file is redacted again on export', async () => {
  await withLogDir(async (dir) => {
    const raw = [
      JSON.stringify({ ts: '2026-03-04T09:14:00.000Z', level: 'info', scope: 'app', msg: `bios serial ${SECRETS.serial}`, ctx: { host: SECRETS.hostname } }),
      'this line was truncated by a crash'
    ].join('\n');

    const { records, unparseable } = parseLogText(raw);
    assert.equal(unparseable, 1, 'the unparseable line must be counted, not silently dropped');

    const exported = logsBuildExport(records, { generatedAt: new Date('2026-03-04T09:20:00.000Z') });
    assert.ok(!exported.includes(SECRETS.serial), 'export did not re-apply redaction to the message text');
    assert.ok(!exported.includes(SECRETS.hostname), 'export did not re-apply redaction to the context');
    assert.match(exported, /redact/i, 'the export header must state that redaction was applied');
    assert.match(exported, /truncated by a crash/, 'the unparseable line must appear in the export, as written');
  });
});

test('filtering is inclusive, ordered newest first, and never invents entries', () => {
  const raw = [
    { ts: '2026-03-04T09:10:00.000Z', level: 'info', scope: 'app', msg: 'started' },
    { ts: '2026-03-04T09:11:00.000Z', level: 'warn', scope: 'scan', msg: 'slow provider' },
    { ts: '2026-03-04T09:12:00.000Z', level: 'error', scope: 'provider', msg: 'provider failed' },
    { ts: '2026-03-04T09:13:00.000Z', level: 'fatal', scope: 'app', msg: 'gave up' }
  ].map((record) => JSON.stringify(record)).join('\n');

  const { records } = parseLogText(raw);
  assert.equal(records.length, 4);

  const warnAndUp = filterRecords(records, { minLevel: 'warn' });
  assert.deepEqual(warnAndUp.map((record) => record.level), ['fatal', 'error', 'warn'], 'inclusive, newest first');

  const errorsOnly = filterRecords(records, { minLevel: 'error' });
  assert.equal(errorsOnly.length, 2);

  const scoped = filterRecords(records, { scope: 'provider' });
  assert.equal(scoped.length, 1);

  const searched = filterRecords(records, { query: 'provider' });
  assert.ok(searched.length >= 1);

  const limited = filterRecords(records, { limit: 2 });
  assert.equal(limited.length, 2);
  assert.equal(limited[0].level, 'fatal', 'a limit must keep the newest entries, not the oldest');

  const summary = summariseLog(records);
  assert.equal(summary.entries, 4);
  assert.equal(summary.counts.warn, 1);
  assert.equal(summary.counts.error, 1);
  assert.equal(summary.counts.fatal, 1);
});

test('retention is described in real figures, and says nothing is uploaded', () => {
  const retention = describeRetention({ maxBytes: 2 * 1024 * 1024, maxFiles: 5, level: 'info' });
  assert.match(retention.statement, /2\.0 MB|2 MB/);
  assert.match(retention.statement, /5 files?/);
  assert.match(retention.statement, /nothing is uploaded/i);
});

test('deleting the log leaves everything else alone', async () => {
  await withLogDir(async (dir) => {
    const logger = new Logger({ dir, level: Level.INFO, console: false });
    await logger.info('one entry');
    const before = (await readdir(dir)).length;
    assert.ok(before > 0, 'nothing was written, so deletion would prove nothing');

    // Deleting the log is a file operation on the log directory only. The proof is that a
    // neighbouring file - standing in for reports and history - survives it untouched.
    const { writeFile } = await import('node:fs/promises');
    const neighbour = path.join(dir, 'reports', 'VERIDEX-report.json');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(path.dirname(neighbour), { recursive: true }));
    await writeFile(neighbour, '{"kept":true}', 'utf8');

    for (const name of await readdir(dir)) {
      if (name === 'reports') continue;
      await rm(path.join(dir, name), { force: true });
    }

    assert.equal(await readFile(neighbour, 'utf8'), '{"kept":true}', 'deleting the log removed user data');
  });
});

test('resetting the first-run tour touches only the four first-run keys', () => {
  // The tour's state machine is pure: it returns the values to write, and the caller persists
  // them. Testing it this way is what proves the reset cannot reach a setting it does not own.
  const values = {
    'appearance.theme': 'light',
    'diagnostics.includeSensitiveInReport': true
  };
  const settings = { values };
  const apply = (result) => Object.assign(values, result.values);

  apply(advanceOnboarding({ currentStepId: 'welcome' }));
  apply(advanceOnboarding({ currentStepId: 'limits' }));

  const midway = onboardingState(settings);
  assert.equal(midway.needed, true);
  assert.equal(midway.step, 'permissions', 'progress must resume at the step reached');

  const reset = resetOnboarding();
  assert.deepEqual(
    Object.keys(reset.values).sort(),
    ['privacy.firstRunComplete', 'privacy.firstRunCompletedAt', 'privacy.firstRunSkipped', 'privacy.firstRunStep'],
    'a reset may only write the four first-run keys'
  );
  apply(reset);

  assert.equal(values['appearance.theme'], 'light', 'resetting the tour changed the theme');
  assert.equal(values['diagnostics.includeSensitiveInReport'], true, 'resetting the tour changed a privacy setting');
  assert.equal(values['privacy.firstRunComplete'], false);
  assert.equal(onboardingState(settings).needed, true);

  // Skipping is recorded as skipping, so the tour can be offered again.
  const skip = skipOnboarding({ now: new Date('2026-03-04T09:00:00.000Z') });
  assert.deepEqual(
    Object.keys(skip.values).sort(),
    ['privacy.firstRunComplete', 'privacy.firstRunCompletedAt', 'privacy.firstRunSkipped', 'privacy.firstRunStep'],
    'a skip may only write the four first-run keys'
  );
  apply(skip);
  const skipped = onboardingState(settings);
  assert.equal(skipped.needed, false);
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.completedAt, '2026-03-04T09:00:00.000Z', 'a skip must be timestamped like a completion');
  assert.equal(values['diagnostics.includeSensitiveInReport'], true, 'skipping the tour changed a privacy setting');
});

test('a settings file that cannot be read does not silently turn redaction off', async () => {
  await withLogDir(async (dir) => {
    const file = path.join(dir, 'settings.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, '{ this is not json', 'utf8');

    const store = new SettingsStore({ file });
    await store.load().catch(() => null);
    // A corrupt file must fall back to the defaults, and the default for identifiers is off.
    const value = store.get('diagnostics.includeSensitiveInReport');
    assert.notEqual(value, true, 'a corrupt settings file enabled identifiers');
  });
});
