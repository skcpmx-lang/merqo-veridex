/**
 * VERIDEX — view helpers.
 *
 * Every function here returns a DOM node or a string. Nothing reads global state, so
 * the whole interface layer is testable with a minimal DOM stub and, more usefully,
 * renderable in a browser without Electron — which is how the visual design was
 * checked in an environment with no Windows host.
 *
 * Two rules encoded here rather than in each page:
 *   - text from the machine is untrusted and is always set through `textContent`,
 *     never interpolated into HTML;
 *   - a status is always rendered as glyph + word, so colour is never the only cue.
 */

import { statusPresentation, statusGlyph, statusAriaLabel } from './theme.js';
import { ICONS } from './icons.js';

/**
 * Create an element. `text` is set with textContent, so a device name containing
 * markup is displayed, not executed.
 * @param {string} tag
 * @param {{class?:string, text?:string, attrs?:Record<string,string>, children?:Node[], style?:Record<string,string>}} [options]
 * @returns {HTMLElement}
 */
/**
 * An inline SVG icon.
 *
 * `createElement` cannot build SVG: the element has to be in the SVG namespace or nothing
 * renders. Icons inherit `currentColor`, so they pick up the accent in the active row and the
 * muted ink everywhere else without a second rule per state.
 * @param {string} name
 * @param {{size?: number, class?: string, title?: string}} [options]
 */
export function icon(name, options = {}) {
  if (typeof document === 'undefined') return null;
  const shape = ICONS[name];
  const size = options.size ?? 18;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', options.class ?? 'vx-icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (options.title) svg.setAttribute('aria-label', options.title);
  if (!shape) {
    // A missing icon is a visible square, on purpose: it is better than an invisible gap that
    // nobody notices, and the test suite fails before it can be shipped.
    const fallback = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    fallback.setAttribute('x', '4');
    fallback.setAttribute('y', '4');
    fallback.setAttribute('width', '16');
    fallback.setAttribute('height', '16');
    fallback.setAttribute('rx', '2');
    fallback.setAttribute('stroke-dasharray', '3 3');
    svg.append(fallback);
    svg.setAttribute('data-missing-icon', name);
    return svg;
  }
  for (const [x, y, width, height, radius] of shape.rects ?? []) {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(width));
    rect.setAttribute('height', String(height));
    if (radius) rect.setAttribute('rx', String(radius));
    svg.append(rect);
  }
  for (const [cx, cy, r] of shape.circles ?? []) {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', String(cx));
    circle.setAttribute('cy', String(cy));
    circle.setAttribute('r', String(r));
    svg.append(circle);
  }
  for (const d of shape.paths ?? []) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

export function el(tag, options = {}) {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined && options.text !== null) node.textContent = String(options.text);
  if (options.attrs) {
    for (const [key, value] of Object.entries(options.attrs)) node.setAttribute(key, value);
  }
  if (options.style) {
    for (const [key, value] of Object.entries(options.style)) node.style.setProperty(key, value);
  }
  for (const child of options.children ?? []) if (child) node.append(child);
  return node;
}

/**
 * A status badge: glyph, word, and an accessible label. Deliberately never a bare
 * colour dot.
 * @param {string} status
 * @param {{showGlyphs?: boolean, size?: 'sm'|'md'}} [options]
 */
export function statusBadge(status, options = {}) {
  const presentation = statusPresentation(status);
  const badge = el('span', {
    class: `vx-badge vx-badge--${presentation.tone}${options.size === 'sm' ? ' vx-badge--sm' : ''}`,
    attrs: { 'data-status': status, 'aria-label': statusAriaLabel(status), role: 'status' }
  });

  const glyph = statusGlyph(status, options.showGlyphs !== false);
  if (glyph) badge.append(el('span', { class: 'vx-badge__glyph', text: glyph, attrs: { 'aria-hidden': 'true' } }));
  badge.append(el('span', { class: 'vx-badge__word', text: presentation.word }));
  return badge;
}

