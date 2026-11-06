/**
 * End-to-end engine integration.
 *
 * This test wires the real provider registry, the real diagnostic runner, the real
 * permission gate, the real health engine and the real report renderers together
 * and drives them with **injected fake providers**. Nothing here touches the host
 * machine: that is deliberate, because the point is to prove the *plumbing*
 * (fallback, privilege gating, conflict resolution, redaction, export) rather than
 * to claim hardware coverage we cannot have on Linux CI.
 *
 * The fakes are labelled as fakes everywhere: provider titles say "test double",
 * and their outputs use an obvious marker value so a leaked fixture cannot be
 * mistaken for a real reading in a shipped report.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Status } from '../../src/core/status.js';
import { available, unavailable, permissionRequired, failed } from '../../src/core/field.js';
import { Logger, NullLogger } from '../../src/core/logger.js';
import { SettingsStore } from '../../src/core/settings.js';
import { ProviderRegistry, DiagnosticRunner } from '../../src/engine/provider-registry.js';
import { assessFromDiagnostics } from '../../src/engine/health.js';
import { buildPrivacyPolicy, applyPrivacyPreset, redactSections, summariseRedactions } from '../../src/security/privacy.js';
import { SecurityGuard } from '../../src/security/guard.js';
import { buildReport } from '../../src/reporting/model.js';
import { renderJson } from '../../src/reporting/json.js';
import { renderHtml } from '../../src/reporting/html.js';
import { renderCsv } from '../../src/reporting/csv.js';
import { renderPdf } from '../../src/reporting/pdf.js';
import { buildCertificate } from '../../src/reporting/certificate.js';

const MARKER = 'TEST-DOUBLE-NOT-REAL';

/** A permission state for a standard (non-elevated) session. */
const standardSession = Object.freeze({
  isAdmin: false,
  isWindows: true,
  mode: 'standard',
  detectedAt: '2026-11-05T00:00:00.000Z',
  detail: 'integration test double'
});

const elevatedSession = Object.freeze({ ...standardSession, isAdmin: true, mode: 'elevated' });

/**
 * Build a registry whose providers are fakes. `overrides` lets a test make one
 * provider throw, answer partially, or disagree with another.
 */
function buildRegistry(overrides = {}) {
  const registry = new ProviderRegistry();

  registry.registerProvider({
    id: 'fake-primary',
    title: 'Primary source (test double)',
    priority: 10,
    async collect() {
      if (overrides.primaryThrows) throw new Error('simulated provider crash');
      return {
        name: available('Fake CPU Model', 'fake-primary'),
        physicalCores: available(4, 'fake-primary'),
        logicalCores: available(8, 'fake-primary'),
        temperature: unavailable('No thermal zone in the test double', 'fake-primary')
      };
    }
  });

  registry.registerProvider({
    id: 'fake-fallback',
    title: 'Fallback source (test double)',
    priority: 20,
    async collect() {
      return {
        // Deliberately disagrees on one key so conflict reporting is exercised.
        physicalCores: available(6, 'fake-fallback'),
        logicalCores: available(8, 'fake-fallback'),
        baseClock: available(1600, 'fake-fallback', { unit: 'MHz' })
      };
    }
  });

  registry.registerProvider({
    id: 'fake-privileged',
    title: 'Elevated-only source (test double)',
    capability: 'storage.smart',
    priority: 10,
    async collect() {
      return { serialNumber: available(MARKER, 'fake-privileged') };
    }
  });

  registry.registerProvider({
    id: 'fake-storage',
    title: 'Storage source (test double)',
    priority: 10,
    async collect() {
      return {
        diskCount: available(1, 'fake-storage'),
        serialNumber: available('TESTSERIAL0001', 'fake-storage'),
        healthStatus: available('Healthy', 'fake-storage')
      };
    }
  });

  registry.registerProvider({
    id: 'fake-network',
    title: 'Network source (test double)',
    priority: 10,
    async collect() {
      return {
        macAddress: available('AA:BB:CC:DD:EE:FF', 'fake-network'),
        ipv4: available('192.0.2.10', 'fake-network'),
        adapterName: available('Ethernet 1', 'fake-network')
      };
    }
  });

  registry.registerTask({ id: 'cpu.info', module: 'cpu', title: 'Processor', providers: ['fake-primary', 'fake-fallback'] });
  registry.registerTask({ id: 'storage.info', module: 'storage', title: 'Storage', providers: ['fake-storage'] });
  registry.registerTask({ id: 'storage.health', module: 'storageHealth', title: 'Storage health', providers: ['fake-privileged'], requiresCapability: 'storage.smart' });
  registry.registerTask({ id: 'network.info', module: 'network', title: 'Network', providers: ['fake-network'] });
  registry.registerTask({
    id: 'cpu.crash',
    module: 'cpuCrash',
    title: 'Crashing provider',
    providers: ['fake-primary', 'fake-fallback']
  });

  return registry;
}

