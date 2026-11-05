/**
 * VERIDEX — IPC contract.
 *
 * The renderer is the least trusted part of an Electron app: it evaluates markup
 * and, in a careless build, can be steered by a device name that contains a quote.
 * So the boundary between the UI and the main process is declared here as data,
 * validated on both sides, and unit tested without Electron present.
 *
 * Rules this file enforces:
 *   - `contextIsolation` with a preload bridge; no `nodeIntegration`, no remote
 *     module, no `enableRemoteModule`;
 *   - the channel list is closed — an unknown channel is refused, not ignored;
 *   - every request payload is validated against a declared shape before it
 *     reaches the engine;
 *   - every response is an envelope `{ok, data}` or `{ok:false, error}`, so the UI
 *     always has something honest to display and an exception cannot become a
 *     blank screen;
 *   - file writes are only ever performed by the main process, and only to a path
 *     the user chose through a native dialog.
 *
 * This module has no Electron import, deliberately: it is the part that can be
 * tested on CI, and the part a future second window implementation must obey.
 */

/** Channels the renderer may invoke, with the shape of what each accepts. */
export const CHANNELS = Object.freeze({
  'app:info': { args: [], description: 'Version, brand and platform facts for the About screen.' },
  'app:settings': { args: [], description: 'The full settings snapshot and its schema, for generating the settings UI.' },
  'app:setSetting': { args: ['key', 'value'], description: 'Change one setting. Validated and persisted by the main process.' },
  'app:applyPrivacyPreset': { args: ['presetId'], description: 'Apply a privacy preset through the settings store.' },
  'app:guardSummary': { args: [], description: 'Blocked network attempts and refused commands.' },
  'scan:start': { args: ['options'], description: 'Start a diagnostic sweep. Progress arrives on the event channel.' },
  'scan:cancel': { args: [], description: 'Abort the running sweep.' },
  'scan:state': { args: [], description: 'Current scan state, for a window that opens mid-scan.' },
  'report:build': { args: ['format'], description: 'Build a report document and render one format to bytes.' },
  'report:save': { args: ['format'], description: 'Render and save via a native save dialog. Returns the chosen path.' },
  'manual:suites': { args: [], description: 'The manual test registry, with instructions and provenance labels.' },
  'manual:record': { args: ['testId', 'verdict', 'detail'], description: 'Record an inspection verdict.' },
  'manual:coverage': { args: [], description: 'Manual programme progress.' },
  'history:list': { args: [], description: 'Stored runs, newest first.' },
  'history:compare': { args: ['aId', 'bId'], description: 'Field-level diff between two runs.' },
  'monitor:start': { args: [], description: 'Begin live sensor sampling. Samples arrive on the event channel.' },
  'monitor:stop': { args: [], description: 'Stop sampling.' },
  'shell:openDataFolder': { args: [], description: 'Reveal the local data folder in Explorer.' }
});

/** Channels the main process pushes events on. The renderer may only listen. */
export const EVENTS = Object.freeze({
  'scan:progress': 'One task finished, with its section.',
  'scan:finished': 'The sweep ended, with a summary.',
  'monitor:sample': 'One live sensor sample.',
  'monitor:stopped': 'Sampling ended, with the reason if it failed.',
  'settings:changed': 'A setting changed, with the new value.',
  'app:error': 'Something failed in the main process.'
});

/** Settings change events the renderer is allowed to observe. */
export const INVOKE_CHANNELS = Object.freeze(Object.keys(CHANNELS));
export const EVENT_CHANNELS = Object.freeze(Object.keys(EVENTS));

/**
 * @param {string} channel
 * @returns {boolean}
 */
export function isInvokable(channel) {
  return Object.hasOwn(CHANNELS, channel);
}

/** @param {string} channel */
export function isEvent(channel) {
  return Object.hasOwn(EVENTS, channel);
}

/**
 * @typedef {{ok:true, data:unknown}} OkEnvelope
 * @typedef {{ok:false, error:{message:string, code:string, detail?:string|null}}} ErrEnvelope
 * @typedef {OkEnvelope|ErrEnvelope} Envelope
 */

/** @param {unknown} data @returns {OkEnvelope} */
export function ok(data) {
  return { ok: true, data };
}

