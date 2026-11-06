/**
 * The CI workflows and the build configuration are load-bearing: they are how the
 * project claims (in docs/GITHUB_ACTIONS.md) that a Windows build happens and that a
 * release is verified. Neither has ever run, which makes it more important, not less,
 * that the files are structurally sound — a broken workflow fails silently on a branch
 * nobody is watching.
 *
 * This test does not prove the workflow will succeed. It proves the workflow refers to
 * things that exist: the scripts it invokes, the commands package.json defines, and the
 * release inputs it expects.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const WORKFLOWS = ['build.yml', 'release.yml', 'ui-evidence.yml'];
const read = (name) => readFileSync(path.join(ROOT, '.github/workflows', name), 'utf8');
const readWorkflow = read;

test('both workflows exist and declare jobs', () => {
  for (const name of WORKFLOWS) {
    const file = path.join(ROOT, '.github/workflows', name);
    assert.ok(existsSync(file), `${name} must exist`);
    const text = readFileSync(file, 'utf8');
    assert.match(text, /^on:/m, `${name} must declare triggers`);
    assert.match(text, /^jobs:/m, `${name} must declare jobs`);
    // Tabs are invalid indentation in YAML and produce a confusing failure.
    assert.ok(!/\t/.test(text), `${name} must not contain tab characters`);
  }
});

test('every npm script a workflow invokes is defined in package.json', () => {
  const missing = [];
  for (const name of WORKFLOWS) {
    const text = read(name);
    for (const match of text.matchAll(/npm run ([a-z0-9:_-]+)/gi)) {
      const script = match[1];
      if (!(script in pkg.scripts)) missing.push(`${name}: npm run ${script}`);
    }
  }
  assert.deepEqual(missing, [], `workflows invoke scripts that do not exist:\n  ${missing.join('\n  ')}`);
});

test('every file a workflow uploads is produced by the build it runs', () => {
  const build = read('build.yml');
  // The artifact paths must line up with the artifact names the builder config sets,
  // or a successful build uploads nothing and the job looks green.
  assert.match(build, /dist\/SHA256SUMS\.txt/, 'the checksum file must be uploaded');
  assert.match(build, /CSC_IDENTITY_AUTO_DISCOVERY/, 'signing auto-discovery must be disabled for an unsigned build');

  const config = readFileSync(path.join(ROOT, 'electron-builder.config.mjs'), 'utf8');
  assert.match(config, /SHA256SUMS|artifactName/, 'the builder must name its artifacts');
  assert.match(config, /perMachine:\s*false/, 'the installer must install per-user');
});

test('the release workflow will not publish without passing tests', () => {
  const release = read('release.yml');
  const testStep = release.indexOf('npm test');
  const publishStep = release.indexOf('gh release create');
  assert.ok(testStep > -1, 'the release workflow must run the tests');
  assert.ok(publishStep > -1, 'the release workflow must create a release');
  assert.ok(testStep < publishStep, 'tests must run before anything is published');
  assert.match(release, /workflow_dispatch/, 'releases are manual by design');
  assert.ok(!/on:\s*push/.test(release), 'a release must not be triggered by a push');
});

test('the release notes say what has not been verified', () => {
  // A release page is a recommendation. It has to carry the same caveat as the repository:
  // everything was executed on a virtual machine, and no requirement is VERIFIED.
  const release = read('release.yml');
  assert.match(release, /virtual machine/i, 'the release must say the evidence comes from a VM');
  assert.match(release, /never been run on real hardware|not field-verified/i, 'the release must say what was never run on hardware');
  assert.match(release, /KNOWN_LIMITATIONS\.md/, 'the release must point at the limitations document');
});

test('the release notes state that the build is unsigned', () => {
  const release = read('release.yml');
  assert.match(release, /unsigned/i, 'the release must disclose that it is not signed');
  assert.match(release, /SHA256/i, 'the release must tell the user how to verify the download');
});

test('the build config matches the intent documented in the repository', async () => {
  const config = (await import('../../electron-builder.config.mjs')).default;
  assert.equal(config.appId, 'com.merqo.veridex');
  assert.equal(config.productName, 'VERIDEX');
  assert.equal(config.win.requestedExecutionLevel, 'asInvoker', 'the app must not start elevated');
  assert.equal(config.nsis.allowElevation, false);
  assert.equal(config.nsis.perMachine, false);
  assert.ok(!config.win.certificateFile, 'no signing certificate exists; the config must not pretend otherwise');
  assert.ok(!config.win.certificateSubjectName, 'no publisher identity may be invented');

  const targets = config.win.target.map((entry) => entry.target).sort();
  assert.deepEqual(targets, ['nsis', 'portable']);
  for (const entry of config.win.target) {
    assert.deepEqual(entry.arch, ['x64'], 'only x64 is built');
  }

  // The files array must ship the renderer assets the app needs at runtime.
  for (const needed of ['src/**/*.js', 'src/**/*.cjs', 'src/renderer/**/*.html', 'src/renderer/**/*.css']) {
    assert.ok(config.files.includes(needed), `the packaged app needs "${needed}"`);
  }
  assert.equal(config.publish, null, 'the build must not upload anywhere');
});

