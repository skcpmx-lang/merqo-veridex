/**
 * The publication step, executed.
 *
 * The previous version of this step passed `$prerelease` — an empty string for a stable
 * release — as a trailing argument to `gh release create`. PowerShell forwards an empty string
 * to a native command as `""`, and every positional after the tag is an **asset path**, so gh
 * tried to glob an empty name and stopped with `no matches found for ''` — after the tag had
 * been pushed and before anything was published.
 *
 * Reading the YAML cannot prove the fix, because the bug was in what the shell actually handed
 * to `gh`. So these tests take the `run:` block out of the shipped workflow file, run it under
 * bash in a temporary directory with stub `gh` and `git` binaries, and inspect the argument
 * vectors gh really received. Nothing here is a mock of the logic under test: the logic under
 * test is the text that ships.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');

/**
 * Pull one step's `run:` script out of the workflow, dedented exactly as Actions would.
 * @param {string} name the step's `name:`
 * @returns {string}
 */
function stepScript(name) {
  const lines = WORKFLOW.split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.notEqual(start, -1, `the workflow has no step named "${name}"`);

  let runLine = -1;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {6}- /.test(lines[index])) break;
    if (/^\s+run: \|\s*$/.test(lines[index])) { runLine = index; break; }
  }
  assert.notEqual(runLine, -1, `the step "${name}" has no run: | block`);

  const runIndent = lines[runLine].match(/^(\s*)/)[1].length;
  const bodyIndent = runIndent + 2;
  const body = [];
  for (let index = runLine + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') { body.push(''); continue; }
    const indent = line.match(/^(\s*)/)[1].length;
    if (indent < bodyIndent) break;
    body.push(line.slice(bodyIndent));
  }
  return body.join('\n');
}

const PUBLISH = stepScript('Publish the release');
const VERIFY = stepScript('Verify the published release');
const TAG_STEP = stepScript('Create the tag if it does not exist');

const STUB_GH = `#!/usr/bin/env bash
set -uo pipefail
for arg in "$@"; do printf '[%s]\\n' "$arg" >> "$GH_ARGV_LOG"; done
printf -- '---\\n' >> "$GH_ARGV_LOG"
case "$1 $2" in
  "release view")
    [ -f "\${GH_VIEW_JSON:-}" ] || { echo "stub gh: no view json" >&2; exit 1; }
    cat "$GH_VIEW_JSON"
    ;;
  "release download")
    dir=""
    while [ $# -gt 0 ]; do
      case "$1" in --dir) dir="$2"; shift 2;; *) shift;; esac
    done
    cp "\${GH_DOWNLOAD_DIR:?}"/* "$dir"/
    ;;
  *)
    exit 0
    ;;
esac
`;

const STUB_GIT = `#!/usr/bin/env bash
set -uo pipefail
for arg in "$@"; do printf '[%s]\\n' "$arg" >> "$GIT_ARGV_LOG"; done
printf -- '---\\n' >> "$GIT_ARGV_LOG"
case "$1" in
  rev-parse)
    # rev-parse HEAD → the head sha; rev-parse --verify refs/tags/… → the tagged sha
    case "$*" in
      *"refs/tags/"*) printf '%s\\n' "\${GIT_TAG_SHA:-}" ;;
      *) printf '%s\\n' "\${GIT_HEAD_SHA:?}" ;;
    esac
    ;;
  fetch) exit 0 ;;
esac
exit 0
`;

/**
 * Build a throwaway workspace: assets in dist/, stub binaries on PATH, a notes destination.
 * @param {object} [options]
 */
