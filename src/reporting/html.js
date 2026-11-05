/**
 * VERIDEX — HTML renderer.
 *
 * A single self-contained file: inline CSS, no scripts, no external fonts, no
 * network requests. That matters for three reasons — it opens offline, it prints
 * predictably to PDF, and a technician can email it without leaking a viewer's
 * request to a third party.
 *
 * The layout is deliberately print-first: A4 page rules, a running header on every
 * printed page, and status conveyed by both colour and a text label so a
 * black-and-white printout is still readable.
 */

import { formatValue } from './model.js';
import { statusLabel, statusTone } from '../core/status.js';

/** Escape for HTML text and attribute contexts. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Design tokens shared with the app, inlined because the report must stand alone. */
const TONES = {
  ok: '#1f9d6b',
  warn: '#c8891f',
  bad: '#c9403f',
  muted: '#7b8794'
};

/**
 * Render a status pill. The text label is always present, so the report survives
 * greyscale printing and colour-blind readers.
 * @param {string} status
 */
export function statusPill(status) {
  const tone = TONES[statusTone(status)] ?? TONES.muted;
  return `<span class="pill" style="--tone:${tone}">${escapeHtml(statusLabel(status))}</span>`;
}

/**
 * Render the report as a standalone HTML document.
 * @param {object} report
 * @param {{certificateHtml?: string}} [options]
 * @returns {string}
 */
