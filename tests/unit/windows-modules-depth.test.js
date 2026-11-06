/**
 * Event log, software inventory and process snapshot — the adversarial cases.
 *
 * The first suite proved these modules read ordinary output. This one asks what they do when
 * Windows is unhelpful: duplicate rows, a hive that cannot be read, a process that vanishes
 * mid-collection, a log that is empty, a protected process with no CPU figure.
 *
 * The through-line is the same as everywhere else in this repository: a limitation must appear
 * as a stated limitation, never as a clean result.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { summariseEvents, describeEvents, registerEvents, parseEventTime, EVENT_WINDOW_DAYS } from '../../src/diagnostics/events.js';
import {
  normaliseApplication,
  normaliseInstallDate,
  summariseApplications,
  describeApplications,
  registerSoftware,
  UNINSTALL_KEYS
} from '../../src/diagnostics/software.js';
import { normaliseProcesses, summariseProcesses, describeProcesses, registerProcesses, PROCESS_LIMIT } from '../../src/diagnostics/processes.js';
import { Status } from '../../src/core/status.js';
import { ProviderRegistry } from '../../src/engine/provider-registry.js';

const NOW = new Date('2026-03-10T12:00:00.000Z');
const daysAgo = (days) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

function providerOf(register, id) {
  const registry = new ProviderRegistry();
  register(registry);
  return registry.providers.get(id);
}

// ═══ Event log ═════════════════════════════════════════════════════════════

test('the window is seven days and is stated in the report', () => {
  assert.equal(EVENT_WINDOW_DAYS, 7);
  const summary = summariseEvents([], { now: NOW });
  const fields = describeEvents(summary, 'powershell.eventlog');
  assert.match(fields.eventWindow.notes.join(' '), /last 7 days/);
});

test('events outside the window are excluded and events on the boundary are kept', () => {
  const summary = summariseEvents(
    [
      { TimeCreated: daysAgo(6.9), Id: 1000, LevelDisplayName: 'Error', ProviderName: 'App' },
      { TimeCreated: daysAgo(7.01), Id: 1000, LevelDisplayName: 'Error', ProviderName: 'App' },
      { TimeCreated: daysAgo(30), Id: 1000, LevelDisplayName: 'Error', ProviderName: 'App' }
    ],
    { now: NOW }
  );
  assert.equal(summary.total, 1, 'only the in-window event counts');
});

test('both logs are queried, and only critical and error levels', async () => {
  const provider = providerOf(registerEvents, 'powershell.eventlog');
  let script = '';
  await provider.collect({
    permissions: {},
    runner: {
      powershellJson: async (body) => {
        script = body;
        return { ok: true, data: [] };
      }
    },
    logger: null,
    timeoutMs: 5000
  });

  assert.match(script, /LogName = @\('System','Application'\)/, 'both logs must be in the query');
  assert.match(script, /Level = 1,2/, 'only critical and error entries are collected');
  assert.match(script, /AddDays\(-7\)/, 'the time filter belongs in the query, not in the parsing');
  assert.match(script, /MaxEvents 400/, 'the query must be bounded');
  // Message bodies must never be selected.
  assert.ok(!/Message|Description/i.test(script), 'the query must not request event text');
});

test('duplicate records are counted once', () => {
  // Get-WinEvent can return the same record twice when a query spans logs with forwarded events;
  // double-counting errors is the difference between "4 errors" and "2 errors" on screen.
  const record = { TimeCreated: daysAgo(1), Id: 1000, LevelDisplayName: 'Error', ProviderName: 'App', RecordId: 8123 };
  const summary = summariseEvents([record, { ...record }, { ...record, RecordId: 8124 }], { now: NOW });
  assert.equal(summary.total, 2, 'a repeated record id is one event; a different id is another');
  assert.equal(summary.error, 2);
});

test('without record ids nothing is dropped, because a duplicate cannot be told from two events', () => {
  // Two applications can crash in the same second with the same event id. A triple-based
  // dedupe would silently delete one of them, which is the wrong direction to be wrong in.
  const row = { TimeCreated: daysAgo(2), Id: 1000, LevelDisplayName: 'Error', ProviderName: 'App' };
  const summary = summariseEvents([row, { ...row }], { now: NOW });
  assert.equal(summary.total, 2);
});

test('a bugcheck is counted only for the system-error-reporting provider', () => {
  const summary = summariseEvents(
    [
      { TimeCreated: daysAgo(2), Id: 1001, LevelDisplayName: 'Error', ProviderName: 'Microsoft-Windows-WER-SystemErrorReporting' },
      { TimeCreated: daysAgo(2), Id: 1001, LevelDisplayName: 'Error', ProviderName: 'Microsoft-Windows-WER' },
      { TimeCreated: daysAgo(2), Id: 1001, LevelDisplayName: 'Error', ProviderName: 'Something.Else' }
    ],
    { now: NOW }
  );
  assert.equal(summary.crash.bugchecks, 1, 'only the bugcheck provider counts a bugcheck');
  assert.equal(summary.crash.werReports, 1, 'the WER report is counted separately');
});

test('an unexpected shutdown and an application crash are counted independently', () => {
  const summary = summariseEvents(
    [
      { TimeCreated: daysAgo(1), Id: 6008, LevelDisplayName: 'Error', ProviderName: 'EventLog' },
      { TimeCreated: daysAgo(1), Id: 1000, LevelDisplayName: 'Error', ProviderName: 'Application Error' },
      { TimeCreated: daysAgo(1), Id: 1000, LevelDisplayName: 'Error', ProviderName: 'Application Error' }
    ],
    { now: NOW }
  );
  assert.equal(summary.crash.unexpectedShutdowns, 1);
  assert.equal(summary.crash.applicationCrashes, 2);
  assert.equal(summary.crash.bugchecks, 0);
});

test('a clean week says it is evidence, not an absence of data', () => {
  const fields = describeEvents(summariseEvents([], { now: NOW }), 'powershell.eventlog');
  assert.equal(fields.eventErrors.status, Status.PASS);
  assert.equal(fields.crashHistory.status, Status.PASS);
  assert.match(fields.crashHistory.notes.join(' '), /meaningful evidence/i);
});

test('crash history is a failure that points at hardware, not a warning', () => {
  const fields = describeEvents(
    summariseEvents([{ TimeCreated: daysAgo(1), Id: 1001, LevelDisplayName: 'Error', ProviderName: 'Microsoft-Windows-WER-SystemErrorReporting' }], { now: NOW }),
    'powershell.eventlog'
  );
  assert.equal(fields.crashHistory.status, Status.FAIL);
  assert.match(fields.crashHistory.notes.join(' '), /hardware or driver|hardware or a driver/i);
});

test('an unreadable event log is unavailable, and says that is not the same as clean', async () => {
  const provider = providerOf(registerEvents, 'powershell.eventlog');
  const fields = await provider.collect({
    permissions: {},
    runner: { powershellJson: async () => ({ ok: false, error: 'Access is denied.' }) },
    logger: null,
    timeoutMs: 5000
  });
  assert.equal(fields.eventErrors.status, Status.UNAVAILABLE);
  assert.match(fields.eventErrors.notes.join(' '), /not the same as clean/i);
});

test('an empty log is a pass, not an error', async () => {
  const provider = providerOf(registerEvents, 'powershell.eventlog');
  const fields = await provider.collect({
    permissions: {},
    runner: { powershellJson: async () => ({ ok: false, error: 'No events were found that match the specified selection criteria.' }) },
    logger: null,
    timeoutMs: 5000
  });
  assert.equal(fields.eventErrors.status, Status.PASS, 'Get-WinEvent throws when there is nothing to return');
});

test('PowerShell 5.1 date wrappers, ISO strings and Date objects all land on the same instant', () => {
  const instant = '2026-03-03T12:00:00.000Z';
  const millis = Date.parse(instant);
  assert.equal(parseEventTime(`/Date(${millis})/`), instant);
  assert.equal(parseEventTime(`/Date(${millis}+0000)/`), instant);
  assert.equal(parseEventTime(instant), instant);
  assert.equal(parseEventTime(new Date(instant)), instant);
  assert.equal(parseEventTime(''), null);
  assert.equal(parseEventTime('not a date'), null);
});

test('the event window is rendered with both ends, in local terms', () => {
  const fields = describeEvents(
    summariseEvents([{ TimeCreated: daysAgo(1), Id: 1000, LevelDisplayName: 'Error', ProviderName: 'App' }], { now: NOW }),
    'powershell.eventlog'
  );
  assert.match(String(fields.eventWindow.value), /→/, 'a count without a period means nothing');
});

// ═══ Software inventory ════════════════════════════════════════════════════

test('all three uninstall hives are read, including the 32-bit per-user view', () => {
  assert.equal(UNINSTALL_KEYS.length, 3);
  assert.ok(UNINSTALL_KEYS.some((key) => /WOW6432Node/.test(key)), '32-bit machine-wide applications live in the WOW6432Node view');
  assert.ok(UNINSTALL_KEYS.some((key) => /^HKCU:/.test(key)), 'per-user installs are only visible in HKCU');
  for (const key of UNINSTALL_KEYS) assert.match(key, /Uninstall\\\*$/, 'each path must target the Uninstall subkeys');
});

test('duplicate entries across registry views are counted once', () => {
  const entry = { DisplayName: 'MERQO Tools', DisplayVersion: '1.2.3', Publisher: 'MERQO', InstallLocation: 'C:\\Program Files\\MERQO' };
  const summary = summariseApplications([
    normaliseApplication({ ...entry, __KeyPath: 'HKLM:\\...\\Uninstall\\MERQO' }),
    normaliseApplication({ ...entry, __KeyPath: 'HKLM:\\...\\WOW6432Node\\...\\MERQO' }),
    normaliseApplication({ ...entry, DisplayVersion: '2.0.0', __KeyPath: 'HKCU:\\...\\MERQO' })
  ]);
  assert.equal(summary.total, 2, 'the same build in two views is one application; a different version is two');
  assert.equal(summary.duplicatesRemoved, 1);
});

test('an entry with no publisher or version is kept and shown as unknown', () => {
  const application = normaliseApplication({ DisplayName: 'Anonymous Tool' });
  assert.ok(application, 'missing metadata must not hide installed software');
  assert.equal(application.publisher, null);
  assert.equal(application.version, null);

  const fields = describeApplications(summariseApplications([application]), 'registry.uninstall');
  // An application with no publisher is still inventoried, and the histogram names the absence
  // rather than quietly leaving a gap in a list the reader will assume is complete.
  assert.equal(fields.applicationPublishers.value, 'Unknown publisher (1)');
  assert.equal(fields.applicationCount.value, 1);
});

test('impossible and malformed values are rejected without dropping the application', () => {
  // Installers write all sorts of things into InstallDate.
  for (const bad of ['20251301', '20250230', '00000000', 'banana', '2025-13-45', '']) {
    assert.equal(normaliseInstallDate(bad), null, `"${bad}" is not a date`);
  }
  assert.equal(normaliseInstallDate(undefined), null);
  assert.equal(normaliseInstallDate('20250310'), '2025-03-10');
  assert.equal(normaliseInstallDate(20250310), '2025-03-10', 'a numeric value is still the compact form');

  const application = normaliseApplication({ DisplayName: 'Broken Date', InstallDate: '20250230' });
  assert.ok(application, 'an unusable install date must not remove the application');
  assert.equal(application.installDate, null);
});

test('system components and update stubs are excluded, as Programs and Features excludes them', () => {
  assert.equal(normaliseApplication({ DisplayName: 'Update for KB123', SystemComponent: 1 }), null);
  assert.equal(normaliseApplication({ DisplayName: 'Update for KB123', SystemComponent: '1' }), null);
  assert.equal(normaliseApplication({ DisplayName: 'Child patch', ParentKeyName: 'Some Product' }), null);
  assert.equal(normaliseApplication({ DisplayVersion: '1.0' }), null, 'an entry with no name is not software');
});

test('the uninstall string is reported as text and never executed', async () => {
  const provider = providerOf(registerSoftware, 'registry.uninstall');
  const calls = [];
  await provider.collect({
    permissions: {},
    runner: {
      powershellJson: async (body) => {
        calls.push(body);
        return { ok: true, data: [{ DisplayName: 'Thing', UninstallString: 'C:\\Program Files\\Thing\\uninstall.exe' }] };
      },
      run: async () => {
        throw new Error('the software inventory must not execute an uninstall string');
      }
    },
    logger: null,
    timeoutMs: 5000
  });
  assert.equal(calls.length, 1, 'one query for all hives');
  assert.ok(!/Start-Process|Invoke-Expression|& \$/.test(calls[0]), 'nothing in the query may run a registry value');
});

test('startup entries are read from Run and RunOnce, at both machine and user scope', async () => {
  const provider = providerOf(registerSoftware, 'powershell.startup');
  let script = '';
  await provider.collect({
    permissions: {},
    runner: {
      powershellJson: async (body) => {
        script = body;
        return { ok: true, data: [] };
      }
    },
    logger: null,
    timeoutMs: 5000
  });
  assert.match(script, /HKLM:.*Run/);
  assert.match(script, /HKCU:.*Run/);
  assert.match(script, /RunOnce/);
  assert.ok(!/Remove-Item|Set-ItemProperty|New-ItemProperty|Disable/i.test(script), 'inventory must never modify a startup entry');
});

test('an entry that launches from a temporary directory is flagged', async () => {
  const provider = providerOf(registerSoftware, 'powershell.startup');
  const fields = await provider.collect({
    permissions: {},
    runner: {
      powershellJson: async () => ({
        ok: true,
        data: [
          { name: 'Updater', command: 'C:\\Users\\demo\\AppData\\Local\\Temp\\upd.exe /silent', location: 'HKCU:\\...\\Run' },
          { name: 'Normal', command: 'C:\\Program Files\\App\\app.exe', location: 'HKLM:\\...\\Run' }
        ]
      })
    },
    logger: null,
    timeoutMs: 5000
  });
  assert.equal(fields.startupEntries.value, 2);
  assert.ok(fields.startupEntryWarning, 'a temp-directory launcher must produce a warning');
  assert.equal(fields.startupEntryWarning.status, Status.WARNING);
});

test('no startup entries is a stated zero, not an empty field', async () => {
  const provider = providerOf(registerSoftware, 'powershell.startup');
  const fields = await provider.collect({
    permissions: {},
    runner: { powershellJson: async () => ({ ok: true, data: [] }) },
    logger: null,
    timeoutMs: 5000
  });
  assert.equal(fields.startupEntries.value, 0);
  assert.match(fields.startupEntries.notes.join(' '), /Nothing is registered/i);
});

test('an unreadable startup key is unavailable rather than "nothing starts"', async () => {
  const provider = providerOf(registerSoftware, 'powershell.startup');
  const fields = await provider.collect({
    permissions: {},
    runner: { powershellJson: async () => ({ ok: false, error: 'Access to the registry key is denied.' }) },
    logger: null,
    timeoutMs: 5000
  });
  assert.equal(fields.startupEntries.status, Status.UNAVAILABLE);
  assert.match(fields.startupEntries.error, /could not be read/i);
});

// ═══ Processes ═════════════════════════════════════════════════════════════

test('the snapshot never asks for command lines', async () => {
  const provider = providerOf(registerProcesses, 'powershell.processes');
  let script = '';
  await provider.collect({
    permissions: {},
    runner: {
      powershellJson: async (body) => {
        script = body;
        return { ok: true, data: [] };
      }
    },
    logger: null,
    timeoutMs: 5000
  });
  assert.ok(!/CommandLine|Path|Owner|StartInfo/i.test(script), 'command lines can carry tokens and paths and are never collected');
  assert.match(script, /ProcessName/);
  assert.match(script, /WorkingSet/);
});

test('a process exiting mid-collection leaves the rest of the snapshot intact', () => {
  const processes = normaliseProcesses([
    { ProcessName: 'alive', Id: 100, CPU: 4.5, WorkingSet64: 100 * 1024 * 1024 },
    // CPU and memory absent: the process was protected, or died between enumeration and read.
    { ProcessName: 'protected', Id: 4, CPU: null, WorkingSet64: null },
    { ProcessName: '', Id: 5 },
    { Id: 6 }
  ]);
  assert.equal(processes.length, 2, 'nameless rows are dropped; partial rows are kept');
  assert.equal(processes[1].cpuSeconds, null);
  assert.equal(processes[1].memoryMb, null);

  const summary = summariseProcesses(processes);
  assert.equal(summary.total, 2);
});

test('a large process table is summarised, not truncated into a false total', () => {
  const many = Array.from({ length: 600 }, (_, index) => ({
    ProcessName: index % 3 === 0 ? 'chrome' : `proc${index}`,
    Id: 1000 + index,
    CPU: index,
    WorkingSet64: (index + 1) * 1024 * 1024
  }));
  const summary = summariseProcesses(normaliseProcesses(many));
  assert.equal(summary.total, 600, 'the total must be the real process count');
  assert.equal(summary.byMemory.length, PROCESS_LIMIT, 'the ranked list is bounded');
  assert.equal(summary.byCpu.length, PROCESS_LIMIT);
  const chrome = summary.heaviestGroup.find((group) => group.name === 'chrome');
  assert.equal(chrome.count, 200, 'grouping by name must count every instance');
});

test('an empty process table is reported honestly', () => {
  const fields = describeProcesses(summariseProcesses([]), 'powershell.processes');
  assert.ok(Object.keys(fields).length > 0);
  const first = Object.values(fields)[0];
  assert.ok([Status.UNAVAILABLE, Status.PASS].includes(first.status));
});

test('the same name twice is a fact; the finding is in the description', () => {
  const summary = summariseProcesses(
    normaliseProcesses([
      { ProcessName: 'chrome', Id: 1, WorkingSet64: 10 * 1024 * 1024 },
      { ProcessName: 'chrome', Id: 2, WorkingSet64: 10 * 1024 * 1024 }
    ])
  );
  assert.equal(summary.heaviestGroup[0].count, 2);
  // Two browsers is normal operation; the description must not call it a problem.
  const fields = describeProcesses(summary, 'powershell.processes');
  const text = JSON.stringify(fields);
  assert.ok(!/duplicate/i.test(text) || /browser|editor|normal/i.test(text), 'multi-process browsers are not a finding');
});

test('an unreadable registry hive is reported instead of shrinking the inventory quietly', async () => {
  const provider = providerOf(registerSoftware, 'registry.uninstall');
  const fields = await provider.collect({
    permissions: {},
    runner: {
      powershellJson: async () => ({
        ok: true,
        data: {
          items: [{ DisplayName: 'Visible app', DisplayVersion: '1.0', Publisher: 'MERQO' }],
          failures: ['HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*']
        }
      })
    },
    logger: null,
    timeoutMs: 5000
  });

  assert.equal(fields.applicationCount.value, 1);
  assert.ok(fields.applicationHivesUnread, 'an unreadable hive must appear in the fields');
  assert.equal(fields.applicationHivesUnread.status, Status.UNAVAILABLE);
  assert.match(fields.applicationHivesUnread.error, /1 of 3/);
  assert.match(fields.applicationHivesUnread.notes.join(' '), /incomplete/i);
});

test('the older array-shaped payload is still understood', async () => {
  const provider = providerOf(registerSoftware, 'registry.uninstall');
  const fields = await provider.collect({
    permissions: {},
    runner: { powershellJson: async () => ({ ok: true, data: [{ DisplayName: 'Legacy payload' }] }) },
    logger: null,
    timeoutMs: 5000
  });
  assert.equal(fields.applicationCount.value, 1);
  assert.equal(fields.applicationHivesUnread, undefined, 'nothing failed, so nothing is claimed to have failed');
});

test('a process query that is refused leaves an explanation, not an empty table', async () => {
  const provider = providerOf(registerProcesses, 'powershell.processes');
  const fields = await provider.collect({
    permissions: {},
    runner: { powershellJson: async () => ({ ok: false, error: 'Access is denied.' }) },
    logger: null,
    timeoutMs: 5000
  });
  const values = Object.values(fields);
  assert.ok(values.length > 0);
  assert.equal(values[0].status, Status.UNAVAILABLE);
  assert.match(values[0].error, /denied|could not/i);
});
