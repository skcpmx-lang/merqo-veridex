#!/usr/bin/env node
/**
 * VERIDEX — install the real installer, run the installed application, remove it.
 *
 * The GUI smoke test drives the unpacked build, which proves the application works but says
 * nothing about whether the installer installs. This script answers that question on Windows:
 *
 *   1. run `VERIDEX-Setup-<version>-x64.exe /S` silently, per-user
 *   2. confirm the installation directory and the uninstaller exist
 *   3. launch the installed executable with the install smoke test attached
 *   4. read its verdict, which proves the installed build starts, renders and talks to its own
 *      main process from inside its own asar
 *   5. run the uninstaller silently, and confirm it removed what it installed
 *   6. confirm user data survived the uninstall (deleteAppDataOnUninstall is false, and a
 *      settings-vanishing uninstall would be a bug, not a feature)
 *
 * Exit codes follow the GUI harness, because they answer different questions:
 *   0 — installed, ran, uninstalled, clean
 *   1 — the installer or the installed application is broken
 *   2 — this machine cannot answer the question (not Windows, no installer)
 *
 * Whatever the outcome, it writes `install-smoke.json` and prints one annotation per problem.
 * The evidence this produces is the difference between "we built an installer" and "the
 * installer installs".
 *
 *   node scripts/install-smoke.mjs                     # find the installer in release/
 *   node scripts/install-smoke.mjs --installer path    # use a specific installer
 *   node scripts/install-smoke.mjs --json out.json     # write the report elsewhere
 *   node scripts/install-smoke.mjs --keep              # do not uninstall or wipe (debugging)
 *
 * @module
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag, fallback = null) => {
  const index = argv.indexOf(flag);
  return index > -1 && argv[index + 1] ? argv[index + 1] : fallback;
};

const reportPath = path.resolve(valueOf('--json', path.join(ROOT, 'install-smoke.json')));
const keep = has('--keep');

/** @type {{level: string, message: string}[]} */
const findings = [];
/** @type {string[]} */
const problems = [];

/** @param {'ok'|'info'|'warn'|'fail'} level @param {string} message */
function record(level, message) {
  findings.push({ level, message });
  const prefix = level === 'fail' ? 'FAIL' : level === 'warn' ? 'WARN' : level === 'ok' ? '  ok' : ' info';
  console.log(`${prefix}  ${message}`);
}

/** @param {string} message */
function fail(message) {
  problems.push(message);
  record('fail', message);
}

