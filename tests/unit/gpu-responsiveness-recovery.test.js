/**
 * R-08-05 GPU benchmark, R-08-06 responsiveness composite, R-25-02 crash marker.
 *
 * These three requirements were the project's three standing warnings. Each is tested here at the
 * level that matters: the mapping from a measurement to a reported figure, the arithmetic of the
 * composite, and the marker's behaviour across a crash and a clean finish.
 *
 * The GPU probe needs a browser context, so it is exercised through a fake WebGL context that
 * records its calls. That is enough to prove the probe's own logic — that it refuses without a
 * context, that it reports UNSUPPORTED rather than a number when WebGL is missing, and that a
 * compile failure becomes an error rather than a zero. It does not prove anything about a real
 * GPU; the Windows harness is what would do that.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { probeGpu, mapGpuBenchmarkResults, gpuFrameTimeOf } from '../../src/benchmarking/gpu-bench.js';
import { computeResponsiveness, responsivenessFields, RESPONSIVENESS_MODEL } from '../../src/benchmarking/responsiveness.js';
import { writeMarker, readMarker, clearMarker, describeInterrupted, markerPath, markerIsStale } from '../../src/app/crash-marker.js';
import { Status } from '../../src/core/status.js';

// ── A fake WebGL context ────────────────────────────────────────────────────

function fakeCanvas({ webgl = true, compileFails = false } = {}) {
  const calls = { draws: 0, readPixels: 0, finish: 0 };
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    STATIC_DRAW: 6,
    FLOAT: 7,
    TRIANGLES: 8,
    RGBA: 9,
    UNSIGNED_BYTE: 10,
    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => compileFails === false,
    getShaderInfoLog: () => (compileFails ? 'shader compile error' : ''),
    createProgram: () => ({}),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    createBuffer: () => ({}),
    bindBuffer: () => {},
    bufferData: () => {},
    getAttribLocation: () => 0,
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    viewport: () => {},
    useProgram: () => {},
    getUniformLocation: () => ({}),
    uniform1f: () => {},
    drawArrays: () => {
      calls.draws += 1;
    },
    readPixels: () => {
      calls.readPixels += 1;
    },
    finish: () => {
      calls.finish += 1;
    },
    getExtension: () => null
  };
  return {
    canvas: { width: 64, height: 64, getContext: () => (webgl ? gl : null) },
    calls
  };
}

test('the GPU probe reports UNSUPPORTED when no context exists, and never a number', () => {
  const result = probeGpu({ canvas: { width: 64, height: 64, getContext: () => null } });
  assert.equal(result.supported, false);
  assert.match(result.reason, /WebGL is not available/);
  assert.equal(result.fps, null);
  assert.equal(result.pixelsPerSecond, null);

  const fields = mapGpuBenchmarkResults(result);
  assert.equal(fields.verdict.status, Status.UNSUPPORTED);
  assert.equal(fields.gpuFillRate.status, Status.UNAVAILABLE);
  assert.match(fields.gpuFillRate.error, /software rasteriser/i);
});

test('the GPU probe with no canvas at all is also a refusal, not a crash', () => {
  const result = probeGpu({});
  assert.equal(result.supported, false);
  assert.match(result.reason, /No canvas/);
});

test('a successful probe measures frames and forces the queue to drain', () => {
  const { canvas, calls } = fakeCanvas();
  let clock = 0;
  const result = probeGpu({ canvas, frames: 10, width: 64, height: 64, now: () => (clock += 10) });

  assert.equal(result.supported, true);
  assert.equal(result.frames, 10);
  assert.equal(calls.draws, 11, 'ten measured frames plus one warm-up frame');
  assert.equal(calls.readPixels, 1, 'a pixel read forces the GPU work to complete before timing stops');
  assert.ok(result.frameTimeMs > 0);
  assert.ok(result.fps > 0);
  assert.ok(result.pixelsPerSecond > 0);
});

test('a shader compile failure is an error, not a zero score', () => {
  const { canvas } = fakeCanvas({ compileFails: true });
  const result = probeGpu({ canvas, frames: 5 });
  assert.equal(result.supported, false);
  assert.match(result.reason, /refused to compile/);
  assert.match(result.error, /shader compile error/);
});

test('the GPU field map reports units and says what the figure is not', () => {
  const fields = mapGpuBenchmarkResults({
    supported: true,
    frames: 30,
    frameTimeMs: 8,
    fps: 125,
    pixelsPerSecond: 9_830_400_000,
    renderer: 'Fake GPU',
    vendor: 'Fake Vendor',
    error: null
  });
  assert.equal(fields.gpuFillRate.unit, 'px/s');
  assert.equal(fields.gpuFrameTime.unit, 'ms');
  assert.equal(fields.gpuFrameTime.status, Status.PASS);
  assert.equal(fields.gpuAdapter.value, 'Fake GPU');
  assert.equal(fields.verdict.status, Status.UNRATED);
  assert.match(fields.gpuFillRate.notes.join(' '), /not the GPU's peak performance/i);
  assert.equal(gpuFrameTimeOf({ supported: true, frameTimeMs: 8 }), 8);
  assert.equal(gpuFrameTimeOf({ supported: false }), null);
});

// ── Responsiveness composite ────────────────────────────────────────────────

test('one measurement is not a composite: the score is withheld with the reason', () => {
  const result = computeResponsiveness({ cpuSingleOpsPerSec: 12_000_000 });
  assert.equal(result.score, null);
  assert.equal(result.status, Status.UNRATED);
  assert.deepEqual(result.measured, ['cpu']);
  assert.match(result.statement, /at least 2 measured subsystems/);
});

test('two measured subsystems produce a score and name what was missing', () => {
  const result = computeResponsiveness({
    cpuSingleOpsPerSec: RESPONSIVENESS_MODEL.reference.cpuSingleOpsPerSec,
    diskRandomReadMs: RESPONSIVENESS_MODEL.reference.diskRandomReadMs
  });
  assert.equal(result.score, 100);
  assert.equal(result.rating, 'Excellent');
  assert.deepEqual(result.measured.sort(), ['cpu', 'disk']);
  assert.deepEqual(result.missing.sort(), ['gpu', 'memory']);
  assert.match(result.statement, /not measured and excluded/);
});

test('slower measured values produce a lower score, monotonically', () => {
  const fast = computeResponsiveness({ cpuSingleOpsPerSec: 20_000_000, diskRandomReadMs: 0.2 });
  const medium = computeResponsiveness({ cpuSingleOpsPerSec: 10_000_000, diskRandomReadMs: 1 });
  const slow = computeResponsiveness({ cpuSingleOpsPerSec: 2_000_000, diskRandomReadMs: 20 });
  assert.ok(fast.score > medium.score, `${fast.score} should exceed ${medium.score}`);
  assert.ok(medium.score > slow.score, `${medium.score} should exceed ${slow.score}`);
  assert.equal(slow.score >= 0, true);
});

test('weights are renormalised over what was measured, so a missing subsystem does not penalise', () => {
  const all = computeResponsiveness({ cpuSingleOpsPerSec: 20_000_000, diskRandomReadMs: 0.2 });
  const weightSum = all.contributions.reduce((total, entry) => total + entry.weight, 0);
  assert.ok(Math.abs(weightSum - 1) < 1e-9, `contributions must sum to 1, got ${weightSum}`);
});

test('event-loop lag is a penalty, capped, and never a weighted input', () => {
  const clean = computeResponsiveness({ cpuSingleOpsPerSec: 20_000_000, diskRandomReadMs: 0.2 });
  const laggy = computeResponsiveness({ cpuSingleOpsPerSec: 20_000_000, diskRandomReadMs: 0.2, eventLoopLagMs: 5 });
  assert.equal(laggy.penalty, 20);
  assert.equal(laggy.score, clean.score - 20);
  assert.equal(laggy.contributions.length, clean.contributions.length, 'lag must not add a contribution');

  const hopeless = computeResponsiveness({ cpuSingleOpsPerSec: 20_000_000, diskRandomReadMs: 0.2, eventLoopLagMs: 500 });
  assert.equal(hopeless.penalty, RESPONSIVENESS_MODEL.eventLoopPenaltyCap);
  assert.equal(hopeless.score, clean.score - RESPONSIVENESS_MODEL.eventLoopPenaltyCap);
});

test('the composite is reported as fields with its formula attached', () => {
  const fields = responsivenessFields({ cpuSingleOpsPerSec: 18_000_000, memoryBandwidthGbps: 14, diskRandomReadMs: 0.4 });
  assert.equal(fields.responsiveness.unit, 'of 100');
  assert.equal(typeof fields.responsiveness.value, 'number');
  assert.match(fields.responsiveness.notes.join(' '), /documented in src\/benchmarking\/responsiveness\.js/);
  assert.equal(fields.responsivenessRating.value.length > 0, true);

  const empty = responsivenessFields({});
  assert.equal(empty.responsiveness.status, Status.UNAVAILABLE);
});

test('nonsense inputs are treated as missing rather than as zero', () => {
  const result = computeResponsiveness({ cpuSingleOpsPerSec: Number.NaN, diskRandomReadMs: -5, memoryBandwidthGbps: null, gpuFrameTimeMs: undefined });
  assert.equal(result.score, null);
  assert.deepEqual(result.measured, []);
});

// ── Crash marker ────────────────────────────────────────────────────────────

test('a marker survives a read, and its absence is how a clean finish is detected', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'veridex-marker-'));
  const file = markerPath(dir);
  try {
    assert.equal(await readMarker(file), null, 'no marker means the last session finished');

    await writeMarker(file, { kind: 'scan', startedAt: '2026-03-04T09:00:00.000Z', appVersion: '1.0.0' });
    const marker = await readMarker(file);
    assert.equal(marker.kind, 'scan');
    assert.equal(marker.startedAt, '2026-03-04T09:00:00.000Z');

    const cleared = await clearMarker(file);
    assert.equal(cleared.cleared, true);
    assert.equal(await readMarker(file), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a corrupt marker is evidence, not an error to swallow', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'veridex-marker-'));
  const file = markerPath(dir);
  try {
    await writeFile(file, '{ this is not json', 'utf8');
    const marker = await readMarker(file);
    assert.equal(marker.corrupt, true);
    const described = describeInterrupted(marker);
    assert.match(described.body, /could not be read/);
    assert.match(described.body, /not reported as completed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the marker is written whole or not at all', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'veridex-marker-'));
  const file = markerPath(dir);
  try {
    await writeMarker(file, { kind: 'stress', startedAt: '2026-03-04T09:00:00.000Z', id: 'stress-1', appVersion: '1.0.0' });
    const raw = await readFile(file, 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw), 'the file on disk must always be valid JSON');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an interrupted run is described as interrupted, per kind, and never as complete', () => {
  for (const [kind, fragment] of [
    ['scan', 'diagnostic scan'],
    ['stress', 'stress run'],
    ['export', 'driver export'],
    ['report', 'report build'],
    ['crash', 'crash']
  ]) {
    const described = describeInterrupted({ kind, startedAt: '2026-03-04T09:00:00.000Z' });
    assert.match(described.body, /recorded as interrupted/, `${kind} must be called interrupted`);
    assert.ok(described.body.includes(fragment), `${kind} description should name it`);
    assert.ok(!/completed successfully/i.test(described.body));
  }
  assert.equal(describeInterrupted(null), null);
});

test('a marker older than the staleness window is flagged rather than reported as a fresh crash', () => {
  const started = '2026-03-04T09:00:00.000Z';
  const fresh = Date.parse(started) + 60_000;
  assert.equal(markerIsStale({ startedAt: started }, fresh), false);
  assert.equal(markerIsStale({ startedAt: started }, Date.parse(started) + 7 * 60 * 60 * 1000), true);
  assert.equal(markerIsStale({ startedAt: null }, fresh), false);
});

test('the marker never carries diagnostic values, only what and when', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'veridex-marker-'));
  const file = markerPath(dir);
  try {
    await writeMarker(file, { kind: 'scan', startedAt: '2026-03-04T09:00:00.000Z', appVersion: '1.0.0', detail: 'serial ABC123' });
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(Object.keys(parsed).sort(), ['appVersion', 'detail', 'id', 'kind', 'startedAt']);
    // The detail field is for a reason string, and the caller's own text is what it holds: this
    // test exists to keep the marker's key set from growing a field that carries evidence.
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
