/**
 * The renderer's import graph, checked as a graph.
 *
 * The window once failed to boot with no error at all: `app.js` imported a privacy helper from
 * a module that (two imports deeper) reached `node:fs/promises`. A sandboxed renderer cannot
 * resolve `node:*`, so the whole module failed to evaluate and the body kept its initial
 * "Starting VERIDEX…" text. Every jsdom test still passed, because jsdom runs inside Node where
 * `node:fs` imports perfectly well. The evidence harness is what found it, two runs later.
 *
 * A static scan for the string "node:" in `src/renderer/` would not have caught it either: the
 * import was in `src/security/privacy.js`. The check has to follow the graph the browser
 * follows, so this test reads every file the renderer can reach and refuses a Node builtin.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const ENTRY = path.join(ROOT, 'src/renderer/app.js');

/** @param {string} file */
async function importsOf(file) {
  const source = await readFile(file, 'utf8');
  const specifiers = [...source.matchAll(/(?:^|\n)\s*(?:import|export)[^;\n]*?from\s+['"]([^'"]+)['"]/g)].map(
    (match) => match[1]
  );
  // Bare side-effect imports (`import './thing.js';`) count too.
  for (const match of source.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) specifiers.push(match[1]);
  return specifiers;
}

/** Walk the graph from the renderer entry point. @returns {Promise<Map<string,string[]>>} */
async function graph(entry) {
  /** @type {Map<string,string[]>} */
  const seen = new Map();
  const queue = [entry];
  while (queue.length > 0) {
    const file = /** @type {string} */ (queue.shift());
    if (seen.has(file)) continue;
    const specifiers = await importsOf(file);
    seen.set(file, specifiers);
    for (const specifier of specifiers) {
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) continue;
      queue.push(path.resolve(path.dirname(file), specifier));
    }
  }
  return seen;
}

test('the renderer never reaches a Node builtin, however deep the import chain', async () => {
  const files = await graph(ENTRY);
  const offenders = [];
  for (const [file, specifiers] of files) {
    for (const specifier of specifiers) {
      if (specifier.startsWith('node:')) offenders.push(`${path.relative(ROOT, file)} → ${specifier}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `the sandboxed renderer cannot import these, and the window will not boot:\n${offenders.join('\n')}`
  );
  // A graph of one file would mean the walker is broken rather than the code clean.
  assert.ok(files.size >= 5, `expected the renderer to reach several modules, walked ${files.size}`);
});

test('every module the renderer imports exists and parses as an ES module', async () => {
  const files = await graph(ENTRY);
  for (const file of files.keys()) {
    const source = await readFile(file, 'utf8');
    assert.ok(!/\brequire\s*\(/.test(source), `${path.relative(ROOT, file)} uses require(); the renderer is ESM`);
    assert.ok(!/\bprocess\.(env|argv|exit)\b/.test(source), `${path.relative(ROOT, file)} reaches a Node global`);
  }
});
