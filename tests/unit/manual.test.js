import test from 'node:test';
import assert from 'node:assert/strict';

import { Status } from '../../src/core/status.js';
import {
  MANUAL_SUITES, MANUAL_TESTS, manualTest, manualSuite, allTestIds,
  validateRegistry, testProvenance
} from '../../src/manual/registry.js';
import {
  InspectionSession, RECORDABLE_VERDICTS, applicableSuites, printableChecklist
} from '../../src/manual/session.js';
import {
  ESSENTIAL_KEYS, MODIFIER_KEYS, analyseKeyboard, analyseModifiers,
  analyseMouseButtons, analyseWheel, analysePointer, analyseUsbPorts, usbSpeedNote
} from '../../src/manual/input.js';

const NOW = () => new Date('2026-11-05T10:00:00.000Z');

// ── Registry ─────────────────────────────────────────────────────────────────

test('the manual registry is structurally valid', () => {
  const result = validateRegistry();
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
});

test('every suite the brief names is present', () => {
  const ids = MANUAL_SUITES.map((suite) => suite.id);
  for (const expected of ['display', 'keyboard', 'mouse', 'touchpad', 'audio', 'camera', 'ports']) {
    assert.ok(ids.includes(expected), `suite "${expected}" must exist`);
  }
});

test('test ids are unique and resolvable', () => {
  const ids = allTestIds();
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.ok(manualTest(id), `${id} must resolve`);
  assert.equal(manualTest('does.not.exist'), null);
  assert.equal(manualSuite('keyboard').id, 'keyboard');
  assert.equal(manualSuite('nope'), null);
});

test('every test has real instructions, not a placeholder', () => {
  for (const suite of MANUAL_SUITES) {
    assert.ok(suite.summary.length > 30, `${suite.id} needs a real summary`);
    for (const test of suite.tests) {
      assert.ok(test.instructions.length > 30, `${test.id} has thin instructions`);
      assert.ok(!/todo|lorem|placeholder|tbd/i.test(test.instructions), `${test.id} contains placeholder text`);
      assert.ok(test.evidence.length > 0, `${test.id} must say what evidence to look for`);
    }
  }
});

test('a capture test always names the module that captures its evidence', () => {
  const captures = MANUAL_TESTS.filter((test) => test.kind === 'capture');
  assert.ok(captures.length >= 6, 'the brief requires real capture-based tests');
  for (const test of captures) {
    assert.ok(test.captureModule, `${test.id} promises automation but names no module`);
  }
});

test('provenance labels separate observation from capture, and never claim automation for a human verdict', () => {
  const capture = testProvenance('keyboard.keys');
  assert.equal(capture.automated, true);
  assert.match(capture.statement, /captured real events/i);

  const observe = testProvenance('display.black');
  assert.equal(observe.automated, false);
  assert.match(observe.statement, /human observation/i);
  assert.match(observe.statement, /not an automated measurement/i);

  assert.equal(testProvenance('nope').kind, 'unknown');
});

// ── Session rules ────────────────────────────────────────────────────────────

test('a fresh session reports every test as untested, not as passing', () => {
  const session = new InspectionSession({ now: NOW });
  const coverage = session.coverage();
  assert.equal(coverage.answered, 0);
  assert.equal(coverage.passed, 0);
  assert.equal(coverage.untested, coverage.totalTests);
  assert.match(coverage.statement, /not run and are reported as UNTESTED, not as passing/);
  assert.deepEqual(session.resultsForReport(), []);
});

test('UNTESTED cannot be recorded as a verdict', () => {
  const session = new InspectionSession({ now: NOW });
  const attempt = session.record('keyboard.keys', Status.UNTESTED, { notes: ['did not try'] });
  assert.equal(attempt.ok, false);
  assert.match(attempt.problems[0], /cannot be recorded as a verdict/);
  assert.equal(session.results.size, 0);
});

test('only the four real verdicts are recordable', () => {
  assert.deepEqual([...RECORDABLE_VERDICTS], [Status.PASS, Status.FAIL, Status.WARNING, Status.NOT_APPLICABLE]);
  const session = new InspectionSession({ now: NOW });
  assert.equal(session.record('keyboard.keys', Status.UNRATED, { notes: ['x'] }).ok, false);
  assert.equal(session.record('keyboard.keys', 'OK', { notes: ['x'] }).ok, false);
});

