/**
 * VERIDEX — Display diagnostics (MODULE 03).
 *
 * Two halves that must not be conflated:
 *   - **Automatic facts**: resolution, refresh rate, DPI scaling, physical size,
 *     multi-monitor layout, HDR capability. These come from the OS.
 *   - **Manual observations**: dead pixels, backlight bleed, uniformity, colour
 *     banding. No software can detect these; the user's eyes are the instrument.
 *     The workflow guides them and records the verdict with a timestamp.
 *
 * This module owns the automatic facts and the pattern catalogue. The manual
 * results live in manual-results.js, and the guided full-screen UI is in the
 * renderer.
 */

import { available, unavailable, field } from '../core/field.js';
import { Status } from '../core/status.js';

/**
 * The full pattern catalogue. `kind` tells the renderer how to draw it; `requires`
 * names any precondition worth checking before the test starts.
 */
export const DISPLAY_PATTERNS = Object.freeze([
  { id: 'white', title: 'White field', kind: 'solid', colour: '#FFFFFF', purpose: 'Reveals dead (always-black) pixels, dust and pressure marks.' },
  { id: 'black', title: 'Black field', kind: 'solid', colour: '#000000', purpose: 'Reveals stuck (always-on) pixels, backlight bleed and bright spots.' },
  { id: 'red', title: 'Red field', kind: 'solid', colour: '#FF0000', purpose: 'Checks the red subpixel channel and colour uniformity.' },
  { id: 'green', title: 'Green field', kind: 'solid', colour: '#00FF00', purpose: 'Checks the green subpixel channel and colour uniformity.' },
  { id: 'blue', title: 'Blue field', kind: 'solid', colour: '#0000FF', purpose: 'Checks the blue subpixel channel and colour uniformity.' },
  { id: 'cyan', title: 'Cyan field', kind: 'solid', colour: '#00FFFF', purpose: 'Checks the green+blue channels together.' },
  { id: 'magenta', title: 'Magenta field', kind: 'solid', colour: '#FF00FF', purpose: 'Checks the red+blue channels together.' },
  { id: 'yellow', title: 'Yellow field', kind: 'solid', colour: '#FFFF00', purpose: 'Checks the red+green channels together.' },
  { id: 'gray', title: 'Mid grey field', kind: 'solid', colour: '#808080', purpose: 'Reveals mura (blotchy patches) and uneven backlighting that pure colours hide.' },
  { id: 'darkGray', title: 'Dark grey field (5%)', kind: 'solid', colour: '#0D0D0D', purpose: 'The most sensitive test for backlight bleed and IPS glow. Best judged in a dimmed room.' },
  { id: 'lightGray', title: 'Light grey field (95%)', kind: 'solid', colour: '#F2F2F2', purpose: 'Reveals faint dead pixels and dirt that white hides by glare.' },
  { id: 'gradientGreyscale', title: 'Greyscale gradient', kind: 'gradient', from: '#000000', to: '#FFFFFF', purpose: 'Reveals banding and posterisation in the panel or the graphics pipeline.' },
  { id: 'gradientRgb', title: 'RGB gradient', kind: 'gradient', from: '#000000', to: '#FFFFFF', channels: true, purpose: 'Separates per-channel banding.' },
  { id: 'steps', title: 'Greyscale steps (32)', kind: 'steps', purpose: 'Counts how many distinct dark-end steps the panel resolves; checks black crush.' },
  { id: 'checker', title: '1px checkerboard', kind: 'checker', purpose: 'Exposes panel dithering and scaling artefacts at pixel level.' },
  { id: 'crosshair', title: 'Centre crosshair + border', kind: 'crosshair', purpose: 'Checks geometry, centring and whether the panel is cropping the edges.' },
  { id: 'text', title: 'Text clarity', kind: 'text', purpose: 'Checks subpixel rendering and sharpness at 1:1 scale.' }
]);

