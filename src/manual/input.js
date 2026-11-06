/**
 * VERIDEX — Input capture analysers.
 *
 * These modules are pure: they receive the raw event objects the renderer gathered
 * and turn them into evidence and a *suggested* verdict. They never fabricate
 * events, never assume an unpressed key, and never upgrade a partial run into a
 * pass.
 *
 * The renderer owns the Electron event hooks; this module owns the meaning. That
 * split is what makes the logic testable on a machine with no keyboard attached,
 * which is the only way these tests could be tested at all in CI.
 */

import { Status } from '../core/status.js';

/**
 * Essential keys a laptop keyboard must have. Deliberately conservative: this is
 * the set whose absence is a real fault, not every key on a full-size board.
 */
export const ESSENTIAL_KEYS = Object.freeze([
  'Escape', 'Tab', 'CapsLock', 'Space', 'Enter', 'Backspace',
  'ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight',
  'LeftShift', 'RightShift', 'LeftCtrl', 'RightCtrl', 'LeftAlt', 'RightAlt',
  'SuperLeft', 'SuperRight',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0',
  'KeyA', 'KeyB', 'KeyC', 'KeyD', 'KeyE', 'KeyF', 'KeyG', 'KeyH', 'KeyI', 'KeyJ',
  'KeyK', 'KeyL', 'KeyM', 'KeyN', 'KeyO', 'KeyP', 'KeyQ', 'KeyR', 'KeyS', 'KeyT',
  'KeyU', 'KeyV', 'KeyW', 'KeyX', 'KeyY', 'KeyZ',
  'Backquote', 'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash',
  'Semicolon', 'Quote', 'Comma', 'Period', 'Slash',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'
]);

/** Modifier keys, grouped by side so a one-sided fault is visible. */
export const MODIFIER_KEYS = Object.freeze([
  'LeftShift', 'RightShift', 'LeftCtrl', 'RightCtrl', 'LeftAlt', 'RightAlt', 'SuperLeft', 'SuperRight', 'CapsLock'
]);

/** @typedef {{code:string, key?:string, at:number, repeat?:boolean, modifiers?:string[]}} KeyEvent */

/**
 * Analyse a run of key events.
 *
 * @param {KeyEvent[]} events
 * @param {{required?: string[], startedAt?: number, endedAt?: number, expectModifierCombos?: boolean}} [options]
 */
export function analyseKeyboard(events, options = {}) {
  const required = options.required ?? ESSENTIAL_KEYS;
  const list = Array.isArray(events) ? events.filter((event) => event && typeof event.code === 'string') : [];
  /** @type {string[]} */
  const problems = [];

  if (list.length === 0) {
    return {
      ok: false,
      status: Status.UNTESTED,
      detected: [],
      missing: [...required],
      unexpected: [],
      repeats: [],
      verdictCandidate: null,
      notes: ['No key events were captured. Nothing can be concluded about the keyboard.'],
      problems: []
    };
  }

  /** @type {Map<string, {count:number, firstAt:number, lastAt:number, repeats:number}>} */
  const byCode = new Map();
  for (const event of list) {
    const entry = byCode.get(event.code) ?? { count: 0, firstAt: event.at, lastAt: event.at, repeats: 0 };
    entry.count += 1;
    entry.lastAt = event.at;
    if (event.repeat) entry.repeats += 1;
    byCode.set(event.code, entry);
  }

  const detected = required.filter((code) => byCode.has(code));
  const missing = required.filter((code) => !byCode.has(code));
  const known = new Set(required);
  const unexpected = [...byCode.keys()].filter((code) => !known.has(code));
  // A key that only ever fired as an auto-repeat was probably never released,
  // which is a stuck-key symptom worth naming rather than hiding.
  const repeats = [...byCode.entries()]
    .filter(([, entry]) => entry.repeats > 0)
    .map(([code, entry]) => ({ code, count: entry.count, repeats: entry.repeats }));

  const modifiersSeen = MODIFIER_KEYS.filter((code) => byCode.has(code));
  const modifierCombos = list.filter((event) => Array.isArray(event.modifiers) && event.modifiers.length > 1).length;

  if (missing.length > 0) {
    problems.push(`${missing.length} required key(s) produced no event: ${missing.join(', ')}.`);
  }

  let status;
  let verdictCandidate;
  if (missing.length === 0) {
    status = Status.PASS;
    verdictCandidate = Status.PASS;
  } else if (detected.length / required.length >= 0.9) {
    // A handful of silent keys is a warning the inspector should confirm, not an
    // automatic pass and not an automatic condemnation of the whole keyboard.
    status = Status.WARNING;
    verdictCandidate = Status.WARNING;
  } else {
    status = Status.FAIL;
    verdictCandidate = Status.FAIL;
  }

  return {
    ok: true,
    status,
    detected,
    missing,
    unexpected,
    repeats,
    modifiersSeen,
    modifierCombos,
    detectedCount: detected.length,
    requiredCount: required.length,
    percentDetected: Math.round((detected.length / required.length) * 1000) / 10,
    verdictCandidate,
    notes: [
      `${detected.length} of ${required.length} required keys were detected (${Math.round((detected.length / required.length) * 100)}%).`,
      missing.length === 0 ? 'Every required key produced at least one event.' : `Silent keys: ${missing.join(', ')}.`,
      ...(repeats.length ? [`Auto-repeat seen on ${repeats.map((entry) => entry.code).join(', ')}; confirm those keys release cleanly.`] : [])
    ],
    problems
  };
}

