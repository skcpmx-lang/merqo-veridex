/**
 * VERIDEX — Graphics diagnostics (MODULE 01, GPU).
 *
 * The central difficulty: Windows reports VRAM through `Win32_VideoController.
 * AdapterRAM`, which is a **signed 32-bit** field. Every card with 4 GB or more
 * reports a negative or truncated value, which is why naive tools show "4095 MB"
 * for an 8 GB card. VERIDEX therefore prefers `HardwareInformation.qwMemorySize`
 * from the display adapter's registry key, and only falls back to AdapterRAM when
 * the registry value is absent — with a note explaining the limitation.
 *
 * Integrated vs dedicated is classified by an explicit rule table and recorded as a
 * heuristic, because the distinction is a product-catalogue fact, not something the
 * driver reports.
 */

import { available, unavailable, failed, field, unsupported } from '../core/field.js';
import { Status } from '../core/status.js';
import { cleanString, num, nonNegative, bytesToGiB, asArray, date } from '../platform/parse.js';
import { queryCim, readRegistry, listSubKeys, runReadOnly, loadSystemInformation, failureToStatus } from '../platform/windows.js';

/** Display adapter class GUID used by the registry memory-size key. */
export const DISPLAY_CLASS_GUID = '{4d36e968-e325-11ce-bfc1-08002be10318}';

/**
 * Classify an adapter as integrated, dedicated or virtual.
 * @param {string|null} name
 * @param {string|null} vendor
 * @returns {{kind:'integrated'|'dedicated'|'virtual'|'unknown', rule:string}}
 */
export function classifyAdapter(name, vendor = null) {
  const text = `${name ?? ''} ${vendor ?? ''}`.toLowerCase();
  if (!text.trim()) return { kind: 'unknown', rule: 'no adapter name or vendor available' };

  if (/basic display adapter|basic render driver|remote display|parsec|spacedesk|virtualbox|vmware|hyper-v|virtual display|citrix/.test(text)) {
    return { kind: 'virtual', rule: 'adapter name matches a known virtual/basic display driver' };
  }
  if (/nvidia|geforce|quadro|rtx |gtx |tesla/.test(text)) {
    return { kind: 'dedicated', rule: 'NVIDIA adapter model naming' };
  }
  if (/intel.*(hd|uhd|iris|arc)/.test(text)) {
    // Intel Arc discrete parts exist, but they all carry "Arc A" or "Arc B" model
    // numbers; everything else in Intel's HD/Iris/UHD line is integrated.
    if (/arc\s*(?:\(tm\)\s*)?(a|b)\s*\d{3}/.test(text)) return { kind: 'dedicated', rule: 'Intel Arc A/B-series discrete model number' };
    return { kind: 'integrated', rule: 'Intel HD/UHD/Iris graphics naming' };
  }
  if (/radeon.*(rx|pro w|vii)/.test(text) || /amd.*(rx \d|pro w)/.test(text)) {
    return { kind: 'dedicated', rule: 'AMD Radeon RX/Pro discrete model naming' };
  }
  if (/radeon|vega graphics|amd.*graphics/.test(text)) {
    // "Radeon Graphics", "Radeon Vega 8", "Radeon 780M" are integrated APU parts.
    return { kind: 'integrated', rule: 'AMD Radeon Graphics / Vega APU naming' };
  }
  if (/qualcomm|adreno|apple m\d/.test(text)) {
    return { kind: 'integrated', rule: 'SoC-integrated graphics' };
  }
  return { kind: 'unknown', rule: 'adapter name did not match any classification rule' };
}

