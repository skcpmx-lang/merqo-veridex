/**
 * Interface feature tests — search, shortcuts, notifications, history comparison.
 *
 * These cover the four interface requirements that were still unimplemented after the audit
 * (R-20-02, R-21-01, R-22-01, R-24-02). Each test drives the *real* controller against a DOM
 * rather than asserting that a function exists, because "the code contains a shortcut" is not
 * the same claim as "pressing the shortcut opens the palette".
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

/** Boot the controller in live mode against a fake bridge. */
async function bootWithBridge(answers) {
  const html = await readFile(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: false });
  const { window } = dom;

  const calls = [];
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

  await import(`../../src/renderer/app.js?boot=${Date.now()}&ui=1`);
  await waitFor(() => window.document.querySelectorAll('.vx-nav__item').length > 0, { label: 'the shell' });
  await waitFor(() => window.document.querySelector('.vx-content') !== null, { label: 'the content region' });

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

const baseAnswers = (history = []) => ({
  'app:info': { ok: true, data: { name: 'VERIDEX', version: '1.0.0', platform: 'win32', brand: 'MERQO' } },
  'app:settings': { ok: true, data: { values: {}, specs: [] } },
  'app:guardSummary': { ok: true, data: { networkAttemptsBlocked: 0, unsafeCommandsBlocked: 0 } },
  'scan:state': { ok: true, data: { running: false, finished: null } },
  'manual:suites': { ok: true, data: { suites: [] } },
  'manual:coverage': { ok: true, data: { coverage: null, progress: null, issues: [] } },
  'history:list': { ok: true, data: { entries: history } },
  'report:save': { ok: false, error: { message: 'not in this test' } },
  'monitor:start': { ok: false, error: { message: 'not in this test' } }
});

/** Press a key on the document the way a user would. */
function press(document, key, modifiers = {}) {
  const event = new document.defaultView.KeyboardEvent('keydown', {
    key,
    ctrlKey: Boolean(modifiers.ctrl),
    shiftKey: Boolean(modifiers.shift),
    bubbles: true,
    cancelable: true
  });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

// ── Shortcuts ───────────────────────────────────────────────────────────────

test('every documented shortcut is unique and points at something that exists', async () => {
  const { SHORTCUTS } = await import('../../src/renderer/shortcuts.js');
  assert.ok(Array.isArray(SHORTCUTS) && SHORTCUTS.length >= 6);

  const combos = SHORTCUTS.map((entry) => entry.keys);
  assert.equal(new Set(combos).size, combos.length, 'two shortcuts must not share a key combination');

  // Ctrl+K and Ctrl+F both open search on purpose: one is the palette convention, the other
  // the find convention, and neither collides with a browser binding inside Electron.
  const actions = SHORTCUTS.map((entry) => entry.action);
  const allowed = new Set(['search', 'scan', 'escape', 'help', 'page:index']);
  for (const action of actions) {
    if (allowed.has(action)) continue;
    assert.match(action, /^page:[a-z]+$/, `${action} must be a page or a known action`);
  }

  for (const entry of SHORTCUTS) assert.ok(entry.label.trim().length > 0, 'every shortcut needs a description');

  // The page targets must be real pages, or the reference would describe a dead key.
  const { document, restore } = await bootWithBridge(baseAnswers());
  try {
    const pages = new Set([...document.querySelectorAll('.vx-nav__item')].map((node) => node.dataset.page));
    for (const action of actions) {
      if (!action.startsWith('page:') || action === 'page:index') continue;
      assert.ok(pages.has(action.slice(5)), `${action} targets a page that is not in the navigation`);
    }
  } finally {
    restore();
  }
});

test('Ctrl+K opens search and Enter navigates to the selected page', { skip }, async () => {
  const { document, restore } = await bootWithBridge(baseAnswers());
  try {
    press(document, 'k', { ctrl: true });
    await waitFor(() => document.querySelector('.vx-search__input') !== null, { label: 'the search palette' });
    const field = document.querySelector('.vx-search__input');
    assert.ok(field, 'Ctrl+K must open the search palette');

    field.value = 'histor';
    field.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));

    const results = [...document.querySelectorAll('.vx-search__result')];
    assert.ok(results.length >= 1, 'the query must match at least the history page');
    assert.match(results[0].textContent, /History/i);

    // Enter picks the highlighted result; the dialog closes and the page changes.
    field.dispatchEvent(new document.defaultView.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await waitFor(() => document.querySelector('.vx-topbar__title').textContent === 'History', { label: 'navigation to History' });
    assert.equal(document.querySelector('.vx-search__input'), null, 'the palette must close after choosing');
  } finally {
    restore();
  }
});

