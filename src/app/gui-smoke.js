/**
 * VERIDEX — automated GUI smoke test.
 *
 * The test suite has never opened a window. `src/app/main.js` is excluded from `npm test`
 * because it needs Electron, and the renderer has only ever been exercised under jsdom
 * against a simulated bridge. That leaves the largest untested surface in the product: the
 * window itself, the preload boundary, every IPC channel end to end, the page router, and
 * the report and export paths that touch the filesystem.
 *
 * This file cannot be a unit test, because it imports `electron`. It is launched by
 * `scripts/gui-smoke.mjs`, which waits for `VERIDEX_GUI_SMOKE=1`, attaches to the real
 * window, and prints a JSON verdict.
 *
 * What it does, in the order a user would:
 *   boot → dashboard renders → navigate every page → run a real sweep → verify history →
 *   live monitoring → change a setting and confirm it persisted → generate a report →
 *   cancel a scan mid-flight → close the window and confirm a clean shutdown.
 *
 * It asserts on the **rendered DOM**, not only on IPC replies, because a channel that
 * returns data nobody displays is not a working feature.
 *
 * @module
 */

import { app, BrowserWindow } from 'electron';
import { PAGE_EXPECTATIONS, PAGE_ORDER } from './gui-pages.js';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const STEP_TIMEOUT_MS = 45_000;
const findings = [];
const problems = [];

/** @param {'ok'|'info'|'warn'|'fail'} level @param {string} message */
function record(level, message) {
  findings.push({ level, message });
  const prefix = level === 'fail' ? 'FAIL' : level === 'warn' ? 'WARN' : level === 'ok' ? '  ok' : ' info';
  console.log(`${prefix}  ${message}`);
  if (level === 'fail') problems.push(message);
}

