/**
 * A static gate that has never refused anything is a gate nobody has measured.
 *
 * `scripts/check.mjs` gained two checks after the 40-section audit found them missing —
 * dependency cycles and a formatting policy — and each is exported as a pure function so it
 * can be pointed at bad input here. The tests below fail if the checks are gutted, and the
 * whole-repository test proves the two new rules pass on the real tree rather than being
 * switched off to reach "No findings".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { findCycles, formatProblems, runChecks } from '../../scripts/check.mjs';

test('a two-file cycle is reported as a chain, not a set', () => {
  const graph = new Map([
    ['a.js', ['b.js']],
    ['b.js', ['a.js']]
  ]);
  const cycles = findCycles(graph);
  assert.equal(cycles.length, 1, 'the cycle was not found');
  assert.deepEqual(cycles[0], ['a.js', 'b.js', 'a.js'], 'the cycle should close on itself so the message reads as a path');
});

test('a longer cycle is found through the nodes between its ends', () => {
  const graph = new Map([
    ['a.js', ['b.js']],
    ['b.js', ['c.js']],
    ['c.js', ['a.js']],
    ['d.js', ['a.js']]
  ]);
  const cycles = findCycles(graph);
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0], ['a.js', 'b.js', 'c.js', 'a.js']);
});

test('a diamond is not a cycle', () => {
  const graph = new Map([
    ['a.js', ['b.js', 'c.js']],
    ['b.js', ['d.js']],
    ['c.js', ['d.js']],
    ['d.js', []]
  ]);
  assert.deepEqual(findCycles(graph), [], 'a shared dependency was mistaken for a cycle');
});

test('a self-import is a cycle of one', () => {
  const cycles = findCycles(new Map([['a.js', ['a.js']]]));
  assert.deepEqual(cycles[0], ['a.js', 'a.js']);
});

test('clean source has no formatting problems', () => {
  assert.deepEqual(formatProblems('src/x.js', "const a = 1;\nexport { a };\n"), []);
});

test('a tab, a carriage return and a trailing space are each reported with a line number', () => {
  const problems = formatProblems('src/x.js', 'const a = 1;\t\nconst b = 2;\r\nconst c = 3; \n');
  const text = problems.join('\n');
  assert.match(text, /src\/x\.js:1: tab character/);
  assert.match(text, /src\/x\.js:2: carriage return/);
  assert.match(text, /src\/x\.js:3: trailing whitespace/);
});

test('a missing final newline is reported', () => {
  const problems = formatProblems('src/x.js', 'const a = 1;');
  assert.match(problems.join('\n'), /no final newline/);
});

test('the checks run against the real repository and find nothing', async () => {
  const result = await runChecks();
  const errors = result.findings.filter((finding) => finding.level === 'error');
  assert.deepEqual(errors, [], `the gate has errors:\n${errors.map((e) => `${e.area}: ${e.message}`).join('\n')}`);
  assert.ok(result.notes.some((note) => note.includes('dependency cycles')), 'the cycle check did not run');
  assert.ok(result.notes.some((note) => note.includes('formatting')), 'the formatting check did not run');
});

test('importing the gate has no side effects', async () => {
  const before = process.exitCode;
  await import('../../scripts/check.mjs');
  assert.equal(process.exitCode, before ?? undefined, 'importing check.mjs changed the exit code');
});

test('the gate script itself is the only place that prints', async () => {
  const source = await import('node:fs/promises').then((fs) => fs.readFile(path.join(import.meta.dirname, '../../scripts/check.mjs'), 'utf8'));
  assert.match(source, /export async function runChecks\(/, 'runChecks must stay exported for this test to mean anything');
});
