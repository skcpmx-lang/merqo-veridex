/**
 * VERIDEX — preload bridge.
 *
 * This is the ONLY object the renderer can reach. It is a CommonJS file because
 * Electron's sandboxed preload loader requires it, and it is written with `require`
 * only so it works with `sandbox: true` (a sandboxed preload cannot use ESM import).
 *
 * Rules:
 *   - the channel lists are hard-coded, matching src/app/ipc-contract.js. A channel
 *     absent from this file cannot be invoked from the UI at all;
 *   - nothing here takes a filesystem path: saving is a main-process dialog;
 *   - listeners are removed one at a time so the renderer cannot leak them;
 *   - no `nodeIntegration`, no `remote`, no `ipcRenderer` exposure.
 *
 * tests/unit/ipc-contract.test.js asserts this file's channel lists match the
 * contract, so the two cannot drift apart.
 */

const { contextBridge, ipcRenderer } = require('electron');

/** Must match Object.keys(CHANNELS) in src/app/ipc-contract.js. */
const INVOKE = [
  'app:info',
  'app:settings',
  'app:setSetting',
  'app:applyPrivacyPreset',
  'app:guardSummary',
  'app:onboarding',
  'app:onboardingAdvance',
  'app:onboardingSkip',
  'app:onboardingReset',
  'scan:start',
  'scan:cancel',
  'scan:state',
  'scan:last',
  'report:build',
  'report:save',
  'manual:suites',
  'manual:record',
  'manual:coverage',
  'history:list',
  'history:compare',
  'drivers:chooseDestination',
  'drivers:plan',
  'drivers:export',
  'drivers:cancelExport',
  'drivers:lastExport',
  'logs:recent',
  'logs:stats',
  'logs:export',
  'logs:clear',
  'bench:cpu',
  'bench:disk',
  'bench:state',
  'bench:cancel',
  'bench:memory',
  'bench:gpu',
  'bench:responsiveness',
  'app:recovery',
  'stress:start',
  'stress:stop',
  'stress:state',
  'monitor:start',
  'monitor:stop',
  'monitor:export',
  'shell:openDataFolder'
];

/** Must match Object.keys(EVENTS) in src/app/ipc-contract.js. */
const EVENTS = [
  'scan:progress',
  'scan:finished',
  'monitor:sample',
  'bench:progress',
  'stress:sample',
  'stress:finished',
  'monitor:stopped',
  'settings:changed',
  'app:error'
];

/** @param {string} channel */
function invoke(channel) {
  if (!INVOKE.includes(channel)) {
    return Promise.reject(new Error(`Channel "${channel}" is not part of the VERIDEX bridge`));
  }
  return (...args) => ipcRenderer.invoke(channel, ...args);
}

/**
 * Subscribe to a main-process event. Returns an unsubscribe function; the caller
 * must use it, because a window that reloads would otherwise stack listeners.
 * @param {string} channel
 * @param {(payload: unknown) => void} listener
 */
function subscribe(channel, listener) {
  if (!EVENTS.includes(channel)) throw new Error(`Event "${channel}" is not part of the VERIDEX bridge`);
  if (typeof listener !== 'function') throw new Error('A listener function is required');
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

/** Frozen bridge. Freezing stops the renderer reassigning methods. */
const bridge = Object.freeze({
  invoke: Object.freeze(Object.fromEntries(INVOKE.map((channel) => [channel, invoke(channel)]))),
  on: subscribe,
  channels: Object.freeze({ invoke: [...INVOKE], events: [...EVENTS] })
});

contextBridge.exposeInMainWorld('veridex', bridge);
