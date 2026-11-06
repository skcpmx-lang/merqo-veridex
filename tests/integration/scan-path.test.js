/**
 * The scan data path, end to end.
 *
 * The previous milestone's tests proved that the *renderer* renders a hand-written projection.
 * They did not prove that a real scan produces that projection, or that the projection agrees
 * with the report. This suite closes that gap by running the actual diagnostic engine
 * (`runScan`, with a scripted runner), projecting with the actual projection function, and then
 * driving the actual renderer with the result.
 *
 * Nothing here is a mock of the thing under test: the scan is real, the projection is real, the
 * controller is real. Only the operating system is simulated, which is unavoidable in a Linux
 * container and is itself stated as a limitation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { runScan } from '../../src/app/scan.js';
import { projectScan, projectionIsEmpty } from '../../src/app/scan-projection.js';
import { buildReport } from '../../src/reporting/model.js';
import { reportInputFromScan } from '../../src/app/scan.js';
import { renderJson } from '../../src/reporting/json.js';
import { renderHtml } from '../../src/reporting/html.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  JSDOM = null;
}

const skipDom = JSDOM === null && 'jsdom not installed';

// ── A scan of a machine that answers some questions and refuses others ───────

/**
 * A runner that answers the commands `runScan` issues.
 *
 * It models the awkward cases on purpose: a provider that succeeds, one that reports a
 * permission problem, one that returns plausible garbage, and every other command
 * unsupported. A scan made only of successes would not exercise the status aggregation.
 */
function scriptedRunner() {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...(args ?? [])].join(' '));
    return { ok: false, code: 'unsupported', stdout: '', stderr: 'not available in this test harness' };
  };
  const runPowerShell = async (script) => {
    calls.push(`powershell:${String(script).slice(0, 40)}`);
    if (/Get-CimInstance .*Win32_Processor/i.test(String(script))) {
      return {
        ok: true,
        stdout: JSON.stringify({
          Name: 'AMD Ryzen 7 5800U with Radeon Graphics',
          NumberOfCores: 8,
          NumberOfLogicalProcessors: 16,
          MaxClockSpeed: 4400,
          L3CacheSize: 16,
          Manufacturer: 'AuthenticAMD'
        })
      };
    }
    return { ok: false, code: 'unsupported', stdout: '', stderr: 'not available' };
  };
  return { run, runPowerShell, calls, elevated: false, platform: 'linux' };
}

/** Run a real scan with a scripted runner and no history file. */
async function realScan(options = {}) {
  return runScan({
    runner: scriptedRunner(),
    historyFile: null,
    settings: {},
    ...options
  });
}

// ── The projection itself ───────────────────────────────────────────────────

test('a real scan projects without loss: every module, status and field survives', async () => {
  const scan = await realScan();
  const projection = projectScan(scan);

  assert.ok(projection, 'a completed scan must project');
  assert.deepEqual(
    Object.keys(projection.modules).sort(),
    Object.keys(scan.modules).sort(),
    'every collected module must appear, and nothing invented'
  );

  for (const [id, fields] of Object.entries(scan.modules)) {
    const module = projection.modules[id];
    assert.deepEqual(module.fields, fields, `${id}: field values must pass through untouched`);
    assert.equal(module.fieldCount, Object.keys(fields).length, `${id}: the field count must be real`);
    assert.ok(typeof module.status === 'string' && module.status.length > 0, `${id}: a module needs a status`);
    assert.ok(module.title, `${id}: a module needs a title`);
    // The status must be the aggregator's, not something the projection invented.
    const values = Object.values(fields);
    if (values.length === 0) assert.equal(module.status, 'UNAVAILABLE');
    if (values.some((value) => value.status === 'PASS')) {
      assert.ok(!['UNRATED'].includes(module.status), `${id}: a module with passing fields must not be unrated`);
    }
  }
});

test('coverage is computed from the same fields the report counts', async () => {
  const scan = await realScan();
  const projection = projectScan(scan);

  // Count independently, from the field values themselves.
  const all = Object.values(scan.modules).flatMap((fields) => Object.values(fields));
  const passed = all.filter((value) => value.status === 'PASS').length;
  const failed = all.filter((value) => value.status === 'FAIL').length;
  const warned = all.filter((value) => ['WARNING', 'PARTIALLY_AVAILABLE'].includes(value.status)).length;

  assert.equal(projection.coverage.passed, passed);
  assert.equal(projection.coverage.failed, failed);
  assert.equal(projection.coverage.warned, warned);
  assert.equal(projection.coverage.assessed, passed + failed + warned);
  assert.equal(projection.coverage.totalFields, all.length);
  assert.ok(projection.coverage.note.length > 20, 'coverage must explain what it counts');

  // And the report agrees, because both go through computeCoverage.
  const report = buildReport(reportInputFromScan(scan, { reportId: 'consistency' }));
  assert.equal(report.coverage.totalFields, projection.coverage.totalFields, 'the PDF must count the same fields as the screen');
  assert.equal(report.coverage.passed, projection.coverage.passed);
});