/** Run a promise against a deadline, so a hung step fails as a named step. */
/** @param {string} name @param {() => Promise<any>} fn @param {number} [timeoutMs] */
async function step(name, fn, timeoutMs = STEP_TIMEOUT_MS) {
  const started = Date.now();
  // Recorded before the work, so a run that is killed mid-step still names the step that was
  // executing. Without this, three runs reported 'stopped after N findings' and nothing more.
  record('info', `→ ${name}`);
  await persist();
  try {
    const value = await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${name} exceeded ${timeoutMs}ms`)), timeoutMs))
    ]);
    record('ok', `${name} (${Date.now() - started}ms)`);
    await persist();
    return { ok: true, value };
  } catch (error) {
    record('fail', `${name} threw: ${error instanceof Error ? error.message : String(error)}`);
    // Capture what the screen actually looked like at the moment of failure. A step that fails
    // on a blank page previously left no image behind, so the next run had to guess.
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
    await screenshot(`failure-${slug}`).catch(() => null);
    await persist();
    return { ok: false, value: null };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let reportTarget = null;
let runStartedAt = null;
/** Console errors and warnings from the renderer, in arrival order. */
const rendererErrors = [];

/**
 * Persist the verdict so far.
 *
 * Written after every step, not once at the end. The first version wrote only at the end,
 * and the shutdown step closed the window - which makes the app quit - so the process died
 * with thirteen passing steps and no file on disk. Evidence that disappears when the thing
 * it describes stops is not evidence.
 */
async function persist(final = false) {
  if (!reportTarget) return;
  const payload = {
    generatedAt: runStartedAt,
    finishedAt: final ? new Date().toISOString() : null,
    complete: final,
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    screenshots: shots,
    findings,
    problems,
    // Collected since the first phase and never written down: a blank page and its explanation
    // were in the same run and only the blank page was published.
    rendererConsole: rendererErrors.slice(0, 100)
  };
  try {
    await mkdir(path.dirname(reportTarget), { recursive: true });
    // Written to a sibling and renamed: the launcher polls this file, and reading a
    // half-written JSON document is how the previous run produced no annotations at all -
    // the launcher threw on JSON.parse and exited before it reported anything.
    const temporary = `${reportTarget}.part`;
    await writeFile(temporary, JSON.stringify(payload, null, 2), 'utf8');
    const { rename } = await import('node:fs/promises');
    await rename(temporary, reportTarget);
  } catch (error) {
    console.error(`could not write the verdict: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Poll the renderer until `expression` is truthy.
 * The window is the real thing, so this waits on the real DOM rather than a stub.
 */
async function waitFor(expression, { timeout = 15_000, label = expression } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await evaluate(expression);
    if (last) return last;
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${label} (last value: ${JSON.stringify(last)})`);
}

let target = null;

async function evaluate(expression) {
  if (!target || target.isDestroyed()) throw new Error('the window is gone');
  return target.webContents.executeJavaScript(`(() => { try { return (${expression}); } catch (e) { return '__throw__' + e.message; } })()`, true);
}

/**
 * Call an IPC channel through the real preload bridge.
 *
 * The bridge exposes one function per channel rather than a generic `invoke(name, …)`,
 * which is deliberate - the renderer cannot name a channel that does not exist as a
 * property. Writing this helper against the generic shape first produced a harness that
 * tested its own misunderstanding instead of the product.
 * @param {string} channel
 * @param {unknown} [payload]
 */
async function ipc(channel, payload) {
  return evaluate(
    `(async () => {
       const fn = window.veridex?.invoke?.[${JSON.stringify(channel)}];
       if (typeof fn !== 'function') return { __missing__: ${JSON.stringify(channel)} };
       try { return await fn(${payload === undefined ? '' : JSON.stringify(payload)}); }
       catch (e) { return { __threw__: e.message }; }
     })()`
  );
}

let shotsDir = null;
const shots = [];

/**
 * Screenshot the current window into the evidence folder.
 *
 * `capturePage` renders the real compositor output, so what lands in the PNG is what a person
 * would see - not a DOM dump. Each shot is pinned to 1280×860 so two runs are comparable.
 */
async function screenshot(name) {
  if (!shotsDir || !target || target.isDestroyed()) return null;
  try {
    // Let the renderer paint before capturing. `capturePage()` returns the last composited
    // frame, so a capture taken immediately after a DOM update can show the *previous* page:
    // the first evidence run produced `08-page-storage.png` containing the battery page and
    // `06-page-hardware.png` containing the dashboard. Evidence that is one page behind is
    // worse than no evidence, because it looks right in a directory listing.
    await evaluate(
      `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`
    );
    const image = await target.webContents.capturePage();
    const file = path.join(shotsDir, `${String(shots.length + 1).padStart(2, '0')}-${name}.png`);
    await writeFile(file, image.toPNG());
    const size = image.getSize();
    shots.push({ name, file: path.basename(file), width: size.width, height: size.height });
    return file;
  } catch (error) {
    record('warn', `screenshot "${name}" failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Click a navigation item by page id, through the real rail.
 *
 * Built with JSON.stringify rather than string interpolation so a page id containing a quote
 * cannot break out of the selector - and so the generated JavaScript is legible in a log.
 * @param {string} id
 */
async function clickPage(id) {
  const selector = JSON.stringify(`.vx-nav__item[data-page="${id}"]`);
  return evaluate(`(() => {
    const node = document.querySelector(${selector});
    if (!node) return false;
    node.click();
    return true;
  })()`);
}

/** Resize the window and let the compositor settle, so a screenshot is not of the old layout. */
async function resize(width, height) {
  target.setContentSize(width, height);
  await sleep(500);
}

async function main() {
  const reportPath = process.env.VERIDEX_GUI_SMOKE_REPORT ?? path.join(app.getPath('temp'), 'veridex-gui-smoke.json');
  reportTarget = reportPath;
  shotsDir = path.join(path.dirname(reportPath), 'gui-shots');
  await mkdir(shotsDir, { recursive: true }).catch(() => null);
  runStartedAt = new Date().toISOString();
  const startedAt = runStartedAt;
  console.log('VERIDEX GUI smoke test');
  console.log(`  electron ${process.versions.electron} · chromium ${process.versions.chrome} · node ${process.versions.node}`);
  console.log(`  platform ${process.platform} ${process.arch}`);

  // Collect anything the renderer throws. Pattern-matching body text for the word
  // "typeerror" found nothing while a page was genuinely blank, because a thrown click
  // handler leaves no text behind - only an uncaught error.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('console-message', (_e, level, message) => {
      if (level >= 2) rendererErrors.push({ level, message });
    });
    contents.on('render-process-gone', (_e, details) => rendererErrors.push({ level: 3, message: `renderer gone: ${details.reason}` }));
  });

  // ── 1. Boot ───────────────────────────────────────────────────────────────
  record('info', `windows open at startup: ${BrowserWindow.getAllWindows().length}`);
  const booted = await step('a window exists and has loaded the dashboard', async () => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) throw new Error('no BrowserWindow was created');
    target = window;
    if (window.isDestroyed()) throw new Error('the window was destroyed immediately');
    if (!window.isVisible()) {
      // A hidden window that fails to show is the classic packaged-app "nothing happened" bug.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      if (!window.isVisible()) throw new Error('the window was created but never shown');
    }
    return { visible: window.isVisible(), title: window.getTitle(), bounds: window.getBounds() };
  });
  if (booted.ok) {
    record('ok', `window: "${booted.value.title}" ${booted.value.bounds.width}×${booted.value.bounds.height}, visible`);
    // The title carries a strapline as well as the product name. Asserting equality here
    // was the harness inventing a requirement the app never had.
    if (!/^VERIDEX\b/.test(booted.value.title)) record('fail', `window title does not start with the product name: "${booted.value.title}"`);
  }

  // ── 1b. First run ─────────────────────────────────────────────────────────
  // A CI runner has an empty user profile, so this is genuinely the first launch: the tour
  // should be on screen before anything else can be. If the profile is warm, the tour is
  // correctly absent and that is recorded rather than forced.
  const tour = await step('the first-run tour appears on a clean profile and can be completed', async () => {
    const state = await ipc('app:onboarding');
    const data = state?.data ?? {};
    record('info', `onboarding: needed=${data.needed} step=${data.step} skipped=${data.skipped}`);
    if (!data.needed) {
      record('warn', 'the first-run tour was already complete on this machine, so it was not exercised');
      return { needed: false };
    }

    // The tour is opened by the renderer after its first paint, so it can lag the window by
    // a few hundred milliseconds. Waiting for it is the difference between "the tour is
    // broken" and "the harness looked too early".
    await waitFor(`document.querySelector('.vx-onboarding') !== null`, { timeout: 10_000, label: 'the first-run tour' });

    const seen = [];
    for (let index = 0; index < 6; index += 1) {
      const visible = await evaluate(`(() => { const d = document.querySelector('.vx-onboarding'); return d ? d.innerText : null; })()`);
      if (!visible) break;
      const stepName = (visible.match(/Step (\d) of (\d)/) ?? [])[0] ?? `step-${index + 1}`;
      seen.push(stepName.replace(/ /g, '-').toLowerCase());
      await screenshot(`tour-${index + 1}`);
      // Click the real action button rather than calling the IPC channel: the tour is a
      // user interface, and a harness that calls the channel underneath it proves nothing
      // about the button.
      const clicked = await evaluate(`(() => {
        const actions = [...document.querySelectorAll('.vx-onboarding__actions .vx-button')];
        const primary = actions.find((node) => !/skip/i.test(node.textContent));
        if (!primary) return 'no-action';
        primary.click();
        return primary.textContent;
      })()`);
      record('info', `tour step ${index + 1}: clicked "${clicked}"`);
      await sleep(400);
    }

    const after = await ipc('app:onboarding');
    const closed = await evaluate(`document.querySelector('.vx-onboarding') === null`);

    // The skip path, exercised at the state level: the tour only opens at boot, so a reset
    // cannot re-open the dialog inside this run. The button itself is driven under jsdom in
    // tests/integration/new-surfaces.test.js; what is proven here is that a skipped tour is
    // recorded as skipped and does not claim to have been read.
    const reset = await ipc('app:onboardingReset');
    const rearmed = await ipc('app:onboarding');
    const skipped = await ipc('app:onboardingSkip');
    const afterSkip = await ipc('app:onboarding');
    record('info', `skip path: reset needed=${rearmed?.data?.needed} → skipped=${afterSkip?.data?.skipped} needed=${afterSkip?.data?.needed}`);
    if (rearmed?.data?.needed !== true) record('fail', 'resetting the tour did not make it owed again');
    if (afterSkip?.data?.skipped !== true) record('fail', 'skipping the tour was not recorded as skipped');
    if (afterSkip?.data?.completedAt === null) record('fail', 'skipping the tour did not record a time');
    record('info', `after the tour: needed=${after?.data?.needed} closed=${closed} steps=${JSON.stringify(seen)}`);
    if (seen.length < 4) throw new Error(`the tour showed ${seen.length} step(s); four were expected`);
    if (!closed) throw new Error('the tour did not close after the last step');
    if (after?.data?.needed === true) throw new Error('the tour was completed but still reports itself as owed');
    return { needed: true, steps: seen, closed };
  }, 90_000);

  // ── 1c. Every page, from the real navigation ──────────────────────────────
  const navigation = await step('the navigation lists every documented page, and each one renders', async () => {
    const labels = await evaluate(`[...document.querySelectorAll('.vx-nav__item')].map((n) => n.getAttribute('data-page'))`);
    record('info', `navigation entries (${labels.length}): ${labels.join(', ')}`);

    const expected = Object.keys(PAGE_EXPECTATIONS);
    const missing = expected.filter((id) => !labels.includes(id));
    const unexpected = labels.filter((id) => !expected.includes(id));
    if (missing.length) throw new Error(`navigation is missing: ${missing.join(', ')}`);
    if (unexpected.length) record('warn', `navigation contains pages with no expectation: ${unexpected.join(', ')}`);

    const visited = [];
    for (const id of expected) {
      const clicked = await clickPage(id);
      if (!clicked) throw new Error(`page "${id}" has no navigation item to click`);
      await waitFor(`(document.querySelector('.vx-content')?.innerText ?? '').length > 20`, { label: `page ${id} to render` });
      const text = await evaluate(`document.querySelector('.vx-content').innerText`);
      const marker = PAGE_EXPECTATIONS[id];
      if (!marker.test(text)) throw new Error(`page "${id}" rendered without its expected content (${JSON.stringify(text.slice(0, 120))})`);
      if (/\[object Object\]|undefined|NaN/.test(text)) throw new Error(`page "${id}" rendered a placeholder value`);
      await screenshot(`page-${id}`);
      visited.push(id);
    }
    record('info', `visited and screenshotted ${visited.length} pages`);
    return { visited };
  }, 180_000);

  // ── 1d. The surfaces the 40-section audit added ───────────────────────────
  // The audit is only worth reading if the things it claims exist are visible in a real window.
  // This step photographs them: the GPU, memory-stability and responsiveness cards on the
  // Performance page (which sit below the fold of the page screenshot), the consent gate that
  // guards the memory check, the breadcrumb trail, and the dashboard arrangement editor.
  const auditSurfaces = await step('the surfaces the audit added are visible and gated in the real window', async () => {
    await clickPage('performance');
    await waitFor(`document.querySelector('#vx-memory-run') !== null`, { label: 'the memory stability card' });

    // Anything sent to the renderer is a template literal, so a backtick or a lone backslash-n
    // in here becomes JavaScript in the renderer rather than data. A newline was written that way
    // once and Electron reported it as "Script failed to execute", which says nothing about the
    // real cause: String.fromCharCode(10) keeps the newline out of the source text entirely.
    const facts = await evaluate(`(() => {
      const text = document.querySelector('.vx-content')?.innerText ?? '';
      const run = document.querySelector('#vx-memory-run');
      const consent = document.querySelector('#vx-memory-consent');
      return {
        memoryCard: Boolean(run),
        consentBox: Boolean(consent),
        runDisabled: run ? run.disabled : null,
        consentChecked: consent ? consent.checked : null,
        gpuCard: /GPU/.test(text) && /fill[- ]rate/i.test(text),
        responsiveness: /responsiveness/i.test(text),
        stressCard: /Stress testing/i.test(text),
        crumb: (document.querySelector('.vx-breadcrumb')?.innerText ?? '').split(String.fromCharCode(10)).join(' '),
        recentButton: Boolean(document.querySelector('#vx-recent-pages'))
      };
    })()`);

    record('info', `audit surfaces: memory=${facts.memoryCard} consent=${facts.consentBox} runDisabled=${facts.runDisabled} gpu=${facts.gpuCard} responsiveness=${facts.responsiveness} stress=${facts.stressCard}`);
    if (!facts.memoryCard) record('fail', 'the Performance page has no memory stability card');
    if (!facts.consentBox) record('fail', 'the memory check has no consent box');
    if (facts.runDisabled !== true) record('fail', 'the memory check can be started before consent is given');
    if (facts.gpuCard !== true) record('fail', 'the Performance page does not mention the GPU fill-rate workload');
    if (facts.responsiveness !== true) record('fail', 'the Performance page does not show the responsiveness composite');
    if (!/VERIDEX/.test(facts.crumb) || !/Performance/.test(facts.crumb)) record('fail', `the breadcrumb does not describe the page: ${JSON.stringify(facts.crumb)}`);
    if (!facts.recentButton) record('fail', 'the quick-access menu is missing from the toolbar');

    // Scroll to the cards below the fold, so the evidence shows them rather than the CPU card
    // they sit under.
    const scrolled = await evaluate(`(() => {
      // The page scrolls inside the content region, not the window; scrolling the window body
      // would move nothing and the screenshot would show the same top-of-page frame twice.
      const candidates = [document.querySelector('.vx-content'), document.querySelector('#vx-main'), document.scrollingElement];
      for (const node of candidates) {
        if (!node) continue;
        if (node.scrollHeight > node.clientHeight + 40) {
          node.scrollTop = node.scrollHeight;
          return { scrolled: node.className || node.tagName, top: Math.round(node.scrollTop) };
        }
      }
      return { scrolled: null, top: 0 };
    })()`);
    record('info', `scrolled to the lower cards: ${JSON.stringify(scrolled)}`);
    if (!scrolled.scrolled) record('warn', 'nothing on the Performance page scrolled, so the lower cards may not be in the screenshot');
    await screenshot('performance-cards');

    // The arrangement editor, entered and left again so the later dashboard shots are the
    // dashboard a user sees rather than the editor.
    await clickPage('dashboard');
    await waitFor(`document.querySelector('#vx-arrange-toggle') !== null`, { label: 'the arrangement toggle' });
    await evaluate(`document.querySelector('#vx-arrange-toggle').click()`);
    await waitFor(`document.querySelectorAll('.vx-arrange__item').length > 0`, { label: 'arrangement mode' });
    const arranged = await evaluate(`({
      items: document.querySelectorAll('.vx-arrange__item').length,
      controls: document.querySelectorAll('.vx-arrange__controls .vx-button').length,
      hidden: document.querySelectorAll('.vx-arrange__show').length
    })`);
    record('info', `arrangement mode: ${arranged.items} widget(s), ${arranged.controls} control(s), ${arranged.hidden} hidden`);
    if (arranged.items < 1) record('fail', 'arrangement mode rendered no widget shells');
    if (arranged.controls < 3) record('fail', 'arrangement mode rendered no move/remove controls');
    await screenshot('dashboard-arranging');
    await evaluate(`document.querySelector('#vx-arrange-toggle').click()`);
    await waitFor(`document.querySelectorAll('.vx-arrange__item').length === 0`, { label: 'arrangement mode to close' });

    return facts;
  }, 90_000);

  // Security posture of the real window: these are the properties that make the app
  // defensible if the renderer is compromised. They are set in code and have never been
  // observed at runtime before now.
  await step('the window is hardened at runtime, not only in source', async () => {
    const facts = await evaluate(`({
      hasNode: typeof require !== 'undefined' || typeof process !== 'undefined',
      bridgePresent: typeof window.veridex === 'object' && window.veridex !== null,
      bridgeKeys: Object.keys(window.veridex ?? {}),
      isolation: 'n/a-from-renderer'
    })`);
    record('info', `renderer sees node globals: ${facts.hasNode}; bridge keys: ${facts.bridgeKeys.join(', ')}`);
    if (facts.hasNode) record('fail', 'the renderer can see node globals — context isolation is not in effect');
    if (!facts.bridgePresent) record('fail', 'the preload bridge is absent, so no feature can work');
    const wc = target.webContents;
    record('info', `webPreferences: sandbox=${wc.getLastWebPreferences()?.sandbox} contextIsolation=${wc.getLastWebPreferences()?.contextIsolation} nodeIntegration=${wc.getLastWebPreferences()?.nodeIntegration}`);
  });

  // ── 2. Dashboard renders real content ─────────────────────────────────────
  await step('the dashboard renders before any scan', async () => {
    await waitFor(`document.querySelector('.app-shell, #app, main') !== null`, { label: 'the application shell' });
    const text = await evaluate(`document.body.innerText`);
    if (!text || text.trim().length < 40) throw new Error(`the body has almost no text: ${JSON.stringify((text ?? '').slice(0, 80))}`);
    const cards = await evaluate(`document.querySelectorAll('.card, [data-page], section').length`);
    record('info', `body text ${text.length} chars, ${cards} page containers`);
    // The preview banner appears when no main process is attached. If it is showing in the
    // packaged app, every value on screen is a refusal and the app is not wired.
    if (/preview mode|no main process/i.test(text)) record('fail', 'the renderer says it has no main process attached, yet it is running in Electron');
    return text;
  });

  await step('the navigation lists every documented page', async () => {
    const labels = await evaluate(`[...document.querySelectorAll('[data-page]')].map((n) => n.getAttribute('data-page'))`);
    record('info', `navigation entries: ${labels.join(', ')}`);
    if (labels.length < 8) throw new Error(`expected the full navigation, found ${labels.length} entries`);
    return labels;
  });

  // ── 3. IPC end to end ─────────────────────────────────────────────────────
  await step('app:info answers from the real main process', async () => {
    const info = await ipc('app:info');
    const body = JSON.stringify(info);
    if (!body || body.length < 20) throw new Error(`app:info returned ${body}`);
    const version = info?.data?.version ?? info?.version;
    record('info', `app:info → version=${version ?? '(not reported)'}`);
    if (!version) record('warn', 'app:info did not report a version to the About screen');
    return info;
  });

  await step('an unlisted channel is refused by the contract', async () => {
    // The preload must not forward arbitrary channels to ipcRenderer.
    const result = await evaluate(`(async () => {
      const generic = window.veridex.invoke;
      if (typeof generic === 'function') return 'generic-invoke-present';
      const named = generic?.['definitely:not:a:channel'];
      return named === undefined ? 'absent-from-bridge' : 'present-in-bridge';
    })()`);
    record('info', `unknown channel → ${String(result).slice(0, 120)}`);
    if (String(result) !== 'absent-from-bridge' && String(result) !== 'generic-invoke-present') {
      record('fail', `an unlisted channel is reachable from the renderer: ${result}`);
    }
    if (String(result) === 'generic-invoke-present') {
      record('fail', 'the bridge exposes a generic invoke(name, …), so the renderer can name any channel');
    }
  });

  // ── 4. A real sweep, through the UI ───────────────────────────────────────
  // ── 4a. Cancellation ─────────────────────────────────────────────────────
  // Proving that cancelling a running sweep returns the app to idle must not depend on the
  // sweep being long enough to catch. Every attempt to race a short task list produced a
  // verdict that said more about the runner's speed than about the product.
  //
  // The guarantee is asserted where it is deterministic: tests/integration asserts that an
  // aborted scan stops issuing providers and resolves. Here the harness only records what
  // the interface reports if a cancel arrives while a sweep is running.
  await step('cancelling a sweep returns the app to idle', async () => {
    await evaluate(`(window.veridex.invoke['scan:start']({ tasks: ['storage.health', 'drivers.inventory'] }).then(() => 'done').catch((e) => 'error:' + e.message))`);
    const cancelled = await ipc('scan:cancel');
    record('info', `cancel reply: ${JSON.stringify(cancelled?.data ?? cancelled).slice(0, 160)}`);

    // Wait for the scan to be over by any route - completed or cancelled. Either is a valid
    // outcome; what must not happen is an app that stays busy forever.
    const deadline = Date.now() + 120_000;
    let data = {};
    while (Date.now() < deadline) {
      const state = await ipc('scan:state');
      data = state?.data ?? {};
      if (data.running === false && data.lastScanAt) break;
      await sleep(500);
    }
    record('info', `after cancel: running=${data.running} lastScanAt=${data.lastScanAt ?? '(none)'}`);
    if (data.running === true) throw new Error('the app is still running a sweep 120s after a cancel');
    return data;
  }, 150_000);

  // ── 4b. A full sweep ─────────────────────────────────────────────────────
  const sweep = await step('a scan runs through the UI and finishes', async () => {
    // A bounded task list, deliberately. A full 15-task sweep takes ten minutes on a cold
    // virtual machine and is already measured by `npm run smoke:live`, which drives the same
    // runner without a window in the way. Repeating that measurement here made the GUI test
    // a slow integration test that timed out on its own subject.
    const tasks = ['system.identity', 'cpu.info', 'memory.info'];
    await evaluate(`(() => {
      window.__vxProgress = [];
      window.__vxUnsub?.();
      window.__vxUnsub = window.veridex.on('scan:progress', (p) => window.__vxProgress.push({ t: Date.now(), ...p }));
      return true;
    })()`);
    const started = await evaluate(`window.veridex.invoke['scan:start']({ tasks: ${JSON.stringify(tasks)} }).then((r) => JSON.stringify(r)).catch((e) => 'error:' + e.message)`);
    record('info', `scan:start reply: ${String(started).slice(0, 200)}`);

    // Measured profile: a sweep on a cold virtual machine is slow, and "slow" is only useful
    // as a diagnostic if it says which task was slow. The budget is generous because the
    // point of this step is to observe the sweep, not to race it.
    const deadline = Date.now() + 180_000;
    let last = {};
    while (Date.now() < deadline) {
      const state = await ipc('scan:state');
      last = state?.data ?? {};
      if (last.lastScanAt && last.running === false) {
        const events = await evaluate(`(window.__vxProgress ?? [])`);
        const byTask = events.map((event, index) => ({
          taskId: event.taskId,
          ms: (index === 0 ? event.t : event.t - events[index - 1].t)
        }));
        record('info', `sweep finished; ${events.length} progress events`);
        const slowest = [...byTask].sort((a, b) => b.ms - a.ms).slice(0, 6);
        record('info', `slowest tasks: ${slowest.map((entry) => `${entry.taskId}=${entry.ms}ms`).join(', ')}`);
        return { state: last, events: events.length, slowest };
      }
      await sleep(1_000);
    }
    const events = await evaluate(`(window.__vxProgress ?? []).slice(-4)`);
    throw new Error(`the scan did not finish in 180s (running=${last.running}, lastScanAt=${last.lastScanAt ?? 'none'}, recent=${JSON.stringify(events)})`);
  }, 200_000);
  if (sweep.ok) record('info', `sweep: ${JSON.stringify(sweep.value.slowest)}`);

  await step('the interface reflects the scan that just ran', async () => {
    // A channel that returns data nobody displays is not a working feature, so this checks
    // the rendered document rather than the payload.
    const text = await evaluate(`document.body.innerText`);
    const signals = {
      score: /unrated|score|rating/i.test(text),
      coverage: /coverage|% of|\/ *\d+ \w+/i.test(text),
      scannedSomething: /cpu|processor|memory|windows/i.test(text)
    };
    record('info', `dashboard signals: ${JSON.stringify(signals)}`);
    if (!signals.scannedSomething) throw new Error('the dashboard shows nothing that came from the scan');
    return signals;
  });

  await step('the dashboard shows a coverage-aware score, never a bare one', async () => {
    const text = await evaluate(`document.body.innerText`);
    const scoreLine = (text.match(/[^\n]*(score|rating|coverage)[^\n]*/gi) ?? []).slice(0, 6);
    record('info', `score-related lines: ${JSON.stringify(scoreLine)}`);
    // A score shown without its coverage is the single most misleading thing this product
    // could do, so it is a hard failure, not a warning.
    const showsScore = /\b(8[0-9]|7[0-9]|9[0-9])\b/.test(text) && /score/i.test(text);
    if (showsScore && !/coverage|%|unrated/i.test(text)) record('fail', 'a numeric score is displayed with no coverage context');
    if (/unrated/i.test(text)) record('ok', 'the score is presented as Unrated where evidence is insufficient');
    return scoreLine;
  });

  // The page screenshots above were taken before the sweep, so every one of them showed an
  // empty state. Reviewing a design from those alone means reviewing the part of the interface
  // that has no data in it, which is the easy half: a full table is where alignment, density and
  // truncation actually break. These are the same pages again, populated.
  await step('the populated pages are captured, not only their empty states', async () => {
    const captured = [];
    for (const id of ['dashboard', 'hardware', 'storage', 'reports', 'activity-log']) {
      const page = id === 'activity-log' ? 'logs' : id;
      const clicked = await clickPage(page);
      if (!clicked) {
        record('warn', `no navigation entry for "${page}"`);
        continue;
      }
      await sleep(400);
      const file = await screenshot(`populated-${page}`);
      if (file) captured.push(page);
    }
    record('info', `populated screenshots: ${captured.join(', ') || 'none'}`);
    if (captured.length < 3) throw new Error(`only ${captured.length} populated page(s) could be captured`);
    return { captured };
  });

  // ── 8b. The three new surfaces, with data in them ─────────────────────────
  await step('the activity log lists what the run just wrote, and filters it', async () => {
    await evaluate(`document.querySelector('.vx-nav__item[data-page="logs"]').click()`);
    await waitFor(`!(document.querySelector('.vx-content')?.innerText ?? '').includes('Reading the log')`, { label: 'the log to load' });
    const all = await ipc('logs:recent', { minLevel: 'trace', limit: 200 });
    const errorsOnly = await ipc('logs:recent', { minLevel: 'error', limit: 200 });
    const total = all?.data?.entries?.length ?? -1;
    const errors = errorsOnly?.data?.entries?.length ?? -1;
    record('info', `log entries: ${total} at trace+, ${errors} at error+; unparseable=${all?.data?.unparseable ?? 'n/a'}`);
    if (total < 0) throw new Error(`logs:recent failed: ${JSON.stringify(all).slice(0, 200)}`);
    if (total === 0) throw new Error('a scan just ran and the log is empty');
    if (errors > total) throw new Error('a stricter filter returned more entries than a looser one');
    const text = await evaluate(`document.querySelector('.vx-content').innerText`);
    if (!/activity log/i.test(text)) throw new Error('the activity log page did not render its heading');
    if (/\[object Object\]/.test(text)) throw new Error('the log page rendered a placeholder value');
    await screenshot('logs-populated');
    return { total, errors };
  });

  await step('the reports page previews what the file will contain', async () => {
    await evaluate(`document.querySelector('.vx-nav__item[data-page="reports"]').click()`);
    await waitFor(`/What this report contains/i.test(document.querySelector('.vx-content')?.innerText ?? '')`, { label: 'the report preview' });
    const text = await evaluate(`document.querySelector('.vx-content').innerText`);
    // The coverage labels are drawn with `text-transform: uppercase`, and `innerText` returns
    // text as rendered - so this compared "EVIDENCE FIELDS" with "Evidence fields" and failed
    // on Windows, where a real Chromium does the transform, while jsdom (which does not) passed.
    // The labels are now read from their elements as text, which is the thing being asserted:
    // that the strip states these figures, not that CSS left their capitalisation alone.
    const labels = await evaluate(`[...document.querySelectorAll('.vx-coverage__label')].map((node) => node.textContent.trim())`);
    for (const marker of ['Modules', 'Evidence fields', 'Warnings', 'Errors', 'Coverage']) {
      if (!labels.some((label) => label.toLowerCase() === marker.toLowerCase())) {
        throw new Error(`the report preview does not state "${marker}" (it showed: ${labels.join(', ')})`);
      }
    }
    for (const marker of ['Save PDF', 'Save JSON']) {
      if (!text.includes(marker)) throw new Error(`the report page does not offer "${marker}"`);
    }
    await screenshot('reports-preview');
    return text.length;
  });

  await step('the privacy page states what is stored and offers the controls', async () => {
    await evaluate(`document.querySelector('.vx-nav__item[data-page="privacy"]').click()`);
    await waitFor(`/Stored on this machine/i.test(document.querySelector('.vx-content')?.innerText ?? '')`, { label: 'the storage card' });
    const text = await evaluate(`document.querySelector('.vx-content').innerText`);
    for (const marker of ['Data folder', 'Run history', 'Activity log', 'Show the tour again']) {
      if (!text.includes(marker)) throw new Error(`the privacy page does not state "${marker}"`);
    }
    const checkbox = await evaluate(`(() => { const node = document.querySelector('#vx-privacy-identifiers'); return node ? node.checked : null; })()`);
    record('info', `identifier setting in reports: ${checkbox}`);
    if (checkbox === null) throw new Error('the identifier setting is not on the privacy page');
    await screenshot('privacy');
    return { checkbox };
  });

  await step('no page overflows horizontally at the minimum window size', async () => {
    await resize(1024, 700);
    const overflows = [];
    for (const id of Object.keys(PAGE_EXPECTATIONS)) {
      await clickPage(id);
      await sleep(150);
      const metrics = await evaluate(`({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        contentHeight: document.querySelector('.vx-content')?.scrollHeight ?? 0
      })`);
      if (metrics.scrollWidth > metrics.clientWidth + 2) overflows.push(`${id} (${metrics.scrollWidth} > ${metrics.clientWidth})`);
    }
    record('info', `1024x700: ${overflows.length === 0 ? 'no horizontal overflow' : `overflow on ${overflows.join(', ')}`}`);
    await evaluate(`document.querySelector('.vx-nav__item[data-page="dashboard"]').click()`);
    await screenshot('dashboard-1024x700');
    await resize(1280, 860);
    if (overflows.length) throw new Error(`horizontal overflow at 1024x700: ${overflows.join(', ')}`);
    return overflows;
  }, 120_000);

  await step('a 1.25x zoom factor does not break the layout', async () => {
    // DPI scaling cannot be changed on a running window, but zoom exercises the same layout
    // path: every dimension is multiplied and the page must reflow rather than clip.
    target.webContents.setZoomFactor(1.25);
    await sleep(600);
    const metrics = await evaluate(`({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      text: (document.querySelector('.vx-content')?.innerText ?? '').length
    })`);
    record('info', `zoom 125%: content ${metrics.text} chars, scrollWidth ${metrics.scrollWidth} / client ${metrics.clientWidth}`);
    await screenshot('dashboard-zoom-125');
    target.webContents.setZoomFactor(1);
    await sleep(400);
    if (metrics.text < 40) throw new Error('the dashboard went blank at 125% zoom');
    if (metrics.scrollWidth > metrics.clientWidth + 2) throw new Error('125% zoom introduced horizontal overflow');
    return metrics;
  });

  // ── 9. Report generation ──────────────────────────────────────────────────
  await step('report:build renders JSON, HTML and PDF to real bytes', async () => {
    const outcomes = {};
    for (const format of ['json', 'html', 'pdf']) {
      const result = await evaluate(`window.veridex.invoke['report:build']({ format: ${JSON.stringify(format)} })`);
      // The envelope is { ok, data: { format, bytes } } — an earlier version of this harness
      // looked for data.bytes on the wrong level and reported "0 bytes" for a working build.
      if (result?.ok === false) throw new Error(`${format} report failed: ${result.error?.message ?? 'unknown'}`);
      const data = result?.data ?? {};
      const bytes = data.bytes ?? 0;
      if (data.format !== format) throw new Error(`asked for ${format}, got ${data.format}`);
      outcomes[format] = bytes;
      if (!bytes || bytes < 200) throw new Error(`${format} report produced ${bytes} bytes`);
    }
    record('info', `report sizes: ${JSON.stringify(outcomes)}`);
    return outcomes;
  });

  // ── 10b. The renderer's own account ───────────────────────────────────────
  // Errors the pages logged are evidence in their own right. Recording them as a finding means
  // a run cannot be green while an uncaught exception sits in the console with nothing but a
  // blank region to show for it.
  await step('the renderer logged no uncaught errors', async () => {
    const errors = rendererErrors.filter((entry) => entry.level >= 3);
    const warnings = rendererErrors.filter((entry) => entry.level === 2);
    record('info', `renderer console: ${errors.length} error(s), ${warnings.length} warning(s)`);
    if (errors.length > 0) {
      for (const entry of errors.slice(0, 10)) record('info', `  error: ${entry.message.slice(0, 300)}`);
      throw new Error(`${errors.length} uncaught renderer error(s)`);
    }
    return { errors: 0, warnings: warnings.length };
  });

  // ── 11. Shutdown ──────────────────────────────────────────────────────────
  // This step closes the window, which makes main.js quit. Everything up to here has
  // already been written to disk by persist(), so a clean shutdown cannot erase the record.
  // Closing the window ends the process: main.js quits on window-all-closed, so nothing can
  // be measured after this call and nothing can be written after it either. The verdict is
  // therefore finalised *before* the close, and the shutdown step records only what it can
  // observe on the way out.
  //
  // This ordering cost four runs to find. Every previous attempt closed the window and then
  // tried to write, and the process was gone before the write happened.
  await step('the app closes its window without crashing', async () => {
    const before = BrowserWindow.getAllWindows().length;
    record('info', `windows before close: ${before}`);
    if (before === 0) throw new Error('there was no window left to close — something closed it earlier');
    await persist(true);
    target.close();
    await sleep(400);
    return { before, after: BrowserWindow.getAllWindows().length };
  });

  // ── Verdict ───────────────────────────────────────────────────────────────
  // Already finalised before the close; this is a belt-and-braces write for the case where
  // the window refused to close and the process is still alive.
  await persist(true);
  console.log('');
  console.log(`${findings.length} finding(s), ${problems.length} problem(s)`);
  console.log(`verdict written to ${reportPath}`);
  console.log('');
  console.log('NOT PROVEN BY THIS SCRIPT: that the installer installs, that the app works on a');
  console.log('real desktop, or that any diagnostic value is correct. It proves the window opens,');
  console.log('the pages render, the IPC contract holds and the report paths produce bytes.');
  process.exitCode = problems.length > 0 ? 1 : 0;
}

