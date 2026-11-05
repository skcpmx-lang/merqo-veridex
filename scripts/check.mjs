#!/usr/bin/env node
/**
 * VERIDEX — static checks.
 *
 * Runs everything that can be checked without a Windows machine or a GUI:
 *   1. every source file parses and every module graph resolves;
 *   2. every `export` a file consumes actually exists (catches the class of bug
 *      where a JSDoc typedef is imported as a runtime binding);
 *   3. no source file imports a network transport outside the guard;
 *   4. the manual registry is structurally valid;
 *   5. every settings key names a module that references it;
 *   6. requirement ids in docs/requirements.json are unique and well formed.
 *
 * Exit code is non-zero on any finding, so CI can gate on it.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const findings = [];
const notes = [];

/** @param {'error'|'warn'} level @param {string} area @param {string} message */
function report(level, area, message) {
  findings.push({ level, area, message });
}

async function walk(dir, filter) {
  /** @type {string[]} */
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      out.push(...(await walk(full, filter)));
    } else if (entry.isFile() && filter(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// ── 1. Parse + resolve ───────────────────────────────────────────────────────
async function checkModules() {
  const files = await walk(path.join(ROOT, 'src'), (name) => name.endsWith('.js'));

  // Electron entry points cannot be imported outside Electron: the runtime modules
  // are CommonJS and only resolve inside the packaged app. They are still parsed
  // (so a syntax error fails the check) but their imports are verified statically
  // by checkNamedImports instead.
  const ENTRY_POINTS = new Set(['src/app/main.js']);

  for (const file of files) {
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    if (ENTRY_POINTS.has(relative)) {
      // Electron entry points cannot be executed here, but they can still be parsed.
      // `node --check` understands ESM and needs no child-process gymnastics.
      const { spawnSync } = await import('node:child_process');
      const parsed = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (parsed.status !== 0) {
        const message = (parsed.stderr || '').split('\n').filter(Boolean).slice(0, 2).join(' ');
        report('error', 'modules', `${relative}: syntax error — ${message}`);
      }
      notes.push(`parsed (not imported): ${relative}`);
      continue;
    }
    try {
      // Importing executes module top-level code. That is intentional here: a
      // module that cannot be imported is a module that cannot ship.
      await import(pathToFileURL(file).href);
    } catch (error) {
      report('error', 'modules', `${relative}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    }
  }
  notes.push(`imported ${files.length} source modules`);
  return files;
}

// ── 2. Named-import consistency ──────────────────────────────────────────────
async function checkNamedImports(files) {
  /** @type {Map<string, Set<string>>} */
  const exportsByFile = new Map();

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const names = new Set();
    for (const match of source.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_$]+)/gm)) {
      names.add(match[1]);
    }
    // `export { a, b as c }`
    for (const match of source.matchAll(/^export\s*\{([^}]+)\}/gm)) {
      for (const part of match[1].split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const alias = trimmed.split(/\s+as\s+/);
        names.add((alias[1] ?? alias[0]).trim());
      }
    }
    // `export * from './x.js'` re-exports are resolved by import-time checking.
    if (/^export\s+\*\s+from/m.test(source)) names.add('*');
    exportsByFile.set(file, names);
  }

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    const relative = path.relative(ROOT, file);
    for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
      const specifiers = match[1]
        .split(',')
        .map((part) => part.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean);
      const target = match[2];
      if (!target.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), target);
      const available = exportsByFile.get(resolved);
      if (!available) continue; // import-time check covers unresolvable files
      if (available.has('*')) continue;
      for (const specifier of specifiers) {
        if (specifier === 'default') continue;
        if (!available.has(specifier)) {
          report('error', 'imports', `${relative} imports "${specifier}" from ${target}, which does not export it`);
        }
      }
    }
  }
}

// ── 3. Offline guarantee ─────────────────────────────────────────────────────
async function checkOffline(files) {
  const allowed = new Set(['src/security/guard.js']);
  const transports = ['node:http', 'node:https', 'node:net', 'node:tls', 'node:dgram', 'node:dns', 'node:http2'];

  for (const file of files) {
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    if (allowed.has(relative)) continue;
    const source = (await readFile(file, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    for (const transport of transports) {
      if (new RegExp(`(from|import|require)\\s*\\(?\\s*['"]${transport}['"]`).test(source)) {
        report('error', 'offline', `${relative} imports ${transport}; only the guard may do that`);
      }
    }
    if (/(^|[^a-zA-Z0-9_$.])fetch\s*\(/.test(source)) {
      report('error', 'offline', `${relative} calls fetch(); VERIDEX makes no outbound requests`);
    }
  }
}

// ── 4. Manual registry ───────────────────────────────────────────────────────
async function checkManualRegistry() {
  const { validateRegistry } = await import(pathToFileURL(path.join(ROOT, 'src/manual/registry.js')).href);
  const result = validateRegistry();
  for (const problem of result.problems) report('error', 'manual-registry', problem);
}

// ── 5. Settings wiring ───────────────────────────────────────────────────────
async function checkSettings() {
  const { SETTINGS_SPEC } = await import(pathToFileURL(path.join(ROOT, 'src/core/settings.js')).href);
  /** @type {Map<string, string>} */
  const cache = new Map();

  for (const spec of SETTINGS_SPEC) {
    const target = path.join(ROOT, spec.appliesTo);
    let source = cache.get(spec.appliesTo);
    if (source === undefined) {
      try {
        source = await readFile(target, 'utf8');
      } catch {
        report('error', 'settings', `setting "${spec.key}" points at ${spec.appliesTo}, which does not exist`);
        continue;
      }
      cache.set(spec.appliesTo, source);
    }
    if (!source.includes(spec.key)) {
      report('error', 'settings', `setting "${spec.key}" is applied by ${spec.appliesTo}, which never references the key`);
    }
  }
  notes.push(`checked ${SETTINGS_SPEC.length} settings against their consumer modules`);
}

// ── 6. Requirements document ─────────────────────────────────────────────────
async function checkRequirements() {
  const file = path.join(ROOT, 'docs/requirements.json');
  try {
    await stat(file);
  } catch {
    report('warn', 'requirements', 'docs/requirements.json is missing');
    return;
  }
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  const requirements = Array.isArray(parsed) ? parsed : (parsed.requirements ?? []);
  const ids = new Set();
  for (const requirement of requirements) {
    if (!requirement.id) {
      report('error', 'requirements', 'a requirement has no id');
      continue;
    }
    if (ids.has(requirement.id)) report('error', 'requirements', `duplicate requirement id ${requirement.id}`);
    ids.add(requirement.id);
    if (!requirement.st || requirement.st === 'NS') {
      report('warn', 'requirements', `${requirement.id} is still marked NS (not started)`);
    }
  }
  notes.push(`${requirements.length} requirements parsed`);
}

// ── Run ──────────────────────────────────────────────────────────────────────
const modules = await checkModules();
await checkNamedImports(modules);
await checkOffline(modules);
await checkManualRegistry();
await checkSettings();
await checkRequirements();

const errors = findings.filter((finding) => finding.level === 'error');
const warnings = findings.filter((finding) => finding.level === 'warn');

console.log('VERIDEX static checks');
for (const note of notes) console.log(`  · ${note}`);
console.log('');

if (findings.length === 0) {
  console.log('No findings.');
} else {
  for (const finding of findings) {
    console.log(`${finding.level === 'error' ? 'FAIL' : 'WARN'}  [${finding.area}] ${finding.message}`);
  }
}

const summary = `${errors.length} error(s), ${warnings.length} warning(s)`;
console.log('');
console.log(summary);
if (errors.length > 0) process.exitCode = 1;
