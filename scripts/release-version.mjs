#!/usr/bin/env node
/**
 * One authority for what a release version is, and what may be done with it.
 *
 * This file exists because the release workflow guessed, and guessed wrongly three times:
 *
 *   1. `if (git rev-parse "v$version") { throw 'already exists' }` threw on **every** run.
 *      `git rev-parse v1.0.0` prints `v1.0.0` to stdout even when it cannot resolve it (that
 *      echo-back is documented git behaviour), so the PowerShell `if` saw a truthy string and
 *      the guard fired on a repository that had no tags at all. The workflow never reached its
 *      first build.
 *   2. Nothing normalised the input. The field says "without the leading v", a person typed
 *      `v1.0.0`, the workflow prefixed another one, and the message said `vv1.0.0`.
 *   3. The publication step passed an empty string as a positional argument: `$prerelease` was
 *      `''` when the release was not a pre-release, PowerShell forwards that to a native command
 *      as `""`, and `gh release create` treats every positional after the tag as an **asset
 *      path**. It therefore tried to glob an empty name and stopped with
 *      `no matches found for ''` — after the tag had been pushed, before anything was published.
 *
 * All three are arithmetic on strings, so the arithmetic lives here, in one place, with tests,
 * and the workflow only calls it:
 *
 *   node scripts/release-version.mjs 1.0.0 --github-env
 *   node scripts/release-version.mjs --decide --tag v1.0.0 --target <sha> \
 *        --existing <sha|none> --in-history true --release-json <path> --github-env --github-output
 *
 * Nothing here touches git or the network; it takes what the caller observed and says what may be
 * done with it. The decisions are deliberately conservative: a tag is never moved, an existing
 * release is never duplicated, and a published release is verified rather than replaced.
 */

import { appendFileSync, readFileSync } from 'node:fs';

/** Semver, without a leading `v`. Build metadata and a pre-release suffix are allowed. */
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/**
 * Normalise a version input to the canonical pair.
 *
 * - `1.0.0`, `v1.0.0`, ` V1.0.0 `, `vv1.0.0` → version `1.0.0`, tag `v1.0.0`
 * - `1.0` → refused, with the reason, rather than becoming `v1.0`
 * - empty → refused
 *
 * Leading `v`s are stripped rather than rejected: a person typing `v1.0.0` was told by the input
 * description not to, and refusing their release over a prefix they obviously meant would be
 * pedantry. What matters is that the *output* is canonical, so `vv1.0.0` can never be produced.
 *
 * @param {unknown} input
 * @returns {{ok:true, version:string, tag:string, prerelease:boolean} | {ok:false, error:string}}
 */
export function normalizeVersion(input) {
  const raw = typeof input === 'string' ? input : input === undefined || input === null ? '' : String(input);
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, error: 'no version was given; pass 1.0.0 (the leading v is optional)' };
  }
  if (/\s/.test(trimmed)) {
    return { ok: false, error: `"${trimmed}" contains whitespace; a version is a single token like 1.0.0` };
  }

  // Strip every leading v/V: `v1.0.0` and `vv1.0.0` both mean the same thing to a person, and
  // the canonical tag is built once, at the end, from the stripped version.
  const version = trimmed.replace(/^[vV]+/, '');
  if (!version) {
    return { ok: false, error: `"${trimmed}" is only a prefix; the version after the v is missing` };
  }

  const match = SEMVER.exec(version);
  if (!match) {
    return {
      ok: false,
      error: `"${trimmed}" is not a release version. Use MAJOR.MINOR.PATCH, for example 1.0.0 or v1.0.0.`
    };
  }

  const [, major, minor, patch, suffix] = match;
  const canonical = `${Number(major)}.${Number(minor)}.${Number(patch)}${suffix ?? ''}`;
  return { ok: true, version: canonical, tag: `v${canonical}`, prerelease: Boolean(suffix) };
}

/**
 * Turn what `gh release view --json …` printed into a state this file can reason about.
 *
 * The workflow writes `{"absent":true}` when `gh release view` exits non-zero, so "there is no
 * release" is an observation the caller made, not an assumption made here.
 *
 * @param {object|string|null} json   parsed `gh release view` output, or a state string
 * @returns {{state:'none'|'draft'|'published', assets:{name:string,size:number}[], url:string|null, isPrerelease:boolean|null}}
 */
export function readReleaseState(json) {
  if (typeof json === 'string') {
    if (json === 'none' || json === 'published' || json === 'draft') {
      return readReleaseState({ absent: json === 'none', isDraft: json === 'draft' });
    }
    return { state: 'unknown', assets: [], url: null, isPrerelease: null };
  }
  if (!json || json.absent === true) {
    return { state: 'none', assets: [], url: null, isPrerelease: null };
  }
  const assets = Array.isArray(json.assets)
    ? json.assets.map((asset) => ({ name: String(asset.name ?? ''), size: Number(asset.size ?? 0) }))
    : [];
  return {
    state: json.isDraft === true ? 'draft' : 'published',
    assets,
    url: typeof json.url === 'string' ? json.url : null,
    isPrerelease: typeof json.isPrerelease === 'boolean' ? json.isPrerelease : null
  };
}

