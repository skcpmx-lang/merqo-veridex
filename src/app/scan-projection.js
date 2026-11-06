/**
 * VERIDEX — the projection the interface renders.
 *
 * A scan result (`src/app/scan.js`) is a large object: per-module fields, every provider
 * attempt, the manual session, the guard summary. The renderer needs a small, stable subset of
 * it, and it needs it to be *identical* to what the report contains — a screen that disagrees
 * with the PDF is worse than no screen, because the user cannot tell which one to believe.
 *
 * So this module is the single place that turns a scan into something presentable:
 *
 *   - **statuses come from `aggregateStatus`**, the same function the report sections use;
 *   - **coverage comes from `computeCoverage`**, the same function the PDF calls;
 *   - **field values are passed through untouched**, including their status, source, unit and
 *     notes, because a page that re-derives a status is a second implementation waiting to
 *     drift;
 *   - **attempts and the manual session are dropped**, because they name commands and
 *     human observations that the renderer has no use for.
 *
 * The projection is deliberately total: given a scan, it never throws. A page must be able to
 * render a half-finished or cancelled run, and the way to guarantee that is to make the shape
 * the same in every case.
 */

import { aggregateStatus, computeCoverage } from '../reporting/model.js';

/**
 * @typedef {object} ScanProjection
 * @property {string} startedAt
 * @property {string} finishedAt
 * @property {number} durationMs
 * @property {boolean} cancelled
 * @property {boolean} quick
 * @property {number|null} taskCount
 * @property {number|null} providersAttempted
 * @property {object|null} assessment
 * @property {object} coverage
 * @property {{warnings: string[], errors: string[], conflicts: object[]}} issues
 * @property {Record<string, {title: string, status: string, note: string|null, fields: Record<string, object>, fieldCount: number}>} modules
 */

/**
 * Project a completed scan into the shape the interface renders.
 *
 * @param {any} scan the object `runScan()` returns
 * @returns {ScanProjection|null} null when there is no scan at all
 */
export function projectScan(scan) {
  if (!scan || typeof scan !== 'object') return null;

  const moduleFields = scan.modules && typeof scan.modules === 'object' ? scan.modules : {};
  const titles = scan.sectionTitles && typeof scan.sectionTitles === 'object' ? scan.sectionTitles : {};

  /** @type {ScanProjection['modules']} */
  const modules = {};
  for (const [id, fields] of Object.entries(moduleFields)) {
    const safeFields = fields && typeof fields === 'object' ? fields : {};
    const aggregated = aggregateStatus(safeFields);
    modules[id] = {
      title: titles[id] ?? id,
      status: aggregated.status,
      note: aggregated.note ?? null,
      fields: safeFields,
      fieldCount: Object.keys(safeFields).length
    };
  }

  // The report builds its coverage from report sections; here the sections are the modules and
  // the rows are their fields, which is the same set of FieldValues the PDF counts.
  const sections = Object.values(moduleFields).map((fields) => ({ rows: Object.values(fields ?? {}) }));

  const issues = scan.issues ?? {};
  return {
    startedAt: scan.startedAt ?? null,
    finishedAt: scan.finishedAt ?? null,
    durationMs: Number.isFinite(scan.durationMs) ? scan.durationMs : 0,
    cancelled: Boolean(scan.cancelled),
    quick: Boolean(scan.quick),
    taskCount: Number.isFinite(scan.taskCount) ? scan.taskCount : null,
    providersAttempted: Number.isFinite(scan.providersAttempted) ? scan.providersAttempted : null,
    assessment: scan.assessment ?? null,
    coverage: computeCoverage(sections, []),
    issues: {
      warnings: Array.isArray(issues.warnings) ? issues.warnings.slice(0, 200) : [],
      errors: Array.isArray(issues.errors) ? issues.errors.slice(0, 200) : [],
      conflicts: Array.isArray(issues.conflicts) ? issues.conflicts.slice(0, 50) : []
    },
    modules
  };
}

/**
 * Whether a projection carries any evidence at all.
 *
 * A run can complete and produce nothing: every provider unsupported, or an empty task list.
 * That is a legitimate outcome, not an error, but it must not be presented the way a
 * successful scan is presented — "0 fields, all unrated" and "142 fields collected" are
 * different claims and the interface has to be able to tell them apart.
 *
 * @param {ScanProjection|null} projection
 */
export function projectionIsEmpty(projection) {
  if (!projection) return true;
  for (const module of Object.values(projection.modules ?? {})) {
    if ((module.fieldCount ?? 0) > 0) return false;
  }
  return true;
}