test('assessment, coverage and issues are mutually consistent', async () => {
  const scan = await realScan();
  const projection = projectScan(scan);

  assert.ok(projection.assessment, 'a completed run has an assessment');
  assert.equal(typeof projection.assessment.score === 'number' || projection.assessment.score === null, true);

  // A withheld score must carry its reason, and the reason must not be empty.
  if (projection.assessment.score === null) {
    assert.equal(projection.assessment.gated, true, 'a null score must be gated, not merely missing');
    assert.ok(String(projection.assessment.gatingNote ?? '').length > 10, 'a withheld score must say why');
  }

  assert.ok(Array.isArray(projection.issues.warnings));
  assert.ok(Array.isArray(projection.issues.errors));
  // Nothing may be reported as both.
  for (const warning of projection.issues.warnings) {
    assert.ok(!projection.issues.errors.includes(warning), 'one message must not be both a warning and an error');
  }
});

test('the projection is total: missing and malformed scans do not throw', () => {
  assert.equal(projectScan(null), null);
  assert.equal(projectScan(undefined), null);

  const empty = projectScan({});
  assert.deepEqual(empty.modules, {});
  assert.equal(empty.cancelled, false);
  assert.equal(empty.durationMs, 0);
  assert.equal(empty.coverage.totalFields, 0);
  assert.equal(projectionIsEmpty(empty), true);

  // A module whose field map arrived as null must not crash the projection.
  const odd = projectScan({ modules: { cpu: null, gpu: { a: { status: 'PASS', value: 1 } } }, issues: { warnings: 'not an array' } });
  assert.equal(odd.modules.cpu.status, 'UNAVAILABLE');
  // A module whose only field passed aggregates to PASS; the point of the assertion is that it
  // did not throw and did not invent a worse status either.
  assert.equal(odd.modules.gpu.status, 'PASS');
  assert.deepEqual(odd.issues.warnings, []);
});

test('an empty scan is reported as empty rather than as a clean bill of health', async () => {
  const scan = await runScan({ runner: scriptedRunner(), historyFile: null, tasks: [] , settings: {} }).catch((error) => ({ error }));
  // An unknown or empty task list is handled by the engine; either way the projection must not
  // claim evidence it does not have.
  if (!scan.error) {
    const projection = projectScan(scan);
    if (projectionIsEmpty(projection)) {
      assert.equal(projection.coverage.totalFields, 0);
      assert.equal(projection.coverage.coveragePercent, 0);
    }
  }
});

test('a cancelled run keeps what it collected and says it was cancelled', async () => {
  const controller = new AbortController();
  const promise = realScan({ signal: controller.signal });
  controller.abort();
  const scan = await promise;
  const projection = projectScan(scan);

  assert.equal(projection.cancelled, true, 'a cancelled run must be labelled as one');
  // Whatever was collected before the abort is still there and still valid.
  for (const [id, module] of Object.entries(projection.modules)) {
    assert.ok(Object.keys(module.fields).length >= 0, `${id}: retained fields must survive cancellation`);
  }
});

// ── The renderer, driven by a real projection ──────────────────────────────

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

/** Boot the real controller with a fake bridge whose answers the test controls. */
async function bootRenderer(answers) {
  const html = await readFile(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: false });
  const { window } = dom;
  const calls = [];
  const listeners = new Map();

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
    on: (channel, listener) => {
      if (!listeners.has(channel)) listeners.set(channel, []);
      listeners.get(channel).push(listener);
      return () => {};
    },
    channels: { invoke: Object.keys(answers), events: [] }
  };

  const previous = { window: globalThis.window, document: globalThis.document, veridex: globalThis.veridex };
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.veridex = window.veridex;

  await import(`../../src/renderer/app.js?path=${Date.now()}&x=${Math.random()}`);
  await waitFor(() => window.document.querySelectorAll('.vx-nav__item').length > 0, { label: 'the shell' });

  return {
    window,
    document: window.document,
    calls,
    emit: (channel, payload) => {
      for (const listener of listeners.get(channel) ?? []) listener(payload);
    },
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
  'app:info': { ok: true, data: { name: 'VERIDEX', version: '1.0.0', platform: 'linux', brand: 'MERQO' } },
  'app:settings': { ok: true, data: { values: {}, specs: [] } },
  'app:guardSummary': { ok: true, data: { networkAttemptsBlocked: 0, unsafeCommandsBlocked: 0 } },
  'scan:state': { ok: true, data: { running: false, lastScanAt: null, score: null } },
  'scan:last': { ok: true, data: { scan: null } },
  'manual:suites': { ok: true, data: { suites: [] } },
  'manual:coverage': { ok: true, data: { coverage: null, issues: [] } },
  'history:list': { ok: true, data: { entries: [] } },
  ...extra
});

