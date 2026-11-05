/**
 * VERIDEX — Installed software inventory (MODULE 12, R-12-01).
 *
 * The uninstall registry keys are the same ones Programs and Features reads. They are the
 * only list that reflects what Windows will actually uninstall, which is why they are used
 * instead of scanning Program Files — a directory listing cannot tell an installed
 * application from a leftover folder, and cannot tell you the publisher or the uninstaller.
 *
 * Read-only, and no launch: this module never runs an uninstall string. The string is
 * reported as text because "what would be run if you chose Uninstall" is a fact a user
 * deserves to see, not something to hide.
 *
 * Volume: a normal desktop has 80–250 entries. The full list is kept for the report (it is
 * useful), but only the count, the publishers and any suspicious install dates are promoted
 * to summary fields, so the dashboard is not buried in it.
 *
 * @module
 */

import { available, unavailable, field } from '../core/field.js';
import { Status } from '../core/status.js';
import { cleanString, asArray, date } from '../platform/parse.js';
import { summariseToolOutput } from '../platform/windows.js';

/** Registry locations, in the order Programs and Features reads them. */
export const UNINSTALL_KEYS = Object.freeze([
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
]);

/**
 * Normalise one uninstall registry entry.
 *
 * Entries are skipped rather than reported blank when they have no display name: update
 * stubs and component entries live in the same keys and would otherwise inflate the count
 * with things no user would recognise as software.
 *
 * @param {object} entry
 * @returns {{name: string, version: string|null, publisher: string|null, installDate: string|null, location: string|null, uninstall: string|null, source: string}|null}
 */
export function normaliseApplication(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const name = cleanString(entry.DisplayName);
  if (!name) return null;
  // Program and Features hides these; so do we, for the same reason.
  if (entry.SystemComponent === 1 || entry.SystemComponent === '1') return null;
  if (entry.ParentKeyName && cleanString(entry.ParentKeyName)) return null;

  const install = normaliseInstallDate(entry.InstallDate);
  return {
    name: name.slice(0, 200),
    version: cleanString(entry.DisplayVersion),
    publisher: cleanString(entry.Publisher),
    installDate: install,
    location: cleanString(entry.InstallLocation),
    uninstall: cleanString(entry.UninstallString)?.slice(0, 300) ?? null,
    source: /^HKCU/i.test(String(entry.__KeyPath ?? '')) ? 'current user' : 'machine'
  };
}

/**
 * Registry install dates are `YYYYMMDD` strings, and some installers write something else.
 * @param {unknown} value
 * @returns {string|null} an ISO date, or null
 */
export function normaliseInstallDate(value) {
  const text = cleanString(value);
  if (!text) return null;
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) {
    const [, year, month, day] = compact;
    const candidate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
    if (!Number.isNaN(candidate.getTime()) && candidate.getUTCFullYear() === Number(year)) {
      return candidate.toISOString().slice(0, 10);
    }
    return null;
  }
  const parsed = date(text);
  // A date is a day, not a timestamp: the registry stores YYYYMMDD and nothing finer, and a
  // field that reads 2025-03-10T00:00:00.000Z invites a reader to think otherwise.
  return parsed ? parsed.slice(0, 10) : null;
}

/**
 * Summarise a normalised application list.
 * @param {Array<ReturnType<typeof normaliseApplication>>} applications
 * @param {{now?: Date}} [options]
 */
