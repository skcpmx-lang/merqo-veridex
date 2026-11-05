/**
 * Renderer smoke tests.
 *
 * The interface cannot be launched here: Electron's binary is not downloadable in
 * this environment, there is no Windows host and no display. What *can* be verified
 * is that the real app controller boots, that every page builds without throwing,
 * and that the truthfulness rules hold in preview mode.
 *
 * This runs the actual `src/renderer/app.js` against a DOM, not a copy of it, so a
 * page that throws is caught. jsdom is an optional dev dependency: if it is absent
 * the tests skip rather than fail, because the packaged product does not need it.
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

/** Build a DOM and boot the real controller inside it. */
async function bootRenderer() {
  const html = await readFile(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: false });
  const { window } = dom;

  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.Node = window.Node;
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  // No `veridex` global on purpose: this is the preview path.

  await import(`../../src/renderer/app.js?boot=${Date.now()}`);
  await new Promise((resolve) => setTimeout(resolve, 150));

  return {
    window,
    document: window.document,
    restore: () => {
      if (previous.window) globalThis.window = previous.window;
      if (previous.document) globalThis.document = previous.document;
      window.close();
    }
  };
}

test('the renderer boots and builds the shell', { skip: JSDOM === null && 'jsdom not installed' }, async () => {
  const { document, restore } = await bootRenderer();
  try {
    assert.equal(document.querySelectorAll('.vx-nav__item').length, 15, 'every navigation page must be present');
    assert.equal(document.querySelector('.vx-topbar__title').textContent, 'Dashboard');
    assert.ok(document.querySelector('.vx-brand__name').textContent.includes('VERIDEX'));
    assert.ok(document.querySelectorAll('*').length > 30, 'the shell must actually be built');
  } finally {
    restore();
  }
});

test('preview mode is labelled and cannot pretend to scan', { skip: JSDOM === null && 'jsdom not installed' }, async () => {
  const { document, restore } = await bootRenderer();
  try {
    assert.match(document.body.textContent, /Design preview/);
    assert.match(document.body.textContent, /no machine was inspected/i);
    // The scan button must be disabled, not silently inert.
    const scan = document.querySelector('#vx-start-scan');
    assert.equal(scan.disabled, true);
    assert.match(scan.title, /requires the VERIDEX main process/);
    // An unrated machine must be described as unrated, never as healthy.
    assert.match(document.body.textContent, /Unrated/);
    assert.match(document.body.textContent, /not measured|not a healthy/i);
  } finally {
    restore();
  }
});

test('every page builds without throwing', { skip: JSDOM === null && 'jsdom not installed' }, async () => {
  const { document, restore } = await bootRenderer();
  try {
    const pages = [...document.querySelectorAll('.vx-nav__item')].map((node) => node.dataset.page);
    assert.equal(pages.length, 15);

    for (const page of pages) {
      const button = document.querySelector(`.vx-nav__item[data-page="${page}"]`);
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const content = document.querySelector('.vx-content');
      assert.ok(content, `${page}: content region must exist`);
      assert.ok(content.children.length > 0, `${page}: page must render something`);
      assert.ok(content.textContent.trim().length > 60, `${page}: page must say something meaningful`);
      // Nothing may show the string "undefined" or "NaN" to a user.
      assert.ok(!/undefined|NaN|\[object Object\]/.test(content.textContent), `${page}: leaked a raw value`);
    }
  } finally {
    restore();
  }
});

test('the UI never claims a benchmark or monitor is running when it is not', { skip: JSDOM === null && 'jsdom not installed' }, async () => {
  const { document, restore } = await bootRenderer();
  try {
    document.querySelector('.vx-nav__item[data-page="performance"]').click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const text = document.querySelector('.vx-content').textContent;
    assert.match(text, /not wired to this page yet/);
    // The safety warnings must be present regardless of wiring state.
    assert.match(text, /physical risk/);
    assert.match(text, /explicit consent/);
    assert.match(text, /not comparable to other benchmark tools/);

    document.querySelector('.vx-nav__item[data-page="monitor"]').click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.match(document.querySelector('.vx-content').textContent, /not wired to this page yet/);
  } finally {
    restore();
  }
});

test('the reports page refuses to export when no scan has run', { skip: JSDOM === null && 'jsdom not installed' }, async () => {
  const { document, restore } = await bootRenderer();
  try {
    document.querySelector('.vx-nav__item[data-page="reports"]').click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const text = document.querySelector('.vx-content').textContent;
    assert.match(text, /No scan to export/);
    assert.match(text, /will not generate a document from nothing/);
  } finally {
    restore();
  }
});

test('theme tokens reach the document root', { skip: JSDOM === null && 'jsdom not installed' }, async () => {
  const { document, restore } = await bootRenderer();
  try {
    const style = document.documentElement.style;
    const tokens = [...style].filter((property) => property.startsWith('--vx-'));
    assert.ok(tokens.length >= 30, `expected the full token set, got ${tokens.length}`);
    assert.ok(style.getPropertyValue('--vx-accent').length > 0);
    assert.equal(document.documentElement.dataset.theme, 'dark', 'the default theme is dark');
  } finally {
    restore();
  }
});

test('the page declares a restrictive content security policy', async () => {
  const html = await readFile(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /connect-src 'none'/, 'the renderer must not be able to open a connection');
  assert.match(html, /script-src 'self'/, 'no inline or remote scripts');
  assert.ok(!/unsafe-inline|unsafe-eval/.test(html), 'the CSP must not permit unsafe inline or eval');
});

