import test from 'node:test';
import assert from 'node:assert/strict';

import { Status, toStatus, isStatus, hasValue, severityRank, statusTone, ALL_STATUSES } from '../../src/core/status.js';
import {
  field,
  available,
  unavailable,
  unsupported,
  permissionRequired,
  failed,
  untested,
  section,
  sectionRows,
  coverageOf,
  Confidence
} from '../../src/core/field.js';

test('status vocabulary is complete and every entry has presentation metadata', () => {
  assert.equal(ALL_STATUSES.length, 12);
  for (const name of ALL_STATUSES) {
    assert.equal(isStatus(name), true);
    assert.ok(statusTone(name).length > 0, `${name} needs a tone`);
    assert.equal(typeof severityRank(name), 'number');
  }
  assert.equal(isStatus('MAYBE'), false);
  assert.throws(() => toStatus('MAYBE'), /Unknown VERIDEX status/);
});

test('UNAVAILABLE, UNSUPPORTED and PERMISSION_REQUIRED are distinct and none counts as having a value', () => {
  const a = unavailable('no sensor');
  const b = unsupported('no nvme');
  const c = permissionRequired('needs admin');
  assert.notEqual(a.status, b.status);
  assert.notEqual(b.status, c.status);
  assert.equal(hasValue(a.status), false);
  assert.equal(hasValue(b.status), false);
  assert.equal(hasValue(c.status), false);
  assert.equal(c.permissionRequired, true);
  assert.equal(a.permissionRequired, false);
});

test('a status claiming data cannot carry a null value — the invariant is structural', () => {
  assert.throws(() => field(null, { status: Status.PASS }), /requires a value/);
  assert.throws(() => available(null, 'x'), /requires a value/);
  // A legitimate absence is allowed.
  const missing = unavailable('nothing exposes this');
  assert.equal(missing.value, null);
});

test('available() defaults to PASS with medium confidence, and keeps unit and source', () => {
  const f = available(4200, 'cim-win32', { unit: 'MHz' });
  assert.equal(f.value, 4200);
  assert.equal(f.status, Status.PASS);
  assert.equal(f.unit, 'MHz');
  assert.equal(f.source, 'cim-win32');
  assert.equal(f.confidence, Confidence.MEDIUM);
  assert.ok(Date.parse(f.collectedAt) > 0, 'collection timestamp is recorded');
  assert.ok(Object.isFrozen(f), 'fields are immutable so nothing downstream can rewrite provenance');
});

test('zero is a real value and is never treated as absent', () => {
  const f = available(0, 'nvme-health-log', { unit: 'count' });
  assert.equal(f.value, 0);
  assert.equal(f.status, Status.PASS);
  assert.equal(hasValue(f.status), true);
});

test('failed() preserves the error message from both Error objects and strings', () => {
  const fromError = failed(new Error('Access denied'), 'ata-smart');
  assert.equal(fromError.status, Status.ERROR);
  assert.equal(fromError.error, 'Access denied');
  assert.equal(fromError.confidence, Confidence.NONE);
  const fromString = failed('timeout', 'ata-smart');
  assert.equal(fromString.error, 'timeout');
});

test('untested() is distinct from unavailable() and carries the reason as a note', () => {
  const pending = untested('waiting for user');
  const missing = unavailable('no sensor');
  assert.equal(pending.status, Status.UNTESTED);
  assert.equal(pending.value, null);
  assert.deepEqual(pending.notes, ['waiting for user']);
  assert.notEqual(pending.status, missing.status);
});

test('section aggregation: all present is PASS, partial is PARTIALLY_AVAILABLE', () => {
  const full = section('cpu', 'CPU', { name: available('i7', 'cim-win32'), cores: available(8, 'cim-win32') });
  assert.equal(full.status, Status.PASS);
  assert.equal(full.counts.ok, 2);
  assert.equal(full.counts.total, 2);

  const partial = section('cpu', 'CPU', { name: available('i7', 'cim-win32'), temp: unavailable('no sensor') });
  assert.equal(partial.status, Status.PARTIALLY_AVAILABLE);
  assert.equal(partial.counts.ok, 1);
  assert.equal(partial.counts.missing, 1);
});

test('section aggregation: a warning downgrades a complete section', () => {
  const warned = section('battery', 'Battery', { health: field(48, { status: Status.WARNING, source: 'battery-firmware' }), cycles: available(310, 'battery-firmware') });
  assert.equal(warned.status, Status.WARNING);
  assert.equal(warned.counts.warning, 1);
});

