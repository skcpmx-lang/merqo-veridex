/**
 * VERIDEX — Windows security posture (MODULE 10).
 *
 * Every check here is a read. Nothing in this module disables, enables or
 * reconfigures a security feature, and the module never reports a feature as
 * "off" when the real answer is "we were not allowed to ask".
 *
 * Sources, in order of preference per check:
 *   Defender       Get-MpComputerStatus   (falls back to the Defender WMI class)
 *   Firewall       Get-NetFirewallProfile
 *   BitLocker      manage-bde -status -csv (or Get-BitLockerVolume with elevation)
 *   UAC            registry EnableLUA
 *   WinRE          reagentc /info
 *   System Restore registry + vssadmin shadowstorage state
 */

import { available, unavailable, failed, field, unsupported, permissionRequired } from '../core/field.js';
import { Status } from '../core/status.js';
import { cleanString, num, bool, asArray } from '../platform/parse.js';
import { queryCim, readRegistry, runReadOnly, failureToStatus, summariseToolOutput as toolOutputClause } from '../platform/windows.js';

/**
 * Map Defender state from `Get-MpComputerStatus`.
 * @param {object|null} status
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function mapDefender(status) {
  const source = 'cim-win32';
  if (!status || typeof status !== 'object') {
    return {
      defenderAvailable: unavailable(
        'Get-MpComputerStatus returned nothing. This usually means a third-party antivirus has taken over registration from Windows Defender, which is a normal configuration and not a fault.',
        source
      )
    };
  }

  const enabled = bool(status.RealTimeProtectionEnabled);
  const antivirusEnabled = bool(status.AntivirusEnabled);
  const signatureAge = nonNegativeOrNull(status.AntivirusSignatureAge);
  const tamper = bool(status.IsTamperProtected);
  const lastScan = cleanString(status.QuickScanEndTime) ?? cleanString(status.FullScanEndTime);

  /** @type {Record<string, import('../core/field.js').FieldValue>} */
  const fields = {
    defenderAvailable: available('Windows Defender is present', source),
    defenderRealtimeProtection: enabled === true
      ? available('Enabled', source)
      : enabled === false
        ? field('Disabled', { status: Status.WARNING, source, notes: ['Real-time protection is off. This is legitimate if another antivirus is active, but should be verified.'] })
        : unavailable('Real-time protection state not reported', source),
    defenderAntivirus: antivirusEnabled === true ? available('Enabled', source) : antivirusEnabled === false ? field('Disabled', { status: Status.WARNING, source }) : unavailable('Antivirus state not reported', source),
    defenderSignatureVersion: cleanString(status.AntivirusSignatureVersion) ? available(cleanString(status.AntivirusSignatureVersion), source) : unavailable('Signature version not reported', source),
    defenderSignatureAge: signatureAge !== null
      ? available(signatureAge, source, { unit: 'days', status: signatureAge > 7 ? Status.WARNING : Status.PASS, notes: signatureAge > 7 ? ['Definitions older than a week leave the machine exposed to recent threats.'] : [] })
      : unavailable('Signature age not reported', source),
    defenderTamperProtection: tamper === true ? available('Enabled', source) : tamper === false ? field('Disabled', { status: Status.WARNING, source, notes: ['Tamper protection prevents malicious changes to Defender settings.'] }) : unavailable('Tamper protection state not reported', source),
    defenderLastScan: lastScan ? available(lastScan, source) : unavailable('No completed scan time was reported', source)
  };

  return fields;
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function nonNegativeOrNull(value) {
  const parsed = num(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

/**
 * Map firewall profile state.
 * @param {object[]} profiles
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function mapFirewall(profiles) {
  const source = 'cim-win32';
  const list = asArray(profiles).filter((profile) => profile && typeof profile === 'object');
  if (list.length === 0) {
    return { firewall: unavailable('Get-NetFirewallProfile returned no profiles', source) };
  }

  /** @type {Record<string, import('../core/field.js').FieldValue>} */
  const fields = {};
  let enabledCount = 0;
  for (const profile of list) {
    const name = cleanString(profile.Name) ?? 'Unknown';
    const enabled = bool(profile.Enabled);
    if (enabled === true) enabledCount += 1;
    fields[`firewall.${name.toLowerCase()}`] = enabled === true
      ? available('Enabled', source)
      : enabled === false
        ? field('Disabled', { status: Status.WARNING, source, notes: [`The ${name} profile is turned off, which leaves the machine exposed on that network type.`] })
        : unavailable(`${name} profile state not reported`, source);
  }

  fields.firewallSummary = enabledCount === list.length
    ? available(`All ${list.length} profiles enabled`, source)
    : field(`${enabledCount} of ${list.length} profiles enabled`, { status: Status.WARNING, source });

  return fields;
}

/**
 * Map BitLocker volume state.
 * @param {string} csvOutput  The CSV that `manage-bde -status -csv` produces.
 * @param {boolean} elevated
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function mapBitlocker(csvOutput, elevated) {
  const source = 'cim-win32';
  if (!elevated) {
    return {
      bitlocker: permissionRequired('BitLocker status is read through manage-bde, which requires administrative rights.', source)
    };
  }
  const text = typeof csvOutput === 'string' ? csvOutput.trim() : '';
  if (!text) return { bitlocker: unavailable('manage-bde returned no output', source) };

  // manage-bde emits a header row and one row per volume. Quoted CSV.
  const rows = text.split(/\r?\n/).filter((line) => line.includes(','));
  if (rows.length < 2) return { bitlocker: unavailable('manage-bde produced no volume rows', source) };

  const header = parseCsvLine(rows[0]);
  const volumes = rows.slice(1).map((line) => {
    const values = parseCsvLine(line);
    /** @type {Record<string,string>} */
    const record = {};
    header.forEach((column, index) => {
      record[column] = values[index] ?? '';
    });
    return record;
  });

  const protectionOff = volumes.filter((volume) => /protection off/i.test(volume['Protection Status'] ?? volume['Conversion Status'] ?? ''));
  const encrypted = volumes.filter((volume) => /fully encrypted/i.test(volume['Conversion Status'] ?? ''));

  return {
    bitlockerVolumeCount: available(volumes.length, source),
    bitlockerEncryptedVolumes: available(encrypted.length, source, {
      notes: encrypted.length === 0 ? ['No volume is fully encrypted. On a Windows 11 Home machine this is normal unless device encryption was enabled.'] : []
    }),
    bitlockerProtectionOff: protectionOff.length > 0
      ? field(`${protectionOff.length} volume(s) with protection suspended`, { status: Status.WARNING, source, notes: ['Protection can be suspended deliberately, but a suspended volume is not protected by encryption at rest.'] })
      : available('No volume has protection suspended', source),
    bitlockerVolumes: available(volumes.map((volume) => ({ volume: volume['Volume'] ?? 'unknown', status: volume['Conversion Status'] ?? '', protection: volume['Protection Status'] ?? '' })), source)
  };
}

