/**
 * The GUI harness must cover the interface it claims to cover.
 *
 * `src/app/gui-smoke.js` walks the real navigation on a Windows runner and screenshots every
 * page. That is the only evidence in this project that the interface works outside jsdom, so
 * the two ways it can silently stop being true are pinned here:
 *
 *   1. a page is added to the renderer and the harness keeps walking the old list;
 *   2. the screenshots are captured but never uploaded, so nobody can look at them.
 *
 * Both are cheap to check statically and neither is checkable from Linux any other way.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

const read = (relative) => readFile(path.join(ROOT, relative), 'utf8');

const { PAGE_EXPECTATIONS, PAGE_ORDER } = await import('../../src/app/gui-pages.js');

/** Page ids from the renderer's navigation declaration. */
async function rendererPages() {
  const source = await read('src/renderer/app.js');
  const block = source.slice(source.indexOf('const PAGES = ['), source.indexOf('];', source.indexOf('const PAGES = [')));
  return [...block.matchAll(/\{\s*id:\s*'([a-zA-Z]+)'/g)].map((match) => match[1]);
}

/** Page ids from the harness's expectation table. */
function harnessPages() {
  return [...PAGE_ORDER];
}

test('the GUI harness visits exactly the pages the renderer declares', async () => {
  const declared = await rendererPages();
  const covered = await harnessPages();

  assert.ok(declared.length >= 18, `expected at least 18 pages, parsed ${declared.length}`);
  assert.deepEqual(
    [...covered].sort(),
    [...declared].sort(),
    'the harness page table and the renderer navigation have drifted apart'
  );
});

test('the GUI harness screenshots every page it visits', async () => {
  const source = await read('src/app/gui-smoke.js');
  assert.match(source, /await screenshot\(`page-\$\{id\}`\)/, 'each visited page must be captured');
  assert.match(source, /capturePage\(\)/, 'the screenshot must come from the real compositor');
  assert.match(source, /screenshots: shots/, 'the verdict must name the files it wrote');
});

test('the harness first captures the first-run tour and the three new surfaces', async () => {
  const source = await read('src/app/gui-smoke.js');
  for (const name of ['tour-', 'logs-populated', 'reports-preview', 'privacy', 'dashboard-zoom-125']) {
    assert.ok(source.includes(name), `the harness no longer captures "${name}"`);
  }
});

test('the evidence artifact includes the screenshots', async () => {
  const workflow = await read('.github/workflows/build.yml');
  const artifact = workflow.slice(workflow.indexOf('name: veridex-gui-evidence'));
  const pathBlock = artifact.slice(0, artifact.indexOf('if-no-files-found'));
  assert.match(pathBlock, /gui-shots\/\*\*/, 'the screenshots must be part of the evidence upload');
});

test('the launcher clears stale screenshots before every run', async () => {
  const launcher = await read('scripts/gui-smoke.mjs');
  assert.match(launcher, /rm\(shotsDir, \{ recursive: true, force: true \}\)/, 'a previous run must not be counted as this one');
  assert.match(launcher, /missing from disk/, 'a screenshot named in the verdict but absent must fail the run');
});
