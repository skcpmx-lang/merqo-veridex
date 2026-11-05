/**
 * VERIDEX — Network and connectivity diagnostics (MODULE 07).
 *
 * Enumerates Wi-Fi, Bluetooth, Ethernet and other adapters with addressing,
 * link speed and driver state. Two decisions worth stating:
 *
 *  - Only *physical* adapters are counted as hardware. Windows creates a large
 *    number of virtual adapters (WAN Miniport, Hyper-V, VPN tunnelling, loopback)
 *    and reporting them as hardware would misrepresent the machine.
 *  - MAC addresses and IPs are sensitive identifiers. They are collected because a
 *    technician needs them for diagnostics, but the privacy layer strips them from
 *    exported reports unless the user opts in.
 */

import { available, unavailable, failed, field } from '../core/field.js';
import { Status } from '../core/status.js';
import { cleanString, num, nonNegative, bool, asArray } from '../platform/parse.js';
import { queryCim, loadSystemInformation, failureToStatus } from '../platform/windows.js';

/**
 * Classify an adapter by its name, description and the physical-adapter flag.
 * @param {{name?:string|null, description?:string|null, physical?:boolean|null, type?:string|null}} input
 * @returns {'wifi'|'bluetooth'|'ethernet'|'virtual'|'other'}
 */
export function classifyAdapter(input = {}) {
  const text = `${input.name ?? ''} ${input.description ?? ''} ${input.type ?? ''}`.toLowerCase();
  if (!text.trim()) return 'other';

  // Virtual adapters must be filtered first: "Hyper-V Virtual Ethernet Adapter"
  // contains "ethernet" and would otherwise be counted as hardware.
  if (/wan miniport|hyper-v|vmware|virtualbox|tap-windows|openvpn|wireguard|loopback|teredo|isatap|tunnel|vpn|bluetooth pan|npcap|wintun|zerotier|tailscale/.test(text)) {
    return 'virtual';
  }
  if (/wi-?fi|wireless|wlan|802\.11|intel\(r\) wi-fi|killer\(r\) wi-fi|mediatek.*wi-fi|realtek.*wireless/.test(text)) return 'wifi';
  if (/bluetooth/.test(text)) return 'bluetooth';
  if (/ethernet|gbe|gigabit|realtek pcie|intel\(r\) i219|i225|i226|killer e\d/.test(text)) return 'ethernet';
  return 'other';
}

/**
 * Normalise a MAC address to upper-case colon-separated form.
 * Returns null for the all-zero and broadcast addresses Windows reports for
 * disconnected or virtual adapters.
 * @param {unknown} mac
 * @returns {string|null}
 */
export function normaliseMac(mac) {
  const text = cleanString(mac);
  if (!text) return null;
  const hex = text.replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (hex.length !== 12) return null;
  if (/^0{12}$/.test(hex) || /^F{12}$/.test(hex)) return null;
  return hex.match(/.{2}/g).join(':');
}

/**
 * Map a `Win32_NetworkAdapter` instance.
 * @param {object} adapter
 * @returns {{kind:string, fields:Record<string, import('../core/field.js').FieldValue>}}
 */
export function mapNetworkAdapter(adapter) {
  const source = 'cim-win32';
  const name = cleanString(adapter?.Name) ?? cleanString(adapter?.NetConnectionID);
  const description = cleanString(adapter?.ProductName) ?? cleanString(adapter?.Name);
  const physical = bool(adapter?.PhysicalAdapter);
  const kind = classifyAdapter({ name, description, physical });

  const speed = nonNegative(adapter?.Speed);
  const statusCode = num(adapter?.NetConnectionStatus);

  return {
    kind,
    fields: {
      name: name ? available(name, source) : unavailable('Adapter name not reported', source),
      description: description ? available(description, source) : unavailable('Adapter description not reported', source),
      kind: available(kind === 'virtual' ? 'Virtual' : kind === 'wifi' ? 'Wi-Fi' : kind === 'bluetooth' ? 'Bluetooth' : kind === 'ethernet' ? 'Ethernet' : 'Other', source),
      physical: physical === null ? unavailable('Windows did not report whether this adapter is physical', source) : available(physical ? 'Physical' : 'Virtual', source),
      macAddress: normaliseMac(adapter?.MACAddress)
        ? available(normaliseMac(adapter.MACAddress), source, { notes: ['Sensitive identifier: redacted from reports unless enabled.'] })
        : unavailable('No usable MAC address (the adapter is disconnected or reports the all-zero address)', source),
      linkSpeed: speed !== null && speed > 0 ? available(Math.round((speed / 1_000_000) * 10) / 10, source, { unit: 'Mbps', notes: ['Negotiated link speed as reported by Windows.'] }) : unavailable('Link speed not reported (the adapter may be disconnected)', source),
      connectionStatus: statusCode !== null ? available(describeConnectionStatus(statusCode), source) : unavailable('Connection status not reported', source),
      driverVersion: cleanString(adapter?.DriverVersion) ? available(cleanString(adapter.DriverVersion), source) : unavailable('Driver version not reported', source),
      driverDate: cleanString(adapter?.DriverDate) ? available(String(adapter.DriverDate).slice(0, 10), source) : unavailable('Driver date not reported', source),
      serviceName: cleanString(adapter?.ServiceName) ? available(cleanString(adapter.ServiceName), source) : unavailable('Driver service name not reported', source),
      deviceId: cleanString(adapter?.DeviceID) ? available(cleanString(adapter.DeviceID), source) : unavailable('Device id not reported', source),
      configManagerError: num(adapter?.ConfigManagerErrorCode) !== null
        ? (num(adapter.ConfigManagerErrorCode) === 0 ? available('No error', source) : field(`Device manager error code ${num(adapter.ConfigManagerErrorCode)}`, { status: Status.WARNING, source, notes: ['A non-zero code means the adapter is not functioning normally. See the Drivers page.'] }))
        : unavailable('Device manager error code not reported', source)
    }
  };
}

