import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyAdapter, mapVideoController, parseDxDiag, mapGraphicsUtilisation, matchVram } from '../../src/diagnostics/gpu.js';
import { simplifyRatio, mapDisplays, deadPixelGuidance, DISPLAY_PATTERNS, pattern } from '../../src/diagnostics/display.js';
import { Status } from '../../src/core/status.js';

test('adapter classification covers integrated, dedicated and virtual adapters', () => {
  const cases = [
    ['NVIDIA GeForce RTX 3060 Laptop GPU', 'NVIDIA', 'dedicated'],
    ['NVIDIA GeForce GTX 1650', 'NVIDIA', 'dedicated'],
    ['Intel(R) UHD Graphics 620', 'Intel Corporation', 'integrated'],
    ['Intel(R) Iris(R) Xe Graphics', 'Intel Corporation', 'integrated'],
    ['Intel(R) Arc(TM) A770 Graphics', 'Intel Corporation', 'dedicated'],
    ['Intel(R) Arc B580 Graphics', 'Intel Corporation', 'dedicated'],
    ['AMD Radeon(TM) Graphics', 'Advanced Micro Devices, Inc.', 'integrated'],
    ['AMD Radeon RX 6700 XT', 'Advanced Micro Devices, Inc.', 'dedicated'],
    ['Microsoft Basic Display Adapter', 'Microsoft', 'virtual'],
    ['VMware SVGA 3D', 'VMware', 'virtual'],
    ['Apple M2', 'Apple', 'integrated']
  ];
  for (const [name, vendor, expected] of cases) {
    assert.equal(classifyAdapter(name, vendor).kind, expected, name);
  }
});

test('unrecognised adapters are reported unknown rather than guessed', () => {
  const result = classifyAdapter('Some Unreleased Chipsets D3D9 Adapter', 'Acme');
  assert.equal(result.kind, 'unknown');
  assert.match(result.rule, /did not match/);
});

test('dGPU VRAM prefers the 64-bit registry value over the truncated AdapterRAM', () => {
  const adapter = {
    Name: 'NVIDIA GeForce RTX 3060',
    AdapterCompatibility: 'NVIDIA',
    AdapterRAM: 4293918720 - 2 ** 32, // Windows' signed 32-bit truncation
    DriverVersion: '31.0.15.3623',
    CurrentRefreshRate: 144
  };
  const eightGb = 8 * 1024 ** 3;
  const fields = mapVideoController(adapter, eightGb);
  assert.equal(fields.dedicatedVram.value, 8, 'full 8 GB reported, not 3.99 GB');
  assert.equal(fields.dedicatedVram.source, 'registry');
  assert.ok(fields.dedicatedVram.notes.some((note) => note.includes('64-bit')));
});

test('without the registry value the AdapterRAM fallback is used but flagged as truncatable', () => {
  const fields = mapVideoController({ Name: 'Intel HD Graphics 620', AdapterRAM: 1024 * 1024 * 1024, AdapterCompatibility: 'Intel' }, null);
  assert.equal(fields.dedicatedVram.value, 1);
  assert.ok(fields.dedicatedVram.notes.some((note) => note.includes('signed 32-bit')));
});

test('missing adapter returns an explanatory status', () => {
  assert.equal(mapVideoController(null).adapter.status, Status.UNAVAILABLE);
});

test('a device-manager error code on the adapter becomes a warning, not silence', () => {
  const fields = mapVideoController({ Name: 'NVIDIA GeForce MX150', AdapterCompatibility: 'NVIDIA', ConfigManagerErrorCode: 43 });
  assert.equal(fields.adapterCompatibilityNote.status, Status.WARNING);
  assert.match(fields.adapterCompatibilityNote.value, /43/);
});

test('VRAM registry lookup matches by PNP id then by adapter name', () => {
  const map = new Map([['pci\\ven_10de&dev_2504', 6 * 1024 ** 3], ['name:nvidia geforce rtx 3060', 6 * 1024 ** 3]]);
  assert.equal(matchVram({ PNPDeviceID: 'PCI\\VEN_10DE&DEV_2504&SUBSYS_1' }, map), 6 * 1024 ** 3);
  assert.equal(matchVram({ Name: 'NVIDIA GeForce RTX 3060' }, map), 6 * 1024 ** 3);
  assert.equal(matchVram({ Name: 'Unmatched' }, map), null);
});

test('GPU temperature and power are unavailable when the driver exposes no sensor', () => {
  const fields = mapGraphicsUtilisation({ controllers: [{ utilizationGpu: 12, memoryUsed: null, memoryTotal: null }] });
  assert.equal(fields.utilization.value, 12);
  assert.equal(fields.temperature.status, Status.UNAVAILABLE);
  assert.match(fields.temperature.error, /No GPU temperature sensor/);
  assert.equal(fields.powerDraw.status, Status.UNAVAILABLE);
  assert.equal(fields.vramUsed.status, Status.UNAVAILABLE);
});

