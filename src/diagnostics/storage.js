/**
 * VERIDEX — Storage diagnostics (MODULE 01, Storage).
 *
 * Enumeration order of preference:
 *   1. `MSFT_PhysicalDisk` (root/Microsoft/Windows/Storage) — the modern, complete
 *      source: bus type, media type, health status and firmware revision.
 *   2. `Win32_DiskDrive` — always present, older, but lacks the bus type for NVMe.
 *   3. `systeminformation.diskLayout()` — last resort for size/model.
 *
 * Health data comes from the protocol-specific providers, selected by bus type:
 * NVMe drives use the NVMe health log; SATA/USB drives use the ATA SMART page. That
 * separation is mandatory in the brief and it matters in practice: sending an ATA
 * SMART command to an NVMe device silently returns nothing on most systems, which is
 * how tools end up reporting "SMART not supported" for perfectly healthy NVMe drives.
 *
 * SMART needs DeviceIoControl, which needs an elevated token. Without it the drive is
 * enumerated normally and the health fields say PERMISSION_REQUIRED with the exact
 * reason, so the user knows the drive is not unreadable, only out of reach.
 */

import { available, unavailable, failed, field, permissionRequired, unsupported } from '../core/field.js';
import { Status } from '../core/status.js';
import { cleanString, num, nonNegative, bytesToGiB } from '../platform/parse.js';
import { queryCim, loadSystemInformation, failureToStatus } from '../platform/windows.js';
import { parseSmartData, interpretSmart } from '../providers/smart-ata.js';
import { parseNvmeHealthLog, interpretNvmeHealth, describePercentageUsed } from '../providers/smart-nvme.js';

/** MSFT_PhysicalDisk MediaType values. */
const MEDIA_TYPE = Object.freeze({ 0: 'Unspecified', 3: 'HDD', 4: 'SSD', 5: 'SCM' });

/** MSFT_PhysicalDisk BusType values that matter for a technician. */
const BUS_TYPE = Object.freeze({
  0: 'Unknown',
  1: 'SCSI',
  2: 'ATAPI',
  3: 'ATA (SATA)',
  4: 'IEEE 1394',
  5: 'SSA',
  6: 'Fibre Channel',
  7: 'USB',
  8: 'RAID',
  9: 'iSCSI',
  10: 'SAS',
  11: 'SATA',
  12: 'SD',
  13: 'MMC',
  14: 'Virtual',
  15: 'File-backed virtual',
  16: 'Storage Spaces',
  17: 'NVMe',
  18: 'SCM',
  19: 'UFS'
});

/** MSFT_PhysicalDisk HealthStatus values. */
const HEALTH_STATUS = Object.freeze({ 0: 'Healthy', 1: 'Warning', 2: 'Unhealthy', 5: 'Unknown' });