/**
 * Analyse modifier-combination evidence. Rollover problems show up as keys that
 * vanish when several are held, so the analyser needs the whole chord.
 * @param {Array<{code:string, modifiers:string[], at:number}>} events
 * @param {{expected?: string[]}} [options]
 */
export function analyseModifiers(events, options = {}) {
  const expected = options.expected ?? MODIFIER_KEYS;
  const list = Array.isArray(events) ? events.filter((event) => event && typeof event.code === 'string') : [];
  if (list.length === 0) {
    return {
      ok: false,
      status: Status.UNTESTED,
      notes: ['No modifier events were captured.'],
      seen: [],
      missing: [...expected],
      problemCombos: []
    };
  }

  const seen = new Set();
  const chords = new Map();
  for (const event of list) {
    seen.add(event.code);
    const combo = [...new Set(event.modifiers ?? [])].sort().join('+');
    if (!combo) continue;
    const record = chords.get(combo) ?? { combo, keys: new Set(), count: 0 };
    record.keys.add(event.code);
    record.count += 1;
    chords.set(combo, record);
  }

  const missing = expected.filter((code) => !seen.has(code));
  // A chord with only the modifier itself and no letter usually means the
  // combination was never actually completed.
  const problemCombos = [...chords.values()]
    .filter((record) => [...record.keys].every((code) => MODIFIER_KEYS.includes(code)))
    .map((record) => record.combo);

  const status = missing.length === 0 ? Status.PASS : missing.length <= 2 ? Status.WARNING : Status.FAIL;
  return {
    ok: true,
    status,
    seen: [...seen],
    missing,
    chords: [...chords.values()].map((record) => ({ combo: record.combo, keys: [...record.keys], count: record.count })),
    problemCombos,
    notes: [
      `${seen.size} of ${expected.length} modifier keys were detected.`,
      missing.length ? `Not detected: ${missing.join(', ')}.` : 'All modifier keys were detected.',
      problemCombos.length
        ? `These chords contained only modifiers, so no combination was actually completed: ${problemCombos.join(', ')}.`
        : 'At least one complete modifier combination was captured.'
    ].filter(Boolean)
  };
}

/** Mouse buttons, in the order an inspector usually tests them. */
export const MOUSE_BUTTONS = Object.freeze([
  { id: 'left', label: 'Left button', electronIndex: 0 },
  { id: 'middle', label: 'Middle button / wheel click', electronIndex: 1 },
  { id: 'right', label: 'Right button', electronIndex: 2 },
  { id: 'back', label: 'Back side button', electronIndex: 3 },
  { id: 'forward', label: 'Forward side button', electronIndex: 4 }
]);

/**
 * Analyse pointer button events.
 * @param {Array<{button:number, type:'down'|'up', at:number}>} events
 * @param {{expectSideButtons?: boolean}} [options]
 */