export function summariseApplications(applications, options = {}) {
  const now = options.now ?? new Date();
  const list = applications.filter(Boolean);
  const publishers = new Map();
  for (const application of list) {
    const publisher = application.publisher ?? 'Unknown publisher';
    publishers.set(publisher, (publishers.get(publisher) ?? 0) + 1);
  }

  const recent = list
    .filter((application) => application.installDate)
    .filter((application) => {
      const installed = new Date(application.installDate).getTime();
      return Number.isFinite(installed) && now.getTime() - installed < 30 * 24 * 60 * 60 * 1000;
    })
    .map((application) => ({ name: application.name, installDate: application.installDate }));

  return {
    total: list.length,
    withPublisher: list.filter((application) => application.publisher).length,
    withInstallDate: list.filter((application) => application.installDate).length,
    topPublishers: [...publishers.entries()]
      .map(([publisher, count]) => ({ publisher, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    installedInLast30Days: recent.slice(0, 20),
    applications: list.sort((a, b) => a.name.localeCompare(b.name))
  };
}

/**
 * Build the summary fields for the report.
 * @param {ReturnType<typeof summariseApplications>} summary
 * @param {string} source
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function describeApplications(summary, source) {
  /** @type {Record<string, import('../core/field.js').FieldValue>} */
  const fields = {
    applicationCount: available(summary.total, source, {
      notes: ['Applications registered for uninstall, from the three registry locations Windows itself reads.']
    })
  };

  if (summary.topPublishers.length > 0) {
    fields.applicationPublishers = available(
      summary.topPublishers.map((entry) => `${entry.publisher} (${entry.count})`).join(', '),
      source
    );
  }

  if (summary.installedInLast30Days.length > 0) {
    fields.applicationsRecentlyInstalled = field(
      summary.installedInLast30Days.map((entry) => `${entry.name} (${entry.installDate})`).join(', '),
      {
        source,
        notes: ['Software installed in the last 30 days. Installers are the most common source of unwanted bundled software.']
      }
    );
  }

  if (summary.withInstallDate === 0 && summary.total > 0) {
    fields.applicationInstallDates = unavailable('No installed application reported an install date', source, {
      notes: ['Many installers omit this value; its absence says nothing about the software.']
    });
  }

  return fields;
}

/**
 * Register the installed-software task.
 * @param {import('../engine/provider-registry.js').ProviderRegistry} registry
 */
export function registerSoftware(registry) {
  registry.registerProvider({
    id: 'registry.uninstall',
    title: 'Windows uninstall registry',
    priority: 1,
    timeoutMs: 45_000,
    collect: async (ctx) => {
      // One query for all three keys: three separate PowerShell starts cost three times the
      // startup, and this is the slowest part of most software inventories.
      const body = [
        `$paths = @(${UNINSTALL_KEYS.map((key) => `'${key}'`).join(', ')})`,
        '$items = @()',
        'foreach ($path in $paths) {',
        '  $items += @(Get-ItemProperty -Path $path -ErrorAction SilentlyContinue |',
        '    Select-Object DisplayName, DisplayVersion, Publisher, InstallDate, InstallLocation, UninstallString, SystemComponent, ParentKeyName, @{n=\'__KeyPath\';e={$_.PSPath}})',
        '}',
        '$items | ConvertTo-Json -Compress -Depth 3'
      ].join('\n');

      const result = await ctx.runner.powershellJson(body, { name: 'software:uninstall', timeoutMs: 40_000 });
      if (!result.ok) {
        return {
          applicationCount: unavailable(`The installed-software list could not be read${summariseToolOutput({ stdout: result.stdout, stderr: result.error ?? result.stderr })}`, 'registry.uninstall', {
            notes: ['Installed software is unverified on this machine. That is not the same as an empty machine.']
          })
        };
      }

      const summary = summariseApplications(asArray(result.data).map(normaliseApplication));
      const fields = describeApplications(summary, 'registry.uninstall');
      // The full list is the point of the page, and the report model truncates it for the
      // document. Storing it as a field keeps one code path for UI, JSON and PDF.
      fields.applications = available(summary.applications.map((application) => ({
        name: application.name,
        version: application.version,
        publisher: application.publisher,
        installDate: application.installDate
      })), 'registry.uninstall');
      return fields;
    }
  });

  registry.registerTask({
    id: 'software.installed',
    module: 'software',
    title: 'Installed applications',
    quick: false,
    providers: ['registry.uninstall'],
    validate: (fields) => {
      const count = fields.applicationCount?.value;
      if (typeof count === 'number' && count < 0) return ['the application count was negative'];
      if (typeof count === 'number' && count > 5000) return [`the application count (${count}) is implausible; the inventory may be double-counting registry views`];
      return [];
    }
  });

  // A running-services and startup-program companion: the same question ("what is running on
  // this machine that I did not ask for") asked of two more places.
  registry.registerProvider({
    id: 'powershell.startup',
    title: 'Startup entries (Run keys and startup folders)',
    priority: 1,
    timeoutMs: 30_000,
    collect: async (ctx) => {
      const body = [
        '$keys = @(',
        "  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run',",
        "  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run',",
        "  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\RunOnce',",
        "  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\RunOnce'",
        ')',
        '$entries = @()',
        'foreach ($key in $keys) {',
        '  $properties = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue',
        '  if (-not $properties) { continue }',
        '  foreach ($property in $properties.PSObject.Properties) {',
        "    if ($property.Name -like 'PS*') { continue }",
        '    $entries += [pscustomobject]@{ name = $property.Name; command = [string]$property.Value; location = $key }',
        '  }',
        '}',
        '$entries | ConvertTo-Json -Compress -Depth 3',
        'return'
      ].join('\n');

      const result = await ctx.runner.powershellJson(body, { name: 'software:startup', timeoutMs: 25_000 });
      if (!result.ok) {
        return { startupEntries: unavailable(`Startup entries could not be read${summariseToolOutput({ stdout: result.stdout, stderr: result.error ?? result.stderr })}`, 'powershell.startup') };
      }
      const entries = asArray(result.data)
        .map((entry) => ({
          name: cleanString(entry?.name)?.slice(0, 120),
          command: cleanString(entry?.command)?.slice(0, 240),
          location: cleanString(entry?.location)?.replace(/^Microsoft\.PowerShell\.Core\\Registry::/, '') ?? null
        }))
        .filter((entry) => entry.name);
      /** @type {Record<string, import('../core/field.js').FieldValue>} */
      const fields = {
        startupEntries: entries.length > 0
          ? available(entries.length, 'powershell.startup', {
            notes: ['Programs Windows starts at sign-in. Each one was added by something you installed, sometimes without asking.']
          })
          : available(0, 'powershell.startup', { notes: ['Nothing is registered to start automatically at sign-in.'] }),
        startupEntryList: entries.length > 0 ? field(entries.slice(0, 40), { source: 'powershell.startup' }) : unavailable('No startup entries are registered', 'powershell.startup'),
        startupEntryWarning: entries.some((entry) => /temp|appdata\\\\local\\\\temp/i.test(entry.command ?? ''))
          ? field('At least one entry runs from a temporary directory', {
            status: Status.WARNING,
            source: 'powershell.startup',
            notes: ['Software that launches from a temporary folder usually cannot be trusted to stay the same software between launches.']
          })
          : null
      };
    }
  });

  registry.registerTask({
    id: 'software.startup',
    module: 'software',
    title: 'Startup programs',
    quick: false,
    providers: ['powershell.startup']
  });
}
