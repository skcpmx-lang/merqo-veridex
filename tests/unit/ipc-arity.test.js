/**
 * The IPC contract must accept the way the renderer actually calls it.
 *
 * The preload exposes one function per channel taking plain arguments, so the renderer calls
 * `invoke('report:save', 'csv')`. The contract described named parameters and read only an
 * object, so the string was ignored and the default `pdf` was used instead: every report the
 * user asked to save as CSV or JSON was written as a PDF, and every HTML build came back as
 * a PDF. Nothing failed, which is why no test noticed.
 *
 * Found by the GUI smoke test, which is the only test that drives the real bridge.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { validateRequest, CHANNELS } from '../../src/app/ipc-contract.js';

const value = (channel, args) => {
  const result = validateRequest(channel, args);
  assert.equal(result.ok, true, `${channel} rejected ${JSON.stringify(args)}: ${result.reason}`);
  return result.value;
};

test('a positional report format is honoured, not silently replaced by the default', () => {
  for (const format of ['pdf', 'html', 'csv', 'json']) {
    assert.equal(value('report:save', [format]).format, format, `report:save ignored "${format}"`);
    assert.equal(value('report:build', [format]).format, format, `report:build ignored "${format}"`);
  }
});

test('the named form still works, so the contract is not now positional-only', () => {
  assert.equal(value('report:save', [{ format: 'csv' }]).format, 'csv');
  assert.equal(value('scan:start', [{ tasks: ['cpu.info'] }]).tasks[0], 'cpu.info');
  assert.deepEqual(value('app:setSetting', [{ key: 'ui.theme', value: 'dark' }]), { key: 'ui.theme', value: 'dark' });
});

test('a positional setting change keeps both its key and its value', () => {
  assert.deepEqual(value('app:setSetting', ['ui.theme', 'dark']), { key: 'ui.theme', value: 'dark' });
  assert.deepEqual(value('app:setSetting', ['diagnostics.deepScan', true]), { key: 'diagnostics.deepScan', value: true });
  assert.deepEqual(value('app:setSetting', ['reports.brandLine', 42]), { key: 'reports.brandLine', value: 42 });
});

test('positional arguments reach every multi-argument channel', () => {
  const recorded = value('manual:record', ['kbd-1', 'PASS', { notes: ['looks fine'] }]);
  assert.equal(recorded.testId, 'kbd-1');
  assert.equal(recorded.verdict, 'PASS');
  assert.deepEqual(recorded.detail.notes, ['looks fine']);
  assert.deepEqual(value('history:compare', ['a', 'b']), { aId: 'a', bId: 'b' });
  assert.equal(value('app:applyPrivacyPreset', ['private']).presetId, 'private');
});

test('validation still rejects what it should reject', () => {
  // Accepting two call shapes must not turn into accepting anything.
  assert.equal(validateRequest('report:save', ['exe']).ok, false);
  assert.equal(validateRequest('report:save', [{}]).ok, false, 'a missing format must not pass validation');
  assert.equal(validateRequest('app:setSetting', ['']).ok, false);
  assert.equal(validateRequest('app:setSetting', ['x', () => {}]).ok, false, 'a function is not a setting value');
  assert.equal(validateRequest('manual:record', ['t', 'MAYBE']).ok, false);
  assert.equal(validateRequest('app:applyPrivacyPreset', ['everything']).ok, false);
  assert.equal(validateRequest('scan:start', [{ tasks: [42] }]).ok, false);
});

test('a missing report format is refused rather than guessed', () => {
  // Previously this returned pdf, which meant a caller that passed nothing got a document
  // it did not ask for. Defaulting silently is how the positional bug stayed invisible.
  assert.equal(validateRequest('report:save', []).ok, false);
});

test('every channel with declared arguments can be called positionally', () => {
  // The general form of the bug: any channel whose args the contract read positionally
  // would have discarded them. This walks the whole contract.
  const samples = {
    'app:setSetting': ['a.b', 'c'],
    'app:applyPrivacyPreset': ['private'],
    'scan:start': [],
    'report:build': ['pdf'],
    'report:save': ['pdf'],
    'manual:record': ['id-1', 'PASS', {}],
    'history:compare': ['a', 'b']
  };
  for (const [channel, args] of Object.entries(samples)) {
    assert.ok(CHANNELS[channel], `${channel} must exist in the contract`);
    const result = validateRequest(channel, args);
    assert.equal(result.ok, true, `${channel} rejected its positional form: ${result.reason}`);
  }
});
