/**
 * The installer and portable checks have to be trustworthy before their results mean anything.
 *
 * Neither can run here: this project's development environment is Linux, and a Windows
 * installer cannot be installed by a Linux process. What *can* be checked is that both scripts
 * refuse to claim a result they did not obtain:
 *
 *   - on this platform they exit 2 ("cannot answer here"), never 0
 *   - they say why, in the report and on the console
 *   - when pointed at a missing executable they still exit 2 rather than failing
 *
 * The distinction matters more than it sounds. A harness that returns 0 when it cannot run is
 * the mechanism by which a release gets published claiming verification it does not have.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const isWindows = process.platform === 'win32';

/** Run a harness and return its result. @param {string} script @param {string[]} args */
function run(script, args) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
    encoding: 'utf8',
    timeout: 60_000
  });
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

test('the install smoke test refuses to claim a result on a non-Windows machine', { skip: isWindows }, () => {
  const report = path.join(os.tmpdir(), `veridex-install-harness-${process.pid}.json`);
  rmSync(report, { force: true });
  const { code, stdout } = run('install-smoke.mjs', ['--installer', 'does-not-exist.exe', '--json', report]);

  assert.equal(code, 2, 'exit 2 means "this machine cannot answer the question"');
  assert.match(stdout, /not something it can do|cannot be installed/i);
  assert.ok(existsSync(report), 'the harness must leave a report even when it cannot run');
  const parsed = JSON.parse(readFileSync(report, 'utf8'));
  assert.equal(parsed.complete, false);
  assert.equal(parsed.skipped, true);
  assert.equal(parsed.reason, 'not Windows');
});

test('the portable smoke test refuses to claim a result on a non-Windows machine', { skip: isWindows }, () => {
  const report = path.join(os.tmpdir(), `veridex-portable-harness-${process.pid}.json`);
  rmSync(report, { force: true });
  const { code, stdout } = run('portable-smoke.mjs', ['--exe', 'does-not-exist.exe', '--json', report]);

  assert.equal(code, 2, 'exit 2 means "this machine cannot answer the question"');
  assert.match(stdout, /cannot be launched here/i);
  const parsed = JSON.parse(readFileSync(report, 'utf8'));
  assert.equal(parsed.skipped, true);
});

test('a harness asked for a missing installer on Windows would exit 2, not 0', () => {
  // This asserts the code path rather than the platform: the guard is on the executable's
  // existence, and it is checked before any work happens.
  const source = readFileSync(path.join(ROOT, 'scripts', 'install-smoke.mjs'), 'utf8');
  assert.match(source, /!installerPath \|\| !existsSync\(installerPath\)/);
  assert.match(source, /process\.exitCode = 2/);
  const portable = readFileSync(path.join(ROOT, 'scripts', 'portable-smoke.mjs'), 'utf8');
  assert.match(portable, /!exe \|\| !existsSync\(exe\)/);
  assert.match(portable, /process\.exitCode = 2/);
});

test('the installed-application harness is selected by an environment variable, not a flag', () => {
  // A test-only command line surface would ship to users. The environment variable is read by
  // main.js and the import only happens when it is set, so a normal launch is unchanged.
  const main = readFileSync(path.join(ROOT, 'src', 'app', 'main.js'), 'utf8');
  assert.match(main, /VERIDEX_INSTALL_SMOKE === '1'/);
  assert.match(main, /await import\('\.\/install-smoke\.js'\)/);
  const smoke = readFileSync(path.join(ROOT, 'src', 'app', 'install-smoke.js'), 'utf8');
  assert.doesNotMatch(smoke, /process\.argv/, 'the installed harness must not parse command line flags');
});

