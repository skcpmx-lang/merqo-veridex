#!/usr/bin/env node
/**
 * VERIDEX — dependency licence audit.
 *
 * R-26-01 asks for "zero paid dependencies" and offline operation. The offline half was already
 * enforced by a test that walks the source for transports; the licence half was a sentence in
 * SECURITY.md and nothing more. A sentence is not a check: a dependency can be added in a pull
 * request whose licence makes the shipped product undistributable, and nothing in the build
 * would notice.
 *
 * This script reads the resolved dependency tree (package-lock.json), looks up each package's
 * declared licence in its own package.json, and fails when:
 *
 *   - a package declares no licence at all, or an empty one;
 *   - a package declares a licence that is not on the allowlist;
 *   - a strong-copyleft licence (GPL/AGPL/SSPL) appears in a **runtime** dependency, which would
 *     affect the distributed binary rather than only the build machine.
 *
 * Dev-only copyleft is reported as a warning rather than an error: it never ships. Nothing is
 * inferred from a registry, because the audit has to work offline, which is the same constraint
 * the product runs under.
 *
 * Usage:
 *   node scripts/licence-audit.mjs            # human-readable
 *   node scripts/licence-audit.mjs --json     # machine-readable, for a test
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/** Licences this project accepts for code that ships. */
export const ALLOWED = Object.freeze([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'CC0-1.0',
  'Unlicense',
  'BlueOak-1.0.0',
  'Python-2.0',
  'MIT-0',
  'Zlib',
  // Not OSI-recognised, but permissive and public-domain-equivalent: it grants every right and
  // disclaims warranty. Reviewed for shipping on 2026-11-06.
  'WTFPL'
]);

/**
 * Packages whose licence cannot be read from the package itself.
 *
 * An undeclared licence is a real problem, not a formatting detail, so it stays an error unless
 * it is listed here with a stated reason and a source. The entry downgrades the finding to a
 * warning; it does not silence it. Anything added to this table must say where the fact came
 * from, or the next reader has no way to check it.
 */
export const EXCEPTIONS = Object.freeze({
  'png-js': {
    reason: 'The published package.json declares no licence field. The upstream repository states MIT in its README and LICENSE, and it is a transitive dependency of pdfkit that ships inside the report renderer.',
    source: 'https://github.com/foliojs/png.js — README "License: MIT"',
    reviewed: '2026-11-06'
  }
});

/** Licences that must never ship inside a closed, unsigned diagnostic build. */
export const FORBIDDEN_RUNTIME = Object.freeze(['GPL-2.0', 'GPL-3.0', 'AGPL-3.0', 'SSPL-1.0', 'CPAL-1.0', 'EUPL-1.2']);

/**
 * Normalise a `license` field, which npm packages write in several shapes.
 *
 * `"MIT"`, `"MIT OR Apache-2.0"`, `"(MIT AND Zlib)"` and `{ "type": "MIT" }` all occur in the
 * wild. The audit does not try to evaluate SPDX expressions properly: it splits on `OR` and
 * accepts the package if **any** branch is allowlisted, because a dual licence is a choice the
 * consumer may exercise. `AND` is stricter — every term must be allowed.
 *
 * @param {unknown} value
 * @returns {{raw: string, ids: string[], kind: 'single'|'or'|'and'|'none'}}
 */
export function readLicence(value) {
  const raw = typeof value === 'string' ? value : (value && typeof value === 'object' && 'type' in value ? String(value.type ?? '') : '');
  const trimmed = raw.trim();
  if (!trimmed) return { raw: '', ids: [], kind: 'none' };

  const strip = (text) => text.replace(/[()]/g, ' ').trim();
  const upper = trimmed.toUpperCase();
  if (/\sOR\s/.test(upper)) {
    return { raw: trimmed, ids: strip(trimmed).split(/\s+OR\s+/i).map((part) => part.trim()).filter(Boolean), kind: 'or' };
  }
  if (/\sAND\s/.test(upper)) {
    return { raw: trimmed, ids: strip(trimmed).split(/\s+AND\s+/i).map((part) => part.trim()).filter(Boolean), kind: 'and' };
  }
  // "MIT*", "SEE LICENSE IN LICENSE" and version suffixes such as "GPL-3.0-or-later".
  const single = strip(trimmed).replace(/\*$/, '').trim();
  return { raw: trimmed, ids: [single], kind: 'single' };
}

/** Does a licence id match an entry in one of the lists, allowing `-or-later` suffixes? */
export function matches(id, list) {
  // SPDX suffixes carry the same base licence: `GPL-3.0`, `GPL-3.0-only` and `GPL-3.0-or-later`
  // are the same terms for the question this audit asks.
  const normalised = String(id).replace(/\+$/, '').replace(/-(only|or-later)$/i, '').toLowerCase();
  return list.some((entry) => entry.toLowerCase() === normalised);
}

/**
 * Classify one package.
 *
 * @param {{name: string, version: string, license?: unknown, dev?: boolean}} pkg
 * @returns {{name: string, version: string, dev: boolean, licence: string, level: 'ok'|'warn'|'error', reason: string|null}}
 */
