/**
 * VERIDEX — the logging surface (MODULE 24, R-24-03).
 *
 * `src/core/logger.js` writes the log. This module is what a user is shown of it, and what can be
 * handed to somebody helping them: filtering by level and source, a summary of what is in the
 * file, an export that is redacted again on the way out, and deletion that actually deletes.
 *
 * Two rules that shape everything here:
 *
 *   1. **A log is evidence, not a transcript.** Entries carry a timestamp, a level, a scope and a
 *      message. Context objects pass through `redact()` a second time at export, because a log
 *      written by an older build may predate a redaction rule.
 *   2. **Nothing is hidden to look tidy.** An entry the viewer cannot parse is shown as
 *      unparseable rather than dropped: a gap in a log is indistinguishable from a lie.
 *
 * The functions are pure — they take records, they return records — so the interface can be
 * tested without a file system and the export can be tested without a calendar.
 *
 * @module
 */

import { maskIdentifiers, redact } from '../core/logger.js';

export const LEVELS = Object.freeze(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

const LEVEL_WEIGHT = Object.freeze({ trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 });

/** How much of a message is kept in the viewer. A 5 kB provider error is not more useful. */
export const MAX_MESSAGE_LENGTH = 500;

/**
 * Parse a JSONL log file into records, keeping anything unparseable as a line record.
 *
 * @param {string} text
 * @returns {{records: object[], unparseable: number, lines: number}}
 */
export function parseLogText(text) {
  const lines = String(text ?? '').split('\n').filter((line) => line.trim().length > 0);
  const records = [];
  let unparseable = 0;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') records.push(parsed);
      else {
        unparseable += 1;
        records.push({ level: 'unknown', msg: String(line).slice(0, MAX_MESSAGE_LENGTH), unparseable: true, ts: null, scope: 'unknown' });
      }
    } catch {
      unparseable += 1;
      records.push({ level: 'unknown', msg: String(line).slice(0, MAX_MESSAGE_LENGTH), unparseable: true, ts: null, scope: 'unknown' });
    }
  }
  return { records, unparseable, lines: lines.length };
}

/**
 * Filter records for display.
 *
 * `minLevel` is inclusive: choosing "warn" shows warnings, errors and fatals. That is what a
 * reader means by "show me the warnings", and the opposite (only warnings) hides the errors that
 * accompany them.
 *
 * @param {object[]} records
 * @param {{minLevel?: string, scope?: string, query?: string, limit?: number}} [options]
 */
export function filterRecords(records, options = {}) {
  const minLevel = LEVELS.includes(options.minLevel) ? options.minLevel : null;
  const scope = typeof options.scope === 'string' && options.scope !== 'all' ? options.scope : null;
  const query = typeof options.query === 'string' ? options.query.trim().toLowerCase() : '';
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 200;

  const filtered = (Array.isArray(records) ? records : []).filter((record) => {
    const level = String(record?.level ?? 'info').toLowerCase();
    if (minLevel) {
      const weight = LEVEL_WEIGHT[level] ?? 0;
      if (weight < LEVEL_WEIGHT[minLevel]) return false;
    }
    if (scope && String(record?.scope ?? 'app') !== scope) return false;
    if (query) {
      const haystack = `${record?.msg ?? ''} ${record?.scope ?? ''} ${JSON.stringify(record?.ctx ?? {})}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  // Newest first: a log is read from the end.
  return filtered.slice(-limit).reverse();
}

/**
 * Summarise a log for the page header and the support bundle.
 *
 * @param {object[]} records
 * @param {{maxBytes?: number|null, fileCount?: number|null}} [options]
 */
export function summariseLog(records, options = {}) {
  const list = Array.isArray(records) ? records : [];
  const counts = Object.fromEntries(LEVELS.map((level) => [level, 0]));
  let unknown = 0;
  const scopes = new Map();
  let first = null;
  let last = null;

  for (const record of list) {
    const level = String(record?.level ?? '').toLowerCase();
    if (level in counts) counts[level] += 1;
    else unknown += 1;

    const scope = String(record?.scope ?? 'app');
    scopes.set(scope, (scopes.get(scope) ?? 0) + 1);

    const ts = typeof record?.ts === 'string' ? record.ts : null;
    if (ts) {
      if (!first || ts < first) first = ts;
      if (!last || ts > last) last = ts;
    }
  }

  return {
    entries: list.length,
    counts,
    unknown,
    scopes: [...scopes.entries()].map(([scope, count]) => ({ scope, count })).sort((a, b) => b.count - a.count).slice(0, 12),
    firstTimestamp: first,
    lastTimestamp: last,
    fileCount: Number.isFinite(options.fileCount) ? options.fileCount : null,
    totalBytes: Number.isFinite(options.maxBytes) ? options.maxBytes : null
  };
}

/**
 * Build the text a user exports for support.
 *
 * The header is written by VERIDEX and says what the file is; every record is re-redacted on the
 * way out. A log export that a user cannot hand over without reading it first is not an export,
 * it is a liability.
 *
 * @param {object[]} records
 * @param {{version?: string, platform?: string, generatedAt?: Date, includeContext?: boolean}} [options]
 */
export function buildExport(records, options = {}) {
  const generatedAt = options.generatedAt ?? new Date();
  const includeContext = options.includeContext !== false;
  const header = [
    '# VERIDEX diagnostic log export',
    `# generated: ${generatedAt.toISOString()}`,
    `# application: ${options.version ?? 'unknown version'}`,
    `# platform: ${options.platform ?? 'unknown'}`,
    '# Entries: timestamp, level, scope, message. Context objects are redacted: serial numbers,',
    '# machine names, user names, MAC addresses, tokens and keys are removed before writing.',
    '# This file contains no diagnostic results and no event-log text.'
  ];

  const lines = [...header];
  for (const record of Array.isArray(records) ? records : []) {
    const safe = {
      ts: record?.ts ?? null,
      level: record?.level ?? 'unknown',
      scope: record?.scope ?? 'app',
      // The message is masked as well as the context. A caller that put an address or an
      // account name into the message text would otherwise have it exported in clear.
      msg: String(maskIdentifiers(String(record?.msg ?? ''))).slice(0, MAX_MESSAGE_LENGTH),
      ...(includeContext && record?.ctx ? { ctx: redact(record.ctx) } : {})
    };
    lines.push(JSON.stringify(safe));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * What the retention settings mean, in the user's words.
 *
 * @param {{maxBytes?: number, maxFiles?: number, level?: string}} options
 */
export function describeRetention(options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : 2 * 1024 * 1024;
  const maxFiles = Number.isFinite(options.maxFiles) ? options.maxFiles : 5;
  const level = LEVELS.includes(options.level) ? options.level : 'info';
  const total = maxBytes * maxFiles;
  const mb = (bytes) => `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;

  return {
    level,
    maxBytes,
    maxFiles,
    totalBytes: total,
    statement: `Logs are kept on this machine only, at level "${level}". Each file is capped at ${mb(maxBytes)} and up to ${maxFiles} files are kept (${mb(total)} in total); older entries are discarded when the cap is reached. Nothing is uploaded. Deleting the logs removes them immediately.`
  };
}

/**
 * Levels that should be shown by default. `debug` and `trace` are noise for a user who is not
 * diagnosing the diagnostic tool.
 */
export const DEFAULT_LEVEL = 'info';