function workspace(options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'vx-publish-'));
  const bin = path.join(dir, 'bin');
  const temp = path.join(dir, 'temp');
  const dist = path.join(dir, 'dist');
  const download = path.join(dir, 'download');
  for (const folder of [bin, temp, dist, download]) mkdirSync(folder, { recursive: true });

  for (const [name, body] of [['gh', STUB_GH], ['git', STUB_GIT]]) {
    const file = path.join(bin, name);
    writeFileSync(file, body);
    chmodSync(file, 0o755);
  }

  const installer = 'VERIDEX-Setup-1.0.0-x64.exe';
  const portable = 'VERIDEX-1.0.0-portable-x64.exe';
  const version = options.version ?? '1.0.0';
  const installerName = options.installerName ?? installer;
  const portableName = options.portableName ?? portable;

  if (options.installer !== 'missing') {
    writeFileSync(path.join(dist, installerName), options.installer ?? 'MZ fake installer contents'.repeat(40));
  }
  if (options.portable !== 'missing') {
    writeFileSync(path.join(dist, portableName), options.portable ?? 'MZ fake portable contents'.repeat(40));
  }

  const sums = [installerName, portableName]
    .filter((name) => existsSync(path.join(dist, name)))
    .map((name) => `${digest(path.join(dist, name))}  ${name}`)
    .join('\n');
  if (options.sums !== 'missing') writeFileSync(path.join(dist, 'SHA256SUMS.txt'), `${options.sums ?? sums}\n`);

  // What the release page is said to contain, and what a download returns.
  writeFileSync(path.join(temp, 'view.json'), JSON.stringify(options.view ?? { absent: true }));
  for (const name of [installerName, portableName]) {
    const source = path.join(dist, name);
    if (existsSync(source)) writeFileSync(path.join(download, name), readFileSync(source));
  }
  if (existsSync(path.join(dist, 'SHA256SUMS.txt'))) {
    writeFileSync(path.join(download, 'SHA256SUMS.txt'), readFileSync(path.join(dist, 'SHA256SUMS.txt')));
  }

  const env = {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    HOME: dir,
    RUNNER_TEMP: temp,
    GITHUB_WORKSPACE: dir,
    GH_ARGV_LOG: path.join(dir, 'gh-argv.log'),
    GIT_ARGV_LOG: path.join(dir, 'git-argv.log'),
    GH_VIEW_JSON: path.join(temp, 'view.json'),
    GH_DOWNLOAD_DIR: download,
    TAG: `v${version}`,
    VERSION: version,
    PRERELEASE: 'false',
    RELEASE_ACTION: 'create',
    TAG_ACTION: 'create',
    TAG_EXISTING: 'none',
    GIT_HEAD_SHA: 'f'.repeat(40),
    GIT_TAG_SHA: 'f'.repeat(40),
    ...(options.env ?? {})
  };

  return { dir, dist, temp, download, env, installerName, portableName, notes: path.join(temp, 'VERIDEX-RELEASE-NOTES.md') };
}