export function classify(pkg) {
  const parsed = readLicence(pkg.license);
  const base = { name: pkg.name, version: pkg.version, dev: Boolean(pkg.dev), licence: parsed.raw || '(none declared)' };

  if (parsed.kind === 'none') {
    const exception = EXCEPTIONS[pkg.name];
    return exception
      ? { ...base, level: 'warn', reason: `no licence is declared in the package; accepted with a recorded exception (${exception.source}, reviewed ${exception.reviewed}): ${exception.reason}` }
      : { ...base, level: 'error', reason: 'no licence is declared, so its terms are unknown' };
  }

  const forbidden = parsed.ids.filter((id) => matches(id, FORBIDDEN_RUNTIME));
  if (forbidden.length > 0) {
    return parsed.kind === 'or'
      ? { ...base, level: 'ok', reason: `dual-licensed; the allowlisted branch may be taken (${parsed.ids.join(' OR ')})` }
      : {
          ...base,
          level: pkg.dev ? 'warn' : 'error',
          reason: pkg.dev
            ? `${forbidden.join(', ')} is a build-only dependency and never ships, but it must be reviewed before it becomes runtime`
            : `${forbidden.join(', ')} cannot be shipped in this build`
        };
  }

  const allowed = parsed.kind === 'and' ? parsed.ids.every((id) => matches(id, ALLOWED)) : parsed.ids.some((id) => matches(id, ALLOWED));
  if (!allowed) {
    const exception = EXCEPTIONS[pkg.name];
    return exception
      ? { ...base, level: 'warn', reason: `accepted with a recorded exception (${exception.source}, reviewed ${exception.reviewed}): ${exception.reason}` }
      : { ...base, level: 'error', reason: `${parsed.raw} is not on the allowlist (${ALLOWED.join(', ')})` };
  }
  return { ...base, level: 'ok', reason: parsed.kind === 'or' ? `dual-licensed (${parsed.raw})` : null };
}

/**
 * Walk the resolved tree in package-lock.json.
 *
 * The lockfile records the whole tree with a `dev` flag per entry, which is what decides whether
 * a package ships. Reading `node_modules` instead would miss platforms whose optional binaries
 * are not installed here.
 *
 * @param {any} lock
 * @returns {Array<{name: string, version: string, dev: boolean, license?: unknown}>}
 */
export function packagesFromLock(lock) {
  const packages = lock?.packages ?? {};
  const out = [];
  for (const [key, entry] of Object.entries(packages)) {
    if (!key || key === '') continue; // the root project
    const name = entry.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (!name) continue;
    out.push({ name, version: entry.version ?? '0.0.0', dev: Boolean(entry.dev), license: entry.license });
  }
  return out;
}

/**
 * Fill in licences the lockfile does not carry.
 *
 * npm writes `license` into newer lockfiles but not all of them, so the audit falls back to the
 * installed package's own package.json. A package that is neither in the lock nor on disk is
 * reported as unknown rather than skipped.
 *
 * @param {Array<{name: string, version: string, dev: boolean, license?: unknown}>} packages
 */
export async function resolveLicences(packages) {
  const resolved = [];
  for (const pkg of packages) {
    if (pkg.license !== undefined && pkg.license !== null && String(pkg.license).trim() !== '') {
      resolved.push(pkg);
      continue;
    }
    const file = path.join(ROOT, 'node_modules', ...pkg.name.split('/'), 'package.json');
    try {
      const manifest = JSON.parse(await readFile(file, 'utf8'));
      resolved.push({ ...pkg, license: manifest.license ?? manifest.licenses ?? null });
    } catch {
      resolved.push({ ...pkg, license: null });
    }
  }
  return resolved;
}

/**
 * Run the audit over a lockfile object.
 * @param {any} lock
 */
export async function auditLock(lock) {
  const packages = await resolveLicences(packagesFromLock(lock));
  const results = packages.map(classify);
  const errors = results.filter((result) => result.level === 'error');
  const warnings = results.filter((result) => result.level === 'warn');

  const counts = new Map();
  for (const result of results) counts.set(result.licence, (counts.get(result.licence) ?? 0) + 1);

  return {
    total: results.length,
    runtime: results.filter((result) => !result.dev).length,
    dev: results.filter((result) => result.dev).length,
    licences: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([licence, count]) => ({ licence, count })),
    errors,
    warnings,
    results
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const json = process.argv.includes('--json');
  let lock;
  try {
    lock = JSON.parse(await readFile(path.join(ROOT, 'package-lock.json'), 'utf8'));
  } catch (error) {
    console.error(`licence audit: package-lock.json could not be read: ${error.message}`);
    process.exitCode = 1;
    lock = null;
  }

  if (lock) {
    const report = await auditLock(lock);
    if (json) {
      console.log(JSON.stringify({
        total: report.total,
        runtime: report.runtime,
        dev: report.dev,
        licences: report.licences,
        errors: report.errors,
        warnings: report.warnings
      }, null, 2));
    } else {
      console.log('VERIDEX dependency licences');
      console.log(`  ${report.total} packages: ${report.runtime} runtime, ${report.dev} build-only`);
      for (const { licence, count } of report.licences) console.log(`  ${String(count).padStart(4)}  ${licence}`);
      for (const warning of report.warnings) console.log(`WARN  ${warning.name}@${warning.version}: ${warning.reason}`);
      for (const error of report.errors) console.log(`FAIL  ${error.name}@${error.version}: ${error.reason}`);
      console.log('');
      console.log(`${report.errors.length} error(s), ${report.warnings.length} warning(s)`);
    }
    if (report.errors.length > 0) process.exitCode = 1;
  }
}
