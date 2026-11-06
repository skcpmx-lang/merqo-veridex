/**
 * VERIDEX — Windows event log, bugchecks and crash reports (MODULE 10, R-10-05).
 *
 * Three questions, all read-only:
 *
 *   What has Windows complained about recently?   System and Application logs, Level 1 and 2
 *   Has this machine blue-screened?               BugCheck (1001) and unexpected-shutdown (6008)
 *   What has crashed?                             Application Error (1000) and WER (1001)
 *
 * The counts are windows with stated start times, because "12 errors" without a period means
 * nothing. Everything here is bounded: a log with 40 000 entries is summarised, never loaded.
 *
 * Nothing is retained after the scan. Event text can contain user names, paths and document
 * names, so only the provider, the id, the level and the time are kept — never the message
 * body. Redaction policies in the report apply on top of that, but the safest place to stop a
 * leak is at collection.
 *
 * @module
 */

import { available, unavailable, field } from '../core/field.js';
import { Status } from '../core/status.js';
import { cleanString, num, date, asArray } from '../platform/parse.js';
import { summariseToolOutput } from '../platform/windows.js';

/** How far back the summary looks. Stated in the report, because a count without a window is noise. */
export const EVENT_WINDOW_DAYS = 7;

/** The event ids that mean something specific on Windows. */
export const KNOWN_EVENT_IDS = Object.freeze({
  1001: 'bugcheck or WER report',
  6008: 'unexpected shutdown',
  1000: 'application crash',
  41: 'kernel power (unexpected reboot)',
  6005: 'event log service started',
  6006: 'event log service stopped'
});

/**
 * Summarise a list of Windows event records.
 *
 * Pure. Accepts the shapes PowerShell produces for `Get-WinEvent | Select-Object ...`, which
 * vary by version: `LevelDisplayName` may be a string or a number, `TimeCreated` may be a
 * serialised date, a `/Date(...)/` wrapper or an ISO string.
 *
 * @param {object[]} records
 * @param {{now?: Date, windowDays?: number}} [options]
 * @returns {{
 *   total: number, critical: number, error: number, warning: number,
 *   byProvider: {provider: string, count: number}[],
 *   byId: {id: number|null, provider: string, count: number}[],
 *   crash: {bugchecks: number, unexpectedShutdowns: number, applicationCrashes: number, werReports: number},
 *   newest: string|null, oldest: string|null, windowDays: number
 * }}
 */