test('search finds settings by key and collected fields by label', { skip }, async () => {
  const answers = baseAnswers();
  answers['app:settings'] = {
    ok: true,
    data: {
      values: { privacy: 'balanced' },
      specs: [{ key: 'privacy', label: 'Privacy profile', default: 'balanced', description: 'How much is collected' }]
    }
  };
  const { document, restore } = await bootWithBridge(answers);
  try {
    press(document, 'k', { ctrl: true });
    await waitFor(() => document.querySelector('.vx-search__input') !== null, { label: 'the palette' });
    const field = document.querySelector('.vx-search__input');
    field.value = 'privacy';
    field.dispatchEvent(new document.defaultView.Event('input', { bubbles: true }));

    const results = [...document.querySelectorAll('.vx-search__result')];
    assert.ok(results.some((node) => /Privacy profile/.test(node.textContent)), 'the settings entry must be searchable by label');
    assert.ok(results.some((node) => /privacy/.test(node.textContent)));
  } finally {
    restore();
  }
});

test('Escape closes the dialog before it touches a scan', { skip }, async () => {
  const { document, restore } = await bootWithBridge(baseAnswers());
  try {
    press(document, 'k', { ctrl: true });
    await waitFor(() => document.querySelector('.vx-dialog'), { label: 'the dialog' });
    press(document, 'Escape');
    await waitFor(() => document.querySelector('.vx-dialog') === null, { label: 'the dialog to close' });
  } finally {
    restore();
  }
});

test('F1 lists every shortcut the handler knows', { skip }, async () => {
  const { document, restore } = await bootWithBridge(baseAnswers());
  try {
    const { SHORTCUTS } = await import('../../src/renderer/shortcuts.js');
    press(document, 'F1');
    await waitFor(() => document.querySelectorAll('.vx-keys__row').length > 0, { label: 'the shortcut reference' });
    const rows = document.querySelectorAll('.vx-keys__row');

    assert.equal(rows.length, SHORTCUTS.length, 'the reference must be generated from the same table');
    const text = document.querySelector('.vx-dialog').textContent;
    for (const shortcut of SHORTCUTS) assert.ok(text.includes(shortcut.keys), `${shortcut.keys} must be listed`);
  } finally {
    restore();
  }
});

// ── Notifications ───────────────────────────────────────────────────────────

test('a toast appears, is dismissable, and is capped in number', { skip }, async () => {
  const { window } = await bootWithBridge(baseAnswers());
  try {
    const { toast } = await import('../../src/renderer/ui.js');
    // Short timeouts on purpose: the assertions run synchronously, and a long timer would
    // keep the test process alive after the last assertion has passed.
    for (let index = 0; index < 6; index += 1) toast({ tone: 'info', title: `Event ${index}`, timeoutMs: 400 });

    const host = window.document.querySelector('.vx-toasts');
    assert.ok(host, 'the toast region must exist');
    // Inside the application column the stack holds two, because it takes layout space from the
    // page; a floating stack (no shell) still allows four.
    assert.equal(host.children.length, 1, 'the in-column stack shows one at a time');
    assert.match(host.textContent, /Event 5/, 'the newest toast must survive the cap');
    assert.ok(!/Event 4/.test(host.textContent), 'the superseded toast must be gone');

    // The page reserves room for the stack while it is on screen, so the last card is never
    // permanently underneath a notification.
    assert.equal(window.document.body.dataset.toasts, '1', 'the page must know a toast is on screen');

    const close = host.querySelector('.vx-toast__close');
    close.click();
    await waitFor(() => host.children.length === 0, { label: 'the dismissed toast to leave' });
    assert.equal(window.document.body.dataset.toasts, undefined, 'the marker must be released');

    for (const node of [...host.children]) host.removeChild(node);
    await waitFor(() => window.document.body.dataset.toasts === undefined, { label: 'the reserve to be released' });
  } finally {
    window.close();
  }
});

// ── History comparison ──────────────────────────────────────────────────────