/**
 * Minimal RFC-4180 line splitter sufficient for manage-bde output.
 * @param {string} line
 * @returns {string[]}
 */
export function parseCsvLine(line) {
  const out = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === ',' && !quoted) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  out.push(current.trim());
  return out;
}

/**
 * Map UAC and Windows Recovery Environment state.
 * @param {{enableLua:number|null, consentPrompt:number|null, reagentcEnabled:boolean|null, reagentcError:string|null}} input
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function mapUacAndRecovery(input) {
  const source = 'registry';
  const lua = num(input.enableLua);
  const consent = num(input.consentPrompt);

  const CONSENT_TEXT = {
    0: 'Elevate without prompting',
    1: 'Prompt for credentials on the secure desktop',
    2: 'Prompt for consent on the secure desktop',
    3: 'Prompt for credentials',
    4: 'Prompt for consent',
    5: 'Prompt for consent for non-Windows binaries'
  };

  return {
    uacEnabled: lua === 1 ? available('Enabled', source) : lua === 0 ? field('Disabled', { status: Status.WARNING, source, notes: ['User Account Control is turned off. Every process then runs with the user\'s full token without prompting, which is a significant security reduction.'] }) : unavailable('UAC state not reported', source),
    uacConsentBehaviour: consent !== null && CONSENT_TEXT[consent] ? available(CONSENT_TEXT[consent], source) : unavailable('UAC consent behaviour not reported', source),
    winreEnabled: input.reagentcEnabled === true
      ? available('Enabled', source)
      : input.reagentcEnabled === false
        ? field('Disabled', { status: Status.WARNING, source, notes: ['Windows Recovery Environment is disabled, so startup repair and reset options are unavailable.'] })
        : unavailable(input.reagentcError ?? 'Recovery Environment state could not be read', source)
  };
}

/**
 * Register security providers and task.
 * @param {import('../engine/provider-registry.js').ProviderRegistry} registry
 */
