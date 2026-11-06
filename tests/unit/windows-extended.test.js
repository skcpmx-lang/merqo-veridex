/**
 * The four Windows modules added by the audit: component-store health, event log, installed
 * software and the process snapshot.
 *
 * Every parser here is tested against output as Windows actually produces it — including the
 * shapes that are easy to get wrong: DISM's three sentences, `/Date(...)/` timestamps,
 * `YYYYMMDD` registry dates, numeric event levels, and `Get-Process` rows where CPU is
 * missing because the process is protected.
 *
 * The point of these tests is not coverage. It is that each module has one way to be wrong
 * that matters: claiming health it did not observe. So most assertions are about what the
 * module refuses to say.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDismHealth, describeStoreHealth, registerWindowsHealth } from '../../src/diagnostics/windowshealth.js';
import { summariseEvents, normaliseLevel, describeEvents, registerEvents, parseEventTime } from '../../src/diagnostics/events.js';
import { normaliseApplication, normaliseInstallDate, summariseApplications, describeApplications, registerSoftware } from '../../src/diagnostics/software.js';
import { normaliseProcesses, summariseProcesses, describeProcesses, registerProcesses } from '../../src/diagnostics/processes.js';
import { Status } from '../../src/core/status.js';
import { ProviderRegistry } from '../../src/engine/provider-registry.js';
import { tierOf } from '../../src/engine/confidence.js';

// ── Component store ──────────────────────────────────────────────────────────

test('DISM\'s three verdicts are read exactly, and nothing else is read as healthy', () => {
  const healthy = parseDismHealth('Deployment Image Servicing and Management tool\r\nVersion: 10.0.22621.1\r\n\r\nNo component store corruption detected.\r\nThe operation completed successfully.\r\n');
  assert.equal(healthy.verdict, 'healthy');
  assert.match(healthy.sentence, /No component store corruption detected/);

  const repairable = parseDismHealth('The component store is repairable.\r\nThe operation completed successfully.');
  assert.equal(repairable.verdict, 'repairable');

  const broken = parseDismHealth('The component store is not repairable.');
  assert.equal(broken.verdict, 'unrepairable');

  // The one that matters: output nobody recognises is unknown, never healthy.
  for (const output of ['', 'Error: 740\r\nElevated permissions are required', 'Something new Microsoft wrote in 2031']) {
    assert.equal(parseDismHealth(output).verdict, 'unknown', `"${output}" must not be read as a verdict`);
  }
});

test('an unrecognised DISM answer is reported as unsupported, not as a pass', () => {
  const fields = describeStoreHealth({ verdict: 'unknown', sentence: null, raw: 'Error: 740' }, 'dism');
  assert.equal(fields.componentStore.status, Status.UNSUPPORTED);
  assert.match(fields.componentStore.error, /nothing is claimed/i);
});

test('a healthy flag is described as a flag, not as proof that every file is intact', () => {
  const fields = describeStoreHealth({ verdict: 'healthy', sentence: 'No component store corruption detected.', raw: '' }, 'dism');
  assert.equal(fields.componentStore.status, Status.PASS);
  assert.match(fields.componentStore.notes.join(' '), /not proof that every system file is intact/i);
});

test('a repairable store is a warning that names the repair as the user\'s decision', () => {
  const fields = describeStoreHealth({ verdict: 'repairable', sentence: 'The component store is repairable.', raw: '' }, 'dism');
  assert.equal(fields.componentStoreVerdict.value, 'repairable');
  assert.equal(fields.componentStore.status, Status.WARNING);
  assert.match(fields.componentStore.notes.join(' '), /must be run by you/i);
  assert.ok('componentStoreRepair' in fields);
});

test('an unrepairable store is a failure, because it is one', () => {
  const fields = describeStoreHealth({ verdict: 'unrepairable', sentence: 'The component store is not repairable.', raw: '' }, 'dism');
  assert.equal(fields.componentStore.status, Status.FAIL);
});

test('the component-store provider asks for elevation rather than guessing', async () => {
  const registry = new ProviderRegistry();
  registerWindowsHealth(registry);
  const provider = registry.providers.get('dism.checkhealth');
  assert.ok(provider, 'the provider must be registered');

  const fields = await provider.collect({
    permissions: { isAdmin: false },
    runner: { run: async () => { throw new Error('a non-admin run must not call DISM at all'); } },
    logger: null,
    timeoutMs: 1000
  });
  assert.equal(fields.componentStore.status, Status.PERMISSION_REQUIRED);
});

test('the component-store task is registered with a validator that rejects invented verdicts', () => {
  const registry = new ProviderRegistry();
  registerWindowsHealth(registry);
  const task = registry.tasks.get('windows.componentHealth');
  assert.ok(task);
  assert.equal(task.module, 'windowsHealth');
  assert.deepEqual(task.validate({ componentStoreVerdict: { value: 'healthy' } }), []);
  assert.equal(task.validate({ componentStoreVerdict: { value: 'probably fine' } }).length, 1);
});

// ── Event log ────────────────────────────────────────────────────────────────

test('event levels are normalised from both the names and the numbers', () => {
  assert.equal(normaliseLevel('Critical'), 'Critical');
  assert.equal(normaliseLevel(1), 'Critical');
  assert.equal(normaliseLevel('Error'), 'Error');
  assert.equal(normaliseLevel(2), 'Error');
  assert.equal(normaliseLevel('Warning'), 'Warning');
  assert.equal(normaliseLevel('Information'), 'Information');
  assert.equal(normaliseLevel(undefined), 'Unknown');
  assert.equal(normaliseLevel('Sideways'), 'Unknown');
});

test('Windows PowerShell 5.1 /Date(...)/ timestamps are parsed, not discarded', () => {
  // This is the shape ConvertTo-Json produces on every Windows 10/11 machine. A parser that
  // only understands ISO 8601 would report a perfectly healthy, empty log on the target
  // platform - the worst failure mode this module has.
  assert.equal(parseEventTime('/Date(1772539200000)/'), '2026-03-03T12:00:00.000Z');
  assert.equal(parseEventTime('2026-03-03T12:00:00Z'), '2026-03-03T12:00:00.000Z');
  assert.equal(parseEventTime(new Date('2026-03-03T12:00:00Z')), '2026-03-03T12:00:00.000Z');
  assert.equal(parseEventTime('not a date'), null);
  assert.equal(parseEventTime(null), null);
});

test('event timestamps in every shape PowerShell produces are parsed and windowed', () => {
  const now = new Date('2026-03-10T12:00:00Z');
  const summary = summariseEvents([
    { TimeCreated: '/Date(1772539200000)/', Id: 1000, LevelDisplayName: 'Error', ProviderName: 'Application Error' },
    { TimeCreated: '2026-03-09T10:00:00Z', Id: 41, LevelDisplayName: 1, ProviderName: 'Microsoft-Windows-Kernel-Power' },
    { TimeCreated: new Date('2026-03-09T00:00:00Z'), Id: 1001, LevelDisplayName: 'Error', ProviderName: 'Microsoft-Windows-WER-SystemErrorReporting' },
    // Outside the seven-day window: must not count.
    { TimeCreated: '2026-01-01T00:00:00Z', Id: 1000, LevelDisplayName: 'Error', ProviderName: 'Old' }
  ], { now, windowDays: 7 });

  assert.equal(summary.total, 3, 'the out-of-window event must be excluded');
  assert.equal(summary.error, 2);
  assert.equal(summary.critical, 1);
  assert.equal(summary.crash.applicationCrashes, 1);
  assert.equal(summary.crash.bugchecks, 1, 'a 1001 from the system-error provider is a bugcheck');
  assert.equal(summary.crash.werReports, 0);
  assert.equal(summary.windowDays, 7);
});

test('a bugcheck is a failure with the next step named, and no crash history is a pass', () => {
  const now = new Date('2026-03-10T12:00:00Z');
  const crashed = describeEvents(summariseEvents([
    { TimeCreated: '2026-03-09T10:00:00Z', Id: 1001, LevelDisplayName: 'Error', ProviderName: 'Microsoft-Windows-WER-SystemErrorReporting' }
  ], { now }), 'powershell.eventlog');
  assert.equal(crashed.crashHistory.status, Status.FAIL);
  assert.match(crashed.crashHistory.notes.join(' '), /driver fault until proven otherwise/i);

  const clean = describeEvents(summariseEvents([], { now }), 'powershell.eventlog');
  assert.equal(clean.crashHistory.status, Status.PASS);
  assert.match(clean.crashHistory.notes.join(' '), /meaningful evidence rather than a missing field/i);
});

test('event text is never retained: only provider, id, level and time reach the fields', () => {
  const now = new Date('2026-03-10T12:00:00Z');
  const withMessage = [{
    TimeCreated: '2026-03-09T10:00:00Z',
    Id: 1000,
    LevelDisplayName: 'Error',
    ProviderName: 'Application Error',
    Message: 'Faulting application C:\\Users\\shohan\\Documents\\tax-return-2025.docx'
  }];
  const summary = summariseEvents(withMessage, { now });
  const serialised = JSON.stringify(summary);
  assert.doesNotMatch(serialised, /tax-return/, 'the message body must not survive summarisation');
  assert.doesNotMatch(serialised, /shohan/);
});

// ── Installed software ───────────────────────────────────────────────────────

test('registry install dates are parsed from the compact form and rejected when impossible', () => {
  assert.equal(normaliseInstallDate('20250310'), '2025-03-10');
  assert.equal(normaliseInstallDate('20251310'), null, 'month 13 is not a date');
  assert.equal(normaliseInstallDate(''), null);
  assert.equal(normaliseInstallDate(null), null);
  assert.equal(normaliseInstallDate('2025-03-10T00:00:00Z'), '2025-03-10');
  assert.equal(normaliseInstallDate('2025031'), null, 'a six-digit date is not a date');
});

test('uninstall entries without a name, and system components, are not software', () => {
  assert.equal(normaliseApplication({ DisplayName: '' }), null);
  assert.equal(normaliseApplication({ DisplayName: 'Update for Windows', SystemComponent: 1 }), null);
  assert.equal(normaliseApplication({ DisplayName: 'Patch', ParentKeyName: 'Windows' }), null);
  assert.equal(normaliseApplication(null), null);

  const app = normaliseApplication({ DisplayName: '7-Zip 24.09', DisplayVersion: '24.09', Publisher: 'Igor Pavlov', InstallDate: '20250101' });
  assert.equal(app.name, '7-Zip 24.09');
  assert.equal(app.installDate, '2025-01-01');
  assert.equal(app.source, 'machine');
});

test('the software summary counts what it can and does not invent publishers', () => {
  const summary = summariseApplications([
    normaliseApplication({ DisplayName: 'A', Publisher: 'Acme' }),
    normaliseApplication({ DisplayName: 'B', Publisher: 'Acme' }),
    normaliseApplication({ DisplayName: 'C' })
  ]);
  assert.equal(summary.total, 3);
  assert.equal(summary.withPublisher, 2);
  assert.deepEqual(summary.topPublishers[0], { publisher: 'Acme', count: 2 });
  assert.equal(summary.topPublishers[1].publisher, 'Unknown publisher');
});

test('install dates missing everywhere is reported as unavailable, not as no software', () => {
  const fields = describeApplications(summariseApplications([normaliseApplication({ DisplayName: 'A' })]), 'registry.uninstall');
  assert.equal(fields.applicationCount.value, 1);
  assert.equal(fields.applicationInstallDates.status, Status.UNAVAILABLE);
});

// ── Processes ────────────────────────────────────────────────────────────────

test('process rows keep memory and CPU time in labelled units, and drop unusable rows', () => {
  const processes = normaliseProcesses([
    { ProcessName: 'chrome', Id: 100, CPU: 41.234, WorkingSet64: 524288000 },
    { ProcessName: 'System', Id: 4, CPU: null, WorkingSet64: 1024000 },
    { Id: 55, CPU: 1, WorkingSet64: 1 },
    null
  ]);
  assert.equal(processes.length, 2, 'a row without a name is not a process');
  assert.equal(processes[0].cpuSeconds, 41.2);
  assert.equal(processes[0].memoryMb, 500);
  assert.equal(processes[1].cpuSeconds, null, 'a protected process has no CPU time, and null is not zero');
});

test('grouping turns many identical processes into one line', () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({ ProcessName: 'chrome', Id: index, CPU: 1, WorkingSet64: 104857600 }));
  const summary = summariseProcesses(normaliseProcesses(rows));
  assert.equal(summary.total, 10);
  assert.equal(summary.heaviestGroup[0].count, 10);
  assert.equal(summary.heaviestGroup[0].memoryMb, 1000);
  // The summary reports the fact; the fields decide what it means. A browser with ten
  // processes is a fact, not a finding, and that judgement belongs in describeProcesses().
  assert.deepEqual(summary.duplicates, [{ name: 'chrome', count: 10 }]);
});

test('an unexplained duplicate process is a warning, a browser is not', () => {
  const many = (name) => Array.from({ length: 12 }, (_, index) => ({ ProcessName: name, Id: index, CPU: 0, WorkingSet64: 10485760 }));
  const suspicious = describeProcesses(summariseProcesses(normaliseProcesses(many('miner'))), 'powershell.processes');
  assert.equal(suspicious.processDuplicates.status, Status.WARNING);
  const browser = describeProcesses(summariseProcesses(normaliseProcesses(many('chrome'))), 'powershell.processes');
  assert.equal(browser.processDuplicates, undefined);
});

test('the process task rejects an implausibly short list as a failed enumeration', () => {
  const registry = new ProviderRegistry();
  registerProcesses(registry);
  const task = registry.tasks.get('processes.snapshot');
  assert.equal(task.validate({ processCount: { value: 2 } }).length, 1);
  assert.equal(task.validate({ processCount: { value: 180 } }).length, 0);
});

// ── Registry-level guarantees ────────────────────────────────────────────────

test('all four modules register, and every provider has a deliberate confidence tier', () => {
  const registry = new ProviderRegistry();
  for (const register of [registerWindowsHealth, registerEvents, registerSoftware, registerProcesses]) register(registry);

  assert.deepEqual([...registry.tasks.keys()].sort(), [
    'processes.snapshot',
    'software.installed',
    'software.scheduledTasks',
    'software.startup',
    'windows.componentHealth',
    'windows.events'
  ]);
  for (const providerId of registry.providers.keys()) {
    assert.notEqual(tierOf(providerId), 'heuristic', `${providerId} fell through to the heuristic default`);
  }
});

test('the event provider treats an empty log as a pass, not as an error', async () => {
  const registry = new ProviderRegistry();
  registerEvents(registry);
  const provider = registry.providers.get('powershell.eventlog');
  const fields = await provider.collect({
    permissions: { isAdmin: false },
    runner: {
      powershellJson: async () => ({ ok: false, data: null, error: 'Get-WinEvent: No events were found that match the specified selection criteria.' })
    },
    logger: null,
    timeoutMs: 1000
  });
  assert.equal(fields.crashHistory.status, Status.PASS);
});
