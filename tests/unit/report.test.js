import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReport, buildMeta, makeReportId, humaniseKey, fieldsToRows, redactField,
  isPrivateField, computeCoverage, tallyManual, aggregateStatus, formatValue, flattenReport,
  REPORT_SCHEMA_VERSION, SECTION_ORDER
} from '../../src/reporting/model.js';
import { renderPdf } from '../../src/reporting/pdf.js';
import { renderHtml, escapeHtml, statusPill } from '../../src/reporting/html.js';
import { renderCsv, csvCell } from '../../src/reporting/csv.js';
import { renderJson } from '../../src/reporting/json.js';
import { buildCertificate, renderCertificateHtml } from '../../src/reporting/certificate.js';
import { assessFromDiagnostics } from '../../src/engine/health.js';
import { available, unavailable, failed, field, permissionRequired } from '../../src/core/field.js';
import { Status } from '../../src/core/status.js';

/** A representative module set used by several tests. */
function sampleModules() {
  return {
    system: { manufacturer: available('LENOVO', 'cim-win32'), model: available('ThinkPad T480', 'cim-win32'), serialNumber: available('PF1ABCDE', 'cim-win32'), macAddress: available('A4:BB:6D:12:34:56', 'cim-win32') },
    cpu: { name: available('Intel Core i5-8250U', 'cim-win32'), physicalCores: available(4, 'cim-win32'), logicalCores: available(8, 'cim-win32'), temperature: unavailable('No sensor provider', 'acpi-thermal') },
    memory: { moduleCount: available(2, 'cim-win32'), totalCapacity: available(16, 'cim-win32') },
    storage: { diskCount: available(1, 'cim-win32'), 'disk1.healthStatus': available('Healthy', 'cim-win32') },
    storageHealth: { 'disk1.percentageUsed': available(12, 'nvme-health-log', { unit: '%' }) },
    battery: { health: available(78.4, 'computed'), cycleCount: available(412, 'battery-firmware') },
    drivers: { driverCount: available(74, 'cim-win32'), driversFailed: available(0, 'computed') },
    security: { defenderRealtimeProtection: available('Enabled', 'cim-win32'), firewallSummary: available('All 3 profiles enabled', 'cim-win32') },
    sensors: { cpuTemperature: available(61, 'acpi-thermal') }
  };
}

function sampleReport(overrides = {}) {
  const modules = overrides.modules ?? sampleModules();
  return buildReport({
    modules,
    assessment: assessFromDiagnostics(modules),
    meta: { includeSensitive: false, kind: 'inspection', reportId: 'VX-RPT-TEST-0001', generatedAt: '2026-11-05T09:00:00.000Z' },
    manualResults: [
      { id: 'display.white', title: 'White field', status: Status.PASS, observedAt: '2026-11-05T09:01:00.000Z', notes: ['0 defective pixels'] },
      { id: 'keyboard.all', title: 'Keyboard full test', status: Status.WARNING, observedAt: '2026-11-05T09:02:00.000Z', notes: ['Right Shift intermittent'] }
    ],
    issues: { warnings: ['Drive temperature requires administrator rights'], errors: [], conflicts: ['cpu.cores: a=8 vs b=4'] },
    providerLog: [
      { providerId: 'cim-win32', task: 'cpu.info', ok: true },
      { providerId: 'ata-smart', task: 'storage.health', ok: false, error: 'Requires elevation' }
    ],
    ...overrides.extra
  });
}

test('report IDs are unique, timestamped and carry no machine identifiers', () => {
  const ids = new Set();
  for (let index = 0; index < 200; index += 1) {
    const id = makeReportId(new Date('2026-11-05T09:00:00.000Z'));
    assert.match(id, /^VX-RPT-\d{8}-\d{6}-\d{3}-[0-9A-F]{4}$/);
    ids.add(id);
  }
  assert.ok(ids.size > 150, 'IDs must not collide in practice');
});

test('report metadata carries brand identity and the tool disclaimer', () => {
  const meta = buildMeta({});
  assert.equal(meta.brand, 'MERQO');
  assert.equal(meta.product, 'VERIDEX');
  assert.equal(meta.founder, 'Shohan Khan');
  assert.equal(meta.contact, 'merqoonline@gmail.com');
  assert.equal(meta.schemaVersion, REPORT_SCHEMA_VERSION);
  assert.match(meta.toolDisclaimer, /not a guarantee of hardware health/);
});

test('serial numbers and MAC addresses are identified as private', () => {
  assert.equal(isPrivateField('serialNumber'), true);
  assert.equal(isPrivateField('disk1.serialNumber'), true);
  assert.equal(isPrivateField('adapter1.macAddress'), true);
  assert.equal(isPrivateField('hostname'), true);
  assert.equal(isPrivateField('cpu.name'), false);
  assert.equal(isPrivateField('memory.totalCapacity'), false);
});

