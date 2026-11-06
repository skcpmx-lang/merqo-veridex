import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CHANNELS, EVENTS, INVOKE_CHANNELS, EVENT_CHANNELS, isInvokable, isEvent,
  ok, fail, validateRequest, bridgeSurface, WINDOW_SECURITY, WINDOW_DEFAULTS, windowFits
} from '../../src/app/ipc-contract.js';

test('unknown channels are refused rather than silently ignored', () => {
  assert.equal(isInvokable('scan:start'), true);
  assert.equal(isInvokable('shell:exec'), false);
  assert.equal(validateRequest('shell:exec', []).ok, false);
  assert.match(validateRequest('shell:exec', []).reason, /Unknown channel/);
});

test('every declared channel documents what it takes', () => {
  for (const [channel, spec] of Object.entries(CHANNELS)) {
    assert.ok(spec.description.length > 10, `${channel} needs a description`);
    assert.ok(Array.isArray(spec.args), `${channel} must declare its args`);
  }
  for (const [channel, description] of Object.entries(EVENTS)) {
    assert.ok(description.length > 10, `event ${channel} needs a description`);
  }
});

test('event channels are not invokable and vice versa', () => {
  for (const channel of EVENT_CHANNELS) assert.equal(isInvokable(channel), false, `${channel} must not be invokable`);
  for (const channel of INVOKE_CHANNELS) assert.equal(isEvent(channel), false, `${channel} must not be treated as an event`);
});

test('error envelopes carry a code so the UI can tell failure kinds apart', () => {
  const envelope = fail(new Error('Requires elevation'), 'permission_required');
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, 'permission_required');
  assert.equal(envelope.error.message, 'Requires elevation');
  assert.equal(fail('plain string').error.message, 'plain string');
  assert.equal(ok(42).data, 42);
});

test('report formats are restricted to the four that exist', () => {
  for (const format of ['pdf', 'html', 'csv', 'json', 'PDF']) {
    assert.equal(validateRequest('report:build', [format]).ok, true, format);
  }
  for (const format of ['docx', 'exe', '', '../../etc/passwd']) {
    assert.equal(validateRequest('report:build', [format]).ok, false, format);
  }
});

test('a recordable verdict is required and unknown verdicts are refused', () => {
  for (const verdict of ['PASS', 'FAIL', 'WARNING', 'NOT_APPLICABLE']) {
    assert.equal(validateRequest('manual:record', ['display.white', verdict, { notes: ['ok'] }]).ok, true, verdict);
  }
  for (const verdict of ['UNTESTED', 'OK', 'pass', '']) {
    assert.equal(validateRequest('manual:record', ['display.white', verdict, {}]).ok, false, verdict);
  }
});

test('manual notes are sanitised before they reach the session', () => {
  const result = validateRequest('manual:record', ['display.white', 'PASS', {
    notes: ['clean', 42, null, 'second'],
    defects: 0
  }]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.detail.notes, ['clean', 'second']);
  assert.equal(result.value.detail.defects, 0);
});

test('a settings write requires a key and rejects exotic value types', () => {
  assert.equal(validateRequest('app:setSetting', ['', true]).ok, false);
  assert.equal(validateRequest('app:setSetting', ['appearance.theme', 'light']).ok, true);
  assert.equal(validateRequest('app:setSetting', ['monitoring.intervalMs', 2000]).ok, true);
  assert.equal(validateRequest('app:setSetting', ['x', () => {}]).ok, false);
});

test('privacy presets are an allowlist, not free text', () => {
  assert.equal(validateRequest('app:applyPrivacyPreset', ['private']).ok, true);
  assert.equal(validateRequest('app:applyPrivacyPreset', ['workshop']).ok, true);
  assert.equal(validateRequest('app:applyPrivacyPreset', ['openEverything']).ok, false);
});

test('scan requests cannot smuggle an unbounded task list', () => {
  const many = Array.from({ length: 300 }, (_, i) => `task.${i}`);
  assert.equal(validateRequest('scan:start', [{ tasks: many }]).ok, false);
  assert.equal(validateRequest('scan:start', [{ tasks: ['cpu.info', 'storage.info'] }]).ok, true);
  assert.equal(validateRequest('scan:start', [{ tasks: [1234] }]).ok, false);
});

test('history comparison needs two ids', () => {
  assert.equal(validateRequest('history:compare', ['VX-1', '']).ok, false);
  assert.equal(validateRequest('history:compare', ['VX-1', 'VX-2']).ok, true);
});