const run = (id, score) => ({
  id,
  finishedAt: id === 'run-a' ? '2026-03-01T10:00:00.000Z' : '2026-03-04T10:00:00.000Z',
  assessment: { score, rating: 'Good', coveragePercent: 40, gated: false },
  coverage: { fields: 15 },
  issues: { errors: [], warnings: [] }
});

test('two runs can be marked and compared field by field', { skip }, async () => {
  const answers = baseAnswers([run('run-b', 82), run('run-a', 90)]);
  answers['history:compare'] = {
    ok: true,
    data: {
      before: { id: 'run-a', finishedAt: '2026-03-01T10:00:00.000Z', score: 90 },
      after: { id: 'run-b', finishedAt: '2026-03-04T10:00:00.000Z', score: 82 },
      summary: { changed: 2, added: 0, removed: 0, improved: 1, degraded: 1, neutral: 20 },
      top: [
        { path: 'thermal.cpuMaxC', before: 71, after: 88, delta: 17, percent: 23.9, kind: 'changed', verdict: 'degraded', direction: 'better-when-lower' },
        { path: 'battery.designCapacityMwh', before: 48000, after: 47000, delta: -1000, percent: -2.1, kind: 'changed', verdict: 'degraded', direction: 'better-when-higher' }
      ],
      differences: []
    }
  };

  const { document, calls, restore } = await bootWithBridge(answers);
  try {
    document.querySelector('.vx-nav__item[data-page="history"]').click();
    await waitFor(() => document.querySelectorAll('.vx-row__mark').length === 2, { label: 'the stored runs' });

    const marks = [...document.querySelectorAll('.vx-row__mark')];
    marks[0].click();
    await waitFor(() => document.querySelector('.vx-compare-bar').textContent.includes('One run marked'), { label: 'the first mark' });
    document.querySelectorAll('.vx-row__mark')[1].click();
    await waitFor(() => document.querySelector('.vx-compare-bar').textContent.includes('Two runs marked'), { label: 'the second mark' });

    const compare = [...document.querySelectorAll('.vx-compare-bar .vx-button')].find((node) => /Compare/.test(node.textContent));
    assert.ok(compare, 'the compare action must appear');
    assert.equal(compare.disabled, false, 'two marks must enable the comparison');
    compare.click();

    await waitFor(() => document.querySelector('.vx-compare'), { label: 'the comparison card' });
    const promise = waitFor(() => calls.some((call) => call.channel === 'history:compare'), { label: 'the comparison call' });
    await promise;

    const text = document.querySelector('.vx-compare').textContent;
    assert.match(text, /thermal\.cpuMaxC/, 'changed fields must be listed by path');
    assert.match(text, /degraded/, 'a regression must be named as one');
    assert.match(text, /71/, 'the earlier value must be shown');
    assert.match(text, /88/, 'the later value must be shown');
    assert.match(text, /Unchanged/, 'unchanged fields are counted, not listed');
  } finally {
    restore();
  }
});

test('a failed comparison reports the failure instead of an empty diff', { skip }, async () => {
  const answers = baseAnswers([run('run-b', 82), run('run-a', 90)]);
  answers['history:compare'] = { ok: false, error: { message: 'Run run-a has been pruned.' } };

  const { document, restore } = await bootWithBridge(answers);
  try {
    document.querySelector('.vx-nav__item[data-page="history"]').click();
    await waitFor(() => document.querySelectorAll('.vx-row__mark').length === 2, { label: 'the stored runs' });
    document.querySelectorAll('.vx-row__mark')[0].click();
    await waitFor(() => document.querySelectorAll('.vx-row__mark')[0].textContent === 'Marked', { label: 'the first mark' });
    document.querySelectorAll('.vx-row__mark')[1].click();
    const compare = [...document.querySelectorAll('.vx-compare-bar .vx-button')].find((node) => /Compare/.test(node.textContent));
    await waitFor(() => compare.disabled === false, { label: 'the compare action to enable' });
    compare.click();

    await waitFor(() => document.querySelector('.vx-callout--bad'), { label: 'the failure callout' });
    assert.match(document.querySelector('.vx-callout--bad').textContent, /has been pruned/);
    assert.equal(document.querySelector('.vx-compare'), null, 'a failed comparison must not render a diff');
  } finally {
    restore();
  }
});

