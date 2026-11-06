/**
 * Contract tests: fixtures must be the production shapes, in both directions.
 *
 * The bug this file exists to prevent was real and shipped: the Reports page read
 * `coverage.percent`, the main process emitted `coverage.coveragePercent`, and the jsdom fixture
 * supplied `{ percent }`. The page therefore showed an em dash on every real scan while its test
 * passed, and the same fixture kept a second bug ("Unrated · null/100") green. A fixture that
 * invents a property does not test the product; it tests the fixture.
 *
 * Two different techniques are used here, because each covers what the other misses:
 *
 *   1. **Shape equality** — the projection is built from a synthetic scan and its key set is
 *      compared with the fixture's, in both directions.
 *   2. **Real-data rendering** — the renderer is booted with `scan:last` set to an actual
 *      `projectScan()` result, not a hand-written object. No fixture sits between production code
 *      and the assertions, so drift cannot hide.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { projectScan, projectionIsEmpty } from '../../src/app/scan-projection.js';
import { mapCpuBenchmarkResults } from '../../src/benchmarking/cpu-bench.js';
import { computeCoverage } from '../../src/reporting/model.js';
import { Status } from '../../src/core/status.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

let JSDOM = null;
try {
  JSDOM = (await import('jsdom')).JSDOM;
} catch {
  JSDOM = null;
}

const F = (value, status = 'PASS', unit = null) => ({ value, status, unit, source: 'fixture', notes: [] });

/** A scan as `src/app/scan.js` produces it: modules of FieldValues plus an assessment and issues. */
function productionScan(overrides = {}) {
  const modules = {
    cpu: { model: F('Demo CPU'), cores: F(12), loadPercent: F(12, 'PASS') },
    memory: { totalGb: F(32, 'PASS', 'GB') },
    storage: { healthPercent: F(96), temperatureC: F(41, 'WARNING', '°C') },
    windows: { secureBoot: F('Enabled'), bitLocker: F(null, 'BLOCKED') }
  };
  return {
    startedAt: '2026-03-04T09:13:58.000Z',
    finishedAt: '2026-03-04T09:14:22.000Z',
    durationMs: 24_000,
    taskCount: 4,
    providersAttempted: 12,
    cancelled: false,
    sectionTitles: { cpu: 'Processor', memory: 'Memory', storage: 'Storage', windows: 'Windows & security' },
    assessment: {
      score: 84,
      rating: 'Good',
      status: 'WARNING',
      gated: false,
      coveragePercent: 78.4,
      ratedComponents: 6,
      totalComponents: 8,
      components: [{ id: 'cpu', label: 'Processor', score: 90, status: 'PASS' }],
      gatingNote: null,
      disclaimer: 'A score summarises the evidence that was collected.'
    },
    issues: {
      warnings: [{ id: 'storage.temperatureC', title: 'Storage temperature above 40 °C' }],
      errors: [],
      conflicts: []
    },
    modules,
    ...overrides
  };
}

async function bootWithBridge(answers) {
  const html = await readFile(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: false });
  const { window } = dom;
  window.veridex = {
    invoke: Object.freeze(
      Object.fromEntries(Object.keys(answers).map((channel) => [channel, async (...args) => answers[channel](...args)]))
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

  await import(`../../src/renderer/app.js?contract=${Date.now()}`);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && window.document.querySelectorAll('.vx-nav__item').length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return {
    window,
    document: window.document,
    restore: () => {
      if (previous.window) globalThis.window = previous.window;
      if (previous.document) globalThis.document = previous.document;
      if (previous.veridex === undefined) delete globalThis.veridex;
      else globalThis.veridex = previous.veridex;
      window.close();
    }
  };
}

/** Answers built from real projections rather than literals. */
function answersFor(projection, extra = {}) {
  return {
    'app:info': async () => ({ ok: true, data: { name: 'VERIDEX', version: '1.0.0', platform: 'win32' } }),
    'app:settings': async () => ({ ok: true, data: { values: {}, specs: [] } }),
    'app:guardSummary': async () => ({ ok: true, data: { networkAttemptsBlocked: 0, unsafeCommandsBlocked: 0 } }),
    'scan:state': async () => ({ ok: true, data: { running: false, finished: null } }),
    'scan:last': async () => ({ ok: true, data: { scan: projection } }),
    'manual:suites': async () => ({ ok: true, data: { suites: [] } }),
    'manual:coverage': async () => ({ ok: true, data: { coverage: null, progress: null, issues: [] } }),
    'history:list': async () => ({ ok: true, data: { entries: [] } }),
    'bench:state': async () => ({ ok: true, data: { cpu: null, disk: null, running: false } }),
    'stress:state': async () => ({ ok: true, data: { running: false, capabilities: { kinds: ['cpu'] } } }),
    ...extra
  };
}

const waitFor = async (predicate, label = 'condition') => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
};

