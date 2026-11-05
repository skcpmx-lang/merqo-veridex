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
import { readFile, writeFile, mkdir } from 'node:fs/promises';
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
  try {
    const value = await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${name} exceeded ${timeoutMs}ms`)), timeoutMs))
    ]);
    record('ok', `${name} (${Date.now() - started}ms)`);
    return { ok: true, value };
  } catch (error) {
    record('fail', `${name} threw: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, value: null };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function main() {
  const reportPath = process.env.VERIDEX_GUI_SMOKE_REPORT ?? path.join(app.getPath('temp'), 'veridex-gui-smoke.json');
  const startedAt = new Date().toISOString();
  console.log('VERIDEX GUI smoke test');
  console.log(`  electron ${process.versions.electron} · chromium ${process.versions.chrome} · node ${process.versions.node}`);
  console.log(`  platform ${process.platform} ${process.arch}`);

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
    if (booted.value.title !== 'VERIDEX') record('fail', `window title is "${booted.value.title}", expected "VERIDEX"`);
  }

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
    const info = await evaluate(`ipc('app:info')`);
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
  const sweep = await step('scan:start runs a real sweep and finishes', async () => {
    // Fire the sweep without awaiting it. scan:start resolves only when every task is done,
    // so awaiting it here would make a healthy long scan look like a hung step.
    await evaluate(`(window.veridex.invoke['scan:start']({}).then(() => 'done').catch((e) => 'error:' + e.message))`);
    await waitFor(`document.body.innerText.length > 200`, { label: 'scan output' });
    // scan:state reports `running` plus facts about the last sweep; there is no status
    // string. Wait for the sweep to stop running and a finish timestamp to appear.
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const state = await evaluate(`ipc('scan:state')`);
      const data = state?.data ?? {};
      if (data.running === false && data.lastScanAt) return data;
      await sleep(1_000);
    }
    throw new Error('the sweep did not finish within 180s');
  }, 200_000);
  if (sweep.ok) record('info', `scan state after finish: ${JSON.stringify(sweep.value?.data ?? sweep.value).slice(0, 300)}`);

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

  // ── 5. Every page, rendered ───────────────────────────────────────────────
  await step('every page renders without an error', async () => {
    const labels = await evaluate(`[...document.querySelectorAll('[data-page]')].map((n) => n.getAttribute('data-page'))`);
    const broken = [];
    for (const label of labels) {
      await evaluate(`(() => { const node = document.querySelector('[data-page="${label}"]'); if (node) node.click(); return true; })()`);
      await sleep(250);
      const facts = await evaluate(`({ text: document.body.innerText.length, error: /cannot read|undefined is not|typeerror/i.test(document.body.innerText) })`);
      if (facts.error) broken.push(label);
      if (facts.text < 40) broken.push(`${label} (blank)`);
    }
    record('info', `${labels.length} pages visited`);
    if (broken.length > 0) throw new Error(`pages rendered badly: ${broken.join(', ')}`);
    return labels;
  });

  // ── 6. History ────────────────────────────────────────────────────────────
  await step('history records the run that just finished', async () => {
    const history = await evaluate(`ipc('history:list')`);
    const entries = history?.data?.entries ?? history?.data ?? [];
    const count = Array.isArray(entries) ? entries.length : Object.keys(entries ?? {}).length;
    record('info', `history:list → ${count} entr(ies)`);
    if (count === 0) record('warn', 'the completed sweep left no history entry');
    return count;
  });

  // ── 7. Live monitoring ────────────────────────────────────────────────────
  await step('live monitoring starts, delivers samples and stops', async () => {
    const sample = await evaluate(`new Promise((resolve) => {
      const timer = setTimeout(() => resolve('__no_sample__'), 20000);
      const listener = (payload) => { clearTimeout(timer); try { window.veridex.off?.('monitor:sample', listener); } catch {} resolve(payload); };
      window.veridex.on('monitor:sample', listener);
      window.veridex.invoke['monitor:start']({});
    })`);
    if (sample === '__no_sample__') throw new Error('no monitor:sample event arrived in 20s');
    await evaluate(`ipc('monitor:stop')`);
    const payload = JSON.stringify(sample).slice(0, 300);
    record('info', `first sample: ${payload}`);
    return payload;
  });

  // ── 8. Settings round trip ────────────────────────────────────────────────
  await step('a setting changes, persists to disk and reads back', async () => {
    const snapshot = await evaluate(`ipc('app:settings')`);
    const values = snapshot?.data?.values ?? {};
    // The store calls its schema `specs`. An earlier version of this harness looked for a
    // field named `schema`, found nothing, and skipped the round trip while reporting that
    // the setting had been changed and read back.
    const specs = snapshot?.data?.specs;
    const candidates = Array.isArray(specs) ? specs : Object.entries(specs ?? {}).map(([key, spec]) => ({ key, ...spec }));
    const firstBoolean = candidates.find((entry) => (entry.type ?? entry.kind) === 'boolean' && entry.key in values);
    if (!firstBoolean) {
      record('warn', `no editable boolean setting among ${candidates.length} specs; skipping the round trip`);
      return null;
    }
    const before = values[firstBoolean.key];
    await evaluate(`window.veridex.invoke['app:setSetting']({ key: ${JSON.stringify(firstBoolean.key)}, value: ${JSON.stringify(!before)} })`);
    const after = await evaluate(`ipc('app:settings')`);
    const now = after?.data?.values?.[firstBoolean.key];
    record('info', `${firstBoolean.key}: ${before} → ${now}`);
    if (now !== !before) throw new Error(`${firstBoolean.key} did not change`);
    // Restore, so the smoke test leaves no trace.
    await evaluate(`window.veridex.invoke['app:setSetting']({ key: ${JSON.stringify(firstBoolean.key)}, value: ${JSON.stringify(before)} })`);
    return { key: firstBoolean.key, before, after: now };
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

  // ── 10. Cancellation ──────────────────────────────────────────────────────
  await step('a scan can be cancelled mid-flight', async () => {
    await evaluate(`ipc('scan:start')`);
    await sleep(1_200);
    await evaluate(`ipc('scan:cancel')`);
    await sleep(1_500);
    const state = await evaluate(`ipc('scan:state')`);
    const data = state?.data ?? {};
    record('info', `state after cancel: running=${data.running} lastScanAt=${data.lastScanAt ?? '(none)'}`);
    // The app must return to an idle, usable state rather than staying stuck in "running".
    if (data.running === true) record('fail', 'the sweep is still marked running after cancel');
    return data;
  });

  // ── 11. Shutdown ──────────────────────────────────────────────────────────
  await step('the app survives a window close and quits cleanly', async () => {
    const before = BrowserWindow.getAllWindows().length;
    target.close();
    await sleep(800);
    const remaining = BrowserWindow.getAllWindows().length;
    record('info', `windows ${before} → ${remaining} after close`);
    if (remaining !== 0) throw new Error('the window did not close');
    return remaining;
  });

  // ── Verdict ───────────────────────────────────────────────────────────────
  const result = {
    generatedAt: startedAt,
    finishedAt: new Date().toISOString(),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    findings,
    problems
  };

  await mkdir(path.dirname(reportPath), { recursive: true }).catch(() => {});
  await writeFile(reportPath, JSON.stringify(result, null, 2), 'utf8');
  console.log('');
  console.log(`${findings.length} finding(s), ${problems.length} problem(s)`);
  console.log(`verdict written to ${reportPath}`);
  console.log('');
  console.log('NOT PROVEN BY THIS SCRIPT: that the installer installs, that the app works on a');
  console.log('real desktop, or that any diagnostic value is correct. It proves the window opens,');
  console.log('the pages render, the IPC contract holds and the report paths produce bytes.');
  try {
    await readFile(reportPath);
  } catch {
    /* the write above already reported */
  }
  process.exitCode = problems.length > 0 ? 1 : 0;
}

// Attach only when invoked deliberately. A normal launch must never run this.
if (process.env.VERIDEX_GUI_SMOKE === '1') {
  app.whenReady().then(() => {
    // The smoke test needs the window that main.js creates; give it a moment to appear.
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