export function registerSecurity(registry) {
  registry.registerProvider({
    id: 'cim-win32.security',
    title: 'Windows security cmdlets (read-only)',
    priority: 1,
    collect: async (ctx) => {
      const [defender, firewall, enableLua, consent, reagentc] = await Promise.all([
        ctx.runner.powershellJson('Get-MpComputerStatus | Select-Object RealTimeProtectionEnabled,AntivirusEnabled,AntivirusSignatureVersion,AntivirusSignatureAge,IsTamperProtected,QuickScanEndTime,FullScanEndTime', { name: 'security:defender', timeoutMs: ctx.timeoutMs }),
        ctx.runner.powershellJson('Get-NetFirewallProfile | Select-Object Name,Enabled', { name: 'security:firewall', timeoutMs: ctx.timeoutMs }),
        readRegistry(ctx.runner, 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System', { names: ['EnableLUA', 'ConsentPromptBehaviorAdmin'], timeoutMs: ctx.timeoutMs }),
        readRegistry(ctx.runner, 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System', { names: ['ConsentPromptBehaviorAdmin'], timeoutMs: ctx.timeoutMs }),
        runReadOnly(ctx.runner, 'reagentc', ['/info'], { timeoutMs: 15_000 })
      ]);

      /** @type {Record<string, import('../core/field.js').FieldValue>} */
      const fields = {};

      if (defender.ok) {
        Object.assign(fields, mapDefender(Array.isArray(defender.data) ? defender.data[0] : defender.data));
      } else {
        Object.assign(fields, mapDefender(null));
        fields.defenderError = field(defender.error ?? 'Get-MpComputerStatus could not be queried', { status: Status.WARNING, source: 'cim-win32.security', notes: ['A third-party antivirus commonly causes this; verify with Windows Security.'] });
      }

      Object.assign(fields, mapFirewall(firewall.ok ? firewall.data : []));

      // `lua` and `consent` were referenced here but the destructured names above are
      // `enableLua` and `consent` — a ReferenceError that only surfaced once the
      // module was actually registered and run.
      const values = new Map((enableLua.values ?? []).map((entry) => [entry.name, entry.value]));
      const consentValue = new Map((consent.values ?? []).map((entry) => [entry.name, entry.value]));
      const reagentText = reagentc.ok ? reagentc.stdout : '';
      const winreEnabled = /Windows Recovery Environment.*?(Enabled|Disabled)/i.exec(reagentText)?.[1]?.toLowerCase() === 'enabled'
        ? true
        : /Windows Recovery Environment.*?Disabled/i.test(reagentText)
          ? false
          : null;

      Object.assign(fields, mapUacAndRecovery({
        enableLua: values.get('EnableLUA') !== undefined ? num(values.get('EnableLUA')) : null,
        consentPrompt: consentValue.get('ConsentPromptBehaviorAdmin') !== undefined ? num(consentValue.get('ConsentPromptBehaviorAdmin')) : null,
        reagentcEnabled: winreEnabled,
        reagentcError: reagentc.ok ? null : `reagentc /info failed (exit ${reagentc.code})`
      }));

      // BitLocker requires elevation.
      if (!ctx.permissions.isAdmin) {
        Object.assign(fields, mapBitlocker('', false));
      } else {
        const bde = await runReadOnly(ctx.runner, 'manage-bde', ['-status', '-csv'], { timeoutMs: 30_000 });
        Object.assign(fields, bde.ok
          ? mapBitlocker(bde.stdout, true)
          : { bitlocker: failed(`manage-bde exited ${bde.code}${toolOutputClause(bde)}`, 'cim-win32.security') });
      }

      return fields;
    }
  });

  registry.registerTask({
    id: 'security.posture',
    module: 'security',
    title: 'Windows security posture',
    quick: true,
    providers: ['cim-win32.security']
  });
}

export { Status };