test('the installed harness never awaits readiness at module scope', () => {
  // Electron does not emit `ready` until the main script finishes evaluating, and main.js
  // imports this harness at the top level. `await app.whenReady()` here therefore deadlocks
  // the entire application: no window, no log, no exit. Two CI runs were spent on a portable
  // build that appeared to hang on launch and was in fact waiting on itself.
  //
  // The rule, then: no module-scope statement may touch `app` at all. Everything that needs it
  // lives inside a function that is scheduled from `app.whenReady().then(run)`.
  const source = readFileSync(path.join(ROOT, 'src', 'app', 'install-smoke.js'), 'utf8');
  const lines = source.split('\n');
  // Comments in this file explain the rule using the very text the rule forbids, so they are
  // removed before any assertion looks at the code.
  const code = lines.filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

  assert.doesNotMatch(code, /await app\.whenReady\(\)/, 'module scope must not await readiness');
  assert.match(code, /app\.whenReady\(\)\.then\(run\)/, 'the work must be scheduled, not awaited');

  const moduleScope = lines.filter((line) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return false; // comments explain the rule
    if (/^\s/.test(line)) return false; // inside a function or block
    // `app.asar` is a file name, not the Electron module.
    return /\bapp\.(?:getPath|whenReady|exit|quit|on|getVersion|isPackaged|getAppPath)\(/.test(line);
  });
  const offending = moduleScope.filter((line) => !line.includes('app.whenReady().then(run)'));
  assert.deepEqual(offending, [], 'no module-scope statement may touch `app`');
});

test('neither launcher starts a GUI application with its window hidden', () => {
  // `windowsHide: true` sets STARTUPINFO to SW_HIDE, and Windows applies that to the process's
  // first window. The page loads, show() runs, and isVisible() stays false forever. It is a
  // console-program flag and it does not belong on an application being tested for visibility.
  const launcher = readFileSync(path.join(ROOT, 'scripts', 'install-smoke.mjs'), 'utf8');
  const appLaunch = launcher.slice(launcher.indexOf('const launch = await run(installedExe'));
  assert.match(appLaunch.slice(0, 600), /NOT windowsHide/, 'the app launch must explain why it is visible');
  assert.doesNotMatch(appLaunch.slice(0, 600), /^\s*windowsHide: true,/m, 'the app launch must not hide its window');

  const portable = readFileSync(path.join(ROOT, 'scripts', 'portable-smoke.mjs'), 'utf8');
  const spawnAt = portable.indexOf('const child = spawn(exe, [], {');
  assert.ok(spawnAt > -1);
  assert.match(portable.slice(spawnAt, spawnAt + 400), /windowsHide: false/);
});

test('the installed harness never reads the archive it is running out of', () => {
  // Electron patches `fs` to serve paths inside an asar. Reading the archive file itself, from
  // the application running out of it, hangs the process - no error, no exit, just a wedge that
  // looks exactly like a broken build. The only fact wanted was the file's size, so `statSync`
  // answers it without touching the archive at all.
  const source = readFileSync(path.join(ROOT, 'src', 'app', 'install-smoke.js'), 'utf8');
  assert.doesNotMatch(source, /readFileSync\(/, 'the harness must not readFileSync the asar');
  assert.match(source, /statSync\(/, 'file sizes come from statSync');
});

test('both harnesses write their report atomically', () => {
  // The GUI harness lost four CI runs to a half-written verdict. These must not repeat it.
  for (const script of ['install-smoke.mjs', 'portable-smoke.mjs']) {
    const source = readFileSync(path.join(ROOT, 'scripts', script), 'utf8');
    assert.match(source, /\.part`/, `${script} should write to a .part file`);
    assert.match(source, /renameSync\(temporary/, `${script} should rename it into place`);
  }
  const inner = readFileSync(path.join(ROOT, 'src', 'app', 'install-smoke.js'), 'utf8');
  assert.match(inner, /\.part`/);
  assert.match(inner, /renameSync\(temporary/);
});

test('the CI job runs the installed build and the portable build, and keeps the evidence', () => {
  const workflow = readFileSync(path.join(ROOT, '.github', 'workflows', 'build.yml'), 'utf8');
  assert.match(workflow, /node scripts\/install-smoke\.mjs/, 'the installer must be installed in CI');
  assert.match(workflow, /node scripts\/portable-smoke\.mjs/, 'the portable build must be launched in CI');
  assert.match(workflow, /install-smoke\.json/, 'the install evidence must be uploaded');
  assert.match(workflow, /portable-smoke\.json/, 'the portable evidence must be uploaded');
});
