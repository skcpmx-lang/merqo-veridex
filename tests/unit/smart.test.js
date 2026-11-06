import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSmartData, interpretSmart, decodeTemperature, readRaw48, ATA_ATTRIBUTES } from '../../src/providers/smart-ata.js';
import { parseNvmeHealthLog, interpretNvmeHealth, describePercentageUsed, dataUnitsToBytes, PERCENTAGE_USED_UNKNOWN } from '../../src/providers/smart-nvme.js';

/**
 * Build a 512-byte SMART READ DATA page in the layout the ATA specification defines.
 * @param {Array<{id:number, norm?:number, worst?:number, raw:number}>} attributes
 */
function buildSmartPage(attributes) {
  const buffer = new Uint8Array(512);
  buffer[0] = 0x10; // revision 1.0
  attributes.forEach((attribute, index) => {
    const offset = 2 + index * 12;
    buffer[offset] = attribute.id;
    buffer[offset + 1] = 0x32;
    buffer[offset + 3] = attribute.norm ?? 100;
    buffer[offset + 4] = attribute.worst ?? 100;
    let value = attribute.raw;
    for (let byte = 0; byte < 6; byte += 1) {
      buffer[offset + 5 + byte] = value % 256;
      value = Math.floor(value / 256);
    }
  });
  return buffer;
}

/** Build a 512-byte NVMe SMART/Health Information log. */
function buildNvmeLog({ critical = 0, temperatureK = 310, spare = 100, spareThreshold = 10, percentageUsed = 5, unitsRead = 1000, unitsWritten = 2000, powerCycles = 10, powerOnHours = 100, unsafeShutdowns = 0, mediaErrors = 0, errorEntries = 0 } = {}) {
  const buffer = new Uint8Array(512);
  const view = new DataView(buffer.buffer);
  buffer[0] = critical;
  view.setUint16(1, temperatureK, true);
  buffer[3] = spare;
  buffer[4] = spareThreshold;
  buffer[5] = percentageUsed;
  const writeU64 = (offset, value) => {
    view.setUint32(offset, value % 4294967296, true);
    view.setUint32(offset + 4, Math.floor(value / 4294967296), true);
  };
  writeU64(32, unitsRead);
  writeU64(48, unitsWritten);
  writeU64(112, powerCycles);
  writeU64(120, powerOnHours);
  writeU64(128, unsafeShutdowns);
  writeU64(144, mediaErrors);
  writeU64(152, errorEntries);
  return buffer;
}

test('48-bit little-endian raw values decode correctly', () => {
  const bytes = new Uint8Array(6);
  bytes[0] = 0xff;
  bytes[1] = 0xff;
  // 0xffff = 65535
  assert.equal(readRaw48(bytes, 0), 65535 + 0 * 0);
  const large = new Uint8Array(6);
  large[0] = 0x01;
  large[3] = 0x01;
  assert.equal(readRaw48(large, 0), 0x01000001);
});

test('ATA SMART attributes are parsed with their standardised names and units', () => {
  const parsed = parseSmartData(
    buildSmartPage([
      { id: 5, raw: 0 },
      { id: 9, raw: 12480 },
      { id: 12, raw: 310 },
      { id: 187, raw: 0 },
      { id: 194, raw: 38 },
      { id: 197, raw: 2 },
      { id: 199, raw: 0 }
    ])
  );
  assert.equal(parsed.powerOnHours, 12480);
  assert.equal(parsed.powerCycleCount, 310);
  assert.equal(parsed.reallocatedSectors, 0);
  assert.equal(parsed.pendingSectors, 2);
  assert.equal(parsed.temperature, 38);
  assert.equal(parsed.standardAttributes, 7);
  assert.equal(parsed.vendorAttributes, 0);

  const nameAttribute = parsed.attributes.find((attribute) => attribute.id === 9);
  assert.equal(nameAttribute.name, 'Power-On Hours');
  assert.equal(nameAttribute.unit, 'hours');
  assert.equal(nameAttribute.vendorSpecific, false);
});

