/**
 * VERIDEX — Operating system diagnostics (MODULE 10).
 *
 * Windows edition, build, install date, activation, uptime and boot time, plus the
 * optional-feature / service / update inventory.
 *
 * Two behaviours worth stating explicitly:
 *  - Activation is read from the licensing service's own output, not inferred from
 *    the registry's partial `DigitalProductId` heuristics.
 *  - Build number is parsed into its components (major.minor.build.revision) because
 *    "22631" alone tells a technician nothing, while "Windows 11 23H2" does.
 */

import { available, unavailable, failed, field } from '../core/field.js';
import { Status } from '../core/status.js';
import { cleanString, num, nonNegative, date, asArray } from '../platform/parse.js';
import { queryCim, loadSystemInformation, runReadOnly, failureToStatus } from '../platform/windows.js';

/**
 * Translate a Windows build number into the marketing version it belongs to.
 * Bands are taken from Microsoft's published build history; anything outside them
 * returns null so no version is invented.
 * @param {unknown} build
 * @returns {{version:string, release:string}|null}
 */
export function describeBuild(build) {
  const value = num(build);
  if (value === null) return null;
  if (value >= 22000 && value < 22621) return { version: 'Windows 11', release: '21H2' };
  if (value >= 22621 && value < 22631) return { version: 'Windows 11', release: '22H2' };
  if (value >= 22631 && value < 26100) return { version: 'Windows 11', release: '23H2' };
  if (value >= 26100) return { version: 'Windows 11', release: '24H2 or later' };
  if (value >= 19041 && value <= 19045) return { version: 'Windows 10', release: '2004 – 22H2' };
  if (value >= 18362 && value < 19041) return { version: 'Windows 10', release: '1903 – 1909' };
  if (value >= 17763 && value < 18362) return { version: 'Windows 10', release: '1809' };
  if (value >= 17134 && value < 17763) return { version: 'Windows 10', release: '1803' };
  if (value >= 10240 && value < 17134) return { version: 'Windows 10', release: '1507 – 1709' };
  if (value >= 9600 && value < 10240) return { version: 'Windows 8.1', release: 'Update 1' };
  if (value >= 9200 && value < 9600) return { version: 'Windows 8', release: null };
  if (value >= 7600 && value < 7602) return { version: 'Windows 7', release: 'RTM / SP1' };
  return null;
}

