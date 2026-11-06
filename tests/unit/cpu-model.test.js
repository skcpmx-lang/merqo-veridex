import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeCpuName,
  decodeArchitecture,
  normaliseInstructionSets,
  validateCoreCounts,
  NOTABLE_INSTRUCTION_SETS
} from '../../src/diagnostics/cpu-model.js';

test('Intel generations decode from the documented model-number rule', () => {
  const cases = [
    ['Intel(R) Core(TM) i7-1165G7 CPU @ 2.80GHz', 11, '1165G7', 'Core i7'],
    ['Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz', 8, '8250U', 'Core i5'],
    ['Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz', 9, '9750H', 'Core i7'],
    ['Intel(R) Core(TM) i7-10750H CPU @ 2.60GHz', 10, '10750H', 'Core i7'],
    ['Intel(R) Core(TM) i9-12900K', 12, '12900K', 'Core i9'],
    ['Intel(R) Core(TM) i5-13600K', 13, '13600K', 'Core i5'],
    ['Intel(R) Core(TM) i7-14700HX', 14, '14700HX', 'Core i7'],
    ['Intel(R) Core(TM) i5-2500K CPU @ 3.30GHz', 2, '2500K', 'Core i5'],
    ['Intel(R) Core(TM) i7-3770 CPU @ 3.40GHz', 3, '3770', 'Core i7'],
    ['Intel(R) Core(TM) i3-1005G1 CPU @ 1.20GHz', 10, '1005G1', 'Core i3']
  ];
  for (const [name, generation, modelNumber, productLine] of cases) {
    const decoded = decodeCpuName(name);
    assert.equal(decoded.manufacturer, 'Intel', name);
    assert.equal(decoded.generation, generation, `${name} generation`);
    assert.equal(decoded.modelNumber, modelNumber, `${name} model number`);
    assert.equal(decoded.productLine, productLine, `${name} product line`);
    assert.ok(decoded.rule, `${name} must state the rule it applied`);
  }
});

test('Intel Core Ultra series decodes without pretending to be a numbered generation', () => {
  const decoded = decodeCpuName('Intel(R) Core(TM) Ultra 7 155H');
  assert.equal(decoded.manufacturer, 'Intel');
  assert.equal(decoded.modelNumber, '155H');
  assert.equal(decoded.generationLabel, 'Core Ultra series 1');
  assert.equal(decoded.rule, 'intel-core-ultra');
});

test('AMD Ryzen series decode from the SKU and never claim a microarchitecture', () => {
  const cases = [
    ['AMD Ryzen 7 5800H with Radeon Graphics', 5000, '5800H', 'Ryzen 7'],
    ['AMD Ryzen 5 3600 6-Core Processor', 3000, '3600', 'Ryzen 5'],
    ['AMD Ryzen 9 7950X 16-Core Processor', 7000, '7950X', 'Ryzen 9'],
    ['AMD Ryzen 7 8845HS w/ Radeon 780M', 8000, '8845HS', 'Ryzen 7'],
    ['AMD Ryzen 5 9600X 6-Core Processor', 9000, '9600X', 'Ryzen 5'],
    ['AMD Ryzen 3 3200U with Radeon Vega Mobile Gfx', 3000, '3200U', 'Ryzen 3']
  ];
  for (const [name, series, model, line] of cases) {
    const decoded = decodeCpuName(name);
    assert.equal(decoded.manufacturer, 'AMD', name);
    assert.equal(decoded.generation, series, `${name} series`);
    assert.equal(decoded.modelNumber, model, `${name} model`);
    assert.equal(decoded.productLine, line, `${name} product line`);
  }
  // The decoded object must not carry any microarchitecture claim.
  const decoded = decodeCpuName('AMD Ryzen 7 5800H with Radeon Graphics');
  assert.equal(Object.keys(decoded).includes('microarchitecture'), false);
});

test('unrecognised names return nulls instead of a guess', () => {
  const decoded = decodeCpuName('Generic x86 Processor');
  assert.equal(decoded.modelNumber, null);
  assert.equal(decoded.generation, null);
  assert.equal(decoded.generationLabel, null);
  assert.equal(decoded.rule, null);
});

test('empty and missing names are handled without throwing', () => {
  assert.equal(decodeCpuName(null).manufacturer, null);
  assert.equal(decodeCpuName(undefined).productLine, null);
  assert.equal(decodeCpuName('   ').modelNumber, null);
});

test('manufacturer hint is honoured when the name omits the vendor', () => {
  const decoded = decodeCpuName('Core i5-9300H CPU @ 2.40GHz', 'GenuineIntel');
  assert.equal(decoded.manufacturer, 'Intel');
  assert.equal(decoded.generation, 9);
});

test('architecture codes map to real names and unknown codes are refused', () => {
  assert.equal(decodeArchitecture(9), 'x64');
  assert.equal(decodeArchitecture(0), 'x86');
  assert.equal(decodeArchitecture(12), 'ARM64');
  assert.equal(decodeArchitecture('9'), 'x64');
  assert.equal(decodeArchitecture(77), null);
  assert.equal(decodeArchitecture(null), null);
});

test('instruction sets are filtered, de-duplicated and ordered consistently', () => {
  const sets = normaliseInstructionSets('MMX SSE SSE2 SSE3 SSSE3 SSE4_1 SSE4_2 AVX AVX2 AES VMX SOMETHING_ELSE');
  assert.deepEqual(sets, ['MMX', 'SSE', 'SSE2', 'SSE3', 'SSSE3', 'SSE4.1', 'SSE4.2', 'AVX', 'AVX2', 'AES', 'VT-x']);
  assert.deepEqual(normaliseInstructionSets([]), []);
  assert.deepEqual(normaliseInstructionSets(null), []);
  // Every emitted value is a documented display name.
  for (const name of sets) assert.ok(NOTABLE_INSTRUCTION_SETS.includes(name));
});

test('core count validation catches impossible configurations', () => {
  assert.deepEqual(validateCoreCounts({ physicalCores: 8, logicalCores: 16 }), []);
  assert.equal(validateCoreCounts({ physicalCores: 16, logicalCores: 8 }).length, 1);
  assert.match(validateCoreCounts({ physicalCores: 16, logicalCores: 8 })[0], /lower than physical/);
  assert.equal(validateCoreCounts({ physicalCores: 0, logicalCores: 0 }).length, 2);
  assert.equal(validateCoreCounts({ physicalCores: 2, logicalCores: 64 }).length, 1);
  assert.deepEqual(validateCoreCounts({}), []);
});
