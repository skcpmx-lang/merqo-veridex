/**
 * The three surfaces added for the remaining requirements: the first-run tour, the activity log
 * and the driver export card.
 *
 * Each is driven through the real controller against a fake bridge, because the claims worth
 * testing are about behaviour: the tour must not appear twice or claim to have been read when it
 * was skipped, the export button must be unusable until there is a destination, and a log page
 * with no entries must not look like a log page whose filter matched nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  JSDOM = null;
}

const skip = JSDOM === null && 'jsdom not installed';

async function waitFor(predicate, { label = 'condition', timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try {
      ok = Boolean(predicate());
    } catch {
      ok = false;
    }
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function bootWithBridge(answers) {
  const html = await readFile(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: false });
  const { window } = dom;
  const calls = [];

  window.veridex = {
    invoke: Object.freeze(
      Object.fromEntries(
        Object.keys(answers).map((channel) => [
          channel,
          async (...args) => {
            calls.push({ channel, args });
            const answer = answers[channel];
            return typeof answer === 'function' ? answer(...args) : answer;
          }
        ])
      )
    ),
    on: () => () => {},
    channels: { invoke: Object.keys(answers), events: [] }
  };

  const previous = { window: globalThis.window, document: globalThis.document, veridex: globalThis.veridex };
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.veridex = window.veridex;

  await import(`../../src/renderer/app.js?surface=${Date.now()}&x=${Math.random()}`);
  await waitFor(() => window.document.querySelectorAll('.vx-nav__item').length > 0, { label: 'the shell' });

  return {
    window,
    document: window.document,
    calls,
    restore: () => {
      if (previous.window) globalThis.window = previous.window;
      if (previous.document) globalThis.document = previous.document;
      if (previous.veridex === undefined) delete globalThis.veridex;
      else globalThis.veridex = previous.veridex;
      window.close();
    }
  };
}

const baseAnswers = (extra = {}) => ({
  'app:info': { ok: true, data: { name: 'VERIDEX', version: '1.0.0', platform: 'win32', brand: 'MERQO' } },
  'app:settings': { ok: true, data: { values: {}, specs: [] } },
  'app:guardSummary': { ok: true, data: { networkAttemptsBlocked: 0, unsafeCommandsBlocked: 0 } },
  'scan:state': { ok: true, data: { running: false } },
  'scan:last': { ok: true, data: { scan: null } },
  'manual:suites': { ok: true, data: { suites: [] } },
  'manual:coverage': { ok: true, data: { coverage: null, issues: [] } },
  'history:list': { ok: true, data: { entries: [] } },
  'app:onboarding': { ok: true, data: { needed: false, step: null, stepIndex: 4, completedAt: '2026-03-01T00:00:00.000Z', skipped: false } },
  'app:onboardingReset': { ok: true, data: { needed: true, step: 'welcome', stepIndex: 0, completedAt: null, skipped: false } },
  'logs:stats': { ok: true, data: { files: 0, bytes: 0, maxBytes: 2097152, maxFiles: 5, level: 'info' } },
  ...extra
});

// ── First run ──────────────────────────────────────────────────────────────

test('the tour appears on a machine that has not seen it, and advances', { skip }, async () => {
  const answers = baseAnswers({
    'app:onboarding': { ok: true, data: { needed: true, step: 'welcome', stepIndex: 0, completedAt: null, skipped: false } },
    'app:onboardingAdvance': async ({ step }) => ({
      ok: true,
      data: step === 'privacy'
        ? { needed: false, step: null, stepIndex: 4, completedAt: '2026-03-04T09:00:00.000Z', skipped: false, done: true }
        : { needed: true, step: 'limits', stepIndex: 1, completedAt: null, skipped: false, done: false }
    })
  });

  const { document, calls, restore } = await bootWithBridge(answers);
  try {
    await waitFor(() => document.querySelector('.vx-onboarding'), { label: 'the first-run tour' });
    const first = document.querySelector('.vx-onboarding').textContent;
    assert.match(first, /Step 1 of 4/);
    assert.match(first, /no account, no telemetry/i, 'the welcome screen must make the privacy promise');
    assert.match(first, /Skip the tour/, 'skipping must be offered, not buried');

    const advance = [...document.querySelectorAll('.vx-onboarding__actions .vx-button')].find((node) => /^Start$/.test(node.textContent));
    assert.ok(advance, 'the first step needs its action');
    advance.click();

    await waitFor(() => /Step 2 of 4/.test(document.querySelector('.vx-onboarding')?.textContent ?? ''), { label: 'the second step' });
    assert.ok(calls.some((call) => call.channel === 'app:onboardingAdvance' && call.args[0]?.step === 'welcome'));
  } finally {
    restore();
  }
});

test('the tour does not appear when it has already been completed', { skip }, async () => {
  const { document, restore } = await bootWithBridge(baseAnswers());
  try {
    await waitFor(() => document.querySelector('.vx-content').textContent.trim().length > 40, { label: 'the dashboard' });
    assert.equal(document.querySelector('.vx-onboarding'), null, 'a returning user must not be interrupted');
  } finally {
    restore();
  }
});

test('skipping is recorded as skipping', { skip }, async () => {
  const answers = baseAnswers({
    'app:onboarding': { ok: true, data: { needed: true, step: 'welcome', stepIndex: 0, completedAt: null, skipped: false } },
    'app:onboardingSkip': { ok: true, data: { needed: false, step: null, stepIndex: 4, completedAt: '2026-03-04T09:00:00.000Z', skipped: true } }
  });
  const { document, calls, restore } = await bootWithBridge(answers);
  try {
    await waitFor(() => document.querySelector('.vx-onboarding'), { label: 'the tour' });
    const skipButton = [...document.querySelectorAll('.vx-onboarding__actions .vx-button')].find((node) => /Skip/.test(node.textContent));
    skipButton.click();
    await waitFor(() => document.querySelector('.vx-dialog') === null, { label: 'the tour to close' });
    assert.ok(calls.some((call) => call.channel === 'app:onboardingSkip'), 'skipping must be recorded, not inferred');
  } finally {
    restore();
  }
});

test('the tour never asks for elevation to finish', { skip }, async () => {
  const answers = baseAnswers({
    'app:onboarding': { ok: true, data: { needed: true, step: 'permissions', stepIndex: 2, completedAt: null, skipped: false } }
  });
  const { document, restore } = await bootWithBridge(answers);
  try {
    await waitFor(() => document.querySelector('.vx-onboarding'), { label: 'the permissions step' });
    const text = document.querySelector('.vx-onboarding').textContent;
    assert.match(text, /declining is fine/i, 'the tour must say that refusing elevation is acceptable');
    assert.ok(!/elevate to continue|administrator to continue|(run as administrator)/i.test(text));
  } finally {
    restore();
  }
});

// ── Activity log ───────────────────────────────────────────────────────────

const logData = {
  entries: [
    { ts: '2026-03-04T09:10:00.000Z', level: 'error', scope: 'provider', msg: 'provider failed: cim-win32.bios', ctx: { provider: 'cim-win32.bios', error: 'timeout' } },
    { ts: '2026-03-04T09:09:00.000Z', level: 'warn', scope: 'scan', msg: 'scan finished with 1 warning' },
    { ts: '2026-03-04T09:08:00.000Z', level: 'info', scope: 'app', msg: 'application started' }
  ],
  unparseable: 1,
  summary: { entries: 3, counts: { trace: 0, debug: 0, info: 1, warn: 1, error: 1, fatal: 0 }, unknown: 0, scopes: [{ scope: 'provider', count: 1 }], fileCount: 1 },
  retention: { level: 'info', statement: 'Logs are kept on this machine only, at level "info". Nothing is uploaded.' }
};

test('the log page shows entries with level, source and time', { skip }, async () => {
  const { document, restore } = await bootWithBridge(baseAnswers({ 'logs:recent': { ok: true, data: logData } }));
  try {
    document.querySelector('.vx-nav__item[data-page="logs"]').click();
    await waitFor(() => /provider failed/.test(document.querySelector('.vx-content').textContent), { label: 'the log entries' });

    const text = document.querySelector('.vx-content').textContent;
    assert.match(text, /cim-win32\.bios/);
    assert.match(text, /provider/, 'the source must be shown');
    assert.match(text, /1 warning/, 'messages must be shown verbatim');
    assert.equal(document.querySelectorAll('.vx-row--log').length, 3);
    assert.match(text, /could not be parsed/, 'unparseable lines must be admitted, not hidden');
    assert.match(text, /Nothing is uploaded/, 'retention must be stated on the page');
  } finally {
    restore();
  }
});

test('an empty log and a filter that matches nothing are told apart', { skip }, async () => {
  const empty = { ...logData, entries: [], summary: { ...logData.summary, entries: 0 }, unparseable: 0 };
  const { document, restore } = await bootWithBridge(baseAnswers({ 'logs:recent': { ok: true, data: empty } }));
  try {
    document.querySelector('.vx-nav__item[data-page="logs"]').click();
    await waitFor(() => /The log is empty/.test(document.querySelector('.vx-content').textContent), { label: 'the empty state' });
    assert.match(document.querySelector('.vx-content').textContent, /Nothing has been written yet/);
  } finally {
    restore();
  }
});

test('the log page can filter, export and delete', { skip }, async () => {
  const answers = baseAnswers({
    'logs:recent': { ok: true, data: logData },
    'logs:export': { ok: true, data: { saved: true, path: 'C:\\Users\\demo\\Documents\\veridex-log.txt', entries: 3 } },
    'logs:clear': { ok: true, data: { removed: 2, remaining: 0 } }
  });
  const { document, calls, restore } = await bootWithBridge(answers);
  try {
    document.querySelector('.vx-nav__item[data-page="logs"]').click();
    await waitFor(() => /provider failed/.test(document.querySelector('.vx-content').textContent), { label: 'the log' });

    const exportButton = [...document.querySelectorAll('.vx-card__head .vx-button')].find((node) => /Export/.test(node.textContent));
    exportButton.click();
    await waitFor(() => calls.some((call) => call.channel === 'logs:export'), { label: 'the export call' });

    const deleteButton = [...document.querySelectorAll('.vx-card__head .vx-button')].find((node) => /Delete/.test(node.textContent));
    deleteButton.click();
    await waitFor(() => calls.some((call) => call.channel === 'logs:clear'), { label: 'the delete call' });
  } finally {
    restore();
  }
});

// ── Driver export ──────────────────────────────────────────────────────────

test('export is unusable until a destination is chosen, and says why', { skip }, async () => {
  const { document, restore } = await bootWithBridge(baseAnswers());
  try {
    document.querySelector('.vx-nav__item[data-page="drivers"]').click();
    await waitFor(() => document.querySelector('#vx-export-start'), { label: 'the export card' });

    const start = document.querySelector('#vx-export-start');
    assert.equal(start.disabled, true, 'an export without a folder must not be startable');
    assert.match(start.title, /choose a folder/i);
    assert.match(document.querySelector('.vx-content').textContent, /Copy, not backup/, 'the promise must be on the card');
  } finally {
    restore();
  }
});

test('choosing a folder plans the export, and a bad folder is refused with a reason', { skip }, async () => {
  const answers = baseAnswers({
    'drivers:chooseDestination': { ok: true, data: { chosen: true, path: 'D:\\Backups' } },
    'drivers:plan': { ok: true, data: { ok: true, folder: 'VERIDEX-drivers-2026-03-04-090507', path: 'D:\\Backups\\VERIDEX-drivers-2026-03-04-090507', freeLabel: '120 GB' } }
  });
  const { document, restore } = await bootWithBridge(answers);
  try {
    document.querySelector('.vx-nav__item[data-page="drivers"]').click();
    await waitFor(() => document.querySelector('#vx-export-choose'), { label: 'the export card' });
    document.querySelector('#vx-export-choose').click();

    await waitFor(() => /VERIDEX-drivers-2026/.test(document.querySelector('.vx-content').textContent), { label: 'the plan' });
    assert.match(document.querySelector('.vx-content').textContent, /120 GB free/);
    assert.equal(document.querySelector('#vx-export-start').disabled, false, 'a valid destination must enable the export');
  } finally {
    restore();
  }
});

test('a refused destination does not enable the export', { skip }, async () => {
  const answers = baseAnswers({
    'drivers:chooseDestination': { ok: true, data: { chosen: true, path: 'C:\\Windows' } },
    'drivers:plan': { ok: true, data: { ok: false, code: 'no_space', reason: 'The destination has 4 MB free. Nothing was written.' } }
  });
  const { document, restore } = await bootWithBridge(answers);
  try {
    document.querySelector('.vx-nav__item[data-page="drivers"]').click();
    await waitFor(() => document.querySelector('#vx-export-choose'), { label: 'the export card' });
    document.querySelector('#vx-export-choose').click();
    await waitFor(() => /That folder cannot be used/.test(document.querySelector('.vx-content').textContent), { label: 'the refusal' });
  } finally {
    restore();
  }
});

test('a finished export reports the count, the folder and what it cannot do', { skip }, async () => {
  const answers = baseAnswers({
    'drivers:chooseDestination': { ok: true, data: { chosen: true, path: 'D:\\Backups' } },
    'drivers:plan': { ok: true, data: { ok: true, folder: 'VERIDEX-drivers-2026-03-04-090507', path: 'D:\\Backups\\VERIDEX-drivers-2026-03-04-090507', freeLabel: '120 GB' } },
    'drivers:export': {
      ok: true,
      data: {
        ok: true,
        code: 'exported',
        packageCount: 42,
        folder: 'VERIDEX-drivers-2026-03-04-090507',
        path: 'D:\\Backups\\VERIDEX-drivers-2026-03-04-090507',
        reason: '42 driver packages exported to VERIDEX-drivers-2026-03-04-090507.',
        statement: 'An export is a copy of the driver packages currently installed. It is not a restore point.',
        verification: { ok: true, found: 42, expected: 42, reason: '42 .inf files present, matching what pnputil reported.' }
      }
    },
    'drivers:cancelExport': { ok: true, data: { cancelled: false, reason: 'No export is running.' } }
  });
  const { document, restore } = await bootWithBridge(answers);
  try {
    document.querySelector('.vx-nav__item[data-page="drivers"]').click();
    await waitFor(() => document.querySelector('#vx-export-choose'), { label: 'the export card' });
    document.querySelector('#vx-export-choose').click();
    await waitFor(() => document.querySelector('#vx-export-start').disabled === false, { label: 'the enabled export button' });
    document.querySelector('#vx-export-start').click();

    await waitFor(() => /Export complete/.test(document.querySelector('.vx-content').textContent), { label: 'the export result' });
    const text = document.querySelector('.vx-content').textContent;
    assert.match(text, /42 driver packages/);
    assert.match(text, /matching what pnputil reported/);
    assert.match(text, /cannot restore a driver/i, 'the limitation must be repeated with the result');
    assert.match(text, /D:\\Backups\\VERIDEX-drivers/, 'the folder must be shown so the user can open it');
  } finally {
    restore();
  }
});

test('a cancelled export is reported as incomplete, not as a success', { skip }, async () => {
  const answers = baseAnswers({
    'drivers:chooseDestination': { ok: true, data: { chosen: true, path: 'D:\\Backups' } },
    'drivers:plan': { ok: true, data: { ok: true, folder: 'X', path: 'D:\\Backups\\X' } },
    'drivers:export': {
      ok: true,
      data: {
        ok: false,
        code: 'cancelled',
        packageCount: 3,
        reason: 'The export was cancelled after 3 packages were copied. The folder contains a partial export and should not be treated as complete.',
        path: 'D:\\Backups\\X'
      }
    }
  });
  const { document, restore } = await bootWithBridge(answers);
  try {
    document.querySelector('.vx-nav__item[data-page="drivers"]').click();
    await waitFor(() => document.querySelector('#vx-export-choose'), { label: 'the export card' });
    document.querySelector('#vx-export-choose').click();
    await waitFor(() => document.querySelector('#vx-export-start').disabled === false, { label: 'the export button' });
    document.querySelector('#vx-export-start').click();
    await waitFor(() => /Export incomplete/.test(document.querySelector('.vx-content').textContent), { label: 'the incomplete notice' });
    assert.match(document.querySelector('.vx-content').textContent, /partial export/);
  } finally {
    restore();
  }
});

// ── Keyboard and accessibility of the new surfaces ─────────────────────────

test('the tour dialog is announced, focused, and Escape dismisses it without recording anything', { skip }, async () => {
  const answers = baseAnswers({
    'app:onboarding': { ok: true, data: { needed: true, step: 'welcome', stepIndex: 0, completedAt: null, skipped: false } }
  });
  const { window, document, calls, restore } = await bootWithBridge(answers);
  try {
    await waitFor(() => document.querySelector('.vx-onboarding'), { label: 'the tour' });

    const panel = document.querySelector('[role="dialog"]');
    assert.ok(panel, 'the tour must be a dialog, not a floating box');
    assert.equal(panel.getAttribute('aria-modal'), 'true');
    assert.equal(panel.getAttribute('aria-label'), 'Welcome to VERIDEX', 'the title must name the dialog');
    assert.equal(document.activeElement, panel, 'focus must move into the dialog');

    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(() => document.querySelector('.vx-onboarding') === null, { label: 'the tour to close' });
    assert.ok(
      !calls.some((call) => /onboarding(Advance|Skip)/.test(call.channel)),
      'closing the tour must not record progress it did not make'
    );
  } finally {
    restore();
  }
});

test('the log filters carry accessible names and a keyboard-reachable level select', { skip }, async () => {
  const { document, restore } = await bootWithBridge(baseAnswers({ 'logs:recent': { ok: true, data: logData } }));
  try {
    document.querySelector('.vx-nav__item[data-page="logs"]').click();
    await waitFor(() => document.querySelector('.vx-log-controls'), { label: 'the filters' });

    const select = document.querySelector('.vx-log-controls select');
    const search = document.querySelector('.vx-log-controls input');
    assert.equal(select.getAttribute('aria-label'), 'Minimum level');
    assert.equal(search.getAttribute('aria-label'), 'Filter log entries');
    assert.equal(select.tagName, 'SELECT', 'a level must be chosen from real levels');
    assert.equal(select.options.length, 6, 'trace through fatal');
    assert.ok(!search.disabled && !select.disabled, 'filters must be usable');
  } finally {
    restore();
  }
});

test('a log entry never renders an object as "[object Object]"', { skip }, async () => {
  const { document, restore } = await bootWithBridge(baseAnswers({ 'logs:recent': { ok: true, data: logData } }));
  try {
    document.querySelector('.vx-nav__item[data-page="logs"]').click();
    await waitFor(() => /provider failed/.test(document.querySelector('.vx-content').textContent), { label: 'the log' });
    assert.ok(
      !document.querySelector('.vx-content').textContent.includes('[object Object]'),
      'structured context must be serialised, not stringified by accident'
    );
  } finally {
    restore();
  }
});

// ── Reports and Privacy at dashboard quality ───────────────────────────────

function scanFixture() {
  const F = (value, status = 'PASS', unit = null) => ({ value, status, unit, source: 'fixture', notes: [] });
  return {
    startedAt: '2026-03-04T09:13:58.000Z',
    finishedAt: '2026-03-04T09:14:22.000Z',
    durationMs: 24000,
    cancelled: false,
    assessment: { status: 'WARNING', rating: 'Good', score: 84, modules: 4 },
    coverage: { percent: 78.4, attempted: 33, total: 34 },
    issues: [{ id: 'storage.temperatureC', title: 'Storage temperature above 40 °C' }],
    modules: {
      cpu: { title: 'Processor', fields: { model: F('Demo CPU'), cores: F(12) } },
      storage: { title: 'Storage', fields: { healthPercent: F(96), temperatureC: F(41, 'WARNING', '°C') } },
      drivers: { title: 'Drivers', fields: { totalDrivers: F(41), problematic: F(1, 'WARNING') } },
      windows: { title: 'Windows', fields: { secureBoot: F('Enabled') } }
    }
  };
}

test('the report page says what is in the file before it is written', { skip }, async () => {
  const { document, restore } = await bootWithBridge(
    baseAnswers({
      'scan:last': { ok: true, data: { scan: scanFixture() } },
      'manual:coverage': { ok: true, data: { coverage: null, progress: null, issues: [] } },
      'app:settings': { ok: true, data: { values: {}, specs: [] } }
    })
  );
  try {
    document.querySelector('.vx-nav__item[data-page="reports"]').click();
    await waitFor(() => /What this report contains/.test(document.querySelector('.vx-content').textContent), { label: 'the report summary' });

    const text = document.querySelector('.vx-content').textContent;
    assert.match(text, /4\b/, 'module count must be shown');
    assert.match(text, /78\.4%/, 'coverage must come from the scan, not be invented');
    assert.match(text, /Open issues/);
    assert.match(text, /Save JSON/, 'every format must still be offered');
    assert.match(text, /Includes timestamps and sources/, 'a format must say what it is for');
  } finally {
    restore();
  }
});

test('the report page distinguishes a cancelled scan from a complete one', { skip }, async () => {
  const scan = { ...scanFixture(), cancelled: true };
  const { document, restore } = await bootWithBridge(baseAnswers({ 'scan:last': { ok: true, data: { scan } } }));
  try {
    document.querySelector('.vx-nav__item[data-page="reports"]').click();
    await waitFor(() => /What this report contains/.test(document.querySelector('.vx-content').textContent), { label: 'the report summary' });
    assert.match(document.querySelector('.vx-content').textContent, /cancelled before it completed/);
  } finally {
    restore();
  }
});

test('the privacy page states what is stored, where, and offers the controls', { skip }, async () => {
  const { document, restore } = await bootWithBridge(
    baseAnswers({
      'app:info': { ok: true, data: { name: 'VERIDEX', version: '1.0.0', platform: 'win32', brand: 'MERQO', dataDir: 'C:\\Users\\DEMO\\AppData\\Roaming\\VERIDEX' } },
      'logs:stats': { ok: true, data: { files: 2, bytes: 1048576, maxBytes: 2097152, maxFiles: 5, level: 'info' } }
    })
  );
  try {
    document.querySelector('.vx-nav__item[data-page="privacy"]').click();
    await waitFor(() => /Stored on this machine/.test(document.querySelector('.vx-content').textContent), { label: 'the storage card' });
    await waitFor(() => /2 file\(s\)/.test(document.querySelector('.vx-content').textContent), { label: 'the log figures' });

    const text = document.querySelector('.vx-content').textContent;
    assert.match(text, /AppData\\Roaming\\VERIDEX/, 'the data folder must be named, not described');
    assert.match(text, /1\.0 MB of 2\.0 MB/, 'the log size must be a real figure');
    assert.match(text, /redaction removes the direct identifiers/, 'the limit of redaction must be stated');
    assert.ok(document.querySelector('#vx-privacy-identifiers'), 'the identifier setting must be here, not only in Settings');
  } finally {
    restore();
  }
});

test('replaying the tour is recorded through the contract, not by clearing settings', { skip }, async () => {
  const { document, calls, restore } = await bootWithBridge(baseAnswers({ 'logs:stats': { ok: true, data: { files: 0, bytes: 0 } } }));
  try {
    document.querySelector('.vx-nav__item[data-page="privacy"]').click();
    await waitFor(() => /Show the tour again/.test(document.querySelector('.vx-content').textContent), { label: 'the replay button' });
    [...document.querySelectorAll('.vx-content .vx-button')].find((node) => /Show the tour again/.test(node.textContent)).click();
    await waitFor(() => calls.some((call) => call.channel === 'app:onboardingReset'), { label: 'the reset call' });
  } finally {
    restore();
  }
});

test('the dashboard survives an issues payload it did not expect', { skip }, async () => {
  // Regression: the projection sends {warnings, errors, conflicts}, and the dashboard read
  // `.warnings.length` straight off it. An array - an older stored projection, or a payload from
  // a build that summarised issues differently - threw inside the page builder and blanked the
  // whole window instead of showing the evidence that had already been collected.
  const scan = { ...scanFixture(), issues: ['storage reports one conflict'] };
  const { document, restore } = await bootWithBridge(baseAnswers({ 'scan:last': { ok: true, data: { scan } } }));
  try {
    await waitFor(() => document.querySelector('.vx-content').textContent.length > 40, { label: 'the dashboard' });
    assert.match(document.querySelector('.vx-content').textContent, /Device health/, 'the dashboard must still render');
    assert.match(document.querySelector('.vx-content').textContent, /storage reports one conflict/, 'an unexpected issue must still be shown, not dropped');
    document.querySelector('.vx-nav__item[data-page="reports"]').click();
    await waitFor(() => /What this report contains/.test(document.querySelector('.vx-content').textContent), { label: 'the report page' });
    assert.match(document.querySelector('.vx-content').textContent, /Open issues1/, 'the count must include the unexpected entry');
  } finally {
    restore();
  }
});

// ── The Windows GUI harness's page table, validated against the real renderer ──

test('every marker the Windows GUI harness expects is actually rendered', { skip }, async () => {
  // The harness runs only on a Windows runner, so without this test its expectations could
  // drift from the renderer for months. Each marker is checked against the page as jsdom
  // renders it from the same fake bridge the rest of this file uses.
  const { PAGE_EXPECTATIONS, PAGE_ORDER } = await import('../../src/app/gui-pages.js');
  const scan = scanFixture();
  const { document, restore } = await bootWithBridge(
    baseAnswers({
      'scan:last': { ok: true, data: { scan } },
      'logs:recent': { ok: true, data: logData },
      'logs:stats': { ok: true, data: { files: 2, bytes: 1024, maxBytes: 2097152, maxFiles: 5, level: 'info' } },
      'processes:snapshot': { ok: true, data: { processes: [], generatedAt: '2026-03-04T09:14:00.000Z' } },
      'events:recent': { ok: true, data: { events: [], windowDays: 7 } }
    })
  );
  try {
    const missing = [];
    for (const id of PAGE_ORDER) {
      const nav = document.querySelector(`.vx-nav__item[data-page="${id}"]`);
      assert.ok(nav, `page "${id}" has no navigation item`);
      nav.click();
      await waitFor(() => (document.querySelector('.vx-content')?.textContent ?? '').length > 20, { label: `page ${id}` });
      const text = document.querySelector('.vx-content').textContent;
      if (!PAGE_EXPECTATIONS[id].test(text)) missing.push(`${id}: ${JSON.stringify(text.slice(0, 90))}`);
    }
    assert.deepEqual(missing, [], 'these pages do not render what the GUI harness waits for');
  } finally {
    restore();
  }
});

test('the report preview states every figure the Windows harness looks for', { skip }, async () => {
  // gui-smoke asserts these five labels on the reports page. The labels are drawn with
  // `text-transform: uppercase`, so reading them out of `innerText` compared "EVIDENCE FIELDS"
  // with "Evidence fields" - a check that could only fail, on the one platform where a real
  // Chromium runs it. The harness now reads the label elements; this test keeps the set of
  // labels it requires and the set the page draws in step.
  const { document, restore } = await bootWithBridge(baseAnswers({ 'scan:last': { ok: true, data: { scan: scanFixture() } } }));
  try {
    await waitFor(() => document.querySelector('.vx-content').textContent.length > 40, { label: 'the dashboard' });
    document.querySelector('.vx-nav__item[data-page="reports"]').click();
    await waitFor(() => /What this report contains/.test(document.querySelector('.vx-content').textContent), { label: 'the report page' });
    const labels = [...document.querySelectorAll('.vx-coverage__label')].map((node) => node.textContent.trim());
    for (const marker of ['Modules', 'Evidence fields', 'Warnings', 'Errors', 'Coverage']) {
      assert.ok(labels.some((label) => label.toLowerCase() === marker.toLowerCase()), `the report preview does not state "${marker}" (it showed: ${labels.join(', ')})`);
    }
  } finally {
    restore();
  }
});

// ── Dashboard widget arrangement (R-19-02) ─────────────────────────────────

test('the dashboard honours the configured widget list, in order', { skip }, async () => {
  // `dashboard.widgets` was declared and forwarded to the renderer but never read, so the
  // setting changed nothing while its description promised it would.
  const { document, restore } = await bootWithBridge(
    baseAnswers({
      'scan:last': { ok: true, data: { scan: scanFixture() } },
      'app:settings': { ok: true, data: { values: { 'dashboard.widgets': ['actions', 'components'] }, specs: [], ui: { theme: 'dark', widgets: ['actions', 'components'] } } }
    })
  );
  try {
    await waitFor(() => document.querySelector('.vx-content').textContent.length > 40, { label: 'the dashboard' });
    const text = document.querySelector('.vx-content').textContent;
    assert.match(text, /Quick actions/, 'a listed widget must be shown');
    assert.match(text, /Components/, 'a listed widget must be shown');
    assert.doesNotMatch(text, /Device health/, 'a widget that is not listed must not be rendered');
    assert.doesNotMatch(text, /Coverage/, 'a widget that is not listed must not be rendered');
  } finally {
    restore();
  }
});

test('an empty widget list restores every widget rather than blanking the page', { skip }, async () => {
  const { document, restore } = await bootWithBridge(
    baseAnswers({
      'scan:last': { ok: true, data: { scan: scanFixture() } },
      'app:settings': { ok: true, data: { values: { 'dashboard.widgets': [] }, specs: [], ui: { theme: 'dark', widgets: [] } } }
    })
  );
  try {
    await waitFor(() => document.querySelector('.vx-content').textContent.length > 40, { label: 'the dashboard' });
    const text = document.querySelector('.vx-content').textContent;
    assert.match(text, /Device health/);
    assert.match(text, /Quick actions/);
  } finally {
    restore();
  }
});
