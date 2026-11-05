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

const WORKFLOWS = ['build.yml', 'release.yml'];
const read = (name) => readFileSync(path.join(ROOT, '.github/workflows', name), 'utf8');

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
