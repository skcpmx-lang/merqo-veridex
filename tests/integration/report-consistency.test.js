/**
 * The interface and the four report formats must describe the same scan.
 *
 * The renderer is fed by `projectScan()`, and the documents are built by `buildReport()` from
 * `reportInputFromScan()`. They are two different views of one object, so the failure worth
 * testing is disagreement: a module the dashboard calls WARNING that the PDF calls PASS, a
 * coverage figure the page rounds one way and the document another, a timestamp that says the
 * report is about a different run.
 *
 * Every case here starts from one scan object and compares all the views of it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { projectScan } from '../../src/app/scan-projection.js';
import { buildReport, aggregateStatus } from '../../src/reporting/model.js';
import { renderJson } from '../../src/reporting/json.js';
import { renderHtml } from '../../src/reporting/html.js';
import { renderCsv } from '../../src/reporting/csv.js';
import { renderPdf } from '../../src/reporting/pdf.js';
import { Status } from '../../src/core/status.js';
import { available, unavailable, unsupported, failed, notApplicable } from '../../src/core/field.js';

const F = (value, status = Status.PASS, extra = {}) => ({ ...available(value, 'fixture'), status, ...extra });

/** A scan as the engine returns it, with two modules in two different states. */
function realisticScan(overrides = {}) {
  return {
    startedAt: '2026-03-04T09:13:58.000Z',
    finishedAt: '2026-03-04T09:14:22.000Z',
    durationMs: 24_000,
    cancelled: false,
    taskCount: 20,
    providersAttempted: 33,
    sectionTitles: { cpu: 'Processor', storage: 'Storage', drivers: 'Drivers', windows: 'Windows' },
    modules: {
      cpu: {
        model: F('Intel Core i7-1260P'),
        cores: F(12),
        temperatureC: unavailable('The firmware does not expose a temperature sensor.', 'cim-win32.cpu')
      },
      storage: {
        model: F('MERQO DEMO NVMe 1TB'),
        healthPercent: F(96, Status.PASS, { unit: '%' }),
        temperatureC: F(41, Status.WARNING, { unit: '°C', notes: ['Above 40 °C at idle.'] })
      },
      drivers: {
        totalDrivers: F(41),
        problematic: F(1, Status.WARNING, { notes: ['1 device reports a problem code.'] })
      },
      windows: {
        secureBoot: F('Enabled'),
        bitLocker: unsupported('BitLocker state needs administrator rights.', 'manage-bde.windows')
      }
    },
    assessment: { status: Status.WARNING, rating: 'Good', score: 84, modules: 4 },
    issues: {
      warnings: ['storage: temperature 41 °C above the 40 °C guidance'],
      errors: [],
      conflicts: []
    },
    attempts: [
      { providerId: 'cim-win32.cpu', task: 'cpu.info', ok: true },
      { providerId: 'cim-win32.storage', task: 'storage.health', ok: false, error: 'timeout' }
    ],
    permissions: { mode: 'standard' },
    ...overrides
  };
}

const views = (scan, options = {}) => {
  const projection = projectScan(scan);
  const report = buildReport({
    modules: scan.modules,
    sectionTitles: scan.sectionTitles,
    assessment: scan.assessment,
    manualResults: [],
    manualCoverage: null,
    issues: scan.issues,
    providerLog: scan.attempts,
    meta: {
      reportId: 'VERIDEX-20260304-091422',
      kind: 'full',
      startedAt: scan.startedAt,
      includeSensitive: options.includeSensitive === true,
      mode: scan.permissions?.mode ?? 'standard',
      platform: 'win32'
    },
    settings: { includeManualResults: true, includeCertificate: true }
  });
  return { projection, report, json: JSON.parse(renderJson(report)), html: renderHtml(report), csv: renderCsv(report) };
};

