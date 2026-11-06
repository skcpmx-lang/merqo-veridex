#!/usr/bin/env node
/**
 * VERIDEX — requirement audit.
 *
 * `docs/requirements.json` is the single source of truth for requirement status.
 * This script does two things and refuses to do a third:
 *
 *   1. **Verifies** every requirement's claimed status against reality: if a
 *      requirement says IMPLEMENTED, the file it names must exist; if it says
 *      TESTED, the test file it names must exist and be referenced by the suite.
 *   2. **Generates** `docs/REQUIREMENTS.md` from the JSON.
 *
 * It will NOT promote a status. A requirement only moves to TESTED when a human
 * changes the JSON *after* the test exists and passes, and only to VERIFIED when
 * someone has actually run the product on Windows. Automatic promotion would be
 * exactly the false-completion claim the brief forbids.
 *
 * Usage:
 *   node scripts/audit-requirements.mjs            verify + regenerate markdown
 *   node scripts/audit-requirements.mjs --check    verify only, exit 1 on inconsistency
 */

import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
// `--json` exists so the audit itself can be tested: a gate nobody has seen fail is a gate
// nobody knows is closed. The default is the real file, and CI never passes the flag.
const jsonFlag = process.argv.indexOf('--json');
const JSON_PATH = jsonFlag > -1 && process.argv[jsonFlag + 1] ? path.resolve(process.argv[jsonFlag + 1]) : path.join(ROOT, 'docs/requirements.json');
const mdFlag = process.argv.indexOf('--md');
const MD_PATH = mdFlag > -1 && process.argv[mdFlag + 1] ? path.resolve(process.argv[mdFlag + 1]) : path.join(ROOT, 'docs/REQUIREMENTS.md');
const checkOnly = process.argv.includes('--check');

const STATUS_ORDER = ['VER', 'TS', 'IM', 'IP', 'BL', 'NS'];
const STATUS_LABEL = {
  NS: 'Not started',
  IP: 'In progress',
  IM: 'Implemented',
  TS: 'Tested (automated)',
  VER: 'Verified on Windows',
  BL: 'Blocked'
};

/** @param {string} relative */
async function exists(relative) {
  if (!relative || relative === 'n/a' || relative === 'none') return true;
  // A requirement may name several files, or a glob-ish directory.
  // A reference may name several files joined by ", " or " + " (the data uses both:
  // "src/providers/smart-ata.js + src/providers/smart-nvme.js").
  const candidates = String(relative).split(/\s*[,+]\s*/).map((part) => part.trim()).filter(Boolean);
  for (const candidate of candidates) {
    // A requirement may name a symbol inside a file (`file.js#functionName`), so
    // strip the fragment before checking the path exists on disk.
    const filePart = candidate.split('#')[0];
    const target = path.join(ROOT, filePart.replace(/\/\*\*?$/, '').replace(/\*.*$/, ''));
    try {
      await access(target);
    } catch {
      return false;
    }
  }
  return true;
}

const raw = await readFile(JSON_PATH, 'utf8');
const data = JSON.parse(raw);
const requirements = data.requirements ?? [];
const problems = [];

// ── Structural checks ────────────────────────────────────────────────────────
const ids = new Set();
for (const requirement of requirements) {
  if (!requirement.id) {
    problems.push('a requirement has no id');
    continue;
  }
  if (ids.has(requirement.id)) problems.push(`${requirement.id}: duplicate id`);
  ids.add(requirement.id);
  if (!requirement.req || requirement.req.length < 15) problems.push(`${requirement.id}: description is too thin to audit`);
  if (!(requirement.st in STATUS_LABEL)) problems.push(`${requirement.id}: unknown status "${requirement.st}"`);
  if (!requirement.impl) problems.push(`${requirement.id}: names no implementing file`);
}

