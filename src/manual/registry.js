/**
 * VERIDEX — Manual inspection registry.
 *
 * Some things software cannot measure: whether a laptop hinge creaks, whether the
 * backlight bleeds at the corners, whether the audio jack sounds crackly. VERIDEX
 * guides the person doing the inspection and records what they report.
 *
 * This module is strict about a distinction the brief demands:
 *
 *   - `capture`  — the app observes a real event from the device (a key code
 *                  arriving, a mouse button press, a USB device appearing). The
 *                  verdict can be computed from captured evidence.
 *   - `observe`  — the human is the instrument. The app provides the stimulus and
 *                  records the verdict, and the report labels it as a human
 *                  observation, never as an automated result.
 *
 * A test with `kind: 'observe'` can never be reported as PASS without a human
 * verdict being recorded. There is no path in this codebase that infers an
 * observation from the presence of hardware.
 *
 * Every test also declares `evidence` — the concrete things the inspector should
 * have looked at — so a report can state what was and was not examined, rather
 * than just "keyboard: OK".
 */

/** @typedef {'capture'|'observe'} TestKind */

/**
 * @typedef {object} ManualTest
 * @property {string} id
 * @property {string} title
 * @property {TestKind} kind
 * @property {string} [component]        Report section this feeds, if any.
 * @property {string} instructions       What the inspector must actually do.
 * @property {string} [passCriteria]     When the human should record PASS.
 * @property {string[]} evidence         What to look or listen for.
 * @property {string[]} [prerequisites]  Conditions to establish first.
 * @property {string} [captureModule]    Module that provides captured evidence.
 * @property {string[]} [notApplicableWhen] Reasons this test may legitimately not apply.
 */

/**
 * @typedef {object} ManualSuite
 * @property {string} id
 * @property {string} title
 * @property {string} component
 * @property {string} summary
 * @property {string} [requiresHardware]
 * @property {ManualTest[]} tests
 */

