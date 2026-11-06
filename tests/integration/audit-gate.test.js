/**
 * The requirement audit must actually refuse a claim it cannot support.
 *
 * Every milestone in this project reports "the audit passes". That sentence is only worth
 * something if the audit has been observed failing, so this file makes it fail on purpose:
 * a tested requirement with no test, an implemented one pointing at a missing file, a verified
 * one with no machine on record, and a blocked one with no reason.
 *
 * `--json` and `--md` exist for this test. CI never passes them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts/audit-requirements.mjs');

async function runAudit(mutate) {
  const dir = await mkdtemp(path.join(tmpdir(), 'veridex-audit-'));
  try {
    const data = JSON.parse(await readFile(path.join(ROOT, 'docs/requirements.json'), 'utf8'));
    const target = data.requirements.find((entry) => entry.st === 'TS');
    mutate(data, target);
    const jsonPath = path.join(dir, 'requirements.json');
    await writeFile(jsonPath, JSON.stringify(data, null, 2), 'utf8');
    return spawnSync(process.execPath, [SCRIPT, '--check', '--json', jsonPath, '--md', path.join(dir, 'REQUIREMENTS.md')], {
      cwd: ROOT,
      encoding: 'utf8'
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('the audit passes on the repository as it stands', async () => {
  const result = await runAudit(() => {});
  assert.equal(result.status, 0, `the audit failed on the real data:\n${result.stdout}${result.stderr}`);
});

test('a tested requirement with no test file is refused', async () => {
  const result = await runAudit((data, target) => {
    target.test = 'tests/unit/this-test-does-not-exist.test.js';
  });
  assert.equal(result.status, 1, 'the audit accepted a test path that does not exist');
  assert.match(`${result.stdout}${result.stderr}`, /does not exist/);
});

test('an implemented requirement pointing at missing code is refused', async () => {
  const result = await runAudit((data, target) => {
    target.impl = 'src/does-not-exist.js';
  });
  assert.equal(result.status, 1, 'the audit accepted an implementation that does not exist');
});

test('a requirement claimed verified without a machine on record is refused', async () => {
  const result = await runAudit((data, target) => {
    target.st = 'VER';
    delete target.verifiedOn;
  });
  assert.equal(result.status, 1, 'the audit accepted VERIFIED with no evidence');
  assert.match(`${result.stdout}${result.stderr}`, /verifiedOn/);
});

test('a blocked requirement with no reason is refused', async () => {
  const result = await runAudit((data, target) => {
    target.st = 'BL';
    delete target.blockedBy;
  });
  assert.equal(result.status, 1, 'the audit accepted BLOCKED with no reason');
  assert.match(`${result.stdout}${result.stderr}`, /blockedBy/);
});

test('a duplicated requirement id is refused', async () => {
  const result = await runAudit((data, target) => {
    data.requirements.push({ ...target });
  });
  assert.equal(result.status, 1, 'the audit accepted a duplicate id');
  assert.match(`${result.stdout}${result.stderr}`, /duplicate id/);
});