export function summariseEvents(records, options = {}) {
  const now = options.now ?? new Date();
  const windowDays = options.windowDays ?? EVENT_WINDOW_DAYS;
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;

  const mapped = asArray(records)
    .map((record) => {
      const level = normaliseLevel(record?.LevelDisplayName ?? record?.Level);
      const when = parseEventTime(record?.TimeCreated ?? record?.timeCreated);
      const id = num(record?.Id ?? record?.EventID);
      const provider = cleanString(record?.ProviderName ?? record?.providerName) ?? 'unknown';
      const recordId = num(record?.RecordId ?? record?.recordId);
      return { level, when, id, provider, recordId, logName: cleanString(record?.LogName) };
    })
    .filter((row) => row.when && new Date(row.when).getTime() >= cutoff);

  // One event must be counted once. A query that spans two logs can return the same record from
  // both when events are forwarded, and a duplicate here doubles an error count — which is the
  // difference between "2 errors this week" and "4 errors this week" in a report.
  //
  // The event log's own RecordId identifies a record within a log, so it is the key — and the
  // query asks for it for exactly this reason.
  //
  // Rows that arrive without one are counted as they arrive. A timestamp/provider/id triple
  // cannot distinguish a forwarded duplicate from two genuine events in the same second (two
  // applications crashing together look identical), and silently dropping one of those would
  // under-report crashes. Double-counting is recoverable by a reader; a lost crash is not.
  const seen = new Set();
  const rows = mapped.filter((row) => {
    if (row.recordId === null) return true;
    const key = `record:${row.recordId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const providerCounts = new Map();
  const idCounts = new Map();
  const crash = { bugchecks: 0, unexpectedShutdowns: 0, applicationCrashes: 0, werReports: 0 };

  for (const row of rows) {
    providerCounts.set(row.provider, (providerCounts.get(row.provider) ?? 0) + 1);
    if (row.id !== null) {
      const key = `${row.id}|${row.provider}`;
      idCounts.set(key, (idCounts.get(key) ?? 0) + 1);
    }
    // A bugcheck is logged as 1001 by WER-SystemErrorReporting; 1001 alone is also used by
    // other providers, so the provider decides which counter it belongs to.
    if (isBugcheck(row)) crash.bugchecks += 1;
    if (row.id === 6008) crash.unexpectedShutdowns += 1;
    if (row.id === 1000) crash.applicationCrashes += 1;
    if (isWerReport(row)) crash.werReports += 1;
  }

  const times = rows.map((row) => new Date(row.when).getTime()).sort((a, b) => a - b);

  return {
    total: rows.length,
    critical: rows.filter((row) => row.level === 'Critical').length,
    error: rows.filter((row) => row.level === 'Error').length,
    warning: rows.filter((row) => row.level === 'Warning').length,
    byProvider: [...providerCounts.entries()]
      .map(([provider, count]) => ({ provider, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    byId: [...idCounts.entries()]
      .map(([key, count]) => {
        const [id, provider] = key.split('|');
        return { id: Number(id), provider, count };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
    crash,
    newest: times.length > 0 ? new Date(times.at(-1)).toISOString() : null,
    oldest: times.length > 0 ? new Date(times[0]).toISOString() : null,
    windowDays
  };
}

/**
 * Parse the several ways Windows PowerShell writes a timestamp.
 *
 * `ConvertTo-Json` in Windows PowerShell 5.1 — which is what ships on every Windows 10 and 11
 * machine — serialises `DateTime` as `/Date(1772539200000)/`, not ISO 8601. Reading only ISO
 * silently discards every event on the platform this product targets, which is the worst
 * possible failure mode for a log summary: a clean bill of health produced by a parser.
 *
 * @param {unknown} value
 * @returns {string|null} an ISO timestamp, or null
 */
export function parseEventTime(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'number') {
    const fromNumber = new Date(value);
    return Number.isNaN(fromNumber.getTime()) ? null : fromNumber.toISOString();
  }
  const text = String(value).trim();
  const wrapped = text.match(/^\/?Date\((-?\d+)([+-]\d{4})?\)\/?$/);
  if (wrapped) {
    const parsed = new Date(Number(wrapped[1]));
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  // PowerShell 7 writes ISO 8601 with a trailing Z or an offset; `date()` covers both, and
  // also the culture-specific forms a localised machine may produce.
  return date(text);
}

/**
 * A record is a bugcheck when the system-error-reporting provider logged it.
 * @param {{id: number|null, provider: string}} row
 */
function isBugcheck(row) {
  return row.id === 1001 && /systemerrorreporting|bugcheck|blueScreen/i.test(row.provider.replace(/\s+/g, ''));
}

/**
 * A record is a WER report when the Windows Error Reporting provider logged it.
 * @param {{id: number|null, provider: string}} row
 */
function isWerReport(row) {
  return row.id === 1001 && /errorreporting|wer/i.test(row.provider) && !isBugcheck(row);
}

/**
 * Turn the numeric or textual level into the three words the rest of the app uses.
 * @param {unknown} value
 * @returns {'Critical'|'Error'|'Warning'|'Information'|'Unknown'}
 */
export function normaliseLevel(value) {
  const text = String(value ?? '').toLowerCase().trim();
  if (!text) return 'Unknown';
  if (text === '1' || text.includes('critical')) return 'Critical';
  if (text === '2' || text.includes('error')) return 'Error';
  if (text === '3' || text.includes('warn')) return 'Warning';
  if (text === '4' || text.includes('information') || text.includes('info')) return 'Information';
  return 'Unknown';
}

/**
 * Build report fields from an event summary.
 * @param {ReturnType<typeof summariseEvents>} summary
 * @param {string} source
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function describeEvents(summary, source) {
  const window = `the last ${summary.windowDays} days`;
  const notes = [`Critical and error entries from the System and Application logs, ${window}. Event message text is never collected.`];

  /** @type {Record<string, import('../core/field.js').FieldValue>} */
  const fields = {
    eventErrors: summary.error + summary.critical > 0
      ? field(`${summary.error} error${summary.error === 1 ? '' : 's'}${summary.critical > 0 ? `, ${summary.critical} critical` : ''}`, {
        // An error in the System or Application log is worth attention either way. It is a
        // warning rather than a failure because Windows logs errors for things that recovered.
        status: Status.WARNING,
        source,
        notes
      })
      : available('None', source, { notes })
  };

  if (summary.byProvider.length > 0) {
    fields.eventTopSources = field(
      summary.byProvider.slice(0, 6).map((entry) => `${entry.provider} (${entry.count})`).join(', '),
      { source, notes: ['The providers that logged the most critical and error entries.'] }
    );
  }

  if (summary.crash.bugchecks > 0 || summary.crash.unexpectedShutdowns > 0) {
    fields.crashHistory = field(
      [
        summary.crash.bugchecks > 0 ? `${summary.crash.bugchecks} bugcheck${summary.crash.bugchecks === 1 ? '' : 's'}` : null,
        summary.crash.unexpectedShutdowns > 0 ? `${summary.crash.unexpectedShutdowns} unexpected shutdown${summary.crash.unexpectedShutdowns === 1 ? '' : 's'}` : null
      ].filter(Boolean).join(', '),
      {
        status: Status.FAIL,
        source,
        notes: [
          'This machine has blue-screened or lost power without a clean shutdown in the window. That is a hardware or driver fault until proven otherwise.',
          'Memory, storage and driver findings in this report are the first places to look.'
        ]
      }
    );
  } else {
    fields.crashHistory = available('No bugchecks or unexpected shutdowns recorded', source, {
      notes: [`Nothing was logged in ${window}. Operating-system crash events are recorded reliably, so this is meaningful evidence rather than a missing field.`]
    });
  }

  fields.crashApplicationErrors = summary.crash.applicationCrashes > 0
    ? field(`${summary.crash.applicationCrashes} application crash${summary.crash.applicationCrashes === 1 ? '' : 'es'}`, {
      status: Status.WARNING,
      source,
      notes: ['Applications crashed without being handled. A single crash is usually the application; a pattern is usually the system.']
    })
    : available('None', source, { notes });

  fields.eventWindow = available(`${summary.oldest ?? '—'} → ${summary.newest ?? '—'}`, source, {
    notes: [`${summary.total} critical and error entries were retrieved for ${window}.`]
  });

  return fields;
}

/**
 * Register the event-log task.
 * @param {import('../engine/provider-registry.js').ProviderRegistry} registry
 */
export function registerEvents(registry) {
  registry.registerProvider({
    id: 'powershell.eventlog',
    title: 'Windows event log (System, Application)',
    priority: 1,
    // Two logs, levels 1 and 2, bounded by count and by time. On a machine with a large log
    // this is the difference between a second and a minute, so the filter is in the query
    // rather than in the parsing.
    timeoutMs: 60_000,
    collect: async (ctx) => {
      const query = [
        `$start = (Get-Date).AddDays(-${EVENT_WINDOW_DAYS})`,
        '$rows = @(Get-WinEvent -FilterHashtable @{ LogName = @(\'System\',\'Application\'); Level = 1,2; StartTime = $start } -MaxEvents 400 -ErrorAction SilentlyContinue |',
        '  Select-Object TimeCreated, Id, LevelDisplayName, ProviderName, LogName, RecordId)',
        // Get-WinEvent throws when there is nothing to return; an empty window is data, not a fault.
        '$rows | ConvertTo-Json -Compress -Depth 3'
      ].join('\n');

      const result = await ctx.runner.powershellJson(query, { name: 'windows:events', timeoutMs: 45_000 });

      if (!result.ok) {
        const detail = summariseToolOutput({ stdout: result.stdout, stderr: result.error ?? result.stderr });
        // "No events were found" is the most common reason this query fails, and it is a pass.
        if (/no events were found|no matching/i.test(`${result.error ?? ''}${result.stderr ?? ''}`)) {
          return describeEvents(summariseEvents([], { now: new Date() }), 'powershell.eventlog');
        }
        return { eventErrors: unavailable(`The event log could not be read${detail}`, 'powershell.eventlog', {
          notes: ['Event history is unverified on this machine. That is not the same as clean.']
        }) };
      }

      const summary = summariseEvents(result.data ?? []);
      return describeEvents(summary, 'powershell.eventlog');
    }
  });

  registry.registerTask({
    id: 'windows.events',
    module: 'events',
    title: 'Event log, bugchecks and crash history',
    quick: false,
    providers: ['powershell.eventlog'],
    validate: (fields) => {
      const window = fields.eventWindow?.value;
      if (window && typeof window === 'string' && !window.includes('→')) {
        return ['the event window should state both ends of the range'];
      }
      return [];
    }
  });
}