/**
 * Map one Win32_VideoController instance.
 * @param {object} adapter
 * @param {number} vramBytesFromRegistry
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function mapVideoController(adapter, vramBytesFromRegistry = null) {
  const source = 'cim-win32';
  if (!adapter || typeof adapter !== 'object') return { adapter: unavailable('Win32_VideoController returned no instance', source) };

  const name = cleanString(adapter.Name);
  const vendor = cleanString(adapter.AdapterCompatibility);
  const classification = classifyAdapter(name, vendor);
  const adapterRam = nonNegative(adapter.AdapterRAM);
  const vramBytes = nonNegative(vramBytesFromRegistry) ?? (adapterRam !== null && adapterRam > 0 ? adapterRam : null);
  const vramSource = nonNegative(vramBytesFromRegistry) !== null ? 'registry' : source;

  const notes = [];
  if (nonNegative(vramBytesFromRegistry) === null && adapterRam !== null) {
    notes.push(
      'Read from Win32_VideoController.AdapterRAM, which is a signed 32-bit field. Any card with 4 GB or more is truncated by Windows, so this value may understate the real memory.'
    );
  } else {
    notes.push('Read from the display adapter registry key HardwareInformation.qwMemorySize, which is 64-bit and not truncated.');
  }

  const driverDate = date(adapter.DriverDate);

  return {
    name: name ? available(name, source) : unavailable('Adapter name not reported', source),
    vendor: vendor ? available(vendor, source) : unavailable('Adapter vendor not reported', source),
    classification: field(classification.kind === 'unknown' ? null : classification.kind === 'virtual' ? 'Virtual / basic display' : classification.kind === 'integrated' ? 'Integrated' : 'Dedicated', {
      status: classification.kind === 'unknown' ? Status.UNAVAILABLE : Status.PASS,
      source: 'vendor-heuristic',
      error: classification.kind === 'unknown' ? 'Adapter could not be classified' : null,
      notes: [`Classified as ${classification.kind} by rule: ${classification.rule}. This is a model-naming inference, not a driver-reported fact.`]
    }),
    dedicatedVram: vramBytes !== null ? available(bytesToGiB(vramBytes), vramSource, { unit: 'GB', notes }) : unavailable('Dedicated video memory not reported', source),
    sharedMemory: nonNegative(adapter.SharedSystemMemory) !== null ? available(bytesToGiB(nonNegative(adapter.SharedSystemMemory)), source, { unit: 'GB' }) : unavailable('Shared system memory not reported', source),
    driverVersion: cleanString(adapter.DriverVersion) ? available(cleanString(adapter.DriverVersion), source) : unavailable('Driver version not reported', source),
    driverDate: driverDate ? available(driverDate.slice(0, 10), source) : unavailable('Driver date not reported', source),
    driverProvider: cleanString(adapter.InstalledDisplayDrivers) ? available(cleanString(adapter.InstalledDisplayDrivers), source) : unavailable('Installed driver file list not reported', source),
    videoProcessor: cleanString(adapter.VideoProcessor) ? available(cleanString(adapter.VideoProcessor), source) : unavailable('Video processor name not reported', source),
    currentMode: cleanString(adapter.VideoModeDescription) ? available(cleanString(adapter.VideoModeDescription), source) : unavailable('Current video mode not reported', source),
    currentRefreshRate: nonNegative(adapter.CurrentRefreshRate) !== null ? available(nonNegative(adapter.CurrentRefreshRate), source, { unit: 'Hz', notes: ['Refresh rate of the primary display attached to this adapter.'] }) : unavailable('Refresh rate not reported', source),
    currentHorizontalResolution: nonNegative(adapter.CurrentHorizontalResolution) !== null ? available(nonNegative(adapter.CurrentHorizontalResolution), source, { unit: 'px' }) : unavailable('Horizontal resolution not reported', source),
    currentVerticalResolution: nonNegative(adapter.CurrentVerticalResolution) !== null ? available(nonNegative(adapter.CurrentVerticalResolution), source, { unit: 'px' }) : unavailable('Vertical resolution not reported', source),
    pnpDeviceId: cleanString(adapter.PNPDeviceID) ? available(cleanString(adapter.PNPDeviceID), source) : unavailable('Adapter instance id not reported', source),
    status: cleanString(adapter.Status) ? available(cleanString(adapter.Status), source) : unavailable('Adapter status not reported', source),
    adapterCompatibilityNote: cleanString(adapter.ConfigManagerErrorCode) && num(adapter.ConfigManagerErrorCode) !== 0
      ? field(`Device manager reports error code ${num(adapter.ConfigManagerErrorCode)}`, { status: Status.WARNING, source, notes: ['A non-zero code means Windows is not running this adapter normally. Check the Drivers page for detail.'] })
      : null
  };
}

/**
 * Read 64-bit VRAM for adapters from their registry keys.
 * Returns a map from adapter pnp id (lower-case) to bytes.
 * @param {import('../platform/runner.js').CommandRunner} runner
 * @param {number} timeoutMs
 * @returns {Promise<{map:Map<string, number>, error:string|null}>}
 */
