#!/usr/bin/env node
/**
 * VERIDEX — launch the real application and run the GUI smoke test.
 *
 * `src/app/gui-smoke.js` runs *inside* Electron. This script is what starts it, waits for
 * the verdict it writes, and turns that verdict into an exit code plus CI annotations.
 *
 *   node scripts/gui-smoke.mjs                 # run against the repository
 *   node scripts/gui-smoke.mjs --dist app      # run against a packaged build in app/
 *   node scripts/gui-smoke.mjs --json out.json
 *
 * It refuses to run where it cannot, with a reason, rather than producing a false pass:
 *   - no Electron binary      → exit 2, "cannot run here"
 *   - no display, no Xvfb     → exit 2, "cannot run here" (unless --offscreen)
 *   - the app did not start   → exit 1, a real failure
 *
 * Exit 2 means "this environment cannot answer the question"; exit 1 means the application
 * is broken. Collapsing the two is how a CI job ends up green while the app does not start.
 *
 * @module
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findElectron } from './electron-path.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag, fallback = null) => {
  const index = argv.indexOf(flag);
  return index > -1 && argv[index + 1] ? argv[index + 1] : fallback;
};

const targetDir = valueOf('--dist', null);
const verbatimReport = valueOf('--json', null);
const reportPath = verbatimReport
  ? path.resolve(verbatimReport)
  : path.join(os.tmpdir(), `veridex-gui-smoke-${Date.now()}.json`);

const IN_ACTIONS = process.env.GITHUB_ACTIONS === 'true';
const emit = (level, title, message) => {
  if (!IN_ACTIONS) return;
  const escaped = String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::${level} title=${title}::${escaped}`);
};

function cannotRun(reason) {
  console.error(`CANNOT RUN GUI SMOKE: ${reason}`);
  emit('warning', 'gui-smoke', `not run: ${reason}`);
  process.exitCode = 2;
}

const electron = findElectron();
if (!electron.ok) {
  cannotRun(electron.reason);
} else {
  await execute(electron);
}

/** @param {{ok:true, path:string, version:string}} electron */
async function execute(electron) {
  const appPath = targetDir ? path.resolve(ROOT, targetDir) : ROOT;
  const packagedExe = targetDir && process.platform === 'win32' ? path.join(appPath, 'VERIDEX.exe') : null;
  const isExecutableRun = packagedExe && existsSync(packagedExe);

  // A display is mandatory unless the caller asks for offscreen rendering. On a Linux
  // runner that means Xvfb; on Windows and macOS a desktop session always exists.
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !has('--offscreen')) {
    cannotRun('no display server and --offscreen was not requested; run under xvfb-run');
    return;
  }

  const args = [];
  if (has('--offscreen')) args.push('--headless', '--disable-gpu', '--in-process-gpu');
  if (!isExecutableRun) args.push(appPath);

  const command = isExecutableRun ? packagedExe : electron.path;
  console.log(`Launching: ${command} ${args.join(' ')}`);
  console.log(`  electron ${electron.version}; report → ${reportPath}`);

  const child = spawn(command, args, {
    cwd: appPath,
    env: { ...process.env, VERIDEX_GUI_SMOKE: '1', VERIDEX_GUI_SMOKE_REPORT: reportPath },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    stdout += text;
    for (const line of text.split(/\r?\n/)) {
      if (/^(FAIL|WARN|  ok| info)/.test(line) || /finding|verdict|NOT PROVEN/.test(line)) console.log(`  [app] ${line}`);
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const deadline = Date.now() + 360_000;
  const timer = setInterval(() => {
    if (Date.now() > deadline) {
      console.error('The application did not exit within 6 minutes; terminating it.');
      child.kill('SIGKILL');
    }
  }, 5_000);

  const exitCode = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? -1));
  });
  clearInterval(timer);

  if (stderr.trim()) {
    const interesting = stderr.split(/\r?\n/).filter((line) => !/DevTools|GPU|Vulkan|dxgi|d3d11|libva/i.test(line)).slice(0, 30);
    if (interesting.length > 0) console.log(`  [stderr] ${interesting.join('\n  [stderr] ')}`);
  }

  if (!existsSync(reportPath)) {
    console.error(`The application exited (${exitCode}) without writing a verdict.`);
    console.error(stdout.slice(-2_000));
    emit('error', 'gui-smoke', `the app exited ${exitCode} before reporting. Last output: ${stdout.slice(-400)}`);
    process.exitCode = 1;
    return;
  }

  /** @type {{problems:string[], findings:Array<{level:string,message:string}>, electron:string, packaged:boolean}} */
  const verdict = JSON.parse(readFileSync(reportPath, 'utf8'));
  if (verdict.complete === false) {
    // The verdict was written incrementally (so a crash still leaves evidence) but the run
    // never reached its end. Say so, and treat it as a failure.
    verdict.problems = [
      ...(verdict.problems ?? []),
      `the run did not complete: it stopped after ${verdict.findings?.length ?? 0} finding(s)`
    ];
  }
  const okCount = verdict.findings.filter((finding) => finding.level === 'ok').length;
  const warnCount = verdict.findings.filter((finding) => finding.level === 'warn').length;

  console.log('');
  console.log(`VERDICT: ${verdict.problems.length === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`  electron ${verdict.electron}, packaged=${verdict.packaged}, ${okCount} steps passed, ${warnCount} warnings, ${verdict.problems.length} problems`);

  // One annotation per problem. A single concatenated line gets truncated by the API and
  // then the reader has to guess which failure came first.
  emit('notice', 'gui-smoke', `electron ${verdict.electron} · ${okCount} steps passed · ${warnCount} warning(s) · ${verdict.problems.length} problem(s)`);
  for (const problem of verdict.problems.slice(0, 10)) {
    emit('error', 'gui-smoke problem', problem);
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      '## VERIDEX GUI smoke test',
      '',
      `Electron ${verdict.electron} · Chromium ${verdict.chromium} · packaged=${verdict.packaged}`,
      '',
      '| Level | Finding |',
      '| --- | --- |',
      ...verdict.findings.map((finding) => `| ${finding.level} | ${String(finding.message).replace(/\|/g, '\\|').slice(0, 220)} |`),
      '',
      verdict.problems.length === 0
        ? 'No problems. This proves the window opens, the pages render and the IPC contract holds — **not** that any diagnostic value is correct, and not that the installer installs.'
        : `**${verdict.problems.length} problem(s).** ${verdict.problems.join('; ')}`
    ];
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n\n`);
  }

  if (!verbatimReport) await rm(reportPath, { force: true }).catch(() => {});
  mkdirSync(path.dirname(reportPath), { recursive: true });

  process.exitCode = verdict.problems.length > 0 ? 1 : 0;
}