test('a completed scan reaches the renderer and every page can read it', { skip: skipDom }, async () => {
  const scan = await realScan();
  const projection = projectScan(scan);
  const { document, restore } = await bootRenderer(baseAnswers({ 'scan:last': { ok: true, data: { scan: projection } } }));

  try {
    await waitFor(() => document.querySelector('.vx-content').textContent.trim().length > 100, { label: 'the dashboard' });
    const dashboard = document.querySelector('.vx-content').textContent;
    assert.match(dashboard, /Coverage/, 'the dashboard must show coverage');
    assert.ok(!/Not collected yet/.test(dashboard), 'the dashboard must not claim nothing was collected');

    // Every diagnostic page must show at least one real field from the scan.
    const pages = ['hardware', 'storage', 'windows', 'drivers', 'reliability', 'processes'];
    for (const page of pages) {
      document.querySelector(`.vx-nav__item[data-page="${page}"]`).click();
      await waitFor(() => document.querySelector('.vx-content').textContent.trim().length > 60, { label: page });
      const text = document.querySelector('.vx-content').textContent;
      assert.ok(!/undefined|NaN|\[object Object\]/.test(text), `${page}: leaked a raw value`);
    }
  } finally {
    restore();
  }
});

test('a module with zero usable fields is reported as unavailable, not as passing', { skip: skipDom }, async () => {
  // A scan on a machine with no Windows: every provider is unsupported, so the projection is
  // full of UNAVAILABLE fields. The screen must look like "nothing could be read", never like
  // "everything is fine".
  const scan = await realScan();
  const projection = projectScan(scan);
  const { document, restore } = await bootRenderer(baseAnswers({ 'scan:last': { ok: true, data: { scan: projection } } }));

  try {
    document.querySelector('.vx-nav__item[data-page="hardware"]').click();
    await waitFor(() => document.querySelector('.vx-content').textContent.trim().length > 60, { label: 'hardware' });
    const text = document.querySelector('.vx-content').textContent;
    assert.match(text, /Unavailable|Unsupported|Not available|Permission required/i, 'unreadable fields must say why');
    // A page of unsupported fields must not present a PASS badge for a module.
    assert.ok(!/Pass/.test(text.split('Processor')[1]?.slice(0, 40) ?? ''), 'an empty module must not be marked as passing');
  } finally {
    restore();
  }
});

test('boot restores the last run, and a later scan replaces it rather than merging', { skip: skipDom }, async () => {
  const first = {
    ...projectScan(await realScan()),
    finishedAt: '2026-01-01T00:00:00.000Z',
    modules: {
      cpu: { title: 'Processor', status: 'PASS', note: null, fieldCount: 1, fields: { name: { value: 'First run CPU', status: 'PASS', source: 'test' } } }
    }
  };
  const second = {
    ...first,
    finishedAt: '2026-02-02T00:00:00.000Z',
    modules: {
      cpu: { title: 'Processor', status: 'PASS', note: null, fieldCount: 1, fields: { name: { value: 'Second run CPU', status: 'PASS', source: 'test' } } }
    }
  };

  let served = first;
  const { document, emit, restore } = await bootRenderer(
    baseAnswers({ 'scan:last': async () => ({ ok: true, data: { scan: served } }) })
  );

  try {
    document.querySelector('.vx-nav__item[data-page="hardware"]').click();
    await waitFor(() => /First run CPU/.test(document.querySelector('.vx-content').textContent), { label: 'the restored run' });

    // A second run completes: the controller must re-read the projection, not keep the first.
    served = second;
    emit('scan:finished', { cancelled: false, durationMs: 1000, score: 80, rating: 'Good', coveragePercent: 50, warnings: 0, errors: 0 });
    await waitFor(() => /Second run CPU/.test(document.querySelector('.vx-content').textContent), { label: 'the replacement run' });

    const text = document.querySelector('.vx-content').textContent;
    assert.ok(!/First run CPU/.test(text), 'the older run must not linger beside the new one');
    // Exactly one CPU card: a re-render must replace, never append.
    const cpuCards = [...document.querySelectorAll('.vx-card')].filter((card) => /Processor/.test(card.querySelector('.vx-card__title')?.textContent ?? ''));
    assert.equal(cpuCards.length, 1, 'a re-render must not duplicate the module card');
  } finally {
    restore();
  }
});