/**
 * Map one `MSFT_PhysicalDisk` instance to fields.
 * @param {object} disk
 * @param {number} index
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function mapPhysicalDisk(disk, index = 0) {
  const source = 'cim-win32';
  if (!disk || typeof disk !== 'object') return {};

  const sizeBytes = nonNegative(disk.Size);
  const mediaType = num(disk.MediaType);
  const busType = num(disk.BusType);
  const health = num(disk.HealthStatus);
  const label = `Disk ${index + 1}`;

  /** @type {Record<string, import('../core/field.js').FieldValue>} */
  const fields = {
    label: available(label, source),
    friendlyName: cleanString(disk.FriendlyName) ? available(cleanString(disk.FriendlyName), source) : unavailable(`${label}: name not reported`, source),
    model: cleanString(disk.Model) ? available(cleanString(disk.Model), source) : unavailable(`${label}: model not reported`, source),
    manufacturer: cleanString(disk.Manufacturer) ? available(cleanString(disk.Manufacturer), source) : unavailable(`${label}: manufacturer not reported`, source),
    capacity: sizeBytes !== null ? available(bytesToGiB(sizeBytes), source, { unit: 'GB' }) : unavailable(`${label}: capacity not reported`, source),
    mediaType: mediaType !== null && MEDIA_TYPE[mediaType] ? available(MEDIA_TYPE[mediaType], source) : unavailable(`${label}: media type not reported`, source),
    busType: busType !== null && BUS_TYPE[busType] ? available(BUS_TYPE[busType], source) : unavailable(`${label}: bus type not reported`, source),
    healthStatus: health !== null && HEALTH_STATUS[health] ? available(HEALTH_STATUS[health], source, { notes: ['Windows storage-stack health as reported by Storage Management.'] }) : unavailable(`${label}: Windows health status not reported`, source),
    serialNumber: cleanString(disk.SerialNumber) ? available(cleanString(disk.SerialNumber), source, { notes: ['Sensitive identifier: redacted from reports unless enabled.'] }) : unavailable(`${label}: serial number not available (Windows hides it without elevation)`, source),
    firmwareVersion: cleanString(disk.FirmwareVersion) ? available(cleanString(disk.FirmwareVersion), source) : unavailable(`${label}: firmware revision not reported`, source),
    spindleSpeed: nonNegative(disk.SpindleSpeed) !== null && nonNegative(disk.SpindleSpeed) > 0 ? available(nonNegative(disk.SpindleSpeed), source, { unit: 'RPM' }) : unavailable(`${label}: rotational speed not reported (normal for solid-state drives)`, source),
    physicalLocation: cleanString(disk.PhysicalLocation) ? available(cleanString(disk.PhysicalLocation), source) : unavailable(`${label}: physical location not reported`, source)
  };

  if (health === 2) {
    fields.healthNote = failed('Windows reports this disk as unhealthy', source);
  } else if (health === 1) {
    fields.healthNote = field('Windows reports a warning for this disk', { status: Status.WARNING, source });
  }

  return fields;
}

/**
 * Map a `Win32_DiskDrive` instance, used when Storage Management is unavailable.
 * @param {object} drive
 * @param {number} index
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function mapDiskDrive(drive, index = 0) {
  const source = 'cim-win32';
  const label = `Disk ${index + 1}`;
  const sizeBytes = nonNegative(drive?.Size);
  const interfaceType = cleanString(drive?.InterfaceType);
  const mediaType = cleanString(drive?.MediaType);
  const model = cleanString(drive?.Model);

  // Win32_DiskDrive does not report NVMe; the model string and the interface type
  // together are the only signal, so the inference is labelled.
  let busType = interfaceType;
  if (!interfaceType || interfaceType.toUpperCase() === 'SCSI') {
    if (/nvme/i.test(model ?? '') || /NVMe/i.test(cleanString(drive?.Caption) ?? '')) {
      busType = 'NVMe (inferred from the model string)';
    }
  }

  return {
    label: available(label, source),
    friendlyName: model ? available(model, source) : unavailable(`${label}: model not reported`, source),
    model: model ? available(model, source) : unavailable(`${label}: model not reported`, source),
    manufacturer: cleanString(drive?.Manufacturer) ? available(cleanString(drive.Manufacturer), source) : unavailable(`${label}: manufacturer not reported`, source),
    capacity: sizeBytes !== null ? available(bytesToGiB(sizeBytes), source, { unit: 'GB' }) : unavailable(`${label}: capacity not reported`, source),
    mediaType: mediaType ? available(mediaType, source) : unavailable(`${label}: media type not reported`, source),
    busType: busType ? available(busType, source) : unavailable(`${label}: bus type not reported`, source),
    serialNumber: cleanString(drive?.SerialNumber) ? available(cleanString(drive.SerialNumber), source, { notes: ['Sensitive identifier: redacted unless enabled.'] }) : unavailable(`${label}: serial number not available`, source),
    firmwareVersion: cleanString(drive?.FirmwareRevision) ? available(cleanString(drive.FirmwareRevision), source) : unavailable(`${label}: firmware revision not reported`, source),
    partitions: nonNegative(drive?.Partitions) !== null ? available(nonNegative(drive.Partitions), source) : unavailable(`${label}: partition count not reported`, source),
    healthStatus: unavailable(`${label}: Windows health status is not exposed through Win32_DiskDrive`, source)
  };
}

/**
 * Decide which health provider applies to a disk.
 * This is the SATA/NVMe separation the brief requires.
 * @param {{busType:string|null, model:string|null}} disk
 * @returns {'nvme'|'ata'|'none'}
 */
