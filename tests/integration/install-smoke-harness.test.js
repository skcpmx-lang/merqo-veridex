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

test('the installed harness waits for the application to be ready before touching `app`', () => {
  // main.js imports this module before `ready`. `app.getPath()` before ready throws, and
  // because that happens inside the main process's startup the application simply never
  // starts - which is exactly what the first portable run on Windows looked like.
  const source = readFileSync(path.join(ROOT, 'src', 'app', 'install-smoke.js'), 'utf8');
  // Ignore comment lines: the file explains this rule in prose, and prose is not a call.
  const code = source.split('\n').map((line, index) => ({ line, index, comment: /^\s*(\/\/|\*|\/\*)/.test(line) }));
  const readyLine = code.find(({ line }) => line.includes('await app.whenReady()'));
  const firstAppUse = code.find(({ line, comment }) => !comment && /app\.getPath\(/.test(line));
  assert.ok(readyLine, 'the harness must await app.whenReady()');
  assert.ok(firstAppUse, 'the harness should use app.getPath()');
  assert.ok(firstAppUse.index > readyLine.index, 'app.getPath() must come after app.whenReady()');
  // And it must be a real await, not a .then() that the rest of the module races past.
  assert.match(readyLine.line, /^\s*await app\.whenReady\(\);\s*$/);
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