/**
 * Format a field value for display. Units are separated by a non-breaking space so
 * "4200 MHz" never wraps mid-value, and null renders as an em dash rather than
 * "null" or an empty cell that looks like a zero.
 * @param {unknown} value
 * @param {string|null} unit
 */
export function formatValue(value, unit = null) {
  if (value === null || value === undefined) return '—';
  if (value === true) return 'Yes';
  if (value === false) return 'No';

  if (Array.isArray(value)) {
    // `Array.prototype.join` renders objects as "[object Object]", which is what a user saw on
    // the hardware page for per-core data: two of them, comma-separated, meaningless. A count
    // plus the shape of one entry is honest, and the values themselves stay in the field for
    // the report, which renders them properly.
    if (value.length === 0) return 'None recorded';
    if (value.some((entry) => entry !== null && typeof entry === 'object')) {
      const described = value.length === 1 ? '1 entry' : `${value.length} entries`;
      return described;
    }
    return value.map((entry) => formatValue(entry)).join(', ');
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value);
    return keys.length === 0 ? 'None recorded' : keys.length === 1 ? '1 value' : `${keys.length} values`;
  }

  const text = typeof value === 'number' ? (Number.isFinite(value) ? formatNumber(value) : 'Not a number') : String(value);
  return unit ? `${text}\u00A0${unit}` : text;
}

/** @param {number} value */
export function formatNumber(value) {
  if (!Number.isFinite(value)) return '—';
  if (Number.isInteger(value)) return value.toLocaleString('en-GB');
  return value.toLocaleString('en-GB', { maximumFractionDigits: 2 });
}

/**
 * Human duration, used on the scan progress line. Never shows "0.0 s" for a
 * sub-100 ms value.
 * @param {number} ms
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} min ${seconds} s`;
}

/** @param {string} iso */
export function formatTimestamp(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * A key/value row for the detail tables.
 * @param {string} label
 * @param {unknown} value
 * @param {{unit?:string|null, status?:string, source?:string|null, note?:string|null}} [options]
 */
export function fieldRow(label, value, options = {}) {
  const row = el('div', { class: 'vx-row' });
  row.append(el('div', { class: 'vx-row__label', text: label }));

  const valueCell = el('div', { class: 'vx-row__value' });
  if (options.status) valueCell.append(statusBadge(options.status, { size: 'sm' }));
  valueCell.append(el('span', { class: 'vx-row__text', text: formatValue(value, options.unit ?? null) }));
  row.append(valueCell);

  if (options.source) valueCell.append(el('span', { class: 'vx-row__source', text: options.source }));
  if (options.note) row.append(el('div', { class: 'vx-row__note', text: options.note }));
  return row;
}

/**
 * An empty state that says why there is nothing to show. An empty table with no
 * explanation is indistinguishable from a failure.
 * @param {string} title @param {string} detail
 */
export function emptyState(title, detail) {
  return el('div', { class: 'vx-empty', children: [el('p', { class: 'vx-empty__title', text: title }), el('p', { class: 'vx-empty__detail', text: detail })] });
}

/**
 * A coverage strip. Counts are shown with labels, and the percentage is always
 * accompanied by what it is a percentage *of*.
 * @param {Array<{label:string, value:string|number}>} cells
 */
export function coverageStrip(cells) {
  const strip = el('div', { class: 'vx-coverage' });
  for (const cell of cells) {
    strip.append(
      el('div', {
        class: 'vx-coverage__cell',
        children: [el('span', { class: 'vx-coverage__value', text: String(cell.value) }), el('span', { class: 'vx-coverage__label', text: cell.label })]
      })
    );
  }
  return strip;
}

/**
 * A labelled progress bar that always shows the real fraction, never a decorative
 * animation. `indeterminate` is used only when the total is genuinely unknown.
 * @param {{done:number, total:number, label?:string, indeterminate?:boolean}} options
 */
export function progressBar(options) {
  const total = Math.max(1, options.total ?? 1);
  const done = Math.min(total, Math.max(0, options.done ?? 0));
  const percent = options.indeterminate ? 0 : Math.round((done / total) * 100);

  const wrapper = el('div', { class: 'vx-progress', attrs: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(done) } });
  const track = el('div', { class: `vx-progress__track${options.indeterminate ? ' vx-progress__track--indeterminate' : ''}` });
  const fill = el('div', { class: 'vx-progress__fill' });
  fill.style.width = options.indeterminate ? '100%' : `${percent}%`;
  track.append(fill);
  wrapper.append(track);
  wrapper.append(el('div', { class: 'vx-progress__label', text: options.label ?? `${done} of ${total}` }));
  return wrapper;
}

