/**
 * R-12-02 — scheduled tasks, and the startup folders the provider claimed to read.
 *
 * The requirement asks what Windows starts and what runs on its own: startup apps, scheduled
 * tasks, services, components and background processes. The startup keys, services, optional
 * features and process snapshot existed; scheduled tasks did not, and the startup provider's
 * title promised two sources while its script read one.
 *
 * These tests are written against the failure modes, not the happy path: a task list that could
 * not be read must not become "0 tasks", the older `schtasks` interface must not invent the
 * author and action it cannot report, and the Startup folders must actually be in the script.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  registerSoftware,
  normaliseScheduledTask,
  summariseScheduledTasks,
  isMicrosoftTask,
  MICROSOFT_TASK_ROOT
} from '../../src/diagnostics/software.js';
import { Status } from '../../src/core/status.js';
import { ProviderRegistry } from '../../src/engine/provider-registry.js';

function providerOf(register, id) {
  const registry = new ProviderRegistry();
  register(registry);
  return registry.providers.get(id);
}

function taskOf(register, id) {
  const registry = new ProviderRegistry();
  register(registry);
  return registry.tasks.get(id);
}

const collect = async (runner) => providerOf(registerSoftware, 'powershell.scheduledTasks').collect({
  permissions: {},
  runner,
  logger: null,
  timeoutMs: 5000
});

// ═══ Classification ═════════════════════════════════════════════════════════

test("Microsoft's own folder is recognised without reading the author", () => {
  assert.equal(MICROSOFT_TASK_ROOT.test('\\Microsoft\\Windows\\Defrag\\ScheduledDefrag'), true);
  assert.equal(MICROSOFT_TASK_ROOT.test('\\Vendor\\Updater'), false);
  assert.equal(isMicrosoftTask({ path: '\\Microsoft\\WindowsUpdate\\Scheduled Start', author: '' }), true);
});

test('a task outside Microsoft’s folder counts as third party even with a blank author', () => {
  // The failure this prevents: an installer drops a task in the root, writes no author, and the
  // list a reviewer scans says "everything here is Microsoft's".
  assert.equal(isMicrosoftTask({ path: '\\', author: '' }), false);
  assert.equal(isMicrosoftTask({ path: '\\', author: 'Microsoft Corporation' }), true);
  assert.equal(isMicrosoftTask(null), false);
});

test('a task with no name is dropped rather than listed as an empty row', () => {
  assert.equal(normaliseScheduledTask({ name: '   ' }), null);
  assert.equal(normaliseScheduledTask(null), null);
  const task = normaliseScheduledTask({ name: 'Updater', path: '\\Vendor\\', state: 'Disabled', action: 'C:\\a.exe' });
  assert.equal(task.name, 'Updater');
  assert.equal(task.disabled, true, 'a Disabled state sets the flag');
});

test('the summary separates running tasks from ready ones', () => {
  const summary = summariseScheduledTasks([
    { name: 'A', path: '\\Vendor\\', state: 'Ready' },
    { name: 'B', path: '\\Vendor\\', state: 'Running' },
    { name: 'C', path: '\\Microsoft\\Windows\\X', state: 'Disabled' },
    { name: 'D', path: '\\Vendor\\', state: 'Disabled' }
  ]);
  assert.equal(summary.total, 4);
  assert.equal(summary.running, 1, 'only a Running task is activity');
  assert.equal(summary.disabled, 2);
  assert.deepEqual(summary.nonMicrosoft.map((task) => task.name), ['A', 'B', 'D']);
});

test('an action that runs from a temporary folder is singled out', () => {
  const summary = summariseScheduledTasks([
    { name: 'Updater', path: '\\Vendor\\', action: 'C:\\Users\\demo\\AppData\\Local\\Temp\\upd.exe /silent' },
    { name: 'Good', path: '\\Vendor\\', action: 'C:\\Program Files\\App\\app.exe' }
  ]);
  assert.deepEqual(summary.temporary.map((task) => task.name), ['Updater']);
});

// ═══ The provider ══════════════════════════════════════════════════════════

test('the provider reads the task list and reports the third-party share', async () => {
  const fields = await collect({
    powershellJson: async () => ({
      ok: true,
      data: [{
        items: [
          { name: 'MicrosoftEdgeUpdateTaskMachineUA', path: '\\', state: 'Ready', author: 'Microsoft Corporation', action: 'C:\\edge.exe /ua' },
          { name: 'ScheduledDefrag', path: '\\Microsoft\\Windows\\Defrag\\', state: 'Ready', author: 'Microsoft Corporation', action: '' },
          { name: 'VendorUpdater', path: '\\', state: 'Ready', author: '', action: 'C:\\Program Files\\Vendor\\upd.exe' }
        ],
        source: 'scheduledtasks',
        failure: null
      }]
    })
  });
  assert.equal(fields.scheduledTaskCount.value, 3);
  // The Edge task sits in the root folder but names Microsoft as its author, so it counts as
  // Microsoft's. That rule is deliberate: a root-folder task with a blank author is the case
  // that must not slip through, and it does not.
  assert.match(fields.scheduledTaskCount.notes.join(' '), /1 of 3 tasks are not published by Microsoft/);
  assert.equal(fields.scheduledTaskList.value.length, 1);
  assert.match(fields.scheduledTaskStates.value, /0 running, 0 disabled of 3/);
});

test('a task list that could not be read is unavailable, never zero', async () => {
  const fields = await collect({ powershellJson: async () => ({ ok: false, error: 'exit 1 — access denied' }) });
  assert.equal(fields.scheduledTaskCount.status, Status.UNAVAILABLE);
  assert.match(fields.scheduledTaskCount.error, /could not be read/i);
  assert.match(fields.scheduledTaskCount.notes.join(' '), /not an empty task list/i);
});

test('an empty list from a query that threw is unavailable, not a clean machine', async () => {
  // This is the exact shape the script produces when `Get-ScheduledTask` and `schtasks` both
  // fail: an empty array carrying the reason. Reading it as "0 tasks" would certify a machine
  // whose task scheduler was never queried.
  const fields = await collect({
    powershellJson: async () => ({
      ok: true,
      data: [{ items: [], source: 'schtasks', failure: 'The term Get-ScheduledTask is not recognized' }]
    })
  });
  assert.equal(fields.scheduledTaskCount.status, Status.UNAVAILABLE);
  assert.match(fields.scheduledTaskCount.error, /not recognized/);
  assert.equal(fields.scheduledTaskList, undefined, 'nothing is listed when nothing was read');
});

test('the schtasks fallback says that it cannot report the author or the action', async () => {
  const fields = await collect({
    powershellJson: async () => ({
      ok: true,
      data: [{ items: [{ name: '\\VendorUpdater', path: '', state: 'Ready', author: '', action: '' }], source: 'schtasks', failure: 'nope' }]
    })
  });
  assert.equal(fields.scheduledTaskCount.status, Status.PASS);
  assert.match(fields.scheduledTaskCount.notes.join(' '), /schtasks.*author and the action are not reported/i);
});

test('an empty machine is a stated zero with a list that says so', async () => {
  const fields = await collect({ powershellJson: async () => ({ ok: true, data: [{ items: [], source: 'scheduledtasks', failure: null }] }) });
  assert.equal(fields.scheduledTaskCount.value, 0);
  assert.deepEqual(fields.scheduledTaskList.value, []);
  assert.match(fields.scheduledTaskList.notes.join(' '), /published by Microsoft, or the machine has no tasks/i);
});

test('a temporary-folder action raises a warning that names the task', async () => {
  const fields = await collect({
    powershellJson: async () => ({
      ok: true,
      data: [{ items: [{ name: 'Updater', path: '\\Vendor\\', state: 'Ready', action: 'C:\\Windows\\Temp\\u.exe' }], source: 'scheduledtasks', failure: null }]
    })
  });
  assert.equal(fields.scheduledTaskWarning.status, Status.WARNING);
  assert.deepEqual(fields.scheduledTaskWarning.value, ['Updater']);
});

test('the query is read-only and asks for the fields the summary uses', async () => {
  let script = '';
  await providerOf(registerSoftware, 'powershell.scheduledTasks').collect({
    permissions: {},
    runner: {
      powershellJson: async (body) => {
        script = body;
        return { ok: true, data: [{ items: [], source: 'scheduledtasks', failure: null }] };
      }
    },
    logger: null,
    timeoutMs: 5000
  });
  assert.match(script, /Get-ScheduledTask/);
  assert.match(script, /schtasks\.exe \/query/);
  assert.match(script, /TaskName/, 'the name is what the list is built from');
  assert.match(script, /Actions/, 'the action is what a security review reads');
  assert.ok(!/Register-ScheduledTask|Unregister-ScheduledTask|Start-ScheduledTask|Stop-ScheduledTask|Set-ScheduledTask|Disable-ScheduledTask|Enable-ScheduledTask/i.test(script), 'a diagnostic must never change a task');
});

test('the task is registered against the software module with a plausible-count guard', () => {
  const task = taskOf(registerSoftware, 'software.scheduledTasks');
  assert.equal(task.module, 'software');
  assert.deepEqual(task.providers, ['powershell.scheduledTasks']);
  assert.deepEqual(task.validate({ scheduledTaskCount: { value: 120 } }), []);
  assert.match(task.validate({ scheduledTaskCount: { value: -1 } })[0], /negative/);
  assert.match(task.validate({ scheduledTaskCount: { value: 99999 } })[0], /implausible/);
});

// ═══ The startup folders ═══════════════════════════════════════════════════

test('the startup query reads the Startup folders, not only the Run keys', async () => {
  // The provider's title has said "Run keys and startup folders" since it was written, and the
  // script only ever read the keys. A shortcut in shell:startup - the way Windows itself tells
  // users to make something start - was invisible.
  let script = '';
  await providerOf(registerSoftware, 'powershell.startup').collect({
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
  assert.match(script, /GetFolderPath\('Startup'\)/);
  assert.match(script, /GetFolderPath\('CommonStartup'\)/);
  assert.match(script, /\.lnk/, 'shortcuts are how the Startup folder holds a program');
  assert.ok(!/Remove-Item|New-Item|Move-Item|Set-ItemProperty/i.test(script), 'reading a startup folder must never change it');
});

test('a startup entry found in a folder keeps its location label', async () => {
  const fields = await providerOf(registerSoftware, 'powershell.startup').collect({
    permissions: {},
    runner: {
      powershellJson: async () => ({
        ok: true,
        data: [{ name: 'Steam', command: 'C:\\Users\\demo\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Steam.lnk', location: 'Startup folder (user)' }]
      })
    },
    logger: null,
    timeoutMs: 5000
  });
  assert.equal(fields.startupEntries.value, 1);
  assert.equal(fields.startupEntryList.value[0].location, 'Startup folder (user)');
});
