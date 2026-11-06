/**
 * VERIDEX — window placement across displays (MODULE 18, R-18-02).
 *
 * The failure this module exists to prevent is specific and common: a window that opens at a
 * fixed 1360x860 on a 125 % laptop, where the work area is 1093x614 in the units Electron
 * reports, so the bottom of the application sits under the taskbar or off the screen entirely —
 * and a second monitor with a negative origin, where "centre" computed against the primary
 * display puts the window on the wrong screen or half of it outside both.
 *
 * Everything here is a pure function over plain objects, so the arithmetic is testable without
 * Electron and without a second monitor. `main.js` supplies the real `screen` data.
 *
 * The units are whatever the caller passes in. Electron's `Display.bounds`, `workArea` and
 * `size` are all device-independent pixels, so a window sized in CSS pixels lines up with them
 * at any scale factor — which is exactly why the work area, not the resolution, is the bound.
 */

/** @typedef {{x:number, y:number, width:number, height:number}} Rect */
/** @typedef {{id:number, bounds:Rect, workArea:Rect, scaleFactor?:number, rotation?:number, label?:string}} Display */

/**
 * Does a rectangle contain a point? Used to find the display under the cursor.
 * @param {Rect} rect
 * @param {{x:number, y:number}} point
 */
export function containsPoint(rect, point) {
  if (!rect || !point) return false;
  return point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height;
}

/**
 * How much of `rect` lies inside `container`? The area, in square pixels.
 * @param {Rect} rect
 * @param {Rect} container
 */