// ── New diagnostic pages ────────────────────────────────────────────────────

test('the Reliability and Processes pages explain what they collect', { skip }, async () => {
  const { document, restore } = await bootWithBridge(baseAnswers());
  try {
    for (const [page, expectation] of [
      ['reliability', /event log/i],
      ['processes', /snapshot/i]
    ]) {
      document.querySelector(`.vx-nav__item[data-page="${page}"]`).click();
      await waitFor(() => document.querySelector('.vx-content').textContent.trim().length > 60, { label: `the ${page} page` });
      const text = document.querySelector('.vx-content').textContent;
      assert.match(text, expectation, `${page} must describe what it collects`);
      assert.ok(!/undefined|NaN|\[object Object\]/.test(text), `${page} leaked a raw value`);
    }
  } finally {
    restore();
  }
});

test('the Windows page names component-store health and never promises a repair', { skip }, async () => {
  const { document, restore } = await bootWithBridge(baseAnswers());
  try {
    document.querySelector('.vx-nav__item[data-page="windows"]').click();
    await waitFor(() => /Component-store health/.test(document.querySelector('.vx-content').textContent), { label: 'the component-store section' });
    const text = document.querySelector('.vx-content').textContent;
    assert.match(text, /never runs a repair|never changes/i, 'the read-only promise must be on the page');
  } finally {
    restore();
  }
});

// ── Rows that were recorded as "not started" but had shipped ────────────────

test('the About screen names the product, its author and the signing reality', { skip }, async () => {
  const { document, restore } = await bootWithBridge(baseAnswers());
  try {
    document.querySelector('.vx-nav__item[data-page="about"]').click();
    await waitFor(() => /Shohan Khan/.test(document.querySelector('.vx-content').textContent), { label: 'the About page' });
    const text = document.querySelector('.vx-content').textContent;
    assert.match(text, /MERQO/, 'the brand must be named');
    assert.match(text, /1\.0\.0/, 'the version must come from the bridge, not a placeholder');
    assert.match(text, /merqoonline@gmail\.com/, 'the contact address must be present');
    assert.match(text, /unsigned/i, 'the signing status must be stated');
  } finally {
    restore();
  }
});

test('both themes are defined and reduce motion is a real switch', async () => {
  const { themeTokens } = await import('../../src/renderer/theme.js');

  for (const theme of ['dark', 'light']) {
    const { tokens, mode } = themeTokens({ theme, accent: 'cyan', density: 'comfortable' });
    assert.equal(mode, theme);
    for (const key of ['--vx-bg', '--vx-ink', '--vx-accent', '--vx-ok', '--vx-warn', '--vx-bad']) {
      assert.ok(tokens[key], `${theme}: ${key} must be defined`);
    }
  }

  const dark = themeTokens({ theme: 'dark' }).tokens;
  const light = themeTokens({ theme: 'light' }).tokens;
  assert.notEqual(dark['--vx-bg'], light['--vx-bg'], 'the two themes must not share a background');

  const still = themeTokens({ theme: 'dark', reduceMotion: true }).tokens;
  assert.ok(['0ms', '0s'].includes(still['--vx-motion']), 'reduced motion must collapse the transition duration');
});

test('the dashboard shows device state rather than a decorative shell', { skip }, async () => {
  const { document, restore } = await bootWithBridge(baseAnswers());
  try {
    await waitFor(() => document.querySelector('.vx-content').textContent.trim().length > 60, { label: 'the dashboard' });
    const text = document.querySelector('.vx-content').textContent;
    assert.match(text, /Unrated|Not measured/, 'an unmeasured machine must not be presented as healthy');
    assert.ok(document.querySelectorAll('.vx-card').length >= 2, 'the dashboard is built from real cards');
    // Nothing is running, so there is nothing to cancel: a red button that would do nothing is
    // worse than no button.
    assert.equal(document.getElementById('vx-start-scan')?.disabled, false, 'a scan can be started');
    assert.equal(document.getElementById('vx-cancel-scan'), null, 'cancel is not offered while idle');
  } finally {
    restore();
  }
});

// ── The scan projection (found while wiring the new pages) ──────────────────

/**
 * The interface had no way to ask the main process for the results of a run: `scan:finished`
 * carries five numbers, and every diagnostic page read `state.scan.modules`, which nothing
 * assigned. A completed sweep therefore left the whole application saying "Not collected yet".
 */