/**
 * @param {number} code Win32_NetworkAdapter.NetConnectionStatus
 */
export function describeConnectionStatus(code) {
  const map = {
    0: 'Disconnected',
    1: 'Connecting',
    2: 'Connected',
    3: 'Disconnecting',
    4: 'Hardware not present',
    5: 'Hardware disabled',
    6: 'Hardware malfunction',
    7: 'Media disconnected',
    8: 'Authenticating',
    9: 'Authentication succeeded',
    10: 'Authentication failed',
    11: 'Invalid address',
    12: 'Credentials required'
  };
  return map[code] ?? `Status ${code}`;
}

/**
 * Map `systeminformation.networkInterfaces()` for addressing.
 * @param {object[]} interfaces
 * @returns {{adapters: Array<{name:string, addresses:object[], mac:string|null, internal:boolean, virtual:boolean}>, summary: Record<string, import('../core/field.js').FieldValue>}}
 */
export function mapNetworkInterfaces(interfaces) {
  const source = 'systeminformation';
  const list = asArray(interfaces)
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      name: cleanString(entry.iface) ?? cleanString(entry.ifaceName) ?? 'unknown',
      addresses: asArray(entry.ip4 ? [{ family: 'IPv4', address: entry.ip4, netmask: entry.ip4subnet }] : []).concat(
        asArray(entry.ip6 ? [{ family: 'IPv6', address: entry.ip6, netmask: entry.ip6subnet }] : [])
      ),
      mac: normaliseMac(entry.mac),
      internal: Boolean(entry.internal),
      virtual: Boolean(entry.virtual)
    }));

  const physical = list.filter((entry) => !entry.internal && !entry.virtual);
  const withV4 = physical.filter((entry) => entry.addresses.some((address) => address.family === 'IPv4'));
  const ipv4Count = withV4.reduce((count, entry) => count + entry.addresses.filter((address) => address.family === 'IPv4').length, 0);

  return {
    adapters: list,
    summary: {
      interfaceCount: list.length > 0 ? available(list.length, source) : unavailable('Network interfaces not reported', source),
      physicalCount: available(physical.length, source, { notes: ['Excludes loopback, internal and virtual interfaces.'] }),
      activeIpv4Count: available(ipv4Count, source, { unit: 'addresses' })
    }
  };
}

