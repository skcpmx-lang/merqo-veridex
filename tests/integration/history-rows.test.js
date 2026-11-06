/**
 * The History page must be able to show what the store now holds (R-24-01).
 *
 * Benchmarks and stress runs are written to history. If the page rendered them through the scan
 * layout they would appear as "Unrated · coverage unknown", which is a true statement about a
 * scan and a false impression of a benchmark. These tests drive the real page.
 *
 * jsdom is an optional dev dependency; without it these skip rather than fail.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

let JSDOM = null;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  JSDOM = null;
}

const skip = JSDOM === null && 'jsdom not installed';

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 10, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let ok = false;
    try {
      ok = Boolean(predicate());
    } catch {
      ok = false;
    }
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label} after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const entries = [
  {
    id: 'stress-1',
    kind: 'stress',
    finishedAt: '2026-11-06T11:00:00.000Z',
    summary: {
      kind: 'cpu',
      state: 'STOPPED_DURATION',
      stopReason: 'duration reached',
      threads: 4,
      peakTemperatureC: 74,
      temperatureObserved: true,
      completed: true
    }
  },
  {
    id: 'bench-1',
    kind: 'benchmark',
    finishedAt: '2026-11-06T10:00:00.000Z',
    summary: {
      benchmark: 'cpu',
      mode: 'all',
      singleCoreOpsPerSec: 1200,
      multiCoreOpsPerSec: 8400,
      memoryGbps: 18.4,
      threads: 8
    }
  },
  {
    id: 'bench-2',
    kind: 'benchmark',
    finishedAt: '2026-11-06T09:00:00.000Z',
    summary: {
      benchmark: 'disk',
      sizeMb: 256,
      writeTested: true,
      sequentialReadMbps: 2400,
      sequentialWriteMbps: 1100,
      randomReadLatencyMs: 0.02,
      tempFileRemoved: false
    }
  },
  {
    id: 'scan-1',
    kind: 'full-scan',
    finishedAt: '2026-11-06T08:00:00.000Z',
    assessment: { score: 71, rating: 'Good', coveragePercent: 68 },
    coverage: { fields: 79 }
  }
];

async function boot() {
  const html = await readFile(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: false });
  const { window } = dom;

  const answers = {
    'app:info': { ok: true, data: { name: 'VERIDEX', version: '1.0.0', platform: 'win32' } },
    'app:settings': { ok: true, data: { values: {}, specs: [], ui: { widgets: [] } } },
    'app:guardSummary': { ok: true, data: { networkAttemptsBlocked: 0, unsafeCommandsBlocked: 0 } },
    'scan:state': { ok: true, data: { running: false, finished: null } },
    'manual:suites': { ok: true, data: { suites: [] } },
    'manual:coverage': { ok: true, data: { coverage: null, progress: null, issues: [] } },
    'history:list': { ok: true, data: { entries } }
  };

  window.veridex = {
    invoke: Object.freeze(
      Object.fromEntries(
        Object.keys(answers).map((channel) => [
          channel,
          async (...args) => {
            const answer = answers[channel];
            return typeof answer === 'function' ? answer(...args) : answer;
          }
        ])
      )
    ),
    on: () => () => {},
    channels: { invoke: Object.keys(answers), events: [] }
  };

  const previous = { window: globalThis.window, document: globalThis.document, veridex: globalThis.veridex };
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.veridex = window.veridex;

  await import(`../../src/renderer/app.js?boot=${Date.now()}&history=1`);
  await waitFor(() => window.document.querySelectorAll('.vx-nav__item').length > 0, { label: 'the shell' });

  const historyItem = [...window.document.querySelectorAll('.vx-nav__item')].find((node) => node.dataset.page === 'history');
  historyItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await waitFor(() => window.document.querySelectorAll('.vx-rows .vx-row').length >= 4, { label: 'the history rows' });

  return {
    document: window.document,
    restore: () => {
      if (previous.window) globalThis.window = previous.window;
      if (previous.document) globalThis.document = previous.document;
      if (previous.veridex === undefined) delete globalThis.veridex;
      else globalThis.veridex = previous.veridex;
      window.close();
    }
  };
}

test('a CPU benchmark is listed by what it measured, not by a score it never had', { skip }, async () => {
  const { document, restore } = await boot();
  try {
    const text = [...document.querySelectorAll('.vx-rows .vx-row')].map((row) => row.textContent).join('\n');
    assert.match(text, /CPU benchmark/);
    assert.match(text, /1,?200 ops\/s single-core|1200 ops\/s single-core/);
    assert.match(text, /8,?400 ops\/s multi-core|8400 ops\/s multi-core/);
    assert.match(text, /18\.4 GB\/s memory/);
  } finally {
    restore();
  }
});

test('a benchmark row carries no coverage claim and no "Unrated" verdict', { skip }, async () => {
  const { document, restore } = await boot();
  try {
    const benchRow = [...document.querySelectorAll('.vx-rows .vx-row')].find((row) => /CPU benchmark/.test(row.textContent));
    assert.ok(benchRow);
    assert.doesNotMatch(benchRow.textContent, /coverage unknown/, 'a benchmark has no coverage to be unknown');
    assert.doesNotMatch(benchRow.textContent, /Unrated/, 'a benchmark is not an unrated scan');
    assert.match(benchRow.textContent, /Comparable only with another VERIDEX run/);
  } finally {
    restore();
  }
});

test('a disk entry that left its temporary file behind says so in the list', { skip }, async () => {
  const { document, restore } = await boot();
  try {
    const diskRow = [...document.querySelectorAll('.vx-rows .vx-row')].find((row) => /Disk benchmark/.test(row.textContent));
    assert.ok(diskRow);
    assert.match(diskRow.textContent, /2,?400 MB\/s read/);
    assert.match(diskRow.textContent, /temporary file was left behind/);
  } finally {
    restore();
  }
});

test('a stress run is listed with its stop reason and peak temperature', { skip }, async () => {
  const { document, restore } = await boot();
  try {
    const stressRow = [...document.querySelectorAll('.vx-rows .vx-row')].find((row) => /stress run/.test(row.textContent));
    assert.ok(stressRow);
    assert.match(stressRow.textContent, /STOPPED_DURATION/);
    assert.match(stressRow.textContent, /duration reached/);
    assert.match(stressRow.textContent, /peak 74 °C/);
    assert.match(stressRow.textContent, /not a pass/i);
  } finally {
    restore();
  }
});

test('a scan row keeps its score, coverage and Mark button', { skip }, async () => {
  const { document, restore } = await boot();
  try {
    const scanRow = [...document.querySelectorAll('.vx-rows .vx-row')].find((row) => /79 fields/.test(row.textContent));
    assert.ok(scanRow, 'the scan row must still render through the scan layout');
    assert.match(scanRow.textContent, /71/);
    assert.match(scanRow.textContent, /68% coverage/);
    assert.ok(scanRow.querySelector('.vx-row__mark'), 'only scans can be marked for comparison');
  } finally {
    restore();
  }
});
