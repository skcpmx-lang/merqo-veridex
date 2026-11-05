/**
 * VERIDEX — renderer bridge.
 *
 * The renderer talks to the main process through exactly one object. This module
 * locates it, and — critically — is explicit about what happens when it is absent.
 *
 * There are two legitimate modes:
 *   - **Electron**: `window.veridex` was injected by the preload. Everything is real.
 *   - **Browser**: no bridge exists. The interface still renders so the design can be
 *     reviewed without a Windows machine, but it is marked PREVIEW everywhere, every
 *     call returns a labelled refusal, and no number on screen is invented. This is
 *     the only concession in the codebase to running outside the product, and it
 *     cannot be mistaken for live data because the banner is permanent and the
 *     sample values are tagged as placeholders.
 */

/** @typedef {{ok:true, data:unknown}|{ok:false, error:{message:string, code:string}}} Envelope */

/** Is the real bridge present? */
export function hasBridge() {
  return Boolean(globalThis.veridex && typeof globalThis.veridex.invoke === 'object');
}

/**
 * Create the client the rest of the interface uses. Always returns an object with
 * the same shape, so no page needs to branch on which mode it is in.
 * @param {{onModeChange?: (mode:'live'|'preview') => void}} [options]
 */
export function createClient(options = {}) {
  const live = hasBridge();
  const mode = live ? 'live' : 'preview';
  options.onModeChange?.(mode);

  /** @returns {Promise<Envelope>} */
  const unavailable = async (channel) => ({
    ok: false,
    error: {
      code: 'no_bridge',
      message: `The VERIDEX main process is not attached, so "${channel}" cannot run. This window is a design preview: nothing shown here is a real reading from a machine.`
    }
  });

  /** @param {string} channel @param {...unknown} args @returns {Promise<Envelope>} */
  async function invoke(channel, ...args) {
    if (!live) return unavailable(channel);
    try {
      const fn = globalThis.veridex.invoke[channel];
      if (typeof fn !== 'function') {
        return { ok: false, error: { code: 'unknown_channel', message: `The bridge does not expose "${channel}".` } };
      }
      const result = await fn(...args);
      // The main process always answers with an envelope; if it does not, that is a
      // contract violation and must surface as an error rather than `undefined`.
      if (result && typeof result === 'object' && 'ok' in result) return result;
      return { ok: false, error: { code: 'bad_envelope', message: `"${channel}" returned a payload that is not a VERIDEX envelope.` } };
    } catch (error) {
      return { ok: false, error: { code: 'bridge_error', message: error instanceof Error ? error.message : String(error) } };
    }
  }

  /**
   * Subscribe to a main-process event. Returns an unsubscribe function that is safe
   * to call in preview mode.
   * @param {string} channel @param {(payload:unknown) => void} listener
   */
  function on(channel, listener) {
    if (!live || typeof globalThis.veridex.on !== 'function') return () => {};
    try {
      return globalThis.veridex.on(channel, listener);
    } catch {
      return () => {};
    }
  }

  return { mode, live, invoke, on, channels: live ? globalThis.veridex.channels : { invoke: [], events: [] } };
}

/**
 * Preview fixtures. These exist only to let the design be reviewed in a browser.
 * They are:
 *   - obviously fake ("Preview" in every name),
 *   - returned only when `preview` mode is on,
 *   - never written to a report or to history,
 *   - labelled wherever they appear.
 *
 * If you are reading this while looking for hardcoded diagnostic results: this is
 * not that. These values never reach a report, a score or a stored run, and the
 * code path that would use them returns a refusal in live mode.
 */
export const PREVIEW_NOTE = 'Design preview — no machine was inspected. Every value below is a placeholder.';
