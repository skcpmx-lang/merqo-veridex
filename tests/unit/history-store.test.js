/**
 * History had no tests, and that hid a defect which made the feature silently useless:
 * entries were written to disk without an id and then discarded on every load, so the
 * history file never accumulated a single run. Nothing failed, nothing warned, and the
 * only symptom was a list that stayed empty.
 *
 * The cause was a spread order: `{ id: entry.id ?? makeId(), ...entry }` lets a caller's
 * explicit `id: undefined` overwrite the generated id.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { HistoryStore, makeId } from '../../src/history/store.js';
import { compareEntries } from '../../src/history/compare.js';

async function tempFile() {
  const dir = await mkdtemp(path.join(tmpdir(), 'veridex-history-'));
  return { file: path.join(dir, 'history.json'), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const entry = (overrides = {}) => ({
  startedAt: '2026-03-01T10:00:00.000Z',
  finishedAt: '2026-03-01T10:00:02.000Z',
  assessment: { score: 91, rating: 'Good', coveragePercent: 82 },
  coverage: { fields: 15 },
  issues: { errors: [], warnings: [] },
  ...overrides
});

test('an added entry is given an id even when the caller passes id: undefined', async () => {
  const { file, cleanup } = await tempFile();
  try {
    const store = new HistoryStore({ file });
    // This exact shape is what src/app/scan.js used to pass, and it was the bug.
    const record = await store.add({ id: undefined, ...entry() });
    assert.equal(typeof record.id, 'string', 'the store must generate an id');
    assert.ok(record.id.length > 0);

    const raw = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(typeof raw.entries[0].id, 'string', 'the id must reach the file');
  } finally {
    await cleanup();
  }
});

test('history accumulates: two scans are two entries after a reload', async () => {
  const { file, cleanup } = await tempFile();
  try {
    const first = new HistoryStore({ file });
    await first.add(entry({ assessment: { score: 70, rating: 'Fair', coveragePercent: 60 } }));
    const second = new HistoryStore({ file });
    await second.load();
    await second.add(entry({ assessment: { score: 95, rating: 'Good', coveragePercent: 90 } }));

    const reloaded = new HistoryStore({ file });
    await reloaded.load();
    assert.equal(reloaded.entries.length, 2, 'both runs must survive a reload');
    assert.equal(reloaded.list().length, 2);
    // Newest first.
    assert.equal(reloaded.entries[0].assessment.score, 95);
  } finally {
    await cleanup();
  }
});

test('an entry without an id is skipped on load, but the caller is not lied to', async () => {
  const { file, cleanup } = await tempFile();
  try {
    // A file written by the buggy version, with a valid entry beside a broken one.
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        entries: [
          { id: 'VX-ok', assessment: { score: 90 }, finishedAt: '2026-03-02T00:00:00.000Z' },
          { assessment: { score: 50 }, finishedAt: '2026-03-01T00:00:00.000Z' }
        ]
      }),
      'utf8'
    );

    const warnings = [];
    const store = new HistoryStore({ file, logger: { warn: async (message, meta) => warnings.push({ message, meta }), debug: async () => {}, info: async () => {}, error: async () => {} } });
    await store.load();

    assert.equal(store.entries.length, 1, 'only addressable entries are loaded');
    assert.equal(store.entries[0].id, 'VX-ok');
    assert.ok(
      warnings.some((w) => /without an id/.test(w.message) && w.meta.dropped === 1),
      'the dropped entry must be reported, not silently discarded'
    );
  } finally {
    await cleanup();
  }
});

test('an unreadable file is quarantined rather than deleted', async () => {
  const { file, cleanup } = await tempFile();
  try {
    await writeFile(file, 'this is not json', 'utf8');
    const store = new HistoryStore({ file, logger: { warn: async () => {}, debug: async () => {}, info: async () => {}, error: async () => {} } });
    await store.load();
    assert.deepEqual(store.entries, [], 'an unreadable file yields no entries');
    assert.ok(store.corruptBackup, 'the original must be kept as a backup, not destroyed');
    assert.equal(await readFile(store.corruptBackup, 'utf8'), 'this is not json');
  } finally {
    await cleanup();
  }
});

test('retention removes the oldest entries beyond the limit', async () => {
  const { file, cleanup } = await tempFile();
  try {
    const store = new HistoryStore({ file, limit: 3 });
    for (let i = 0; i < 6; i += 1) {
      await store.add(entry({ finishedAt: `2026-03-0${i + 1}T00:00:00.000Z`, assessment: { score: 60 + i } }));
    }
    assert.equal(store.entries.length, 3, 'the limit must be enforced');
    assert.equal(store.entries[0].assessment.score, 65, 'the newest entries are the ones kept');
  } finally {
    await cleanup();
  }
});

test('a stored run can be compared with the one before it', async () => {
  const { file, cleanup } = await tempFile();
  try {
    const store = new HistoryStore({ file });
    await store.add(entry({ assessment: { score: 70, rating: 'Fair', coveragePercent: 60 }, fields: { 'cpu.name': { value: 'i5' } } }));
    const later = await store.add(entry({ assessment: { score: 90, rating: 'Good', coveragePercent: 85 }, fields: { 'cpu.name': { value: 'i7' } } }));

    const previous = store.previous(later.id);
    assert.ok(previous, 'the previous entry must be found by id');
    assert.equal(previous.assessment.score, 70);

    const diff = compareEntries(previous, later);
    assert.ok(diff.before && diff.after, 'the comparison must describe both runs');
    assert.equal(diff.summary.degraded, 0);
  } finally {
    await cleanup();
  }
});

test('ids are unique and sortable by time', () => {
  const a = makeId(new Date('2026-03-01T10:00:00.000Z'));
  const b = makeId(new Date('2026-03-01T10:00:01.000Z'));
  assert.notEqual(a, b);
  assert.match(a, /^VX-\d{14}-[A-Z0-9]{4}$/);
  assert.ok(a < b, 'an earlier run must sort before a later one');
});