test('the bridge surface exposes no filesystem or process function', () => {
  const surface = bridgeSurface();
  assert.deepEqual(surface.invoke, INVOKE_CHANNELS);
  assert.deepEqual(surface.on, EVENT_CHANNELS);
  for (const forbidden of surface.forbidden) {
    assert.ok(!surface.invoke.includes(forbidden), `${forbidden} must not be exposed to the renderer`);
  }
  // No invoke channel may take a path argument.
  for (const [channel, spec] of Object.entries(CHANNELS)) {
    assert.ok(!spec.args.some((arg) => /path|file|dir/i.test(arg)), `${channel} must not accept a filesystem path from the UI`);
  }
});

test('window security is locked down', () => {
  assert.equal(WINDOW_SECURITY.contextIsolation, true);
  assert.equal(WINDOW_SECURITY.nodeIntegration, false);
  assert.equal(WINDOW_SECURITY.sandbox, true);
  assert.equal(WINDOW_SECURITY.webSecurity, true);
  assert.equal(WINDOW_SECURITY.webviewTag, false);
  assert.equal(WINDOW_SECURITY.allowRunningInsecureContent, false);
});

test('the default window fits a 1366x768 laptop', () => {
  const result = windowFits({ width: 1366, height: 728 });
  assert.equal(result.fits, true);
  assert.ok(result.clamped.height <= 728);
  assert.ok(result.clamped.width <= 1366);
});

test('the window refuses to open on a screen too small to use it', () => {
  const result = windowFits({ width: 800, height: 600 });
  assert.equal(result.fits, false);
  assert.equal(result.clamped.width, WINDOW_DEFAULTS.minWidth);
});

test('the preload bridge exposes exactly the contract channels, no more', async () => {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const root = path.resolve(import.meta.dirname, '..', '..');
  const source = await readFile(path.join(root, 'src/app/preload.cjs'), 'utf8');

  const grab = (name) => {
    const match = source.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
    assert.ok(match, `${name} list must exist in the preload`);
    return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
  };

  assert.deepEqual(grab('INVOKE'), INVOKE_CHANNELS, 'preload invoke list must match the contract exactly');
  assert.deepEqual(grab('EVENTS'), EVENT_CHANNELS, 'preload event list must match the contract exactly');
});

test('every contract channel has a handler in the main process', async () => {
  // The Performance page spent a phase saying "the engines exist but this page is not wired".
  // That is what a tested engine plus a missing handler looks like from the outside, so the
  // correspondence is asserted rather than left to review: a channel in the contract with no
  // `handle()` behind it is an invitation to a dead button.
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const root = path.resolve(import.meta.dirname, '..', '..');
  const source = await readFile(path.join(root, 'src/app/main.js'), 'utf8');
  const handled = new Set([...source.matchAll(/handle\('([^']+)'/g)].map((match) => match[1]));
  const missing = INVOKE_CHANNELS.filter((channel) => !handled.has(channel));
  assert.deepEqual(missing, [], `channels declared without a main-process handler: ${missing.join(', ')}`);
});

test('a benchmark mode is validated rather than passed through', () => {
  assert.deepEqual(validateRequest('bench:cpu', [{ mode: 'multi' }]).value, { mode: 'multi' });
  assert.equal(validateRequest('bench:cpu', [{}]).value.mode, 'all', 'a missing mode measures everything');
  const refused = validateRequest('bench:cpu', [{ mode: 'gpu' }]);
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /not a benchmark mode/);
  // The disk benchmark takes its size and write policy from settings, not from the renderer.
  assert.equal(validateRequest('bench:disk', []).ok, true);
});

test('the preload never exposes a raw ipcRenderer or a path-taking function', async () => {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const root = path.resolve(import.meta.dirname, '..', '..');
  const source = await readFile(path.join(root, 'src/app/preload.cjs'), 'utf8');

  assert.ok(source.includes('contextBridge.exposeInMainWorld'), 'the bridge must be exposed through contextBridge');
  assert.ok(!/exposeInMainWorld\([^)]*ipcRenderer\s*\)/.test(source), 'ipcRenderer must never be handed to the renderer directly');
  assert.ok(!/openPath|writeFile|readFile\s*\(/.test(source), 'the preload must not do filesystem work');
  assert.ok(source.includes('Object.freeze'), 'the bridge should be frozen so the renderer cannot reassign it');
  assert.ok(!/\bnodeIntegration\b\s*:\s*true/.test(source));
});
