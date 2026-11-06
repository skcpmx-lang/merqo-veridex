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

test('a run that captures no screenshots says so instead of passing quietly', async () => {
  // The distinction this milestone kept having to make: "the harness ran" is not "somebody
  // looked at the interface". A silent zero must therefore be a warning, and the count must be
  // printed so a reviewer can see it in the log without downloading the artifact.
  const launcher = await read('scripts/gui-smoke.mjs');
  assert.match(launcher, /screenshots: \$\{onDisk\.length\} of \$\{shots\.length\} recorded/, 'the screenshot count must be printed');
  assert.match(launcher, /shots\.length === 0[\s\S]{0,400}no screenshots were captured in this run/, 'zero screenshots must emit a warning');
});

test('the figures quoted about the Windows run match the code they describe', async () => {
  // These numbers were stale for three commits: the document said 15 pages and 18 channels
  // while the build had 18 pages and 32 channels, because the counts were typed once and the
  // code moved on. A number in a release document is a claim about a specific build.
  const { PAGE_ORDER } = await import('../../src/app/gui-pages.js');
  const { INVOKE_CHANNELS } = await import('../../src/app/ipc-contract.js');
  const pages = PAGE_ORDER.length;
  const channels = INVOKE_CHANNELS.length;
  const doc = await read('docs/RELEASE_VERIFICATION.md');
  assert.match(doc, new RegExp(`${channels} invoke channels`), `the document must quote the real channel count (${channels})`);
  assert.match(doc, new RegExp(`all ${pages} pages`, 'i'), `the document must quote the real page count (${pages})`);
  assert.doesNotMatch(doc, /all 15 pages/i, 'the older page count is still quoted somewhere');
});

test('IPC handlers are registered before the window loads the renderer', async () => {
  // The renderer invokes app:onboarding, app:info, app:settings and app:lastScan from its first
  // script evaluation. Registering handlers after createWindow() gave the renderer a window it
  // could outrun, and Electron rejects an unhandled invoke rather than queueing it: on the
  // Windows runner this is what made the first-run tour silently never appear. Nothing else in
  // this suite can see it, because jsdom has no such race.
  const main = await read('src/app/main.js');
  const ready = main.slice(main.indexOf('app.whenReady()'));
  const end = ready.indexOf("app.on('activate'", ready.indexOf('await createWindow()'));
  const body = end === -1 ? ready : ready.slice(0, end);
  const registered = body.indexOf('registerHandlers()');
  const created = body.indexOf('await createWindow()');
  assert.ok(registered !== -1, 'registerHandlers() must be called at startup');
  assert.ok(created !== -1, 'createWindow() must be called at startup');
  assert.ok(registered < created, 'registerHandlers() must run before createWindow(), or the renderer can invoke a channel that has no handler');
});

test('screenshots can leave the runner, not just the artifact store', async () => {
  // An artifact is only evidence to someone who can download it. The publish-evidence job
  // exists because that download is blocked on some networks - including the machine this
  // project is verified from - and a screenshot that cannot be opened cannot be reviewed.
  // Ordinary pushes must never write to the repository, so the job is gated on a dispatch
  // input and pushes only a snapshot branch.
  const workflow = await read('.github/workflows/build.yml');
  assert.match(workflow, /capture_evidence:/, 'the dispatch input must exist');
  assert.match(workflow, /needs: package/, 'the publishing job must run after the screenshots exist');
  assert.match(workflow, /if: always\(\) && inputs\.capture_evidence/, 'it must not run on ordinary pushes');
  assert.match(workflow, /ci\/evidence-\$\{GITHUB_RUN_ID\}/, 'it must publish to a per-run branch');
  assert.match(workflow, /contents: write/, 'it needs write access to publish a branch');
});
