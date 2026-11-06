/**
 * VERIDEX — keyboard shortcut table.
 *
 * Kept in its own module, with no DOM access, so it can be read by the shortcut reference
 * *and* by tests without booting the interface. A documented shortcut that is not bound is
 * worse than no shortcut at all, so the dialog and the handler both read this one array.
 */

/** The binding list, in the order the reference dialog shows it. */
export const SHORTCUTS = Object.freeze([
  { keys: 'Ctrl+K', label: 'Search everything', action: 'search' },
  { keys: 'Ctrl+F', label: 'Search everything', action: 'search' },
  { keys: 'Ctrl+,', label: 'Open settings', action: 'page:settings' },
  { keys: 'Ctrl+H', label: 'Open history', action: 'page:history' },
  { keys: 'Ctrl+Shift+R', label: 'Run a full scan', action: 'scan' },
  { keys: 'Escape', label: 'Close a dialog, or cancel a running scan', action: 'escape' },
  { keys: 'Ctrl+1 … Ctrl+9', label: 'Jump to the first nine pages', action: 'page:index' },
  { keys: 'F1', label: 'This shortcut reference', action: 'help' }
]);

/**
 * Normalise a keyboard event into the shape used in `SHORTCUTS`.
 *
 * Modifier order is fixed (Ctrl, Shift, key) so a binding cannot be written two ways that
 * look identical to a reader and behave differently to the handler. `metaKey` is folded into
 * Ctrl because Electron on Windows reports one or the other depending on the hardware.
 *
 * @param {KeyboardEvent} event
 * @returns {string}
 */
export function shortcutOf(event) {
  const parts = [];
  if (event.ctrlKey || event.metaKey) parts.push('Ctrl');
  if (event.shiftKey) parts.push('Shift');
  const key = event.key === ' ' ? 'Space' : event.key;
  parts.push(key.length === 1 ? key.toUpperCase() : key);
  return parts.join('+');
}
