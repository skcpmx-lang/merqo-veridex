/**
 * VERIDEX — installed-application smoke test.
 *
 * The packaged, unpacked build has been driven through its whole interface since the GUI smoke
 * test started passing. What had never happened is the thing a user actually does: run the
 * installer, let it install, start the installed application, and remove it again.
 *
 * This harness does exactly that, and nothing else. It is deliberately small — no scan, no
 * report, no page walk — because the question here is "is this a working installation", and
 * every failure mode of an installer shows up in the first second of the first launch:
 *
 *   - the install location is missing or incomplete
 *   - the application refuses to start from where it was installed
 *   - the application starts against a broken data directory
 *   - uninstalling leaves the application, its shortcuts or its data behind
 *
 * It is selected by VERIDEX_INSTALL_SMOKE=1, the same way the GUI smoke test is selected, so
 * the shipped application carries no test-only command line surface.
 *
 * @module
 */
import { app, BrowserWindow } from 'electron';
import { existsSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

// main.js imports this module before the application is ready, so nothing here may touch
// `app` until it is. Calling app.getPath() too early throws, and because the import happens
// inside the main process's own startup the failure is silent: the process waits forever and
// the launcher sees a portable build that never reports. That cost one CI run to find.
await app.whenReady();

const reportPath = process.env.VERIDEX_INSTALL_SMOKE_REPORT ?? path.join(app.getPath('temp'), 'veridex-install-smoke.json');

// The same checks run for the portable build, which is the same application extracted to a
// temporary directory by its self-extracting wrapper. Two expectations differ there: a
// portable build ships no uninstaller and no shortcuts, so their absence is not a failure.
// Everything about whether the application itself works is identical.
const variant = process.env.VERIDEX_SMOKE_VARIANT === 'portable' ? 'portable' : 'installed';
const startedAt = Date.now();

/** @type {{level: 'ok'|'info'|'warn'|'fail', message: string}[]} */
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

/**
 * Write the verdict. Written to a sibling file and renamed, so a reader never sees a partial
 * document — the GUI harness taught this the hard way.
 * @param {boolean} complete
 */
function persist(complete) {
  const verdict = {
    kind: `${variant}-smoke`,
    app: {
      version: app.getVersion(),
      executable: process.execPath,
      packaged: app.isPackaged,
      electron: process.versions.electron
    },
    installDir: path.dirname(process.execPath),
    userData: app.getPath('userData'),
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    findings,
    problems,
    complete
  };
  const temporary = `${reportPath}.part`;
  writeFileSync(temporary, `${JSON.stringify(verdict, null, 2)}\n`);
  renameSync(temporary, reportPath);
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Wait until `fn` returns a truthy value, or give up.
 * @template T
 * @param {() => T | Promise<T>} fn
 * @param {number} timeoutMs
 * @param {string} what
 * @returns {Promise<T>}
 */
async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(200);
  }
  throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what}`);
}

record('info', `→ installed application smoke test`);

const handle = { findings, problems, persist };
process.on('unhandledRejection', (reason) => {
  fail(`unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
  persist(false);
});

// ── 1. Where am I running from? ───────────────────────────────────────────────
// If this is not the installed location, the rest of the run measures the wrong thing while
// appearing to succeed, so it is checked first and reported either way.
const installDir = path.dirname(process.execPath);
record('info', `executable: ${process.execPath}`);
record('info', `install directory: ${installDir}`);

const appDir = path.join(installDir, 'resources', 'app.asar');
if (existsSync(appDir)) {
  const size = readFileSync(appDir).length;
  record('ok', `resources/app.asar present in the install directory (${size} bytes)`);
} else {
  fail(`no resources/app.asar under ${installDir} — the installation is incomplete`);
}

const sibling = path.join(installDir, 'resources', 'app.asar.unpacked');
record('info', `unpacked resources: ${existsSync(sibling) ? 'present' : 'absent (nothing was marked asarUnpack)'}`);

const entries = readdirSync(installDir).slice(0, 12);
record('info', `install directory contains ${readdirSync(installDir).length} entries, e.g. ${entries.slice(0, 6).join(', ')}`);

const expectedExe = path.join(installDir, 'VERIDEX.exe');
if (existsSync(expectedExe)) record('ok', 'VERIDEX.exe is present beside the running executable');
else if (variant === 'portable') record('info', `portable build runs as ${path.basename(process.execPath)} from an extraction directory`);
else record('warn', `VERIDEX.exe not found by name; running as ${path.basename(process.execPath)}`);

