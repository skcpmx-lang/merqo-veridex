import test from 'node:test';
import assert from 'node:assert/strict';

import { aggregateCaches, deriveSocket, isDesktopIntelSuffix, isDesktopAmdSuffix, mapCimProcessor, mapCurrentLoad, mapSystemInformationCpu } from '../../src/diagnostics/cpu.js';
import { Status } from '../../src/core/status.js';

test('cache aggregation sums per-core L2, takes the largest unified L3, and keeps L1 total', () => {
  const result = aggregateCaches([
    { Level: 1, MaxCacheSize: 65536 },
    { Level: 2, MaxCacheSize: 262144 },
    { Level: 2, MaxCacheSize: 262144 },
    { Level: 2, MaxCacheSize: 262144 },
    { Level: 2, MaxCacheSize: 262144 },
    { Level: 3, MaxCacheSize: 8388608 },
    { Level: 3, MaxCacheSize: 8388608 }
  ]);
  assert.equal(result.l1, 65536);
  assert.equal(result.l2, 1048576, 'four 256 KB L2 instances sum to 1 MB');
  assert.equal(result.l3, 8388608, 'duplicate L3 rows are not double-counted');
});

test('cache aggregation reports null for levels that were never reported', () => {
  const result = aggregateCaches([{ Level: 3, MaxCacheSize: 33554432 }]);
  assert.equal(result.l1, null);
  assert.equal(result.l2, null);
  assert.equal(result.l3, 33554432);
  assert.deepEqual(aggregateCaches([]), { l1: null, l2: null, l3: null });
});

test('desktop Intel suffixes yield a socket; mobile suffixes yield nothing rather than a wrong socket', () => {
  assert.equal(deriveSocket('Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz').socket, 'LGA1200');
  assert.equal(deriveSocket('Intel(R) Core(TM) i5-2500K CPU @ 3.30GHz').socket, 'LGA1155');
  assert.equal(deriveSocket('Intel(R) Core(TM) i9-9900K CPU @ 3.60GHz').socket, 'LGA1151');
  assert.equal(deriveSocket('Intel(R) Core(TM) i7-1165G7 CPU @ 2.80GHz'), null, 'G7 is a soldered mobile part');
  assert.equal(deriveSocket('Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz'), null, 'H is mobile');
  assert.equal(deriveSocket('Intel(R) Core(TM) i5-10210U CPU @ 1.60GHz'), null, 'U is mobile');
});

test('AMD desktop suffixes yield a socket; mobile suffixes yield nothing', () => {
  assert.equal(deriveSocket('AMD Ryzen 5 5600X 6-Core Processor').socket, 'AM4');
  assert.equal(deriveSocket('AMD Ryzen 9 7950X 16-Core Processor').socket, 'AM5');
  assert.equal(deriveSocket('AMD Ryzen 5 5600G with Radeon Graphics').socket, 'AM4');
  assert.equal(deriveSocket('AMD Ryzen 7 5800H with Radeon Graphics'), null);
  assert.equal(deriveSocket('AMD Ryzen 5 3550U with Radeon Vega Mobile Gfx'), null);
});

test('every derived socket states the rule that produced it', () => {
  const result = deriveSocket('AMD Ryzen 5 5600X 6-Core Processor');
  assert.match(result.rule, /amd-desktop-sku-series/);
  assert.match(result.rule, /X/);
});

test('suffix classifiers are exhaustive on the documented sets', () => {
  for (const suffix of ['K', 'KF', 'F', 'X', 'XE', 'T', '']) assert.equal(isDesktopIntelSuffix(suffix), true, suffix);
  for (const suffix of ['H', 'HK', 'HX', 'U', 'Y', 'P', 'G7', 'M', 'MQ', 'HQ']) assert.equal(isDesktopIntelSuffix(suffix), false, suffix);
  for (const suffix of ['X', 'XT', 'X3D', 'G', '']) assert.equal(isDesktopAmdSuffix(suffix), true, suffix);
  for (const suffix of ['H', 'HS', 'HX', 'U', 'C']) assert.equal(isDesktopAmdSuffix(suffix), false, suffix);
});

test('processor mapping never fabricates a temperature or a boost clock', () => {
  const fields = mapCimProcessor({
    Name: 'Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz',
    Manufacturer: 'GenuineIntel',
    NumberOfCores: 4,
    NumberOfLogicalProcessors: 8,
    MaxClockSpeed: 1800,
    CurrentClockSpeed: 1800,
    Architecture: 9,
    VirtualizationFirmwareEnabled: true
  });

  assert.equal(fields.physicalCores.value, 4);
  assert.equal(fields.logicalCores.value, 8);
  assert.equal(fields.manufacturer.value, 'Intel');
  assert.equal(fields.generation.value, '8th generation');
  assert.equal(fields.maxClock.value, 1800);
  assert.equal(fields.maxClock.unit, 'MHz');
  assert.equal('temperature' in fields, false, 'temperature is not a CPU-cimpl field and must not be invented here');
  assert.equal(fields.boostClock.status, Status.UNAVAILABLE, 'rated boost is not exposed by Windows');
  assert.match(fields.boostClock.error, /does not infer/);
});

test('boost is reported only as an observation when current exceeds nominal', () => {
  const fields = mapCimProcessor({ Name: 'Intel(R) Core(TM) i7-10700K CPU @ 3.80GHz', NumberOfCores: 8, NumberOfLogicalProcessors: 16, MaxClockSpeed: 3800, CurrentClockSpeed: 4700 });
  assert.equal(fields.boostClock.value, 4700);
  assert.ok(fields.boostClock.notes.some((note) => note.includes('observation')));
});

test('missing processor instance produces an explanatory status, not a crash', () => {
  const fields = mapCimProcessor(null);
  assert.equal(fields.name.status, Status.UNAVAILABLE);
  assert.equal(fields.name.value, null);
});

test('a placeholder OEM vendor string is normalised but unknown values pass through', () => {
  assert.equal(mapCimProcessor({ Name: 'x', Manufacturer: 'AuthenticAMD' }).manufacturer.value, 'AMD');
  const odd = mapCimProcessor({ Name: 'x', Manufacturer: 'SomeFoundry Inc' }).manufacturer.value;
  assert.equal(odd, 'SomeFoundry Inc');
});

test('per-core load parsing drops entries with no reading instead of reporting zero', () => {
  const { total, perCore } = mapCurrentLoad({ currentLoad: 42.35, cpus: [{ load: 10 }, { load: null }, { load: 90 }] });
  assert.equal(total.value, 42.4);
  assert.equal(total.unit, '%');
  assert.equal(perCore.value.length, 2, 'core with no reading is omitted, not faked as 0%');
  assert.deepEqual(perCore.value.map((core) => core.core), [10, 90]);
});

test('out-of-range utilisation is refused rather than clamped', () => {
  assert.equal(mapCurrentLoad({ currentLoad: 143 }).total.status, Status.UNAVAILABLE);
  assert.equal(mapCurrentLoad({ currentLoad: -4 }).total.status, Status.UNAVAILABLE);
});

test('instruction set mapping degrades to UNAVAILABLE when the source has no flags', () => {
  const fields = mapSystemInformationCpu({ speed: 2.4, flags: [] });
  assert.equal(fields.instructionSets.status, Status.UNAVAILABLE);
  assert.equal(fields.currentClock.value, 2.4);
  assert.equal(fields.currentClock.unit, 'GHz');
});