export function selectHealthProvider(disk) {
  const bus = (disk.busType ?? '').toLowerCase();
  const model = (disk.model ?? '').toLowerCase();
  if (bus.includes('nvme')) return 'nvme';
  if (bus.includes('sata') || bus.includes('ata') || bus.includes('usb') || bus.includes('sas')) return 'ata';
  if (/nvme/.test(model)) return 'nvme';
  // Virtual/unknown bus types: no protocol-level health log exists.
  return 'none';
}

/**
 * Turn an ATA SMART parse into health fields for one disk.
 * @param {ReturnType<typeof parseSmartData>} parsed
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function smartToFields(parsed) {
  const source = 'ata-smart';
  const interpretation = interpretSmart(parsed);
  /** @type {Record<string, import('../core/field.js').FieldValue>} */
  const fields = {
    healthAssessment: field(interpretation.findings.join(' ') || null, {
      status: interpretation.status,
      source,
      error: interpretation.status === 'UNAVAILABLE' ? 'SMART data could not be read' : null,
      notes: interpretation.notes
    }),
    temperature: parsed.temperature !== null ? available(parsed.temperature, source, { unit: '°C' }) : unavailable('This drive did not report a temperature attribute', source),
    powerOnHours: parsed.powerOnHours !== null ? available(parsed.powerOnHours, source, { unit: 'hours' }) : unavailable('This drive did not report power-on hours', source),
    powerCycleCount: parsed.powerCycleCount !== null ? available(parsed.powerCycleCount, source, { unit: 'count' }) : unavailable('This drive did not report a power-cycle count', source),
    reallocatedSectors: parsed.reallocatedSectors !== null ? available(parsed.reallocatedSectors, source, { unit: 'sectors', status: parsed.reallocatedSectors > 0 ? Status.WARNING : Status.PASS }) : unavailable('Attribute 5 (reallocated sectors) was not reported', source),
    pendingSectors: parsed.pendingSectors !== null ? available(parsed.pendingSectors, source, { unit: 'sectors', status: parsed.pendingSectors > 0 ? Status.WARNING : Status.PASS }) : unavailable('Attribute 197 (pending sectors) was not reported', source),
    uncorrectableErrors: parsed.uncorrectableErrors !== null ? available(parsed.uncorrectableErrors, source, { unit: 'count', status: parsed.uncorrectableErrors > 0 ? Status.WARNING : Status.PASS }) : unavailable('Attribute 187 (uncorrectable errors) was not reported', source),
    crcErrors: parsed.crcErrors !== null ? available(parsed.crcErrors, source, { unit: 'count', status: parsed.crcErrors > 0 ? Status.WARNING : Status.PASS }) : unavailable('Attribute 199 (UDMA CRC errors) was not reported', source),
    attributeCount: available(parsed.attributes.length, source, { notes: [`${parsed.standardAttributes} standardised and ${parsed.vendorAttributes} vendor-specific attributes were decoded.`] })
  };
  return fields;
}