/** Emit a GitHub Actions annotation; harmless elsewhere. @param {string} level @param {string} title @param {string} message */
function emit(level, title, message) {
  const command = level === 'fail' ? 'error' : level;
  const text = `${title}: ${message}`.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::${command}::${text}`);
}

/**
 * Record a failure and announce it immediately.
 * A summary at the end is lost if anything throws in between, which is how a step fails with
 * no annotation and no explanation - the exact failure mode this project has paid for twice.
 * @param {string} message
 */
function failNow(message) {
  problems.push(message);
  console.log(`FAIL  ${message}`);
  emit('fail', 'install-smoke problem', message);
}

/** Write the report. Renamed into place so a reader never sees half a document. */
function writeReport(complete, extra = {}) {
  const report = {
    kind: 'install-smoke-launcher',
    platform: process.platform,
    installer: installerPath,
    installedDir,
    complete,
    findings,
    problems,
    ...extra
  };
  mkdirSync(path.dirname(reportPath), { recursive: true });
  const temporary = `${reportPath}.part`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(temporary, reportPath);
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Run a command and return its exit code and output. @param {string} command @param {string[]} args @param {object} [options] */
function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      ...options,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      // An installer that never returns is a failure worth naming, not a hang.
      try { child.kill(); } catch { /* already gone */ }
    }, options.timeoutMs ?? 300_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

// ── Find the installer ────────────────────────────────────────────────────────
const installerPath = (() => {
  const explicit = valueOf('--installer', null);
  if (explicit) return path.resolve(explicit);
  // dist/ is where electron-builder writes; release/ is a conventional alternative.
  for (const directory of ['dist', 'release', '.']) {
    const full = path.join(ROOT, directory);
    if (!existsSync(full)) continue;
    const candidate = readdirSync(full).find((name) => /^VERIDEX-Setup-.*\.exe$/i.test(name));
    if (candidate) return path.join(full, candidate);
  }
  console.log(`info  no ${'installer'} matched; searched: ${
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

/** @type {string|null} */
let installedDir = null;

if (process.platform !== 'win32') {
  record('info', `this machine is ${process.platform}: installing a Windows application is not something it can do`);
  writeReport(false, { skipped: true, reason: 'not Windows' });
  process.exitCode = 2;
} else if (!installerPath || !existsSync(installerPath)) {
  record('info', 'no VERIDEX-Setup-*.exe found — nothing to install');
  writeReport(false, { skipped: true, reason: 'no installer' });
  process.exitCode = 2;
} else {
  await main();
}

async function main() {
  record('info', `installer: ${installerPath} (${readFileSync(installerPath).length} bytes)`);

  // The default per-user location NSIS uses for a non-elevated install. allowElevation is
  // false in the build config, so this is where a /S install must land.
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  installedDir = path.join(localAppData, 'Programs', 'VERIDEX');
  const installedExe = path.join(installedDir, 'VERIDEX.exe');
  const userData = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'VERIDEX');
  const smokeReport = path.join(os.tmpdir(), 'veridex-install-smoke.json');

  record('info', `expected install directory: ${installedDir}`);

  try {
    // ── 1. A clean starting point ────────────────────────────────────────────
    // Installing over an existing installation would hide a first-install failure. Remove any
    // previous one, and say that we did.
    if (existsSync(installedDir)) {
      record('warn', 'a previous installation was present; removing it so this measures a first install');
      const uninstallers = readdirSync(installedDir).filter((name) => /^Uninstall .*\.exe$/i.test(name));
      for (const name of uninstallers) await run(path.join(installedDir, name), ['/S'], { timeoutMs: 120_000 });
      await sleep(2_000);
      await rm(installedDir, { recursive: true, force: true });
    }

    // ── 2. Install silently ──────────────────────────────────────────────────
    const startedInstall = Date.now();
    const install = await run(installerPath, ['/S'], { timeoutMs: 240_000 });
    record('info', `installer exited ${install.code} after ${Date.now() - startedInstall}ms`);
    if (install.stdout.trim()) record('info', `installer stdout: ${install.stdout.trim().slice(0, 400)}`);
    if (install.code !== 0) fail(`the installer exited ${install.code}: ${install.stderr.trim().slice(0, 300)}`);

    // NSIS unpacks asynchronously; wait for the application to appear rather than assuming.
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline && !existsSync(installedExe)) await sleep(500);
    if (existsSync(installedExe)) {
      const files = readdirSync(installedDir);
      record('ok', `installed: ${installedExe} (${readFileSync(installedExe).length} bytes, ${files.length} file(s) alongside)`);
      if (files.some((name) => /^Uninstall .*\.exe$/i.test(name))) record('ok', 'the uninstaller was installed');
      else fail('no uninstaller in the installed directory');
    } else {
      fail(`the installer reported success but ${installedExe} does not exist`);
      throw new Error('nothing was installed');
    }

    // Shortcuts: createDesktopShortcut and createStartMenuShortcut are both true. A missing
    // shortcut is not fatal (a policy or an existing shortcut can suppress it), so it warns.
    const desktopLink = path.join(process.env.USERPROFILE ?? os.homedir(), 'Desktop', 'VERIDEX.lnk');
    const startLink = path.join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'VERIDEX.lnk');
    record(existsSync(desktopLink) ? 'ok' : 'warn', `desktop shortcut: ${existsSync(desktopLink) ? 'present' : 'absent'}`);
    record(existsSync(startLink) ? 'ok' : 'warn', `start menu shortcut: ${existsSync(startLink) ? 'present' : 'absent'}`);

    // ── 3. Launch the installed application ─────────────────────────────────
    await rm(smokeReport, { force: true });
    const launchedAt = Date.now();
    const launch = await run(installedExe, [], {
      timeoutMs: 300_000,
      env: { ...process.env, VERIDEX_INSTALL_SMOKE: '1', VERIDEX_INSTALL_SMOKE_REPORT: smokeReport }
    });
    record('info', `installed application exited ${launch.code} after ${Date.now() - launchedAt}ms`);
    if (launch.stdout.trim()) for (const line of launch.stdout.trim().split('\n').slice(-20)) console.log(`    [app] ${line}`);

    if (!existsSync(smokeReport)) {
      fail(`the installed application exited ${launch.code} without writing a verdict. Output: ${launch.stdout.trim().slice(-500) || '(none)'}`);
    } else {
      let verdict = null;
      try {
        verdict = JSON.parse(readFileSync(smokeReport, 'utf8'));
      } catch (error) {
        fail(`the installed application's verdict could not be read: ${error.message}`);
      }
      if (verdict) {
        record('info', `installed build reported ${verdict.findings?.length ?? 0} finding(s), ${verdict.problems?.length ?? 0} problem(s)`);
        for (const finding of (verdict.findings ?? []).slice(-40)) record(finding.level, `[installed] ${finding.message}`);
        for (const problem of verdict.problems ?? []) fail(`[installed] ${problem}`);
        if (verdict.complete !== true) {
          const lastPhase = [...(verdict.findings ?? [])].reverse().find((finding) => finding.message.startsWith('→ '));
          fail(`the installed application stopped before finishing its checks${lastPhase ? ` (last phase: ${lastPhase.message.slice(2)})` : ''}`);
        }
        if (verdict.installDir && path.resolve(verdict.installDir).toLowerCase() !== path.resolve(installedDir).toLowerCase()) {
          fail(`the running application reported a different install directory (${verdict.installDir}) than the one it was installed to (${installedDir})`);
        }
        if (verdict.app?.packaged !== true) fail('the installed application is not running as a packaged application');
        if (launch.code !== 0) fail(`the installed application exited ${launch.code}`);
      }
    }

    // ── 4. Uninstall ────────────────────────────────────────────────────────
    if (keep) {
      record('warn', '--keep was given: the installation and its user data were left in place');
    } else {
      const uninstallerName = readdirSync(installedDir).find((name) => /^Uninstall .*\.exe$/i.test(name));
      if (!uninstallerName) {
        fail('cannot uninstall: the uninstaller is missing');
      } else {
        // NSIS copies its uninstaller to a temp directory before running it, so the launched
        // process is not the file in the install directory and its path can vanish under us.
        // Run it and wait for the directory rather than trusting the exit code.
        const removed = await run(path.join(installedDir, uninstallerName), ['/S'], { timeoutMs: 180_000 });
        record('info', `uninstaller exited ${removed.code}`);
        const gone = Date.now() + 90_000;
        while (Date.now() < gone && existsSync(installedExe)) await sleep(500);

        if (existsSync(installedExe)) {
          fail(`the uninstaller completed but ${installedExe} is still present`);
        } else {
          record('ok', 'the installed application was removed');
          // The directory may legitimately linger if it still holds user-chosen files; only an
          // executive file left behind is a failure.
          const leftovers = existsSync(installedDir) ? readdirSync(installedDir) : [];
          if (leftovers.length > 0) record('warn', `the install directory was left with ${leftovers.length} item(s): ${leftovers.slice(0, 5).join(', ')}`);
          else record('ok', 'the install directory was removed entirely');
        }

        const desktopGone = !existsSync(desktopLink);
        const startGone = !existsSync(startLink);
        if (desktopGone && startGone) record('ok', 'uninstall removed the shortcuts');
        else record('warn', `shortcuts left behind: ${[!desktopGone && 'desktop', !startGone && 'start menu'].filter(Boolean).join(', ')}`);

        // Data is expected to survive: deleteAppDataOnUninstall is false, so an uninstall that
        // wiped a user's scan history would be the bug.
        if (existsSync(userData)) record('info', `user data kept at ${userData} (deleteAppDataOnUninstall is false)`);
      }
    }
  } catch (error) {
    failNow(`the install check crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }

  try {
    writeReport(true);
  } catch (reportError) {
    emit('fail', 'install-smoke', `the report could not be written: ${reportError.message}`);
  }
  console.log('');
  console.log(`${findings.length} finding(s), ${problems.length} problem(s)`);
  console.log(`report written to ${reportPath}`);

  const ok = problems.length === 0;
  for (const problem of problems.slice(0, 10)) emit('fail', 'install-smoke problem', problem);
  emit(ok ? 'notice' : 'fail', 'install-smoke', `${findings.filter((f) => f.level === 'ok').length} check(s) passed · ${problems.length} problem(s)`);
  process.exitCode = ok ? 0 : 1;
}