test('section aggregation: nothing usable prefers the actionable explanation', () => {
  const blocked = section('storage', 'Storage', { smart: permissionRequired('needs admin'), serial: permissionRequired('needs admin') });
  assert.equal(blocked.status, Status.PERMISSION_REQUIRED);

  const broken = section('storage', 'Storage', { smart: failed('ioctl failed'), serial: unavailable('hidden') });
  assert.equal(broken.status, Status.ERROR);

  const absent = section('storage', 'Storage', { smart: unsupported('no device'), serial: unavailable('hidden') });
  assert.equal(absent.status, Status.UNAVAILABLE);

  const empty = section('storage', 'Storage', {});
  assert.equal(empty.status, Status.UNAVAILABLE);
  assert.equal(empty.counts.total, 0);
});

test('notApplicable and unsupported count as missing, not as passing', () => {
  const s = section('battery', 'Battery', { cycles: untested('not run'), design: unsupported('desktop') });
  assert.equal(s.counts.ok, 0, 'unsupported/untested must never be counted as present');
  assert.equal(s.counts.missing, 2);
});

test('sectionRows flattens for reports and keeps provenance per row', () => {
  const s = section('cpu', 'CPU', { name: available('Ryzen 7', 'cim-win32'), temp: unavailable('no sensor') });
  const rows = sectionRows([s]);
  assert.equal(rows.length, 2);
  const temp = rows.find((row) => row.key === 'temp');
  assert.equal(temp.status, Status.UNAVAILABLE);
  assert.equal(temp.value, null);
  assert.ok('collectedAt' in temp && 'confidence' in temp && 'source' in temp);
});

test('coverageOf reports present/total and a bounded percentage', () => {
  const a = section('cpu', 'CPU', { one: available(1, 'x'), two: available(2, 'x') });
  const b = section('gpu', 'GPU', { three: unavailable('no'), four: available(4, 'x'), five: unavailable('no') });
  const coverage = coverageOf([a, b]);
  assert.equal(coverage.total, 5);
  assert.equal(coverage.present, 3);
  assert.equal(coverage.percent, 60);
  assert.equal(coverageOf([]).percent, 0, 'empty coverage is 0, never 100');
});

test('every status is classified, so a section cannot over-report its evidence', async () => {
  // section() counted "missing" and "blocked" by listing statuses inline. Adding a status to
  // the vocabulary therefore left the counter behind, and a new status would have counted as
  // neither - a field with no value that the summary treated as not-there-and-fine.
  const { ALL_STATUSES: ALL, hasValue, DATA_ABSENT_EXPECTED, DATA_BLOCKED, DATA_FAILED } = await import('../../src/core/status.js');
  const classes = new Map();
  for (const status of ALL) {
    const hit = [
      hasValue(status) ? 'present' : null,
      DATA_ABSENT_EXPECTED.includes(status) ? 'absent' : null,
      DATA_BLOCKED.includes(status) ? 'blocked' : null,
      DATA_FAILED.includes(status) ? 'failed' : null
    ].filter(Boolean);
    assert.equal(hit.length, 1, `status ${status} belongs to ${hit.length} categories (${hit.join(', ')}); it must belong to exactly one`);
    classes.set(status, hit[0]);
  }
  assert.equal(classes.size, ALL.length);
  assert.equal(classes.get('PASS'), 'present');
  assert.equal(classes.get('PERMISSION_REQUIRED'), 'blocked');
  assert.equal(classes.get('UNSUPPORTED'), 'absent');
  assert.equal(classes.get('FAIL'), 'failed');
});

test('a section holding a failure reports it instead of claiming there is no data', async () => {
  const { section, available, field } = await import('../../src/core/field.js');
  const { Status } = await import('../../src/core/status.js');
  const failing = section('battery', 'Battery', { wear: field(84, { status: Status.FAIL, unit: '%' }) });
  assert.equal(failing.status, Status.FAIL, 'a module whose only reading failed must say FAIL, not UNAVAILABLE');
  assert.equal(failing.counts.failed, 1);

  const mixed = section('storage', 'Storage', { model: available('Samsung', 'cim'), health: field(null, { status: Status.FAIL }) });
  assert.equal(mixed.status, Status.WARNING, 'a failure among good readings is a warning, not a pass and not a total loss');

  const unknown = section('gpu', 'GPU', { vram: field(null, { status: Status.UNKNOWN, error: 'could not interpret' }) });
  assert.equal(unknown.status, Status.UNKNOWN, 'a payload that could not be interpreted is not the same as no provider');
});
