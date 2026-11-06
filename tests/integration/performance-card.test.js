/**
 * The Performance page's consent-gated cards.
 *
 * The memory stability check allocates real memory, so the interface must not offer a run button
 * that works before the user has said yes — and it must not keep the button disabled after they
 * have. Both directions are asserted here, against the real controller.
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

async function bootPerformance() {
  const html = await readFile(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: false });
  const { window } = dom;
  const calls = [];

  const answers = {
    'app:info': { ok: true, data: { name: 'VERIDEX', version: '1.0.0', platform: 'win32' } },
    'app:settings': { ok: true, data: { values: {}, specs: [], ui: { widgets: [] } } },
    'app:guardSummary': { ok: true, data: { networkAttemptsBlocked: 0, unsafeCommandsBlocked: 0 } },
    'scan:state': { ok: true, data: { running: false, finished: null } },
    'manual:suites': { ok: true, data: { suites: [] } },
    'manual:coverage': { ok: true, data: { coverage: null, progress: null, issues: [] } },
    'history:list': { ok: true, data: { entries: [] } },
    'bench:state': { ok: true, data: { cpu: null, disk: null, gpu: null, memory: null, stress: null } },
    'stress:state': { ok: true, data: { running: false, last: null, capabilities: { thermalSensorAvailable: false, logicalCpus: 2 }, limits: { minDurationSec: 10, maxDurationSec: 300, thermalLimitC: 90 } } },
    'bench:memory': async (megabytes, passes, consent) => {
      calls.push({ channel: 'bench:memory', megabytes, passes, consent });
      return {
        ok: true,
        data: {
          started: true,
          refused: false,
          cancelled: false,
          megabytes,
          passes,
          bytesVerified: megabytes * 1024 * 1024 * passes,
          mismatches: 0,
          durationMs: 120,
          fields: {
            memoryStability: { value: 0, status: 'UNRATED', source: 'memory-stability', confidence: 'MEDIUM', unit: 'words', notes: ['A read-back matched the written pattern at every position.', 'That is not a clean bill of health.'] }
          }
        }
      };
    }
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

  await import(`../../src/renderer/app.js?boot=${Date.now()}&perf=1`);
  await waitFor(() => window.document.querySelectorAll('.vx-nav__item').length > 0, { label: 'the shell' });
  window.document.querySelector('.vx-nav__item[data-page="performance"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await waitFor(() => window.document.querySelector('#vx-memory-run') !== null, { label: 'the memory card' });

  return {
    document: window.document,
    window,
    calls,
    restore: () => {
      if (previous.window) globalThis.window = previous.window;
      if (previous.document) globalThis.document = previous.document;
      if (previous.veridex === undefined) delete globalThis.veridex;
      else globalThis.veridex = previous.veridex;
      window.close();
    }
  };
}

test('the stability check cannot be started before consent is given', { skip }, async () => {
  const { document, restore } = await bootPerformance();
  try {
    const run = document.querySelector('#vx-memory-run');
    assert.ok(run, 'the memory card must offer the check');
    assert.equal(run.disabled, true, 'a run button that works before consent would allocate memory unasked');
    assert.match(run.title, /Consent is required/);

    const consent = document.querySelector('#vx-memory-consent');
    assert.ok(consent, 'the consent box must exist and be addressable');
    assert.equal(consent.checked, false, 'consent must start unticked');
  } finally {
    restore();
  }
});

test('ticking consent enables the check, and the bounds are visible', { skip }, async () => {
  const { document, window, restore } = await bootPerformance();
  try {
    const consent = document.querySelector('#vx-memory-consent');
    // A real click flips `checked` before firing `change`; a synthetic dispatch does not, so the
    // test does what the browser would.
    consent.checked = true;
    consent.dispatchEvent(new window.Event('change', { bubbles: true }));
    await waitFor(() => document.querySelectorAll('#vx-memory-run')[0]?.disabled === false, { label: 'the enabled run button' });

    const size = document.querySelector('#vx-memory-mb');
    const passes = document.querySelector('#vx-memory-passes');
    assert.equal(size.getAttribute('min'), '64');
    assert.equal(size.getAttribute('max'), '1024');
    assert.equal(passes.getAttribute('max'), '20');
  } finally {
    restore();
  }
});

test('running the check sends the sizes as numbers, and the result renders as unrated', { skip }, async () => {
  const { document, window, calls, restore } = await bootPerformance();
  try {
    const consent = document.querySelector('#vx-memory-consent');
    consent.checked = true;
    consent.dispatchEvent(new window.Event('change', { bubbles: true }));
    await waitFor(() => document.querySelector('#vx-memory-run').disabled === false, { label: 'the enabled run button' });
    document.querySelector('#vx-memory-run').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

    await waitFor(() => calls.length === 1, { label: 'the invoke call' });
    assert.equal(calls[0].channel, 'bench:memory');
    assert.equal(calls[0].megabytes, 256);
    assert.equal(calls[0].passes, 3);
    assert.equal(calls[0].consent, true);

    await waitFor(() => /clean bill of health/.test(document.body.textContent), { label: 'the rendered result' });
    assert.match(document.body.textContent, /Memory stability/);
  } finally {
    restore();
  }
});