test('implausible GPU temperatures are refused rather than displayed', () => {
  const hot = mapGraphicsUtilisation({ controllers: [{ utilizationGpu: 5, temperatureGpu: 0 }] });
  assert.equal(hot.temperature.status, Status.UNAVAILABLE, '0°C is a missing sensor, not a reading');
  const impossible = mapGraphicsUtilisation({ controllers: [{ temperatureGpu: 512 }] });
  assert.equal(impossible.temperature.status, Status.UNAVAILABLE);
});

test('dxdiag parsing extracts the runtime version and monitor names, and refuses empty input', () => {
  const text = [
    '------------------',
    'System Information',
    '------------------',
    '      Operating System: Windows 11 Pro 64-bit',
    '           DirectX Version: DirectX 12',
    '',
    '------------',
    'Display Devices',
    '------------',
    '         Card name: NVIDIA GeForce RTX 3060',
    '     Display Memory: 6024 MB',
    '      Monitor Name: Generic PnP Monitor',
    '      Monitor Name: DELL U2720Q'
  ].join('\n');
  const parsed = parseDxDiag(text);
  assert.equal(parsed.directxVersion, 'DirectX 12');
  assert.equal(parsed.displayMemory, '6024 MB');
  assert.deepEqual(parsed.monitors, ['Generic PnP Monitor', 'DELL U2720Q']);
  assert.equal(parseDxDiag('').directxVersion, null);
  assert.equal(parseDxDiag(null).monitors.length, 0);
});

test('aspect ratio simplification names common panel ratios', () => {
  assert.equal(simplifyRatio(1920, 1080), '16:9');
  assert.equal(simplifyRatio(1366, 768), '16:9');
  assert.equal(simplifyRatio(2880, 1800), '16:10');
  assert.equal(simplifyRatio(3440, 1440), '21:9');
  assert.equal(simplifyRatio(0, 1080), null);
  assert.equal(simplifyRatio(1920, 1080.5), '16:9');
});

test('multi-monitor mapping reports per-display facts including scaling and internal flag', () => {
  const fields = mapDisplays(
    [
      { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1.25, rotation: 0, internal: true, label: 'BOE NV156FHM', displayFrequency: 60 },
      { id: 2, bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, scaleFactor: 1, rotation: 0, internal: false, label: 'DELL U2720Q', displayFrequency: 59.95, isHDR: true }
    ],
    { primaryId: 1 }
  );
  assert.equal(fields.displayCount.value, 2);
  assert.equal(fields.multiMonitor.value, 'Yes');
  assert.equal(fields['display1.scaleFactor'].value, '125%');
  assert.equal(fields['display1.internal'].value, 'Built-in panel');
  assert.equal(fields['display2.internal'].value, 'External display');
  assert.equal(fields['display2.refreshRate'].value, 60, '59.95 Hz rounds to the advertised 60 Hz');
  assert.equal(fields['display2.hdrCapability'].value, 'HDR enabled');
  assert.equal(fields['display1.primary'].value, 'Yes');
});

test('a display with no reported internal flag says so instead of assuming a laptop', () => {
  const fields = mapDisplays([{ id: 3, bounds: { width: 1920, height: 1080 }, scaleFactor: 1, internal: undefined }]);
  assert.equal(fields['display1.internal'].status, Status.UNAVAILABLE);
});

test('no displays is an explicit absence, not an empty object', () => {
  const fields = mapDisplays([]);
  assert.equal(fields.displayCount.status, Status.UNAVAILABLE);
});

test('every display pattern is complete and individually actionable', () => {
  assert.ok(DISPLAY_PATTERNS.length >= 16);
  const ids = new Set();
  for (const entry of DISPLAY_PATTERNS) {
    assert.ok(entry.id && entry.title && entry.kind && entry.purpose, `${entry.id} is incomplete`);
    assert.equal(ids.has(entry.id), false, `duplicate pattern id ${entry.id}`);
    ids.add(entry.id);
  }
  assert.ok(DISPLAY_PATTERNS.some((entry) => entry.colour === '#FFFFFF' && entry.kind === 'solid'));
  assert.ok(DISPLAY_PATTERNS.some((entry) => entry.colour === '#000000'));
  assert.equal(pattern('gray').kind, 'solid');
  assert.equal(pattern('nope'), null);
});

test('dead pixel guidance is advisory and never certifies the panel', () => {
  assert.equal(deadPixelGuidance(0).verdict, 'clean');
  assert.equal(deadPixelGuidance(2).verdict, 'minor');
  assert.match(deadPixelGuidance(2).text, /varies by panel/);
  assert.equal(deadPixelGuidance(9).verdict, 'significant');
  assert.equal(deadPixelGuidance(-1).verdict, 'unknown');
  assert.equal(deadPixelGuidance(null).verdict, 'unknown');
});