const scanProjection = {
  startedAt: '2026-03-04T09:00:00.000Z',
  finishedAt: '2026-03-04T09:00:42.000Z',
  durationMs: 42_000,
  cancelled: false,
  taskCount: 20,
  providersAttempted: 33,
  assessment: {
    score: 84,
    rating: 'Good',
    status: 'WARNING',
    gated: false,
    ratedComponents: 9,
    totalComponents: 11,
    coveragePercent: 71.4,
    disclaimer: 'Scored only from the evidence collected.'
  },
  coverage: { assessed: 120, passed: 104, warned: 12, failed: 4, untested: 8, blocked: 2, unsupported: 14, coveragePercent: 71.4, note: 'Coverage counts automated fields that produced an assessment.' },
  issues: { warnings: ['battery.info: elevation required'], errors: [], conflicts: [] },
  modules: {
    cpu: {
      title: 'Processor',
      status: 'PASS',
      note: null,
      fields: {
        name: { value: 'Intel Core i7-1165G7', status: 'PASS', source: 'cim-win32.cpu', unit: null },
        cores: { value: 4, status: 'PASS', source: 'cim-win32.cpu', unit: null }
      }
    },
    windowsHealth: {
      title: 'Component store',
      status: 'WARNING',
      note: '1 field(s) warrant attention.',
      fields: {
        storeHealth: { value: 'REPAIRABLE', status: 'WARNING', source: 'dism.checkhealth', unit: null, notes: ['Repair is possible but nothing was run.'] }
      }
    }
  }
};

test('the scan:last projection reaches the interface, not just the event stream', { skip }, async () => {
  const answers = baseAnswers();
  answers['scan:last'] = { ok: true, data: { scan: scanProjection } };

  const { document, restore } = await bootWithBridge(answers);
  try {
    await waitFor(() => /84/.test(document.querySelector('.vx-content').textContent), { label: 'the adopted score' });
    const text = document.querySelector('.vx-content').textContent;
    assert.match(text, /84/, 'the score from the last scan must be shown');
    assert.match(text, /Good/, 'with its rating');
    assert.match(text, /71\.4%/, 'and the coverage the score was limited by');
    assert.match(text, /elevation required/, 'the warnings must be listed, not swallowed');
    assert.ok(document.querySelector('.vx-dial'), 'the score is rendered in the health dial');
  } finally {
    restore();
  }
});

test('a collected module renders its fields and its aggregate status', { skip }, async () => {
  const answers = baseAnswers();
  answers['scan:last'] = { ok: true, data: { scan: scanProjection } };

  const { document, restore } = await bootWithBridge(answers);
  try {
    document.querySelector('.vx-nav__item[data-page="windows"]').click();
    await waitFor(() => /Component-store health/.test(document.querySelector('.vx-content').textContent), { label: 'the Windows page' });
    const text = document.querySelector('.vx-content').textContent;
    assert.match(text, /Repairable|REPAIRABLE/, 'the component-store verdict must be shown, in DISM\'s own words');
    assert.match(text, /dism\.checkhealth/, 'the field must name the provider that produced it');

    // The card for a collected module must not say "Not collected yet". Sibling modules that
    // this run did not touch are allowed to say exactly that — inventing their fields would be
    // the lie, not the admission.
    const healthCard = [...document.querySelectorAll('.vx-card')].find((card) => /Component-store health/.test(card.textContent));
    assert.ok(healthCard, 'the component-store card must exist');
    assert.ok(!/Not collected yet/.test(healthCard.textContent), 'a collected module must not claim nothing was collected');
  } finally {
    restore();
  }
});

test('the contract declares scan:last, so the preload exposes it', async () => {
  const { CHANNELS, bridgeSurface } = await import('../../src/app/ipc-contract.js');
  assert.ok(CHANNELS['scan:last'], 'scan:last must be a declared channel');
  assert.deepEqual(CHANNELS['scan:last'].args, [], 'it takes no arguments');
  const surface = bridgeSurface();
  assert.ok(surface.invoke.includes('scan:last'), 'the bridge surface must include scan:last');
  assert.ok(surface.on.length > 0 && !surface.on.includes('scan:last'), 'it is a request, not an event');
});