/**
 * Turn an NVMe health log into health fields for one disk.
 * @param {ReturnType<typeof parseNvmeHealthLog>} health
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function nvmeToFields(health) {
  const source = 'nvme-health-log';
  const interpretation = interpretNvmeHealth(health);
  const endurance = describePercentageUsed(health.percentageUsed, health.percentageUsedRaw);

  /** @type {Record<string, import('../core/field.js').FieldValue>} */
  const fields = {
    healthAssessment: field(interpretation.findings.join(' ') || null, {
      status: interpretation.status,
      source,
      error: interpretation.status === 'UNAVAILABLE' ? 'The NVMe health log could not be read' : null,
      notes: interpretation.notes
    }),
    temperature: health.temperatureC !== null ? available(health.temperatureC, source, { unit: '°C', notes: ['Composite temperature from the controller.'] }) : unavailable('The controller did not report a composite temperature', source),
    percentageUsed: health.percentageUsed !== null
      ? available(health.percentageUsed, source, { unit: '%', status: endurance.status, notes: ['Reported by the drive firmware as consumed endurance, not computed by VERIDEX.'] })
      : field(null, { status: Status.UNAVAILABLE, source, error: endurance.reason }),
    availableSpare: health.availableSpare !== null ? available(health.availableSpare, source, { unit: '%', status: health.availableSpare === 0 ? Status.FAIL : health.availableSpareThreshold !== null && health.availableSpare < health.availableSpareThreshold ? Status.WARNING : Status.PASS }) : unavailable('Available spare not reported', source),
    availableSpareThreshold: health.availableSpareThreshold !== null ? available(health.availableSpareThreshold, source, { unit: '%', notes: ['The drive\'s own warning threshold, not a VERIDEX threshold.'] }) : unavailable('Spare threshold not reported', source),
    criticalWarning: health.criticalWarning.raw === 0
      ? available('No critical warning', source)
      : field(health.criticalWarning.bits.join('; '), { status: Status.FAIL, source, notes: [`Raw warning byte: 0x${health.criticalWarning.raw.toString(16).padStart(2, '0')}`] }),
    mediaErrors: health.mediaErrors !== null ? available(health.mediaErrors, source, { unit: 'count', status: health.mediaErrors > 0 ? Status.WARNING : Status.PASS }) : unavailable('Media error count not reported', source),
    unsafeShutdowns: health.unsafeShutdowns !== null ? available(health.unsafeShutdowns, source, { unit: 'count' }) : unavailable('Unsafe shutdown count not reported', source),
    powerOnHours: health.powerOnHours !== null ? available(health.powerOnHours, source, { unit: 'hours' }) : unavailable('Power-on hours not reported', source),
    powerCycles: health.powerCycles !== null ? available(health.powerCycles, source, { unit: 'count' }) : unavailable('Power cycle count not reported', source),
    hostReads: health.hostReads !== null ? available(health.hostReads, source, { unit: 'TiB', notes: ['Converted from the controller\'s data-units-read counter (1 unit = 512,000 bytes).'] }) : unavailable('Data-units-read counter not reported', source),
    hostWrites: health.hostWrites !== null ? available(health.hostWrites, source, { unit: 'TiB', notes: ['Converted from the controller\'s data-units-written counter (1 unit = 512,000 bytes).'] }) : unavailable('Data-units-written counter not reported', source),
    controllerBusyMinutes: health.controllerBusyMinutes !== null ? available(health.controllerBusyMinutes, source, { unit: 'min' }) : unavailable('Controller busy time not reported', source),
    errorLogEntries: health.errorLogEntries !== null ? available(health.errorLogEntries, source, { unit: 'count' }) : unavailable('Error log entry count not reported', source),
    temperatureSensors: health.temperatureSensorsK.length > 0 ? available(health.temperatureSensorsK.map((kelvin) => Math.round((kelvin - 273.15) * 10) / 10), source, { unit: '°C', notes: ['Per-sensor readings from the controller, where the drive exposes them.'] }) : unavailable('This drive exposes no per-sensor temperatures', source)
  };

  return fields;
}

/**
 * Summarise the physical disk set for the top of the report.
 * @param {Array<{busType:string|null, capacity:number|null, mediaType:string|null}>} disks
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function summariseDisks(disks) {
  const source = 'computed';
  const list = Array.isArray(disks) ? disks : [];
  const totalCapacity = list.reduce((sum, disk) => sum + (typeof disk.capacity === 'number' ? disk.capacity : 0), 0);
  const nvme = list.filter((disk) => (disk.busType ?? '').toLowerCase().includes('nvme')).length;
  const ssd = list.filter((disk) => (disk.mediaType ?? '').toUpperCase() === 'SSD').length;
  const hdd = list.filter((disk) => (disk.mediaType ?? '').toUpperCase() === 'HDD').length;
  const usb = list.filter((disk) => (disk.busType ?? '').toLowerCase().includes('usb')).length;

  return {
    diskCount: list.length > 0 ? available(list.length, source) : unavailable('No physical disks were enumerated', 'cim-win32'),
    totalCapacity: list.length > 0 ? available(Math.round(totalCapacity * 10) / 10, source, { unit: 'GB' }) : unavailable('Total capacity not available', source),
    nvmeCount: list.length > 0 ? available(nvme, source) : unavailable('NVMe disk count not available', source),
    ssdCount: list.length > 0 ? available(ssd, source) : unavailable('SSD count not available', source),
    hddCount: list.length > 0 ? available(hdd, source) : unavailable('HDD count not available', source),
    usbStorageCount: list.length > 0 ? available(usb, source) : unavailable('USB storage count not available', source)
  };
}

/**
 * Register storage providers and the two health tasks.
 * @param {import('../engine/provider-registry.js').ProviderRegistry} registry
 */