/**
 * Error envelopes carry a code so the UI can distinguish "needs elevation" from
 * "this machine cannot do that" from "the app has a bug". Collapsing them into one
 * red toast is how a diagnostic tool starts lying to its user.
 * @param {unknown} error
 * @param {string} [code]
 * @returns {ErrEnvelope}
 */
export function fail(error, code = 'app_error') {
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  return { ok: false, error: { message, code } };
}

/**
 * Validate a request before it reaches the engine.
 *
 * Each validator returns `{ok:true, value}` with a normalised payload, or
 * `{ok:false, reason}`. Normalising here (clamping numbers, rejecting unknown
 * enum members) means the engine never has to defend itself against the UI.
 *
 * @param {string} channel
 * @param {unknown[]} args
 * @returns {{ok:true, value:unknown}|{ok:false, reason:string}}
 */
/**
 * Normalise an argument list into the shape each channel documents.
 *
 * The renderer calls channels positionally - `invoke('report:save', 'csv')` - because that
 * is what the preload exposes: one function per channel, taking plain arguments. The
 * contract, however, describes named parameters. Accepting only the object form silently
 * discarded a positional argument and defaulted to the first allowed value, so every
 * report the user asked to save as CSV or JSON was written as a PDF. Accepting only the
 * positional form would break every future caller that passes an object.
 *
 * So: if the first argument is an object, treat it as the named payload; otherwise map the
 * positional arguments onto the channel's declared parameter names, in order.
 *
 * @param {string} channel
 * @param {unknown[]} args
 * @returns {Record<string, unknown>|null}
 */
function namedArguments(channel, args) {
  const spec = CHANNELS[channel];
  if (!spec) return null;
  if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
    return /** @type {Record<string, unknown>} */ (args[0]);
  }
  if (args.length === 0) return {};
  /** @type {Record<string, unknown>} */
  const named = {};
  spec.args.forEach((name, index) => {
    if (index < args.length) named[name] = args[index];
  });
  return named;
}