test('the stylesheet loads no remote font or asset', async () => {
  const css = await readFile(path.join(ROOT, 'src/renderer/styles.css'), 'utf8');
  assert.ok(!/@import/.test(css), 'no CSS imports');
  assert.ok(!/url\(\s*['"]?https?:/.test(css), 'no remote assets');
  assert.ok(!/fonts\.googleapis|fonts\.gstatic/.test(css));
  assert.match(css, /prefers-reduced-motion/, 'reduced motion must be respected');
});

/**
 * Live-mode tests: a fake bridge is injected so the controller takes its real path
 * rather than the preview path. This is the only way to verify the pages that are
 * genuinely wired, because in preview mode they correctly refuse to show data.
 */
async function bootWithBridge(answers) {
  const html = await readFile(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: false });
  const { window } = dom;

  const calls = [];
  window.veridex = {
    invoke: Object.freeze({
      // A callable object, because the bridge checks `typeof invoke === 'object'` and
      // the controller calls `invoke(channel, ...)`.
      ...Object.fromEntries(
        Object.keys(answers).map((channel) => [
          channel,
          async (...args) => {
            calls.push({ channel, args });
            const answer = answers[channel];
            return typeof answer === 'function' ? answer(...args) : answer;
          }
        ])
      )
    }),
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

  await import(`../../src/renderer/app.js?boot=${Date.now()}&bridge=1`);
  await new Promise((resolve) => setTimeout(resolve, 200));

  return {
    window,
    document: window.document,
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

const run = (id, score, extra = {}) => ({
  id,
  finishedAt: '2026-03-04T09:15:00.000Z',
  assessment: { score, rating: score === null ? 'Unrated' : 'Good', coveragePercent: 13.2, ...extra },
  coverage: { fields: 15 },
  issues: { errors: [], warnings: [] }
});

const baseAnswers = (history) => ({
  'app:info': { ok: true, data: { name: 'VERIDEX', version: '1.0.0', platform: 'win32', brand: 'MERQO' } },
  'app:settings': { ok: true, data: { values: {}, specs: [] } },
  'app:guardSummary': { ok: true, data: { networkAttemptsBlocked: 0, unsafeCommandsBlocked: 0 } },
  'scan:state': { ok: true, data: { running: false, finished: null } },
  'manual:suites': { ok: true, data: { suites: [] } },
  'manual:coverage': { ok: true, data: { coverage: {}, progress: {}, issues: [] } },
  'history:list': history
});

test('the history page lists stored runs with their real scores', { skip: JSDOM === null && 'jsdom not installed' }, async () => {
  const { document, restore } = await bootWithBridge(baseAnswers({ ok: true, data: { entries: [run('VX-1', 87), run('VX-2', null)] } }));
  try {
    const nav = [...document.querySelectorAll('.vx-nav__item')].find((node) => node.textContent.includes('History'));
    nav.dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 120));

    const text = document.body.textContent;
    assert.match(text, /87/, 'a real score must be shown');
    assert.match(text, /Good/);
    assert.match(text, /VX-1/);
    assert.match(text, /13\.2% coverage/);
    assert.equal(document.querySelectorAll('.vx-rows .vx-row').length, 2, 'one row per stored run');
  } finally {
    restore();
  }
});

test('a withheld score reads as withheld in history, never as 0', { skip: JSDOM === null && 'jsdom not installed' }, async () => {
  const gated = run('VX-3', null, { gated: true, gatingNote: 'Only 13.2% could be measured.' });
  const { document, restore } = await bootWithBridge(baseAnswers({ ok: true, data: { entries: [gated] } }));
  try {
    const nav = [...document.querySelectorAll('.vx-nav__item')].find((node) => node.textContent.includes('History'));
    nav.dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 120));

    // Scope to the history rows: the shell elsewhere legitimately contains numerals
    // (task counts, coverage of zero), so a whole-body check would be meaningless.
    const rows = document.querySelectorAll('.vx-rows .vx-row');
    assert.equal(rows.length, 1);
    const rowText = rows[0].textContent;
    assert.match(rowText, /Score withheld/);
    assert.ok(!/\b0\b/.test(rowText), `a withheld score must not carry a numeric score: "${rowText}"`);
  } finally {
    restore();
  }
});

test('an empty history says so rather than showing a blank area', { skip: JSDOM === null && 'jsdom not installed' }, async () => {
  const { document, restore } = await bootWithBridge(baseAnswers({ ok: true, data: { entries: [] } }));
  try {
    const nav = [...document.querySelectorAll('.vx-nav__item')].find((node) => node.textContent.includes('History'));
    nav.dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.match(document.body.textContent, /No runs stored yet/);
  } finally {
    restore();
  }
});

test('a failed history read is reported, not disguised as "no runs"', { skip: JSDOM === null && 'jsdom not installed' }, async () => {
  const { document, restore } = await bootWithBridge(
    baseAnswers({ ok: false, error: { code: 'disk', message: 'The history file is unreadable.' } })
  );
  try {
    const nav = [...document.querySelectorAll('.vx-nav__item')].find((node) => node.textContent.includes('History'));
    nav.dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 120));

    const text = document.body.textContent;
    assert.match(text, /History could not be read/);
    assert.match(text, /unreadable/);
    assert.ok(!/No runs stored yet/.test(text), 'a read failure must not look like an empty history');
  } finally {
    restore();
  }
});

test('with a live bridge the preview banner is gone and scanning is possible', { skip: JSDOM === null && 'jsdom not installed' }, async () => {
  const { document, restore } = await bootWithBridge(baseAnswers({ ok: true, data: { entries: [] } }));
  try {
    assert.ok(!/Design preview/i.test(document.body.textContent ?? ''), 'live mode must not claim to be a preview');
    const start = document.getElementById('vx-start-scan');
    assert.ok(start, 'the scan button must exist');
    assert.equal(start.disabled, false, 'with a main process attached the scan must be startable');
  } finally {
    restore();
  }
});