test('a manual observation cannot be recorded without evidence', () => {
  const session = new InspectionSession({ now: NOW });
  const bare = session.record('display.white', Status.PASS, {});
  assert.equal(bare.ok, false);
  assert.match(bare.problems[0], /needs at least one note or a recorded count/);

  const evidenced = session.record('display.white', Status.PASS, { defects: 0, notes: ['No dark pixels found'] });
  assert.equal(evidenced.ok, true);
  assert.equal(evidenced.result.status, Status.PASS);
  assert.equal(evidenced.result.observedAt, NOW().toISOString());
});

test('a FAIL verdict must describe the fault', () => {
  const session = new InspectionSession({ now: NOW });
  const bare = session.record('audio.output', Status.FAIL, {});
  assert.equal(bare.ok, false);
  assert.match(bare.problems[0], /requires a note/);

  const described = session.record('audio.output', Status.FAIL, { notes: ['Right speaker rattles above 60% volume'] });
  assert.equal(described.ok, true);
  assert.equal(described.result.status, Status.FAIL);
});

test('NOT_APPLICABLE needs a declared reason and a note', () => {
  const session = new InspectionSession({ now: NOW });
  const undeclared = session.record('display.white', Status.NOT_APPLICABLE, { notes: ['skipped'] });
  assert.equal(undeclared.ok, false);
  assert.match(undeclared.problems[0], /no declared reason/);

  const declaredNoNote = session.record('touchpad.presence', Status.NOT_APPLICABLE, {});
  assert.equal(declaredNoNote.ok, false);
  assert.ok(declaredNoNote.problems.some((problem) => /explaining why/.test(problem)));

  const proper = session.record('touchpad.presence', Status.NOT_APPLICABLE, { notes: ['Desktop machine, no touchpad fitted'] });
  assert.equal(proper.ok, true);
  assert.equal(proper.result.status, Status.NOT_APPLICABLE);
});

test('an unknown test id is refused rather than created', () => {
  const session = new InspectionSession({ now: NOW });
  const attempt = session.record('screen.hologram', Status.PASS, { notes: ['x'] });
  assert.equal(attempt.ok, false);
  assert.match(attempt.problems[0], /Unknown manual test/);
});

test('coverage counts not-applicable separately from passed and untested', () => {
  const session = new InspectionSession({ now: NOW });
  session.record('display.white', Status.PASS, { defects: 0, notes: ['clean'] });
  session.record('display.black', Status.FAIL, { notes: ['bleed at bottom left'] });
  session.record('touchpad.presence', Status.NOT_APPLICABLE, { notes: ['desktop'] });

  const coverage = session.coverage();
  assert.equal(coverage.answered, 3);
  assert.equal(coverage.passed, 1);
  assert.equal(coverage.failed, 1);
  assert.equal(coverage.notApplicable, 1);
  assert.equal(coverage.untested, coverage.totalTests - 3);
  // Not-applicable tests must not dilute the pass rate of tests that were run.
  assert.equal(coverage.percentPassedOfRun, 50);
  assert.ok(coverage.percentComplete < 20);
});

test('an unanswered test can be cleared back to untested', () => {
  const session = new InspectionSession({ now: NOW });
  session.record('display.white', Status.PASS, { defects: 0, notes: ['clean'] });
  assert.equal(session.coverage().answered, 1);
  assert.equal(session.clear('display.white'), true);
  assert.equal(session.coverage().answered, 0);
  assert.equal(session.clear('display.white'), false);
});

test('a PASS that skips the defect count it asks for is flagged as weak evidence', () => {
  const session = new InspectionSession({ now: NOW });
  session.record('display.white', Status.PASS, { notes: ['looked fine'] });
  const weak = session.weakResults();
  assert.equal(weak.length, 1);
  assert.match(weak[0], /without the defect count/);
});

test('a FAIL with a zero defect count is flagged as a contradiction', () => {
  const session = new InspectionSession({ now: NOW });
  session.record('display.white', Status.FAIL, { notes: ['looks bad'], defects: 0 });
  const issues = session.toIssues();
  assert.ok(issues.warnings.some((warning) => /defect count is 0/.test(warning)));
});

test('session issues name every incomplete suite, so a report cannot look finished', () => {
  const session = new InspectionSession({ now: NOW });
  const issues = session.toIssues();
  assert.ok(issues.warnings.some((warning) => /Manual inspection incomplete/.test(warning)));
  assert.ok(issues.warnings.some((warning) => /Display inspection \(0\/6\)/.test(warning)));
});

