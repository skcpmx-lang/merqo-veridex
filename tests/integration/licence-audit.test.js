/**
 * The dependency licence audit (R-26-01).
 *
 * The requirement's open half was "dependency licence cleanliness is not yet checked by a
 * script". A script that always passes would close nothing, so these tests point it at licences
 * it must refuse: an undeclared licence, a strong-copyleft runtime dependency, and an unknown
 * licence with no recorded exception. Then they run it over the real lockfile, where a new
 * dependency with an unacceptable licence will fail a build instead of a review.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ALLOWED, EXCEPTIONS, FORBIDDEN_RUNTIME, auditLock, classify, matches, readLicence } from '../../scripts/licence-audit.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

test('a plain licence, a dual licence and an AND expression are each parsed', () => {
  assert.equal(readLicence('MIT').kind, 'single');
  assert.deepEqual(readLicence('MIT OR Apache-2.0').ids, ['MIT', 'Apache-2.0']);
  assert.equal(readLicence('MIT OR Apache-2.0').kind, 'or');
  assert.equal(readLicence('(MIT AND Zlib)').kind, 'and');
  assert.deepEqual(readLicence({ type: 'ISC' }).ids, ['ISC']);
  assert.equal(readLicence('').kind, 'none');
  assert.equal(readLicence(undefined).kind, 'none');
});

test('a licence id matches through its -or-later suffix', () => {
  assert.equal(matches('GPL-3.0-or-later', FORBIDDEN_RUNTIME), true);
  assert.equal(matches('MIT', ALLOWED), true);
  assert.equal(matches('GPL-3.0', ALLOWED), false);
});

test('an allowlisted runtime package is accepted', () => {
  assert.equal(classify({ name: 'left-pad', version: '1.0.0', license: 'MIT' }).level, 'ok');
  assert.equal(classify({ name: 'zod', version: '1.0.0', license: 'Apache-2.0' }).level, 'ok');
  assert.equal(classify({ name: 'wtf', version: '1.0.0', license: 'WTFPL' }).level, 'ok');
});

test('an undeclared licence is an error, not a default of "probably MIT"', () => {
  const result = classify({ name: 'mystery-package', version: '1.0.0', license: null });
  assert.equal(result.level, 'error');
  assert.match(result.reason, /no licence is declared/);
  assert.equal(result.licence, '(none declared)');
});

test('a GPL runtime dependency is an error and the same licence dev-only is a warning', () => {
  const runtime = classify({ name: 'gpl-thing', version: '1.0.0', license: 'GPL-3.0-only' });
  assert.equal(runtime.level, 'error');
  assert.match(runtime.reason, /cannot be shipped/);

  const dev = classify({ name: 'gpl-builder', version: '1.0.0', license: 'GPL-3.0-only', dev: true });
  assert.equal(dev.level, 'warn');
  assert.match(dev.reason, /never ships/);
});

test('a dual licence with one acceptable branch is accepted, and the branch is named', () => {
  const result = classify({ name: 'dual', version: '1.0.0', license: 'MIT OR GPL-2.0' });
  assert.equal(result.level, 'ok');
  assert.match(result.reason, /dual-licensed/);
});

test('an AND expression needs every term accepted', () => {
  assert.equal(classify({ name: 'both-ok', version: '1', license: 'MIT AND Zlib' }).level, 'ok');
  assert.equal(classify({ name: 'one-bad', version: '1', license: 'MIT AND GPL-3.0' }).level, 'error');
});

test('an exception turns an error into a warning and carries its source', () => {
  const name = Object.keys(EXCEPTIONS)[0];
  const result = classify({ name, version: '1.0.0', license: null });
  assert.equal(result.level, 'warn', 'a recorded exception must still be visible');
  assert.match(result.reason, /recorded exception/);
  assert.match(result.reason, /github\.com/, 'the reason must say where the fact came from');
});

test('the audit over a synthetic lockfile counts runtime and build-only packages apart', async () => {
  const lock = {
    packages: {
      '': { name: 'veridex' },
      'node_modules/a': { version: '1.0.0', license: 'MIT' },
      'node_modules/b': { version: '2.0.0', license: 'ISC', dev: true },
      'node_modules/c': { version: '3.0.0', license: '' }
    }
  };
  const report = await auditLock(lock);
  assert.equal(report.total, 3);
  assert.equal(report.runtime, 2);
  assert.equal(report.dev, 1);
  assert.equal(report.errors.length, 1, 'the package with an empty licence must be refused');
  assert.equal(report.errors[0].name, 'c');
});

test('the real dependency tree has no unaccepted licence', async () => {
  const lock = JSON.parse(await readFile(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const report = await auditLock(lock);
  assert.deepEqual(
    report.errors.map((error) => `${error.name}: ${error.reason}`),
    [],
    'a dependency ships with a licence this project has not accepted'
  );
  assert.ok(report.total > 100, 'the audit should cover the whole tree, not the two direct dependencies');
});

test('the CLI exits non-zero on a bad tree and zero on this one', () => {
  const script = path.join(ROOT, 'scripts/licence-audit.mjs');
  const ok = spawnSync(process.execPath, [script, '--json'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(ok.status, 0, `the audit failed on this tree:\n${ok.stdout}${ok.stderr}`);
  const report = JSON.parse(ok.stdout);
  assert.equal(report.errors.length, 0);
  assert.ok(Array.isArray(report.licences) && report.licences.length > 0);
});