/**
 * Map `Win32_OperatingSystem`.
 * @param {object} os
 * @param {Date} [now]
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function mapOperatingSystem(os, now = new Date()) {
  const source = 'cim-win32';
  if (!os || typeof os !== 'object') return { os: unavailable('Win32_OperatingSystem returned no instance', source) };

  const caption = cleanString(os.Caption);
  const build = num(os.BuildNumber);
  const version = cleanString(os.Version);
  const installDate = date(os.InstallDate);
  const bootTime = date(os.LastBootUpTime);
  const band = describeBuild(build);

  let uptimeSeconds = null;
  if (bootTime) {
    const booted = Date.parse(bootTime);
    if (!Number.isNaN(booted)) uptimeSeconds = Math.max(0, Math.floor((now.getTime() - booted) / 1000));
  }

  const totalMemoryKb = nonNegative(os.TotalVisibleMemorySize);
  const freeMemoryKb = nonNegative(os.FreePhysicalMemory);

  return {
    caption: caption ? available(caption, source) : unavailable('Windows product name not reported', source),
    version: version ? available(version, source) : unavailable('Windows version string not reported', source),
    build: build !== null ? available(build, source) : unavailable('Build number not reported', source),
    releaseBand: band ? available(`${band.version}${band.release ? ` ${band.release}` : ''}`, 'model-table', { notes: [`Derived from build number ${build} using the published Windows build history.`] }) : unavailable(`Build ${String(build)} is outside VERIDEX's documented build bands`, 'model-table'),
    architecture: cleanString(os.OSArchitecture) ? available(cleanString(os.OSArchitecture), source) : unavailable('OS architecture not reported', source),
    installDate: installDate ? available(installDate.slice(0, 10), source, { notes: ['Date Windows was installed, not the date of the most recent update.'] }) : unavailable('Install date not reported', source),
    bootTime: bootTime ? available(bootTime, source) : unavailable('Last boot time not reported', source),
    uptimeSeconds: uptimeSeconds !== null ? available(uptimeSeconds, source, { unit: 's', notes: ['Computed as now minus last boot time. Sleep/hibernate time may not be counted by Windows.'] }) : unavailable('Uptime could not be computed', source),
    totalPhysicalMemory: totalMemoryKb !== null ? available(Math.round((totalMemoryKb / 1024 / 1024) * 10) / 10, source, { unit: 'GB', notes: ['Visible to the operating system, which is lower than the installed total when integrated graphics reserve memory.'] }) : unavailable('Total memory not reported', source),
    freePhysicalMemory: freeMemoryKb !== null ? available(Math.round((freeMemoryKb / 1024 / 1024) * 10) / 10, source, { unit: 'GB' }) : unavailable('Free memory not reported', source),
    systemDrive: cleanString(os.SystemDrive) ? available(cleanString(os.SystemDrive), source) : unavailable('System drive not reported', source),
    registeredUser: cleanString(os.RegisteredUser) ? available(cleanString(os.RegisteredUser), source, { notes: ['Sensitive identifier: redacted from reports unless enabled.'] }) : unavailable('Registered user not reported', source),
    serialNumber: cleanString(os.SerialNumber) ? available(cleanString(os.SerialNumber), source, { notes: ['Windows product identifier, not the hardware serial. Redacted from reports unless enabled.'] }) : unavailable('Windows product identifier not reported', source)
  };
}

/**
 * Parse `slmgr /xpr` output for activation state.
 *
 * slmgr writes to a message box in normal use, but with a non-interactive console it
 * prints a localised line such as "Windows(R), ... edition: The machine is permanently
 * activated." Matching on the English strings only, and returning null otherwise, is
 * deliberate: guessing activation from a localised string would produce false
 * "not activated" warnings on non-English Windows.
 * @param {string} output
 * @returns {{activated:boolean|null, text:string|null}}
 */
export function parseActivation(output) {
  const text = typeof output === 'string' ? output : '';
  if (!text.trim()) return { activated: null, text: null };
  if (/permanently activated/i.test(text)) return { activated: true, text: 'Permanently activated' };
  if (/will expire|expiration|notification mode|not activated|grace period/i.test(text)) {
    const line = text.split(/\r?\n/).map((entry) => entry.trim()).filter((entry) => entry.length > 0).pop() ?? null;
    return { activated: false, text: line };
  }
  return { activated: null, text: text.trim().split(/\r?\n/).pop() ?? null };
}

/**
 * Parse `Get-WindowsOptionalFeature` rows into a compact summary.
 * @param {object[]} features
 * @returns {{enabled:string[], disabledCount:number, total:number}|null}
 */
export function summariseFeatures(features) {
  const list = asArray(features).filter((entry) => entry && typeof entry === 'object');
  if (list.length === 0) return null;
  const enabled = list.filter((feature) => String(feature.State ?? '').toLowerCase() === 'enabled').map((feature) => cleanString(feature.FeatureName)).filter(Boolean);
  return { enabled, disabledCount: list.length - enabled.length, total: list.length };
}

/**
 * Map service state from `Get-Service` rows.
 * @param {object[]} services
 * @returns {{running:number, stopped:number, total:number, automaticStopped:string[]}|null}
 */