/**
 * A callout. Used for the honest statements the product must make — a low score is
 * not a failure prediction, a test was not run, elevation is missing.
 * @param {{tone?:'info'|'warn'|'bad'|'ok', title:string, body:string, actions?:HTMLElement[]}} options
 */
export function callout(options) {
  return el('div', {
    class: `vx-callout vx-callout--${options.tone ?? 'info'}`,
    children: [
      el('p', { class: 'vx-callout__title', text: options.title }),
      el('p', { class: 'vx-callout__body', text: options.body }),
      ...(options.actions ? [el('div', { class: 'vx-callout__actions', children: options.actions })] : [])
    ]
  });
}

/**
 * A button. Kept as a factory so every button in the app is a real element with a
 * handler attached by the caller — the build contains no decorative buttons.
 * @param {{label:string, onClick:() => void, variant?:'primary'|'ghost'|'danger', disabled?:boolean, title?:string}} options
 */
export function button(options) {
  const node = el('button', {
    class: `vx-button vx-button--${options.variant ?? 'ghost'}`,
    text: options.label,
    attrs: { type: 'button', ...(options.title ? { title: options.title } : {}) }
  });
  node.disabled = Boolean(options.disabled);
  if (typeof options.onClick === 'function' && !options.disabled) {
    node.addEventListener('click', options.onClick);
  } else if (typeof options.onClick === 'function') {
    // A disabled button must not silently accept clicks if it is re-enabled by CSS.
    node.addEventListener('click', (event) => event.preventDefault());
  }
  return node;
}

/**
 * A tab strip. Returns the container plus a `select(id)` function so the caller
 * owns routing; the strip itself holds no state.
 * @param {Array<{id:string, label:string, badge?:string}>} tabs
 * @param {(id:string) => void} onSelect
 */
export function tabStrip(tabs, onSelect) {
  const strip = el('div', { class: 'vx-tabs', attrs: { role: 'tablist' } });
  const buttons = new Map();

  const select = (id) => {
    for (const [tabId, node] of buttons) {
      const active = tabId === id;
      node.classList.toggle('is-active', active);
      node.setAttribute('aria-selected', String(active));
      node.tabIndex = active ? 0 : -1;
    }
  };

  for (const tab of tabs) {
    const node = el('button', {
      class: 'vx-tab',
      attrs: { type: 'button', role: 'tab', 'aria-selected': 'false' }
    });
    node.append(el('span', { text: tab.label }));
    if (tab.badge) node.append(el('span', { class: 'vx-tab__badge', text: tab.badge }));
    node.addEventListener('click', () => {
      select(tab.id);
      onSelect(tab.id);
    });
    buttons.set(tab.id, node);
    strip.append(node);
  }

  return { node: strip, select };
}

/**
 * Sort rows so problems come first, then by label. Mirrors the report's ordering so
 * the screen and the exported document tell the same story.
 * @param {Array<{status:string, label:string}>} rows
 */
export function sortBySeverity(rows) {
  const rank = { FAIL: 0, ERROR: 0, WARNING: 1, PARTIALLY_AVAILABLE: 1, PERMISSION_REQUIRED: 2, UNKNOWN: 3, UNAVAILABLE: 4, UNSUPPORTED: 4, UNTESTED: 4, PASS: 5 };
  return [...rows].sort((a, b) => {
    const difference = (rank[a.status] ?? 3) - (rank[b.status] ?? 3);
    return difference !== 0 ? difference : a.label.localeCompare(b.label);
  });
}

