#!/usr/bin/env node
/**
 * One authority for what a release version is.
 *
 * This file exists because the release workflow guessed, and guessed wrongly twice:
 *
 *   1. `if (git rev-parse "v$version") { throw 'already exists' }` threw on **every** run.
 *      `git rev-parse v1.0.0` prints `v1.0.0` to stdout even when it cannot resolve it (that
 *      echo-back is documented git behaviour), so the PowerShell `if` saw a truthy string and
 *      the guard fired on a repository that had no tags at all. The workflow never reached its
 *      first build.
 *   2. Nothing normalised the input. The field says "without the leading v", a person typed
 *      `v1.0.0`, the workflow prefixed another one, and the message said `vv1.0.0`.
 *
 * Both failures are arithmetic on a string, so the arithmetic lives here, in one place, with
 * tests, and the workflow only calls it:
 *
 *   node scripts/release-version.mjs 1.0.0 --github-env     # → VERSION, TAG
 *   node scripts/release-version.mjs --decide --target <sha> --existing <sha|none> \
 *        --release-exists <true|false> --github-env          # → TAG_ACTION
 *
 * Nothing here touches git, the network or a file; it takes what the caller observed and says
 * what may be done with it. The decisions are deliberately conservative: a tag on another commit
 * is never moved, and an existing release is never duplicated.
 */

import { appendFileSync } from 'node:fs';

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
 * What may be done with an observed repository state.
 *
 * The caller supplies what it actually saw — never what it hopes to see — and gets one of three
 * answers. A missing observation (`existing: null`) means "no tag", and must be produced by a
 * check that can tell the difference; see the workflow, which uses `git rev-parse --verify`.
 *
 * @param {object} state
 * @param {string} state.tag                 canonical tag, from normalizeVersion
 * @param {string} state.target              the commit this run intends to release
 * @param {string|null} [state.existing]     commit the tag points at, or null when there is no tag
 * @param {boolean} [state.releaseExists]    whether a GitHub Release for the tag already exists
 * @returns {{action:'create'|'reuse', message:string} | {action:'refuse', message:string}}
 */
export function decideTagAction(state) {
  const { tag, target, existing = null, releaseExists = false } = state;
  // Abbreviated SHAs are accepted in either direction: `git rev-parse` returns a full hash and
  // `GITHUB_SHA` is one too, but a test or a person may supply `e3f6cc9`.
  const left = String(existing ?? '').trim().toLowerCase();
  const right = String(target ?? '').trim().toLowerCase();
  const sameCommit = Boolean(left) && Boolean(right) && (left === right || left.startsWith(right) || right.startsWith(left));

  if (releaseExists) {
    return {
      action: 'refuse',
      message: `a GitHub Release for ${tag} already exists. Publishing again would duplicate it. Delete or edit that release deliberately, or release a new version.`
    };
  }

  if (!existing) {
    return { action: 'create', message: `no ${tag} tag exists; it will be created on ${target}.` };
  }

  if (sameCommit) {
    return {
      action: 'reuse',
      message: `${tag} already exists and points at this commit (${existing}); the tag will be reused, not moved.`
    };
  }

  return {
    action: 'refuse',
    message: `${tag} already exists and points at ${existing}, not at ${target}. A tag is never moved, overwritten or deleted by this workflow: release a new version, or delete that tag deliberately after checking what it points at.`
  };
}

/**
 * Parse the command line. Kept separate so it can be tested without spawning a process.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const args = { mode: 'normalize', input: null, githubEnv: false, tag: null, target: null, existing: null, releaseExists: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--github-env') args.githubEnv = true;
    else if (arg === '--decide') args.mode = 'decide';
    else if (arg === '--tag') { args.tag = argv[index + 1] ?? null; index += 1; }
    else if (arg === '--target') { args.target = argv[index + 1] ?? null; index += 1; }
    else if (arg === '--existing') { args.existing = argv[index + 1] ?? null; index += 1; }
    else if (arg === '--release-exists') { args.releaseExists = String(argv[index + 1] ?? '').toLowerCase() === 'true'; index += 1; }
    else if (!arg.startsWith('--') && args.input === null) args.input = arg;
  }
  return args;
}

/**
 * Render key=value lines for `$GITHUB_ENV`.
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
 * @param {string} lines
 * @param {boolean} githubEnv
 */
export function emit(lines, githubEnv) {
  const file = process.env.GITHUB_ENV;
  if (githubEnv && file) {
    appendFileSync(file, `${lines}\n`);
    return;
  }
  process.stdout.write(`${lines}\n`);
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
    const decision = decideTagAction({ tag: args.tag, target: args.target, existing, releaseExists: args.releaseExists });
    const env = renderEnv({ TAG_ACTION: decision.action, TAG_EXISTING: existing ?? 'none' });
    emit(env, args.githubEnv);
    if (decision.action === 'refuse') {
      console.error(`release-version: ${decision.message}`);
      process.exit(1);
    }
    console.log(decision.message);
    return;
  }

  const result = normalizeVersion(args.input);
  if (!result.ok) {
    console.error(`release-version: ${result.error}`);
    process.exit(1);
  }
  const env = renderEnv({ VERSION: result.version, TAG: result.tag, PRERELEASE: result.prerelease });
  emit(env, args.githubEnv);
  console.log(`version ${result.version} → tag ${result.tag}`);
}

const invokedDirectly = process.argv[1] && /release-version\.test\.mjs$|release-version\.mjs$/.test(process.argv[1]);
if (invokedDirectly) main();