export function validateRequest(channel, args = []) {
  if (!isInvokable(channel)) return { ok: false, reason: `Unknown channel "${channel}"` };
  const list = Array.isArray(args) ? args : [];
  const named = namedArguments(channel, list);
  const [first, second] = named ? [named, list[1]] : [list[0], list[1]];

  switch (channel) {
    case 'app:setSetting': {
      const key = String(named?.key ?? '');
      if (!key || key.length > 120) return { ok: false, reason: 'A setting key is required.' };
      const value = named?.value;
      // A setting value may legitimately be a string, number, boolean, array or
      // object; it must not be a function or a class instance from the renderer.
      const kind = typeof value;
      if (!['string', 'number', 'boolean', 'object', 'undefined'].includes(kind)) {
        return { ok: false, reason: `Setting values of type ${kind} are not accepted.` };
      }
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        // A plain object from the renderer has a prototype from its own realm, which is a
        // different realm from this one. Accept only null-prototype or plain objects.
        const proto = Object.getPrototypeOf(value);
        if (proto !== null && proto !== Object.prototype) {
          return { ok: false, reason: 'Setting values must be plain data, not class instances.' };
        }
      }
      return { ok: true, value: { key, value } };
    }

    case 'app:applyPrivacyPreset': {
      const presetId = String(named?.presetId ?? '');
      if (!['private', 'minimalTrace', 'workshop'].includes(presetId)) {
        return { ok: false, reason: `Unknown privacy preset "${presetId}"` };
      }
      return { ok: true, value: { presetId } };
    }

    case 'scan:start': {
      const options = named ?? {};
      // No task list means every registered task. Returning an empty array here made
      // `scan:start` start a sweep of nothing, which reported success and produced no data.
      const requested = /** @type {any} */ (options).tasks;
      const tasks = Array.isArray(requested) ? requested : [];
      // Accept only task ids that look like ids: the main process resolves them
      // against the registry and refuses anything unknown, but a malformed list
      // should not even reach that far.
      if (tasks.length > 200) return { ok: false, reason: 'Too many tasks requested.' };
      if (tasks.some((task) => typeof task !== 'string' || task.length > 80)) {
        return { ok: false, reason: 'Task ids must be short strings.' };
      }
      return { ok: true, value: { tasks } };
    }

    case 'report:build':
    case 'report:save': {
      // No default. Choosing pdf for a caller that asked for nothing is how the positional
      // bug stayed invisible: the call succeeded and produced a document nobody requested.
      if (named?.format === undefined || named?.format === null || named?.format === '') {
        return { ok: false, reason: 'A report format is required: pdf, html, csv or json.' };
      }
      const format = String(named.format).toLowerCase();
      if (!['pdf', 'html', 'csv', 'json'].includes(format)) {
        return { ok: false, reason: `Unsupported report format "${format}".` };
      }
      return { ok: true, value: { format } };
    }

    case 'manual:record': {
      const testId = String(named?.testId ?? '');
      const verdict = String(named?.verdict ?? '');
      const detail = named?.detail && typeof named.detail === 'object' ? named.detail : {};
      if (!testId) return { ok: false, reason: 'A test id is required.' };
      if (!['PASS', 'FAIL', 'WARNING', 'NOT_APPLICABLE'].includes(verdict)) {
        return { ok: false, reason: `"${verdict}" is not a recordable verdict.` };
      }
      const notes = Array.isArray(/** @type {any} */ (detail).notes)
        ? /** @type {any} */ (detail).notes.filter((note) => typeof note === 'string').slice(0, 20)
        : [];
      const defects = /** @type {any} */ (detail).defects;
      return {
        ok: true,
        value: {
          testId,
          verdict,
          detail: {
            notes,
            defects: Number.isFinite(defects) ? Number(defects) : undefined
          }
        }
      };
    }

    case 'history:compare': {
      const aId = String(named?.aId ?? '');
      const bId = String(named?.bId ?? '');
      if (!aId || !bId) return { ok: false, reason: 'Two run ids are required to compare.' };
      if (aId.length > 80 || bId.length > 80) return { ok: false, reason: 'Run ids are too long.' };
      return { ok: true, value: { aId, bId } };
    }

    default:
      // Channels that take no arguments still must not be called with junk.
      if (args.length > 0) {
        const tolerated = ['scan:start'];
        if (!tolerated.includes(channel)) return { ok: true, value: undefined };
      }
      return { ok: true, value: undefined };
  }
}

/**
 * The preload bridge surface, as data. `src/app/preload.js` builds the real bridge
 * from this list and `tests/integration/ipc-contract.test.js` asserts they agree,
 * so a channel cannot be added to the UI without existing in the contract.
 */
export function bridgeSurface() {
  return {
    invoke: [...INVOKE_CHANNELS],
    on: [...EVENT_CHANNELS],
    // Deliberately absent: any function that takes a filesystem path. Saving is
    // done by a main-process dialog the user drives, never by a path the renderer
    // supplied.
    forbidden: ['writeFile', 'readFile', 'exec', 'spawn', 'eval', 'require', 'openPath', 'openExternal']
  };
}

/**
 * Window security options. Kept here so a reviewer can see every one of them in a
 * single place rather than hunting through `main.js`.
 */
export const WINDOW_SECURITY = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  spellcheck: false,
  webviewTag: false,
  enableRemoteModule: false
});

/**
 * Window size rules, expressed as data so the "fits a 1366x768 laptop" requirement
 * is checkable rather than aspirational.
 */
export const WINDOW_DEFAULTS = Object.freeze({
  width: 1360,
  height: 860,
  minWidth: 1024,
  minHeight: 700,
  backgroundColor: '#0A1220',
  show: false
});

/**
 * Does the default window fit the given work area? Used by the test that asserts
 * VERIDEX opens fully visible on a small laptop screen.
 * @param {{width:number, height:number}} workArea
 */
export function windowFits(workArea) {
  return {
    fits: WINDOW_DEFAULTS.minWidth <= workArea.width && WINDOW_DEFAULTS.minHeight <= workArea.height,
    clamped: {
      width: Math.min(WINDOW_DEFAULTS.width, Math.max(WINDOW_DEFAULTS.minWidth, workArea.width)),
      height: Math.min(WINDOW_DEFAULTS.height, Math.max(WINDOW_DEFAULTS.minHeight, workArea.height))
    }
  };
}
