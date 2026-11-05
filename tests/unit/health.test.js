import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildComponentScore, assessOverall, assessFromDiagnostics, ratingFor, statusForScore,
  scoreStorage, scoreBattery, scoreSecurity, scoreDrivers, scoreMemory, scoreThermal,
  coverageStatement, unratedExplanation, PENALTIES, COMPONENTS
} from '../../src/engine/health.js';
import { available, unavailable, permissionRequired, field, notApplicable } from '../../src/core/field.js';
import { Status } from '../../src/core/status.js';

test('a component with no evidence is UNRATED, never 100', () => {
  const score = buildComponentScore('storage', []);
  assert.equal(score.score, null);
  assert.equal(score.rating, 'Unrated');
  assert.equal(score.status, Status.UNRATED);
  assert.match(score.explanation, /not a pass and not a failure/);
  assert.deepEqual(score.missing, ['no usable evidence was collected']);
});

test('an unrated component explains exactly what was missing', () => {
  const score = buildComponentScore('battery', [], { missing: ['battery health could not be computed'] });
  assert.equal(unratedExplanation(score), 'Not scored: battery health could not be computed.');
  assert.equal(unratedExplanation(buildComponentScore('battery', [{ id: 'x', label: 'x', delta: 0, status: 'PASS', source: null }])), null);
});

test('rating bands map to their documented ranges', () => {
  assert.equal(ratingFor(100), 'Good');
  assert.equal(ratingFor(90), 'Good');
  assert.equal(ratingFor(89), 'Fair');
  assert.equal(ratingFor(70), 'Fair');
  assert.equal(ratingFor(69), 'Poor');
  assert.equal(ratingFor(40), 'Poor');
  assert.equal(ratingFor(39), 'Critical');
  assert.equal(ratingFor(null), 'Unrated');
});

test('scores are clamped to 0..100 and never go negative', () => {
  const catastrophic = buildComponentScore('storage', [
    { id: 'a', label: 'a', delta: -70, status: 'FAIL', source: null },
    { id: 'b', label: 'b', delta: -60, status: 'FAIL', source: null }
  ]);
  assert.equal(catastrophic.score, 0);
  assert.equal(catastrophic.rating, 'Critical');
});

test('evidence is preserved so a score can always be explained', () => {
  const score = buildComponentScore('battery', [{ id: 'battery.health', label: 'battery health is 62%', delta: -22, status: 'WARNING', source: 'battery-firmware' }]);
  assert.equal(score.score, 78);
  assert.equal(score.evidence.length, 1);
  assert.match(score.explanation, /battery health is 62%/);
  assert.match(score.explanation, /-22/);
});

test('overall score excludes unrated components and reports coverage honestly', () => {
  const scored = buildComponentScore('cpu', [{ id: 'x', label: 'ok', delta: 0, status: 'PASS', source: null }]);
  const unrated = buildComponentScore('battery', []);
  const overall = assessOverall([scored, unrated]);
  // The raw average still excludes the unrated component, but the headline number is
  // capped because nearly half the weighted surface had no evidence. Publishing 100
  // "Good" from one component is the failure mode this guards against.
  assert.equal(overall.rawScore, 100, 'the unrated component does not inflate or deflate the raw average');
  assert.equal(overall.score, 84, 'the published score is capped, never the raw 100');
  assert.equal(overall.rating, 'Fair');
  assert.equal(overall.capped, true);
  assert.notEqual(overall.score, overall.rawScore);
  assert.equal(overall.ratedComponents, 1);
  assert.equal(overall.totalComponents, 2);
  assert.ok(overall.coveragePercent < 100);
  assert.match(overall.disclaimer, /not a certification/);
});

test('a score is withheld when most of the machine could not be assessed', () => {
  const components = [
    buildComponentScore('cpu', [{ id: 'x', label: 'ok', delta: 0, status: 'PASS', source: null }]),
    ...['gpu', 'memory', 'storage', 'battery', 'drivers', 'security'].map((id) => buildComponentScore(id, []))
  ];
  const overall = assessOverall(components);
  assert.equal(overall.score, null, 'one rated component out of seven must not become a score');
  assert.equal(overall.rating, 'Unrated');
  assert.equal(overall.status, 'UNRATED');
  assert.equal(overall.gated, true);
  assert.match(overall.gatingNote, /score is withheld/);
  assert.match(overall.gatingNote, /would look like a verdict on the whole machine/);
});