test('privacy transform redacts sensitive fields unless the user opted in', () => {
  const serial = available('PF1ABCDE', 'cim-win32');
  const redacted = redactField(serial, 'serialNumber', false);
  assert.equal(redacted.value, '[redacted]');
  assert.ok(redacted.notes.some((note) => note.includes('Privacy settings')));

  const kept = redactField(serial, 'serialNumber', true);
  assert.equal(kept.value, 'PF1ABCDE');

  const notSensitive = redactField(available('Intel', 'cim-win32'), 'manufacturer', false);
  assert.equal(notSensitive.value, 'Intel');
});

test('the report applies redaction before any renderer sees the data', () => {
  const report = sampleReport();
  const systemSection = report.sections.find((section) => section.id === 'system');
  assert.equal(systemSection.rows.find((row) => row.key === 'serialNumber').value, '[redacted]');
  assert.equal(systemSection.rows.find((row) => row.key === 'manufacturer').value, 'LENOVO');
});

test('sections are produced in canonical order and carry aggregated status', () => {
  const report = sampleReport();
  const ids = report.sections.map((section) => section.id);
  assert.deepEqual(ids, ['system', 'cpu', 'memory', 'storage', 'storageHealth', 'battery', 'drivers', 'security', 'sensors']);
  const cpu = report.sections.find((section) => section.id === 'cpu');
  assert.equal(cpu.status, Status.PARTIALLY_AVAILABLE, 'a missing temperature makes the section partial, not passing');
});

test('an unknown module is still reported rather than dropped', () => {
  const report = buildReport({ modules: { futureModule: { thing: available(1, 'x') } }, meta: { reportId: 'R' } });
  const section = report.sections.find((entry) => entry.id === 'futureModule');
  assert.ok(section, 'unknown modules must not be silently discarded');
  assert.equal(section.rows[0].value, 1);
});

test('problem rows sort ahead of healthy rows so a reader sees issues first', () => {
  const report = buildReport({
    modules: { demo: { a: available('ok', 'x'), b: failed('broken', 'x'), c: field('warn', { status: Status.WARNING, source: 'x' }) } },
    meta: { reportId: 'R' }
  });
  const rows = report.sections[0].rows;
  assert.equal(rows[0].status, Status.ERROR);
  assert.equal(rows[rows.length - 1].status, Status.PASS);
});

test('coverage excludes unavailable and untested items from the assessed count', () => {
  const report = sampleReport();
  const coverage = report.coverage;
  assert.ok(coverage.assessed > 0);
  assert.equal(coverage.assessed, coverage.passed + coverage.failed + coverage.warned);
  assert.ok(coverage.unsupported > 0, 'the missing CPU temperature is counted as unavailable, not passed');
  assert.ok(coverage.coveragePercent < 100);
  assert.match(coverage.note, /rather than counted as passes/);
});

test('coverage and health score are separate numbers', () => {
  const report = sampleReport();
  assert.notEqual(report.assessment.coveragePercent, report.coverage.coveragePercent);
  assert.ok(typeof report.assessment.score === 'number');
});

test('aggregateStatus prefers failures, then warnings, then partial availability', () => {
  assert.equal(aggregateStatus({ a: failed('x', 's') }).status, Status.ERROR);
  assert.equal(aggregateStatus({ a: available(1, 's'), b: field('w', { status: Status.WARNING, source: 's' }) }).status, Status.WARNING);
  assert.equal(aggregateStatus({ a: available(1, 's'), b: unavailable('no', 's') }).status, Status.PARTIALLY_AVAILABLE);
  assert.equal(aggregateStatus({ a: permissionRequired('admin', 's') }).status, Status.PERMISSION_REQUIRED);
  assert.equal(aggregateStatus({}).status, Status.UNAVAILABLE);
});

test('field keys become readable labels for non-technical readers', () => {
  assert.equal(humaniseKey('disk1.percentageUsed'), 'Disk 1 · Percentage Used');
  assert.equal(humaniseKey('cpu.l3Cache'), 'CPU · L3 Cache');
  assert.equal(humaniseKey('macAddress'), 'MAC Address');
  assert.equal(humaniseKey('gpu.pcieLinkGen'), 'GPU · PCIe Link Gen');
});

test('values render with units, arrays and booleans readably', () => {
  assert.equal(formatValue(4200, 'MHz'), '4200 MHz');
  assert.equal(formatValue(null, 'MHz'), '');
  assert.equal(formatValue(['a', 'b'], null), 'a; b');
  assert.equal(formatValue(true, null), 'Yes');
  assert.equal(formatValue(0, '%'), '0 %', 'zero is a real value and must render');
});

