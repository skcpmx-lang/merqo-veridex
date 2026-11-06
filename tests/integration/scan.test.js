/**
 * Scan orchestration.
 *
 * `runScan` is the seam between the engine and the app. These tests drive it with a
 * fake registry and a fake runner so the whole pipeline — provider selection,
 * permission gating, guard-wrapped commands, health assessment, issue collection and
 * report input — is exercised without touching the host machine. On Linux CI there
 * is no Windows hardware to inspect, and pretending otherwise would be the exact
 * dishonesty this project forbids.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runScan, wrapRunner, reportInputFromScan } from '../../src/app/scan.js';
import { ProviderRegistry } from '../../src/engine/provider-registry.js';
import { CommandRunner } from '../../src/platform/runner.js';
import { SecurityGuard } from '../../src/security/guard.js';
import { NullLogger } from '../../src/core/logger.js';
import { available } from '../../src/core/field.js';
import { Status } from '../../src/core/status.js';
import { buildReport } from '../../src/reporting/model.js';
import { renderHtml } from '../../src/reporting/html.js';
import { InspectionSession } from '../../src/manual/session.js';

function fakeRegistry() {
  const registry = new ProviderRegistry();
  registry.registerProvider({
    id: 'fake-cpu',
    title: 'CPU (test double)',
    async collect() {
      return {
        name: available('Fake Processor 9000', 'fake-cpu'),
        physicalCores: available(6, 'fake-cpu'),
        logicalCores: available(12, 'fake-cpu')
      };
    }
  });
  registry.registerProvider({
    id: 'fake-smart',
    title: 'SMART (test double)',
    capability: 'storage.smart',
    async collect() {
      return { healthStatus: available('Healthy', 'fake-smart') };
    }
  });
  registry.registerTask({ id: 'cpu.info', module: 'cpu', title: 'Processor', providers: ['fake-cpu'], quick: true });
  registry.registerTask({ id: 'storage.health', module: 'storageHealth', title: 'Storage health', providers: ['fake-smart'], requiresCapability: 'storage.smart' });
  return registry;
}

/**
 * Every scan in this file runs as a pinned standard user. Auto-detection would read the
 * host, so the same assertion would pass on a Linux container and fail on an elevated
 * Windows runner — which is exactly what happened in CI.
 */
const STANDARD_SESSION = Object.freeze({
  isAdmin: false,
  isWindows: true,
  mode: 'standard',
  detectedAt: '2026-01-01T00:00:00.000Z',
  detail: 'pinned for tests'
});

test('a scan assembles modules, assessment and issues into one finished object', async () => {
  const scan = await runScan({ registry: fakeRegistry(), logger: new NullLogger(), settings: {}, permissions: STANDARD_SESSION, historyFile: null });

  assert.equal(scan.taskCount, 2);
  assert.equal(scan.cancelled, false);
  assert.ok(scan.modules.cpu, 'the cpu module must be present');
  assert.equal(scan.modules.cpu.name.value, 'Fake Processor 9000');
  assert.equal(scan.sectionTitles.cpu, 'Processor');
  assert.ok(scan.assessment, 'the health assessment must be produced');
  assert.equal(typeof scan.durationMs, 'number');
});

test('a privileged task in a standard session is reported, not silently dropped', async () => {
  // The permission state is pinned. Auto-detection reads the host, and a Windows CI runner
  // starts elevated, so this test used to assert the opposite of its own name there: it
  // passed on Linux and failed on Windows for a reason that had nothing to do with the
  // behaviour it covers.
  const standardSession = Object.freeze({
    isAdmin: false,
    isWindows: true,
    mode: 'standard',
    detectedAt: '2026-01-01T00:00:00.000Z',
    detail: 'pinned for this test'
  });
  const scan = await runScan({ registry: fakeRegistry(), logger: new NullLogger(), settings: {}, historyFile: null, permissions: standardSession });
  const smart = scan.attempts.find((attempt) => attempt.task === 'storage.health');
  assert.ok(smart, 'the attempt must be recorded');
  assert.equal(smart.ok, false);
  assert.match(String(smart.error), /standard users|administrator/i);
  // It belongs in warnings, not errors: it is a permissions fact, not a bug.
  assert.ok(scan.issues.warnings.some((warning) => /storage\.health/.test(warning)));
  assert.equal(scan.issues.errors.length, 0);
});