export async function readVramFromRegistry(runner, timeoutMs = 20_000) {
  const map = new Map();
  const base = `HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\${DISPLAY_CLASS_GUID}`;
  const keys = await listSubKeys(runner, base, { timeoutMs });
  if (!keys.ok) return { map, error: keys.error };

  for (const key of keys.names.filter((name) => /^\d{4}$/.test(name))) {
    const detail = await readRegistry(runner, `${base}\\${key}`, { names: ['HardwareInformation.qwMemorySize', 'HardwareInformation.AdapterString', 'MatchingDeviceId'], timeoutMs });
    if (!detail.ok) continue;
    const byName = new Map(detail.values.map((entry) => [entry.name, entry.value]));
    const size = num(byName.get('HardwareInformation.qwMemorySize'));
    const matchingId = cleanString(byName.get('MatchingDeviceId'));
    const adapterString = cleanString(byName.get('HardwareInformation.AdapterString'));
    if (size === null || size <= 0) continue;
    if (matchingId) map.set(matchingId.toLowerCase(), size);
    if (adapterString) map.set(`name:${adapterString.toLowerCase()}`, size);
  }
  return { map, error: null };
}

/**
 * Match a Win32_VideoController instance to a registry VRAM reading.
 * @param {object} adapter
 * @param {Map<string, number>} vramMap
 * @returns {number|null}
 */
export function matchVram(adapter, vramMap) {
  const pnp = cleanString(adapter?.PNPDeviceID)?.toLowerCase();
  if (pnp) {
    if (vramMap.has(pnp)) return vramMap.get(pnp);
    // The registry's MatchingDeviceId usually omits the SUBSYS/REV suffixes that
    // PNPDeviceID carries, so an exact comparison misses real adapters. Match on
    // the vendor+device pair instead, which uniquely identifies the chip.
    const vendorDevice = pnp.match(/ven_[0-9a-f]{4}&dev_[0-9a-f]{4}/)?.[0];
    if (vendorDevice) {
      for (const [key, bytes] of vramMap) {
        if (key.includes(vendorDevice)) return bytes;
      }
    }
  }
  const name = cleanString(adapter?.Name)?.toLowerCase();
  if (name && vramMap.has(`name:${name}`)) return vramMap.get(`name:${name}`);
  return null;
}

/**
 * Map `systeminformation.graphics()` for utilisation and temperature.
 * @param {object} graphics
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function mapGraphicsUtilisation(graphics) {
  const source = 'systeminformation';
  const controllers = asArray(graphics?.controllers);
  /** @type {Record<string, import('../core/field.js').FieldValue>} */
  const fields = {};

  if (controllers.length > 0) {
    const primary = controllers[0];
    const utilisation = num(primary.utilizationGpu);
    fields.utilization = utilisation !== null && utilisation >= 0 && utilisation <= 100
      ? available(Math.round(utilisation * 10) / 10, source, { unit: '%' })
      : unavailable('GPU utilisation is not exposed by this driver', source);

    const memoryUsed = nonNegative(primary.memoryUsed);
    const memoryTotal = nonNegative(primary.memoryTotal);
    if (memoryUsed !== null && memoryTotal !== null && memoryTotal > 0) {
      fields.vramUsed = available(bytesToGiB(memoryUsed), source, { unit: 'GB' });
      fields.vramUtilization = available(Math.round((memoryUsed / memoryTotal) * 1000) / 10, source, { unit: '%' });
    } else {
      fields.vramUsed = unavailable('VRAM usage is not exposed by this driver', source);
    }

    const temperature = num(primary.temperatureGpu);
    // 0 and negative-zero are what drivers return when no sensor exists; a real
    // GPU is never at 0 °C while running, so treat that as absent rather than as a
    // reading.
    fields.temperature = temperature !== null && temperature > 0 && temperature < 150
      ? available(temperature, source, { unit: '°C' })
      : unavailable('No GPU temperature sensor provider is available on this system', source);

    const powerDraw = num(primary.powerDraw);
    fields.powerDraw = powerDraw !== null && powerDraw >= 0 ? available(powerDraw, source, { unit: 'W' }) : unavailable('GPU power draw is not exposed by this driver', source);

    const clockCore = nonNegative(primary.clockCore);
    fields.coreClock = clockCore !== null ? available(clockCore, source, { unit: 'MHz' }) : unavailable('GPU core clock is not exposed by this driver', source);
    const clockMemory = nonNegative(primary.clockMemory);
    fields.memoryClock = clockMemory !== null ? available(clockMemory, source, { unit: 'MHz' }) : unavailable('GPU memory clock is not exposed by this driver', source);
  } else {
    fields.utilization = unavailable('No graphics controller reported', source);
  }

  fields.controllerCount = controllers.length > 0 ? available(controllers.length, source) : unavailable('Graphics controller count not reported', source);
  return fields;
}