test('the licence file exists, because both the installer and package.json require it', () => {
  assert.ok(existsSync(path.join(ROOT, 'LICENSE')), 'LICENSE is referenced by nsis.license and package.json');
  const licence = readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
  assert.match(licence, /NO WARRANTY/i);
  assert.match(licence, /not a certification/i, 'the licence must not overstate what a report means');
});

test('the Windows job exercises the real interfaces, not only the test doubles', () => {
  // The whole suite drives providers with a no-op runner, so on its own it never proves a
  // command path executes. The smoke script is the only place a provider talks to real WMI.
  const build = readWorkflow('build.yml');
  assert.match(build, /live-smoke\.mjs/, 'the Windows job must run the live smoke script');
  assert.match(build, /runner\.os == 'Windows'/, 'the smoke script must be gated to Windows');
  assert.ok(existsSync(path.join(ROOT, 'scripts/live-smoke.mjs')), 'the smoke script must exist');
});

test('the build publishes an auditable manifest beside the artifacts', () => {
  const build = readWorkflow('build.yml');
  // A 234 MB artifact cannot always be fetched, so the build's own record of what it
  // produced and its digests must be readable without downloading anything.
  assert.match(build, /BUILD-MANIFEST\.txt/);
  assert.match(build, /Get-FileHash/, 'the manifest must be built from real digests');
  assert.match(build, /::notice/, 'the facts must reach the checks API as annotations');
  assert.match(build, /NOT VERIFIED/i, 'the manifest must say the installer is unproven');
});

test('a failing test reports its reason, not only its name', async () => {
  // The annotation used to say "not ok 46 - every registered provider executes without
  // throwing" and nothing else: the message was in the indented block underneath, which the
  // workflow's awk kept discarding. A failing check must carry the failure.
  const { spawn } = await import('node:child_process');

  const tap = [
    'not ok 46 - every registered provider executes without throwing',
    '  ---',
    '  type: testCodeFailure',
    '  error: |-',
    '    providers failed to execute:',
    '    memory.info: threw Field invariant violated',
    '  code: ERR_ASSERTION',
    '  ...',
    ''
  ].join('\n');

  const stdout = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/tap-annotate.mjs'], { cwd: ROOT });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString(); });
    child.on('error', reject);
    child.on('close', () => resolve(out));
    child.stdin.end(tap);
  });

  assert.match(stdout, /^::error title=Test failed::every registered provider executes without throwing/m);
  assert.match(stdout, /Field invariant violated/, 'the assertion message must be in the annotation');
  assert.match(stdout, /ERR_ASSERTION/, 'the failure code must be in the annotation');
});

test('the Windows job validates and launches the packaged application', () => {
  // Before this, CI proved an installer came out of the build and nothing more. A package
  // with no renderer, no preload or no version metadata passes a size check and breaks for
  // the user, so the job must inspect the app and then run it.
  const build = readWorkflow('build.yml');
  assert.match(build, /verify-package\.mjs/, 'the packaged application must be inspected');
  assert.match(build, /gui-smoke\.mjs/, 'the application must actually be launched');
  assert.match(build, /--dist dist\/win-unpacked/, 'the smoke test must run the built app, not the sources');
  assert.ok(existsSync(path.join(ROOT, 'scripts/verify-package.mjs')));
  assert.ok(existsSync(path.join(ROOT, 'scripts/gui-smoke.mjs')));
  assert.ok(existsSync(path.join(ROOT, 'src/app/gui-smoke.js')));
});

test('a GUI test that cannot run does not report success', () => {
  // The distinction that matters: "this machine cannot run the test" is exit 2 and a
  // warning; "the application is broken" is exit 1 and a failure. A CI job that treats
  // them the same either goes green on a broken app or red on a healthy one.
  const script = readFileSync(path.join(ROOT, 'scripts/gui-smoke.mjs'), 'utf8');
  assert.match(script, /process\.exitCode = 2/, 'cannot-run must be distinguishable from failure');
  assert.match(script, /CANNOT RUN GUI SMOKE/);
  assert.match(script, /process\.exitCode = verdict\.problems\.length > 0 \? 1 : 0/);
});
