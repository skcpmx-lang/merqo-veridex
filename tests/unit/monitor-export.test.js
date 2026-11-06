/**
 * Monitoring session export (R-09-03).
 *
 * The requirement's remaining gap was "samples are shown live but cannot be exported". These
 * tests hold the file format to three promises: a missing reading stays missing instead of
 * becoming a zero, a sensor that never answered is still named, and an unsupported format is
 * refused rather than silently replaced by one that exists.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CSV_COLUMNS,
  EXPORT_LIMITS,
  flattenSnapshot,
  renderMonitorExport,
  toCsv,
  toJson
} from '../../src/monitoring/export.js';

/** Two sensors, three ticks, one missing reading, one sensor that never answered. */
function snapshot() {
  return {
    startedAt: '2026-11-06T09:00:00.000Z',
    endedAt: '2026-11-06T09:00:03.000Z',
    intervalMs: 1500,
    elevated: false,
    series: [
      {
        id: 'cpu.load',
        label: 'CPU utilisation',
        unit: '%',
        points: [
          { at: '2026-11-06T09:00:00.000Z', value: 12 },
          { at: '2026-11-06T09:00:01.500Z', value: null },
          { at: '2026-11-06T09:00:03.000Z', value: 44 }
        ]
      },
      {
        id: 'fan.speed',
        label: 'Fan speed, chassis',
        unit: 'RPM',
        points: [
          { at: '2026-11-06T09:00:00.000Z', value: null },
          { at: '2026-11-06T09:00:01.500Z', value: null },
          { at: '2026-11-06T09:00:03.000Z', value: null }
        ]
      }
    ]
  };
}

test('a missing reading is an empty cell marked unavailable, never a zero', () => {
  const csv = toCsv(snapshot());
  const lines = csv.trimEnd().split('\n');
  const headerIndex = lines.findIndex((line) => line.startsWith('timestamp,'));
  assert.equal(lines[headerIndex], CSV_COLUMNS.join(','), 'the header must be the exported constant');

  const cpuRow = lines.find((line) => line.includes('cpu.load') && line.includes('2026-11-06T09:00:01.500Z'));
  assert.ok(cpuRow, 'the missing reading must still produce a row');
  const cells = cpuRow.split(',');
  assert.equal(cells[4], '', 'a missing value must be blank, not 0');
  assert.equal(cells[5], 'no', 'the row must say the reading was unavailable');

  const answered = lines.find((line) => line.includes('cpu.load') && line.includes('09:00:00.000Z'));
  assert.equal(answered.split(',')[4], '12');
  assert.equal(answered.split(',')[5], 'yes');
});

test('a label containing a comma is quoted and does not shift the columns', () => {
  const csv = toCsv(snapshot());
  const row = csv.split('\n').find((line) => line.includes('Fan speed, chassis'));
  assert.ok(row, 'the quoted label must survive');
  assert.match(row, /"Fan speed, chassis"/);
});

test('the CSV header states where the numbers came from, including the missing-value rule', () => {
  const csv = toCsv(snapshot());
  assert.match(csv.split('\n')[0], /^# VERIDEX live monitoring, 6 readings from 2 sensors/);
  assert.match(csv, /interval 1500 ms, standard user/);
  assert.match(csv, /missing value means the sensor did not answer/);
});

test('a sensor that never answered is still named, with zero readings', () => {
  const json = JSON.parse(toJson(snapshot()));
  const fan = json.sensors.find((entry) => entry.id === 'fan.speed');
  assert.ok(fan, 'an unavailable sensor must still appear in the sensor list');
  assert.equal(fan.readings, 0);
  assert.equal(fan.unit, 'RPM');
  assert.equal(json.points.length, 6, 'every tick contributes a row for each sensor');
  assert.ok(json.points.every((point) => 'value' in point), 'a missing value is a null field, not a dropped key');
});

test('points are ordered by time so a reader does not have to sort them', () => {
  const { rows } = flattenSnapshot({
    series: [
      { id: 'b', points: [{ at: '2026-11-06T09:00:02.000Z', value: 1 }, { at: '2026-11-06T09:00:00.000Z', value: 2 }] },
      { id: 'a', points: [{ at: '2026-11-06T09:00:02.000Z', value: 3 }, { at: '2026-11-06T09:00:00.000Z', value: 4 }] }
    ]
  });
  const times = rows.map((row) => row.at);
  assert.deepEqual(times, [...times].sort(), 'rows must be chronological');
  // Within one timestamp the ids are sorted, so two exports of one session are byte-identical.
  assert.deepEqual(rows.filter((row) => row.at === '2026-11-06T09:00:00.000Z').map((row) => row.id), ['a', 'b']);
});

test('an unsupported or empty format is refused with a reason', () => {
  for (const format of ['', undefined, null, 'yaml', 'exe', 'CSV ']) {
    const result = renderMonitorExport(snapshot(), format);
    if (format === 'CSV ') {
      // Trailing space is trimmed on purpose: it is a formatting accident, not a different format.
      assert.equal(result.ok, true, 'format matching ignores surrounding whitespace');
      continue;
    }
    assert.equal(result.ok, false, `${format} must be refused`);
    assert.ok(result.reason && result.reason.length > 10, 'a refusal must explain itself');
  }
});

test('nothing sampled is refused rather than written as a header-only file', () => {
  const result = renderMonitorExport({ series: [] }, 'csv');
  assert.equal(result.ok, false);
  assert.match(result.reason, /Nothing has been sampled/);
  assert.equal(renderMonitorExport(null, 'json').ok, false);
});

test('the export reports how many readings and sensors it contains', () => {
  const result = renderMonitorExport(snapshot(), 'json');
  assert.equal(result.ok, true);
  assert.equal(result.rows, 6);
  assert.equal(result.sensors, 2);
  assert.equal(result.dropped, 0);
});

test('the row cap is enforced and reported instead of silently truncating', () => {
  const many = {
    series: [
      {
        id: 'cpu.load',
        points: Array.from({ length: EXPORT_LIMITS.maxRows + 5 }, (_, index) => ({
          at: new Date(Date.UTC(2026, 10, 6, 0, 0, 0) + index * 1000).toISOString(),
          value: index % 100
        }))
      }
    ]
  };
  const { rows, dropped } = flattenSnapshot(many);
  assert.equal(rows.length, EXPORT_LIMITS.maxRows);
  assert.equal(dropped, 5, 'the number of dropped readings must be counted');
  assert.match(toCsv(many), /5 readings were dropped/);
});
