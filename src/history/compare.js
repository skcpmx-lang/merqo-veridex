/**
 * VERIDEX — Run comparison.
 *
 * Answers the question a technician actually asks second: "has anything changed
 * since last time?" Compares two history entries field by field and classifies
 * each difference by direction and significance.
 *
 * Two rules keep this honest:
 *  - a field missing on one side is reported as `added`/`removed`, never coerced
 *    to zero (a battery that stopped reporting capacity has not "improved");
 *  - only fields whose direction is genuinely meaningful get a better/worse
 *    verdict; everything else is reported as a neutral change with the raw delta.
 */

/** Fields where a lower value is better. */
const LOWER_IS_BETTER = [
  'temperature',
  'wear',
  'cycles',
  'reallocated',
  'uncorrectable',
  'mediaerrors',
  'percentageused',
  'criticalwarning'
];

/** Fields where a higher value is better. */
const HIGHER_IS_BETTER = [
  'health',
  'score',
  'capacity',
  'fullchargecapacity',
  'freespace',
  'availablespare',
  'throughput',
  'readspeed',
  'writespeed',
  'opsper',
  'iops'
];

/**
 * @param {string} path
 * @returns {'better-when-lower'|'better-when-higher'|'neutral'}
 */
export function directionOf(path) {
  const normalised = String(path).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (LOWER_IS_BETTER.some((token) => normalised.includes(token))) return 'better-when-lower';
  if (HIGHER_IS_BETTER.some((token) => normalised.includes(token))) return 'better-when-higher';
  return 'neutral';
}

/**
 * Flatten a nested snapshot into dotted numeric/string leaves.
 * @param {unknown} snapshot
 * @param {string} [prefix]
 * @param {Record<string, unknown>} [out]
 * @returns {Record<string, unknown>}
 */