/**
 * The health dial: a ring gauge with the number inside it.
 *
 * The ring repeats information that is also printed as a number and a word, so it is marked
 * decorative for assistive technology and carries the value in a text alternative. A gauge
 * whose only encoding is colour and arc length is unreadable for some users and ambiguous for
 * everyone once the screenshot is greyscale.
 *
 * @param {number|null} score 0–100, or null for an unrated machine
 * @param {{status?: string, rating?: string, label?: string}} [options]
 * @returns {HTMLElement}
 */
export function scoreDial(score, options = {}) {
  const dial = el('div', { class: 'vx-dial' });
  const label = options.label ?? 'Health score';

  if (score === null || score === undefined) {
    dial.classList.add('vx-dial--unrated');
    dial.append(
      el('div', {
        class: 'vx-dial__ring',
        style: { '--dial-tone': 'var(--vx-muted)' },
        attrs: { 'aria-hidden': 'true' }
      }),
      el('div', { class: 'vx-dial__readout', children: [el('span', { class: 'vx-dial__value', text: 'Unrated' })] })
    );
    dial.setAttribute('role', 'img');
    dial.setAttribute('aria-label', `${label}: not rated. This machine has not been measured.`);
    return dial;
  }

  const tone = options.status ? statusPresentation(options.status).tone : 'info';
  const toneToken = ['ok', 'warn', 'bad', 'info'].includes(tone) ? `var(--vx-${tone})` : 'var(--vx-accent)';
  dial.append(
    el('div', { class: 'vx-dial__ring', style: { '--dial-tone': toneToken, '--dial-value': String(score) }, attrs: { 'aria-hidden': 'true' } }),
    el('div', {
      class: 'vx-dial__readout',
      children: [
        el('span', { class: 'vx-dial__value', text: String(score) }),
        el('span', { class: 'vx-dial__unit', text: options.rating ?? 'of 100' })
      ]
    })
  );
  dial.setAttribute('role', 'img');
  dial.setAttribute('aria-label', `${label} ${score} of 100${options.rating ? `, ${options.rating}` : ''}`);
  return dial;
}

// ── Transient feedback (R-20-02) ─────────────────────────────────────────────
//
// A diagnostic run takes minutes and can end in three very different ways. The topbar's
// progress bar answers "how far along", not "did it work", and a user who has navigated away
// from the dashboard gets no answer at all. Toasts carry the answer to wherever they are.
//
// Deliberately restrained: no stacking beyond four, no icons that pulse, no sound. A toast
// that is not read is noise, so each one names one thing that happened and disappears.

/** @type {HTMLElement|null} */
let toastHost = null;

/** Maximum simultaneous toasts. Beyond this the oldest is removed rather than queued. */
const TOAST_LIMIT = 4;

/**
 * The stack inside the application column takes layout space, so it shows one notification at a
 * time: at 700px tall, four full-size toasts took half of the window away from the page they were
 * reporting on. The newest replaces the previous one, and a floating stack (no shell) keeps the
 * larger limit because it covers nothing but itself.
 */
const COLUMN_TOAST_LIMIT = 1;

/**
 * The toast container, created once and appended to the document body.
 * @returns {HTMLElement|null}
 */
function ensureToastHost() {
  if (typeof document === 'undefined' || !document.body) return null;
  if (toastHost && toastHost.isConnected) return toastHost;
  toastHost = el('div', { class: 'vx-toasts', attrs: { role: 'region', 'aria-live': 'polite', 'aria-label': 'Notifications' } });
  // Inside the application column when there is one, so the stack takes layout space at the
  // bottom of the window instead of floating over a card. A notification that covers the value
  // it is reporting on is worse than the seconds it saves.
  const column = document.getElementById('vx-main');
  (column ?? document.body).append(toastHost);
  // The stack floats over the content, so the content needs to know it is there: with the
  // attribute set, the scroll container reserves room for the toast instead of the last card
  // sitting underneath it. A marker rather than a measurement, because the number of toasts is
  // what changes and CSS can size the reserve.
  syncToastMarker();
  return toastHost;
}