test('manual results are kept separate from automated findings', () => {
  const report = sampleReport();
  assert.equal(report.manualResults.length, 2);
  const rows = flattenReport(report);
  const manual = rows.filter((row) => row.section === 'Manual inspection');
  assert.equal(manual.length, 2);
  assert.equal(manual[0].source, 'manual observation');
});

test('disabling manual results removes them and recomputes coverage', () => {
  const withManual = sampleReport();
  const without = sampleReport({ extra: { settings: { includeManualResults: false } } });
  assert.equal(without.manualResults.length, 0);
  assert.equal(without.manualCoverage, null, 'with manual results off there is no manual programme to report');
  // Field coverage is unaffected by manual results either way — that separation is
  // the whole point of keeping the two tallies apart.
  assert.equal(without.coverage.totalFields, withManual.coverage.totalFields);
  assert.equal(without.coverage.coveragePercent, withManual.coverage.coveragePercent);
});

test('PDF renders a real document with page furniture and the certificate', async () => {
  const report = sampleReport();
  const certificate = buildCertificate(report);
  const pdf = await renderPdf(report, { certificate });
  assert.ok(Buffer.isBuffer(pdf));
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 4000, 'a report with content must not be a near-empty file');
  // Page count sanity: the certificate is appended as its own page.
  const pageCount = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  assert.ok(pageCount >= 2, `expected multiple pages, got ${pageCount}`);
});

test('PDF rendering survives a report with no assessment at all', async () => {
  const report = buildReport({ modules: { cpu: { name: available('x', 's') } }, meta: { reportId: 'R' } });
  const pdf = await renderPdf(report);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
});

test('HTML is self-contained: no scripts, no external resources', () => {
  const html = renderHtml(sampleReport());
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(!/<script/i.test(html), 'the report must not execute anything');
  assert.ok(!/https?:\/\//i.test(html.replace(/https:\/\/veridex\.merqo\.local[^"']*/g, '')), 'no external resources');
  assert.ok(html.includes('VERIDEX'));
  assert.ok(html.includes('MERQO'));
  assert.ok(html.includes('Report ID'));
});

test('HTML escapes user-derived content', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml('a & b "c"'), 'a &amp; b &quot;c&quot;');
  const report = buildReport({ modules: { system: { model: available('<img src=x onerror=alert(1)>', 'cim-win32') } }, meta: { reportId: 'R' } });
  const html = renderHtml(report);
  assert.ok(!html.includes('<img src=x'), 'device names are untrusted input');
  assert.ok(html.includes('&lt;img src=x'));
});

test('status pills always carry a text label, never colour alone', () => {
  const pill = statusPill(Status.UNAVAILABLE);
  assert.ok(pill.includes('Unavailable'));
  assert.ok(pill.includes('--tone:'));
});

test('HTML includes the coverage block and the mandatory disclaimer', () => {
  const html = renderHtml(sampleReport());
  assert.ok(html.includes('Automated field coverage'));
  assert.ok(html.includes('Coverage'));
  assert.ok(html.includes('not a warranty') || html.includes('excluded from the score'));
});

test('CSV is RFC 4180 quoted with a UTF-8 BOM and CRLF endings', () => {
  const csv = renderCsv(sampleReport());
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('\r\n'));
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('has,comma'), '"has,comma"');
  assert.equal(csvCell('has"quote'), '"has""quote"');
  assert.equal(csvCell('line\nbreak'), '"line\nbreak"');
});

test('CSV neutralises spreadsheet formula injection', () => {
  assert.equal(csvCell('=cmd|calc'), "'=cmd|calc");
  assert.equal(csvCell('+1'), "'+1");
  assert.equal(csvCell('-1'), "'-1");
  assert.equal(csvCell('@SUM'), "'@SUM");
});

test('JSON is valid, versioned and carries provenance per field', () => {
  const parsed = JSON.parse(renderJson(sampleReport()));
  assert.equal(parsed.schemaVersion, REPORT_SCHEMA_VERSION);
  assert.equal(parsed.generator.product, 'VERIDEX');
  assert.equal(parsed.report.sensitiveDataIncluded, false);
  const cpuSection = parsed.sections.find((section) => section.id === 'cpu');
  const nameField = cpuSection.fields.find((entry) => entry.key === 'name');
  assert.ok('source' in nameField && 'collectedAt' in nameField && 'confidence' in nameField);
  assert.ok(parsed.limitations.unverifiableWithoutHardware.length >= 3);
  assert.match(parsed.limitations.notACertification, /not a warranty/);
});

test('JSON records the redaction rather than hiding it', () => {
  const parsed = JSON.parse(renderJson(sampleReport()));
  const serial = parsed.sections.find((section) => section.id === 'system').fields.find((entry) => entry.key === 'serialNumber');
  assert.equal(serial.redacted, true);
});