// ── Shape equality ──────────────────────────────────────────────────────────

test('the scan projection carries every key the pages read, and invents none', () => {
  const projection = projectScan(productionScan());
  for (const key of ['startedAt', 'finishedAt', 'durationMs', 'cancelled', 'taskCount', 'assessment', 'coverage', 'issues', 'modules']) {
    assert.ok(key in projection, `projection must carry ${key}`);
  }
  // The two keys the Reports page reads and the dashboard reads.
  assert.ok('coveragePercent' in projection.coverage, 'coverage must carry the percentage the pages print');
  assert.ok('totalFields' in projection.coverage);
  assert.ok('manual' in projection.coverage);
  assert.ok(!('percent' in projection.coverage), 'the projection must not carry a key nothing writes');
});

test('a module with an unexpected field keeps it: evidence is never silently dropped', () => {
  const scan = productionScan({
    modules: { cpu: { model: F('Demo CPU'), somethingNew: F(7, 'PASS', 'widgets') } },
    sectionTitles: {}
  });
  const projection = projectScan(scan);
  assert.ok('somethingNew' in projection.modules.cpu.fields, 'an unknown field must survive the projection');
  assert.equal(projection.modules.cpu.fields.somethingNew.value, 7);
  assert.equal(projection.modules.cpu.fieldCount, 2);
});

test('a projection of nothing is empty rather than crashy, and says so', () => {
  const projection = projectScan({});
  assert.equal(projectionIsEmpty(projection), true);
  assert.deepEqual(projection.modules, {});
  assert.equal(projection.assessment, null);
  assert.equal(projection.coverage.totalFields, 0);
  // A missing scan is null, not an empty object pretending to be one.
  assert.equal(projectScan(null), null);
});

test('null, missing and unknown statuses survive the projection without becoming passes', () => {
  const scan = productionScan({
    modules: { storage: { temperatureC: F(null, null), healthPercent: F(96, 'PASS'), weird: F('x', 'SOMETHING_ELSE') } }
  });
  const projection = projectScan(scan);
  assert.equal(projection.modules.storage.fields.temperatureC.value, null);
  assert.notEqual(projection.modules.storage.status, 'PASS', 'a module with a null field is not a clean module');
  assert.equal(projection.modules.storage.fields.weird.status, 'SOMETHING_ELSE', 'an unknown status is not rewritten');
});

test('coverage counts what was measured and excludes what could not be', () => {
  // Real status names only: "BLOCKED" is not a status, and a test written against it silently
  // exercised the default branch instead of the permission branch.
  const sections = [
    { rows: ['PASS', 'PASS', 'WARNING', 'PERMISSION_REQUIRED', 'UNSUPPORTED', 'UNTESTED'].map((status) => ({ status })) }
  ];
  const coverage = computeCoverage(sections, []);
  assert.equal(coverage.totalFields, 6);
  assert.equal(coverage.passed, 2);
  assert.equal(coverage.warned, 1);
  assert.equal(coverage.blocked, 1, 'a permission refusal is blocked, not a failure');
  assert.equal(coverage.unsupported, 1);
  assert.equal(coverage.untested, 1);
  assert.ok(coverage.coveragePercent < 100, 'unavailable and untested fields must not count as covered');
});

test('the benchmark field map is the shape the Performance page renders', () => {
  const fields = mapCpuBenchmarkResults({
    single: { opsPerSecond: 1_000_000, samples: [1_000_000, 990_000], spreadPercent: 1, checksumStable: true, error: null },
    multi: { threads: 4, opsPerSecond: 3_600_000, perThread: [900_000, 900_000, 900_000, 900_000], scaling: 3.6, error: null },
    memory: { sequentialGbps: 12.5, stridedGbps: 3.1, error: null }
  });
  assert.ok(Object.keys(fields).length >= 4);
  for (const [key, value] of Object.entries(fields)) {
    assert.ok('value' in value, `${key} must carry a value`);
    assert.ok('status' in value, `${key} must carry a status`);
    assert.ok('source' in value, `${key} must name its source`);
    assert.ok(value.notes === undefined || Array.isArray(value.notes), `${key} notes must be a list`);
    // A number carries its unit beside it; a sentence carries none. Values that bake units into
    // the string ("1%") cannot be aligned with the other figures or read by anything else.
    if (typeof value.value === 'number') {
      assert.equal(typeof value.unit, 'string', `${key} must have a unit when it has a number`);
      assert.ok(value.unit.length > 0, `${key} has an empty unit`);
    } else if (typeof value.value === 'string') {
      assert.ok(value.unit === null || value.unit === undefined, `${key} is a sentence but carries unit "${value.unit}"`);
    }
  }
  const units = new Set(Object.values(fields).map((value) => value.unit).filter(Boolean));
  for (const unit of units) assert.match(unit, /^(ops\/s|GB\/s|%|×|°C)$/, `unexpected unit ${unit}`);
  assert.equal(fields.sampleSpread.value, 1, 'the spread is a number with a unit, not "1%"');
  assert.equal(fields.sampleSpread.unit, '%');
});

