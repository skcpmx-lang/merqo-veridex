import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';

import { runDiskBenchmark, bytesFor, checkFreeSpace, BLOCK_SIZE, FREE_SPACE_FACTOR } from '../../src/benchmarking/disk-bench.js';
import { Status } from '../../src/core/status.js';

test('test size is rounded to whole blocks so timing is not distorted', () => {
  assert.equal(bytesFor(1) % BLOCK_SIZE, 0);
  assert.ok(bytesFor(32) >= 32 * 1024 * 1024);
  assert.ok(bytesFor(0.01) >= BLOCK_SIZE, 'a tiny request still yields one full block');
});

test('free-space check requires headroom so a full disk is never put at risk', async () => {
  const ok = await checkFreeSpace(tmpdir(), 1024 * 1024);
  assert.equal(ok.ok, true);
  assert.ok(ok.freeBytes > 0);
  assert.equal(ok.requiredBytes, 1024 * 1024 * FREE_SPACE_FACTOR);

  const absurd = await checkFreeSpace(tmpdir(), 1024 ** 5);
  assert.equal(absurd.ok, false);
  assert.match(absurd.reason, /required/);
  assert.match(absurd.reason, /never put at risk/);
});

test('the disk benchmark writes only to a fresh temp directory and always cleans up', async () => {
  const { fields, cleanup } = await runDiskBenchmark({ sizeMb: 32, allowWrite: true });
  assert.ok(cleanup.path.includes('veridex-bench-'));
  assert.equal(cleanup.removed, true, 'the temporary directory must be removed');
  assert.equal(fields.cleanup.status, Status.PASS);
  assert.ok(fields.sequentialWrite.value > 0);
  assert.equal(fields.sequentialWrite.unit, 'MB/s');
  assert.ok(fields.sequentialRead.value > 0);
  assert.ok(fields.randomReadIops.value > 0);
  assert.equal(fields.randomReadIops.unit, 'IOPS');
  assert.ok(fields.randomReadLatency.value >= 0);
});

test('write throughput documents that it includes a device flush', async () => {
  const { fields } = await runDiskBenchmark({ sizeMb: 32, allowWrite: true });
  assert.ok(fields.sequentialWrite.notes.some((note) => note.includes('fsync')));
  assert.ok(fields.sequentialWrite.notes.some((note) => note.includes('actually reached the disk')));
});

test('read throughput discloses that the OS cache may be involved', async () => {
  const { fields } = await runDiskBenchmark({ sizeMb: 32, allowWrite: true });
  assert.ok(fields.sequentialRead.notes.some((note) => note.includes('OS cache')));
});

test('with writes disabled the write test is UNTESTED and says why', async () => {
  const { fields } = await runDiskBenchmark({ sizeMb: 32, allowWrite: false });
  assert.equal(fields.sequentialWrite.status, Status.UNTESTED);
  assert.ok(fields.sequentialWrite.notes.some((note) => note.includes('disabled in Performance settings')));
});