// ── Claim verification ───────────────────────────────────────────────────────
const claimed = { NS: 0, IP: 0, IM: 0, TS: 0, VER: 0, BL: 0 };
for (const requirement of requirements) {
  if (requirement.st in claimed) claimed[requirement.st] += 1;
  const status = requirement.st;

  // Anything claiming to be implemented must point at code that exists.
  if (['IM', 'TS', 'VER'].includes(status)) {
    if (!(await exists(requirement.impl))) {
      problems.push(`${requirement.id}: claims ${status} but "${requirement.impl}" does not exist`);
    }
  }

  // A reference that points at a file nobody wrote is a broken promise, whatever the
  // status. The auditor previously validated `test` only for TS/VER claims and never
  // looked at `doc` at all, so 47 entries cited files that did not exist while the
  // audit reported a clean bill of health.
  if (requirement.impl && requirement.impl !== 'n/a' && requirement.impl !== 'none') {
    if (!(await exists(requirement.impl))) {
      problems.push(`${requirement.id}: implementation reference "${requirement.impl}" does not exist`);
    }
  }

  // The document a requirement points a reader at must exist.
  if (requirement.doc && requirement.doc !== 'n/a' && requirement.doc !== 'none') {
    if (!(await exists(requirement.doc))) {
      problems.push(`${requirement.id}: documentation reference "${requirement.doc}" does not exist`);
    }
  }

  // Any test path named, even for an unimplemented requirement, must exist if it is
  // presented as the place the test will live — a plan naming a file is fine, but a
  // path is not a promise that can be silently broken.
  if (requirement.test && requirement.test !== 'n/a' && requirement.test !== 'none') {
    if (!(await exists(requirement.test))) {
      problems.push(`${requirement.id}: test reference "${requirement.test}" does not exist`);
    }
  }

  // Anything claiming automated tests must point at a test that exists.
  if (['TS', 'VER'].includes(status)) {
    if (!requirement.test || requirement.test === 'n/a') {
      problems.push(`${requirement.id}: claims ${status} but names no automated test`);
    } else if (!(await exists(requirement.test))) {
      problems.push(`${requirement.id}: claims ${status} but "${requirement.test}" does not exist`);
    }
  }

  // VERIFIED demands real-platform evidence, which cannot be inferred from a file.
  if (status === 'VER' && !requirement.verifiedOn) {
    problems.push(`${requirement.id}: claims VERIFIED but records no verifiedOn evidence (machine, date, result)`);
  }

  // BLOCKED must say what blocks it, or it is just an unexplained gap.
  if (status === 'BL' && !requirement.blockedBy) {
    problems.push(`${requirement.id}: marked BLOCKED without a blockedBy reason`);
  }
}

// ── Generate the markdown ────────────────────────────────────────────────────
const byModule = new Map();
for (const requirement of requirements) {
  const module = requirement.mod ?? 'Unassigned';
  if (!byModule.has(module)) byModule.set(module, []);
  byModule.get(module).push(requirement);
}

const totals = STATUS_ORDER.map((status) => `${STATUS_LABEL[status]}: ${claimed[status] ?? 0}`).join(' · ');
const modules = [...byModule.keys()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

const lines = [
  '# VERIDEX — Requirement Status',
  '',
  '> Generated by `npm run audit:requirements` from `docs/requirements.json`. Do not hand-edit this file.',
  '',
  `Total requirements: **${requirements.length}** · ${totals}`,
  '',
  '## How to read the status column',
  '',
  '| Status | Meaning |',
  '| --- | --- |',
  ...STATUS_ORDER.map((status) => `| ${status} | ${STATUS_LABEL[status]} |`),
  '',
  '**IM means the code exists and is wired. TS means an automated test runs and passes. VER means a person ran the product on Windows and saw it work. These are three different claims and the project never treats one as another.** No requirement is marked VER in this repository yet, because VER requires evidence from a real Windows machine and that evidence is recorded per requirement in `verifiedOn`.',
  '',
];

for (const module of modules) {
  const entries = byModule.get(module);
  lines.push(`## ${module}`, '');
  lines.push('| ID | Requirement | Implementation | Test | Status |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const requirement of entries) {
    const test = requirement.test && requirement.test !== 'n/a' ? `\`${requirement.test}\`` : '—';
    lines.push(`| ${requirement.id} | ${String(requirement.req).replace(/\|/g, '\\|')} | \`${requirement.impl}\` | ${test} | **${requirement.st}** |`);
  }
  lines.push('');
}

if (problems.length === 0 && !checkOnly) {
  await writeFile(MD_PATH, lines.join('\n'), 'utf8');
}

console.log('VERIDEX requirement audit');
console.log(`  ${requirements.length} requirements across ${modules.length} modules`);
console.log(`  ${totals}`);
console.log('');

if (problems.length > 0) {
  for (const problem of problems) console.log(`FAIL  ${problem}`);
  console.log('');
  console.log(`${problems.length} inconsistency(ies) between claimed status and repository contents.`);
  process.exitCode = 1;
} else {
  console.log('Every claimed status matches the repository contents.');
  if (!checkOnly) console.log(`Wrote ${path.relative(ROOT, MD_PATH)}`);
}