function digest(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Run a workflow step's script in a prepared workspace.
 * @param {string} script
 * @param {object} box
 */
function run(script, box) {
  const file = path.join(box.temp, 'step.sh');
  writeFileSync(file, script);
  const result = spawnSync('bash', [file], { cwd: box.dir, env: box.env, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * Read the recorded argument vectors: one array per `gh`/`git` invocation.
 * @param {string} file
 * @returns {string[][]}
 */
function invocations(file) {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf8');
  return text
    .split('---\n')
    .filter((block) => block.trim() !== '')
    .map((block) => block.split('\n').filter((line) => line.startsWith('[')).map((line) => line.slice(1, -1)));
}

function ghCalls(box) {
  return invocations(box.env.GH_ARGV_LOG);
}

function gitCalls(box) {
  return invocations(box.env.GIT_ARGV_LOG);
}

// ═══ The publish step ══════════════════════════════════════════════════════

test('the publish step hands gh exactly three real files and no empty argument', () => {
  const box = workspace();
  const result = run(PUBLISH, box);
  assert.equal(result.status, 0, `the step failed:\n${result.stdout}\n${result.stderr}`);

  const calls = ghCalls(box);
  assert.equal(calls.length, 1, `expected one gh invocation, saw ${calls.length}`);
  const argv = calls[0];

  for (const arg of argv) {
    assert.notEqual(arg, '', `gh received an empty argument: ${JSON.stringify(argv)}`);
  }
  assert.equal(argv[0], 'release');
  assert.equal(argv[1], 'create');
  assert.equal(argv[2], 'v1.0.0');
  assert.deepEqual(
    argv.slice(3, 6),
    [`dist/${box.installerName}`, `dist/${box.portableName}`, 'dist/SHA256SUMS.txt'],
    'the three assets go to gh as named files, in order, with nothing between them'
  );
  assert.ok(argv.includes('--verify-tag'), 'the tag must exist before anything is published');
  assert.ok(argv.includes('--notes-file'), 'the notes go through a file, not an argument');
  assert.ok(!argv.includes('--prerelease'), 'a stable release must not carry --prerelease');
  assert.ok(!argv.some((arg) => arg === '--notes'), 'no inline --notes argument');

  // The notes file is written, substituted, and is the one gh was told about.
  const notesPath = argv[argv.indexOf('--notes-file') + 1];
  assert.equal(notesPath, box.notes);
  const notes = readFileSync(notesPath, 'utf8');
  assert.match(notes, /^## VERIDEX 1\.0\.0$/m);
  assert.doesNotMatch(notes, /@VERSION@/, 'the placeholder must be substituted');
  assert.match(notes, /unsigned/, 'the unsigned warning must be published');
  assert.match(notes, /VERIDEX-Setup-1\.0\.0-x64\.exe/, 'the notes must name the real installer');
});

test('a pre-release adds --prerelease and changes nothing else', () => {
  const box = workspace({ env: { PRERELEASE: 'true' } });
  const result = run(PUBLISH, box);
  assert.equal(result.status, 0, result.stderr);
  const argv = ghCalls(box)[0];
  assert.ok(argv.includes('--prerelease'));
  assert.equal(argv[argv.indexOf('--prerelease') + 1], undefined, '--prerelease takes no value');
  assert.equal(argv.filter((arg) => arg === '').length, 0);
});

test('a missing asset stops the step before gh is called at all', () => {
  const box = workspace({ portable: 'missing' });
  const result = run(PUBLISH, box);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /missing asset/);
  assert.deepEqual(ghCalls(box), [], 'gh must not be invoked when an asset is absent');
});

test('a zero-byte asset stops the step before gh is called', () => {
  const box = workspace({ portable: '' });
  const result = run(PUBLISH, box);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /zero bytes/);
  assert.deepEqual(ghCalls(box), []);
});

test('a checksum file that does not describe the files stops the step', () => {
  const box = workspace();
  // The installer changed after it was checksummed.
  writeFileSync(path.join(box.dist, box.installerName), 'different bytes entirely');
  const result = run(PUBLISH, box);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /does not match its SHA256SUMS\.txt entry/);
  assert.deepEqual(ghCalls(box), []);
});

test('a checksum file with no entry for an asset stops the step', () => {
  const box = workspace({ sums: `${'0'.repeat(64)}  something-else.exe` });
  const result = run(PUBLISH, box);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /has no entry for/);
  assert.deepEqual(ghCalls(box), []);
});

test('an interrupted draft is completed and then published, never recreated', () => {
  const box = workspace({ env: { RELEASE_ACTION: 'complete-draft' } });
  const result = run(PUBLISH, box);
  assert.equal(result.status, 0, result.stderr);
  const calls = ghCalls(box);
  assert.equal(calls.length, 2, 'one upload, one edit');
  assert.deepEqual(calls[0].slice(0, 3), ['release', 'upload', 'v1.0.0']);
  assert.ok(calls[0].includes('--clobber'), 'a draft is not public, so its own files may be replaced');
  assert.deepEqual(calls[1].slice(0, 2), ['release', 'edit']);
  assert.ok(calls[1].includes('--draft=false'), 'the draft is published');
  assert.ok(!calls.some((call) => call[1] === 'create'), 'a draft must never be re-created');
});

test('an already-published release is left alone', () => {
  const box = workspace({ env: { RELEASE_ACTION: 'verify' } });
  const result = run(PUBLISH, box);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(ghCalls(box), [], 'verify means verify: nothing is created, uploaded or edited');
});

test('an unknown release action is refused rather than guessed', () => {
  const box = workspace({ env: { RELEASE_ACTION: '' } });
  const result = run(PUBLISH, box);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /unknown release action/);
  assert.deepEqual(ghCalls(box), []);
});

// ═══ The verification step ═════════════════════════════════════════════════

/**
 * A view.json describing a complete, published release.
 * @param {object} box
 */
function completeRelease(box, overrides = {}) {
  return {
    tagName: 'v1.0.0',
    isDraft: false,
    isPrerelease: false,
    url: 'https://github.com/skcpmx-lang/merqo-veridex/releases/tag/v1.0.0',
    body: '## VERIDEX 1.0.0\n\n### This build is unsigned\n',
    assets: [
      { name: box.installerName, size: 1000 },
      { name: box.portableName, size: 1000 },
      { name: 'SHA256SUMS.txt', size: 140 }
    ],
    ...overrides
  };
}