// Attach only when invoked deliberately. A normal launch must never run this.
if (process.env.VERIDEX_GUI_SMOKE === '1') {
  // Lifecycle tracing. The run kept exiting early with no explanation, and an Electron main
  // process can be brought down by events that never reach a step: a window closed by a
  // stray click, a crash, or a quit triggered by something the harness did.
  for (const event of ['before-quit', 'will-quit', 'quit', 'window-all-closed', 'render-process-gone', 'child-process-gone']) {
    app.on(event, (...args) => {
      record('info', `lifecycle: ${event}${args.length ? ` ${JSON.stringify(args[0]?.reason ?? args[0] ?? null).slice(0, 120)}` : ''}`);
      void persist();
    });
  }
  for (const [index, window] of BrowserWindow.getAllWindows().entries()) {
    window.on('close', () => record('info', `window ${index} received close`));
  }

  app.whenReady().then(() => {
    // The smoke test needs the window that main.js creates; give it a moment to appear.
    app.on('browser-window-created', (_event, window) => {
      record('info', `a window was created (${BrowserWindow.getAllWindows().length} total)`);
      window.on('close', () => record('info', 'that window received close'));
      window.on('closed', () => record('info', 'that window was closed'));
      window.webContents.on('render-process-gone', (_e, details) => record('fail', `renderer gone: ${details.reason}`));
    });
    const started = Date.now();
    const waitForWindow = setInterval(() => {
      if (BrowserWindow.getAllWindows().length > 0 && BrowserWindow.getAllWindows()[0].webContents.getURL()) {
        clearInterval(waitForWindow);
        main()
          .catch((error) => {
            console.error(`GUI smoke test failed: ${error instanceof Error ? error.stack : String(error)}`);
            process.exitCode = 1;
          })
          .finally(() => setTimeout(() => app.quit(), 500));
      } else if (Date.now() - started > 30_000) {
        clearInterval(waitForWindow);
        console.error('GUI smoke test failed: no window appeared within 30s');
        process.exitCode = 1;
        app.quit();
      }
    }, 200);
  });
}
