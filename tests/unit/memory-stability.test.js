/**
 * Memory stability check (R-08-03).
 *
 * The requirement asked for bandwidth and stability. Bandwidth existed; stability did not, so the
 * requirement stayed partial. These tests hold the new check to the claims it makes:
 *
 *   - it refuses to run without consent, and refuses sizes and pass counts outside the bounds;
 *   - it round-trips a real buffer through the real worker and reports zero mismatches on a
 *     healthy machine — the check itself must not report faults that are not there;
 *   - a mismatch, when one is injected, is reported as a mismatch and never as a PASS;
 *   - "no mismatches" is UNRATED, with the limits of the claim written in the note.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Status } from '../../src/core/status.js';
import {
  MEMORY_STABILITY_LIMITS,
  mapMemoryStabilityResults,
  runMemoryStability,
  validateStabilityOptions
} from '../../src/benchmarking/memory-stability.js';
import { memoryStabilityWorkload } from '../../src/benchmarking/worker.js';

const refusingRunner = (result) => async () => result;

test('consent is required before anything is allocated', () => {
  const refused = validateStabilityOptions({ megabytes: 128, passes: 2 });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /consent/i);
});

test('the buffer size and pass count are bounded', () => {
  assert.equal(validateStabilityOptions({ consentGiven: true, megabytes: 32, passes: 1 }).ok, false);
  assert.equal(validateStabilityOptions({ consentGiven: true, megabytes: 2048, passes: 1 }).ok, false);
  assert.equal(validateStabilityOptions({ consentGiven: true, megabytes: 128, passes: 0 }).ok, false);
  assert.equal(validateStabilityOptions({ consentGiven: true, megabytes: 128, passes: 21 }).ok, false);
  assert.equal(validateStabilityOptions({ consentGiven: true, megabytes: 12.5, passes: 1 }).ok, false);
  assert.equal(validateStabilityOptions({ consentGiven: true, megabytes: 128, passes: 2 }).ok, true);
  // Defaults are inside the bounds and are reported back, not left implicit.
  const defaults = validateStabilityOptions({ consentGiven: true });
  assert.deepEqual(defaults.effective, { megabytes: MEMORY_STABILITY_LIMITS.defaultMegabytes, passes: MEMORY_STABILITY_LIMITS.defaultPasses });
});

test('a refused check says so and produces a failed field, not a zero result', async () => {
  const result = await runMemoryStability({ megabytes: 128, passes: 1, runner: refusingRunner({ ok: true, mismatches: 0, passesCompleted: 1, bytesVerified: 1024 }) });
  assert.equal(result.refused, true);
  assert.equal(result.started, false);
  assert.equal(result.fields.memoryStability.status, Status.ERROR);
  assert.match(result.reason, /consent/i);
});

test('a completed check on a real buffer finds no mismatches and is still UNRATED', async () => {
  const result = await runMemoryStability({ megabytes: 64, passes: 1, consentGiven: true });
  assert.equal(result.started, true);
  assert.equal(result.refused, false);
  assert.equal(result.mismatches, 0, 'the check must not invent faults on healthy memory');
  assert.equal(result.bytesVerified, 64 * 1024 * 1024);

  const field = result.fields.memoryStability;
  assert.equal(field.value, 0);
  assert.equal(field.status, Status.UNRATED, 'zero mismatches is not a pass');
  assert.ok(field.notes.some((note) => /not a clean bill of health/i.test(note)), 'the note must say what zero mismatches does not prove');
  assert.equal(result.fields.verdict.status, Status.UNRATED);
});

test('an injected mismatch is reported as FAIL and the count is kept', async () => {
  const result = await runMemoryStability({
    megabytes: 64,
    passes: 1,
    consentGiven: true,
    runner: refusingRunner({ ok: true, mismatches: 7, passesCompleted: 1, bytesVerified: 64 * 1024 * 1024 })
  });
  const field = result.fields.memoryStability;
  assert.equal(field.value, 7);
  assert.equal(field.status, Status.FAIL);
  assert.ok(field.notes.some((note) => /does not identify which module/i.test(note)), 'the note must not claim attribution it cannot have');
});

test('a cancelled run keeps the cancellation instead of reporting a completed check', async () => {
  const result = await runMemoryStability({ megabytes: 64, passes: 1, consentGiven: true, runner: refusingRunner({ ok: false, cancelled: true }) });
  assert.equal(result.cancelled, true);
  assert.equal(result.passes, 0);
  assert.equal(result.mismatches, null);
  assert.match(result.reason, /cancelled/i);
  assert.equal(result.fields.memoryStability.status, Status.ERROR);
});

test('a worker failure is a failure, not a silent zero', async () => {
  const result = await runMemoryStability({ megabytes: 64, passes: 1, consentGiven: true, runner: refusingRunner({ ok: false, error: 'worker exceeded 60000ms' }) });
  assert.equal(result.mismatches, null);
  assert.match(result.reason, /worker exceeded/);
  assert.equal(result.fields.memoryStability.status, Status.ERROR);
});

test('the workload writes and verifies the whole buffer, pass after pass', async () => {
  const passes = [];
  const result = await memoryStabilityWorkload({ megabytes: 8, passes: 3, onPass: (info) => passes.push(info) });
  assert.equal(result.passesCompleted, 3);
  assert.equal(result.mismatches, 0);
  assert.equal(result.bytesVerified, 8 * 1024 * 1024 * 3);
  assert.deepEqual(passes.map((entry) => entry.pass), [1, 2, 3]);
});

test('the workload stops when asked, and reports only the passes it finished', async () => {
  let seen = 0;
  const result = await memoryStabilityWorkload({ megabytes: 8, passes: 5, shouldStop: () => {
    seen += 1;
    return seen > 6;
  } });
  assert.ok(result.passesCompleted < 5, 'a stopped run must not claim every pass');
  assert.ok(result.passesCompleted >= 0);
});

test('the verdict fields say a stability check has no verdict', () => {
  const fields = mapMemoryStabilityResults({ megabytes: 128, passes: 2, bytesVerified: 128 * 1024 * 1024 * 2, mismatches: 0, durationMs: 900 });
  assert.equal(fields.verdict.status, Status.UNRATED);
  assert.match(fields.verdict.error, /no verdict/);
  assert.equal(fields.memoryStabilityPasses.value, 2);
  assert.equal(fields.memoryStabilityBytes.value, 128 * 1024 * 1024 * 2);
  assert.equal(fields.memoryStabilityDuration.unit, 'ms');
});