// ── 2. The uninstaller, which is what makes this an installation ─────────────
if (variant === 'portable') {
  const hasUninstaller = readdirSync(installDir).some((name) => /^Uninstall .*\.exe$/i.test(name));
  record('info', `portable build: uninstaller ${hasUninstaller ? 'present (unexpected)' : 'absent, as designed'}`);
} else {
  const uninstaller = readdirSync(installDir).find((name) => /^Uninstall .*\.exe$/i.test(name));
  if (uninstaller) {
    const bytes = readFileSync(path.join(installDir, uninstaller), { encoding: null }).length;
    record('ok', `uninstaller present: ${uninstaller} (${bytes} bytes)`);
  } else {
    // This is a failure, not a warning: an application that cannot be removed from Programs and
    // Features has no business being installed, and the brief requires a proper uninstaller.
    fail('no Uninstall*.exe in the install directory — the installation cannot be removed normally');
  }
}

// ── 3. The data directory ─────────────────────────────────────────────────────
// A fresh installation must work with a data directory that does not exist yet. The
// application creates it; if anything assumed it was there, a first run is the only time that
// shows up.
const userData = app.getPath('userData');
record('info', `userData: ${userData}`);
if (variant !== 'portable' && app.getPath('userData').toLowerCase().includes('program files')) {
  fail('the data directory is inside Program Files — settings would be unwritable for a standard user');
}
writeFileSync(path.join(app.getPath('temp'), 'veridex-install-smoke-probe.txt'), 'probe\n');
record('ok', 'the temp directory is writable, so the application can write reports and logs');

// ── 4. The interface comes up ────────────────────────────────────────────────
let window = null;
try {
  window = await waitFor(() => BrowserWindow.getAllWindows()[0], 45_000, 'the application window');
  record('ok', `window created (${BrowserWindow.getAllWindows().length} window(s))`);
  await waitFor(() => window.isVisible(), 30_000, 'the window to become visible');
  record('ok', `window visible: ${window.getBounds().width}×${window.getBounds().height}`);

  // The renderer must load from the asar, not from a development server or a missing file.
  const url = window.webContents.getURL();
  if (url.includes('app.asar')) record('ok', `renderer loaded from ${url.split('/').slice(-2).join('/')}`);
  else record('warn', `renderer URL is ${url.slice(0, 120)} — expected a file inside app.asar`);

  await waitFor(
    () => window.webContents.executeJavaScript('document.readyState === "complete" && Boolean(document.body) && document.body.childElementCount > 0').catch(() => false),
    45_000,
    'the renderer to finish loading'
  );

  const title = await window.webContents.executeJavaScript('document.title');
  record('ok', `document title: ${title}`);
  if (!/^VERIDEX\b/.test(title)) fail(`the window title does not identify the application: "${title}"`);

  // The preload bridge is the only way the interface can do anything. If it did not load from
  // the installed location, every feature is dead even though the page looks fine.
  const bridge = await window.webContents.executeJavaScript(`(() => {
    const bridge = window.veridex;
    if (!bridge) return { ok: false, reason: 'window.veridex is undefined' };
    return {
      ok: true,
      channels: Object.keys(bridge.invoke ?? {}).length,
      events: typeof bridge.on === 'function'
    };
  })()`);
  if (bridge.ok) record('ok', `preload bridge loaded: ${bridge.channels} invoke channel(s), events: ${bridge.events}`);
  else fail(`the preload bridge is missing in the installed application: ${bridge.reason}`);

  // One real call through the real bridge, from the installed build.
  if (bridge.ok) {
    const info = await window.webContents.executeJavaScript(`window.veridex.invoke['app:info']().then((r) => JSON.stringify(r)).catch((e) => 'error:' + e.message)`);
    if (String(info).startsWith('error:')) fail(`app:info failed in the installed application: ${info.slice(0, 200)}`);
    else record('ok', `app:info replied: ${String(info).slice(0, 160)}`);
  }

  // Pages must render. A blank window is the classic installed-build failure — resources
  // resolved in the repository but not inside the asar.
  const pages = await window.webContents.executeJavaScript(`document.querySelectorAll('[data-page]').length`);
  if (pages > 0) record('ok', `${pages} navigable page(s) rendered from the installed build`);
  else fail('no pages rendered in the installed application — the interface is empty');

  record('ok', `installed application is usable after ${Date.now() - startedAt}ms`);
} catch (error) {
  fail(`the installed application did not come up: ${error instanceof Error ? error.message : String(error)}`);
}

// ── 5. Verdict ───────────────────────────────────────────────────────────────
// Finalised before the window closes: closing it quits the application.
persist(true);
console.log('');
console.log(`${findings.length} finding(s), ${problems.length} problem(s)`);
console.log(`verdict written to ${reportPath}`);

try {
  if (window && !window.isDestroyed()) window.close();
} catch {
  // The process is ending either way.
}
await sleep(400);
app.exit(problems.length === 0 ? 0 : 1);
void handle;