test('a score built from a minority of the machine is capped below Good', () => {
  const components = Array.from({ length: 8 }, (_, index) =>
    buildComponentScore('cpu', index < 5 ? [{ id: `x${index}`, label: 'ok', delta: 0, status: 'PASS', source: null }] : [])
  );
  const overall = assessOverall(components);
  assert.ok(overall.coveragePercent >= 50 && overall.coveragePercent < 80);
  assert.equal(overall.gated, false, 'this much coverage is enough to publish a number');
  assert.ok(overall.score <= 84, 'but not enough to call the machine Good');
  assert.equal(overall.rating, 'Fair');
  assert.equal(overall.capped, true);
  assert.match(overall.gatingNote, /capped at 84/);
});

test('full coverage publishes the real score without a cap', () => {
  const components = Array.from({ length: 8 }, () =>
    buildComponentScore('cpu', [{ id: 'x', label: 'ok', delta: 0, status: 'PASS', source: null }])
  );
  const overall = assessOverall(components);
  assert.equal(overall.coveragePercent, 100);
  assert.equal(overall.score, 100);
  assert.equal(overall.rating, 'Good');
  assert.equal(overall.capped, false);
  assert.equal(overall.gatingNote, null);
});

test('with nothing rated the overall score is null, not zero or 100', () => {
  const overall = assessOverall([buildComponentScore('cpu', []), buildComponentScore('storage', [])]);
  assert.equal(overall.score, null);
  assert.equal(overall.rating, 'Unrated');
  assert.equal(overall.coveragePercent, 0);
});

test('storage with no SMART data is unrated rather than healthy', () => {
  const storage = { diskCount: available(1, 'cim-win32') };
  const score = scoreStorage(storage, {});
  assert.equal(score.score, null);
  assert.ok(score.missing.some((entry) => entry.includes('SMART')));
});

test('storage with permission-blocked SMART explains the elevation requirement', () => {
  const score = scoreStorage({ diskCount: available(1, 'cim-win32') }, { smart: permissionRequired('needs DeviceIoControl', 'ata-smart') });
  assert.equal(score.score, null);
  assert.ok(score.missing.some((entry) => entry.includes('administrator rights')));
});

test('a failing NVMe drive is scored down sharply with the reason attached', () => {
  const score = scoreStorage(
    { diskCount: available(2, 'cim-win32') },
    {
      'disk1.percentageUsed': available(112, 'nvme-health-log', { unit: '%' }),
      'disk1.criticalWarning': field('reliability degraded', { status: Status.FAIL, source: 'nvme-health-log' })
    }
  );
  assert.ok(score.score !== null && score.score < 20, `expected a very low score, got ${score.score}`);
  assert.equal(score.rating, 'Critical');
  assert.ok(score.evidence.some((entry) => entry.id.includes('percentageUsed')));
  assert.ok(score.evidence.some((entry) => entry.id.includes('criticalWarning')));
});

test('a clean NVMe drive scores full marks', () => {
  const score = scoreStorage(
    { diskCount: available(1, 'cim-win32') },
    { 'disk1.percentageUsed': available(4, 'nvme-health-log', { unit: '%' }), 'disk1.availableSpare': available(100, 'nvme-health-log', { unit: '%' }) }
  );
  assert.equal(score.score, 100);
  assert.equal(score.status, Status.PASS);
});

test('battery scoring tracks wear bands and cycle counts', () => {
  assert.equal(scoreBattery({ health: available(96, 'battery-firmware') }).score, 100);
  assert.equal(scoreBattery({ health: available(85, 'battery-firmware') }).score, 92);
  assert.equal(scoreBattery({ health: available(75, 'battery-firmware') }).score, 78);
  assert.equal(scoreBattery({ health: available(62, 'battery-firmware') }).score, 60);
  assert.equal(scoreBattery({ health: available(41, 'battery-firmware') }).score, 40);
  assert.equal(scoreBattery({ health: available(85, 'battery-firmware'), cycleCount: available(950, 'battery-firmware') }).score, 84);
});

