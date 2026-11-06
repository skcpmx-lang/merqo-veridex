/**
 * Driver export.
 *
 * The feature is a copy operation, and the risk is not corruption — it is the user believing they
 * hold a backup that can be restored. So the tests below check the arithmetic of space, the
 * refusal of unsafe destinations, the honesty of a partial export, and the fact that every
 * message says what the folder is and is not.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planExport,
  describeExport,
  verifyExport,
  exportFolderName,
  formatBytes,
  EXPORT_PROMISE,
  FREE_SPACE_MARGIN_BYTES,
  BYTES_PER_DRIVER_ESTIMATE
} from '../../src/app/driver-export.js';

const NOW = new Date('2026-03-04T09:05:07');

// ── Planning ───────────────────────────────────────────────────────────────

test('an export goes into a fresh, sortable subfolder of the chosen destination', () => {
  assert.equal(exportFolderName(NOW), 'VERIDEX-drivers-2026-03-04-090507');

  const plan = planExport({ destination: 'D:\\Backups', driverCount: 40, freeBytes: 50 * 1024 * 1024 * 1024, now: NOW });
  assert.equal(plan.ok, true);
  assert.equal(plan.folder, 'VERIDEX-drivers-2026-03-04-090507');
  assert.equal(plan.path, 'D:\\Backups\\VERIDEX-drivers-2026-03-04-090507');
  // Never the destination itself: an export must not mix with whatever is already there.
  assert.notEqual(plan.path, 'D:\\Backups');
});

test('no destination and a drive root are both refused', () => {
  assert.equal(planExport({}).code, 'no_destination');
  assert.equal(planExport({ destination: '   ' }).code, 'no_destination');
  assert.equal(planExport({ destination: null }).code, 'no_destination');

  // A drive root would put the export folder beside the whole file system.
  const root = planExport({ destination: 'D:\\', driverCount: 10, freeBytes: 10 * 1024 * 1024 * 1024, now: NOW });
  assert.equal(root.code, 'root_destination');
});

test('insufficient space is refused before anything is written', () => {
  const tight = planExport({ destination: 'C:\\tiny', driverCount: 100, freeBytes: 500 * 1024 * 1024, now: NOW });
  assert.equal(tight.ok, false);
  assert.equal(tight.code, 'not_enough_space');
  assert.match(tight.reason, /Nothing was written/);
  // The message must give the reader both numbers, not just "not enough space".
  assert.match(tight.reason, /GB|MB/);

  const none = planExport({ destination: 'C:\\tiny', freeBytes: 10 * 1024 * 1024, now: NOW });
  assert.equal(none.code, 'no_space');

  const roomy = planExport({ destination: 'C:\\big', driverCount: 100, freeBytes: 8 * 1024 * 1024 * 1024, now: NOW });
  assert.equal(roomy.ok, true);
  assert.ok(roomy.estimateBytes >= 100 * BYTES_PER_DRIVER_ESTIMATE);
  assert.equal(roomy.marginBytes, FREE_SPACE_MARGIN_BYTES);
});

test('an unknown free-space figure does not block the export', () => {
  const plan = planExport({ destination: 'D:\\Backups', driverCount: 12, freeBytes: null, now: NOW });
  assert.equal(plan.ok, true, 'a missing measurement is not a reason to refuse');
});

// ── Outcomes ───────────────────────────────────────────────────────────────

test('a successful export reports the count and repeats what it is not', () => {
  const described = describeExport({
    folder: 'VERIDEX-drivers-2026-03-04-090507',
    infFiles: ['a.inf', 'b.inf', 'c.inf'],
    pnputilExitCode: 0
  });
  assert.equal(described.ok, true);
  assert.equal(described.packageCount, 3);
  assert.match(described.reason, /3 driver packages/);
  assert.match(described.statement, /not a restore point/i);
  assert.match(described.statement, /installs, updates or removes/i);
});

test('a partial export is reported as partial and never as complete', () => {
  const cancelled = describeExport({ folder: 'X', infFiles: ['a.inf'], pnputilExitCode: 0, cancelled: true });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.code, 'cancelled');
  assert.match(cancelled.reason, /partial/i);

  const timedOut = describeExport({ folder: 'X', infFiles: ['a.inf', 'b.inf'], pnputilExitCode: null, timedOut: true });
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.reason, /partial export/);

  const failed = describeExport({ folder: 'X', infFiles: ['a.inf'], pnputilExitCode: 3 });
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /code 3/);
  assert.match(failed.reason, /incomplete/i);
});

test('success with nothing on disk is not an export', () => {
  const empty = describeExport({ folder: 'X', infFiles: [], pnputilExitCode: 0 });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'empty');
  assert.match(empty.reason, /no export is claimed/i);
});

test('cancelling before anything is copied says nothing was left behind', () => {
  const early = describeExport({ folder: 'X', infFiles: [], pnputilExitCode: 0, cancelled: true });
  assert.equal(early.ok, false);
  assert.match(early.reason, /before any package/i);
  assert.match(early.reason, /Nothing was left behind/i);
});

// ── Verification ───────────────────────────────────────────────────────────

test('the folder is verified against what pnputil claimed', () => {
  const match = verifyExport({ expected: 2, infFiles: ['a.inf', 'b.inf'] });
  assert.equal(match.ok, true);
  assert.match(match.reason, /matching what pnputil reported/);

  const mismatch = verifyExport({ expected: 5, infFiles: ['a.inf'] });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.reason, /cannot be confirmed complete/i);

  const none = verifyExport({ expected: 0, infFiles: [] });
  assert.equal(none.ok, false);
  assert.match(none.reason, /No \.inf file/);
});

// ── The promise, in one place ──────────────────────────────────────────────

test('the export promise names both directions: what it does and what it cannot do', () => {
  assert.match(EXPORT_PROMISE, /copies the driver packages/i);
  assert.match(EXPORT_PROMISE, /changes nothing/i);
  assert.match(EXPORT_PROMISE, /cannot restore/i);
  assert.match(EXPORT_PROMISE, /does not install, update or remove/i);
});

test('byte sizes are readable and never negative', () => {
  assert.equal(formatBytes(0), '0 bytes');
  assert.equal(formatBytes(1024), '1 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 * 1024 * 1024), '5 GB');
  assert.equal(formatBytes(-1), 'an unknown amount of');
  assert.equal(formatBytes(Number.NaN), 'an unknown amount of');
});
