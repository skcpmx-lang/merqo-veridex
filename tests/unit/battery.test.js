import test from 'node:test';
import assert from 'node:assert/strict';

import { computeHealth, mapWmiBattery, mapWin32Battery, parseBatteryReportXml, batteryApplicability, HEALTH_PLAUSIBLE_RANGE } from '../../src/diagnostics/battery.js';
import { Status } from '../../src/core/status.js';

test('health is full ÷ design × 100 with one decimal', () => {
  const result = computeHealth(57000, 48200);
  assert.equal(result.health, 84.6);
  assert.equal(result.wear, 15.4);
  assert.equal(result.status, Status.PASS);
});

test('health thresholds classify wear honestly', () => {
  assert.equal(computeHealth(50000, 45000).status, Status.PASS, '10% wear is healthy');
  assert.equal(computeHealth(50000, 40000).status, Status.WARNING, '20% wear is a warning');
  assert.equal(computeHealth(50000, 30000).status, Status.WARNING);
  assert.equal(computeHealth(50000, 9000).status, Status.FAIL, '82% wear is a failure');
});

test('health is refused — never computed — from zero, missing or invalid capacities', () => {
  for (const [design, full] of [[0, 48200], [57000, 0], [null, 48200], [57000, null], [undefined, undefined], ['', ''], [-5, 48200]]) {
    const result = computeHealth(design, full);
    assert.equal(result.health, null, `${design}/${full} must not yield a health figure`);
    assert.equal(result.wear, null);
    assert.ok([Status.UNAVAILABLE, Status.UNKNOWN].includes(result.status));
    assert.ok(result.reason.length > 0, 'a refusal must explain itself');
  }
});

test('a design capacity of zero is explicitly called out as unreported', () => {
  const result = computeHealth(0, 48200);
  assert.match(result.reason, /Design capacity was not reported/);
  assert.equal(result.status, Status.UNAVAILABLE);
});

test('implausibly low health is UNKNOWN, not a dramatic number', () => {
  const result = computeHealth(57000, 900);
  assert.equal(result.health, null);
  assert.equal(result.status, Status.UNKNOWN);
  assert.match(result.reason, /more likely a firmware reporting fault/);
  assert.ok(result.reason.includes(`${HEALTH_PLAUSIBLE_RANGE.min}%`));
  assert.match(result.notes.join(' '), /57000 mWh/);
});

test('a replaced larger pack is reported with an explanation, not silently clamped', () => {
  const result = computeHealth(40000, 60000);
  assert.equal(result.health, 150);
  assert.equal(result.status, Status.WARNING, 'over-reporting is flagged, never shown as healthy');
  assert.ok(result.notes.some((note) => note.includes('replaced with a larger one')));
});

test('a small overshoot from a freshly calibrated pack stays within tolerance', () => {
  const result = computeHealth(57000, 59000);
  assert.equal(result.health, 103.5);
  assert.equal(result.status, Status.PASS, 'a few percent over design is normal after calibration');
  assert.equal(result.notes.length, 0);
});

test('WMI battery mapping reads capacities, cycles, rates and temperature', () => {
  const fields = mapWmiBattery({
    staticData: { DesignedCapacity: 57000 },
    fullCharged: { FullChargedCapacity: 48200 },
    status: { RemainingCapacity: 24100, Voltage: 11800, Rate: -12500, PowerOnline: false, Charging: false, Discharging: true },
    cycleCount: { CycleCount: 412 },
    temperature: { BatteryTemperature: 3032 }
  });
  assert.equal(fields.designCapacity.value, 57000);
  assert.equal(fields.designCapacity.unit, 'mWh');
  assert.equal(fields.fullChargeCapacity.value, 48200);
  assert.equal(fields.health.value, 84.6);
  assert.equal(fields.wear.value, 15.4);
  assert.equal(fields.cycleCount.value, 412);
  assert.equal(fields.dischargeRate.value, 12500, 'discharge is reported as a magnitude with direction stated separately');
  assert.equal(fields.discharging.value, 'Discharging');
  assert.equal(fields.acConnected.value, 'No');
  assert.equal(fields.temperature.value, 30.1);
  assert.equal(fields.temperature.unit, '°C');
});

test('measured runtime is derived only from a simultaneous capacity and rate reading', () => {
  const fields = mapWmiBattery({ status: { RemainingCapacity: 24100, Rate: -12500, Discharging: true } });
  assert.equal(fields.measuredRuntime.value, 116);
  assert.match(fields.measuredRuntime.notes.join(' '), /not a full-capacity test/);
});

