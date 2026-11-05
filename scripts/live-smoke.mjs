#!/usr/bin/env node
/**
 * VERIDEX — live platform smoke test.
 *
 * Every other test in this repository drives the diagnostic layer with a no-op runner, so
 * the providers have never issued a real command. That is a large blind spot: a parser
 * tested against a fixture proves the parser matches the *fixture*, and the fixture was
 * written by the same person who wrote the parser.
 *
 * This script closes part of that gap on a real machine. It is **not** a unit test and is
 * not part of `npm test`, because it requires real Windows and real hardware. It is run by
 * CI on a Windows runner and can be run by a person on their own machine.
 *
 *   node scripts/live-smoke.mjs [--json <path>] [--timeout <ms>]
 *
 * What it does, in order:
 *   1. detects the real permission state through the real probes;
 *   2. runs the real WMI / PowerShell / registry read paths and reports what came back;
 *   3. executes all 15 registered tasks with the real runner, then validates every field
 *      that comes out against the same rules the test suite enforces;
 *   4. prints what each provider actually returned — including every UNAVAILABLE, so the
 *      absences are visible rather than summarised away.
 *
 * Exit code is 0 when the smoke test *completes*. It does not fail because a field is
 * unavailable: on a virtual machine many legitimately are, and "unavailable is a valid
 * answer" is a core property of the product. It fails only on a structural problem —
 * a provider that throws, a field that claims a value it does not have, or a field that is
 * unavailable without saying why.
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CommandRunner } from '../src/platform/runner.js';
import { detectPermissionState } from '../src/platform/permissions.js';
import { classifyCimError, queryCim, readRegistry, loadSystemInformation } from '../src/platform/windows.js';
import { runScan } from '../src/app/scan.js';
import { Status } from '../src/core/status.js';

const argv = process.argv.slice(2);
const argValue = (name, fallback = null) => {
  const index = argv.indexOf(name);
  return index > -1 && argv[index + 1] ? argv[index + 1] : fallback;
};
const JSON_OUT = argValue('--json');
const TASK_TIMEOUT = Number(argValue('--timeout', '60000'));

const VALID_STATUSES = new Set(Object.values(Status));
const findings = [];
const problems = [];

const IN_ACTIONS = process.env.GITHUB_ACTIONS === 'true';

/** Escape a value for a GitHub Actions workflow command. */
function cmdEscape(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/**
 * @param {'ok'|'info'|'warn'|'fail'} level
 * @param {string} message
 *
 * Failures are also emitted as workflow commands. CI logs are frequently unreachable, so
 * an error that exists only in stdout is invisible to whoever has to fix it; an annotation
 * is not.
 */
function record(level, message) {
  findings.push({ level, message });
  const prefix = level === 'fail' ? 'FAIL' : level === 'warn' ? 'WARN' : level === 'ok' ? '  ok' : ' info';
  console.log(`${prefix}  ${message}`);
  if (level === 'fail') {
    problems.push(message);
    if (IN_ACTIONS) console.log(`::error title=live-smoke::${cmdEscape(message.slice(0, 900))}`);
  }
  if (level === 'warn' && IN_ACTIONS) console.log(`::warning title=live-smoke::${cmdEscape(message.slice(0, 400))}`);
}

function heading(title) {
  console.log('');
  console.log(`── ${title} ${'─'.repeat(Math.max(0, 66 - title.length))}`);
}

const runner = new CommandRunner();

async function main() {
  console.log('VERIDEX live platform smoke test');
  console.log(`  host platform: ${process.platform} ${process.arch}`);
  console.log(`  node: ${process.version}`);
  console.log(`  cwd: ${process.cwd()}`);

  // ── 1. Permission state ───────────────────────────────────────────────────
  heading('Permission state');
  const permissions = await detectPermissionState(runner);
  record('info', `mode=${permissions.mode} isAdmin=${permissions.isAdmin} isWindows=${permissions.isWindows}`);
  record('info', `detail: ${permissions.detail}`);
  if (!permissions.isWindows) {
    record('warn', 'Not running on Windows. The Windows read paths below will report "not running on Windows" — that is the documented behaviour, not a failure.');
  }

  // ── 2. Raw platform reads ─────────────────────────────────────────────────
  heading('Raw platform reads');

  const cpu = await queryCim(runner, 'Win32_Processor', { properties: ['Name', 'NumberOfCores', 'NumberOfLogicalProcessors', 'MaxClockSpeed'] });
  if (cpu.ok) {
    const row = cpu.rows[0];
    record('ok', `CIM Win32_Processor returned ${cpu.rows.length} row(s); first name = ${JSON.stringify(row?.Name ?? null)}`);
    if (!row?.Name) record('warn', 'Win32_Processor returned a row with no Name — the parser would produce an empty CPU name.');
  } else {
    const cause = classifyCimError(cpu.error);
    record(permissions.isWindows ? 'warn' : 'info', `CIM Win32_Processor did not succeed: ${cpu.error} (accessDenied=${cause.accessDenied}, unavailable=${cause.unavailable})`);
  }

  const board = await queryCim(runner, 'Win32_BaseBoard', { properties: ['Manufacturer', 'Product'] });
  record(board.ok ? 'ok' : 'warn', board.ok ? `CIM Win32_BaseBoard: ${board.rows[0]?.Manufacturer ?? '?'} ${board.rows[0]?.Product ?? '?'}` : `CIM Win32_BaseBoard: ${board.error}`);

  const disks = await queryCim(runner, 'Win32_DiskDrive', { properties: ['Model', 'Size', 'MediaType', 'InterfaceType'] });
  if (disks.ok) {
    record('ok', `CIM Win32_DiskDrive returned ${disks.rows.length} drive(s)`);
    for (const disk of disks.rows.slice(0, 4)) {
      record('info', `  ${disk.Model ?? '?'} — ${disk.Size ?? '?'} bytes — ${disk.MediaType ?? '?'} / ${disk.InterfaceType ?? '?'}`);
    }
  } else {
    record('warn', `CIM Win32_DiskDrive: ${disks.error}`);
  }

  const battery = await queryCim(runner, 'BatteryStaticData', { namespace: 'root/wmi', properties: ['DesignedCapacity'] });
  record(battery.ok ? 'ok' : 'info', battery.ok ? `BatteryStaticData returned ${battery.rows.length} row(s)` : `BatteryStaticData: ${battery.error} (a desktop or VM has no battery; NOT_APPLICABLE is the correct answer there)`);

  const registry = await readRegistry(runner, 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion', { names: ['ProductName', 'CurrentBuild', 'UBR'] });
  record(registry.ok ? 'ok' : 'warn', registry.ok ? `Registry: ${registry.values.map((v) => `${v.name}=${v.value}`).join(', ') || '(no matching values)'}` : `Registry read: ${registry.error}`);

  const powershell = await runner.powershellJson('$PSVersionTable.PSVersion.ToString()', { name: 'smoke:psversion', timeoutMs: 20_000 });
  record(powershell.ok ? 'ok' : 'warn', powershell.ok ? `PowerShell JSON path works; PSVersion = ${JSON.stringify(powershell.data)}` : `PowerShell JSON path failed: ${powershell.error}`);

  const si = await loadSystemInformation();
  record(si.ok ? 'ok' : 'warn', si.ok ? 'systeminformation loaded' : `systeminformation unavailable: ${si.error}`);

  // ── 3. A real scan ────────────────────────────────────────────────────────
  heading('Full diagnostic sweep with the real runner');
  const startedAt = Date.now();
  let scan = null;
  try {
    scan = await runScan({ settings: {}, historyFile: null, timeoutMs: TASK_TIMEOUT, permissions });
  } catch (error) {
    record('fail', `runScan threw: ${error instanceof Error ? error.stack : String(error)}`);
  }

  if (scan) {
    record('ok', `sweep completed in ${Date.now() - startedAt} ms: ${scan.taskCount} tasks, ${scan.providersAttempted} provider attempts, ${Object.keys(scan.modules).length} modules produced fields`);

    if (scan.issues.errors.length > 0) {
      for (const error of scan.issues.errors) record('fail', `scan error: ${error}`);
    } else {
      record('ok', 'no scan errors');
    }
    for (const warning of scan.issues.warnings) record('info', `warning: ${warning}`);

    const assessment = scan.assessment;
    record(
      assessment.gated ? 'info' : 'ok',
      `assessment: score=${assessment.score} raw=${assessment.rawScore} rating=${assessment.rating} ` +
      `gated=${assessment.gated} capped=${assessment.capped} coverage=${assessment.coveragePercent}% ` +
      `(${assessment.ratedComponents}/${assessment.totalComponents} components)`
    );
    if (assessment.gated && !assessment.gatingNote) {
      record('fail', 'the score was withheld but no gatingNote explains why — the user would see a blank score with no reason');
    }

    // ── 4. Validate every field against the same rules the suite enforces ───
    heading('Field validation');
    let total = 0;
    const statusCounts = {};
    for (const [moduleId, fields] of Object.entries(scan.modules)) {
      for (const [key, value] of Object.entries(fields)) {
        total += 1;
        statusCounts[value.status] = (statusCounts[value.status] ?? 0) + 1;
        if (!VALID_STATUSES.has(value.status)) {
          record('fail', `${moduleId}.${key}: status "${value.status}" is not in the vocabulary`);
          continue;
        }
        if ([Status.PASS, Status.WARNING, Status.FAIL].includes(value.status) && (value.value === null || value.value === undefined)) {
          record('fail', `${moduleId}.${key}: claims ${value.status} with no value`);
        }
        if ([Status.UNAVAILABLE, Status.UNSUPPORTED, Status.ERROR, Status.PERMISSION_REQUIRED].includes(value.status)) {
          const explained = (value.error && String(value.error).length > 3) || (value.notes ?? []).some((note) => String(note).length > 3);
          if (!explained) record('fail', `${moduleId}.${key}: ${value.status} with no explanation — the user would see a blank cell with no reason`);
        }
      }
    }
    record('ok', `${total} fields validated across ${Object.keys(scan.modules).length} modules`);
    record('info', `status distribution: ${Object.entries(statusCounts).map(([status, count]) => `${status}=${count}`).join(', ')}`);

    // ── 5. What each provider actually returned ─────────────────────────────
    heading('Provider attempts');
    // The flat `scan.attempts` list is a summary (provider, task, ok, status, error); the
    // per-attempt field counts live on each task result. Reading the summary and asking for
    // `fieldCount` produced a page of misleading "0 field(s)".
    const byProvider = new Map();
    const detail = scan.results.flatMap((task) => task.attempts.map((attempt) => ({ ...attempt, task: task.taskId })));
    for (const attempt of detail) {
      const entry = byProvider.get(attempt.providerId) ?? { attempts: 0, ok: 0, fields: 0, errors: new Set(), tasks: new Set() };
      entry.attempts += 1;
      if (attempt.ok) entry.ok += 1;
      entry.fields += attempt.fieldCount ?? 0;
      entry.tasks.add(attempt.task);
      if (attempt.error) entry.errors.add(String(attempt.error).slice(0, 140));
      byProvider.set(attempt.providerId, entry);
    }
    for (const [providerId, entry] of [...byProvider.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const note = entry.errors.size > 0 ? ` — ${[...entry.errors].join(' | ')}` : '';
      record(entry.fields > 0 ? 'ok' : 'info', `${providerId}: ${entry.fields} field(s), task(s) ${[...entry.tasks].join(', ')}${note}`);
    }

    // ── 6. Report and history round trip ────────────────────────────────────
    heading('Report and history round trip');
    try {
      const { buildReport } = await import('../src/reporting/model.js');
      const { reportInputFromScan } = await import('../src/app/scan.js');
      const { renderJson } = await import('../src/reporting/json.js');
      const { renderHtml } = await import('../src/reporting/html.js');
      const { renderPdf } = await import('../src/reporting/pdf.js');
      const { buildCertificate } = await import('../src/reporting/certificate.js');

      const report = buildReport(reportInputFromScan(scan, { reportId: `VX-SMOKE-${Date.now()}` }));
      const json = JSON.parse(renderJson(report));
      record('ok', `JSON report built; assessment.gated=${json.assessment?.gated} gatingNote present=${Boolean(json.assessment?.gatingNote)}`);
      const html = renderHtml(report);
      record('ok', `HTML report built (${html.length} bytes); carries the gating note: ${/coverage limit|withheld/i.test(html)}`);
      const pdf = await renderPdf(report);
      record('ok', `PDF report built (${pdf.length} bytes)`);
      const certificate = buildCertificate(report);
      record('info', `certificate verdict: ${JSON.stringify(certificate.overallText)}`);
    } catch (error) {
      record('fail', `report generation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  heading('Summary');
  const failures = findings.filter((finding) => finding.level === 'fail').length;
  const warnings = findings.filter((finding) => finding.level === 'warn').length;
  console.log(`${findings.length} finding(s): ${failures} failure(s), ${warnings} warning(s), ${findings.length - failures - warnings} informational`);
  console.log('');
  console.log('NOT PROVEN BY THIS SCRIPT: that the packaged application installs, launches or');
  console.log('renders. This exercises the diagnostic layer against real interfaces on a real');
  console.log('Windows host; it does not open a window. See docs/RELEASE_VERIFICATION.md.');

  if (JSON_OUT) {
    const payload = {
      generatedAt: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      permissions,
      findings,
      problems,
      fieldsValidated: scan ? Object.values(scan.modules).reduce((sum, fields) => sum + Object.keys(fields).length, 0) : 0,
      assessment: scan?.assessment
        ? {
            score: scan.assessment.score,
            rawScore: scan.assessment.rawScore,
            rating: scan.assessment.rating,
            gated: scan.assessment.gated,
            capped: scan.assessment.capped,
            coveragePercent: scan.assessment.coveragePercent,
            gatingNote: scan.assessment.gatingNote ?? null
          }
        : null,
      providerAttempts: scan?.attempts?.length ?? 0,
      scanErrors: scan?.issues?.errors ?? []
    };
    await writeFile(path.resolve(JSON_OUT), JSON.stringify(payload, null, 2), 'utf8');
    console.log(`\nJSON evidence written to ${JSON_OUT}`);
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      '## VERIDEX live smoke test',
      '',
      `Host: \`${process.platform} ${process.arch}\`, node ${process.version}`,
      '',
      '| Level | Finding |',
      '| --- | --- |',
      ...findings.map((finding) => `| ${finding.level} | ${finding.message.replace(/\|/g, '\\|').slice(0, 300)} |`),
      '',
      problems.length > 0
        ? `**${problems.length} structural problem(s).** A provider threw, or a field claimed data it does not have.`
        : 'No structural problems. This does not prove the packaged app runs — see docs/RELEASE_VERIFICATION.md.'
    ];
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    const { appendFile } = await import('node:fs/promises');
    await appendFile(summaryPath, `${lines.join('\n')}\n\n`, 'utf8');
  }

  if (problems.length > 0) {
    console.error(`\n${problems.length} structural problem(s) found:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  }
}

await main();