test('progress is per suite and complete only when fully answered', () => {
  const session = new InspectionSession({ now: NOW });
  const before = session.progress().find((entry) => entry.suiteId === 'camera');
  assert.equal(before.complete, false);
  assert.equal(before.untested, before.total);

  for (const test of manualSuite('camera').tests) {
    const notes = test.kind === 'observe' ? ['observed'] : [];
    const result = session.record(test.id, Status.PASS, { notes: notes.length ? notes : undefined, evidence: { captured: true } });
    if (!result.ok) {
      // Capture tests that require a note-free pass need some evidence; supply it.
      assert.ok(session.record(test.id, Status.NOT_APPLICABLE, { notes: ['not present on this machine'] }).ok, test.id);
    }
  }
  const after = session.progress().find((entry) => entry.suiteId === 'camera');
  assert.equal(after.complete, true);
  assert.equal(after.untested, 0);
});

test('session notes are recorded with a timestamp and empty notes rejected', () => {
  const session = new InspectionSession({ now: NOW });
  assert.equal(session.addNote('   '), false);
  assert.equal(session.addNote('Hinge creaks past 100 degrees'), true);
  assert.equal(session.notes[0].at, NOW().toISOString());
});

test('a session round-trips through JSON and drops tests that no longer exist', () => {
  const session = new InspectionSession({ now: NOW, inspector: 'Shohan' });
  session.record('display.white', Status.PASS, { defects: 0, notes: ['clean'] });
  const restored = InspectionSession.fromJSON(JSON.parse(JSON.stringify(session.toJSON())), { now: NOW });
  assert.equal(restored.coverage().answered, 1);
  assert.equal(restored.inspector, 'Shohan');

  const stale = InspectionSession.fromJSON({ results: [{ id: 'display.white', status: Status.PASS }, { id: 'removed.test', status: Status.PASS }] }, { now: NOW });
  assert.equal(stale.results.size, 1);
  assert.deepEqual(stale.droppedOnLoad, ['removed.test']);
});

test('applicable suites never mark a missing device as passing', () => {
  const decisions = applicableSuites({ hasTouchpad: false, hasCamera: true });
  const touchpad = decisions.find((entry) => entry.suiteId === 'touchpad');
  const camera = decisions.find((entry) => entry.suiteId === 'camera');
  assert.equal(touchpad.applicable, false);
  assert.match(touchpad.reason, /No touchpad detected/);
  assert.equal(camera.applicable, true);

  // Unknown detection keeps the suite listed rather than silently skipping it.
  const unknown = applicableSuites({}).find((entry) => entry.suiteId === 'camera');
  assert.equal(unknown.applicable, true);
  assert.match(unknown.reason, /confirm by hand/);
});

test('the printable checklist covers every test in the registry', () => {
  const checklist = printableChecklist();
  for (const test of MANUAL_TESTS) {
    assert.ok(checklist.includes(test.title), `${test.title} missing from the checklist`);
  }
  assert.match(checklist, /Manual observation|Captured from device events/);
});

// ── Keyboard analysis ────────────────────────────────────────────────────────

function keyRun(codes, extra = {}) {
  return codes.map((code, index) => ({ code, at: 1000 + index * 20, ...extra }));
}

test('a keyboard with every required key detected passes', () => {
  const result = analyseKeyboard(keyRun(ESSENTIAL_KEYS));
  assert.equal(result.status, Status.PASS);
  assert.deepEqual(result.missing, []);
  assert.equal(result.percentDetected, 100);
  assert.match(result.notes[0], /79 of 79|required keys were detected/);
});

test('a partially detected keyboard is a warning, and silent keys are named', () => {
  const pressed = ESSENTIAL_KEYS.filter((code) => code !== 'KeyZ' && code !== 'F12');
  const result = analyseKeyboard(keyRun(pressed));
  assert.equal(result.status, Status.WARNING);
  assert.deepEqual(result.missing.sort(), ['F12', 'KeyZ']);
  assert.match(result.notes[1], /Silent keys: .*KeyZ/);
});

test('a keyboard where most keys are dead fails', () => {
  const result = analyseKeyboard(keyRun(['KeyA', 'KeyB']));
  assert.equal(result.status, Status.FAIL);
  assert.ok(result.missing.length > 70);
});