test('measured runtime is unavailable while charging or without a rate', () => {
  const charging = mapWmiBattery({ status: { RemainingCapacity: 24100, Rate: 20000, Charging: true } });
  assert.equal(charging.measuredRuntime.status, Status.UNAVAILABLE);
  const noRate = mapWmiBattery({ status: { RemainingCapacity: 24100 } });
  assert.equal(noRate.measuredRuntime.status, Status.UNAVAILABLE);
});

test('cycle count is never estimated when the controller does not expose it', () => {
  const fields = mapWmiBattery({ staticData: { DesignedCapacity: 50000 }, fullCharged: { FullChargedCapacity: 45000 } });
  assert.equal(fields.cycleCount.value, null);
  assert.equal(fields.cycleCount.status, Status.UNAVAILABLE);
  assert.match(fields.cycleCount.error, /does not expose|No battery cycle-count class/);
});

test('a controller that declares no cycle support is NOT_APPLICABLE', () => {
  const fields = mapWmiBattery({ staticData: { DesignedCapacity: 50000, CycleCount: false }, fullCharged: { FullChargedCapacity: 45000 } });
  assert.equal(fields.cycleCountSupport.status, Status.NOT_APPLICABLE);
});

test('implausible battery temperatures are rejected as invalid', () => {
  const tooHot = mapWmiBattery({ temperature: { BatteryTemperature: 4000 } }); // 126.85 °C
  assert.equal(tooHot.temperature.status, Status.UNAVAILABLE);
  assert.match(tooHot.temperature.error, /outside a plausible range/);
  const zeroKelvin = mapWmiBattery({ temperature: { BatteryTemperature: 0 } });
  assert.equal(zeroKelvin.temperature.status, Status.UNAVAILABLE);
});

test('Win32_Battery mapping interprets the CIM status table and rejects sentinels', () => {
  const charging = mapWin32Battery({ BatteryStatus: 6, EstimatedChargeRemaining: 74, Chemistry: 6, DesignVoltage: 11550, EstimatedRunTime: 71582788 });
  assert.equal(charging.statusText.value, 'Charging');
  assert.equal(charging.chargePercent.value, 74);
  assert.equal(charging.chemistry.value, 'Lithium-ion');
  assert.equal(charging.designVoltage.value, 11.55);
  assert.equal(charging.estimatedRuntime.status, Status.UNAVAILABLE, 'the 71582788 sentinel must not become a runtime');
  assert.match(charging.estimatedRuntime.error, /sentinel/);
});

test('battery report XML is parsed for capacities, cycles and capacity history', () => {
  const xml = `<?xml version="1.0"?>
<BatteryReport>
  <Batteries>
    <Battery>
      <Id>1</Id>
      <Manufacturer>SMP</Manufacturer>
      <Chemistry>LiP</Chemistry>
      <DesignCapacity>57000</DesignCapacity>
      <FullChargeCapacity>48200</FullChargeCapacity>
      <CycleCount>412</CycleCount>
    </Battery>
  </Batteries>
  <CapacityHistory>
    <CapacityHistoryEntry>
      <LocalTimestamp>2026-06-01T10:00:00</LocalTimestamp>
      <DesignCapacity>57000</DesignCapacity>
      <FullChargeCapacity>51000</FullChargeCapacity>
    </CapacityHistoryEntry>
    <CapacityHistoryEntry>
      <LocalTimestamp>2026-09-01T10:00:00</LocalTimestamp>
      <DesignCapacity>57000</DesignCapacity>
      <FullChargeCapacity>48200</FullChargeCapacity>
    </CapacityHistoryEntry>
  </CapacityHistory>
</BatteryReport>`;
  const parsed = parseBatteryReportXml(xml);
  assert.equal(parsed.designCapacity, 57000);
  assert.equal(parsed.fullChargeCapacity, 48200);
  assert.equal(parsed.cycleCount, 412);
  assert.equal(parsed.manufacturer, 'SMP');
  assert.equal(parsed.chemistry, 'LiP');
  assert.equal(parsed.history.length, 2);
  assert.equal(parsed.history[1].fullCharge, 48200);
});

test('empty battery report XML degrades to nulls rather than throwing', () => {
  const parsed = parseBatteryReportXml('');
  assert.deepEqual(parsed, { designCapacity: null, fullChargeCapacity: null, cycleCount: null, manufacturer: null, chemistry: null, serialNumber: null, history: [] });
});

test('a machine with no battery is NOT_APPLICABLE, not an error', () => {
  const result = batteryApplicability({ hasBattery: false, chassisHint: 'Desktop' });
  assert.equal(result.status, Status.NOT_APPLICABLE);
  assert.match(result.error, /No battery is present/);
  assert.match(result.error, /nothing here is a fault/);
  assert.equal(batteryApplicability({ hasBattery: true }), null);
});
