/**
 * Navigation surfaces: the breadcrumb trail and the quick-access menu (R-22-02).
 *
 * The 40-section audit found R-22-02 still in progress with "sidebar and grouping exist,
 * breadcrumbs and a quick-access menu do not". These tests drive the real controller, so the
 * claim being made is "clicking the crumb navigates", not "a function that builds crumbs exists".
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

const answers = {
  'app:info': { ok: true, data: { name: 'VERIDEX', version: '1.0.0', platform: 'win32', brand: 'MERQO' } },
  'app:settings': { ok: true, data: { values: {}, specs: [] } },
  'app:guardSummary': { ok: true, data: { networkAttemptsBlocked: 0, unsafeCommandsBlocked: 0 } },
  'scan:state': { ok: true, data: { running: false, finished: null } },
  'manual:suites': { ok: true, data: { suites: [] } },
  'manual:coverage': { ok: true, data: { coverage: null, progress: null, issues: [] } },
  'history:list': { ok: true, data: { entries: [] } },
  'monitor:start': { ok: false, error: { message: 'not in this test' } }
};

async function boot() {
  const html = await readFile(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: false });
  const { window } = dom;

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

  await import(`../../src/renderer/app.js?boot=${Date.now()}&nav=1`);
  await waitFor(() => window.document.querySelectorAll('.vx-nav__item').length > 0, { label: 'the shell' });
  await waitFor(() => window.document.querySelector('.vx-breadcrumb') !== null, { label: 'the breadcrumb' });

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

const crumbText = (document) => [...document.querySelectorAll('.vx-breadcrumb > *')].map((node) => node.textContent).join(' ');

test('the breadcrumb states where the user is, on the first page', { skip }, async () => {
  const { document, restore } = await boot();
  try {
    const trail = document.querySelector('.vx-breadcrumb');
    assert.ok(trail, 'the topbar must carry a breadcrumb');
    assert.equal(trail.getAttribute('aria-label'), 'Breadcrumb');
    assert.match(crumbText(document), /VERIDEX/);
    assert.match(crumbText(document), /Overview/);
    const current = document.querySelector('.vx-breadcrumb__current');
    assert.equal(current.textContent, 'Dashboard');
    assert.equal(current.getAttribute('aria-current'), 'page', 'the current crumb must be marked as current, not as a link');
  } finally {
    restore();
  }
});

test('navigating replaces the trail with the new page and group', { skip }, async () => {
  const { document, restore } = await boot();
  try {
    const hardware = [...document.querySelectorAll('.vx-nav__item')].find((node) => /Hardware/.test(node.textContent));
    hardware.dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true }));
    await waitFor(() => document.querySelector('.vx-breadcrumb__current')?.textContent === 'Hardware', { label: 'the Hardware crumb' });
    assert.match(crumbText(document), /Diagnostics/);
    assert.equal(document.querySelector('.vx-topbar__title').textContent, 'Hardware');
  } finally {
    restore();
  }
});

test('the group crumb goes to the first page of that group, and VERIDEX goes home', { skip }, async () => {
  const { document, restore } = await boot();
  try {
    const hardware = [...document.querySelectorAll('.vx-nav__item')].find((node) => /Hardware/.test(node.textContent));
    hardware.dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true }));
    await waitFor(() => document.querySelector('.vx-breadcrumb__current')?.textContent === 'Hardware', { label: 'the Hardware crumb' });

    const [home, group] = document.querySelectorAll('.vx-breadcrumb__link');
    group.dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true }));
    await waitFor(() => document.querySelector('.vx-breadcrumb__current')?.textContent === 'Hardware', { label: 'the group page' });
    assert.equal(document.querySelector('.vx-topbar__title').textContent, 'Hardware', 'Diagnostics starts at Hardware');

    home.dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true }));
    await waitFor(() => document.querySelector('.vx-breadcrumb__current')?.textContent === 'Dashboard', { label: 'home' });
  } finally {
    restore();
  }
});

test('the quick-access menu is empty on first launch and says so', { skip }, async () => {
  const { document, restore } = await boot();
  try {
    const trigger = document.querySelector('#vx-recent-pages');
    assert.ok(trigger, 'the topbar must offer the quick-access menu');
    trigger.dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true }));
    await waitFor(() => document.querySelector('.vx-dialog') !== null, { label: 'the quick-access dialog' });
    assert.match(document.querySelector('.vx-dialog__body').textContent, /Nothing visited yet/);
  } finally {
    restore();
  }
});

test('the menu lists visited pages newest first and navigates back to them', { skip }, async () => {
  const { document, restore } = await boot();
  try {
    for (const label of ['Hardware', 'Battery']) {
      const entry = [...document.querySelectorAll('.vx-nav__item')].find((node) => new RegExp(label).test(node.textContent));
      entry.dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true }));
      await waitFor(() => document.querySelector('.vx-breadcrumb__current')?.textContent === label, { label });
    }

    document.querySelector('#vx-recent-pages').dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true }));
    await waitFor(() => document.querySelector('.vx-quickaccess') !== null, { label: 'the recent list' });
    const rows = [...document.querySelectorAll('.vx-quickaccess__row')].map((node) => node.textContent);
    assert.equal(rows.length, 2, 'two pages have been visited, so the list holds two');
    assert.match(rows[0], /Hardware/, 'the page visited before the current one comes first');
    assert.match(rows[1], /Dashboard/);

    document.querySelectorAll('.vx-quickaccess__row')[0].dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true }));
    await waitFor(() => document.querySelector('.vx-breadcrumb__current')?.textContent === 'Hardware', { label: 'navigation from the menu' });
    assert.equal(document.querySelector('.vx-dialog'), null, 'choosing a page closes the menu');
  } finally {
    restore();
  }
});

test('the current page never appears in its own recent list, and the list stops at five', { skip }, async () => {
  const { document, restore } = await boot();
  try {
    const ids = ['hardware', 'battery', 'storage', 'network', 'windows', 'reliability', 'drivers'];
    for (const id of ids) {
      const entry = [...document.querySelectorAll('.vx-nav__item')].find((node) => node.dataset.page === id);
      entry.dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true }));
    }
    await waitFor(() => document.querySelector('.vx-topbar__title').textContent === 'Drivers & software', { label: 'the last page' });

    document.querySelector('#vx-recent-pages').dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true }));
    await waitFor(() => document.querySelector('.vx-quickaccess') !== null, { label: 'the recent list' });
    const rows = [...document.querySelectorAll('.vx-quickaccess__row')].map((node) => node.textContent);
    assert.equal(rows.length, 5, 'the quick-access list is capped at five entries');
    assert.ok(!rows.some((row) => /Drivers & software/.test(row)), 'the page you are on is not a place to go');
  } finally {
    restore();
  }
});