/** Run the full task set and return {byModule, results}. */
async function runSweep(session = standardSession, overrides = {}) {
  const registry = buildRegistry(overrides);
  const runner = new DiagnosticRunner({ registry, permissions: session, logger: new NullLogger(), timeoutMs: 5000 });
  const { results, byModule } = await runner.runTasks([
    'cpu.info',
    'storage.info',
    'storage.health',
    'network.info'
  ]);
  return { results, byModule, registry, runner };
}

test('the runner falls back when the first provider crashes, and records the failure', async () => {
  const { results, byModule } = await runSweep(standardSession, { primaryThrows: true });
  const cpu = results.find((result) => result.taskId === 'cpu.info');

  const primary = cpu.attempts.find((attempt) => attempt.providerId === 'fake-primary');
  assert.equal(primary.status, Status.ERROR);
  assert.match(primary.error, /simulated provider crash/);

  const fallback = cpu.attempts.find((attempt) => attempt.providerId === 'fake-fallback');
  assert.equal(fallback.ok, true);

  // The crash must not erase usable data from the fallback.
  assert.equal(byModule.cpu.fields.logicalCores.value, 8);
});

test('disagreeing providers are resolved and the conflict is reported, not hidden', async () => {
  const { results } = await runSweep();
  const cpu = results.find((result) => result.taskId === 'cpu.info');
  assert.ok(cpu.conflicts.length >= 1, 'the 4-vs-6 core disagreement must surface');
  assert.match(cpu.conflicts[0], /physicalCores/);
  assert.match(cpu.conflicts[0], /fake-primary=4/);
  assert.match(cpu.conflicts[0], /fake-fallback=6/);
});

test('a privileged task in a standard session is PERMISSION_REQUIRED, not "unsupported"', async () => {
  const { results } = await runSweep(standardSession);
  const health = results.find((result) => result.taskId === 'storage.health');
  const attempt = health.attempts[0];
  assert.equal(attempt.status, Status.PERMISSION_REQUIRED);
  assert.equal(attempt.skipped, true);
  assert.equal(attempt.skipReason, 'permission');
  assert.match(attempt.error, /standard users|administrator/i);

  // And the section carries that status forward rather than pretending it is empty.
  assert.equal(health.section.status, Status.PERMISSION_REQUIRED);
});

test('the same privileged task runs when the session is elevated', async () => {
  const { byModule } = await runSweep(elevatedSession);
  assert.equal(byModule.storageHealth.fields.serialNumber.value, MARKER);
});

test('redaction removes identifiers from a real run before any renderer runs', async () => {
  const { byModule } = await runSweep();
  const policy = buildPrivacyPolicy({});
  const sections = Object.values(byModule);
  const redacted = redactSections(sections, policy);

  const storage = redacted.find((entry) => entry.id === 'storage');
  assert.equal(storage.fields.serialNumber.value, '[redacted]');
  // The serial keeps its provenance, so "withheld" is distinguishable from "absent".
  assert.equal(storage.fields.serialNumber.status, Status.PASS);
  assert.ok(storage.fields.serialNumber.notes.some((note) => /Privacy settings/.test(note)));

  const network = redacted.find((entry) => entry.id === 'network');
  assert.equal(network.fields.macAddress.value, '[redacted]');
  assert.equal(network.fields.ipv4.value, '[redacted]');
  assert.equal(network.fields.adapterName.value, 'Ethernet 1', 'a non-identifying field must survive');

  const summary = summariseRedactions(sections, policy);
  assert.ok(summary.redactedFields >= 3);
  assert.ok(summary.categories.some((category) => category.category === 'serial'));
  assert.ok(summary.categories.some((category) => category.category === 'network'));
});

test('opting in keeps identifiers, and the report states that it does', async () => {
  const { byModule } = await runSweep();
  const policy = buildPrivacyPolicy({ 'diagnostics.includeSensitiveInReport': true });
  const sections = Object.values(byModule);
  const kept = redactSections(sections, policy);
  assert.equal(kept.find((entry) => entry.id === 'storage').fields.serialNumber.value, 'TESTSERIAL0001');
  const summary = summariseRedactions(sections, policy);
  assert.equal(summary.redactedFields, 0);
  assert.match(summary.statement, /included in this export/);
});

test('privacy defaults are the private ones, even with no settings at all', () => {
  const policy = buildPrivacyPolicy();
  assert.equal(policy.includeSensitive, false);
  assert.equal(policy.allowNetwork, false);
  assert.equal(policy.persistHistory, true);
});