test('quick mode runs only the tasks marked quick', async () => {
  const scan = await runScan({ registry: fakeRegistry(), logger: new NullLogger(), settings: {}, quick: true, permissions: STANDARD_SESSION, historyFile: null });
  assert.equal(scan.taskCount, 1);
  assert.ok(scan.modules.cpu);
  assert.equal(scan.modules.storageHealth, undefined);
});

test('a requested task that does not exist is an error, not a silent skip', async () => {
  const scan = await runScan({ registry: fakeRegistry(), logger: new NullLogger(), settings: {}, tasks: ['cpu.info', 'ghost.task'], permissions: STANDARD_SESSION, historyFile: null });
  assert.ok(scan.issues.errors.some((error) => /ghost\.task/.test(error)));
});

test('progress is reported per task so the UI can show a real bar', async () => {
  const seen = [];
  const scan = await runScan({
    registry: fakeRegistry(),
    logger: new NullLogger(),
    settings: {},
    permissions: STANDARD_SESSION,
    historyFile: null,
    onProgress: (progress) => seen.push(progress)
  });
  assert.equal(seen.length, scan.taskCount);
  assert.equal(seen[0].done, 1);
  assert.equal(seen.at(-1).total, scan.taskCount);
});

test('a cancelled scan stops and says so', async () => {
  const controller = new AbortController();
  controller.abort();
  const scan = await runScan({ registry: fakeRegistry(), logger: new NullLogger(), settings: {}, signal: controller.signal, permissions: STANDARD_SESSION, historyFile: null });
  assert.equal(scan.cancelled, true);
  assert.equal(scan.taskCount, 2, 'the requested task count is still known');
  assert.equal(Object.keys(scan.modules).length, 0);
});

test('a written history entry is stored and readable back', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'veridex-scan-'));
  try {
    const file = path.join(dir, 'history.json');
    const scan = await runScan({ registry: fakeRegistry(), logger: new NullLogger(), settings: {}, historyFile: file });
    assert.ok(scan.historyEntry, 'a history entry should be created');
    const raw = JSON.parse(await readFile(file, 'utf8'));
    const entries = Array.isArray(raw) ? raw : raw.entries;
    assert.ok(entries.length >= 1);
    assert.equal(entries[0].id, scan.historyEntry.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('history is not written when the user turned persistence off', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'veridex-nohistory-'));
  try {
    const file = path.join(dir, 'history.json');
    const scan = await runScan({
      registry: fakeRegistry(),
      logger: new NullLogger(),
      settings: { 'diagnostics.persistHistory': false },
      permissions: STANDARD_SESSION,
      historyFile: file
    });
    assert.equal(scan.historyEntry, undefined);
    await assert.rejects(readFile(file, 'utf8'), 'no history file should have been created');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the guard refuses a destructive command even when a provider asks for it', async () => {
  const guard = new SecurityGuard({ logger: new NullLogger() });
  const runner = wrapRunner(new CommandRunner({ platform: 'win32' }), guard);

  const blocked = await runner.run('chkdsk', ['C:', '/f']);
  assert.equal(blocked.ok, false);
  assert.match(blocked.stderr, /VERIDEX refused/);
  assert.equal(guard.summary().unsafeCommandsBlocked, 1);

  // A read-only invocation of the same tool must still be permitted.
  const allowed = guard.checkCommand('chkdsk', ['C:', '/scan']);
  assert.equal(allowed.allowed, true);
});