/**
 * Parse the summary section of a `dxdiag /t` report.
 *
 * dxdiag is the only offline way to obtain the DirectX runtime version and the
 * per-monitor identity without a paid SDK. It writes a text file and takes several
 * seconds, so it is a *fallback* provider, never on the quick-scan path.
 *
 * @param {string} text
 * @returns {{directxVersion:string|null, displayMemory:string|null, monitors:string[], raw:boolean}}
 */
export function parseDxDiag(text) {
  const source = typeof text === 'string' ? text : '';
  if (!source.trim()) return { directxVersion: null, displayMemory: null, monitors: [], raw: false };

  const directxVersion = source.match(/DirectX Version:\s*([^\r\n]+)/i)?.[1]?.trim() ?? null;
  const displayMemory = source.match(/Display Memory:\s*([^\r\n]+)/i)?.[1]?.trim() ?? null;

  // Monitor entries appear as "Card name:" / "Monitor Name:" / "Monitor Model:".
  const monitors = [...source.matchAll(/Monitor (?:Name|Model):\s*([^\r\n]+)/gi)].map((match) => match[1].trim()).filter(Boolean);

  return { directxVersion, displayMemory, monitors: [...new Set(monitors)], raw: true };
}

/**
 * Register GPU providers and task.
 * @param {import('../engine/provider-registry.js').ProviderRegistry} registry
 */
