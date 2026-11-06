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
    // Compare all three components, not just the year. `Date.UTC(2025, 1, 30)` is 2 March, and a
    // year-only check accepted that rollover: an impossible registry date became a plausible,
    // wrong one — the worst outcome for a value that ends up in a report beside a real date.
    const exact =
      !Number.isNaN(candidate.getTime()) &&
      candidate.getUTCFullYear() === Number(year) &&
      candidate.getUTCMonth() === Number(month) - 1 &&
      candidate.getUTCDate() === Number(day);
    return exact ? candidate.toISOString().slice(0, 10) : null;
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

  // The three uninstall keys overlap. A 64-bit machine lists some packages in both the native
  // and the WOW6432Node view, and an application installed for all users plus the current user
  // can appear twice. Two rows with the same name, version, publisher and install location are
  // one application; counting both inflates the inventory and the publisher histogram.
  const seen = new Set();
  let duplicatesRemoved = 0;
  const list = applications.filter(Boolean).filter((application) => {
    const key = [
      application.name.toLowerCase(),
      (application.version ?? '').toLowerCase(),
      (application.publisher ?? '').toLowerCase(),
      (application.location ?? '').toLowerCase()
    ].join('\u0000');
    if (seen.has(key)) {
      duplicatesRemoved += 1;
      return false;
    }
    seen.add(key);
    return true;
  });

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
    applications: list.sort((a, b) => a.name.localeCompare(b.name)),
    duplicatesRemoved
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

/** Task Scheduler's own folder for Microsoft's tasks. */
export const MICROSOFT_TASK_ROOT = /^\\Microsoft\\/i;

/**
 * Is this task something Microsoft shipped?
 *
 * Two independent signals, because neither is complete: the folder is reliable for built-in
 * tasks, but third-party installers put their tasks in the root, and the author field is
 * frequently blank on tasks created by scripting. A task counts as Microsoft's only when one
 * of the two says so, so the list a reader scans is the list they should scan.
 *
 * @param {{path?:string|null, author?:string|null}} task
 */
export function isMicrosoftTask(task) {
  if (!task) return false;
  if (task.path && MICROSOFT_TASK_ROOT.test(task.path)) return true;
  return /^(microsoft|windows)( corporation)?$/i.test(String(task.author ?? '').trim());
}

/**
 * Normalise one scheduled task.
 *
 * The action is reported, not judged: it is the text Windows would run at the trigger, and
 * hiding it would leave the user with a list of names and no way to see what any of them do.
 *
 * @param {object} entry
 * @returns {{name:string, path:string|null, state:string|null, author:string|null, action:string|null, disabled:boolean}|null}
 */
export function normaliseScheduledTask(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const name = cleanString(entry.name ?? entry.TaskName);
  if (!name) return null;
  return {
    name: name.slice(0, 160),
    path: cleanString(entry.path)?.slice(0, 160) ?? null,
    state: cleanString(entry.state) ?? null,
    author: cleanString(entry.author)?.slice(0, 120) ?? null,
    action: cleanString(entry.action)?.slice(0, 240) || null,
    disabled: entry.disabled === true || String(entry.state ?? '').toLowerCase() === 'disabled'
  };
}

/**
 * Summarise the task list.
 *
 * "Running" counts a task executing right now, which is a smaller and different number from
 * "ready": a task in Ready state has armed triggers, and reading that as activity would
 * overstate what the machine is doing.
 *
 * @param {object[]} items
 */