test('a failed benchmark is reported as failed, never as zero', () => {
  const fields = mapCpuBenchmarkResults({
    single: { opsPerSecond: null, samples: [], spreadPercent: null, checksumStable: false, error: 'worker failed' },
    multi: { threads: 0, opsPerSecond: null, perThread: [], scaling: null, error: 'all workers failed' },
    memory: { sequentialGbps: null, stridedGbps: null, error: 'worker failed' }
  });
  // A benchmark that could not run is an ERROR (a provider was expected to succeed and failed),
  // not a FAIL (which is a measured defect) and certainly not a zero.
  assert.equal(fields.singleCore.status, Status.ERROR);
  assert.equal(fields.singleCore.value, null);
  assert.match(fields.singleCore.error, /worker failed/);
  assert.equal(fields.multiCore.value, null);
  assert.equal(fields.memoryBandwidth.value, null);
});

// ── Real-data rendering ─────────────────────────────────────────────────────

test('the dashboard renders a real projection, not a fixture', { skip: JSDOM === null && 'jsdom not installed' }, async () => {
  const projection = projectScan(productionScan());
  const { document, restore } = await bootWithBridge(answersFor(projection));
  try {
    await waitFor(() => document.querySelector('.vx-content')?.textContent.length > 80, 'the dashboard');
    const text = document.querySelector('.vx-content').textContent;
    assert.match(text, /Good/, 'the rating from the projection must reach the page');
    assert.match(text, /84/, 'the score from the projection must reach the page');
    assert.match(text, /78\.4%/, 'the coverage percentage the projection emits must be printed');
    assert.ok(!/\bnull\b|undefined|NaN/.test(text), 'a real projection must never leak a raw value');
  } finally {
    restore();
  }
});

test('the reports page prints the coverage figure the projection actually carries', { skip: JSDOM === null && 'jsdom not installed' }, async () => {
  const projection = projectScan(productionScan());
  const { document, restore } = await bootWithBridge(answersFor(projection));
  try {
    await waitFor(() => document.querySelector('.vx-nav__item[data-page="reports"]'), 'the navigation');
    document.querySelector('.vx-nav__item[data-page="reports"]').click();
    await waitFor(() => /What this report contains/.test(document.querySelector('.vx-content').textContent), 'the report page');
    const labels = [...document.querySelectorAll('.vx-coverage__label')].map((node) => node.textContent.trim());
    const values = [...document.querySelectorAll('.vx-coverage__value')].map((node) => node.textContent.trim());
    const coverageIndex = labels.findIndex((label) => label === 'Coverage');
    assert.ok(coverageIndex >= 0, `the coverage tile must exist (labels: ${labels.join(', ')})`);
    assert.match(values[coverageIndex], /^\d+(\.\d+)?%$/, `the coverage tile must print a percentage, got "${values[coverageIndex]}"`);
  } finally {
    restore();
  }
});

test('a gated projection never prints a bare number where a score is withheld', { skip: JSDOM === null && 'jsdom not installed' }, async () => {
  const scan = productionScan();
  const projection = projectScan({
    ...scan,
    assessment: { ...scan.assessment, score: null, gated: true, rating: 'Unrated', gatingNote: 'Only 26% of the weighted surface could be measured.' }
  });
  const { document, restore } = await bootWithBridge(answersFor(projection));
  try {
    await waitFor(() => document.querySelector('.vx-content')?.textContent.length > 80, 'the dashboard');
    document.querySelector('.vx-nav__item[data-page="reports"]').click();
    await waitFor(() => /What this report contains/.test(document.querySelector('.vx-content').textContent), 'the report page');
    const text = document.querySelector('.vx-content').textContent;
    assert.match(text, /score withheld/i);
    assert.ok(!/null\/100/.test(text), 'a withheld score must not be printed as a null fraction');
  } finally {
    restore();
  }
});