/** Mirror the number of visible toasts onto the document. */
function syncToastMarker() {
  if (typeof document === 'undefined' || !document.body) return;
  const count = toastHost && toastHost.isConnected ? toastHost.children.length : 0;
  if (count > 0) document.body.dataset.toasts = String(count);
  else delete document.body.dataset.toasts;
}

/**
 * Show a transient notification.
 *
 * @param {{tone?: 'info'|'good'|'warn'|'bad', title: string, body?: string, timeoutMs?: number}} options
 * @returns {() => void} a function that dismisses it early
 */
export function toast(options) {
  const host = ensureToastHost();
  if (!host) return () => {};

  const tone = options.tone ?? 'info';
  const node = el('div', {
    class: `vx-toast vx-toast--${tone}`,
    attrs: { role: tone === 'bad' ? 'alert' : 'status' }
  });
  node.append(el('p', { class: 'vx-toast__title', text: options.title }));
  if (options.body) node.append(el('p', { class: 'vx-toast__body', text: options.body }));

  const dismiss = () => {
    node.classList.add('is-leaving');
    // Removed on a timer rather than immediately so the transition can run; the element is
    // still removed synchronously when the document is going away.
    const remove = () => {
      node.remove();
      syncToastMarker();
    };
    if (typeof setTimeout === 'function') setTimeout(remove, 180); else remove();
  };

  const close = el('button', {
    class: 'vx-toast__close',
    text: '×',
    attrs: { type: 'button', 'aria-label': `Dismiss: ${options.title}` }
  });
  close.addEventListener('click', dismiss);
  node.append(close);

  host.append(node);
  const limit = host.parentElement?.id === 'vx-main' ? COLUMN_TOAST_LIMIT : TOAST_LIMIT;
  while (host.children.length > limit) host.children[0].remove();
  syncToastMarker();

  const timeout = options.timeoutMs ?? (tone === 'bad' ? 12_000 : 6_000);
  if (timeout > 0 && typeof setTimeout === 'function') setTimeout(dismiss, timeout);
  return dismiss;
}

// ── Modal dialog (R-21-01 shortcut reference, first-run notice) ──────────────

/**
 * Open a modal dialog. Focus moves into it, Escape closes it, and focus returns to
 * whatever had it before — three things that are always skipped when written inline.
 *
 * @param {{title: string, body: Node|Node[], label?: string, onClose?: () => void}} options
 * @returns {{close: () => void, node: HTMLElement}|null}
 */
export function dialog(options) {
  if (typeof document === 'undefined' || !document.body) return null;

  const previouslyFocused = document.activeElement;
  const panel = el('div', { class: 'vx-dialog', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': options.title } });
  const heading = el('h2', { class: 'vx-dialog__title', text: options.title, attrs: { id: 'vx-dialog-title' } });

  const closeButton = button({ label: 'Close', variant: 'ghost', onClick: () => close() });
  const bodyNode = el('div', { class: 'vx-dialog__body' });
  const children = Array.isArray(options.body) ? options.body : [options.body];
  for (const child of children) if (child) bodyNode.append(/** @type {any} */ (child));

  panel.append(heading, bodyNode, el('div', { class: 'vx-dialog__actions', children: [closeButton] }));

  const backdrop = el('div', { class: 'vx-dialog-backdrop' });
  backdrop.append(panel);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    backdrop.remove();
    document.removeEventListener('keydown', onKeydown, true);
    if (previouslyFocused && typeof (/** @type {any} */ (previouslyFocused).focus) === 'function') {
      /** @type {any} */ (previouslyFocused).focus();
    }
    options.onClose?.();
  }

  /** @param {KeyboardEvent} event */
  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  }

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener('keydown', onKeydown, true);
  document.body.append(backdrop);
  // Focus the panel so a screen reader announces the title, and so Escape reaches the handler
  // through the document even before the user tabs anywhere.
  panel.setAttribute('tabindex', '-1');
  /** @type {any} */ (panel).focus?.();

  return { close, node: panel };
}