test('a desktop with no battery is unrated with a not-applicable explanation', () => {
  const score = scoreBattery({ present: notApplicable('No battery is present', 'cim-win32') });
  assert.equal(score.score, null);
  assert.ok(score.missing.some((entry) => entry.includes('no battery is present')));
});

test('thermal scoring penalises hot and critical sensors but not a missing sensor', () => {
  assert.equal(scoreThermal({ cpuTemperature: available(55, 'acpi-thermal') }).score, 100);
  assert.equal(scoreThermal({ cpuTemperature: available(88, 'acpi-thermal') }).score, 88);
  assert.equal(scoreThermal({ cpuTemperature: available(97, 'acpi-thermal') }).score, 72);
  const none = scoreThermal({});
  assert.equal(none.score, null);
  assert.ok(none.missing.some((entry) => entry.includes('no temperature sensor')));
});

test('driver failures lower the score and name the devices', () => {
  const score = scoreDrivers({
    driverCount: available(64, 'cim-win32'),
    driversFailed: available(2, 'computed'),
    criticalIssues: field(['Intel Wi-Fi 6', 'Realtek Audio'], { status: Status.WARNING, source: 'computed' })
  });
  assert.ok(score.score !== null && score.score < 100);
  assert.ok(score.evidence.some((entry) => entry.label.includes('2 device(s) in a failed state')));
});

test('security penalties cover the real posture failures', () => {
  const score = scoreSecurity({
    defenderRealtimeProtection: field('Disabled', { status: Status.WARNING, source: 'cim-win32' }),
    firewallSummary: available('All 3 profiles enabled', { status: Status.PASS })
  }, {});
  assert.equal(score.score, 88);
  assert.ok(score.evidence.some((entry) => entry.id === 'security.real-time protection'));
});

test('memory single-module configuration costs a small amount and is labelled', () => {
  const score = scoreMemory({ moduleCount: available(1, 'cim-win32'), totalCapacity: available(16, 'cim-win32') });
  assert.equal(score.score, 96);
  assert.ok(score.evidence.some((entry) => entry.label.includes('single-channel')));
});

test('a full assessment wires all eight components together', () => {
  const assessment = assessFromDiagnostics({
    cpu: { name: available('Intel Core i7', 'cim-win32'), physicalCores: available(8, 'cim-win32'), logicalCores: available(16, 'cim-win32') },
    gpu: { adapterCount: available(1, 'cim-win32') },
    memory: { moduleCount: available(2, 'cim-win32'), totalCapacity: available(16, 'cim-win32') },
    storage: { diskCount: available(1, 'cim-win32') },
    storageHealth: { 'disk1.percentageUsed': available(6, 'nvme-health-log') },
    battery: { health: available(91, 'battery-firmware') },
    sensors: { cpuTemperature: available(58, 'acpi-thermal') },
    drivers: { driverCount: available(60, 'cim-win32'), driversFailed: available(0, 'computed') },
    security: { defenderRealtimeProtection: available('Enabled', 'cim-win32'), firewallSummary: available('All profiles enabled', 'cim-win32') }
  });
  assert.equal(assessment.components.length, 8);
  assert.ok(assessment.ratedComponents >= 6);
  assert.ok(typeof assessment.score === 'number');
  assert.ok(assessment.coveragePercent > 50);
});

test('coverage statement separates rated from unrated with reasons', () => {
  const assessment = assessOverall([
    buildComponentScore('cpu', [{ id: 'x', label: 'ok', delta: 0, status: 'PASS', source: null }]),
    buildComponentScore('thermal', [], { missing: ['no temperature sensor was readable'] })
  ]);
  const statement = coverageStatement(assessment);
  assert.match(statement.headline, /1 of 2 components/);
  assert.match(statement.rated[0], /Processor: 100/);
  assert.match(statement.unrated[0], /Thermals: not rated — no temperature sensor/);
});

test('every component definition has a label and weight', () => {
  for (const [id, definition] of Object.entries(COMPONENTS)) {
    assert.ok(definition.label, id);
    assert.ok(definition.weight > 0, id);
  }
});

test('penalties are all negative', () => {
  for (const [name, value] of Object.entries(PENALTIES)) assert.ok(value < 0, `${name} must be a penalty`);
});