export function summariseScheduledTasks(items) {
  const tasks = asArray(items).map(normaliseScheduledTask).filter(Boolean);
  const thirdParty = tasks.filter((task) => !isMicrosoftTask(task));
  return {
    total: tasks.length,
    nonMicrosoft: thirdParty,
    disabled: tasks.filter((task) => task.disabled).length,
    running: tasks.filter((task) => String(task.state ?? '').toLowerCase() === 'running').length,
    temporary: thirdParty.filter((task) => /appdata\\local\\temp|\\temp\\/i.test(task.action ?? ''))
  };
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
      // Each path is read in its own try/catch so a hive the process cannot open is *reported*
      // rather than skipped. With -ErrorAction SilentlyContinue a denied key produced a smaller,
      // cheerful inventory and no indication that a third of the machine had not been read.
      const body = [
        `$paths = @(${UNINSTALL_KEYS.map((key) => `'${key}'`).join(', ')})`,
        '$items = @()',
        '$failures = @()',
        'foreach ($path in $paths) {',
        '  try {',
        '    $items += @(Get-ItemProperty -Path $path -ErrorAction Stop |',
        '      Select-Object DisplayName, DisplayVersion, Publisher, InstallDate, InstallLocation, UninstallString, SystemComponent, ParentKeyName, @{n=\'__KeyPath\';e={$_.PSPath}})',
        '  } catch { $failures += $path }',
        '}',
        '[pscustomobject]@{ items = @($items); failures = @($failures) } | ConvertTo-Json -Compress -Depth 4'
      ].join('\n');

      const result = await ctx.runner.powershellJson(body, { name: 'software:uninstall', timeoutMs: 40_000 });
      if (!result.ok) {
        return {
          applicationCount: unavailable(`The installed-software list could not be read${summariseToolOutput({ stdout: result.stdout, stderr: result.error ?? result.stderr })}`, 'registry.uninstall', {
            notes: ['Installed software is unverified on this machine. That is not the same as an empty machine.']
          })
        };
      }

      // Two shapes are accepted: the current `{ items, failures }` object and the plain array an
      // older build returned. The renderer and the report only ever see the fields built below.
      const payload = result.data && !Array.isArray(result.data) && Array.isArray(result.data.items) ? result.data : { items: asArray(result.data), failures: [] };
      const summary = summariseApplications(asArray(payload.items).map(normaliseApplication));
      const fields = describeApplications(summary, 'registry.uninstall');

      const unread = asArray(payload.failures).filter(Boolean);
      if (unread.length > 0) {
        fields.applicationHivesUnread = unavailable(
          `${unread.length} of ${UNINSTALL_KEYS.length} registry locations could not be read`,
          'registry.uninstall',
          {
            notes: [
              'The installed-software list below is incomplete: it is what could be read, not everything installed.',
              ...unread.slice(0, 3).map((path) => `Could not read ${String(path).slice(0, 120)}`)
            ]
          }
        );
      }
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
        '# The same list Windows appends to the Run keys: shortcuts dropped in the Startup folders.',
        '# They were missing while the provider title claimed to read them, so a start-up program',
        '# added the way Windows itself suggests - drop a shortcut here - was invisible to a review.',
        '$folders = @(',
        "  [pscustomobject]@{ path = [Environment]::GetFolderPath('Startup'); label = 'Startup folder (user)' },",
        "  [pscustomobject]@{ path = [Environment]::GetFolderPath('CommonStartup'); label = 'Startup folder (all users)' }",
        ')',
        'foreach ($folder in $folders) {',
        '  if (-not $folder.path) { continue }',
        '  try {',
        '    $files = @(Get-ChildItem -LiteralPath $folder.path -File -ErrorAction Stop |',
        "      Where-Object { $_.Extension -in '.lnk', '.url', '.exe', '.bat', '.cmd' })",
        '  } catch { continue }',
        '  foreach ($file in $files) {',
        '    $entries += [pscustomobject]@{ name = $file.BaseName; command = $file.FullName; location = $folder.label }',
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
      };
      if (entries.some((entry) => /temp|appdata\\\\local\\\\temp/i.test(entry.command ?? ''))) {
        fields.startupEntryWarning = field('At least one entry runs from a temporary directory', {
          status: Status.WARNING,
          source: 'powershell.startup',
          notes: ['Software that launches from a temporary folder usually cannot be trusted to stay the same software between launches.']
        });
      }
      // Returning the fields is the whole job of a provider. This one built them and dropped
      // them: the startup task reported an empty object, which reads to the engine as "no data"
      // and to the user as "nothing starts automatically".
      return fields;
    }
  });

  registry.registerTask({
    id: 'software.startup',
    module: 'software',
    title: 'Startup programs',
    quick: false,
    providers: ['powershell.startup']
  });

  // Scheduled tasks are the third place Windows starts software from, and the one a security
  // review cares about most: an installer can register a task that runs as SYSTEM at every
  // logon and never appears in either the Run keys or the Startup folders.
  registry.registerProvider({
    id: 'powershell.scheduledTasks',
    title: 'Scheduled tasks',
    priority: 2,
    timeoutMs: 45_000,
    collect: async (ctx) => {
      // `Get-ScheduledTask` needs the ScheduledTasks module, which is present on Windows 8 and
      // later but can be disabled or removed on a stripped image. `schtasks` is the older
      // interface and is always there; it cannot report the author or the action in a form that
      // survives translation, so the fallback says so instead of inventing those two fields.
      const body = [
        '$items = @()',
        '$source = "scheduledtasks"',
        '$failure = $null',
        'try {',
        '  $items = @(Get-ScheduledTask -ErrorAction Stop | ForEach-Object {',
        '    $task = $_',
        '    $actions = @($task.Actions | ForEach-Object { (([string]$_.Execute) + " " + ([string]$_.Arguments)).Trim() })',
        '    [pscustomobject]@{',
        '      name = [string]$task.TaskName',
        '      path = [string]$task.TaskPath',
        '      state = [string]$task.State',
        '      author = [string]$task.Author',
        '      action = ($actions -join "; ")',
        '      disabled = [bool]($null -ne $task.Settings -and $task.Settings.Enabled -eq $false)',
        '    }',
        '  })',
        '} catch {',
        '  $failure = $_.Exception.Message',
        '  $source = "schtasks"',
        '  try {',
        '    $items = @(schtasks.exe /query /fo csv /nh 2>$null | ForEach-Object {',
        '      $columns = @($_ -split \'","\')',
        '      if ($columns.Count -lt 3) { return }',
        '      [pscustomobject]@{',
        '        name = ($columns[0] -replace \'^"\', \'\')',
        '        path = ""',
        '        state = ($columns[2] -replace \'"$\', \'\')',
        '        author = ""',
        '        action = ""',
        '        disabled = $false',
        '      }',
        '    } | Where-Object { $_.name -and $_.name -ne "TaskName" -and $_.name -ne "Folder: " })',
        '  } catch { $items = @() }',
        '}',
        '[pscustomobject]@{ items = @($items); source = $source; failure = $failure }'
      ].join('\n');

      const result = await ctx.runner.powershellJson(body, { name: 'software:scheduledTasks', timeoutMs: 40_000 });
      if (!result.ok) {
        return {
          scheduledTaskCount: unavailable(`Scheduled tasks could not be read${summariseToolOutput({ stdout: result.stdout, stderr: result.error ?? result.stderr })}`, 'powershell.scheduledTasks', {
            notes: ['An unread task list is not an empty task list. Treat scheduled tasks as unknown on this machine.']
          })
        };
      }

      // `powershellJson` always hands back an array, so the summary object is its first element.
      const first = Array.isArray(result.data) ? result.data[0] : result.data;
      const payload = first && typeof first === 'object' && Array.isArray(first.items)
        ? first
        : { items: asArray(result.data), source: 'scheduledtasks', failure: null };
      const items = asArray(payload.items);
      // An empty list from a query that threw is an absence of data, and reporting "0 tasks"
      // would be a clean bill of health for a machine that was never read.
      if (items.length === 0 && payload.failure) {
        return {
          scheduledTaskCount: unavailable(`The task list could not be read: ${String(payload.failure).slice(0, 200)}`, 'powershell.scheduledTasks', {
            notes: ['An unread task list is not an empty task list. Treat scheduled tasks as unknown on this machine.']
          })
        };
      }

      const summary = summariseScheduledTasks(items);
      /** @type {Record<string, import('../core/field.js').FieldValue>} */
      const fields = {
        scheduledTaskCount: available(summary.total, 'powershell.scheduledTasks', {
          notes: [
            `${summary.nonMicrosoft.length} of ${summary.total} tasks are not published by Microsoft.`,
            payload.source === 'schtasks'
              ? 'Read through `schtasks`, because `Get-ScheduledTask` was unavailable; the author and the action are not reported by that interface.'
              : 'A task whose triggers are armed is counted here; the count is inventory, not activity.'
          ]
        }),
        scheduledTaskStates: available(`${summary.running} running, ${summary.disabled} disabled of ${summary.total}`, 'powershell.scheduledTasks')
      };

      fields.scheduledTaskList = summary.nonMicrosoft.length > 0
        ? available(summary.nonMicrosoft.slice(0, 40).map((task) => ({
          name: task.name,
          folder: task.path || null,
          state: task.state,
          action: task.action
        })), 'powershell.scheduledTasks', {
          notes: [`The first ${Math.min(40, summary.nonMicrosoft.length)} non-Microsoft tasks, in the order Windows returned them.`]
        })
        : available([], 'powershell.scheduledTasks', {
          notes: ['Every task on this machine is published by Microsoft, or the machine has no tasks at all.']
        });

      if (summary.temporary.length > 0) {
        fields.scheduledTaskWarning = field(summary.temporary.map((task) => task.name).slice(0, 10), {
          status: Status.WARNING,
          source: 'powershell.scheduledTasks',
          notes: ['At least one non-Microsoft task runs its action from a temporary folder. Software that runs from %TEMP% usually cannot be trusted to stay the same software between runs.']
        });
      }

      return fields;
    }
  });

  registry.registerTask({
    id: 'software.scheduledTasks',
    module: 'software',
    title: 'Scheduled tasks',
    quick: false,
    providers: ['powershell.scheduledTasks'],
    validate: (fields) => {
      const count = fields.scheduledTaskCount?.value;
      if (typeof count === 'number' && count < 0) return ['the scheduled-task count was negative'];
      if (typeof count === 'number' && count > 20000) return [`the scheduled-task count (${count}) is implausible; the query may have counted the same task once per trigger`];
      return [];
    }
  });
}