test('a privacy preset is applied through the settings store, so it persists', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'veridex-privacy-'));
  try {
    const store = new SettingsStore({ file: path.join(dir, 'settings.json'), logger: new NullLogger() });
    await store.load();

    const result = await applyPrivacyPreset(store, 'workshop');
    assert.equal(result.ok, true);
    assert.equal(store.get('diagnostics.includeSensitiveInReport'), true);

    // Reload from disk: the change must be durable, not just in memory.
    const reloaded = new SettingsStore({ file: path.join(dir, 'settings.json'), logger: new NullLogger() });
    await reloaded.load();
    assert.equal(reloaded.get('diagnostics.includeSensitiveInReport'), true);

    // And the policy built from the store follows it.
    assert.equal(buildPrivacyPolicy(reloaded).includeSensitive, true);

    await applyPrivacyPreset(store, 'minimalTrace');
    assert.equal(store.get('diagnostics.persistHistory'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the guard blocks an outbound request and records the refusal', async () => {
  const guard = new SecurityGuard({ policy: { allowNetwork: false }, logger: new NullLogger() });
  guard.install();
  try {
    // fetch is the path real code uses, and the patched entry point is global.
    await assert.rejects(fetch('https://example.com/upload', { method: 'POST' }), (error) => {
      assert.equal(error.code, 'EVERIDEX_NETWORK_BLOCKED');
      assert.equal(error.veridexBlocked, true);
      assert.match(error.message, /blocked outbound request/);
      return true;
    });

    // The module-object patch catches CommonJS-style consumers that read at call
    // time. (ESM named imports bind before install; that limit is documented in
    // guard.js and covered by the static source scan below.)
    const httpDefault = (await import('node:http')).default;
    await assert.rejects(
      new Promise((resolve, reject) => {
        httpDefault.request('http://example.com/upload', () => resolve('should not happen')).on('error', reject).end();
      }),
      (error) => {
        assert.equal(error.code, 'EVERIDEX_NETWORK_BLOCKED');
        return true;
      }
    );
  } finally {
    guard.uninstall();
  }

  const summary = guard.summary();
  assert.equal(summary.networkAttemptsBlocked, 2);
  assert.equal(summary.networkAccessEnabled, false);
  assert.equal(summary.entries[0].host, 'example.com');
  assert.match(summary.statement, /2 network attempt\(s\)/);
});

test('the guard stays out of the way when installed and unused', async () => {
  const guard = new SecurityGuard({ policy: { allowNetwork: false } });
  guard.install();
  guard.uninstall();
  const http = await import('node:http');
  assert.equal(typeof http.request, 'function');
  assert.equal(guard.summary().networkAttemptsBlocked, 0);
});

test('the guard refuses destructive commands and asks for consent on the rest', () => {
  const guard = new SecurityGuard({ logger: new NullLogger() });

  const destructive = guard.checkCommand('chkdsk', ['C:', '/f']);
  assert.equal(destructive.allowed, false);
  assert.equal(destructive.verdict, 'forbid');

  const readOnly = guard.checkCommand('chkdsk', ['C:', '/scan']);
  assert.equal(readOnly.allowed, true);

  const consent = guard.checkCommand('pnputil', ['/export-driver', '*', 'C:\\drivers']);
  assert.equal(consent.verdict, 'needs-consent');
  assert.equal(consent.allowed, false, 'consent-gated operations must not run silently');

  guard.grantConsent(consent.id);
  assert.equal(guard.checkCommand('pnputil', ['/export-driver', '*', 'C:\\drivers']).allowed, true);

  assert.equal(guard.summary().unsafeCommandsBlocked, 2);
});

test('a full sweep produces one report that every format agrees on', async () => {
  const { byModule } = await runSweep();
  const assessment = assessFromDiagnostics(byModule);
  const modules = Object.fromEntries(Object.entries(byModule).map(([id, section]) => [id, section.fields]));

  const sectionTitles = Object.fromEntries(
    Object.entries(byModule).map(([id, section]) => [id, section.title])
  );

  const report = buildReport({
    modules,
    sectionTitles,
    assessment,
    meta: { reportId: 'VX-RPT-IT-0001', generatedAt: '2026-11-05T00:00:00.000Z', includeSensitive: false },
    privacy: { allowNetwork: false, persistHistory: true },
    issues: { warnings: [], errors: [], conflicts: [] }
  });

  // 1. Redaction happened in the model, once.
  const storageRow = report.sections.find((section) => section.id === 'storage').rows.find((row) => row.key === 'serialNumber');
  assert.equal(storageRow.value, '[redacted]');
  assert.equal(storageRow.redacted, true);
  assert.ok(report.privacy.redactedFields >= 3);

  // 2. The permission-blocked module is present and labelled, not dropped.
  const healthSection = report.sections.find((section) => section.id === 'storageHealth');
  assert.ok(healthSection, 'the privileged section must still appear in the report');
  assert.equal(healthSection.status, Status.PERMISSION_REQUIRED);

  // 3. The health score excludes what could not be measured.
  assert.ok(assessment.coveragePercent < 100);
  assert.match(assessment.disclaimer, /not a certification|excluded/i);

  // 4. Every renderer carries the same withheld value, and none leaks the marker.
  const json = renderJson(report);
  const html = renderHtml(report);
  const csv = renderCsv(report);
  const pdf = await renderPdf(report, { certificate: buildCertificate(report) });

  assert.equal(JSON.parse(json).sections.find((section) => section.id === 'storage').fields.find((field) => field.key === 'serialNumber').redacted, true);
  assert.ok(json.includes('[redacted]'));
  assert.ok(html.includes('[redacted]'));
  assert.ok(csv.includes('[redacted]'));
  assert.ok(pdf.length > 4000);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');

  for (const [label, output] of [['json', json], ['html', html], ['csv', csv]]) {
    assert.ok(!output.includes('TESTSERIAL0001'), `${label} must not contain the withheld serial`);
    assert.ok(!output.includes('AA:BB:CC:DD:EE:FF'), `${label} must not contain the withheld MAC address`);
  }
  assert.ok(!pdf.toString('latin1').includes('TESTSERIAL0001'), 'the PDF must not contain the withheld serial');
});

test('the JSON report records the run provenance including which providers failed', async () => {
  const { results, byModule } = await runSweep(standardSession, { primaryThrows: true });
  const providerLog = results.flatMap((result) =>
    result.attempts.map((attempt) => ({ providerId: attempt.providerId, task: result.taskId, ok: attempt.ok, error: attempt.error }))
  );
  const report = buildReport({
    modules: Object.fromEntries(Object.entries(byModule).map(([id, section]) => [id, section.fields])),
    meta: { reportId: 'VX-RPT-IT-0002' },
    providerLog
  });

  const parsed = JSON.parse(renderJson(report));
  const crashed = parsed.providers.find((entry) => entry.provider === 'fake-primary' && entry.task === 'cpu.info');
  assert.ok(crashed, 'a crashed provider must appear in the provider log');
  assert.equal(crashed.ok, false);
  assert.match(crashed.error, /simulated provider crash/);
});

test('the log redacts identifiers written to disk', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'veridex-log-'));
  try {
    const logger = new Logger({ dir, level: 'info', console: false });
    await logger.info('simulated sweep', {
      scope: 'engine',
      serialNumber: 'TESTSERIAL0001',
      macAddress: 'AA:BB:CC:DD:EE:FF',
      note: 'kept'
    });
    await logger.flush?.();

    const files = await logger.files();
    assert.ok(files.length >= 1);
    const text = await readFile(files[0], 'utf8');
    assert.ok(!text.includes('TESTSERIAL0001'), 'serial numbers must not reach the log file');
    assert.ok(!text.includes('AA:BB:CC:DD:EE:FF'), 'MAC addresses must not reach the log file');
    assert.ok(text.includes('kept'), 'non-sensitive context must survive');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a runner with no usable provider still produces an explanatory report', async () => {
  const registry = new ProviderRegistry();
  registry.registerProvider({
    id: 'fake-dead',
    title: 'Dead source (test double)',
    async collect() {
      return { only: failed('device not present', 'fake-dead') };
    }
  });
  registry.registerTask({ id: 'ghost.info', module: 'ghost', title: 'Ghost subsystem', providers: ['fake-dead'] });

  const runner = new DiagnosticRunner({ registry, permissions: standardSession, logger: new NullLogger(), timeoutMs: 2000 });
  const { byModule } = await runner.runTasks(['ghost.info']);
  // A provider that ran and reported a hard failure produces ERROR, never FAIL:
  // FAIL is reserved for a test that ran and measured an out-of-range result.
  assert.equal(byModule.ghost.fields.only.status, Status.ERROR);

  const report = buildReport({
    modules: { ghost: byModule.ghost.fields },
    sectionTitles: { ghost: byModule.ghost.title },
    meta: { reportId: 'VX-RPT-IT-0003' }
  });
  const html = renderHtml(report);
  assert.ok(html.includes('Ghost subsystem'));
  assert.ok(html.includes('device not present'));
});

test('a permission-required field is rendered differently from a failed one', async () => {
  const modules = {
    demo: {
      needsAdmin: permissionRequired('Requires administrator rights', 'acpi-thermal'),
      broke: failed('WMI class missing', 'cim-win32')
    }
  };
  const report = buildReport({ modules, meta: { reportId: 'VX-RPT-IT-0004' } });
  const html = renderHtml(report);
  assert.ok(html.includes('Permission required'));
  assert.ok(html.includes('Error'));
  assert.notEqual(
    report.sections[0].rows[0].status,
    report.sections[0].rows[1].status,
    'PERMISSION_REQUIRED and ERROR must not collapse into one another'
  );
});
