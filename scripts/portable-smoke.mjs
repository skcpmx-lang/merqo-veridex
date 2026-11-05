#!/usr/bin/env node
/**
 * VERIDEX — launch the portable executable and confirm it runs.
 *
 * The portable build is a self-extracting NSIS wrapper: it unpacks the application to a temp
 * directory and runs it from there. That path is different from both the unpacked build and an
 * installed one, and it is the build most likely to be broken by a resource path or a
 * `process.execPath` assumption, because the executable the user double-clicked is not the
 * executable that ends up running.
 *
 * This checks exactly that it starts, renders, and can talk to its own main process.
 *
 *   node scripts/portable-smoke.mjs --exe release/VERIDEX-1.0.0-portable-x64.exe
 *
 * Exit 0 launched and worked · 1 broken · 2 cannot answer here (not Windows, no executable).
 *
 * @module
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const valueOf = (flag, fallback = null) => {
  const index = argv.indexOf(flag);
  return index > -1 && argv[index + 1] ? argv[index + 1] : fallback;
};

const reportPath = path.resolve(valueOf('--json', path.join(ROOT, 'portable-smoke.json')));

/** @type {string[]} */
const problems = [];
/** @type {number} */
let passed = 0;

/** @param {'ok'|'info'|'warn'|'fail'} level @param {string} message */
function record(level, message) {
  if (level === 'ok') passed += 1;
  if (level === 'fail') {
    problems.push(message);
    // Announced at the moment it happens. A summary printed at the end is lost entirely if
    // anything throws in between - which is exactly how a step fails with no annotation.
    emit('fail', 'portable-smoke problem', message);
  }
  const prefix = level === 'fail' ? 'FAIL' : level === 'warn' ? 'WARN' : level === 'ok' ? '  ok' : ' info';
  console.log(`${prefix}  ${message}`);
}

/** @param {string} title @param {string} message */
function emit(level, title, message) {
  const command = level === 'fail' ? 'error' : 'notice';
  console.log(`::${command}::${`${title}: ${message}`.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
}

const exe = (() => {
  const explicit = valueOf('--exe', null);
  if (explicit) return path.resolve(explicit);
  // dist/ is where electron-builder writes; release/ is a conventional alternative.
  for (const directory of ['dist', 'release', '.']) {
    const full = path.join(ROOT, directory);
    if (!existsSync(full)) continue;
    const candidate = readdirSync(full).find((name) => /^VERIDEX-.*portable.*\.exe$/i.test(name));
    if (candidate) return path.join(full, candidate);
  }
  console.log(`info  no ${'portable executable'} matched; searched: ${
    ['dist', 'release', '.']
      .map((directory) => {
        const full = path.join(ROOT, directory);
        if (!existsSync(full)) return `${directory} (absent)`;
        const exes = readdirSync(full).filter((name) => name.toLowerCase().endsWith('.exe'));
        return `${directory} (${exes.length ? exes.join(', ') : 'no .exe files'})`;
      })
      .join(' | ')
  }`);
  return null;
})();

function writeReport(complete, extra = {}) {
  const report = {
    kind: 'portable-smoke',
    platform: process.platform,
    exe,
    complete,
    passed,
    problems,
    ...extra
  };
  mkdirSync(path.dirname(reportPath), { recursive: true });
  const temporary = `${reportPath}.part`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(temporary, reportPath);
}

if (process.platform !== 'win32') {
  record('info', `this machine is ${process.platform}: a Windows executable cannot be launched here`);
  writeReport(false, { skipped: true, reason: 'not Windows' });
  process.exitCode = 2;
} else if (!exe || !existsSync(exe)) {
  record('info', 'no portable executable found — nothing to launch');
  writeReport(false, { skipped: true, reason: 'no executable' });
  process.exitCode = 2;
} else {
  // Nothing may escape unannotated. The first run of this script failed on Windows with exit 1
  // and no annotation at all, which told us nothing; a stack trace in an annotation would have
  // told us everything.
  try {
    await check();
  } catch (error) {
    record('fail', `the portable check crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    try {
      writeReport(false);
    } catch {
      // If even the report cannot be written, the annotation above is the evidence.
    }
    emit('fail', 'portable-smoke', `${passed} check(s) passed · ${problems.length} problem(s)`);
    process.exitCode = 1;
  }
}

async function check() {
  record('info', `portable executable: ${exe} (${readFileSync(exe).length} bytes)`);
  record('info', `working directory: ${ROOT}`);
  record('info', `report will be written to ${reportPath}`);

  // The portable build extracts to a temp directory and relaunches itself. Point the smoke test
  // at a report path outside the extraction directory, because that directory is deleted.
  const report = path.join(os.tmpdir(), 'veridex-portable-smoke.json');
  const exitCode = await new Promise((resolve) => {
    const child = spawn(exe, [], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // The light harness, not the full GUI suite: the question here is whether this build
      // starts and works from its extraction directory, and the full page walk already runs
      // against the unpacked build in the step before this one.
      env: {
        ...process.env,
        VERIDEX_INSTALL_SMOKE: '1',
        VERIDEX_INSTALL_SMOKE_REPORT: report,
        VERIDEX_SMOKE_VARIANT: 'portable'
      }
    });
    let output = '';
    child.stdout?.on('data', (chunk) => { output += chunk; });
    child.stderr?.on('data', (chunk) => { output += chunk; });
    // A portable application that has not reported within eight minutes is not going to.
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* gone */ }
      resolve({ code: -1, output, timedOut: true });
    }, 480_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, output: `${output}${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output });
    });
  });

  const verdictPath = report;
  if (typeof exitCode === 'object') record('info', `portable application output tail:\n${exitCode.output.trim().split('\n').slice(-12).join('\n')}`);
  else record('info', `portable application exited ${exitCode}`);

  if (!existsSync(verdictPath)) {
    record('fail', 'the portable executable did not write a verdict — it either failed to start or crashed');
    writeReport(true);
    emit('fail', 'portable-smoke', 'the portable executable did not start');
    process.exitCode = 1;
    return;
  }

  let verdict = null;
  try {
    verdict = JSON.parse(readFileSync(verdictPath, 'utf8'));
  } catch (error) {
    record('fail', `the portable verdict could not be read: ${error.message}`);
  }

  if (verdict) {
    for (const finding of verdict.findings ?? []) {
      record(finding.level === 'fail' ? 'fail' : finding.level, `[portable] ${finding.message}`);
    }
    for (const problem of verdict.problems ?? []) record('fail', `[portable] ${problem}`);
    if (verdict.complete !== true) record('fail', 'the portable application stopped before finishing its own checks');
    // The portable wrapper extracts before running, so execPath is a temp directory. That is
    // expected and worth recording: it is the reason this build needs its own check.
    record('info', `extracted to ${path.dirname(verdict.app?.executable ?? '(unknown)')}`);
    if (verdict.app?.packaged !== true) record('fail', 'the portable build is not running as a packaged application');
  }

  writeReport(true, { exitCode });
  const ok = problems.length === 0;
  emit(ok ? 'notice' : 'fail', 'portable-smoke', `${passed} check(s) passed · ${problems.length} problem(s)`);
  process.exitCode = ok ? 0 : 1;
}