/** @type {ManualSuite[]} */
export const MANUAL_SUITES = [
  {
    id: 'display',
    title: 'Display inspection',
    component: 'display',
    summary: 'Panel uniformity, dead pixels, backlight bleed, geometry and text sharpness. The pattern player provides the stimulus; your eyes do the measuring.',
    tests: [
      {
        id: 'display.white',
        title: 'White field: dead pixels and dust',
        kind: 'observe',
        instructions: 'Display the white field full-screen, then scan the whole panel slowly from edge to edge. Count any pixel that stays black.',
        passCriteria: 'No permanently dark pixels, or a count you are willing to accept for this panel.',
        evidence: ['Dark spots on a white field', 'Dust versus dead pixels (dust moves, dead pixels do not)', 'A defect count you can record'],
        prerequisites: ['Screen cleaned and fingerprints removed', 'Panel at its normal brightness'],
        captureModule: 'src/diagnostics/display.js'
      },
      {
        id: 'display.black',
        title: 'Black field: stuck pixels and backlight bleed',
        kind: 'observe',
        instructions: 'Display the black and 5% grey fields in a dimmed room. Check each edge and corner for light leaking past the panel edge.',
        passCriteria: 'No bright pixels and no bleed visible at normal viewing brightness.',
        evidence: ['Bright pixels that stay lit on black', 'Corner glow', 'Bleed extent (mild / moderate / severe)'],
        prerequisites: ['Room lighting dimmed', 'Brightness at the level you normally use'],
        captureModule: 'src/diagnostics/display.js'
      },
      {
        id: 'display.colour',
        title: 'Colour fields and uniformity (mura)',
        kind: 'observe',
        instructions: 'Cycle the red, green, blue, cyan, magenta, yellow and mid-grey fields. Look for patches, tinting or blotchiness that persist across colours.',
        passCriteria: 'Uniform colour across the panel with no tinting visible in normal use.',
        evidence: ['Colour patches', 'Green or pink tint at the edges', 'Mura (blotchy patches) on mid grey'],
        captureModule: 'src/diagnostics/display.js'
      },
      {
        id: 'display.gradient',
        title: 'Gradients and banding',
        kind: 'observe',
        instructions: 'Display the greyscale gradient, the RGB gradient and the 32-step greyscale ramp. Watch for visible steps instead of a smooth ramp.',
        passCriteria: 'Smooth transitions with no obvious banding or crushed blacks.',
        evidence: ['Visible bands', 'Crushed detail at the dark end', 'Posterisation in photographs'],
        captureModule: 'src/diagnostics/display.js'
      },
      {
        id: 'display.geometry',
        title: 'Geometry and edge cropping',
        kind: 'observe',
        instructions: 'Display the crosshair-and-border pattern. Confirm all four borders are fully visible and the crosshair sits at the centre.',
        passCriteria: 'Borders visible on all four sides and the centre mark is centred.',
        evidence: ['Cropped edges', 'Off-centre image', 'Asymmetric overscan'],
        captureModule: 'src/diagnostics/display.js'
      },
      {
        id: 'display.text',
        title: 'Text clarity and subpixel rendering',
        kind: 'observe',
        instructions: 'Display the text pattern at 100% scaling. Read the small sizes: they should be legible, not fringed or smeared.',
        passCriteria: 'Text legible at the smallest size shown, with no colour fringing on vertical strokes.',
        evidence: ['Colour fringing', 'Blurring', 'Uneven stroke weight'],
        captureModule: 'src/diagnostics/display.js'
      }
    ]
  },

  {
    id: 'keyboard',
    title: 'Keyboard test',
    component: 'keyboard',
    summary: 'Every essential key is detected from real key events. Keys you never press are reported as untested, not as passing.',
    requiresHardware: 'A physical keyboard or a working on-screen keyboard',
    tests: [
      {
        id: 'keyboard.keys',
        title: 'Essential keys respond',
        kind: 'capture',
        instructions: 'Press every highlighted key shown on the keyboard map. VERIDEX records which keys actually produce an event.',
        passCriteria: 'Every essential key is detected at least once.',
        evidence: ['Detected key list with timings', 'Missing keys listed by name', 'Duplicate or repeat events'],
        captureModule: 'src/manual/keyboard.js'
      },
      {
        id: 'keyboard.modifiers',
        title: 'Modifier combinations',
        kind: 'capture',
        instructions: 'Hold each modifier (Shift, Ctrl, Alt, AltGr, Win) and press a letter, then press every modifier together to check for rollover limits.',
        passCriteria: 'Every modifier registers both alone and in combination; no keys drop when several are held.',
        evidence: ['Modifier state during combination', 'Dropped keys when multiple are held (rollover)', 'Stuck modifier after release'],
        captureModule: 'src/manual/keyboard.js'
      },
      {
        id: 'keyboard.functionKeys',
        title: 'Function row and media keys',
        kind: 'capture',
        instructions: 'Press F1–F12 and the media/brightness keys. Note whether the Fn layer must be held (the app reports what it receives).',
        passCriteria: 'All function keys register and no key is remapped to something you did not expect.',
        evidence: ['Received function keys', 'Keys that emit nothing', 'Keys reporting a different code than their label'],
        captureModule: 'src/manual/keyboard.js'
      },
      {
        id: 'keyboard.backlight',
        title: 'Keyboard backlight',
        kind: 'observe',
        instructions: 'Cycle the keyboard backlight through its levels and time-out, if the machine has one.',
        passCriteria: 'Backlight changes level, and turns off when it should.',
        evidence: ['Levels available', 'Uneven illumination', 'Keys not lit'],
        notApplicableWhen: ['The machine has no keyboard backlight']
      }
    ]
  },

  {
    id: 'mouse',
    title: 'Mouse and pointer test',
    component: 'mouse',
    summary: 'Buttons, wheel directions and pointer tracking are captured from real input events. Drag accuracy and feel require your judgement.',
    tests: [
      {
        id: 'mouse.buttons',
        title: 'Buttons respond',
        kind: 'capture',
        instructions: 'Click every button the device has: left, right, middle, and side buttons if present. Press each several times.',
        passCriteria: 'Every present button registers, and none registers without being pressed (no double-firing).',
        evidence: ['Button press log', 'Bounce or chatter (one press, several events)', 'Buttons that only work if pressed hard'],
        captureModule: 'src/manual/mouse.js'
      },
      {
        id: 'mouse.wheel',
        title: 'Scroll wheel direction and detents',
        kind: 'capture',
        instructions: 'Scroll up and down through the on-screen list, slowly and quickly.',
        passCriteria: 'Scrolling up moves content up, with no reversal and no skipped detents.',
        evidence: ['Scroll direction events', 'Skipped detents', 'Reversal or jitter'],
        captureModule: 'src/manual/mouse.js'
      },
      {
        id: 'mouse.tracking',
        title: 'Pointer tracking and acceleration',
        kind: 'capture',
        instructions: 'Trace the on-screen target path slowly, then quickly. Then drag an object across the screen and back.',
        passCriteria: 'Pointer reaches every part of the screen smoothly, with no jumps, dead zones or dropped drags.',
        evidence: ['Jump or stutter', 'Dead zones', 'Dropped drag', 'Acceleration curve (the app reports pointer travel counts, not a verdict)'],
        captureModule: 'src/manual/mouse.js'
      },
      {
        id: 'mouse.doubleClick',
        title: 'Double-click timing',
        kind: 'observe',
        instructions: 'Double-click the target several times at your normal speed, then slowly.',
        passCriteria: 'Your normal double-click registers as one double-click, not two separate clicks or a drag.',
        evidence: ['Failed double-clicks', 'Accidental drags', 'Chatter on a worn switch'],
        captureModule: 'src/manual/mouse.js'
      }
    ]
  },

  {
    id: 'touchpad',
    title: 'Touchpad and trackpoint test',
    component: 'touchpad',
    summary: 'Presence is detected by the OS. Gestures, tap force, palm rejection and drift are physical behaviours only you can judge.',
    tests: [
      {
        id: 'touchpad.presence',
        title: 'Touchpad is present and enabled',
        kind: 'capture',
        instructions: 'VERIDEX reads whether Windows reports a precision touchpad. Confirm it matches the physical device.',
        passCriteria: 'The OS reports a touchpad and the cursor moves when you use it.',
        evidence: ['Device name reported by Windows', 'Precision touchpad capability', 'Enabled or disabled state'],
        notApplicableWhen: ['The machine is a desktop with no touchpad'],
        captureModule: 'src/manual/touchpad.js'
      },
      {
        id: 'touchpad.surface',
        title: 'Surface tracking and drift',
        kind: 'observe',
        instructions: 'Rest a finger on the pad without moving it for ten seconds, then move it slowly across the surface.',
        passCriteria: 'The cursor does not creep while the finger is still, and tracks evenly across the whole surface.',
        evidence: ['Cursor drift while stationary', 'Dead areas near the edges', 'Uneven tracking speed'],
        notApplicableWhen: ['No touchpad'],
        captureModule: 'src/manual/touchpad.js'
      },
      {
        id: 'touchpad.buttons',
        title: 'Physical click and tap-to-click',
        kind: 'observe',
        instructions: 'Click both bottom corners, then tap once and twice with tap-to-click enabled.',
        passCriteria: 'Both corners click with a consistent feel, and tap-to-click registers reliably.',
        evidence: ['One corner requiring more force', 'Taps that do not register', 'Accidental taps'],
        notApplicableWhen: ['No touchpad'],
        captureModule: 'src/manual/touchpad.js'
      },
      {
        id: 'touchpad.gestures',
        title: 'Multi-finger gestures',
        kind: 'observe',
        instructions: 'Try two-finger scroll, two-finger right-click, three-finger swipe and pinch-to-zoom.',
        passCriteria: 'Every gesture you use in daily work registers reliably.',
        evidence: ['Gestures that do not register', 'Scroll direction reversed', 'Gesture triggering accidentally'],
        notApplicableWhen: ['No touchpad'],
        captureModule: 'src/manual/touchpad.js'
      },
      {
        id: 'touchpad.palmRejection',
        title: 'Palm rejection',
        kind: 'observe',
        instructions: 'Type a full paragraph while your palms rest naturally on the touchpad area.',
        passCriteria: 'No cursor jumps while typing.',
        evidence: ['Cursor jumps during typing', 'Accidental clicks', 'Text inserted in the wrong place'],
        notApplicableWhen: ['No touchpad']
      }
    ]
  },

  {
    id: 'audio',
    title: 'Audio test',
    component: 'audio',
    summary: 'VERIDEX generates real test signals and records the device list. Whether you actually hear them is your judgement; nothing is inferred from a driver being present.',
    tests: [
      {
        id: 'audio.devices',
        title: 'Output and input devices enumerate',
        kind: 'capture',
        instructions: 'VERIDEX lists the playback and recording devices the OS reports. Confirm they match what you expect.',
        passCriteria: 'Expected speakers, headphones and microphone appear in the list.',
        evidence: ['Device names and states', 'A device present but disabled', 'A device that disappears when reconnected'],
        captureModule: 'src/manual/audio.js'
      },
      {
        id: 'audio.output',
        title: 'Speaker output',
        kind: 'observe',
        instructions: 'Play the sweep, the channel test and the left/right test at a moderate volume. Listen for distortion, buzzing and imbalance.',
        passCriteria: 'Both channels produce clean sound with no rattle or dropouts at your normal listening level.',
        evidence: ['Which channel is silent or weak', 'Buzzing or crackle', 'Distortion at higher volume', 'Channel imbalance'],
        captureModule: 'src/manual/audio.js'
      },
      {
        id: 'audio.headphoneJack',
        title: 'Headphone jack detection',
        kind: 'observe',
        instructions: 'Plug headphones into the 3.5 mm jack and play the test sweep. Then unplug them.',
        passCriteria: 'Plugging in switches output to the headphones and unplugging switches it back, with no crackle when the plug moves.',
        evidence: ['Detection on plug in/out', 'Sound continuing from the speakers', 'Crackle when the plug is wiggled'],
        notApplicableWhen: ['The machine has no 3.5 mm jack'],
        captureModule: 'src/manual/audio.js'
      },
      {
        id: 'audio.microphone',
        title: 'Microphone capture level',
        kind: 'capture',
        instructions: 'VERIDEX shows a live input level meter from the array microphone. Speak normally and then stay silent.',
        passCriteria: 'The meter responds to speech and falls to near-silence when you are quiet (no constant hum or noise floor).',
        evidence: ['Peak level while speaking', 'Noise floor while silent', 'A dead or always-clipping input'],
        notApplicableWhen: ['The machine has no microphone'],
        captureModule: 'src/manual/audio.js'
      },
      {
        id: 'audio.microphoneQuality',
        title: 'Microphone clarity',
        kind: 'observe',
        instructions: 'Record a short phrase using VERIDEX and play it back. Listen for hiss, clipping and dropouts.',
        passCriteria: 'Speech is intelligible on playback with no hiss or clipping at normal speaking distance.',
        evidence: ['Hiss or hum', 'Clipping', 'Dropouts'],
        notApplicableWhen: ['The machine has no microphone']
      }
    ]
  },

  {
    id: 'camera',
    title: 'Camera test',
    component: 'camera',
    summary: 'VERIDEX can enumerate cameras and show a local preview. Frames never leave the machine and are never written to a report.',
    tests: [
      {
        id: 'camera.presence',
        title: 'Camera enumerates',
        kind: 'capture',
        instructions: 'VERIDEX lists the video capture devices the OS reports, including the privacy shutter state where available.',
        passCriteria: 'The expected camera appears in the list.',
        evidence: ['Device name', 'Driver state', 'Absence of a camera the machine is supposed to have'],
        notApplicableWhen: ['The machine has no camera'],
        captureModule: 'src/manual/camera.js'
      },
      {
        id: 'camera.image',
        title: 'Image quality',
        kind: 'observe',
        instructions: 'Open the local preview. Look at the image while moving your hand in front of the lens.',
        passCriteria: 'A clear, correctly exposed image with no colour cast, dead columns or stuck pixels.',
        evidence: ['Blur or soft focus', 'Colour cast', 'Stuck pixels or dead columns', 'Motion smearing'],
        notApplicableWhen: ['No camera'],
        captureModule: 'src/manual/camera.js'
      },
      {
        id: 'camera.privacyShutter',
        title: 'Privacy shutter and indicator',
        kind: 'observe',
        instructions: 'Close the physical privacy shutter if fitted, and confirm the activity indicator behaves as expected while the preview is open.',
        passCriteria: 'The shutter fully blocks the image, and the indicator shows when the camera is active.',
        evidence: ['Light leaking past the shutter', 'Indicator that never lights', 'Indicator that stays on'],
        notApplicableWhen: ['The machine has no privacy shutter']
      }
    ]
  },

  {
    id: 'ports',
    title: 'Ports and connectivity test',
    component: 'ports',
    summary: 'USB ports are verified by plugging in a real device: VERIDEX watches for the arrival event and attributes it to the port you selected. Video and card readers require your observation.',
    tests: [
      {
        id: 'ports.usb',
        title: 'USB ports accept a device',
        kind: 'capture',
        instructions: 'Select a port label, then plug a known-good USB device into that port. Unplug and repeat for every port.',
        passCriteria: 'Every port produces a device-arrival event while it is selected.',
        evidence: ['Arrival event per port', 'Ports with no event', 'Device that only works at USB 2 speeds'],
        captureModule: 'src/manual/ports.js'
      },
      {
        id: 'ports.video',
        title: 'Video outputs',
        kind: 'observe',
        instructions: 'Connect an external display to HDMI and to DisplayPort/USB-C video if present. Confirm the display is detected and the image is stable.',
        passCriteria: 'Each output drives a display at its rated resolution with no flicker.',
        evidence: ['Outputs that detect nothing', 'Flicker or dropouts', 'Resolution limited below the cable rating'],
        notApplicableWhen: ['The machine has no external video output']
      },
      {
        id: 'ports.cardReader',
        title: 'SD or microSD reader',
        kind: 'observe',
        instructions: 'Insert a card, confirm it mounts, then eject and remove it.',
        passCriteria: 'The card mounts, and ejecting it is safe with no read errors.',
        evidence: ['Card not detected', 'Read errors', 'Card only detected when re-inserted'],
        notApplicableWhen: ['The machine has no card reader']
      },
      {
        id: 'ports.chargingPort',
        title: 'Charging connector',
        kind: 'observe',
        instructions: 'Connect the charger and watch the reported charge rate and battery direction.',
        passCriteria: 'The machine reports charging at roughly its rated wattage, and the plug does not need to be wiggled.',
        evidence: ['Reported charge rate', 'Charging only in one cable position', 'Connector that cuts out when moved'],
        notApplicableWhen: ['The machine has no battery or uses a fixed cable']
      }
    ]
  }
];

