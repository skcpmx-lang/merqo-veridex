import test from 'node:test';
import assert from 'node:assert/strict';

import { available, unavailable, failed, permissionRequired, Confidence } from '../../src/core/field.js';
import { agree, resolveField, mergeFields, preferred } from '../../src/engine/merge.js';

test('agree() tolerates unit rounding but catches real disagreement', () => {
  assert.equal(agree(8192, 8192), true);
  assert.equal(agree(8192, 8100), true, '2% tolerance absorbs MB/GB rounding');
  assert.equal(agree(16, 8), false);
  assert.equal(agree('DDR4', 'ddr4'), true, 'string comparison is case-insensitive');
  assert.equal(agree(null, 5), false);
  assert.equal(agree('Samsung', 'SK Hynix'), false);
});

test('an authoritative source beats a heuristic for the same field', () => {
  const result = resolveField('cpu.name', [
    { providerId: 'vendor-heuristic', field: available('Intel Core i5 (guessed)', 'vendor-heuristic') },
    { providerId: 'cim-win32', field: available('Intel(R) Core(TM) i5-8250U', 'cim-win32') }
  ]);
  assert.equal(result.field.value, 'Intel(R) Core(TM) i5-8250U');
  assert.equal(result.conflict, true, 'the disagreement is recorded even though the winner is clear');
  assert.equal(result.field.confidence, Confidence.LOW, 'a conflict lowers confidence so the user can see ambiguity');
  assert.ok(
    result.field.notes.some((note) => note.includes('Conflicting reading')),
    'the discarded reading stays visible'
  );
});

test('two independent providers agreeing raises confidence and says so', () => {
  const result = resolveField('ram.total', [
    { providerId: 'cim-win32', field: available(16, 'cim-win32', { unit: 'GB' }) },
    { providerId: 'systeminformation', field: available(16, 'systeminformation', { unit: 'GB' }) }
  ]);
  assert.equal(result.field.value, 16);
  assert.equal(result.conflict, false);
  assert.equal(result.field.confidence, Confidence.HIGH);
  assert.ok(result.field.notes.some((note) => note.includes('Corroborated')));
});

test('when no provider produced a value the most actionable status wins', () => {
  const result = resolveField('storage.smart', [
    { providerId: 'ata-smart', field: failed('ioctl 0x7C failed', 'ata-smart') },
    { providerId: 'nvme-health-log', field: permissionRequired('needs elevation', 'nvme-health-log') },
    { providerId: 'cim-win32', field: unavailable('not exposed', 'cim-win32') }
  ]);
  assert.equal(result.field.status, 'PERMISSION_REQUIRED', 'tells the user what to do next');
  assert.equal(result.field.value, null);
  assert.equal(result.conflict, false, 'absence of a value is not a conflict');
});

test('resolveField returns null when handed nothing', () => {
  assert.equal(resolveField('x', []).field, null);
});

test('mergeFields lets a fallback top up gaps without overwriting good values', () => {
  const base = { name: available('i7', 'cim-win32'), cores: unavailable('not exposed', 'cim-win32') };
  const addition = { cores: available(8, 'systeminformation'), name: available('Wrong i7', 'vendor-heuristic') };
  const merged = mergeFields(base, addition);
  assert.equal(merged.name.value, 'i7', 'existing authoritative value survives');
  assert.equal(merged.cores.value, 8, 'gap filled by the fallback provider');
});

test('mergeFields keeps the more actionable explanation when neither side has a value', () => {
  const merged = mergeFields(
    { smart: unavailable('not exposed', 'cim-win32') },
    { smart: permissionRequired('needs admin', 'ata-smart') }
  );
  assert.equal(merged.smart.status, 'PERMISSION_REQUIRED');
});

test('preferred() ranks validated before unvalidated, then tier, then freshness', () => {
  const validatedHeuristic = { providerId: 'vendor-heuristic', field: available('a', 'vendor-heuristic'), validated: true };
  const unvalidatedAuthoritative = { providerId: 'cim-win32', field: available('b', 'cim-win32'), validated: false };
  assert.ok(preferred(validatedHeuristic, unvalidatedAuthoritative) > 0, 'validation outranks source tier');

  const older = { providerId: 'cim-win32', field: { ...available('a', 'cim-win32'), collectedAt: '2024-01-01T00:00:00.000Z' } };
  const newer = { providerId: 'cim-win32', field: { ...available('b', 'cim-win32'), collectedAt: '2024-06-01T00:00:00.000Z' } };
  assert.ok(preferred(newer, older) > 0, 'fresher data wins between equals');
});