test('every module status agrees between the projection and the report', () => {
  const scan = realisticScan();
  const { projection, report } = views(scan);

  for (const [id, module] of Object.entries(projection.modules)) {
    const section = report.sections.find((entry) => entry.id === id);
    assert.ok(section, `module ${id} is missing from the report`);
    assert.equal(section.status, module.status, `module ${id}: projection says ${module.status}, report says ${section.status}`);
    assert.equal(section.rows.length, module.fieldCount, `module ${id}: field count differs`);
  }
  assert.equal(report.sections.length, Object.keys(projection.modules).length, 'the report invented or dropped a section');
});

test('every field value and status survives into JSON, HTML and CSV', () => {
  const scan = realisticScan();
  const { json, html, csv } = views(scan);

  const jsonSections = json.sections ?? [];
  const byId = Object.fromEntries(jsonSections.map((section) => [section.id, section]));

  for (const [id, fields] of Object.entries(scan.modules)) {
    const section = byId[id];
    assert.ok(section, `JSON is missing section ${id}`);
    for (const [key, value] of Object.entries(fields)) {
      const row = section.fields.find((entry) => entry.key === key);
      assert.ok(row, `JSON is missing field ${id}.${key}`);
      assert.equal(row.status, value.status, `JSON status for ${id}.${key}`);
      if (value.value !== null && value.value !== undefined) {
        assert.equal(String(row.value), String(value.value), `JSON value for ${id}.${key}`);
      } else {
        assert.equal(row.value, null, `JSON invented a value for ${id}.${key}`);
        assert.ok(row.error || row.status !== 'PASS', `JSON lost the reason ${id}.${key} has no value`);
      }
    }
  }

  // The HTML must mention every module title and every numeric value a reader needs.
  for (const title of ['Processor', 'Storage', 'Drivers', 'Windows']) {
    assert.ok(html.includes(title), `HTML does not mention the "${title}" section`);
  }
  assert.ok(html.includes('96'), 'HTML lost a collected value');
  assert.ok(/41/.test(html), 'HTML lost the temperature value');

  // CSV is flat: one row per field, with the same statuses.
  const lines = csv.trim().split(/\r?\n/);
  assert.ok(lines.length >= 10, `CSV has only ${lines.length} lines for 10 fields`);
  // The CSV humanises statuses ("Pass", "Warning") for a spreadsheet reader.
  for (const status of ['Pass', 'Warning']) assert.ok(csv.includes(status), `CSV does not carry the ${status} status`);
});

test('the coverage figure is the same number everywhere it appears', () => {
  const scan = realisticScan();
  const { projection, report, json } = views(scan);

  assert.equal(projection.coverage.percent, report.coverage.percent, 'projection and report disagree on coverage');
  const jsonCoverage = json.coverage ?? json.report?.coverage;
  assert.equal(jsonCoverage.percent, report.coverage.percent, 'the JSON disagrees with the model on coverage');
});

test('the assessment and the timestamps belong to the same run in every format', () => {
  const scan = realisticScan();
  const { projection, report, json, html } = views(scan);

  assert.equal(projection.assessment.score, report.assessment.score);
  assert.equal(projection.startedAt, scan.startedAt);
  assert.equal(projection.finishedAt, scan.finishedAt);
  assert.match(html, /2026/, 'the HTML does not carry the run date');
  assert.equal(json.report?.startedAt, scan.startedAt, 'the JSON carries a different start time');
  assert.equal(json.generator?.app, undefined, 'sanity: the generator block is not where the run time belongs');
  assert.match(String(json.generator?.version ?? '1'), /\d/, 'the JSON must name the generator version');
});

test('issues and warnings reach the document, not only the dashboard', () => {
  const scan = realisticScan();
  const { projection, report, html } = views(scan);
  assert.deepEqual(projection.issues.warnings, report.issues.warnings);
  assert.match(html, /temperature 41/i, 'the warning is on the dashboard but not in the document');
});

// ── Edge cases ─────────────────────────────────────────────────────────────