/** Patterns whose verdict is a human observation rather than a measurement. */
export const MANUAL_PATTERN_IDS = Object.freeze(DISPLAY_PATTERNS.map((pattern) => pattern.id));

/**
 * @param {string} id
 */
export function pattern(id) {
  return DISPLAY_PATTERNS.find((entry) => entry.id === id) ?? null;
}

/**
 * Build display fields from the Electron `screen` module data.
 * This function is deliberately free of Electron imports so it is unit-testable;
 * the caller passes in the plain objects it read from `screen.getAllDisplays()`.
 *
 * @param {Array<{id:number, bounds:{x:number,y:number,width:number,height:number}, workArea:{width:number,height:number}, scaleFactor:number, rotation:number, internal:boolean, label?:string, colorDepth?:number, colorSpace?:string, isHDR?:boolean, displayFrequency?:number, detected?:boolean, depthPerComponent?:number}>} displays
 * @param {{primaryId?:number, cursor?:{x:number,y:number}}} [context]
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function mapDisplays(displays, context = {}) {
  const source = 'electron-screen';
  const list = Array.isArray(displays) ? displays.filter(Boolean) : [];
  /** @type {Record<string, import('../core/field.js').FieldValue>} */
  const fields = {};

  if (list.length === 0) {
    return { displayCount: unavailable('No displays were reported by the operating system', source) };
  }

  fields.displayCount = available(list.length, source);
  fields.multiMonitor = field(list.length > 1 ? 'Yes' : 'No', { status: Status.PASS, source, notes: list.length > 1 ? ['More than one display is connected. The display test lets you target each one individually.'] : [] });

  list.forEach((display, index) => {
    // The `internal` flag is how Electron reports a panel-attached display on
    // Windows; when absent we say so rather than assuming.
    const isInternal = typeof display.internal === 'boolean' ? display.internal : null;
    const bounds = display.bounds ?? { width: 0, height: 0 };
    const scale = typeof display.scaleFactor === 'number' && display.scaleFactor > 0 ? display.scaleFactor : null;
    const refresh = typeof display.displayFrequency === 'number' && display.displayFrequency > 0 ? Math.round(display.displayFrequency) : null;
    const aspect = bounds.width > 0 && bounds.height > 0 ? simplifyRatio(bounds.width, bounds.height) : null;

    const prefix = `display${index + 1}.`;
    fields[`${prefix}label`] = available(display.label && String(display.label).trim() ? String(display.label).trim() : `Display ${index + 1}`, source, { notes: display.label ? [] : ['Windows did not return a monitor name; the index is used instead.'] });
    fields[`${prefix}nativeResolution`] = bounds.width > 0 && bounds.height > 0 ? available(`${bounds.width} × ${bounds.height}`, source) : unavailable('Resolution not reported', source);
    fields[`${prefix}width`] = bounds.width > 0 ? available(bounds.width, source, { unit: 'px' }) : unavailable('Width not reported', source);
    fields[`${prefix}height`] = bounds.height > 0 ? available(bounds.height, source, { unit: 'px' }) : unavailable('Height not reported', source);
    fields[`${prefix}aspectRatio`] = aspect ? available(aspect, 'computed') : unavailable('Aspect ratio could not be computed', 'computed');
    fields[`${prefix}scaleFactor`] = scale !== null ? available(`${Math.round(scale * 100)}%`, source) : unavailable('Display scaling not reported', source);
    fields[`${prefix}refreshRate`] = refresh !== null ? available(refresh, source, { unit: 'Hz' }) : unavailable('Refresh rate not reported for this display', source);
    fields[`${prefix}rotation`] = typeof display.rotation === 'number' ? available(`${display.rotation}°`, source) : unavailable('Rotation not reported', source);
    fields[`${prefix}internal`] = isInternal === null ? unavailable('Windows did not report whether this is a built-in panel', source) : available(isInternal ? 'Built-in panel' : 'External display', source);
    fields[`${prefix}primary`] = available(display.id === context.primaryId ? 'Yes' : 'No', source);
    fields[`${prefix}hdrCapability`] = typeof display.isHDR === 'boolean'
      ? available(display.isHDR ? 'HDR enabled' : 'HDR not enabled', source, { notes: ['Reports whether Windows is currently driving this display in HDR, not whether the panel supports it.'] })
      : unavailable('HDR state is not reported by this Windows build', source);
    fields[`${prefix}colourDepth`] = typeof display.colorDepth === 'number' && display.colorDepth > 0 ? available(display.colorDepth, source, { unit: 'bit' }) : unavailable('Colour depth not reported', source);
  });

  return fields;
}

