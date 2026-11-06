/**
 * The release version, and what may be done with a tag.
 *
 * Four release runs failed at their first guard while the repository had no tags at all. The
 * guard was `if (git rev-parse "v$version")` — and `git rev-parse v1.0.0` prints `v1.0.0` to
 * stdout even when it cannot resolve it, so PowerShell saw a truthy string every time. The
 * second run also proved the input was never normalised: a person typed `v1.0.0`, the workflow
 * prefixed another one, and the message read `vv1.0.0`.
 *
 * These tests pin both halves of the fix, and the workflow text that has to use it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, readFileSync as read } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeVersion,
  decideTagAction,
  decideRelease,
  readReleaseState,
  parseArgs,
  renderEnv,
  emit
} from '../../scripts/release-version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');

// ═══ Normalisation ═════════════════════════════════════════════════════════

test('1.0.0 and v1.0.0 both produce the canonical tag v1.0.0', () => {
  for (const input of ['1.0.0', 'v1.0.0', 'V1.0.0', '  v1.0.0  ']) {
    const result = normalizeVersion(input);
    assert.equal(result.ok, true, `${input} should be accepted`);
    assert.equal(result.version, '1.0.0');
    assert.equal(result.tag, 'v1.0.0', `${input} must not produce a second v`);
  }
});

test('a doubled prefix can never reach the tag', () => {
  // The exact string the failed run printed. It normalises to the canonical tag rather than
  // being echoed back with another v in front of it.
  const result = normalizeVersion('vv1.0.0');
  assert.equal(result.ok, true);
  assert.equal(result.tag, 'v1.0.0');
  assert.notEqual(result.tag, 'vvv1.0.0');
});

test('a pre-release version keeps its suffix and is marked as one', () => {
  const result = normalizeVersion('v1.2.3-rc.1');
  assert.equal(result.ok, true);
  assert.equal(result.version, '1.2.3-rc.1');
  assert.equal(result.tag, 'v1.2.3-rc.1');
  assert.equal(result.prerelease, true);
  assert.equal(normalizeVersion('1.2.3').prerelease, false);
});

test('versions that are not three-part numbers are refused with a reason', () => {
  for (const input of ['', '   ', 'v', 'vv', '1.0', '1', '1.0.0.0', 'one.two.three', '1.0.0 beta', 'latest']) {
    const result = normalizeVersion(input);
    assert.equal(result.ok, false, `"${input}" must be refused`);
    assert.match(result.error, /version|prefix/i, `the refusal for "${input}" must explain itself`);
  }
});

test('leading zeros are normalised rather than carried into a tag', () => {
  const result = normalizeVersion('01.02.03');
  assert.equal(result.ok, true);
  assert.equal(result.tag, 'v1.2.3');
});

// ═══ What may be done with a tag ═══════════════════════════════════════════

test('a missing tag is created on the release commit', () => {
  const decision = decideTagAction({ tag: 'v1.0.0', target: 'abc1234567', existing: null });
  assert.equal(decision.action, 'create');
});

test('a tag already on this commit is reused, not moved', () => {
  const decision = decideTagAction({ tag: 'v1.0.0', target: 'e3f6cc95362b7d82480e4f0bc6f8943b7145bd3b', existing: 'e3f6cc95362b7d82480e4f0bc6f8943b7145bd3b' });
  assert.equal(decision.action, 'reuse');
  assert.match(decision.message, /reused, not moved/);
});

test('an abbreviated existing tag still counts as the same commit', () => {
  const full = 'e3f6cc95362b7d82480e4f0bc6f8943b7145bd3b';
  assert.equal(decideTagAction({ tag: 'v1.0.0', target: full, existing: 'e3f6cc9' }).action, 'reuse');
  assert.equal(decideTagAction({ tag: 'v1.0.0', target: 'e3f6cc9', existing: full }).action, 'reuse');
});

test('a tag on another commit is refused, never overwritten', () => {
  const decision = decideTagAction({ tag: 'v1.0.0', target: 'aaaaaaa', existing: 'bbbbbbb' });
  assert.equal(decision.action, 'refuse');
  assert.match(decision.message, /never moved, overwritten or deleted/);
  assert.match(decision.message, /bbbbbbb/);
  assert.match(decision.message, /aaaaaaa/);
});

test('an existing release never makes the tag decision a duplicate-publishing one', () => {
  // The release object is handled separately, by decideRelease: the tag may be reused, and the
  // release itself is then verified rather than created again.
  const decision = decideTagAction({ tag: 'v1.0.0', target: 'abc', existing: 'abc', releaseExists: true });
  assert.equal(decision.action, 'reuse');
  assert.equal(decideRelease({ state: 'published' }).action, 'verify');
});

test('a release without a tag is refused as an unexplainable state', () => {
  const decision = decideTagAction({ tag: 'v1.0.0', target: 'abc', existing: null, releaseState: 'published' });
  assert.equal(decision.action, 'refuse');
  assert.match(decision.message, /cannot be explained/);
});

// ═══ Resuming after a partial failure ══════════════════════════════════════

test('a tag on an ancestor commit releases the tagged tree, not the branch head', () => {
  // v1.0.0 was pushed by a run that then died while publishing. main has moved on since, by
  // exactly the CI fix that makes publishing work. The released files must be the files the
  // tag names, so the ref to build is the tag's commit and the tag is never moved.
  const decision = decideTagAction({
    tag: 'v1.0.0',
    target: 'cccccccccccccccccccccccccccccccccccccccc',
    existing: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    inHistory: true
  });
  assert.equal(decision.action, 'reuse-ancestor');
  assert.equal(decision.ref, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.notEqual(decision.ref, 'cccccccccccccccccccccccccccccccccccccccc');
  assert.match(decision.message, /not moved/);
});

test('a tag that is not in the history of the dispatched commit is refused', () => {
  const decision = decideTagAction({ tag: 'v1.0.0', target: 'aaaaaaa', existing: 'bbbbbbb', inHistory: false });
  assert.equal(decision.action, 'refuse');
  assert.equal(decision.ref, null);
  assert.match(decision.message, /not in the history/);
});

test('a tag on this commit is reused and built from that same commit', () => {
  const decision = decideTagAction({ tag: 'v1.0.0', target: 'ddddddd', existing: 'ddddddd' });
  assert.equal(decision.action, 'reuse');
  assert.equal(decision.ref, 'ddddddd');
});

test('a missing tag is created on the dispatched commit', () => {
  const decision = decideTagAction({ tag: 'v1.0.0', target: 'eeeeeee' });
  assert.equal(decision.action, 'create');
  assert.equal(decision.ref, 'eeeeeee');
});

// ═══ The release object ════════════════════════════════════════════════════

test('the release state is read from what gh printed, including "absent"', () => {
  assert.equal(readReleaseState({ absent: true }).state, 'none');
  assert.equal(readReleaseState(null).state, 'none');
  assert.equal(readReleaseState('none').state, 'none');
  assert.equal(readReleaseState('draft').state, 'draft');
  assert.equal(readReleaseState('published').state, 'published');
  assert.equal(readReleaseState({ isDraft: true, assets: [] }).state, 'draft');
  const published = readReleaseState({
    isDraft: false,
    isPrerelease: false,
    url: 'https://example.invalid/release',
    assets: [{ name: 'a.exe', size: 12 }, { name: 'SHA256SUMS.txt', size: 3 }]
  });
  assert.equal(published.state, 'published');
  assert.deepEqual(published.assets, [{ name: 'a.exe', size: 12 }, { name: 'SHA256SUMS.txt', size: 3 }]);
  assert.equal(published.url, 'https://example.invalid/release');
});

test('each release state has one action, and none of them overwrites a published release', () => {
  assert.equal(decideRelease({ state: 'none' }).action, 'create');
  assert.equal(decideRelease({ state: 'draft' }).action, 'complete-draft');
  assert.equal(decideRelease({ state: 'published' }).action, 'verify');
  assert.equal(decideRelease({ state: 'something else' }).action, 'refuse');
  assert.match(decideRelease({ state: 'published' }).message, /never overwritten or deleted/);
});

// ═══ Plumbing ══════════════════════════════════════════════════════════════

test('the command line separates the version from the flags', () => {
  assert.deepEqual(parseArgs(['v1.0.0', '--github-env']), {
    mode: 'normalize', input: 'v1.0.0', githubEnv: true, githubOutput: false,
    tag: null, target: null, existing: null, inHistory: false,
    releaseExists: false, releaseState: null, releaseJson: null
  });
  const decide = parseArgs(['--decide', '--tag', 'v1.0.0', '--target', 'abc', '--existing', 'none', '--release-exists', 'true']);
  assert.equal(decide.mode, 'decide');
  assert.equal(decide.tag, 'v1.0.0');
  assert.equal(decide.existing, 'none');
  assert.equal(decide.releaseExists, true);
});

test('values are rendered one per line for $GITHUB_ENV', () => {
  assert.equal(renderEnv({ VERSION: '1.0.0', TAG: 'v1.0.0' }), 'VERSION=1.0.0\nTAG=v1.0.0');
});

test('--github-env writes the file Actions reads, and stdout otherwise', () => {
  // A step that only printed the values would look identical in the log and leave every later
  // step with empty variables — which is how a release silently builds the wrong version.
  const dir = mkdtempSync(path.join(tmpdir(), 'vx-env-'));
  const file = path.join(dir, 'env');
  const previous = process.env.GITHUB_ENV;
  process.env.GITHUB_ENV = file;
  try {
    emit('VERSION=1.0.0', true);
    assert.equal(read(file, 'utf8').trim(), 'VERSION=1.0.0');
    emit('VERSION=2.0.0', false); // fallback path: no file write, prints instead
    assert.equal(read(file, 'utf8').trim(), 'VERSION=1.0.0', 'a non-github-env emit must not touch the file');
  } finally {
    if (previous === undefined) delete process.env.GITHUB_ENV;
    else process.env.GITHUB_ENV = previous;
  }
});

// ═══ The workflow that has to use it ═══════════════════════════════════════

test('the workflow normalises the version instead of building a tag by hand', () => {
  assert.match(WORKFLOW, /node scripts\/release-version\.mjs "\$INPUT_VERSION" --github-env/);
  assert.doesNotMatch(WORKFLOW, /v\$\{\{ inputs\.version \}\}/, 'a tag must never be built by pasting the raw input after a v');
  assert.doesNotMatch(WORKFLOW, /git tag "-/);
  assert.equal((WORKFLOW.match(/inputs\.version/g) ?? []).length, 1, 'the raw input is read once, by the normaliser');
});

test('the tag check can tell "no tag" from "cannot say"', () => {
  // `git rev-parse <tag>` echoes the tag back and exits 128. Only `--verify --quiet` is silent
  // on stdout, which is what makes the emptiness meaningful.
  assert.match(WORKFLOW, /git rev-parse --verify --quiet "refs\/tags\/\$\{TAG\}\^\{commit\}"/);
  assert.doesNotMatch(WORKFLOW, /if \(git rev-parse/);
});

test('the release step refuses to duplicate, and verifies the tag it publishes', () => {
  assert.match(WORKFLOW, /--decide/, 'the tag/release state decision must come from the module');
  assert.match(WORKFLOW, /--verify-tag/, 'gh release create must verify the tag exists before publishing');
  assert.match(WORKFLOW, /TAG_ACTION" = "create"/, 'the tag is created only when it is absent');
  assert.doesNotMatch(WORKFLOW, /git push --force|git tag -f|git push origin .*--force/, 'a tag is never moved by force');
});

test('no PowerShell string silently swallows an environment variable', () => {
  // `'$env:VERSION'` in single quotes is four literal characters plus a name; the release page
  // would read "VERIDEX $env:VERSION". The notes here-string had exactly this problem.
  assert.doesNotMatch(WORKFLOW, /'\$env:/, 'a single-quoted $env: reference does not expand');
  assert.doesNotMatch(WORKFLOW, /\$notes = @'/, 'the notes here-string must be double-quoted to interpolate');
});

test('the workflow still publishes the three required assets, named exactly', () => {
  for (const asset of [
    'dist/VERIDEX-Setup-${VERSION}-x64.exe',
    'dist/VERIDEX-${VERSION}-portable-x64.exe',
    'dist/SHA256SUMS.txt'
  ]) {
    assert.ok(WORKFLOW.includes(asset), `the release must attach ${asset}`);
  }
  assert.doesNotMatch(WORKFLOW, /disk\/VERIDEX[^\n]*\*\.exe/, 'a glob is expanded by the wrong program sooner or later');
});