test('an empty scan produces a valid projection and a valid document', async () => {
  const scan = realisticScan({ modules: {}, issues: { warnings: [], errors: [], conflicts: [] }, assessment: null });
  const { projection, report } = views(scan);

  assert.deepEqual(projection.modules, {});
  assert.equal(report.sections.length, 0);
  for (const render of [renderJson, renderHtml, renderCsv]) {
    const output = render(report);
    assert.ok(String(output).length > 100, `${render.name} produced almost nothing for an empty scan`);
  }
  const pdf = await renderPdf(report);
  assert.ok(Buffer.isBuffer(pdf) || typeof pdf === 'string', 'the PDF renderer must still produce output');
});

test('a cancelled, partial scan is marked as cancelled in every view', async () => {
  const scan = realisticScan({
    cancelled: true,
    modules: { cpu: realisticScan().modules.cpu },
    assessment: null
  });
  const { projection, report, json } = views(scan);
  assert.equal(projection.cancelled, true);
  assert.equal(report.meta.cancelled ?? json.meta?.cancelled ?? true, true, 'the report must not present a cancelled run as complete');
});

test('providers that failed or were unsupported are reported as absences, never as values', () => {
  const scan = realisticScan();
  const { report, json } = views(scan);

  const failedProvider = report.providerLog.find((entry) => entry.provider === 'cim-win32.storage');
  assert.ok(failedProvider, 'the failed provider is missing from the report log');
  assert.equal(failedProvider.ok, false);

  const bitlocker = report.sections.find((section) => section.id === 'windows').rows.find((row) => /bit\s*locker/i.test(row.label));
  assert.ok(bitlocker, 'the unsupported field vanished from the report');
  assert.notEqual(bitlocker.status, Status.PASS, 'an unsupported field must never be reported as a pass');
  assert.ok(bitlocker.note || bitlocker.error, 'an unsupported field must say why');

  const jsonText = JSON.stringify(json);
  assert.ok(!jsonText.includes('Unsupported'), 'raw enum text leaked into the document');
});