test('no captured events means untested, never a pass', () => {
  const result = analyseKeyboard([]);
  assert.equal(result.status, Status.UNTESTED);
  assert.equal(result.verdictCandidate, null);
  assert.match(result.notes[0], /Nothing can be concluded/);
});

test('auto-repeat is surfaced because it suggests a key not releasing', () => {
  const events = [
    ...keyRun(ESSENTIAL_KEYS),
    { code: 'KeyA', at: 9000, repeat: true },
    { code: 'KeyA', at: 9030, repeat: true }
  ];
  const result = analyseKeyboard(events);
  assert.equal(result.repeats.length, 1);
  assert.equal(result.repeats[0].code, 'KeyA');
  assert.match(result.notes.join(' '), /confirm those keys release cleanly/);
});

test('unexpected keys are reported but do not fail the test', () => {
  const result = analyseKeyboard(keyRun([...ESSENTIAL_KEYS, 'IntlRo', 'PrintScreen']));
  assert.deepEqual(result.unexpected.sort(), ['IntlRo', 'PrintScreen']);
  assert.equal(result.status, Status.PASS);
});

test('modifier analysis names the keys that never arrived', () => {
  const events = MODIFIER_KEYS.filter((code) => code !== 'RightCtrl').map((code) => ({
    code,
    modifiers: [],
    at: 1000
  }));
  events.push({ code: 'KeyC', modifiers: ['LeftCtrl'], at: 2000 });
  const result = analyseModifiers(events);
  assert.deepEqual(result.missing, ['RightCtrl']);
  assert.equal(result.status, Status.WARNING);
  assert.ok(result.chords.some((chord) => chord.combo === 'LeftCtrl'));
});

test('a chord made only of modifiers is called out as incomplete', () => {
  const result = analyseModifiers([{ code: 'LeftShift', modifiers: ['LeftShift'], at: 1 }]);
  assert.ok(result.problemCombos.includes('LeftShift'));
  assert.match(result.notes.join(' '), /no combination was actually completed/);
});

test('no modifier events means untested', () => {
  assert.equal(analyseModifiers([]).status, Status.UNTESTED);
});

// ── Mouse analysis ───────────────────────────────────────────────────────────

test('all buttons pressed cleanly is a pass', () => {
  const events = [
    { button: 0, type: 'down', at: 1 }, { button: 0, type: 'up', at: 2 },
    { button: 2, type: 'down', at: 3 }, { button: 2, type: 'up', at: 4 }
  ];
  const result = analyseMouseButtons(events);
  assert.equal(result.status, Status.PASS);
  assert.deepEqual(result.pressed, [0, 2]);
  assert.deepEqual(result.stuck, []);
});

test('a missing right-click fails the test', () => {
  const result = analyseMouseButtons([{ button: 0, type: 'down', at: 1 }, { button: 0, type: 'up', at: 2 }]);
  assert.equal(result.status, Status.FAIL);
  assert.ok(result.missing.includes(2));
});

test('button chatter is detected and warned about', () => {
  const events = [
    { button: 0, type: 'down', at: 1 }, { button: 0, type: 'down', at: 2 }, { button: 0, type: 'up', at: 3 },
    { button: 2, type: 'down', at: 4 }, { button: 2, type: 'up', at: 5 }
  ];
  const result = analyseMouseButtons(events);
  assert.equal(result.status, Status.WARNING);
  assert.equal(result.chatter[0].button, 0);
});

test('a button that never released is listed as stuck', () => {
  const events = [
    { button: 0, type: 'down', at: 1 }, { button: 0, type: 'up', at: 2 },
    { button: 2, type: 'down', at: 3 }
  ];
  const result = analyseMouseButtons(events);
  assert.deepEqual(result.stuck, [2]);
});

test('side buttons are only required when the inspector says they exist', () => {
  const events = [
    { button: 0, type: 'down', at: 1 }, { button: 0, type: 'up', at: 2 },
    { button: 2, type: 'down', at: 3 }, { button: 2, type: 'up', at: 4 }
  ];
  assert.equal(analyseMouseButtons(events).status, Status.PASS);
  assert.equal(analyseMouseButtons(events, { expectSideButtons: true }).status, Status.FAIL);
});

