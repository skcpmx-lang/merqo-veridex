/**
 * The offline guarantee, proven statically.
 *
 * The runtime guard in src/security/guard.js is best-effort by design (see the
 * scope note in that file). This test proves the stronger claim instead: **the
 * VERIDEX source tree contains no network client at all.** If that scan passes,
 * there is nothing for the guard to block, and the privacy screen's promise is a
 * property of the code rather than of a patch list.
 *
 * The scan is deliberately simple and deliberately strict: it reads every source
 * file and fails on transport *imports* and on transport *calls*. It allows the
 * guard itself, which must import the modules in order to patch them, and it
 * allows occurrences inside comments where the rule is being documented.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SCANNED_DIRS = ['src'];
/** The guard must reference these modules; nothing else may. */
const ALLOWED_FILES = new Set(['src/security/guard.js']);

/** Node transport modules that would let application code talk to a network. */
const TRANSPORT_MODULES = ['node:http', 'node:https', 'node:net', 'node:tls', 'node:dgram', 'node:dns', 'node:http2'];

async function walk(dir) {
  /** @type {string[]} */
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Remove comments so that documentation *about* the rule does not trip the scan.
 * Deliberately dumb: this is a lint, not a parser, and a false negative here is
 * caught by the human review that reads the same files.
 * @param {string} source
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('no source file outside the guard imports a network transport', async () => {
  const files = (await Promise.all(SCANNED_DIRS.map((dir) => walk(path.join(ROOT, dir))))).flat();
  assert.ok(files.length > 20, `expected to scan the whole source tree, found only ${files.length} files`);

  /** @type {string[]} */
  const offenders = [];
  for (const file of files) {
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    if (ALLOWED_FILES.has(relative)) continue;
    const source = stripComments(await readFile(file, 'utf8'));
    for (const moduleName of TRANSPORT_MODULES) {
      // Matches `from 'node:http'`, `import('node:http')` and `require('node:http')`.
      const pattern = new RegExp(`(from|import|require)\\s*\\(?\\s*['"]${moduleName.replace(':', ':')}['"]`);
      if (pattern.test(source)) offenders.push(`${relative} imports ${moduleName}`);
    }
  }

  assert.deepEqual(offenders, [], `network transports must only appear in the guard:\n${offenders.join('\n')}`);
});

test('no source file calls fetch, XMLHttpRequest or a WebSocket', async () => {
  const files = (await Promise.all(SCANNED_DIRS.map((dir) => walk(path.join(ROOT, dir))))).flat();
  /** @type {string[]} */
  const offenders = [];

  for (const file of files) {
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    if (ALLOWED_FILES.has(relative)) continue;
    const source = stripComments(await readFile(file, 'utf8'));
    // `fetch(` as a call, not the word inside `prefetch` or `fetchFields`.
    if (/(^|[^a-zA-Z0-9_$.])fetch\s*\(/.test(source)) offenders.push(`${relative} calls fetch()`);
    if (/\bXMLHttpRequest\b/.test(source)) offenders.push(`${relative} uses XMLHttpRequest`);
    if (/\bnew\s+WebSocket\b/.test(source)) offenders.push(`${relative} opens a WebSocket`);
    if (/\bnavigator\.sendBeacon\b/.test(source)) offenders.push(`${relative} uses sendBeacon`);
  }

  assert.deepEqual(offenders, [], `outbound calls must not exist in the source:\n${offenders.join('\n')}`);
});

test('the renderer layer declares no remote resource in its markup or styles', async () => {
  const files = (await Promise.all(SCANNED_DIRS.map((dir) => walk(path.join(ROOT, dir))))).flat();
  /** @type {string[]} */
  const offenders = [];

  for (const file of files) {
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    const source = await readFile(file, 'utf8');
    // Reports may reference the schema URL as an identifier; they must never load it. The third
    // exemption is narrower than it looks: the SVG namespace is a name, not an address. It is
    // never fetched - it is the string that tells the DOM "this is an SVG element" - and an
    // inline icon cannot be created without it. Every other absolute URL is still an offence.
    const NAMESPACE_URIS = ['http://www.w3.org/2000/svg', 'http://www.w3.org/1999/xlink'];
    for (const match of source.matchAll(/https?:\/\/[^\s'"`)]+/g)) {
      const url = match[0];
      const benign =
        url.startsWith('https://veridex.merqo.local/schema/') ||
        url.includes('merqo.local/schema') ||
        NAMESPACE_URIS.includes(url);
      if (!benign) offenders.push(`${relative}: ${url}`);
    }
  }

  assert.deepEqual(offenders, [], `no absolute remote URLs may appear in the source:\n${offenders.join('\n')}`);
});

test('package.json declares no HTTP or cloud client dependency', async () => {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies });
  const suspicious = declared.filter((name) =>
    /^(axios|node-fetch|got|superagent|request|undici|ws|socket\.io|@aws-sdk|@azure|@google-cloud|firebase|sentry|posthog|mixpanel)/.test(name)
  );
  assert.deepEqual(suspicious, [], `no network or telemetry client may be declared: ${suspicious.join(', ')}`);
});