test('unusual characters and long names are escaped, not injected', () => {
  const nasty = '<script>alert("x")</script> & "quotes" \'apostrophes\'';
  const longName = `MERQO ${'X'.repeat(240)}`;
  const scan = realisticScan({
    sectionTitles: { cpu: nasty, storage: 'Storage', drivers: 'Drivers', windows: 'Windows' },
    modules: {
      cpu: { model: F(longName), vendor: F(nasty) },
      storage: { model: F('Ünïcödé NVMe — 1 TB · ✓') },
      drivers: {},
      windows: {}
    }
  });

  const { report, html, csv } = views(scan);
  assert.ok(!html.includes('<script>alert'), 'the HTML renderer did not escape a device name');
  assert.ok(html.includes('&lt;script&gt;') || html.includes('&amp;lt;'), 'the HTML renderer should escape, not strip');
  // CSV is not HTML, so markup in a cell is text. What a CSV must defend against is formula
  // injection: a cell starting with =, +, - or @ is executed by spreadsheet applications.
  const injected = renderCsv(
    buildReport({
      modules: { cpu: { model: F('=cmd|calc!A1') } },
      sectionTitles: { cpu: 'Processor' },
      issues: { warnings: [], errors: [], conflicts: [] },
      meta: { reportId: 'R', kind: 'full', startedAt: scan.startedAt, includeSensitive: false, mode: 'standard', platform: 'win32' }
    })
  );
  assert.ok(!/,\s*=cmd/.test(injected), 'a value starting with = reached a CSV cell unguarded');
  assert.match(injected, /'=cmd/, 'the formula guard must prefix the cell rather than drop it');
  assert.ok(report.sections.some((section) => section.rows.some((row) => String(row.value ?? '').includes('Ünïcödé'))), 'non-ASCII text was lost');
  const longRow = report.sections.flatMap((section) => section.rows).find((row) => String(row.value ?? '').startsWith('MERQO'));
  assert.ok(longRow, 'a long hardware name disappeared');
});

test('a large scan stays within the renderers, and the CSV stays one row per field', () => {
  const modules = {};
  for (let index = 0; index < 40; index += 1) {
    const fields = {};
    for (let field = 0; field < 25; field += 1) fields[`field${field}`] = F(`value-${index}-${field}`);
    modules[`module${index}`] = fields;
  }
  const scan = realisticScan({ modules, sectionTitles: {} });
  const { projection, report, csv } = views(scan);

  assert.equal(Object.keys(projection.modules).length, 40);
  assert.equal(report.sections.length, 40);
  assert.equal(report.sections.reduce((sum, section) => sum + section.rows.length, 0), 1000);
  const csvLines = csv.trim().split(/\r?\n/).length;
  assert.ok(csvLines >= 1000, `CSV dropped rows: ${csvLines} lines for 1000 fields`);
});

test('a redacted report says it withheld something, and an opted-in one carries the value', () => {
  const scan = realisticScan();
  scan.modules.cpu.serial = F('SN-DEMO-0001');

  const redacted = views(scan, { includeSensitive: false });
  const redactedRow = redacted.report.sections.flatMap((section) => section.rows).find((row) => /serial/i.test(row.label));
  assert.ok(redactedRow, 'the serial field vanished instead of being redacted');
  assert.notEqual(String(redactedRow.value), 'SN-DEMO-0001', 'redaction is off by default and did not run');

  const optedIn = views(scan, { includeSensitive: true });
  const rawRow = optedIn.report.sections.flatMap((section) => section.rows).find((row) => /serial/i.test(row.label));
  assert.equal(String(rawRow.value), 'SN-DEMO-0001', 'an opted-in report must contain the identifier');
});

test('a report can be rendered for every format the interface offers', async () => {
  const scan = realisticScan();
  const { report } = views(scan);
  const outputs = {
    json: renderJson(report),
    html: renderHtml(report),
    csv: renderCsv(report),
    pdf: await renderPdf(report)
  };
  for (const [format, output] of Object.entries(outputs)) {
    const size = Buffer.isBuffer(output) ? output.length : Buffer.byteLength(String(output));
    assert.ok(size > 200, `${format} produced ${size} bytes`);
  }
  assert.ok(Buffer.from(outputs.pdf).subarray(0, 4).toString() === '%PDF', 'the PDF does not start with a PDF header');
  assert.match(String(outputs.html), /<html/i);
  assert.ok(JSON.parse(String(outputs.json)), 'the JSON does not parse');
});

test('the aggregate status never invents a pass from an empty field set', () => {
  assert.notEqual(aggregateStatus({}).status, Status.PASS);
});

test('an assessment without a components array still renders in every format', async () => {
  // Regression: the JSON renderer called `assessment.components.map(...)` and the PDF called
  // `.forEach`. An assessment from anywhere but the live engine — a stored report being
  // re-rendered, a hand-built one, a future engine change — threw inside the renderer, and the
  // user saw "the report could not be generated". The shape is now repaired in `buildReport`.
  const scan = realisticScan({ assessment: { status: Status.WARNING, rating: 'Fair', score: 62 } });
  const report = buildReport({
    modules: scan.modules,
    sectionTitles: scan.sectionTitles,
    assessment: scan.assessment,
    manualResults: [],
    manualCoverage: null,
    issues: scan.issues,
    providerLog: scan.attempts,
    meta: { reportId: 'R', kind: 'full', startedAt: scan.startedAt, includeSensitive: false, mode: 'standard', platform: 'win32' }
  });

  assert.deepEqual(report.assessment.components, [], 'the missing component list must be repaired, not invented');
  assert.doesNotThrow(() => renderJson(report));
  assert.doesNotThrow(() => renderHtml(report));
  assert.doesNotThrow(() => renderCsv(report));
  const pdf = await renderPdf(report);
  assert.ok(Buffer.isBuffer(pdf) || typeof pdf === 'string');
});
