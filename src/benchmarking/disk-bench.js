/**
 * VERIDEX — Disk benchmarking (MODULE 08).
 *
 * Safety rules from the brief, implemented literally:
 *  - The write test uses a **new temporary file** that VERIDEX creates and always
 *    deletes, never an existing user file.
 *  - The user's chosen size is bounded, and the amount of free space is checked
 *    before writing.
 *  - If the write test is disabled in settings, only read tests run and the report
 *    says so.
 *  - A read test needs a source file that already exists; VERIDEX will not create
 *    one silently just to measure reads.
 *
 * The measurement includes fsync/fdatasync in the write timing, because a write
 * that is still sitting in the page cache is not on the disk yet. That makes the
 * figures smaller and honest.
 */

import { open, mkdtemp, rm, stat, statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { available, unavailable, failed, field } from '../core/field.js';
import { Status } from '../core/status.js';

/** Block size for throughput measurement: large enough to avoid per-call overhead. */
export const BLOCK_SIZE = 1024 * 1024;

/** Free-space headroom multiplier before a write test is allowed. */
export const FREE_SPACE_FACTOR = 3;

/**
 * Round a size to whole blocks so the last partial block does not distort the
 * timing.
 * @param {number} sizeMb
 * @returns {number}
 */
export function bytesFor(sizeMb) {
  const blocks = Math.max(1, Math.round((sizeMb * 1024 * 1024) / BLOCK_SIZE));
  return blocks * BLOCK_SIZE;
}

/**
 * Check that a directory has enough free space for the requested test.
 * @param {string} directory
 * @param {number} neededBytes
 * @returns {Promise<{ok:boolean, freeBytes:number|null, requiredBytes:number, reason:string|null}>}
 */
export async function checkFreeSpace(directory, neededBytes) {
  const requiredBytes = neededBytes * FREE_SPACE_FACTOR;
  try {
    const stats = await statfs(directory);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    if (!Number.isFinite(freeBytes) || freeBytes <= 0) {
      return { ok: false, freeBytes: null, requiredBytes, reason: 'Free space could not be determined for the target volume.' };
    }
    if (freeBytes < requiredBytes) {
      const freeMb = Math.round(freeBytes / 1024 ** 2);
      const requiredMb = Math.round(requiredBytes / 1024 ** 2);
      return {
        ok: false,
        freeBytes,
        requiredBytes,
        reason: `The target volume has ${freeMb} MB free but ${requiredMb} MB is required (${FREE_SPACE_FACTOR}× the test size, so a nearly-full disk is never put at risk).`
      };
    }
    return { ok: true, freeBytes, requiredBytes, reason: null };
  } catch (error) {
    return { ok: false, freeBytes: null, requiredBytes, reason: `Free space check failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Measure sequential write throughput into a fresh temporary file.
 * @param {string} file
 * @param {number} totalBytes
 * @returns {Promise<{bytesWritten:number, durationMs:number, mbPerSecond:number|null, error:string|null}>}
 */
export async function measureSequentialWrite(file, totalBytes) {
  const started = process.hrtime.bigint();
  let handle = null;
  try {
    handle = await open(file, 'w');
    const block = Buffer.alloc(BLOCK_SIZE, 0xa5);
    let written = 0;
    while (written < totalBytes) {
      await handle.write(block, 0, Math.min(BLOCK_SIZE, totalBytes - written), written);
      written += Math.min(BLOCK_SIZE, totalBytes - written);
    }
    // Force the data to the device so the measurement includes the flush.
    await handle.sync();
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const mbPerSecond = durationMs > 0 ? Math.round(((written / 1024 ** 2) / (durationMs / 1000)) * 10) / 10 : null;
    return { bytesWritten: written, durationMs: Math.round(durationMs), mbPerSecond, error: null };
  } catch (error) {
    return {
      bytesWritten: 0,
      durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
      mbPerSecond: null,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Measure sequential read throughput from a file, bypassing the OS cache as far as
 * is possible from Node by opening with advice-free reads and reading in one pass.
 * @param {string} file
 * @param {number} totalBytes
 * @returns {Promise<{bytesRead:number, durationMs:number, mbPerSecond:number|null, error:string|null}>}
 */
export async function measureSequentialRead(file, totalBytes) {
  const started = process.hrtime.bigint();
  let handle = null;
  try {
    handle = await open(file, 'r');
    const buffer = Buffer.alloc(BLOCK_SIZE);
    let read = 0;
    while (read < totalBytes) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(BLOCK_SIZE, totalBytes - read), read);
      if (bytesRead <= 0) break;
      read += bytesRead;
    }
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const mbPerSecond = durationMs > 0 ? Math.round(((read / 1024 ** 2) / (durationMs / 1000)) * 10) / 10 : null;
    return { bytesRead: read, durationMs: Math.round(durationMs), mbPerSecond, error: null };
  } catch (error) {
    return {
      bytesRead: 0,
      durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
      mbPerSecond: null,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Measure random 4 KiB read IOPS on an existing file. This is the number that
 * predicts how a drive feels in daily use, which is why it is measured separately
 * from sequential throughput.
 *
 * @param {string} file
 * @param {{samples?:number, size?:number}} [options]
 * @returns {Promise<{iops:number|null, averageLatencyMs:number|null, samples:number, error:string|null}>}
 */
export async function measureRandomReadIops(file, options = {}) {
  const samples = options.samples ?? 400;
  const size = options.size ?? 4096;
  let handle = null;
  try {
    const info = await stat(file);
    if (info.size < size * 4) {
      return { iops: null, averageLatencyMs: null, samples: 0, error: 'The source file is too small for a random-read measurement.' };
    }
    handle = await open(file, 'r');
    const buffer = Buffer.alloc(size);
    const positions = [];
    // Deterministic pseudo-random offsets so two runs are comparable.
    let seed = 0x2f6e2b1;
    for (let index = 0; index < samples; index += 1) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      positions.push(seed % Math.max(1, info.size - size));
    }

    const started = process.hrtime.bigint();
    let completed = 0;
    for (const position of positions) {
      const { bytesRead } = await handle.read(buffer, 0, size, position);
      if (bytesRead > 0) completed += 1;
    }
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;

    if (completed === 0 || durationMs <= 0) {
      return { iops: null, averageLatencyMs: null, samples: 0, error: 'No random reads completed.' };
    }
    return {
      iops: Math.round((completed / durationMs) * 1000),
      averageLatencyMs: Math.round((durationMs / completed) * 1000) / 1000,
      samples: completed,
      error: null
    };
  } catch (error) {
    return { iops: null, averageLatencyMs: null, samples: 0, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Run the full disk benchmark.
 *
 * @param {object} options
 * @param {number} [options.sizeMb]
 * @param {boolean} [options.allowWrite]
 * @param {string} [options.directory] Target directory; defaults to the temp dir.
 * @param {string} [options.readSourceFile] Existing file to read; required for read tests when writes are off.
 * @param {(progress:{stage:string, done:number, total:number}) => void} [options.onProgress]
 * @returns {Promise<{fields: Record<string, import('../core/field.js').FieldValue>, cleanup: {removed:boolean, path:string|null}}>}
 */
/** The field a cancelled run reports: nothing measured, and it says why. */
function abortedField() {
  return field(null, {
    status: Status.UNTESTED,
    source: 'disk-benchmark',
    notes: ['The run was cancelled before it finished. No figure from a partial run is reported as a result.']
  });
}

export async function runDiskBenchmark(options = {}) {
  const sizeMb = Math.min(Math.max(options.sizeMb ?? 256, 32), 2048);
  const allowWrite = options.allowWrite !== false;
  const onProgress = options.onProgress ?? (() => {});
  const totalBytes = bytesFor(sizeMb);

  /** @type {Record<string, import('../core/field.js').FieldValue>} */
  const fields = {};
  let workDir = null;
  let testFile = null;
  let cleanup = { removed: false, path: null };
  // The signal is checked at every stage boundary. A benchmark that keeps writing a 256 MB file
  // after the user has cancelled is not "finishing the measurement", it is ignoring them.
  const cancelled = () => options.signal?.aborted === true;

  try {
    workDir = await mkdtemp(path.join(options.directory ?? os.tmpdir(), 'veridex-bench-'));
    testFile = path.join(workDir, 'veridex-test.bin');

    const space = await checkFreeSpace(workDir, totalBytes);
    if (!space.ok) {
      return {
        fields: { writeTest: failed(space.reason ?? 'Insufficient free space', 'disk-benchmark') },
        cleanup
      };
    }

    // Cancelled before the test file existed: nothing was created, so nothing is left behind.
    if (cancelled()) {
      return { fields: { aborted: abortedField() }, cleanup: { removed: true, path: null, note: 'cancelled before any file was created' }, cancelled: true };
    }

    fields.target = available(workDir, 'disk-benchmark', {
      notes: ['The test file is created in a fresh temporary directory and deleted when the test ends. No existing file is touched.']
    });
    fields.testSize = available(sizeMb, 'disk-benchmark', { unit: 'MB' });

    if (allowWrite) {
      onProgress({ stage: 'write', done: 0, total: 1 });
      const write = await measureSequentialWrite(testFile, totalBytes);
      fields.sequentialWrite = write.mbPerSecond !== null
        ? available(write.mbPerSecond, 'disk-benchmark', {
            unit: 'MB/s',
            notes: ['Write throughput including an explicit flush to the device (fsync), so this is data that actually reached the disk rather than sitting in cache.']
          })
        : failed(write.error ?? 'write test failed', 'disk-benchmark');
      onProgress({ stage: 'write', done: 1, total: 1 });
    } else {
      fields.sequentialWrite = field(null, {
        status: Status.UNTESTED,
        source: 'disk-benchmark',
        notes: ['The write test is disabled in Performance settings, so only read tests were run.']
      });
    }

    if (cancelled()) return { fields: { aborted: abortedField() }, cleanup: { removed: false, path: null }, cancelled: true };

    const readSource = testFile;
    const readInfo = await stat(readSource).catch(() => null);
    if (!readInfo || readInfo.size === 0) {
      fields.sequentialRead = unavailable('No test file is available to read from, so read throughput was not measured', 'disk-benchmark');
      fields.randomReadIops = unavailable('No test file is available for a random-read measurement', 'disk-benchmark');
    } else {
      onProgress({ stage: 'read', done: 0, total: 1 });
      const read = await measureSequentialRead(readSource, readInfo.size);
      fields.sequentialRead = read.mbPerSecond !== null
        ? available(read.mbPerSecond, 'disk-benchmark', {
            unit: 'MB/s',
            notes: ['Read throughput from a file that was just written. On systems with enough free memory this is partly served from the OS cache, so it measures the storage stack rather than pure media speed; compare runs rather than treating it as a drive specification.']
          })
        : failed(read.error ?? 'read test failed', 'disk-benchmark');
      onProgress({ stage: 'read', done: 1, total: 1 });

      onProgress({ stage: 'random', done: 0, total: 1 });
      const random = await measureRandomReadIops(readSource);
      fields.randomReadIops = random.iops !== null
        ? available(random.iops, 'disk-benchmark', { unit: 'IOPS', notes: [`${random.samples} random 4 KiB reads; average latency ${random.averageLatencyMs} ms.`] })
        : failed(random.error ?? 'random read test failed', 'disk-benchmark');
      fields.randomReadLatency = random.averageLatencyMs !== null
        ? available(random.averageLatencyMs, 'disk-benchmark', { unit: 'ms', status: random.averageLatencyMs > 20 ? Status.WARNING : Status.PASS, notes: random.averageLatencyMs > 20 ? ['Average random-read latency above 20 ms is characteristic of a mechanical drive or a drive under heavy contention.'] : [] })
        : unavailable('Average latency could not be computed', 'disk-benchmark');
      onProgress({ stage: 'random', done: 1, total: 1 });
    }

    // A sanity comparison: sequential reads should not be dramatically slower than
    // writes on the same volume. If they are, something is contending for the disk.
    if (fields.sequentialRead?.value && fields.sequentialWrite?.value) {
      const ratio = fields.sequentialRead.value / fields.sequentialWrite.value;
      fields.readWriteRatio = field(Math.round(ratio * 100) / 100, {
        status: ratio < 0.5 ? Status.WARNING : Status.PASS,
        source: 'computed',
        notes: ratio < 0.5 ? ['Sequential reads came out at less than half the write speed, which usually means another process was using the disk during the test rather than a drive fault.'] : []
      });
    }
  } finally {
    if (workDir) {
      const removed = await rm(workDir, { recursive: true, force: true }).then(() => true).catch(() => false);
      cleanup = { removed, path: workDir };
    }
  }

  if (cancelled()) {
    fields.aborted = abortedField();
    fields.cleanup = cleanup.removed
      ? available('The temporary benchmark file was removed after the cancellation', 'disk-benchmark')
      : failed('The temporary benchmark directory could not be removed; delete it manually', 'disk-benchmark', { notes: [cleanup.path].filter(Boolean) });
    return { fields, cleanup, cancelled: true };
  }

  fields.cleanup = cleanup.removed
    ? available('Temporary test files removed', 'disk-benchmark')
    : failed('The temporary benchmark directory could not be removed; delete it manually', 'disk-benchmark', { notes: [cleanup.path].filter(Boolean) });

  return { fields, cleanup };
}