test('the certificate states partial coverage instead of implying a full inspection', () => {
  const report = sampleReport();
  const certificate = buildCertificate(report);
  assert.equal(certificate.deviceName, 'LENOVO ThinkPad T480');
  assert.ok(certificate.coveragePercent < 100);
  assert.match(certificate.overallText, /coverage/);
  assert.match(certificate.statement, /not a warranty/);
  assert.ok(certificate.untestedItems.length >= 0);
  assert.ok(certificate.unassessedCaveat === null || /excluded from the score/.test(certificate.unassessedCaveat));
});

test('a device name that cannot be identified is stated, not invented', () => {
  const report = buildReport({ modules: { cpu: { name: available('x', 's') } }, meta: { reportId: 'R' } });
  assert.equal(buildCertificate(report).deviceName, 'Not identified');
});

test('certificate lists failures so a buyer cannot miss them', () => {
  const report = buildReport({
    modules: { storage: { diskCount: available(1, 's'), 'disk1.healthStatus': field('Unhealthy', { status: Status.FAIL, source: 'cim-win32' }) } },
    meta: { reportId: 'R' }
  });
  const certificate = buildCertificate(report);
  assert.ok(certificate.failedItems.length > 0);
  const html = renderCertificateHtml(certificate, escapeHtml);
  assert.ok(html.includes('Failed items'));
});

test('every canonical section id is unique and titled', () => {
  const ids = new Set();
  for (const section of SECTION_ORDER) {
    assert.ok(section.title.length > 0);
    assert.equal(ids.has(section.id), false);
    ids.add(section.id);
  }
});

test('computeCoverage handles an empty report without dividing by zero', () => {
  const coverage = computeCoverage([], []);
  assert.equal(coverage.coveragePercent, 0);
  assert.equal(coverage.totalFields, 0);
});

test('manual results never inflate automated field coverage', () => {
  // Regression: folding manual observations into the field tally made a run that
  // collected no automated fields report 100% field coverage.
  const coverage = computeCoverage([], [
    { status: Status.PASS },
    { status: Status.PASS },
    { status: Status.WARNING }
  ]);
  assert.equal(coverage.totalFields, 0);
  assert.equal(coverage.coveragePercent, 0, 'field coverage must stay 0 when no fields were collected');
  assert.match(coverage.note, /No automated fields were collected/);
  assert.equal(coverage.manual.total, 3);
  assert.equal(coverage.manual.passed, 2);
  assert.equal(coverage.manual.coveragePercent, 100);
});

test('not-applicable manual results are neither passed nor untested', () => {
  const coverage = computeCoverage([], [{ status: Status.NOT_APPLICABLE }, { status: Status.PASS }]);
  assert.equal(coverage.manual.notApplicable, 1);
  assert.equal(coverage.manual.untested, 0);
  assert.equal(coverage.manual.passed, 1);
  assert.equal(coverage.manual.coveragePercent, 50);
});

test('a manual-only report states there is no field coverage instead of showing a bar', () => {
  const report = buildReport({
    modules: {},
    manualResults: [{ id: 'display.white', title: 'White field', status: Status.PASS, observedAt: '2026-11-05T00:00:00.000Z', notes: ['clean'], kind: 'observe' }],
    meta: { reportId: 'VX-RPT-MANUAL-ONLY' }
  });
  assert.equal(report.coverage.totalFields, 0);
  assert.equal(report.manualCoverage.total, 1);
  const html = renderHtml(report);
  assert.ok(html.includes('No automated fields were collected'));
  assert.ok(html.includes('Manual observation'), 'the result must be labelled as a human observation');
});

test('manual coverage is present in every renderer, so formats cannot disagree', async () => {
  const report = buildReport({
    modules: {},
    manualResults: [{ id: 'keyboard.keys', title: 'Essential keys respond', status: Status.WARNING, observedAt: '2026-11-05T00:00:00.000Z', notes: ['KeyZ silent'], kind: 'capture' }],
    manualCoverage: { totalTests: 31, answered: 1, passed: 0, failed: 0, warned: 1, notApplicable: 0, untested: 30, percentComplete: 3.2, statement: '1 of 31 manual inspection tests were answered; 30 were not run and are reported as UNTESTED, not as passing.' },
    meta: { reportId: 'VX-RPT-MANUAL-COV' }
  });

  assert.equal(JSON.parse(renderJson(report)).manualCoverage.answered, 1);
  const html = renderHtml(report);
  assert.ok(html.includes('30') && html.includes('Not run'));
  const pdf = await renderPdf(report);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  // A capture-based result must be labelled as captured, not as an observation.
  assert.ok(html.includes('Captured from device events'));
});