/**
 * What to do about the release object for a tag.
 *
 * @param {{state:'none'|'draft'|'published'|'unknown'}} release
 * @returns {{action:'create'|'complete-draft'|'verify'|'refuse', message:string}}
 */
export function decideRelease(release) {
  const state = typeof release === 'string' ? release : release?.state;
  if (state === 'none') {
    return { action: 'create', message: 'no GitHub Release exists for this tag; it will be created.' };
  }
  if (state === 'draft') {
    return {
      action: 'complete-draft',
      message: 'a draft release exists; its assets will be uploaded and it will be published. A draft is not public, so replacing its asset files is safe.'
    };
  }
  if (state === 'published') {
    return {
      action: 'verify',
      message: 'a published release already exists; it will be verified against its own assets and left untouched. A published release is never overwritten or deleted here.'
    };
  }
  return { action: 'refuse', message: `the release state could not be read ("${String(state)}"); refusing to guess.` };
}

/**
 * What may be done with an observed repository state.
 *
 * The caller supplies what it actually saw — never what it hopes to see — and gets one of four
 * answers. A missing observation (`existing: null`) means "no tag", and must be produced by a
 * check that can tell the difference; see the workflow, which uses `git rev-parse --verify`.
 *
 * `ref` is the commit the release is built from. When the tag already exists it is the **tag's**
 * commit, not whatever happens to be at the head of the branch: the released files must be the
 * files the tag names. `inHistory` is the caller's answer to "is the tag's commit an ancestor of
 * the commit being dispatched?", which is what stops a tag that belongs to some other line of
 * work from being published under this branch's name.
 *
 * @param {object} state
 * @param {string} state.tag                 canonical tag, from normalizeVersion
 * @param {string} state.target              the commit this run was dispatched against
 * @param {string|null} [state.existing]     commit the tag points at, or null when there is no tag
 * @param {boolean} [state.inHistory]        whether that commit is an ancestor of `target`
 * @param {boolean} [state.releaseExists]    back-compatible form of `releaseState === 'published'`
 * @param {'none'|'draft'|'published'} [state.releaseState]
 * @returns {{action:'create'|'reuse'|'reuse-ancestor'|'refuse', ref:string|null, message:string}}
 */
export function decideTagAction(state) {
  const { tag, target, existing = null, inHistory = false, releaseExists = false } = state;
  const releaseState = state.releaseState ?? (releaseExists ? 'published' : 'none');
  // Abbreviated SHAs are accepted in either direction: `git rev-parse` returns a full hash and
  // `GITHUB_SHA` is one too, but a test or a person may supply `e3f6cc9`.
  const left = String(existing ?? '').trim().toLowerCase();
  const right = String(target ?? '').trim().toLowerCase();
  const sameCommit = Boolean(left) && Boolean(right) && (left === right || left.startsWith(right) || right.startsWith(left));

  if (releaseState !== 'none' && !existing) {
    return {
      action: 'refuse',
      ref: null,
      message: `a ${releaseState} release was found but no ${tag} tag was; that state cannot be explained, so nothing will be published.`
    };
  }

  if (!existing) {
    return { action: 'create', ref: String(target ?? ''), message: `no ${tag} tag exists; it will be created on ${target}.` };
  }

  if (sameCommit) {
    return {
      action: 'reuse',
      ref: String(existing),
      message: `${tag} already exists and points at this commit (${existing}); the tag will be reused, not moved.`
    };
  }

  if (inHistory) {
    return {
      action: 'reuse-ancestor',
      ref: String(existing),
      message: `${tag} already exists and points at ${existing}, which is in the history of ${target}. The release will be built from the tagged commit ${existing} — the files the tag names — and the tag itself is not moved.`
    };
  }

  return {
    action: 'refuse',
    ref: null,
    message: `${tag} already exists and points at ${existing}, which is not in the history of ${target}. A tag is never moved, overwritten or deleted by this workflow: release a new version, or delete that tag deliberately after checking what it points at.`
  };
}