export function analyseMouseButtons(events, options = {}) {
  const list = Array.isArray(events) ? events.filter((event) => event && Number.isInteger(event.button)) : [];
  if (list.length === 0) {
    return { ok: false, status: Status.UNTESTED, notes: ['No mouse button events were captured.'], pressed: [], chatter: [], stuck: [] };
  }

  const pressed = new Set();
  /** @type {Map<number, {downs:number, ups:number, at:number}>} */
  const perButton = new Map();
  let openDown = null;

  for (const event of list) {
    pressed.add(event.button);
    const record = perButton.get(event.button) ?? { downs: 0, ups: 0, chatter: 0 };
    if (event.type === 'down') {
      record.downs += 1;
      // Two downs with no intervening up is switch chatter/bounce.
      if (openDown === event.button) record.chatter += 1;
      openDown = event.button;
    } else {
      record.ups += 1;
      if (openDown === event.button) openDown = null;
    }
    perButton.set(event.button, record);
  }

  const chatter = [...perButton.entries()].filter(([, record]) => record.chatter > 0).map(([button, record]) => ({ button, count: record.chatter }));
  const stuck = [...perButton.entries()].filter(([, record]) => record.downs !== record.ups).map(([button]) => button);

  const required = [0, 2];
  const missing = required.filter((button) => !pressed.has(button));
  const sideButtonsExpected = options.expectSideButtons === true;
  const sideMissing = sideButtonsExpected ? [3, 4].filter((button) => !pressed.has(button)) : [];

  // A missing button fails the test whether it was required or merely expected:
  // if the inspector said the device has side buttons, a silent one is a fault.
  const anyMissing = missing.length > 0 || sideMissing.length > 0;
  const status = anyMissing ? Status.FAIL : chatter.length > 0 || stuck.length > 0 ? Status.WARNING : Status.PASS;

  return {
    ok: true,
    status,
    pressed: [...pressed].sort((a, b) => a - b),
    labelled: [...pressed].map((button) => MOUSE_BUTTONS.find((entry) => entry.electronIndex === button)?.id ?? `button${button}`),
    chatter,
    stuck,
    missing: [...missing, ...sideMissing],
    notes: [
      `Buttons captured: ${[...pressed].map((button) => MOUSE_BUTTONS.find((entry) => entry.electronIndex === button)?.label ?? `button ${button}`).join(', ')}.`,
      chatter.length ? `Chatter detected on ${chatter.map((entry) => entry.button).join(', ')}: one press produced more than one down event.` : 'No button chatter detected.',
      stuck.length ? `These buttons have unbalanced down/up events: ${stuck.join(', ')}.` : 'Every button released cleanly.',
      ...(sideButtonsExpected && sideMissing.length ? [`Expected side buttons produced nothing: ${sideMissing.join(', ')}.`] : [])
    ]
  };
}

/**
 * Analyse scroll-wheel events.
 * @param {Array<{deltaX:number, deltaY:number, at:number}>} events
 */
export function analyseWheel(events) {
  const list = Array.isArray(events) ? events.filter((event) => event && Number.isFinite(event.deltaY)) : [];
  if (list.length === 0) {
    return { ok: false, status: Status.UNTESTED, notes: ['No scroll events were captured.'], up: 0, down: 0, horizontal: 0, reversals: 0 };
  }

  let up = 0;
  let down = 0;
  let horizontal = 0;
  let reversals = 0;
  let lastSign = 0;
  for (const event of list) {
    if (event.deltaY < 0) up += 1;
    else if (event.deltaY > 0) down += 1;
    if (Math.abs(event.deltaX ?? 0) > 0) horizontal += 1;
    const sign = Math.sign(event.deltaY);
    if (sign !== 0) {
      if (lastSign !== 0 && sign !== lastSign) reversals += 1;
      lastSign = sign;
    }
  }

  const bothDirections = up > 0 && down > 0;
  // Reversals during a single continuous scroll are the classic worn-encoder
  // symptom, so a high ratio is a warning rather than a pass.
  const reversalRatio = list.length === 0 ? 0 : reversals / list.length;
  const status = !bothDirections ? Status.WARNING : reversalRatio > 0.35 ? Status.WARNING : Status.PASS;

  return {
    ok: true,
    status,
    up,
    down,
    horizontal,
    reversals,
    notes: [
      `Captured ${up} scroll-up and ${down} scroll-down event(s).`,
      bothDirections ? 'Both directions produced events.' : 'Only one scroll direction produced events.',
      reversals > 0 ? `${reversals} direction change(s) were recorded. Some are expected when you change direction deliberately; a reversal in the middle of one continuous scroll indicates a worn encoder.` : 'No direction changes were recorded.',
      horizontal > 0 ? `${horizontal} horizontal scroll event(s) were also captured.` : ''
    ].filter(Boolean)
  };
}

/**
 * Analyse pointer movement. This reports travel and stations reached; it does not
 * claim to have judged acceleration, because that needs the human's expectation of
 * how the pointer *should* feel.
 * @param {Array<{x:number, y:number, at:number}>} points
 * @param {{width:number, height:number, stations?: Array<{id:string, x:number, y:number, r:number}>}} options
 */