test('wheel analysis distinguishes deliberate reversal from encoder fault', () => {
  const deliberate = [
    { deltaY: 100 }, { deltaY: 100 }, { deltaY: 100 },
    { deltaY: -100 }, { deltaY: -100 }, { deltaY: -100 },
    { deltaY: 100 }, { deltaY: 100 }, { deltaY: 100 }, { deltaY: 100 }
  ].map((event, index) => ({ ...event, at: index }));
  const clean = analyseWheel(deliberate);
  assert.equal(clean.up, 3);
  assert.equal(clean.down, 7);
  assert.equal(clean.status, Status.PASS);

  const flutter = [];
  for (let index = 0; index < 10; index += 1) flutter.push({ deltaY: index % 2 === 0 ? 100 : -100, at: index });
  const worn = analyseWheel(flutter);
  assert.equal(worn.status, Status.WARNING);
  assert.ok(worn.reversals >= 8);
});

test('one-direction-only scrolling is a warning, not a pass', () => {
  const result = analyseWheel([{ deltaY: 100, at: 1 }, { deltaY: 100, at: 2 }]);
  assert.equal(result.status, Status.WARNING);
  assert.match(result.notes.join(' '), /Only one scroll direction/);
});

test('no wheel events means untested', () => {
  assert.equal(analyseWheel([]).status, Status.UNTESTED);
});

// ── Pointer analysis ─────────────────────────────────────────────────────────

test('pointer travel and target stations are measured, not judged as acceleration', () => {
  const stations = [{ id: 'tl', x: 5, y: 5, r: 12 }, { id: 'br', x: 95, y: 95, r: 12 }];
  const points = [
    { x: 0, y: 0, at: 0 }, { x: 5, y: 5, at: 20 }, { x: 50, y: 50, at: 40 }, { x: 95, y: 95, at: 60 }
  ];
  const result = analysePointer(points, { stations });
  assert.equal(result.status, Status.PASS);
  assert.deepEqual(result.reached.sort(), ['br', 'tl']);
  assert.ok(result.travel > 100);
  assert.match(result.notes.join(' '), /acceleration is a feel judgement/);
});

test('an unreached station is reported as missed', () => {
  const stations = [{ id: 'corner', x: 95, y: 95, r: 5 }];
  const result = analysePointer([{ x: 0, y: 0, at: 0 }, { x: 10, y: 10, at: 20 }], { stations });
  assert.deepEqual(result.missed, ['corner']);
  assert.equal(result.status, Status.WARNING);
});

test('stutter is distinguished from fast movement', () => {
  const stuttering = [{ x: 0, y: 0, at: 0 }, { x: 200, y: 0, at: 900 }];
  const result = analysePointer(stuttering, {});
  assert.equal(result.gaps, 1);
  assert.match(result.notes.join(' '), /looked like stutter/);
});

test('too few pointer samples means untested', () => {
  assert.equal(analysePointer([{ x: 1, y: 1, at: 0 }], {}).status, Status.UNTESTED);
});

// ── USB attribution ──────────────────────────────────────────────────────────

test('USB arrivals are attributed to the selected port and say so honestly', () => {
  const arrivals = [{ vendorId: '0781', productId: '5567', name: 'SanDisk Cruzer', at: 5000 }];
  const result = analyseUsbPorts(arrivals, { selectedPort: 'Rear USB-A 1', baselineDeviceIds: ['0001:0002:Mouse'] });
  assert.equal(result.status, Status.PASS);
  assert.equal(result.arrivals[0].port, 'Rear USB-A 1');
  assert.match(result.attribution, /not "this port was electrically tested"/);
});

test('a device that was already plugged in is not evidence for a port', () => {
  const baseline = ['0781:5567:SanDisk Cruzer'];
  const result = analyseUsbPorts([{ vendorId: '0781', productId: '5567', name: 'SanDisk Cruzer', at: 1 }], {
    selectedPort: 'Front USB 1',
    baselineDeviceIds: baseline
  });
  assert.equal(result.status, Status.WARNING);
  assert.equal(result.arrivals.length, 0);
});

test('no arrival at all means untested, not a failed port', () => {
  const result = analyseUsbPorts([], { selectedPort: 'Front USB 1' });
  assert.equal(result.status, Status.UNTESTED);
  assert.match(result.notes[0], /Plug a device into the selected port/);
});

test('USB speed reporting is a fact and does not certify the port', () => {
  assert.match(usbSpeedNote('SuperSpeed (5 Gbps)').text, /operating at SuperSpeed/);
  assert.match(usbSpeedNote('High (480 Mbps)').text, /worth checking/);
  assert.match(usbSpeedNote(null).text, /did not report/);
});