export function registerGpu(registry) {
  registry.registerProvider({
    id: 'cim-win32.gpu',
    title: 'Windows CIM (Win32_VideoController)',
    priority: 1,
    collect: async (ctx) => {
      const controllers = await queryCim(ctx.runner, 'Win32_VideoController', { name: 'gpu:videocontroller', timeoutMs: ctx.timeoutMs });
      if (!controllers.ok) {
        const cause = failureToStatus(controllers);
        return {
          adapters: cause.kind === 'permission'
            ? field(null, { status: Status.PERMISSION_REQUIRED, permissionRequired: true, error: cause.reason, source: 'cim-win32.gpu' })
            : failed(controllers.error ?? 'Graphics adapters unavailable', 'cim-win32.gpu')
        };
      }

      const vram = await readVramFromRegistry(ctx.runner, ctx.timeoutMs);
      /** @type {Record<string, import('../core/field.js').FieldValue>} */
      const fields = {};
      const adapters = controllers.rows.filter((row) => cleanString(row?.Name));

      adapters.forEach((adapter, index) => {
        const mapped = mapVideoController(adapter, matchVram(adapter, vram.map));
        for (const [key, value] of Object.entries(mapped)) {
          if (value === null) continue;
          fields[`adapter${index + 1}.${key}`] = value;
        }
      });

      fields.adapterCount = adapters.length > 0
        ? available(adapters.length, 'cim-win32.gpu', { notes: adapters.length > 1 ? ['Multiple display adapters detected (for example an integrated GPU plus a discrete GPU, or a virtual display).'] : [] })
        : unavailable('No display adapters reported', 'cim-win32.gpu');

      const physical = adapters.filter((adapter) => classifyAdapter(cleanString(adapter.Name), cleanString(adapter.AdapterCompatibility)).kind !== 'virtual');
      fields.physicalAdapterCount = physical.length > 0 ? available(physical.length, 'vendor-heuristic', { notes: ['Count of adapters that are neither virtual nor basic display drivers.'] }) : unavailable('Could not determine physical adapter count', 'vendor-heuristic');

      return fields;
    }
  });

  registry.registerProvider({
    id: 'systeminformation.gpu',
    title: 'systeminformation (GPU counters)',
    priority: 2,
    collect: async () => {
      const loaded = await loadSystemInformation();
      if (!loaded.ok) return { utilization: unavailable(`systeminformation unavailable: ${loaded.error}`, 'systeminformation.gpu') };
      try {
        const graphics = await loaded.si.graphics();
        return mapGraphicsUtilisation(graphics);
      } catch (error) {
        return { utilization: failed(error, 'systeminformation.gpu') };
      }
    }
  });

  registry.registerTask({
    id: 'gpu.info',
    module: 'gpu',
    title: 'Graphics adapters',
    quick: true,
    providers: ['cim-win32.gpu', 'systeminformation.gpu'],
    validate: (fields) => {
      const problems = [];
      for (const [key, value] of Object.entries(fields)) {
        if (key.endsWith('.dedicatedVram') && typeof value.value === 'number' && value.value > 256) {
          problems.push(`${key} reports ${value.value} GB, which exceeds any current consumer GPU and suggests a unit error`);
        }
        if (key.endsWith('.dedicatedVram') && typeof value.value === 'number' && value.value <= 0) {
          problems.push(`${key} is not positive; an integrated adapter legitimately has no dedicated memory, but a dedicated one cannot report 0 GB`);
        }
      }
      return problems;
    }
  });

  registry.registerProvider({
    id: 'directx-dxdiag.gpu',
    title: 'dxdiag text report',
    priority: 1,
    collect: async (ctx) => {
      const target = `${process.env.TEMP ?? process.env.TMP ?? '.'}\\veridex-dxdiag-${Date.now()}.txt`;
      if (!ctx.runner.isWindows) return { directxVersion: unsupported('dxdiag is only available on Windows', 'directx-dxdiag.gpu') };

      const run = await runReadOnly(ctx.runner, 'directx-dxdiag.gpu', ['/t', target, '/whql:off'], { timeoutMs: Math.max(ctx.timeoutMs, 45_000) });
      if (!run.ok) {
        return {
          directxVersion: field(null, {
            status: Status.ERROR,
            source: 'directx-dxdiag.gpu',
            error: `dxdiag did not complete (${run.timedOut ? 'timed out' : `exit ${run.code}`}). The DirectX tool is slow on some systems; this does not indicate a GPU fault.`
          })
        };
      }

      try {
        const { readFile, unlink } = await import('node:fs/promises');
        const text = await readFile(target, 'utf8');
        await unlink(target).catch(() => {});
        const parsed = parseDxDiag(text);
        return {
          directxVersion: parsed.directxVersion ? available(parsed.directxVersion, 'directx-dxdiag.gpu') : unavailable('DirectX version not found in the dxdiag report', 'directx-dxdiag.gpu'),
          reportedDisplayMemory: parsed.displayMemory ? available(parsed.displayMemory, 'directx-dxdiag.gpu') : unavailable('Display memory not found in the dxdiag report', 'directx-dxdiag.gpu'),
          monitors: parsed.monitors.length > 0 ? available(parsed.monitors, 'directx-dxdiag.gpu') : unavailable('Monitor names not found in the dxdiag report', 'directx-dxdiag.gpu')
        };
      } catch (error) {
        return { directxVersion: failed(`dxdiag report could not be read: ${error instanceof Error ? error.message : String(error)}`, 'directx-dxdiag.gpu') };
      }
    }
  });

  registry.registerTask({
    id: 'gpu.directx',
    module: 'directx',
    title: 'DirectX runtime',
    quick: false,
    providers: ['directx-dxdiag.gpu']
  });
}