/**
 * Parse the command line. Kept separate so it can be tested without spawning a process.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const args = {
    mode: 'normalize',
    input: null,
    githubEnv: false,
    githubOutput: false,
    tag: null,
    target: null,
    existing: null,
    inHistory: false,
    releaseExists: false,
    releaseState: null,
    releaseJson: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--github-env') args.githubEnv = true;
    else if (arg === '--github-output') args.githubOutput = true;
    else if (arg === '--decide') args.mode = 'decide';
    else if (arg === '--tag') { args.tag = argv[index + 1] ?? null; index += 1; }
    else if (arg === '--target') { args.target = argv[index + 1] ?? null; index += 1; }
    else if (arg === '--existing') { args.existing = argv[index + 1] ?? null; index += 1; }
    else if (arg === '--in-history') { args.inHistory = String(argv[index + 1] ?? '').toLowerCase() === 'true'; index += 1; }
    else if (arg === '--release-exists') { args.releaseExists = String(argv[index + 1] ?? '').toLowerCase() === 'true'; index += 1; }
    else if (arg === '--release-state') { args.releaseState = argv[index + 1] ?? null; index += 1; }
    else if (arg === '--release-json') { args.releaseJson = argv[index + 1] ?? null; index += 1; }
    else if (!arg.startsWith('--') && args.input === null) args.input = arg;
  }
  return args;
}

/**
 * Render key=value lines for `$GITHUB_ENV`. The same lines are valid for `$GITHUB_OUTPUT`.
 * @param {Record<string,string|boolean>} values
 */
export function renderEnv(values) {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('\n');
}

/**
 * Put the values where the workflow can read them.
 *
 * With `--github-env` inside Actions, `$GITHUB_ENV` is the only channel that survives into a
 * later step; printing to the log looks identical and does nothing. Outside Actions the same
 * flag falls back to stdout, so a person can run this and see the answer.
 *
 * `--github-output` writes the same pairs to `$GITHUB_OUTPUT`, because a step's *outputs* are the
 * only channel that can be interpolated into a later step's `with:` — which is how the workflow
 * checks out the tagged commit.
 *
 * @param {string} lines
 * @param {{githubEnv?:boolean, githubOutput?:boolean}} options
 */
export function emit(lines, options = {}) {
  const { githubEnv = typeof options === 'boolean' ? options : false, githubOutput = false } = options;
  const envFile = process.env.GITHUB_ENV;
  const outputFile = process.env.GITHUB_OUTPUT;
  if (githubEnv && envFile) {
    appendFileSync(envFile, `${lines}\n`);
  } else if (!githubOutput || !outputFile) {
    process.stdout.write(`${lines}\n`);
  }
  if (githubOutput && outputFile) {
    appendFileSync(outputFile, `${lines}\n`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.mode === 'decide') {
    if (!args.tag || !args.target) {
      console.error('release-version: --decide needs --tag and --target');
      process.exit(2);
    }
    // A tag the caller could not resolve is passed as an empty string or the literal `none`.
    const existing = args.existing && args.existing !== 'none' ? args.existing : null;

    let release;
    if (args.releaseJson) {
      let raw;
      try {
        raw = readFileSync(args.releaseJson, 'utf8');
      } catch (error) {
        console.error(`release-version: cannot read --release-json ${args.releaseJson}: ${error.message}`);
        process.exit(2);
      }
      try {
        release = readReleaseState(JSON.parse(raw));
      } catch (error) {
        console.error(`release-version: --release-json ${args.releaseJson} is not JSON: ${error.message}`);
        process.exit(2);
      }
    } else if (args.releaseState) {
      release = readReleaseState(args.releaseState);
    } else {
      release = readReleaseState(args.releaseExists ? 'published' : 'none');
    }

    const tagDecision = decideTagAction({
      tag: args.tag,
      target: args.target,
      existing,
      inHistory: args.inHistory,
      releaseState: release.state
    });
    const releaseDecision = tagDecision.action === 'refuse' ? { action: 'refuse', message: '' } : decideRelease(release);

    const values = {
      TAG_ACTION: tagDecision.action,
      TAG_EXISTING: existing ?? 'none',
      RELEASE_ACTION: releaseDecision.action,
      RELEASE_STATE: release.state,
      RELEASE_REF: tagDecision.ref ?? ''
    };
    emit(renderEnv(values), { githubEnv: args.githubEnv, githubOutput: args.githubOutput });

    if (tagDecision.action === 'refuse') {
      console.error(`release-version: ${tagDecision.message}`);
      process.exit(1);
    }
    console.log(tagDecision.message);
    console.log(releaseDecision.message);
    if (release.state === 'draft') {
      console.log(`release-version: the draft is at ${release.url ?? '(no url reported)'} with ${release.assets.length} asset(s).`);
    }
    return;
  }

  const result = normalizeVersion(args.input);
  if (!result.ok) {
    console.error(`release-version: ${result.error}`);
    process.exit(1);
  }
  const env = renderEnv({ VERSION: result.version, TAG: result.tag, PRERELEASE: result.prerelease });
  emit(env, { githubEnv: args.githubEnv, githubOutput: args.githubOutput });
  console.log(`version ${result.version} → tag ${result.tag}`);
}

const invokedDirectly = process.argv[1] && /release-version\.test\.mjs$|release-version\.mjs$/.test(process.argv[1]);
if (invokedDirectly) main();