export function registerStorage(registry) {
  registry.registerProvider({
    id: 'cim-win32',
    title: 'Windows Storage Management (MSFT_PhysicalDisk)',
    priority: 1,
    collect: async (ctx) => {
      const physical = await queryCim(ctx.runner, 'MSFT_PhysicalDisk', { namespace: 'root/Microsoft/Windows/Storage', name: 'storage:physicaldisk', timeoutMs: ctx.timeoutMs });
      const rows = physical.ok ? physical.rows : [];
      const disks = [];

      if (rows.length === 0) {
        const fallback = await queryCim(ctx.runner, 'Win32_DiskDrive', { name: 'storage:diskdrive', timeoutMs: ctx.timeoutMs });
        if (!fallback.ok) {
          const cause = failureToStatus(fallback);
          return {
            disks: cause.kind === 'permission'
              ? permissionRequired(cause.reason, 'cim-win32')
              : failed(fallback.error ?? 'No storage devices could be enumerated', 'cim-win32')
          };
        }
        fallback.rows.forEach((drive, index) => {
          const mapped = mapDiskDrive(drive, index);
          for (const [key, value] of Object.entries(mapped)) disks.push({ key: `disk${index + 1}.${key}`, value });
          disks.push({ key: `disk${index + 1}.source`, value: available('Win32_DiskDrive (Storage Management unavailable)', 'cim-win32') });
        });
      } else {
        rows.forEach((disk, index) => {
          const mapped = mapPhysicalDisk(disk, index);
          for (const [key, value] of Object.entries(mapped)) disks.push({ key: `disk${index + 1}.${key}`, value });
        });
      }

      /** @type {Record<string, import('../core/field.js').FieldValue>} */
      const fields = {};
      /** @type {Array<{busType:string|null, capacity:number|null, mediaType:string|null}>} */
      const summaryInput = [];

      for (const entry of disks) fields[entry.key] = entry.value;

      const count = rows.length > 0 ? rows.length : (await Promise.resolve(disks.filter((entry) => entry.key.endsWith('.label')).length));
      for (let index = 1; index <= count; index += 1) {
        summaryInput.push({
          busType: fields[`disk${index}.busType`]?.value ?? null,
          capacity: fields[`disk${index}.capacity`]?.value ?? null,
          mediaType: fields[`disk${index}.mediaType`]?.value ?? null
        });
      }
      Object.assign(fields, summariseDisks(summaryInput));
      return fields;
    }
  });

  registry.registerProvider({
    id: 'systeminformation',
    title: 'systeminformation (disk layout)',
    priority: 2,
    collect: async () => {
      const loaded = await loadSystemInformation();
      if (!loaded.ok) return {};
      try {
        const layout = await loaded.si.diskLayout();
        /** @type {Record<string, import('../core/field.js').FieldValue>} */
        const fields = {};
        (Array.isArray(layout) ? layout : []).forEach((disk, index) => {
          const size = nonNegative(disk.size);
          if (size !== null && size > 0) fields[`disk${index + 1}.capacity`] = available(bytesToGiB(size), 'systeminformation', { unit: 'GB' });
          const type = cleanString(disk.type);
          if (type) fields[`disk${index + 1}.mediaType`] = available(type, 'systeminformation');
          const iface = cleanString(disk.interfaceType);
          if (iface) fields[`disk${index + 1}.busType`] = available(iface, 'systeminformation');
        });
        return fields;
      } catch {
        return {};
      }
    }
  });

  registry.registerTask({
    id: 'storage.inventory',
    module: 'storage',
    title: 'Storage devices',
    quick: true,
    providers: ['cim-win32', 'systeminformation'],
    validate: (fields) => {
      const problems = [];
      for (const [key, value] of Object.entries(fields)) {
        if (key.endsWith('.capacity') && typeof value.value === 'number' && (value.value <= 0 || value.value > 100_000)) {
          problems.push(`${key} reports an implausible capacity of ${value.value} GB`);
        }
      }
      return problems;
    }
  });

  // ── SATA / ATA SMART ─────────────────────────────────────────────────────────
  registry.registerProvider({
    id: 'ata-smart',
    title: 'ATA SMART (DeviceIoControl 0x7C)',
    capability: 'storage.smart',
    priority: 1,
    collect: async (ctx) => {
      if (!ctx.permissions.isAdmin) {
        return { smart: permissionRequired('SMART data requires DeviceIoControl access, which Windows grants only to elevated processes.', 'ata-smart') };
      }
      const result = await ctx.runner.powershellJson(
        `$ErrorActionPreference='SilentlyContinue'
$disks = Get-CimInstance -Namespace root/Microsoft/Windows/Storage -ClassName MSFT_PhysicalDisk
$out = @()
foreach ($d in $disks) {
  $out += [pscustomobject]@{
    Number = $d.DeviceId
    Model = $d.Model
    BusType = $d.BusType
    MediaType = $d.MediaType
    SmartStatus = (try { (Get-PhysicalDisk -DeviceNumber $d.DeviceId | Get-StorageReliabilityCounter -ErrorAction SilentlyContinue).Wear } catch { $null })
    Temperature = (try { (Get-PhysicalDisk -DeviceNumber $d.DeviceId | Get-StorageReliabilityCounter -ErrorAction SilentlyContinue).Temperature } catch { $null })
    PowerOnHours = (try { (Get-PhysicalDisk -DeviceNumber $d.DeviceId | Get-StorageReliabilityCounter -ErrorAction SilentlyContinue).PowerOnHours } catch { $null })
    ReadErrorsTotal = (try { (Get-PhysicalDisk -DeviceNumber $d.DeviceId | Get-StorageReliabilityCounter -ErrorAction SilentlyContinue).ReadErrorsTotal } catch { $null })
    WriteErrorsTotal = (try { (Get-PhysicalDisk -DeviceNumber $d.DeviceId | Get-StorageReliabilityCounter -ErrorAction SilentlyContinue).WriteErrorsTotal } catch { $null })
  }
}
$out`,
        { name: 'storage:smart-probe', timeoutMs: Math.max(ctx.timeoutMs, 30_000) }
      );

      if (!result.ok) {
        const cause = failureToStatus({ error: result.error, accessDenied: /access|denied|privilege/i.test(result.error ?? '') });
        return {
          smart: cause.kind === 'permission'
            ? permissionRequired(cause.reason, 'ata-smart')
            : failed(result.error ?? 'SMART reliability counters could not be read', 'ata-smart')
        };
      }

      /** @type {Record<string, import('../core/field.js').FieldValue>} */
      const fields = {};
      const rows = Array.isArray(result.data) ? result.data : [];
      rows.forEach((row, index) => {
        const number = num(row.Number) ?? index;
        const prefix = `disk${number + 1}.`;
        const wear = nonNegative(row.SmartStatus);
        if (wear !== null) {
          fields[`${prefix}wear`] = available(wear, 'ata-smart', { unit: '%', status: wear >= 80 ? Status.WARNING : Status.PASS, notes: ['From the Windows storage reliability counter, which reports wear for both SATA SSDs and NVMe drives.'] });
        }
        const temperature = nonNegative(row.Temperature);
        if (temperature !== null && temperature > 0 && temperature < 120) {
          fields[`${prefix}temperature`] = available(temperature, 'ata-smart', { unit: '°C' });
        }
        const hours = nonNegative(row.PowerOnHours);
        if (hours !== null && hours > 0) fields[`${prefix}powerOnHours`] = available(hours, 'ata-smart', { unit: 'hours' });
        const readErrors = nonNegative(row.ReadErrorsTotal);
        if (readErrors !== null) fields[`${prefix}readErrors`] = available(readErrors, 'ata-smart', { unit: 'count', status: readErrors > 0 ? Status.WARNING : Status.PASS });
        const writeErrors = nonNegative(row.WriteErrorsTotal);
        if (writeErrors !== null) fields[`${prefix}writeErrors`] = available(writeErrors, 'ata-smart', { unit: 'count', status: writeErrors > 0 ? Status.WARNING : Status.PASS });
      });

      if (Object.keys(fields).length === 0) {
        return { smart: unavailable('Windows storage reliability counters returned no usable values for any disk', 'ata-smart') };
      }
      return fields;
    }
  });

  registry.registerProvider({
    id: 'nvme-health-log',
    title: 'NVMe SMART/Health Information log (page 0x02)',
    capability: 'storage.smart',
    priority: 1,
    collect: async (ctx) => {
      if (!ctx.permissions.isAdmin) {
        return { nvmeHealth: permissionRequired('The NVMe health log is read through IOCTL_STORAGE_QUERY_PROPERTY, which Windows restricts to elevated processes.', 'nvme-health-log') };
      }
      // Windows exposes the NVMe log through PowerShell's StorageReliabilityCounter
      // and, on newer builds, through the Get-StorageReliabilityCounter numeric
      // fields. The raw log page requires a native IOCTL, which the packaged app's
      // elevated helper performs; here we read the equivalent counters.
      const result = await ctx.runner.powershellJson(
        `$ErrorActionPreference='SilentlyContinue'
$out = @()
foreach ($d in (Get-PhysicalDisk)) {
  if ($d.BusType -eq 'NVMe') {
    $c = $d | Get-StorageReliabilityCounter
    $out += [pscustomobject]@{
      Number = $d.DeviceId
      Model = $d.Model
      Wear = $c.Wear
      Temperature = $c.Temperature
      PowerOnHours = $c.PowerOnHours
      ReadErrorsCorrected = $c.ReadErrorsCorrected
      ReadErrorsUncorrected = $c.ReadErrorsUncorrected
      WriteErrorsCorrected = $c.WriteErrorsCorrected
      WriteErrorsUncorrected = $c.WriteErrorsUncorrected
      StartStopCycleCount = $c.StartStopCycleCount
    }
  }
}
$out`,
        { name: 'storage:nvme-health', timeoutMs: Math.max(ctx.timeoutMs, 30_000) }
      );

      if (!result.ok) {
        return { nvmeHealth: failed(result.error ?? 'NVMe health counters could not be read', 'nvme-health-log') };
      }

      const rows = Array.isArray(result.data) ? result.data : [];
      if (rows.length === 0) {
        return { nvmeHealth: unsupported('No NVMe drive is present, so the NVMe health log does not apply to this system.', 'nvme-health-log') };
      }

      /** @type {Record<string, import('../core/field.js').FieldValue>} */
      const fields = {};
      rows.forEach((row, index) => {
        const number = num(row.Number) ?? index;
        const prefix = `disk${number + 1}.`;
        const wear = nonNegative(row.Wear);
        if (wear !== null) {
          fields[`${prefix}percentageUsed`] = available(wear, 'nvme-health-log', { unit: '%', status: wear >= 100 ? Status.FAIL : wear >= 80 ? Status.WARNING : Status.PASS, notes: ['Wear reported by the NVMe controller through the Windows storage reliability counter.'] });
        }
        const temperature = nonNegative(row.Temperature);
        if (temperature !== null && temperature > 0 && temperature < 120) fields[`${prefix}temperature`] = available(temperature, 'nvme-health-log', { unit: '°C' });
        const hours = nonNegative(row.PowerOnHours);
        if (hours !== null && hours > 0) fields[`${prefix}powerOnHours`] = available(hours, 'nvme-health-log', { unit: 'hours' });
        const uncorrected = nonNegative(row.ReadErrorsUncorrected);
        if (uncorrected !== null) fields[`${prefix}mediaErrors`] = available(uncorrected, 'nvme-health-log', { unit: 'count', status: uncorrected > 0 ? Status.WARNING : Status.PASS });
        const corrected = nonNegative(row.ReadErrorsCorrected);
        if (corrected !== null) fields[`${prefix}correctedErrors`] = available(corrected, 'nvme-health-log', { unit: 'count', notes: ['Errors the controller corrected without data loss.'] });
      });

      return Object.keys(fields).length > 0
        ? fields
        : { nvmeHealth: unavailable('The NVMe controller returned no reliability counters on this system', 'nvme-health-log') };
    }
  });

  registry.registerTask({
    id: 'storage.health',
    module: 'storageHealth',
    title: 'Storage health (SMART / NVMe)',
    quick: false,
    providers: ['nvme-health-log', 'ata-smart'],
    requiresCapability: 'storage.smart'
  });
}

export { MEDIA_TYPE, BUS_TYPE, HEALTH_STATUS };