/** Flat test index, keyed by test id. */
export const MANUAL_TESTS = Object.freeze(
  MANUAL_SUITES.flatMap((suite) => suite.tests.map((test) => Object.freeze({ ...test, suiteId: suite.id, component: test.component ?? suite.component })))
);

const TEST_BY_ID = new Map(MANUAL_TESTS.map((test) => [test.id, test]));

/** @param {string} id */
export function manualTest(id) {
  return TEST_BY_ID.get(id) ?? null;
}

/** @param {string} id */
export function manualSuite(id) {
  return MANUAL_SUITES.find((suite) => suite.id === id) ?? null;
}

/** All test ids, in registry order. */
export function allTestIds() {
  return MANUAL_TESTS.map((test) => test.id);
}

/**
 * Structural validation. The registry is data, so it can be wrong; this makes the
 * wrongness a test failure rather than a mystery in the UI.
 * @param {ManualSuite[]} [suites]
 */
export function validateRegistry(suites = MANUAL_SUITES) {
  /** @type {string[]} */
  const problems = [];
  const seen = new Set();
  for (const suite of suites) {
    if (!suite.id) problems.push('a suite has no id');
    if (!suite.tests?.length) problems.push(`suite "${suite.id}" has no tests`);
    for (const test of suite.tests) {
      if (!test.id) problems.push(`suite "${suite.id}" has a test with no id`);
      if (seen.has(test.id)) problems.push(`duplicate test id "${test.id}"`);
      seen.add(test.id);
      if (test.kind !== 'capture' && test.kind !== 'observe') {
        problems.push(`test "${test.id}" has kind "${test.kind}"; must be "capture" or "observe"`);
      }
      if (!test.instructions || test.instructions.length < 20) {
        problems.push(`test "${test.id}" needs real instructions, not a placeholder`);
      }
      if (!Array.isArray(test.evidence) || test.evidence.length === 0) {
        problems.push(`test "${test.id}" must state what evidence to look for`);
      }
      // A capture test without a module would promise automation that does not exist.
      if (test.kind === 'capture' && !test.captureModule) {
        problems.push(`capture test "${test.id}" must name the module that captures its evidence`);
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * What the report and the UI must say about a test. Used verbatim so the label
 * cannot drift from the registry.
 * @param {string} id
 */
export function testProvenance(id) {
  const test = manualTest(id);
  if (!test) return { kind: 'unknown', label: 'Unknown test', automated: false, statement: `Test "${id}" is not in the manual registry.` };
  if (test.kind === 'capture') {
    return {
      kind: 'capture',
      label: 'Captured from device events',
      automated: true,
      statement: `VERIDEX captured real events for this test${test.captureModule ? ` (${test.captureModule})` : ''}. The verdict is computed from the captured evidence, and any part you did not exercise stays untested.`
    };
  }
  return {
    kind: 'observe',
    label: 'Manual observation',
    automated: false,
    statement: 'This result is a human observation recorded during the inspection. It is not an automated measurement, and VERIDEX did not verify it independently.'
  };
}