/**
 * Map the default gateway and DNS servers from `Get-NetIPConfiguration`.
 * Kept separate because they are per-connection, not per-adapter.
 * @param {object[]} configurations
 * @param {object[]} dnsServers
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function mapIpConfiguration(configurations, dnsServers = []) {
  const source = 'cim-win32';
  const list = asArray(configurations).filter((entry) => entry && typeof entry === 'object');
  if (list.length === 0) {
    return {
      defaultGateway: unavailable('No IP configuration was returned; the machine may be disconnected', source),
      dnsServers: unavailable('DNS servers not reported', source)
    };
  }

  const gateways = [];
  const addresses = [];
  for (const configuration of list) {
    const gateway = cleanString(configuration?.IPv4DefaultGateway?.NextHop) ?? cleanString(configuration?.IPv6DefaultGateway?.NextHop);
    if (gateway) gateways.push(gateway);
    const ip = cleanString(configuration?.IPv4Address?.IPAddress) ?? cleanString(configuration?.IPv4Address?.[0]?.IPAddress);
    if (ip) addresses.push(ip);
  }

  // Get-DnsClientServerAddress returns one object per interface whose
  // ServerAddresses property is itself an array, so both shapes must be handled.
  const dns = [];
  for (const entry of asArray(dnsServers)) {
    if (!entry || typeof entry !== 'object') continue;
    const addresses = asArray(entry.ServerAddresses ?? entry.serverAddresses);
    for (const address of addresses) {
      const text = cleanString(address);
      if (text) dns.push(text);
    }
    if (addresses.length === 0) {
      const name = cleanString(entry.Name);
      if (name) dns.push(name);
    }
  }
  const uniqueDns = [...new Set(dns)];

  return {
    defaultGateway: gateways.length > 0 ? available([...new Set(gateways)], source) : unavailable('No default gateway is configured', source),
    ipAddress: addresses.length > 0 ? available([...new Set(addresses)], source) : unavailable('No IPv4 address is assigned', source),
    dnsServers: uniqueDns.length > 0 ? available(uniqueDns, source) : unavailable('No DNS servers are configured', source)
  };
}

/**
 * Register network providers and task.
 * @param {import('../engine/provider-registry.js').ProviderRegistry} registry
 */
export function registerNetwork(registry) {
  registry.registerProvider({
    id: 'cim-win32.network',
    title: 'Windows CIM (Win32_NetworkAdapter + IP configuration)',
    priority: 1,
    collect: async (ctx) => {
      const [adapters, configurations, dns] = await Promise.all([
        queryCim(ctx.runner, 'Win32_NetworkAdapter', { name: 'net:adapters', timeoutMs: ctx.timeoutMs }),
        queryCim(ctx.runner, 'Get-NetIPConfiguration', { name: 'net:ipconfig', timeoutMs: ctx.timeoutMs }),
        queryCim(ctx.runner, 'Get-DnsClientServerAddress', { name: 'net:dns', timeoutMs: ctx.timeoutMs })
      ]);

      if (!adapters.ok) {
        const cause = failureToStatus(adapters);
        return { adapters: cause.kind === 'permission' ? field(null, { status: Status.PERMISSION_REQUIRED, permissionRequired: true, error: cause.reason, source: 'cim-win32.network' }) : failed(adapters.error, 'cim-win32.network') };
      }

      /** @type {Record<string, import('../core/field.js').FieldValue>} */
      const fields = {};
      const counts = { wifi: 0, bluetooth: 0, ethernet: 0, virtual: 0, other: 0 };

      adapters.rows.forEach((adapter, index) => {
        const { kind, fields: mapped } = mapNetworkAdapter(adapter);
        counts[kind] = (counts[kind] ?? 0) + 1;
        for (const [key, value] of Object.entries(mapped)) {
          fields[`adapter${index + 1}.${key}`] = value;
        }
      });

      Object.assign(fields, mapIpConfiguration(configurations.rows, dns.rows));

      fields.wifiAdapterCount = available(counts.wifi, 'cim-win32.network', { notes: counts.wifi === 0 ? ['No Wi-Fi adapter was detected. This is expected on desktop boards without wireless, and is not a fault.'] : [] });
      fields.bluetoothAdapterCount = available(counts.bluetooth, 'cim-win32.network', { notes: counts.bluetooth === 0 ? ['No Bluetooth adapter was detected. This is expected on many desktops.'] : [] });
      fields.ethernetAdapterCount = available(counts.ethernet, 'cim-win32.network');
      fields.virtualAdapterCount = available(counts.virtual, 'cim-win32.network', { notes: ['Virtual and tunnelling adapters are counted separately so they are never mistaken for hardware.'] });

      return fields;
    }
  });

  registry.registerProvider({
    id: 'systeminformation.network',
    title: 'systeminformation (network interfaces)',
    priority: 2,
    collect: async () => {
      const loaded = await loadSystemInformation();
      if (!loaded.ok) return {};
      try {
        const mapped = mapNetworkInterfaces(await loaded.si.networkInterfaces());
        return mapped.summary;
      } catch {
        return {};
      }
    }
  });

  registry.registerTask({
    id: 'network.info',
    module: 'network',
    title: 'Network adapters',
    quick: true,
    providers: ['cim-win32.network', 'systeminformation.network'],
    validate: (fields) => {
      const problems = [];
      for (const [key, value] of Object.entries(fields)) {
        if (key.endsWith('.linkSpeed') && typeof value.value === 'number' && value.value > 800_000) {
          problems.push(`${key} reports ${value.value} Mbps, which exceeds any current link technology`);
        }
      }
      return problems;
    }
  });
}