export function overlapArea(rect, container) {
  if (!rect || !container) return 0;
  const width = Math.min(rect.x + rect.width, container.x + container.width) - Math.max(rect.x, container.x);
  const height = Math.min(rect.y + rect.height, container.y + container.height) - Math.max(rect.y, container.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * The display a window should open on.
 *
 * The cursor wins when it is on a display, because that is where the user's attention is; the
 * primary display is the fallback, and the first display is the fallback for a machine whose
 * primary display cannot be identified. Returning the display itself rather than an id keeps
 * the caller honest about which work area it is going to clamp against.
 *
 * @param {Display[]} displays
 * @param {{primaryId?:number, cursor?:{x:number,y:number}}} [context]
 * @returns {{display:Display|null, reason:string}}
 */
export function chooseDisplay(displays, context = {}) {
  const list = Array.isArray(displays) ? displays.filter((display) => display && display.bounds) : [];
  if (list.length === 0) return { display: null, reason: 'no-displays' };

  const underCursor = context.cursor ? list.find((display) => containsPoint(display.bounds, context.cursor)) : null;
  if (underCursor) return { display: underCursor, reason: 'cursor' };

  const primary = context.primaryId === undefined ? null : list.find((display) => display.id === context.primaryId);
  if (primary) return { display: primary, reason: 'primary' };

  const marked = list.find((display) => display.isPrimary === true);
  return { display: marked ?? list[0], reason: marked ? 'primary' : 'first' };
}

/**
 * Fit a preferred size into a work area.
 *
 * A work area smaller than the minimum window is not a reason to open a window that does not
 * fit: the minimum wins only where it can be honoured. When it cannot, the window is the work
 * area and `belowMinimum` says so, so the caller can lower the window's own minimum to match
 * and the log records why the application is smaller than its design size.
 *
 * @param {{width:number, height:number}} preferred
 * @param {Rect} workArea
 * @param {{minWidth:number, minHeight:number}} limits
 */
export function fitToWorkArea(preferred, workArea, limits) {
  const area = workArea ?? preferred;
  const width = Math.max(1, Math.min(preferred.width, area.width));
  const height = Math.max(1, Math.min(preferred.height, area.height));
  const belowMinimum = width < limits.minWidth || height < limits.minHeight;
  return {
    width,
    height,
    belowMinimum,
    minimum: {
      width: Math.min(limits.minWidth, area.width),
      height: Math.min(limits.minHeight, area.height)
    }
  };
}

/**
 * Centre a size inside a work area, keeping the whole window inside it.
 *
 * Rounding is downward on purpose: a window whose centre lands on a half pixel is rounded to
 * the pixel that leaves the largest margin, not the one that shaves the last pixel off the
 * right edge of a 1024-wide screen.
 *
 * @param {Display} display
 * @param {{width:number, height:number}} size
 * @returns {Rect}
 */
export function placeOnDisplay(display, size) {
  const area = display.workArea ?? display.bounds;
  const x = Math.round(area.x + Math.max(0, (area.width - size.width) / 2));
  const y = Math.round(area.y + Math.max(0, (area.height - size.height) / 2));
  return { x, y, width: size.width, height: size.height };
}

/**
 * Everything `main.js` needs to open the window, in one call.
 *
 * `saved` is accepted and honoured when it still lands on a connected display: a window that
 * was on a monitor somebody has since unplugged is moved to the chosen display rather than
 * opened off-screen, which is the state a user cannot recover from without editing a file.
 *
 * @param {object} input
 * @param {Display[]} input.displays
 * @param {number} [input.primaryId]
 * @param {{x:number,y:number}} [input.cursor]
 * @param {Rect} [input.saved]
 * @param {{width:number, height:number}} input.preferred
 * @param {{minWidth:number, minHeight:number}} input.limits
 */
export function resolvePlacement(input) {
  const { display, reason } = chooseDisplay(input.displays, input);
  if (!display) {
    // No display data at all: the only honest answer is the preferred size, unplaced, and a
    // reason the caller can log. Electron does not produce this, but a test can.
    return {
      bounds: { x: undefined, y: undefined, width: input.preferred.width, height: input.preferred.height },
      displayId: null,
      reason: 'no-displays',
      belowMinimum: false,
      minimum: { width: input.limits.minWidth, height: input.limits.minHeight }
    };
  }

  const area = display.workArea ?? display.bounds;
  if (input.saved) {
    const inside = overlapArea(input.saved, area);
    const savedArea = Math.max(1, input.saved.width * input.saved.height);
    // Two thirds visible is the threshold: enough of the title bar and the content to use it.
    if (inside / savedArea >= 2 / 3) {
      const width = Math.min(input.saved.width, area.width);
      const height = Math.min(input.saved.height, area.height);
      const x = Math.min(Math.max(input.saved.x, area.x), area.x + area.width - width);
      const y = Math.min(Math.max(input.saved.y, area.y), area.y + area.height - height);
      const exact = x === input.saved.x && y === input.saved.y && width === input.saved.width && height === input.saved.height;
      return {
        bounds: { x, y, width, height },
        displayId: display.id,
        reason: exact ? 'restored' : 'restored-clamped',
        belowMinimum: false,
        minimum: { width: input.limits.minWidth, height: input.limits.minHeight }
      };
    }
  }

  const fitted = fitToWorkArea(input.preferred, area, input.limits);
  const bounds = placeOnDisplay(display, { width: fitted.width, height: fitted.height });
  return {
    bounds,
    displayId: display.id,
    reason: input.saved ? 'saved-offscreen' : reason,
    belowMinimum: fitted.belowMinimum,
    minimum: fitted.minimum
  };
}

/**
 * Is the window still usable where it is? Called after a display is removed or its metrics
 * change: a window left with less than two thirds of itself on any connected work area can no
 * longer be dragged back by somebody who cannot see it.
 * @param {Rect} bounds
 * @param {Display[]} displays
 */
export function isStranded(bounds, displays) {
  const list = Array.isArray(displays) ? displays.filter((display) => display && display.bounds) : [];
  if (list.length === 0) return false;
  const total = Math.max(1, bounds.width * bounds.height);
  const visible = list.reduce((sum, display) => sum + overlapArea(bounds, display.workArea ?? display.bounds), 0);
  return visible / total < 2 / 3;
}

/**
 * One sentence for the startup log and the harness report.
 * @param {{bounds:Rect, displayId:number|null, reason:string, belowMinimum:boolean, minimum:{width:number,height:number}}} placement
 * @param {Display|null} display
 */
export function describePlacement(placement, display) {
  if (!display) return `window placed without display data (${placement.reason})`;
  const scale = display.scaleFactor ? ` at ${Math.round(display.scaleFactor * 100)} %` : '';
  const size = `${placement.bounds.width}x${placement.bounds.height}`;
  if (placement.reason === 'no-displays') return `window opened at ${size} with no display data`;
  const where = display.label ? `"${display.label}"` : `display ${display.id}`;
  const why = placement.reason === 'cursor'
    ? 'under the pointer'
    : placement.reason === 'saved-offscreen'
      ? 'because the display it was last on is gone'
      : placement.reason === 'restored' || placement.reason === 'restored-clamped'
        ? 'where it was left'
        : 'on the primary display';
  const squeezed = placement.belowMinimum
    ? '; the work area is smaller than the design minimum, so the window is the work area'
    : '';
  return `window opened at ${size} at ${placement.bounds.x},${placement.bounds.y} ${why}, inside ${where}${scale} (${display.workArea.width}x${display.workArea.height} work area)${squeezed}`;
}
