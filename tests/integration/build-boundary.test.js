/**
 * What may reach the installed application.
 *
 * The design harness lives outside this repository, but the fixtures it serves and the tests that
 * assert against them do not - they sit inside it. This test pins the packaging rules so "the
 * harness is not in the build" is a checked fact rather than something a reviewer has to trust.
 *
 * It reads the builder config and resolves the declared patterns against the real tree; it does
 * not invoke electron-builder, because a build needs Windows and takes minutes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

/** The `files:` array from the builder config, read as text so no Node-only import is needed. */
async function packagedPatterns() {
  const text = await readFile(path.join(ROOT, 'electron-builder.config.mjs'), 'utf8');
  const start = text.indexOf('files: [');
  assert.ok(start >= 0, 'the builder config must declare a files list');
  const end = text.indexOf(']', start);
  return [...text.slice(start, end).matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

const includes = (patterns, file) => {
  let included = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    const body = negated ? pattern.slice(1) : pattern;
    if (matches(body, file)) included = !negated;
  }
  return included;
};

/** A deliberately small glob: the config only uses `**`, `*` and literal segments. */
function matches(pattern, file) {
  // Drop the negative-lookahead segments the config uses for node_modules; they never match a
  // first-party file, and pretending to evaluate them would overstate what this check proves.
  if (pattern.includes('{')) return false;
  const toRegExp = (glob) =>
    new RegExp(
      `^${glob
        .split('/')
        .map((segment) =>
          segment === '**' ? '.*' : segment.split('*').map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('[^/]*')
        )
        .join('/')}$`
    );
  return toRegExp(pattern).test(file);
}

test('no test, fixture, documentation or harness file is packaged', async () => {
  const patterns = await packagedPatterns();
  const offenders = [];

  async function walk(dir) {
    for (const entry of await readdir(path.join(ROOT, dir), { withFileTypes: true })) {
      const relative = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(relative);
        continue;
      }
      if (!includes(patterns, relative)) continue;
      if (/\.test\.js$|^tests\/|^docs\/|harness|fixture|demo/i.test(relative)) offenders.push(relative);
    }
  }

  for (const dir of ['src', 'tests', 'docs', 'scripts']) {
    const info = await stat(path.join(ROOT, dir)).catch(() => null);
    if (!info?.isDirectory()) continue;
    await walk(dir);
  }

  assert.deepEqual(offenders, [], 'these files would ship and must not');
});

test('the renderer and every module it imports are packaged', async () => {
  const patterns = await packagedPatterns();
  const entry = await readFile(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
  const imports = [...entry.matchAll(/^import[^'"]*['"](\.[^'"]+)['"]/gm)].map((match) => match[1]);

  assert.ok(imports.length > 0, 'the renderer must be a module with local imports');
  for (const specifier of imports) {
    const resolved = path.posix.normalize(path.posix.join('src/renderer', specifier));
    assert.ok(includes(patterns, resolved), `${resolved} is imported by the renderer but not packaged`);
    const exists = await stat(path.join(ROOT, resolved)).catch(() => null);
    assert.ok(exists?.isFile(), `${resolved} is imported but does not exist`);
  }
});

test('the harness is outside the repository, so it cannot be packaged by accident', async () => {
  const info = await stat(path.join(ROOT, 'ui-preview')).catch(() => null);
  assert.equal(info, null, 'the design harness must not live inside the shipped tree');
});