/**
 * Reduce a resolution to its simplest aspect ratio. Common ratios are named so the
 * UI can show "16:9" rather than "1920:1080".
 * @param {number} width
 * @param {number} height
 * @returns {string|null}
 */
export function simplifyRatio(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const ratio = width / height;

  // Snap to a published panel ratio when within 1%. This is why 1366x768
  // (1.7786) reports 16:9 like its 1920x1080 cousin instead of the useless
  // fraction 683:384.
  const STANDARD = [
    [16, 9],
    [16, 10],
    [21, 9],
    [43, 18],
    [32, 9],
    [4, 3],
    [5, 4],
    [3, 2],
    [1, 1]
  ];
  for (const [w, h] of STANDARD) {
    if (Math.abs(ratio - w / h) / (w / h) <= 0.01) {
      // Ultrawide 43:18 is the exact form of the marketing "21:9"; report the
      // name technicians and resellers actually use.
      if (w === 43 && h === 18) return '21:9';
      return `${w}:${h}`;
    }
  }

  const divisor = gcd(Math.round(width), Math.round(height));
  const w = Math.round(width) / divisor;
  const h = Math.round(height) / divisor;
  if (w > 40 || h > 40) return `${ratio.toFixed(2)}:1`;
  return `${w}:${h}`;
}

/**
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function gcd(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    [x, y] = [y, x % y];
  }
  return x || 1;
}

/**
 * Known-good checklist the display page shows above the pattern player. Each line
 * is a real instruction, not decoration.
 */
export const DISPLAY_PROCEDURE = Object.freeze([
  'Dim the room and set the panel to a comfortable brightness before testing backlight uniformity.',
  'Clean the screen first: dust and fingerprints read as dead pixels.',
  'Run each solid colour full-screen and move your eyes across the whole panel, not just the centre.',
  'For backlight bleed, judge only the dark and 5% grey fields, with the panel at your normal brightness.',
  'For dead pixels, count them and record the count. One dead pixel is normal on many panels and is not the same as a damaged one.',
  'Record a verdict for every pattern you actually viewed. Anything you skip stays UNTESTED in the report — it is not assumed good.'
]);

/**
 * Advise on the significance of a dead/stuck pixel count.
 * Deliberately does not certify the panel: panel acceptance thresholds are
 * manufacturer-specific and not published in a machine-readable form.
 * @param {number} count
 */
export function deadPixelGuidance(count) {
  // Guard before coercing: Number(null) and Number('') are 0, which would report
  // a clean panel that nobody actually inspected.
  const value = count === null || count === undefined || count === '' ? Number.NaN : Number(count);
  if (!Number.isFinite(value) || value < 0) return { verdict: 'unknown', text: 'No defect count was recorded, so no guidance can be given.' };
  if (value === 0) return { verdict: 'clean', text: 'No defective pixels were recorded by the inspector.' };
  if (value <= 3) {
    return {
      verdict: 'minor',
      text: `${value} defective pixel${value === 1 ? '' : 's'} recorded. Many manufacturers consider a small number within specification, and the exact threshold varies by panel and policy, so treat this as an observation rather than a fault.`
    };
  }
  return {
    verdict: 'significant',
    text: `${value} defective pixels recorded. This is above the typical published allowance and is worth raising with the seller or manufacturer.`
  };
}