export function summariseServices(services) {
  const list = asArray(services).filter((entry) => entry && typeof entry === 'object');
  if (list.length === 0) return null;
  const running = list.filter((service) => String(service.Status ?? '').toLowerCase() === 'running').length;
  // "Automatic but stopped" is a genuinely useful signal for a technician.
  const automaticStopped = list
    .filter((service) => String(service.Status ?? '').toLowerCase() !== 'running' && String(service.StartType ?? '').toLowerCase() === 'automatic')
    .map((service) => cleanString(service.Name))
    .filter(Boolean);
  return { running, stopped: list.length - running, total: list.length, automaticStopped };
}

/**
 * Register OS providers and task.
 * @param {import('../engine/provider-registry.js').ProviderRegistry} registry
 */
/** `Get-WindowsOptionalFeature -Online` is the slowest query in the product; bound it. */
const OPTIONAL_FEATURE_BUDGET_MS = 40_000;
/** Service and hotfix enumeration; generous, but inside the provider's own budget. */
const SERVICE_BUDGET_MS = 20_000;

export function registerWindows(registry) {
  registry.registerProvider({
    id: 'cim-win32.windows',
    title: 'Windows CIM (Win32_OperatingSystem) + licensing service',
    priority: 1,
    collect: async (ctx) => {
      const [os, activation] = await Promise.all([
        queryCim(ctx.runner, 'Win32_OperatingSystem', { name: 'os:win32', timeoutMs: ctx.timeoutMs }),
        ctx.runner.run('cscript', ['//nologo', `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\slmgr.vbs`, '/xpr'], { timeoutMs: 30_000 })
      ]);

      if (!os.ok) {
        const cause = failureToStatus(os);
        return { os: cause.kind === 'permission' ? field(null, { status: Status.PERMISSION_REQUIRED, permissionRequired: true, error: cause.reason, source: 'cim-win32.windows' }) : failed(os.error, 'cim-win32.windows') };
      }

      const fields = mapOperatingSystem(os.rows[0], new Date());
      const activationState = parseActivation(`${activation.stdout}\n${activation.stderr}`);
      fields.activation = activationState.activated === true
        ? available(activationState.text ?? 'Activated', 'cim-win32.windows')
        : activationState.activated === false
          ? field(activationState.text ?? 'Not activated', { status: Status.WARNING, source: 'cim-win32.windows', notes: ['Windows reports that the licence is not permanently activated. This limits personalisation and can disable updates.'] })
          : unavailable('The licensing service did not return a recognisable activation state', 'cim-win32.windows');

      return fields;
    }
  });

  registry.registerProvider({
    id: 'systeminformation.windows',
    title: 'systeminformation (OS identity)',
    priority: 2,
    collect: async () => {
      const loaded = await loadSystemInformation();
      if (!loaded.ok) return {};
      try {
        const osInfo = await loaded.si.osInfo();
        /** @type {Record<string, import('../core/field.js').FieldValue>} */
        const fields = {};
        const distro = cleanString(osInfo?.distro);
        if (distro) fields.caption = available(distro, 'systeminformation.windows');
        const release = cleanString(osInfo?.release);
        if (release) fields.version = available(release, 'systeminformation.windows');
        const build = cleanString(osInfo?.build);
        if (build) fields.build = available(build, 'systeminformation.windows');
        if (typeof osInfo?.uptime === 'number' && osInfo.uptime > 0) {
          fields.uptimeSeconds = available(Math.floor(osInfo.uptime), 'systeminformation.windows', { unit: 's' });
        }
        if (Object.keys(fields).length === 0) {
          return { osName: unavailable('systeminformation reported no operating-system details', 'systeminformation.windows') };
        }
        return fields;
      } catch (error) {
        return { osName: failed(error instanceof Error ? error.message : String(error), 'systeminformation.windows') };
      }
    }
  });

  registry.registerTask({
    id: 'windows.info',
    module: 'windows',
    title: 'Windows',
    quick: true,
    providers: ['cim-win32.windows', 'systeminformation.windows'],
    validate: (fields) => {
      const problems = [];
      const build = fields.build?.value;
      if (typeof build === 'number' && (build < 7600 || build > 40000)) problems.push(`build number ${build} is outside any known Windows build range`);
      const uptime = fields.uptimeSeconds?.value;
      if (typeof uptime === 'number' && uptime < 0) problems.push('uptime was negative');
      return problems;
    }
  });

  registry.registerProvider({
    id: 'system-features.windows',
    title: 'Windows servicing inventory',
    priority: 1,
    // Three separate PowerShell/CIM calls, two of which enumerate a whole subsystem. On a
    // Windows runner this is the slowest provider in the sweep: `Get-WindowsOptionalFeature
    // -Online` alone took longer than 90 s on a cold image, which took the whole task down
    // and lost the services and update data that had been ready in 3 s.
    //
    // Each sub-query now has its own budget well inside the provider's, so a slow one costs
    // its own field and nothing else. The sub-processes are killed individually, so nothing
    // is left running behind a timed-out provider.
    timeoutMs: 60_000,
    collect: async (ctx) => {
      const [features, services, updates] = await Promise.all([
        ctx.permissions.isAdmin
          ? ctx.runner.powershellJson('Get-WindowsOptionalFeature -Online | Select-Object FeatureName,State', { name: 'os:features', timeoutMs: OPTIONAL_FEATURE_BUDGET_MS })
          : Promise.resolve({ ok: false, data: null, error: 'Windows optional features require administrative rights' }),
        ctx.runner.powershellJson('Get-Service | Select-Object Name,Status,StartType', { name: 'os:services', timeoutMs: SERVICE_BUDGET_MS }),
        queryCim(ctx.runner, 'Win32_QuickFixEngineering', { name: 'os:updates', timeoutMs: SERVICE_BUDGET_MS })
      ]);

      /** @type {Record<string, import('../core/field.js').FieldValue>} */
      const fields = {};
      const featureSummary = features.ok ? summariseFeatures(features.data) : null;
      fields.windowsFeatures = featureSummary
        ? available(featureSummary.enabled, 'cim-win32.windows', { notes: [`${featureSummary.enabled.length} of ${featureSummary.total} optional features are enabled.`] })
        : ctx.permissions.isAdmin
          ? unavailable(features.error ?? 'Optional features were not returned', 'cim-win32.windows')
          : field(null, { status: Status.PERMISSION_REQUIRED, permissionRequired: true, error: 'Enumerating Windows optional features requires administrative rights.', source: 'cim-win32.windows' });

      const serviceSummary = services.ok ? summariseServices(services.data) : null;
      // A service enumeration that did not finish is an absence of data, not a fault: the
      // machine is not misconfigured because a query was slow.
      fields.servicesSummary = serviceSummary
        ? available(`${serviceSummary.running} running of ${serviceSummary.total}`, 'cim-win32.windows')
        : unavailable(services.error ?? 'Services could not be enumerated', 'cim-win32.windows');
      if (serviceSummary && serviceSummary.automaticStopped.length > 0) {
        fields.servicesNotRunning = field(serviceSummary.automaticStopped.slice(0, 40), {
          status: Status.WARNING,
          source: 'cim-win32.windows',
          notes: ['A service set to Automatic that is not running may be failing to start. Check the System event log for service-control errors.']
        });
      }

      const updateList = updates.ok
        ? updates.rows.map((row) => ({ hotfix: cleanString(row.HotFixID), installed: date(row.InstalledOn) })).filter((entry) => entry.hotfix)
        : [];
      fields.updates = updateList.length > 0
        ? available(updateList.slice(0, 40), 'cim-win32.windows', { notes: ['A partial view: cumulative updates are not always listed by this class.'] })
        : updates.ok
          ? unavailable('No updates were reported', 'cim-win32.windows')
          : unavailable(updates.error ?? 'Update history could not be queried', 'cim-win32.windows');

      return fields;
    }
  });

  registry.registerTask({
    id: 'windows.inventory',
    module: 'windowsInventory',
    title: 'Windows features, services & updates',
    quick: false,
    providers: ['system-features.windows']
  });
}