export function analysePointer(points, options = {}) {
  const list = Array.isArray(points) ? points.filter((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y)) : [];
  const stations = options.stations ?? [];
  if (list.length < 2) {
    return {
      ok: false,
      status: Status.UNTESTED,
      notes: ['Not enough pointer movement was captured to conclude anything.'],
      travel: 0,
      reached: [],
      missed: stations.map((station) => station.id),
      maxJump: 0
    };
  }

  let travel = 0;
  let maxJump = 0;
  let gaps = 0;
  for (let index = 1; index < list.length; index += 1) {
    const previous = list[index - 1];
    const current = list[index];
    const distance = Math.hypot(current.x - previous.x, current.y - previous.y);
    travel += distance;
    if (distance > maxJump) maxJump = distance;
    // A long silence between two samples with a large jump is a stutter, not
    // fast movement: the pointer stopped reporting and resumed elsewhere.
    if (current.at - previous.at > 250 && distance > 40) gaps += 1;
  }

  const reached = [];
  const missed = [];
  for (const station of stations) {
    const hit = list.some((point) => Math.hypot(point.x - station.x, point.y - station.y) <= station.r);
    (hit ? reached : missed).push(station.id);
  }

  const status = stations.length > 0 ? (missed.length === 0 ? Status.PASS : Status.WARNING) : Status.WARNING;
  return {
    ok: true,
    status,
    travel: Math.round(travel),
    maxJump: Math.round(maxJump),
    gaps,
    reached,
    missed,
    samples: list.length,
    notes: [
      `Captured ${list.length} pointer samples covering ${Math.round(travel)} px of travel.`,
      stations.length ? `Reached ${reached.length} of ${stations.length} on-screen target(s).` : 'No target stations were configured, so only travel was measured.',
      missed.length ? `Targets not reached: ${missed.join(', ')}.` : '',
      gaps > 0 ? `${gaps} sample gap(s) looked like stutter rather than fast movement.` : 'No stutter was detected between samples.',
      'Pointer acceleration is a feel judgement: the app reports travel, it does not decide whether acceleration is correct.'
    ].filter(Boolean)
  };
}

/**
 * Analyse USB arrival events against the port an inspector selected.
 *
 * Attribution honesty: Windows does not reliably tell an application which physical
 * port a device arrived on, so this analyser records which port the inspector said
 * they were using at the moment of arrival. The report must not present that as a
 * port-level hardware measurement.
 * @param {Array<{vendorId?:string, productId?:string, name:string, at:number}>} arrivals
 * @param {{selectedPort?: string|null, baselineDeviceIds?: string[]}} [options]
 */
export function analyseUsbPorts(arrivals, options = {}) {
  const list = Array.isArray(arrivals) ? arrivals.filter((event) => event && typeof event.at === 'number') : [];
  const baseline = new Set(options.baselineDeviceIds ?? []);
  // Devices present before the test started cannot be evidence for a port.
  const newDevices = list.filter((event) => !baseline.has(identifier(event)));

  if (list.length === 0 && newDevices.length === 0) {
    return {
      ok: false,
      status: Status.UNTESTED,
      notes: ['No USB arrival events were captured. Plug a device into the selected port while the test is running.'],
      arrivals: [],
      attribution: 'No arrival to attribute.'
    };
  }

  const selectedPort = options.selectedPort ?? null;
  return {
    ok: true,
    status: newDevices.length > 0 ? Status.PASS : Status.WARNING,
    arrivals: newDevices.map((event) => ({ name: event.name, at: event.at, port: selectedPort })),
    attribution: selectedPort
      ? `The inspector selected "${selectedPort}". Windows does not expose reliable per-port arrival information to applications, so this record means "a device arrived while this port was selected", not "this port was electrically tested".`
      : 'No port was selected, so arrivals cannot be attributed to a physical port.',
    notes: [
      `${newDevices.length} new device arrival(s) were captured.`,
      list.length !== newDevices.length ? `${list.length - newDevices.length} arrival(s) were for devices already present and are excluded.` : '',
      selectedPort ? `Attributed to the inspector-selected port "${selectedPort}".` : 'No port was selected.'
    ].filter(Boolean)
  };
}

/** @param {{vendorId?:string, productId?:string, name:string}} event */
function identifier(event) {
  return `${event.vendorId ?? ''}:${event.productId ?? ''}:${event.name ?? ''}`;
}

/**
 * Electrical USB speed, derived from the negotiated speed the driver reports.
 * Reported as a fact, never as a verdict on the port's condition.
 * @param {string|null} speedName
 */
export function usbSpeedNote(speedName) {
  if (!speedName) return { level: null, text: 'The device did not report a negotiated USB speed.' };
  const normalised = String(speedName).toLowerCase();
  if (normalised.includes('super') || normalised.includes('5') || normalised.includes('10')) {
    return { level: '3.x', text: `Negotiated USB ${speedName}: the port is operating at SuperSpeed.` };
  }
  if (normalised.includes('high') || normalised.includes('480')) {
    return { level: '2.0', text: `Negotiated USB ${speedName}: high speed. A USB 3 port that never negotiates SuperSpeed is worth checking with a known USB 3 device.` };
  }
  return { level: 'slow', text: `Negotiated USB ${speedName}: this is a low or full speed device, so port speed cannot be judged from it.` };
}