test('vendor-specific attributes are named as such instead of being guessed', () => {
  const parsed = parseSmartData(buildSmartPage([{ id: 22, raw: 12345 }, { id: 9, raw: 100 }]));
  const vendor = parsed.attributes.find((attribute) => attribute.id === 22);
  assert.equal(vendor.name, 'Vendor-specific attribute 22');
  assert.equal(vendor.vendorSpecific, true);
  assert.equal(parsed.vendorAttributes, 1);
  assert.equal(parsed.standardAttributes, 1);
});

test('a short or empty SMART page yields no attributes rather than garbage', () => {
  assert.deepEqual(parseSmartData(new Uint8Array(10)).attributes, []);
  assert.deepEqual(parseSmartData(null).attributes, []);
  assert.deepEqual(parseSmartData([]).attributes, []);
});

test('temperature decoding handles low-byte, second-byte and implausible values', () => {
  assert.equal(decodeTemperature(new Uint8Array([38, 0, 0, 0, 0, 0])), 38);
  assert.equal(decodeTemperature(new Uint8Array([0, 42, 0, 0, 0, 0])), 42, 'value stored in the second byte');
  assert.equal(decodeTemperature(new Uint8Array([0, 0, 0, 0, 0, 0])), null, 'no reading is null, not zero');
  assert.equal(decodeTemperature(new Uint8Array([250, 0, 0, 0, 0, 0])), null, 'implausible values are refused');
});

test('a clean drive passes and its findings are stated positively', () => {
  const parsed = parseSmartData(buildSmartPage([{ id: 5, raw: 0 }, { id: 9, raw: 500 }, { id: 194, raw: 32 }]));
  const result = interpretSmart(parsed);
  assert.equal(result.status, 'PASS');
  assert.ok(result.findings.some((finding) => finding.includes('No reallocated sectors')));
});

test('pending and reallocated sectors escalate health with driving evidence', () => {
  const pending = interpretSmart(parseSmartData(buildSmartPage([{ id: 5, raw: 0 }, { id: 197, raw: 3 }])));
  assert.equal(pending.status, 'WARNING');
  assert.ok(pending.findings.some((finding) => finding.includes('could not read them')));

  const reallocated = interpretSmart(parseSmartData(buildSmartPage([{ id: 5, raw: 40 }])));
  assert.equal(reallocated.status, 'FAIL');

  const uncorrectable = interpretSmart(parseSmartData(buildSmartPage([{ id: 5, raw: 0 }, { id: 187, raw: 1 }])));
  assert.equal(uncorrectable.status, 'WARNING');
});

test('CRC errors are attributed to the link, not the disk surface', () => {
  const result = interpretSmart(parseSmartData(buildSmartPage([{ id: 5, raw: 0 }, { id: 199, raw: 512 }])));
  assert.equal(result.status, 'WARNING');
  const finding = result.findings.find((entry) => entry.includes('CRC'));
  assert.match(finding, /cabling or controller problem/);
  assert.match(finding, /rather than a failing disk surface/);
});

test('high temperature escalates the drive health verdict', () => {
  assert.equal(interpretSmart(parseSmartData(buildSmartPage([{ id: 5, raw: 0 }, { id: 194, raw: 58 }]))).status, 'WARNING');
  assert.equal(interpretSmart(parseSmartData(buildSmartPage([{ id: 5, raw: 0 }, { id: 194, raw: 68 }]))).status, 'FAIL');
});

test('an unreadable SMART page reports UNAVAILABLE with a reason', () => {
  const result = interpretSmart(parseSmartData(new Uint8Array(512)));
  assert.equal(result.status, 'UNAVAILABLE');
  assert.ok(result.notes.length > 0);
});