export function renderHtml(report, options = {}) {
  const meta = report.meta;
  const assessment = report.assessment;

  const componentCards = assessment
    ? assessment.components
        .map(
          (component) => `
        <div class="card">
          <div class="card-head">
            <span class="card-title">${escapeHtml(component.label)}</span>
            ${statusPill(component.status)}
          </div>
          <div class="score">${component.score === null ? '<span class="unrated">Unrated</span>' : `${component.score}<small>/100</small>`}</div>
          <div class="rating">${escapeHtml(component.rating)}</div>
          ${
            component.missing.length > 0
              ? `<p class="missing">Not scored: ${escapeHtml(component.missing.join('; '))}</p>`
              : `<p class="evidence">${escapeHtml(component.explanation)}</p>`
          }
        </div>`
        )
        .join('')
    : '';

  const sectionHtml = report.sections
    .map(
      (section) => `
      <section class="section">
        <h2>${escapeHtml(section.title)} ${statusPill(section.status)}</h2>
        ${section.note ? `<p class="section-note">${escapeHtml(section.note)}</p>` : ''}
        <table>
          <thead>
            <tr><th>Field</th><th>Value</th><th>Status</th><th>Source</th><th>Confidence</th></tr>
          </thead>
          <tbody>
            ${section.rows
              .map(
                (row) => `
              <tr class="row-${escapeHtml(statusTone(row.status))}">
                <td class="field">${escapeHtml(row.label)}</td>
                <td class="value">${escapeHtml(formatValue(row.value, row.unit)) || '<span class="dash">—</span>'}${
                  row.error ? `<div class="detail">${escapeHtml(row.error)}</div>` : ''
                }${row.notes.length ? `<div class="detail">${escapeHtml(row.notes.join(' '))}</div>` : ''}</td>
                <td>${statusPill(row.status)}</td>
                <td class="source">${escapeHtml(row.source ?? '—')}</td>
                <td class="source">${escapeHtml(row.confidence)}</td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </section>`
    )
    .join('');

  const manualHtml = report.manualResults.length
    ? `
    <section class="section manual">
      <h2>Manual inspection results <span class="hint">recorded by the person performing the inspection</span></h2>
      <table>
        <thead><tr><th>Test</th><th>Result</th><th>Observed at</th><th>Notes</th></tr></thead>
        <tbody>
          ${report.manualResults
            .map(
              (result) => `<tr><td class="field">${escapeHtml(result.title)}</td><td>${statusPill(result.status)}</td><td class="source">${escapeHtml(result.observedAt)}</td><td class="detail">${escapeHtml(result.notes.join(' '))}</td></tr>`
            )
            .join('')}
        </tbody>
      </table>
      <p class="disclaimer">These results describe what a human observed. Software cannot detect dead pixels, backlight bleed, speaker distortion or physical port function, so these findings depend on the inspector's judgement.</p>
    </section>`
    : '';

  const issuesHtml =
    report.issues.warnings.length > 0 || report.issues.errors.length > 0 || report.issues.conflicts.length > 0
      ? `
    <section class="section issues">
      <h2>Warnings, errors and conflicting readings</h2>
      ${report.issues.warnings.length ? `<h3>Warnings</h3><ul>${report.issues.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}</ul>` : ''}
      ${report.issues.errors.length ? `<h3>Errors</h3><ul>${report.issues.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join('')}</ul>` : ''}
      ${report.issues.conflicts.length ? `<h3>Conflicting provider readings</h3><ul>${report.issues.conflicts.map((conflict) => `<li>${escapeHtml(conflict)}</li>`).join('')}</ul>` : ''}
    </section>`
      : '';

  const privacy = report.privacy ?? null;
  const privacyHtml = !privacy
    ? ''
    : `<section class="section privacy">
  <h2>Privacy and data handling</h2>
  <p>${escapeHtml(privacy.statement)}</p>
  ${
    privacy.categories.length
      ? `<table class="fields"><tbody>${privacy.categories
          .map(
            (category) =>
              `<tr><td class="label">${escapeHtml(category.label)}</td><td class="value">${category.count} field(s) withheld<span class="src">${escapeHtml(category.keys.join(', '))}</span></td></tr>`
          )
          .join('')}</tbody></table>`
      : ''
  }
  ${
    privacy.guard
      ? `<p>Network access: ${privacy.guard.networkAccessEnabled ? 'enabled' : 'disabled'}. ${escapeHtml(privacy.guard.statement)}</p>`
      : ''
  }
  <p class="disclaimer">This report was generated offline. No diagnostic data was transmitted from the device it describes.</p>
</section>`;

  const providerHtml = report.providerLog.length
    ? `
    <section class="section providers">
      <h2>Data sources attempted</h2>
      <table>
        <thead><tr><th>Task</th><th>Provider</th><th>Result</th><th>Detail</th></tr></thead>
        <tbody>
          ${report.providerLog
            .map(
              (entry) => `<tr><td class="field">${escapeHtml(entry.task)}</td><td>${escapeHtml(entry.provider)}</td><td>${entry.ok ? statusPill('PASS') : statusPill('UNAVAILABLE')}</td><td class="detail">${escapeHtml(entry.error ?? '')}</td></tr>`
            )
            .join('')}
        </tbody>
      </table>
    </section>`
    : '';

  const coverage = report.coverage;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VERIDEX report ${escapeHtml(meta.reportId)}</title>
<style>
  :root {
    --ink: #10151c;
    --ink-soft: #4a5563;
    --line: #d6dde5;
    --line-soft: #e8edf2;
    --bg: #ffffff;
    --bg-soft: #f6f8fa;
    --accent: #12456b;
    --ok: ${TONES.ok};
    --warn: ${TONES.warn};
    --bad: ${TONES.bad};
    --muted: ${TONES.muted};
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 28px 34px 48px;
    background: var(--bg);
    color: var(--ink);
    font-family: "Segoe UI", -apple-system, "Helvetica Neue", Arial, sans-serif;
    font-size: 12.5px;
    line-height: 1.5;
  }
  header.masthead {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 24px;
    padding-bottom: 18px;
    border-bottom: 2px solid var(--accent);
    margin-bottom: 22px;
  }
  .brand { font-size: 26px; font-weight: 700; letter-spacing: 0.14em; color: var(--accent); }
  .brand small { display: block; font-size: 10.5px; letter-spacing: 0.22em; font-weight: 600; color: var(--ink-soft); margin-top: 4px; }
  .meta-table { border-collapse: collapse; font-size: 11.5px; }
  .meta-table td { padding: 1px 0 1px 12px; }
  .meta-table td.label { color: var(--ink-soft); text-align: right; }
  .meta-table td.value { font-weight: 600; font-variant-numeric: tabular-nums; }
  h1 { font-size: 17px; margin: 26px 0 10px; letter-spacing: 0.01em; }
  h2 { font-size: 14px; margin: 0 0 4px; display: flex; align-items: center; gap: 8px; }
  h3 { font-size: 12.5px; margin: 14px 0 4px; }
  section.section { margin: 0 0 22px; break-inside: avoid-page; }
  .section-note { margin: 0 0 8px; color: var(--ink-soft); font-size: 11.5px; }
  table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
  th { text-align: left; font-weight: 600; color: var(--ink-soft); border-bottom: 1px solid var(--line); padding: 5px 8px; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; }
  td { border-bottom: 1px solid var(--line-soft); padding: 5px 8px; vertical-align: top; }
  tr { break-inside: avoid; }
  td.field { font-weight: 600; width: 27%; }
  td.value { width: 33%; font-variant-numeric: tabular-nums; }
  td.source { color: var(--ink-soft); font-size: 10.5px; }
  .detail { color: var(--ink-soft); font-size: 10.5px; margin-top: 2px; }
  .dash { color: var(--muted); }
  .pill { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 9.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--tone); border: 1px solid var(--tone); background: color-mix(in srgb, var(--tone) 9%, white); white-space: nowrap; }
  .scoreboard { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 10px 0 18px; }
  .card { border: 1px solid var(--line); border-radius: 10px; padding: 11px 13px; background: var(--bg-soft); break-inside: avoid; }
  .card-head { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
  .card-title { font-weight: 700; font-size: 11.5px; }
  .score { font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1.15; margin-top: 4px; }
  .score small { font-size: 11px; font-weight: 500; color: var(--ink-soft); }
  .unrated { font-size: 15px; color: var(--muted); font-weight: 600; }
  .rating { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--ink-soft); }
  .missing, .evidence { font-size: 10px; color: var(--ink-soft); margin: 5px 0 0; }
  .overall { display: flex; align-items: center; gap: 22px; padding: 14px 16px; border: 1px solid var(--line); border-radius: 12px; background: var(--bg-soft); margin: 8px 0 18px; }
  .overall .big { font-size: 40px; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; }
  .overall .big small { font-size: 13px; color: var(--ink-soft); font-weight: 500; }
  .overall .summary { flex: 1; }
  .overall .summary p { margin: 3px 0; font-size: 11.5px; color: var(--ink-soft); }
  .coverage-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 8px; margin: 8px 0 4px; }
  .coverage-cell { border: 1px solid var(--line-soft); border-radius: 8px; padding: 7px 9px; }
  .coverage-cell .n { font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .coverage-cell .k { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-soft); }
  .hint { font-weight: 400; font-size: 10.5px; color: var(--ink-soft); text-transform: none; letter-spacing: 0; }
  .disclaimer { font-size: 10.5px; color: var(--ink-soft); border-left: 3px solid var(--line); padding-left: 10px; margin: 10px 0 0; }
  footer.report-footer { margin-top: 26px; padding-top: 12px; border-top: 1px solid var(--line); font-size: 10px; color: var(--ink-soft); display: flex; justify-content: space-between; gap: 16px; }
  @media print {
    body { padding: 0; font-size: 10.5pt; }
    header.masthead { position: running(masthead); }
    section.section { break-inside: avoid-page; }
    .card { break-inside: avoid; }
    @page { size: A4; margin: 16mm 14mm; }
  }
</style>
</head>
<body>
<header class="masthead">
  <div>
    <div class="brand">VERIDEX<small>A PREMIUM PRODUCT BY ${escapeHtml(meta.brand)}</small></div>
  </div>
  <table class="meta-table">
    <tr><td class="label">Report ID</td><td class="value">${escapeHtml(meta.reportId)}</td></tr>
    <tr><td class="label">Generated</td><td class="value">${escapeHtml(meta.generatedAt.replace('T', ' ').slice(0, 19))} UTC</td></tr>
    <tr><td class="label">Report type</td><td class="value">${escapeHtml(meta.kind)}</td></tr>
    <tr><td class="label">Access mode</td><td class="value">${escapeHtml(meta.mode)}</td></tr>
    <tr><td class="label">App version</td><td class="value">${escapeHtml(meta.appVersion)}</td></tr>
  </table>
</header>

${
  assessment
    ? `<h1>Device health assessment</h1>
<div class="overall">
  <div class="big">${assessment.score === null ? '<span class="unrated">Unrated</span>' : `${assessment.score}<small>/100</small>`}</div>
  <div class="summary">
    <p><strong>${escapeHtml(assessment.rating)}</strong> — ${assessment.ratedComponents} of ${assessment.totalComponents} components could be assessed (${assessment.coveragePercent}% coverage).</p>
    <p>${escapeHtml(assessment.disclaimer)}</p>
  </div>
</div>
<div class="scoreboard">${componentCards}</div>`
    : ''
}

<h1>Test coverage</h1>
<div class="coverage-grid">
  <div class="coverage-cell"><div class="n">${coverage.assessed}</div><div class="k">Assessed</div></div>
  <div class="coverage-cell"><div class="n">${coverage.passed}</div><div class="k">Passed</div></div>
  <div class="coverage-cell"><div class="n">${coverage.warned}</div><div class="k">Warnings</div></div>
  <div class="coverage-cell"><div class="n">${coverage.failed}</div><div class="k">Failed</div></div>
  <div class="coverage-cell"><div class="n">${coverage.untested}</div><div class="k">Untested</div></div>
  <div class="coverage-cell"><div class="n">${coverage.blocked}</div><div class="k">Blocked</div></div>
  <div class="coverage-cell"><div class="n">${coverage.unsupported}</div><div class="k">Unavailable</div></div>
  <div class="coverage-cell"><div class="n">${coverage.coveragePercent}%</div><div class="k">Coverage</div></div>
</div>
<p class="disclaimer">${escapeHtml(coverage.note)}</p>

<h1>Detailed findings</h1>
${sectionHtml}
${manualHtml}
${privacyHtml}
${issuesHtml}
${providerHtml}
${options.certificateHtml ?? ''}

<footer class="report-footer">
  <span>VERIDEX ${escapeHtml(meta.appVersion)} · ${escapeHtml(meta.brand)} · ${escapeHtml(meta.founder)} · ${escapeHtml(meta.contact)}</span>
  <span>${escapeHtml(meta.reportId)}${meta.brandLine ? ` · ${escapeHtml(meta.brandLine)}` : ''}</span>
</footer>
</body>
</html>`;
}