test('the verification step accepts a complete release and prints the digests', () => {
  const box = workspace();
  writeFileSync(path.join(box.temp, 'view.json'), JSON.stringify(completeRelease(box)));
  const result = run(VERIFY, box);
  assert.equal(result.status, 0, `the verification failed:\n${result.stdout}\n${result.stderr}`);
  const expected = digest(path.join(box.download, box.installerName));
  assert.match(result.stdout, new RegExp(`${expected}  ${box.installerName}`));
  assert.match(result.stdout, /VERIFIED/);
});

test('the verification step refuses a release that is still a draft', () => {
  const box = workspace();
  writeFileSync(path.join(box.temp, 'view.json'), JSON.stringify(completeRelease(box, { isDraft: true })));
  const result = run(VERIFY, box);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /still a draft/);
});

test('the verification step refuses a release whose checksums do not match its assets', () => {
  const box = workspace();
  writeFileSync(path.join(box.temp, 'view.json'), JSON.stringify(completeRelease(box)));
  // The download differs from the checksum file that was published with it.
  writeFileSync(path.join(box.download, box.installerName), 'a different installer');
  const result = run(VERIFY, box);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /does not match the published SHA256SUMS\.txt/);
});

test('the verification step refuses a release with a missing asset', () => {
  const box = workspace();
  const view = completeRelease(box);
  view.assets = view.assets.filter((asset) => asset.name !== box.portableName);
  writeFileSync(path.join(box.temp, 'view.json'), JSON.stringify(view));
  const result = run(VERIFY, box);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing the release|missing/);
});

test('the verification step refuses a release whose notes do not say the build is unsigned', () => {
  const box = workspace();
  writeFileSync(path.join(box.temp, 'view.json'), JSON.stringify(completeRelease(box, { body: '## VERIDEX 1.0.0\n' })));
  const result = run(VERIFY, box);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsigned/);
});

test('the verification step refuses when the uploaded bytes are not the bytes this run built', () => {
  const box = workspace();
  writeFileSync(path.join(box.temp, 'view.json'), JSON.stringify(completeRelease(box)));
  // The download and the checksum file agree, but dist/ holds something else.
  writeFileSync(path.join(box.dist, box.installerName), 'rebuilt differently');
  const result = run(VERIFY, box);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /not the file this run built/);
});

// ═══ The tag step ══════════════════════════════════════════════════════════

test('the tag step creates the tag once and never moves one', () => {
  const created = workspace();
  const createResult = run(TAG_STEP, created);
  assert.equal(createResult.status, 0, createResult.stderr);
  const git = gitCalls(created);
  const tagCall = git.find((call) => call[0] === 'tag');
  assert.ok(tagCall, 'the tag is created');
  assert.deepEqual(tagCall.slice(0, 2), ['tag', '-a'], 'the tag is annotated');
  assert.equal(tagCall[2], 'v1.0.0');
  assert.equal(tagCall[3], '-m');
  assert.deepEqual(
    git.find((call) => call[0] === 'push'),
    ['push', 'origin', 'refs/tags/v1.0.0'],
    'the tag is pushed by its full ref'
  );
  assert.ok(
    !git.some((call) => call.some((arg) => arg === '--force' || arg === '-f')),
    'nothing here may force anything'
  );

  const reused = workspace({ env: { TAG_ACTION: 'reuse', TAG_EXISTING: 'f'.repeat(40) } });
  const reuseResult = run(TAG_STEP, reused);
  assert.equal(reuseResult.status, 0, reuseResult.stderr);
  const reuseGit = gitCalls(reused);
  assert.ok(!reuseGit.some((call) => call[0] === 'tag'), 'an existing tag is never re-created');
  assert.ok(!reuseGit.some((call) => call[0] === 'push'), 'an existing tag is never pushed again');
});

test('the tag step refuses when the tag does not name the commit that was built', () => {
  const box = workspace({ env: { TAG_ACTION: 'reuse', TAG_EXISTING: 'a'.repeat(40), GIT_TAG_SHA: 'b'.repeat(40) } });
  const result = run(TAG_STEP, box);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /names .* but this run built/);
});
