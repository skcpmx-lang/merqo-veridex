import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyAdapter, normaliseMac, describeConnectionStatus, mapNetworkAdapter, mapIpConfiguration, mapNetworkInterfaces } from '../../src/diagnostics/network.js';
import { Status } from '../../src/core/status.js';

test('adapters are classified by name and virtual adapters are recognised first', () => {
  const cases = [
    ['Intel(R) Wi-Fi 6 AX201 160MHz', 'wifi'],
    ['Killer(R) Wi-Fi 6E AX1675x Wireless Network Adapter', 'wifi'],
    ['Realtek PCIe GbE Family Controller', 'ethernet'],
    ['Intel(R) Ethernet Connection I219-V', 'ethernet'],
    ['Bluetooth Device (Personal Area Network)', 'bluetooth'],
    ['Hyper-V Virtual Ethernet Adapter #2', 'virtual'],
    ['WAN Miniport (IP)', 'virtual'],
    ['TAP-Windows Adapter V9', 'virtual'],
    ['WireGuard Tunnel', 'virtual']
  ];
  for (const [name, expected] of cases) assert.equal(classifyAdapter({ name }), expected, name);
});

test('virtual detection wins over the ethernet keyword inside a virtual adapter name', () => {
  assert.equal(classifyAdapter({ name: 'Hyper-V Virtual Ethernet Adapter' }), 'virtual');
});

test('MAC addresses are normalised and invalid sentinels are refused', () => {
  assert.equal(normaliseMac('a4:bb:6d:12:34:56'), 'A4:BB:6D:12:34:56');
  assert.equal(normaliseMac('A4-BB-6D-12-34-56'), 'A4:BB:6D:12:34:56');
  assert.equal(normaliseMac('00:00:00:00:00:00'), null, 'all-zero means disconnected, not a real MAC');
  assert.equal(normaliseMac('FF:FF:FF:FF:FF:FF'), null);
  assert.equal(normaliseMac(''), null);
  assert.equal(normaliseMac(null), null);
  assert.equal(normaliseMac('not-a-mac'), null);
});

test('connection status codes map to their documented meanings', () => {
  assert.equal(describeConnectionStatus(2), 'Connected');
  assert.equal(describeConnectionStatus(7), 'Media disconnected');
  assert.equal(describeConnectionStatus(5), 'Hardware disabled');
  assert.equal(describeConnectionStatus(99), 'Status 99');
});

test('link speed is converted from bps to Mbps and absence is honest', () => {
  const connected = mapNetworkAdapter({ Name: 'Intel(R) Wi-Fi 6 AX201', PhysicalAdapter: true, Speed: 866700000, NetConnectionStatus: 2, MACAddress: 'A4BB6D123456' });
  assert.equal(connected.kind, 'wifi');
  assert.equal(connected.fields.linkSpeed.value, 866.7);
  assert.equal(connected.fields.linkSpeed.unit, 'Mbps');

  const disconnected = mapNetworkAdapter({ Name: 'Intel(R) Wi-Fi 6 AX201', PhysicalAdapter: true, Speed: 0, NetConnectionStatus: 7 });
  assert.equal(disconnected.fields.linkSpeed.status, Status.UNAVAILABLE);
  assert.match(disconnected.fields.linkSpeed.error, /disconnected/);
});

test('a device manager error on an adapter is surfaced as a warning', () => {
  const mapped = mapNetworkAdapter({ Name: 'Realtek PCIe GbE', ConfigManagerErrorCode: 10 });
  assert.equal(mapped.fields.configManagerError.status, Status.WARNING);
  assert.match(mapped.fields.configManagerError.value, /10/);
});

test('IP configuration handles single and multiple gateways without inventing one', () => {
  const single = mapIpConfiguration([{ IPv4DefaultGateway: { NextHop: '192.168.1.1' }, IPv4Address: { IPAddress: '192.168.1.42' } }], [{ ServerAddresses: ['1.1.1.1', '8.8.8.8'] }]);
  assert.deepEqual(single.defaultGateway.value, ['192.168.1.1']);
  assert.deepEqual(single.ipAddress.value, ['192.168.1.42']);
  assert.deepEqual(single.dnsServers.value, ['1.1.1.1', '8.8.8.8']);

  const none = mapIpConfiguration([], []);
  assert.equal(none.defaultGateway.status, Status.UNAVAILABLE);
  assert.match(none.defaultGateway.error, /disconnected/);
});

test('network interface summary separates physical from virtual interfaces', () => {
  const { summary, adapters } = mapNetworkInterfaces([
    { iface: 'Ethernet', ip4: '192.168.1.10', mac: 'a4bb6d123456', internal: false, virtual: false },
    { iface: 'vEthernet (Default)', ip4: '172.20.0.1', mac: '00155d123456', internal: false, virtual: true },
    { iface: 'Loopback Pseudo-Interface 1', ip4: '127.0.0.1', mac: '000000000000', internal: true, virtual: false }
  ]);
  assert.equal(adapters.length, 3);
  assert.equal(summary.physicalCount.value, 1, 'loopback and virtual are excluded');
  assert.equal(summary.activeIpv4Count.value, 1);
});