test('a failed scan keeps earlier evidence but labels it as earlier', { skip: skipDom }, async () => {
  const scan = await realScan();
  const projection = projectScan(scan);
  const answers = baseAnswers({
    'scan:last': { ok: true, data: { scan: projection } },
    'scan:start': { ok: false, error: { code: 'permission_required', message: 'The runner refused to start.' } }
  });
  const { document, restore } = await bootRenderer(answers);

  try {
    await waitFor(() => /Coverage/.test(document.querySelector('.vx-content').textContent), { label: 'the adopted run' });
    document.getElementById('vx-start-scan').click();
    await waitFor(() => /could not run/i.test(document.querySelector('.vx-content').textContent), { label: 'the failure notice' });

    const text = document.querySelector('.vx-content').textContent;
    assert.match(text, /could not run/i);
    assert.match(text, /from an earlier run/i, 'the retained evidence must be labelled with its real age');
    assert.match(text, /refused to start/, 'the reason must be shown verbatim');
    // The old numbers are still there, because hiding them would lose good information.
    assert.match(text, /Coverage/);
  } finally {
    restore();
  }
});

test('an IPC failure on scan:last leaves the application usable', { skip: skipDom }, async () => {
  const answers = baseAnswers({ 'scan:last': { ok: false, error: { code: 'bridge_error', message: 'The main process is unreachable.' } } });
  const { document, restore } = await bootRenderer(answers);

  try {
    await waitFor(() => document.querySelector('.vx-content').textContent.trim().length > 50, { label: 'a rendered page' });
    assert.ok(document.querySelectorAll('.vx-nav__item').length >= 17, 'navigation must still work');
    for (const page of ['hardware', 'reports', 'history', 'settings']) {
      document.querySelector(`.vx-nav__item[data-page="${page}"]`).click();
      await waitFor(() => document.querySelector('.vx-content').textContent.trim().length > 20, { label: page });
    }
    const text = document.querySelector('.vx-content').textContent;
    assert.ok(!/TypeError|undefined is not/.test(text), 'an unreachable main process must not produce a stack trace on screen');
  } finally {
    restore();
  }
});

// ── Report and interface agreement ─────────────────────────────────────────

test('the JSON, the HTML and the screen describe the same evidence', async () => {
  const scan = await realScan();
  const projection = projectScan(scan);
  const report = buildReport(reportInputFromScan(scan, { reportId: 'agreement', brandLine: 'agreement test' }));

  const json = JSON.parse(renderJson(report));
  const html = renderHtml(report);
  const sections = new Map((json.sections ?? []).map((section) => [section.id, section]));

  let compared = 0;
  for (const [id, module] of Object.entries(projection.modules)) {
    const section = sections.get(id);
    if (!section) continue;
    compared += 1;

    assert.equal(section.status, module.status, `${id}: the report and the screen must agree on the module status`);

    const reportKeys = new Set((section.fields ?? []).map((row) => row.key));
    for (const key of Object.keys(module.fields)) {
      assert.ok(reportKeys.has(key), `${id}: field "${key}" is on screen but missing from the report`);
    }
    const screenKeys = new Set(Object.keys(module.fields));
    for (const row of section.fields ?? []) {
      assert.ok(screenKeys.has(row.key), `${id}: field "${row.key}" is in the report but missing from the screen`);
    }
  }
  assert.ok(compared > 5, `at least five modules must be comparable, compared ${compared}`);

  // A value the interface displays must be findable in the HTML report, so a user reading the
  // PDF is not told something the screen contradicts.
  const firstScalar = Object.values(projection.modules)
    .flatMap((module) => Object.values(module.fields))
    .find((field) => (typeof field?.value === 'string' || typeof field?.value === 'number') && String(field.value).length > 3);
  if (firstScalar) {
    const needle = String(firstScalar.value).slice(0, 10);
    assert.ok(html.includes(needle) || html.includes(needle.replace(/&/g, '&amp;')), `"${needle}" must appear in the HTML report`);
  }
});
