/**
 * Documentation that names code must keep naming code that exists.
 *
 * docs/SECURITY.md makes claims of the form "enforced in src/security/guard.js". Those
 * claims rot silently when a file is renamed, and a security document that points at a
 * path which no longer exists is worse than no document: it reads as evidence.
 *
 * This test resolves every path a document mentions and fails if one is missing. It also
 * checks that the promises the document makes in prose are still true in the code.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DOCS = path.join(ROOT, 'docs');

/** Documents that reference source files by path. */
const REFERENCING_DOCS = ['SECURITY.md', 'requirements.json'];

test('every repository path named in the documentation exists', () => {
  const missing = [];
  for (const name of REFERENCING_DOCS) {
    const file = path.join(DOCS, name);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    const candidates = new Set([
      ...[...text.matchAll(/(?:^|[\s`"'(])((?:src|tests|scripts|docs|build|installer)\/[A-Za-z0-9_./-]+)(?=[\s`"'),:]|$)/gm)].map((m) => m[1])
    ]);
    for (const candidate of candidates) {
      if (candidate.includes('*')) continue;
      // Strip a #symbol or :line suffix, a trailing sentence period, and any
      // "+ other/file" list glue that JSON-free prose uses.
      const clean = candidate.split('#')[0].split(':')[0].replace(/\.+$/, '');
      if (!existsSync(path.join(ROOT, clean))) missing.push(`${name}: ${candidate}`);
    }
  }
  assert.deepEqual(missing, [], `documentation points at paths that do not exist:\n  ${missing.join('\n  ')}`);
});

test('the security document does not describe a network client that exists', () => {
  const doc = readFileSync(path.join(DOCS, 'SECURITY.md'), 'utf8');
  // The document claims VERIDEX contains no transport code. If that claim is ever
  // weakened in the document, this test should be updated deliberately, not silently.
  assert.match(doc, /no network client/i);
  assert.match(doc, /unsigned/i, 'the unsigned status of the build must be stated');
  assert.match(doc, /not a (kernel )?sandbox|not a sandbox/i, 'the guard\'s limits must be stated');
});

test('the guard claims in SECURITY.md match the guard tables', async () => {
  const doc = readFileSync(path.join(DOCS, 'SECURITY.md'), 'utf8');
  const guard = await import('../../src/security/guard.js');

  // Section 3.2 lists the scripted-diskpart and shell cases; both must still be rules.
  const ids = guard.FORBIDDEN_COMMANDS.map((rule) => rule.id);
  for (const required of ['diskpart-script', 'shell-destructive', 'format-volume', 'registry-write']) {
    assert.ok(ids.includes(required), `SECURITY.md relies on rule "${required}" which no longer exists`);
  }

  // Section 3.3 names the four consent-gated writes.
  const consentIds = guard.CONSENT_REQUIRED.map((rule) => rule.id);
  for (const id of consentIds) {
    assert.ok(doc.includes(id) || /consent/i.test(doc), `consent rule "${id}" is not mentioned in SECURITY.md`);
  }
});

test('the CSP quoted in SECURITY.md matches the one in the document shell', () => {
  const doc = readFileSync(path.join(DOCS, 'SECURITY.md'), 'utf8');
  const html = readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  const meta = html.match(/Content-Security-Policy" content="([^"]+)"/);
  assert.ok(meta, 'the renderer must declare a CSP');
  const directives = meta[1].split(';').map((part) => part.trim()).filter(Boolean);
  for (const directive of directives) {
    assert.ok(
      doc.includes(directive),
      `SECURITY.md quotes a CSP that omits "${directive}", which the shell actually declares`
    );
  }
});

test('the test count quoted in the documentation matches the files on disk', () => {
  // Documents that quote a number rot the moment a test is added. Rather than banning the
  // number (it is useful evidence), pin it to the files: count the `test(` declarations in
  // the suite and require the documented figure to be within one of it.
  let declared = 0;
  for (const dir of ['tests/unit', 'tests/integration']) {
    for (const name of readdirSync(path.join(ROOT, dir))) {
      if (!name.endsWith('.test.js')) continue;
      const text = readFileSync(path.join(ROOT, dir, name), 'utf8');
      declared += (text.match(/^test\(/gm) ?? []).length;
    }
  }
  assert.ok(declared > 300, `expected a real suite, counted ${declared} test declarations`);

  for (const file of ['README.md', 'docs/TEST_STATUS.md', 'docs/PROJECT_STATUS.md', 'docs/KNOWN_LIMITATIONS.md']) {
    const target = path.join(ROOT, file);
    if (!existsSync(target)) continue;
    const text = readFileSync(target, 'utf8');
    for (const match of text.matchAll(/(\d{3})\s+(?:automated\s+)?tests/g)) {
      const quoted = Number(match[1]);
      assert.ok(
        Math.abs(quoted - declared) <= 2,
        `${file} quotes ${quoted} tests but the suite declares ${declared}`
      );
    }
  }
});

test('every document in docs/ is listed in the README or requirements', () => {
  // A document nobody links to is a document nobody reads.
  const docs = readdirSync(DOCS).filter((name) => name.endsWith('.md'));
  const requirements = readFileSync(path.join(DOCS, 'REQUIREMENTS.md'), 'utf8');
  const readme = existsSync(path.join(ROOT, 'README.md')) ? readFileSync(path.join(ROOT, 'README.md'), 'utf8') : '';
  const unreferenced = docs.filter(
    (name) => name !== 'REQUIREMENTS.md' && !requirements.includes(name) && !readme.includes(name)
  );
  assert.deepEqual(unreferenced, [], `documents not referenced anywhere: ${unreferenced.join(', ')}`);
});

test('the forbidden-command count quoted in SECURITY.md matches the guard', async () => {
  // The document said "sixteen" while the table held twenty-two, and nothing noticed: a count
  // in prose is a claim about code. This pins it to FORBIDDEN_COMMANDS itself, in words and in
  // digits, so the next rule that is added either updates the sentence or fails the build.
  const { FORBIDDEN_COMMANDS, CONSENT_REQUIRED } = await import('../../src/security/guard.js');
  const doc = readFileSync(path.join(DOCS, 'SECURITY.md'), 'utf8');
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
    'nineteen', 'twenty', 'twenty-one', 'twenty-two', 'twenty-three', 'twenty-four', 'twenty-five',
    'twenty-six', 'twenty-seven', 'twenty-eight', 'twenty-nine', 'thirty'];
  const count = FORBIDDEN_COMMANDS.length;
  assert.ok(count < words.length, 'the table has outgrown the words this test knows');
  assert.ok(
    doc.includes(`${words[count]} damaging command lines`) || doc.includes(`${count} damaging command lines`),
    `SECURITY.md does not quote the real forbidden count (${words[count]} / ${count}), which is what FORBIDDEN_COMMANDS holds`
  );
  const consent = words[CONSENT_REQUIRED.length];
  const consentCapitalised = consent[0].toUpperCase() + consent.slice(1);
  assert.ok(
    doc.includes(`write files.** ${consentCapitalised}`) || doc.includes(`write files.** ${CONSENT_REQUIRED.length}`),
    `SECURITY.md does not quote the real consent count (${consent}), which is what CONSENT_REQUIRED holds`
  );
});
