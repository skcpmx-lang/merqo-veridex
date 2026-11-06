/**
 * VERIDEX — live-monitoring session export.
 *
 * R-09-03 asked for configurable sampling and exportable samples; the interval was always
 * configurable, but a monitoring session ended when the window did and nothing could leave the
 * application. This module turns one session into a file, and it is deliberately the only place
 * that decides the file's shape, because two writers of the same CSV eventually disagree.
 *
 * The format is **long**, one row per reading:
 *
 *     timestamp,sensor,label,unit,value,available
 *
 * A wide format (one column per sensor) would be smaller, and it would also silently invent a
 * value for every tick where a sensor had no reading — the row would either shift or repeat the
 * previous number. Long rows keep a missing reading missing, and `available` says which it is.
 * A sensor that never answered contributes no rows at all and appears in `sensors`, so a reader
 * can tell "not sampled" apart from "sampled as zero".
 */

/** Rows are capped so a session left running overnight cannot exhaust memory on export. */
export const EXPORT_LIMITS = Object.freeze({ maxRows: 200000, maxBytes: 24 * 1024 * 1024 });

/** The CSV header, exported so a test can assert the file against it rather than a copy. */
export const CSV_COLUMNS = Object.freeze(['timestamp', 'sensor', 'label', 'unit', 'value', 'available']);

/**
 * Quote a CSV cell.
 *
 * Numbers and ISO timestamps pass through; anything containing a comma, a quote or a newline is
 * quoted with embedded quotes doubled, which is the rule every spreadsheet implements.
 * @param {unknown} value
 */
function cell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Flatten a live-monitoring snapshot into rows.
 *
 * @param {{series?: Array<{id: string, label?: string, unit?: string, points?: Array<{at: string, value: number|null}>}>}} snapshot
 * @returns {{rows: Array<{at: string, id: string, label: string, unit: string, value: number|null}>, sensors: Array<{id: string, label: string, unit: string, readings: number}>, dropped: number}}
 */
export function flattenSnapshot(snapshot) {
  const series = Array.isArray(snapshot?.series) ? snapshot.series : [];
  /** @type {Array<{at: string, id: string, label: string, unit: string, value: number|null}>} */
  const rows = [];
  const sensors = [];
  let dropped = 0;

  for (const entry of series) {
    if (!entry?.id) continue;
    const points = Array.isArray(entry.points) ? entry.points : [];
    const readings = points.filter((point) => typeof point?.value === 'number').length;
    sensors.push({ id: entry.id, label: entry.label ?? entry.id, unit: entry.unit ?? '', readings });
    for (const point of points) {
      if (!point?.at) continue;
      if (rows.length >= EXPORT_LIMITS.maxRows) {
        dropped += 1;
        continue;
      }
      rows.push({
        at: point.at,
        id: entry.id,
        label: entry.label ?? entry.id,
        unit: entry.unit ?? '',
        // A value that is not a number is kept as null rather than coerced: `Number(undefined)`
        // is NaN, and NaN in a CSV is a number to nobody.
        value: typeof point.value === 'number' && Number.isFinite(point.value) ? point.value : null
      });
    }
  }

  rows.sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : a.at.localeCompare(b.at)));
  return { rows, sensors, dropped };
}

/**
 * Render one monitoring session as CSV.
 *
 * The comment line at the top is a `#` header rather than a spreadsheet row: it records where the
 * numbers came from, and every tool that reads CSV either skips it or shows it as a comment.
 *
 * @param {{series?: any[], startedAt?: string|null, endedAt?: string|null, intervalMs?: number|null, elevated?: boolean}} snapshot
 */
export function toCsv(snapshot = {}) {
  const { rows, sensors, dropped } = flattenSnapshot(snapshot);
  const lines = [];
  lines.push(`# VERIDEX live monitoring, ${rows.length} readings from ${sensors.length} sensors`);
  lines.push(`# started ${snapshot.startedAt ?? 'unknown'}, ended ${snapshot.endedAt ?? 'unknown'}, interval ${snapshot.intervalMs ?? 'unknown'} ms, ${snapshot.elevated ? 'elevated' : 'standard user'}`);
  lines.push('# A missing value means the sensor did not answer; it is not zero.');
  if (dropped > 0) lines.push(`# ${dropped} readings were dropped: the export limit is ${EXPORT_LIMITS.maxRows} rows`);
  lines.push(CSV_COLUMNS.join(','));
  for (const row of rows) {
    lines.push([cell(row.at), cell(row.id), cell(row.label), cell(row.unit), cell(row.value), row.value === null ? 'no' : 'yes'].join(','));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Render one monitoring session as JSON.
 *
 * `sensors` is separate from `points` on purpose: it carries the unit and the number of readings
 * per sensor, so a consumer can tell a sensor that was never sampled (0 readings) from one that
 * answered null (0 readings, but present in the series).
 *
 * @param {{series?: any[], startedAt?: string|null, endedAt?: string|null, intervalMs?: number|null, elevated?: boolean}} snapshot
 */
export function toJson(snapshot = {}) {
  const { rows, sensors, dropped } = flattenSnapshot(snapshot);
  return `${JSON.stringify(
    {
      format: 'veridex.monitoring',
      version: 1,
      startedAt: snapshot.startedAt ?? null,
      endedAt: snapshot.endedAt ?? null,
      intervalMs: snapshot.intervalMs ?? null,
      elevated: Boolean(snapshot.elevated),
      note: 'A missing value means the sensor did not answer; it is not zero.',
      sensors,
      points: rows,
      dropped
    },
    null,
    2
  )}\n`;
}

/**
 * Render a session in the requested format, or refuse with the reason.
 *
 * Refusing here rather than defaulting is the same rule the report writer follows: a caller that
 * asked for nothing must not receive a PDF, and a caller that asked for `yaml` must not receive
 * CSV that it will then try to open as something else.
 *
 * @param {{series?: any[], startedAt?: string|null, endedAt?: string|null, intervalMs?: number|null, elevated?: boolean}} snapshot
 * @param {string} format
 * @returns {{ok: boolean, format?: string, text?: string, rows?: number, sensors?: number, reason?: string}}
 */
export function renderMonitorExport(snapshot, format) {
  const normalised = typeof format === 'string' ? format.trim().toLowerCase() : '';
  if (!normalised) return { ok: false, reason: 'A format is required: csv or json.' };
  if (normalised !== 'csv' && normalised !== 'json') {
    return { ok: false, reason: `Unsupported format "${format}". Live monitoring exports as csv or json.` };
  }
  const { rows, sensors, dropped } = flattenSnapshot(snapshot);
  if (rows.length === 0 && sensors.length === 0) {
    return { ok: false, reason: 'Nothing has been sampled yet, so there is no series to export.' };
  }
  const text = normalised === 'csv' ? toCsv(snapshot) : toJson(snapshot);
  if (Buffer.byteLength(text) > EXPORT_LIMITS.maxBytes) {
    return { ok: false, reason: `The series is larger than the ${Math.round(EXPORT_LIMITS.maxBytes / (1024 * 1024))} MB export limit. Sample for a shorter time.` };
  }
  return { ok: true, format: normalised, text, rows: rows.length, sensors: sensors.length, dropped };
}