test('NVMe health log decodes temperature, spare, endurance and counters', () => {
  const health = parseNvmeHealthLog(buildNvmeLog({ temperatureK: 313, spare: 100, spareThreshold: 10, percentageUsed: 7, unitsWritten: 150_000_000, powerOnHours: 9876, powerCycles: 812, unsafeShutdowns: 12 }));
  assert.equal(health.temperatureC, 39.9);
  assert.equal(health.availableSpare, 100);
  assert.equal(health.availableSpareThreshold, 10);
  assert.equal(health.percentageUsed, 7);
  assert.equal(health.powerOnHours, 9876);
  assert.equal(health.powerCycles, 812);
  assert.equal(health.unsafeShutdowns, 12);
  assert.ok(health.hostWrites > 60 && health.hostWrites < 80, `expected ~69.8 TiB written, got ${health.hostWrites}`);
});

test('NVMe 0xFF percentage used is "unknown", never 255% endurance', () => {
  const health = parseNvmeHealthLog(buildNvmeLog({ percentageUsed: PERCENTAGE_USED_UNKNOWN }));
  assert.equal(health.percentageUsed, null);
  assert.equal(health.percentageUsedRaw, 255);
  const described = describePercentageUsed(health.percentageUsed, health.percentageUsedRaw);
  assert.equal(described.status, 'UNAVAILABLE');
  assert.match(described.text, /Unknown/);
  const interpretation = interpretNvmeHealth(health);
  assert.ok(interpretation.findings.some((finding) => finding.includes('255')), 'the raw value is disclosed');
  assert.equal(interpretation.status, 'PASS', 'an unknown endurance figure is not a failure');
});

test('NVMe critical warning bits are decoded into their meanings', () => {
  const health = parseNvmeHealthLog(buildNvmeLog({ critical: 0b00000101 }));
  assert.deepEqual(health.criticalWarning.bits, ['Available spare capacity has fallen below the threshold', 'NVM subsystem reliability has degraded']);
  const interpretation = interpretNvmeHealth(health);
  assert.equal(interpretation.status, 'FAIL');
  assert.match(interpretation.findings[0], /critical warning/);
});

test('NVMe endurance thresholds escalate health', () => {
  assert.equal(interpretNvmeHealth(parseNvmeHealthLog(buildNvmeLog({ percentageUsed: 85 }))).status, 'WARNING');
  assert.equal(interpretNvmeHealth(parseNvmeHealthLog(buildNvmeLog({ percentageUsed: 105 }))).status, 'FAIL');
});

test('exhausted NVMe spare capacity and media errors are failures', () => {
  const spareGone = parseNvmeHealthLog(buildNvmeLog({ spare: 0, spareThreshold: 10 }));
  assert.equal(interpretNvmeHealth(spareGone).status, 'FAIL');
  const errors = parseNvmeHealthLog(buildNvmeLog({ mediaErrors: 4 }));
  assert.equal(interpretNvmeHealth(errors).status, 'WARNING');
  assert.ok(interpretNvmeHealth(errors).findings.some((finding) => finding.includes('data-integrity')));
});

test('an unreadable NVMe log reports UNAVAILABLE', () => {
  assert.equal(parseNvmeHealthLog(new Uint8Array(64)).temperatureC, null);
  assert.equal(interpretNvmeHealth(parseNvmeHealthLog(new Uint8Array(0))).status, 'UNAVAILABLE');
});

test('data unit conversion uses the 512,000-byte unit the specification defines', () => {
  const converted = dataUnitsToBytes(1_000_000);
  assert.equal(converted.bytes, 512_000_000_000);
  assert.equal(dataUnitsToBytes(0), null);
  assert.equal(dataUnitsToBytes(null), null);
});

test('every standardised ATA attribute entry carries a name', () => {
  for (const [id, meta] of Object.entries(ATA_ATTRIBUTES)) {
    assert.ok(meta.name, `attribute ${id} needs a name`);
  }
});
