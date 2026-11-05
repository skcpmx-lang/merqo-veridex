/**
 * The artifact verifier is the last thing standing between a broken build and a published
 * release, and until now it had no test: its only exerciser was a real Windows build.
 *
 * That is exactly how it shipped a wrong assumption. It required a "portable .zip", but
 * electron-builder's portable target produces a single .exe, so the verifier rejected a
 * build that had actually succeeded. The Windows CI job built both artifacts and then
 * failed on the check that was supposed to validate them.
 *
 * These tests build fixture directories and run the real script against them via
 * `--dist`, asserting its exit code and its findings.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts/verify-artifacts.mjs');
const pkg = JSON.parse(spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(require("./package.json")))'], { cwd: ROOT, encoding: 'utf8' }).stdout);

/** A file that starts with the given signature, padded to a plausible size. */
function binary(signature, megabytes = 1) {
  const size = Math.round(megabytes * 1024 * 1024);
  const buffer = Buffer.alloc(size, 0x20);
  signature.copy(buffer, 0);
  return buffer;
}

async function fixture(files) {
  const dir = await mkdtemp(path.join(tmpdir(), 'veridex-dist-'));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content);
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function run(dir) {
  const result = spawnSync(process.execPath, [SCRIPT, '--dist', dir], { cwd: ROOT, encoding: 'utf8' });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const setup = (version) => `VERIDEX-Setup-${version}-x64.exe`;
const portable = (version) => `VERIDEX-${version}-portable-x64.exe`;

test('a build with an installer and a portable exe passes', async () => {
  const version = pkg.version;
  const { dir, cleanup } = await fixture({
    [setup(version)]: binary(Buffer.from('MZ'), 25),
    [portable(version)]: binary(Buffer.from('MZ'), 25)
  });
  try {
    const { code, out } = run(dir);
    assert.equal(code, 0, `verification should pass:\n${out}`);
    assert.match(out, /is a Windows executable/);
    assert.match(out, /portable target/);
    // Checksums must be written, and must be correct.
    const sums = await readFile(path.join(dir, 'SHA256SUMS.txt'), 'utf8');
    const expected = createHash('sha256').update(binary(Buffer.from('MZ'), 25)).digest('hex');
    assert.ok(sums.includes(expected), 'SHA256SUMS.txt must contain the real digest');
    assert.ok(sums.includes(setup(version)));
    assert.ok(sums.includes(portable(version)));
  } finally {
    await cleanup();
  }
});

test('a portable zip is still accepted', async () => {
  // The target can be configured to produce a zip; that form must not regress.
  const version = pkg.version;
  const { dir, cleanup } = await fixture({
    [setup(version)]: binary(Buffer.from('MZ'), 25),
    [`VERIDEX-${version}-portable-x64.zip`]: binary(Buffer.from('PK\x03\x04'), 2)
  });
  try {
    const { code, out } = run(dir);
    assert.equal(code, 0, `a zip portable build must pass:\n${out}`);
    assert.match(out, /is a zip archive/);
  } finally {
    await cleanup();
  }
});

test('a missing installer is a blocking failure', async () => {
  const version = pkg.version;
  const { dir, cleanup } = await fixture({ [portable(version)]: binary(Buffer.from('MZ'), 25) });
  try {
    const { code, out } = run(dir);
    assert.equal(code, 1, 'verification must fail without an installer');
    assert.match(out, /No installer \.exe was produced/);
  } finally {
    await cleanup();
  }
});

test('an artifact that is not an executable is rejected', async () => {
  const version = pkg.version;
  const { dir, cleanup } = await fixture({
    [setup(version)]: Buffer.from('this is not a PE file, it is text'),
    [portable(version)]: binary(Buffer.from('MZ'), 25)
  });
  try {
    const { code, out } = run(dir);
    assert.equal(code, 1);
    assert.match(out, /not a Windows executable/);
  } finally {
    await cleanup();
  }
});

test('the digest is recomputed, so a tampered artifact is caught', async () => {
  const version = pkg.version;
  const original = binary(Buffer.from('MZ'), 25);
  const { dir, cleanup } = await fixture({
    [setup(version)]: original,
    [portable(version)]: binary(Buffer.from('MZ'), 25)
  });
  try {
    assert.equal(run(dir).code, 0, 'first pass records the checksums');

    // Change the file after checksumming, as a supply-chain substitution would.
    const tampered = Buffer.from(original);
    tampered[100] = 0x00;
    tampered[101] = 0x01;
    await writeFile(path.join(dir, setup(version)), tampered);

    const { code, out } = run(dir);
    assert.equal(code, 1, 'a changed artifact must fail verification');
    assert.match(out, /SHA-256 mismatch/);
  } finally {
    await cleanup();
  }
});

test('the output always lists what was actually in the directory', async () => {
  // A failure that only says "no portable build" is hard to diagnose from a CI log.
  const { dir, cleanup } = await fixture({ 'notes.txt': 'hello' });
  try {
    const { code, out } = run(dir);
    assert.equal(code, 1);
    assert.match(out, /dist\/ contains 1 entry: notes\.txt/);
  } finally {
    await cleanup();
  }
});

test('the verifier states plainly what it cannot check', async () => {
  const version = pkg.version;
  const { dir, cleanup } = await fixture({
    [setup(version)]: binary(Buffer.from('MZ'), 25),
    [portable(version)]: binary(Buffer.from('MZ'), 25)
  });
  try {
    const { out } = run(dir);
    // It cannot prove the installer runs. It must say so rather than implying it has.
    assert.match(out, /NOT VERIFIED HERE/);
    assert.match(out, /requires a real Windows machine/);
    // And it must never imply the build is signed.
    assert.match(out, /unsigned/i);
  } finally {
    await cleanup();
  }
});
