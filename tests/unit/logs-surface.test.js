/**
 * The logging surface.
 *
 * The logger itself was already tested where it lives. What is new here is the part a user sees:
 * filtering by level (inclusive, so "warn" does not hide errors), a summary that counts what is
 * really in the file, an export that re-redacts, and retention text that states a real size.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseLogText, filterRecords, summariseLog, buildExport, describeRetention, LEVELS, MAX_MESSAGE_LENGTH } from '../../src/app/logs.js';

const record = (level, msg, ctx = {}, scope = 'app', ts = '2026-03-04T09:00:00.000Z') => ({ ts, level, scope, msg, ...(Object.keys(ctx).length ? { ctx } : {}) });

const SAMPLE = [
  record('info', 'application started'),
  record('warn', 'provider failed', { provider: 'cim-win32.bios', error: 'timeout' }, 'provider'),
  record('error', 'scan failed', { task: 'storage.health' }),
  record('debug', 'provider ok', { provider: 'cim-win32.cpu' }, 'provider'),
  record('fatal', 'unhandled rejection')
];

// ── Parsing ────────────────────────────────────────────────────────────────

test('a log file parses line by line, and a corrupt line is shown rather than dropped', () => {
  const text = [
    JSON.stringify(record('info', 'one')),
    'this is not json',
    JSON.stringify(record('error', 'two')),
    ''
  ].join('\n');

  const parsed = parseLogText(text);
  assert.equal(parsed.lines, 3);
  assert.equal(parsed.records.length, 3);
  assert.equal(parsed.unparseable, 1);
  const broken = parsed.records.find((entry) => entry.unparseable);
  assert.ok(broken, 'the unparseable line must still be visible');
  assert.match(broken.msg, /not json/);
  assert.equal(broken.level, 'unknown');
});

test('an empty or missing log is empty, not an error', () => {
  for (const input of ['', null, undefined, '\n\n\n']) {
    const parsed = parseLogText(input);
    assert.deepEqual(parsed.records, []);
    assert.equal(parsed.unparseable, 0);
  }
});

// ── Filtering ──────────────────────────────────────────────────────────────

test('the level filter is inclusive and anything above it is shown too', () => {
  const warned = filterRecords(SAMPLE, { minLevel: 'warn' });
  const levels = warned.map((entry) => entry.level).sort();
  assert.deepEqual(levels, ['error', 'fatal', 'warn'], 'choosing warnings must not hide the errors beside them');
  assert.ok(!levels.includes('debug'));
});

test('records come back newest first, which is how a log is read', () => {
  const ordered = filterRecords(
    [
      record('info', 'oldest', {}, 'app', '2026-03-04T09:00:00.000Z'),
      record('info', 'middle', {}, 'app', '2026-03-04T09:05:00.000Z'),
      record('info', 'newest', {}, 'app', '2026-03-04T09:10:00.000Z')
    ],
    {}
  );
  assert.deepEqual(ordered.map((entry) => entry.msg), ['newest', 'middle', 'oldest']);
});

test('scope and free-text filters narrow without emptying the result for the wrong reason', () => {
  assert.deepEqual(filterRecords(SAMPLE, { scope: 'provider' }).map((entry) => entry.msg), ['provider ok', 'provider failed']);
  assert.deepEqual(filterRecords(SAMPLE, { query: 'storage' }).map((entry) => entry.msg), ['scan failed']);
  assert.deepEqual(filterRecords(SAMPLE, { query: 'CI M-WIN' }).map((entry) => entry.msg), [], 'a query that matches nothing returns nothing');
  assert.equal(filterRecords(SAMPLE, { limit: 2 }).length, 2);
  assert.equal(filterRecords(SAMPLE, {}).length, SAMPLE.length);
});

test('a filter that matches nothing is distinguishable from an empty log', () => {
  const emptyLog = filterRecords([], { minLevel: 'error' });
  const noMatch = filterRecords(SAMPLE, { query: 'nothing-matches-this' });
  assert.deepEqual(emptyLog, []);
  assert.deepEqual(noMatch, []);
  // The page distinguishes them by asking for the summary, which counts the file rather than the filter.
  assert.equal(summariseLog(SAMPLE).entries, SAMPLE.length);
});

// ── Summary ────────────────────────────────────────────────────────────────

test('the summary counts every level and names the sources', () => {
  const summary = summariseLog(SAMPLE);
  assert.equal(summary.entries, 5);
  assert.equal(summary.counts.info, 1);
  assert.equal(summary.counts.warn, 1);
  assert.equal(summary.counts.error, 1);
  assert.equal(summary.counts.fatal, 1);
  assert.equal(summary.counts.debug, 1);
  assert.equal(summary.unknown, 0);
  assert.ok(summary.scopes.some((entry) => entry.scope === 'provider' && entry.count === 2));
  assert.equal(summary.firstTimestamp, '2026-03-04T09:00:00.000Z');
  assert.equal(summary.lastTimestamp, '2026-03-04T09:00:00.000Z');
});

test('entries with no level or timestamp are counted as unknown, not guessed at', () => {
  const summary = summariseLog([{ msg: 'bare' }, { ts: '2026-03-04T10:00:00.000Z', level: 'shout', msg: 'odd level' }]);
  assert.equal(summary.unknown, 2);
  assert.equal(summary.lastTimestamp, '2026-03-04T10:00:00.000Z');
});

// ── Export ─────────────────────────────────────────────────────────────────

test('an export is redacted again on the way out', () => {
  const text = buildExport(
    [
      record('warn', 'device', { serial: 'SN-123456', mac: 'AA:BB:CC:DD:EE:FF', provider: 'cim-win32.bios', computername: 'DESK-01' }),
      record('info', 'plain', { task: 'cpu.info' })
    ],
    { version: '1.0.0', platform: 'win32', generatedAt: new Date('2026-03-04T12:00:00.000Z') }
  );

  assert.ok(!text.includes('SN-123456'), 'a serial number must not reach an export');
  assert.ok(!text.includes('AA:BB:CC:DD:EE:FF'), 'a MAC address must not reach an export');
  assert.ok(!text.includes('DESK-01'), 'a machine name must not reach an export');
  assert.match(text, /\[redacted\]/);
  assert.match(text, /cpu\.info/, 'ordinary context is kept, or the export is useless');

  const lines = text.split('\n');
  const headerLines = lines.filter((line) => line.startsWith('#'));
  const recordLines = lines.filter((line) => line.startsWith('{'));
  assert.ok(headerLines.length >= 5, 'the header must say what the file is');
  assert.match(headerLines[0], /VERIDEX diagnostic log export/);
  assert.equal(recordLines.length, 2, 'both records must be present');
  assert.ok(JSON.parse(recordLines[0]).ts, 'records follow the header as JSON');
});

test('an export says what it does not contain', () => {
  const text = buildExport([], { version: '1.0.0' });
  assert.match(text, /no diagnostic results/i);
  assert.match(text, /no event-log text/i);
});

test('a message longer than the viewer limit is truncated on export, not silently dropped', () => {
  const text = buildExport([record('error', 'x'.repeat(MAX_MESSAGE_LENGTH + 200))], {});
  const body = text.split('\n').filter((line) => line.startsWith('{'));
  assert.equal(body.length, 1);
  assert.equal(JSON.parse(body[0]).msg.length, MAX_MESSAGE_LENGTH);
});

// ── Retention ──────────────────────────────────────────────────────────────

test('retention is stated in real numbers, including the total', () => {
  const described = describeRetention({ maxBytes: 2 * 1024 * 1024, maxFiles: 5, level: 'info' });
  assert.equal(described.totalBytes, 10 * 1024 * 1024);
  assert.match(described.statement, /2 MB/);
  assert.match(described.statement, /5 files/);
  assert.match(described.statement, /10 MB in total/);
  assert.match(described.statement, /nothing is uploaded/i);
  assert.match(described.statement, /Deleting the logs removes them immediately/i);
});

test('retention defaults are stated rather than left blank', () => {
  const described = describeRetention({});
  assert.equal(described.level, 'info');
  assert.ok(described.statement.length > 60);
  assert.ok(LEVELS.includes(described.level));
});