test('a scan converts into report input that carries provenance and manual results', async () => {
  const session = new InspectionSession();
  session.record('display.white', Status.PASS, { defects: 0, notes: ['clean panel'] });
  const scan = await runScan({ registry: fakeRegistry(), logger: new NullLogger(), settings: {}, session, permissions: STANDARD_SESSION, historyFile: null });

  const input = reportInputFromScan(scan, { reportId: 'VX-RPT-SCAN-1' });
  const report = buildReport(input);

  assert.equal(report.meta.reportId, 'VX-RPT-SCAN-1');
  assert.ok(report.providerLog.length >= 2, 'every provider attempt must reach the report');
  assert.equal(report.manualCoverage.answered, 1);
  assert.equal(report.sections.length, 2);

  const html = renderHtml(report);
  assert.ok(html.includes('Fake Processor 9000'));
  assert.ok(html.includes('clean panel'));
  // The blocked privileged provider must be visible, not hidden.
  assert.ok(html.includes('Data sources attempted'));
});

test('a scan on a host with no diagnostics produces an unrated assessment, never a fake score', async () => {
  const empty = new ProviderRegistry();
  const scan = await runScan({ registry: empty, logger: new NullLogger(), settings: {}, permissions: STANDARD_SESSION, historyFile: null });
  assert.equal(scan.taskCount, 0);
  assert.equal(scan.assessment.score, null);
  assert.equal(scan.assessment.rating, 'Unrated');
});

test('two scans write history a comparison can actually read', async () => {
  // The comparison feature was hollow: runScan stored `assessment` but never the documented
  // `summary` or `snapshot`, so history:compare flattened {} against {} and told the user
  // nothing had changed between two runs, with both scores shown as unrated. This drives two
  // real scans through the same code path that writes history, then compares the stored entries.
  const { HistoryStore } = await import('../../src/history/store.js');
  const { compareEntries } = await import('../../src/history/compare.js');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'veridex-history-'));
  const file = path.join(dir, 'history.json');

  const makeRegistry = (cores) => {
    const registry = new ProviderRegistry();
    registry.registerProvider({ id: 'fake-cpu', title: 'CPU (test double)', async collect() { return { physicalCores: available(cores, 'fake-cpu') }; } });
    registry.registerTask({ id: 'cpu.info', module: 'cpu', title: 'Processor', providers: ['fake-cpu'] });
    return registry;
  };

  try {
    await runScan({ registry: makeRegistry(6), logger: new NullLogger(), settings: {}, permissions: STANDARD_SESSION, historyFile: file, appVersion: '1.0.0' });
    await runScan({ registry: makeRegistry(4), logger: new NullLogger(), settings: {}, permissions: STANDARD_SESSION, historyFile: file, appVersion: '1.0.0' });

    const store = new HistoryStore({ file });
    await store.load();
    assert.equal(store.entries.length, 2, 'both runs must be in the history');
    for (const entry of store.entries) {
      assert.ok(entry.snapshot && Object.keys(entry.snapshot).length > 0, 'a stored run must carry a field snapshot');
      assert.equal(entry.summary.modules, 1);
      assert.equal(entry.appVersion, '1.0.0');
      assert.equal(entry.kind, 'full-scan');
      assert.equal(typeof entry.durationMs, 'number');
    }

    const [after, before] = store.entries;
    const comparison = compareEntries(before, after);
    const cores = comparison.differences.find((diff) => /cpu\.physicalCores$/.test(diff.path));
    assert.ok(cores, `the change in physical cores must appear in the comparison: ${comparison.differences.map((d) => d.path).join(', ')}`);
    assert.equal(cores.before, 6);
    assert.equal(cores.after, 4);
    assert.equal(cores.kind, 'changed');
    // This fixture runs one provider, so the honest assessment is UNRATED: the score is null
    // and the comparison must report null rather than invent one. What matters is that the
    // entry carries the field, so a rated run shows its number in the same place.
    assert.equal(comparison.before.score, null);
    assert.ok(Object.prototype.hasOwnProperty.call(store.entries[0].summary, 'overallScore'), 'the summary must carry the score field even when unrated');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
