/**
 * VERIDEX — Device inspection certificate (MODULE 15).
 *
 * The certificate is the artefact a reseller hands to a buyer, so it must be
 * strictly truthful: it states what was assessed, what was *not* assessed, and how
 * much of the machine the assessment covered. It never says "fully tested" unless
 * coverage actually is complete, and it says "not assessed" in as many words when it
 * is not.
 */

import { Status } from '../core/status.js';
import { coverageStatement } from '../engine/health.js';

/**
 * Build the certificate data from a completed report document.
 *
 * @param {object} report
 * @param {{inspectedAt?:string, inspector?:string|null}} [options]
 */
export function buildCertificate(report, options = {}) {
  const assessment = report.assessment;
  const coverage = report.coverage;

  const deviceName = (() => {
    const system = report.sections.find((section) => section.id === 'system');
    if (!system) return null;
    const manufacturer = system.rows.find((row) => row.key === 'manufacturer')?.value;
    const model = system.rows.find((row) => row.key === 'model')?.value;
    if (manufacturer && model) return `${manufacturer} ${model}`;
    return model ?? manufacturer ?? null;
  })();

  // The wording of the overall verdict depends on how much of the machine was
  // actually assessed. This is the honesty requirement in one place.
  const overallText = (() => {
    if (!assessment || assessment.score === null) return 'Not assessed — insufficient evidence';
    if (assessment.coveragePercent >= 80) return `${assessment.rating} (${assessment.score}/100, ${assessment.coveragePercent}% coverage)`;
    if (assessment.coveragePercent >= 50) return `${assessment.rating} (${assessment.score}/100) — partial assessment, ${assessment.coveragePercent}% coverage`;
    return `${assessment.rating} (${assessment.score}/100) — limited assessment, only ${assessment.coveragePercent}% coverage`;
  })();

  const failedItems = [];
  const warningItems = [];
  const untestedItems = [];
  const unassessedItems = [];

  for (const section of report.sections) {
    for (const row of section.rows) {
      if (row.status === Status.FAIL) failedItems.push(`${section.title} · ${row.label}`);
      else if (row.status === Status.WARNING) warningItems.push(`${section.title} · ${row.label}`);
      else if (row.status === Status.UNTESTED) untestedItems.push(`${section.title} · ${row.label}`);
      else if (row.status === Status.UNAVAILABLE || row.status === Status.UNSUPPORTED || row.status === Status.NOT_APPLICABLE) unassessedItems.push(`${section.title} · ${row.label}`);
    }
  }

  for (const result of report.manualResults) {
    if (result.status === Status.FAIL) failedItems.push(`Manual · ${result.title}`);
    else if (result.status === Status.WARNING) warningItems.push(`Manual · ${result.title}`);
    else if (result.status === Status.UNTESTED) untestedItems.push(`Manual · ${result.title}`);
  }

  return {
    reportId: report.meta.reportId,
    generatedAt: report.meta.generatedAt,
    inspectedAt: options.inspectedAt ?? report.meta.generatedAt,
    inspector: options.inspector ?? null,
    deviceName: deviceName ?? 'Not identified',
    appVersion: report.meta.appVersion,
    brand: report.meta.brand,
    founder: report.meta.founder,
    overallText,
    score: assessment?.score ?? null,
    rating: assessment?.rating ?? 'Unrated',
    coveragePercent: coverage.coveragePercent,
    counts: {
      passed: coverage.passed,
      failed: coverage.failed,
      warned: coverage.warned,
      untested: coverage.untested,
      blocked: coverage.blocked,
      unsupported: coverage.unsupported
    },
    failedItems,
    warningItems,
    untestedItems,
    unassessedItems,
    componentCoverage: assessment ? coverageStatement(assessment) : null,
    statement:
      'This certificate records the tests VERIDEX performed on the device identified above, and the observations recorded at that time. It is not a warranty, a safety certification, or a prediction of future failure. Items listed as untested, unavailable or unrated were not assessed, and their absence from the failed list does not mean they are healthy.',
    unassessedCaveat:
      unassessedItems.length > 0
        ? `${unassessedItems.length} item(s) could not be assessed on this device. They are excluded from the score rather than counted as passing.`
        : null
  };
}

/**
 * Render the certificate as a self-contained HTML block, for inclusion in an HTML
 * report or for printing on its own.
 * @param {ReturnType<typeof buildCertificate>} certificate
 * @param {string} escapeHtmlFn
 */
export function renderCertificateHtml(certificate, escapeHtmlFn) {
  const escape = escapeHtmlFn ?? ((value) => String(value ?? ''));
  const list = (title, items) =>
    items.length > 0 ? `<h3>${escape(title)}</h3><ul>${items.map((item) => `<li>${escape(item)}</li>`).join('')}</ul>` : '';

  return `
<section class="section certificate">
  <h2>Certificate of device inspection <span class="hint">${escape(certificate.reportId)}</span></h2>
  <div class="overall">
    <div class="big">${certificate.score === null ? '<span class="unrated">Unrated</span>' : `${certificate.score}<small>/100</small>`}</div>
    <div class="summary">
      <p><strong>${escape(certificate.deviceName)}</strong></p>
      <p>${escape(certificate.overallText)}</p>
      <p>Inspected ${escape(certificate.inspectedAt.replace('T', ' ').slice(0, 19))} UTC${certificate.inspector ? ` by ${escape(certificate.inspector)}` : ''}</p>
    </div>
  </div>
  <div class="coverage-grid">
    <div class="coverage-cell"><div class="n">${certificate.counts.passed}</div><div class="k">Passed</div></div>
    <div class="coverage-cell"><div class="n">${certificate.counts.failed}</div><div class="k">Failed</div></div>
    <div class="coverage-cell"><div class="n">${certificate.counts.warned}</div><div class="k">Warnings</div></div>
    <div class="coverage-cell"><div class="n">${certificate.counts.untested}</div><div class="k">Untested</div></div>
    <div class="coverage-cell"><div class="n">${certificate.counts.blocked}</div><div class="k">Blocked</div></div>
    <div class="coverage-cell"><div class="n">${certificate.counts.unsupported}</div><div class="k">Unavailable</div></div>
  </div>
  ${list('Failed items', certificate.failedItems)}
  ${list('Warnings', certificate.warningItems)}
  ${list('Untested', certificate.untestedItems)}
  ${certificate.componentCoverage ? `<h3>Component coverage</h3><ul>${certificate.componentCoverage.rated.map((item) => `<li>${escape(item)}</li>`).join('')}${certificate.componentCoverage.unrated.map((item) => `<li>${escape(item)}</li>`).join('')}</ul>` : ''}
  <p class="disclaimer">${escape(certificate.statement)}</p>
  ${certificate.unassessedCaveat ? `<p class="disclaimer">${escape(certificate.unassessedCaveat)}</p>` : ''}
</section>`;
}