export function flatten(snapshot, prefix = '', out = {}) {
  if (snapshot === null || snapshot === undefined) return out;
  if (typeof snapshot !== 'object') {
    if (typeof snapshot === 'string' || typeof snapshot === 'number' || typeof snapshot === 'boolean') {
      if (prefix) out[prefix] = snapshot;
    }
    return out;
  }
  if (Array.isArray(snapshot)) {
    snapshot.forEach((item, index) => flatten(item, prefix ? `${prefix}[${index}]` : `[${index}]`, out));
    return out;
  }
  for (const [key, value] of Object.entries(snapshot)) {
    // Skip provenance noise — it changes every run and would drown real deltas.
    if (['collectedAt', 'source', 'confidence', 'status', 'notes', 'timestamp', 'external'].includes(key)) continue;
    flatten(value, prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

/**
 * @typedef {object} Difference
 * @property {string} path
 * @property {unknown} before
 * @property {unknown} after
 * @property {number|null} delta
 * @property {number|null} percent
 * @property {'changed'|'added'|'removed'|'identical'} kind
 * @property {'improved'|'degraded'|'neutral'|'unknown'} verdict
 * @property {string} direction
 */

/**
 * Compare two snapshots.
 * @param {object} before
 * @param {object} after
 * @param {{threshold?: number}} [options] relative threshold below which numeric changes are treated as noise
 * @returns {{differences:Difference[], summary:{changed:number, added:number, removed:number, improved:number, degraded:number, neutral:number}, top:Difference[]}}
 */
export function compareSnapshots(before, after, options = {}) {
  const threshold = options.threshold ?? 0.005; // 0.5% relative noise floor
  const a = flatten(before);
  const b = flatten(after);
  const paths = new Set([...Object.keys(a), ...Object.keys(b)]);

  /** @type {Difference[]} */
  const differences = [];
  for (const path of [...paths].sort()) {
    const hasBefore = Object.prototype.hasOwnProperty.call(a, path);
    const hasAfter = Object.prototype.hasOwnProperty.call(b, path);
    const beforeValue = hasBefore ? a[path] : null;
    const afterValue = hasAfter ? b[path] : null;
    const direction = directionOf(path);

    if (hasBefore && !hasAfter) {
      differences.push({ path, before: beforeValue, after: null, delta: null, percent: null, kind: 'removed', verdict: 'unknown', direction });
      continue;
    }
    if (!hasBefore && hasAfter) {
      differences.push({ path, before: null, after: afterValue, delta: null, percent: null, kind: 'added', verdict: 'unknown', direction });
      continue;
    }
    if (beforeValue === afterValue) {
      differences.push({ path, before: beforeValue, after: afterValue, delta: 0, percent: 0, kind: 'identical', verdict: 'neutral', direction });
      continue;
    }

    const beforeNum = typeof beforeValue === 'number' ? beforeValue : null;
    const afterNum = typeof afterValue === 'number' ? afterValue : null;

    if (beforeNum !== null && afterNum !== null) {
      const delta = afterNum - beforeNum;
      const percent = beforeNum === 0 ? null : Math.round((delta / Math.abs(beforeNum)) * 1000) / 10;
      const significant = beforeNum === 0 ? delta !== 0 : Math.abs(delta / Math.abs(beforeNum)) >= threshold;
      let verdict = 'neutral';
      if (significant) {
        if (direction === 'better-when-lower') verdict = delta < 0 ? 'improved' : 'degraded';
        else if (direction === 'better-when-higher') verdict = delta > 0 ? 'improved' : 'degraded';
        else verdict = 'neutral';
      }
      differences.push({ path, before: beforeNum, after: afterNum, delta: Math.round(delta * 1000) / 1000, percent, kind: significant ? 'changed' : 'identical', verdict, direction });
      continue;
    }

    differences.push({ path, before: beforeValue, after: afterValue, delta: null, percent: null, kind: 'changed', verdict: 'neutral', direction });
  }

  const summary = { changed: 0, added: 0, removed: 0, improved: 0, degraded: 0, neutral: 0 };
  for (const diff of differences) {
    if (diff.kind === 'changed') summary.changed += 1;
    if (diff.kind === 'added') summary.added += 1;
    if (diff.kind === 'removed') summary.removed += 1;
    if (diff.verdict === 'improved') summary.improved += 1;
    if (diff.verdict === 'degraded') summary.degraded += 1;
    if (diff.verdict === 'neutral' || diff.verdict === 'unknown') summary.neutral += 1;
  }

  // Surface the most decision-relevant changes first: degradations, then
  // improvements by magnitude, then the rest.
  const rank = { degraded: 0, improved: 1, unknown: 2, neutral: 3 };
  const top = differences
    .filter((diff) => diff.kind !== 'identical')
    .sort((left, right) => {
      const rankDiff = rank[left.verdict] - rank[right.verdict];
      if (rankDiff !== 0) return rankDiff;
      return Math.abs(right.percent ?? right.delta ?? 0) - Math.abs(left.percent ?? left.delta ?? 0);
    })
    .slice(0, 25);

  return { differences, summary, top };
}

/**
 * Compare two history entries, guarding against mismatched shapes.
 * @param {import('./store.js').HistoryEntry} before
 * @param {import('./store.js').HistoryEntry} after
 */
export function compareEntries(before, after) {
  if (!before || !after) throw new Error('compareEntries requires two history entries');
  const result = compareSnapshots(before.snapshot ?? {}, after.snapshot ?? {});
  return {
    // `summary` and `assessment` are both real: entries written before the snapshot fix carry
    // only `assessment`, and reading one shape meant every score in the comparison read as
    // unrated even when the list beside it showed the number.
    before: { id: before.id, kind: before.kind, finishedAt: before.finishedAt, score: before.summary?.overallScore ?? before.assessment?.score ?? null },
    after: { id: after.id, kind: after.kind, finishedAt: after.finishedAt, score: after.summary?.overallScore ?? after.assessment?.score ?? null },
    ...result
  };
}

/**
 * Build the compact snapshot stored with each history entry. Keeping this small
 * and stable is what makes cross-version comparisons meaningful.
 * @param {object} input
 */
export function buildSnapshot(input = {}) {
  /** @type {Record<string, unknown>} */
  const snapshot = {};
  const put = (path, value) => {
    if (value === null || value === undefined) return;
    const parts = path.split('.');
    let cursor = snapshot;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index];
      cursor[part] = cursor[part] && typeof cursor[part] === 'object' ? cursor[part] : {};
      cursor = /** @type {Record<string, unknown>} */ (cursor[part]);
    }
    cursor[parts[parts.length - 1]] = value;
  };

  for (const [key, value] of Object.entries(input)) put(key, value);
  return snapshot;
}
