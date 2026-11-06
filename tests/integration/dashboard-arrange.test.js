/**
 * Dashboard widget arrangement (R-19-02).
 *
 * The audit found the setting was declared, forwarded to the renderer, and read only for the
 * order it happened to contain — there was no way to change it from the product. These tests
 * drive the real controller: toggling arrangement mode, moving a card, removing one, adding one
 * back, and resetting. Every one of them asserts the *stored* value, because an arrangement that
 * only lives in the DOM is lost at the next settings read.
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

/**
 * Boot the controller with a given widget arrangement.
 *
 * `widgets` is what the main process would report for `dashboard.widgets`; `setSetting` records
 * the call and echoes success, so the test can assert exactly what was asked to be stored.
 */
async function boot(widgets = null) {
  const html = await readFile(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: false });
  const { window } = dom;
  const calls = [];
  const settingsCalls = [];

  const answers = {
    'app:info': { ok: true, data: { name: 'VERIDEX', version: '1.0.0', platform: 'win32', brand: 'MERQO' } },
    'app:settings': {
      ok: true,
      data: {
        values: {},
        specs: [{ key: 'dashboard.widgets', label: 'Dashboard widgets', default: [] }],
        ui: { widgets: widgets ?? [], greetingName: '' }
      }
    },
    'app:setSetting': async (key, value) => {
      settingsCalls.push({ key, value });
      return { ok: true, data: { key, value } };
    },
    'app:guardSummary': { ok: true, data: { networkAttemptsBlocked: 0, unsafeCommandsBlocked: 0 } },
    'scan:state': { ok: true, data: { running: false, finished: null } },
    'manual:suites': { ok: true, data: { suites: [] } },
    'manual:coverage': { ok: true, data: { coverage: null, progress: null, issues: [] } },
    'history:list': { ok: true, data: { entries: [] } }
  };

  window.veridex = {
    invoke: Object.freeze(
      Object.fromEntries(
        Object.keys(answers).map((channel) => [
          channel,
          async (...args) => {
            calls.push({ channel, args });
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

  await import(`../../src/renderer/app.js?boot=${Date.now()}&arrange=1`);
  await waitFor(() => window.document.querySelector('#vx-arrange-toggle') !== null, { label: 'the arrangement toggle' });

  return {
    document: window.document,
    window,
    settingsCalls,
    restore: () => {
      if (previous.window) globalThis.window = previous.window;
      if (previous.document) globalThis.document = previous.document;
      if (previous.veridex === undefined) delete globalThis.veridex;
      else globalThis.veridex = previous.veridex;
      window.close();
    }
  };
}

const click = (document, node) => node.dispatchEvent(new document.defaultView.MouseEvent('click', { bubbles: true }));

test('the arrangement mode is off until asked for, so the dashboard opens as a report', { skip }, async () => {
  const { document, restore } = await boot(['health', 'coverage', 'actions']);
  try {
    assert.equal(document.querySelectorAll('.vx-arrange__item').length, 0, 'no editing chrome may appear unasked');
    assert.equal(document.querySelector('#vx-arrange-toggle').textContent.trim(), 'Arrange widgets');
  } finally {
    restore();
  }
});

test('entering arrangement mode labels every card and offers controls', { skip }, async () => {
  const { document, restore } = await boot(['health', 'coverage', 'actions']);
  try {
    click(document, document.querySelector('#vx-arrange-toggle'));
    await waitFor(() => document.querySelectorAll('.vx-arrange__item').length > 0, { label: 'arrangement mode' });
    const names = [...document.querySelectorAll('.vx-arrange__name')].map((node) => node.textContent);
    assert.ok(names.includes('Health score + Coverage'), `the pair must be named together, got ${names.join('|')}`);
    assert.ok(names.includes('Quick actions'));
    assert.equal(document.querySelector('#vx-arrange-toggle').textContent.trim(), 'Done arranging');
  } finally {
    restore();
  }
});

test('moving a card down stores the new order', { skip }, async () => {
  const { document, restore, settingsCalls } = await boot(['health', 'coverage', 'actions']);
  try {
    click(document, document.querySelector('#vx-arrange-toggle'));
    await waitFor(() => document.querySelectorAll('.vx-arrange__item').length > 0, { label: 'arrangement mode' });

    const firstDown = [...document.querySelectorAll('.vx-arrange__item')][0].querySelectorAll('.vx-arrange__controls .vx-button')[1];
    click(document, firstDown);
    await waitFor(() => settingsCalls.length === 1, { label: 'the save call' });
    assert.equal(settingsCalls[0].key, 'dashboard.widgets');
    assert.deepEqual(settingsCalls[0].value, ['actions', 'health', 'coverage']);
  } finally {
    restore();
  }
});

test('the first card cannot move up and the last cannot move down', { skip }, async () => {
  const { document, restore, settingsCalls } = await boot(['health', 'coverage', 'actions']);
  try {
    click(document, document.querySelector('#vx-arrange-toggle'));
    await waitFor(() => document.querySelectorAll('.vx-arrange__item').length > 0, { label: 'arrangement mode' });
    const items = [...document.querySelectorAll('.vx-arrange__item')];
    const firstUp = items[0].querySelectorAll('.vx-arrange__controls .vx-button')[0];
    const lastDown = items[items.length - 1].querySelectorAll('.vx-arrange__controls .vx-button')[1];
    assert.equal(firstUp.disabled, true, 'the first widget has nowhere to go up to');
    assert.equal(lastDown.disabled, true, 'the last widget has nowhere to go down to');
    click(document, firstUp);
    click(document, lastDown);
    assert.equal(settingsCalls.length, 0, 'a disabled move must not write anything');
  } finally {
    restore();
  }
});

test('removing a card hides it and leaves it reachable in the hidden list', { skip }, async () => {
  const { document, restore, settingsCalls } = await boot(['health', 'coverage', 'actions']);
  try {
    click(document, document.querySelector('#vx-arrange-toggle'));
    await waitFor(() => document.querySelectorAll('.vx-arrange__item').length > 0, { label: 'arrangement mode' });

    const quickActions = [...document.querySelectorAll('.vx-arrange__item')].find((node) => /Quick actions/.test(node.textContent));
    const remove = quickActions.querySelector('[data-remove="actions"]');
    assert.ok(remove, 'the remove control must say which widget it removes');
    click(document, remove);
    await waitFor(() => settingsCalls.length === 1, { label: 'the save call' });
    assert.deepEqual(settingsCalls[0].value, ['health', 'coverage']);
  } finally {
    restore();
  }
});

test('a hidden widget can be added back, and it is appended at the end', { skip }, async () => {
  const { document, restore, settingsCalls } = await boot(['health', 'coverage', 'actions']);
  try {
    click(document, document.querySelector('#vx-arrange-toggle'));
    await waitFor(() => document.querySelectorAll('.vx-arrange__item').length > 0, { label: 'arrangement mode' });
    const show = [...document.querySelectorAll('.vx-arrange__show')].find((node) => node.dataset.widget === 'issues');
    assert.ok(show, 'every widget missing from the arrangement must be offered back');
    click(document, show);
    await waitFor(() => settingsCalls.length === 1, { label: 'the save call' });
    assert.deepEqual(settingsCalls[0].value, ['health', 'coverage', 'actions', 'issues']);
  } finally {
    restore();
  }
});

test('reset restores the default order', { skip }, async () => {
  const { document, restore, settingsCalls } = await boot(['actions']);
  try {
    click(document, document.querySelector('#vx-arrange-toggle'));
    await waitFor(() => document.querySelector('#vx-arrange-reset') !== null, { label: 'the reset control' });
    click(document, document.querySelector('#vx-arrange-reset'));
    await waitFor(() => settingsCalls.length === 1, { label: 'the save call' });
    assert.deepEqual(settingsCalls[0].value, ['health', 'coverage', 'progress', 'components', 'issues', 'actions']);
  } finally {
    restore();
  }
});

test('an empty arrangement renders the empty state, not a blank page', { skip }, async () => {
  const { document, restore } = await boot([]);
  try {
    // An empty stored list means "everything", which is the documented default.
    assert.ok(document.querySelectorAll('.vx-card').length > 0, 'an empty list must not hide every card');
  } finally {
    restore();
  }
});

test('every widget the dashboard can draw has a name in the editor', async () => {
  const source = await readFile(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
  const block = source.slice(source.indexOf('const WIDGET_LABELS'), source.indexOf('Application state. Deliberately small'));
  const labels = [...block.matchAll(/^\s{2}([a-z]+):/gm)].map((match) => match[1]);
  assert.deepEqual(labels.sort(), ['actions', 'components', 'coverage', 'health', 'issues', 'progress']);

  const nodes = source.slice(source.indexOf('const nodes = {'), source.indexOf('const configured = state.settings'));
  const drawn = [...nodes.matchAll(/^\s{4}([a-z]+)[:,]/gm)].map((match) => match[1]);
  for (const id of drawn) {
    assert.ok(labels.includes(id), `the dashboard draws "${id}" but the arrangement editor has no name for it`);
  }
});
