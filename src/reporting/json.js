/**
 * VERIDEX — JSON renderer.
 *
 * The JSON report is the machine-readable contract: it keeps every field's
 * provenance intact (source, timestamp, confidence, notes, error), because that is
 * the whole point of JSON for a diagnostics tool. It also carries an explicit
 * `limitations` block so a consumer parsing this file cannot mistake it for a
 * certified hardware assessment.
 */

import { REPORT_SCHEMA_VERSION } from './model.js';

/**
 * Render the document as JSON.
 * @param {object} report
 * @returns {string}
 */
export function renderJson(report) {
  const document = {
    $schema: 'https://veridex.merqo.local/schema/report-v1.json',
    schemaVersion: REPORT_SCHEMA_VERSION,
    generator: {
      product: report.meta.product,
      brand: report.meta.brand,
      version: report.meta.appVersion,
      founder: report.meta.founder,
      contact: report.meta.contact
    },
    report: {
      id: report.meta.reportId,
      kind: report.kind,
      generatedAt: report.meta.generatedAt,
      startedAt: report.meta.startedAt,
      mode: report.meta.mode,
      platform: report.meta.platform,
      sensitiveDataIncluded: report.meta.includeSensitive
    },
    assessment: report.assessment
      ? {
          score: report.assessment.score,
          rawScore: report.assessment.rawScore ?? report.assessment.score,
          rating: report.assessment.rating,
          gated: Boolean(report.assessment.gated),
          capped: Boolean(report.assessment.capped),
          gatingNote: report.assessment.gatingNote ?? null,
          coveragePercent: report.assessment.coveragePercent,
          ratedComponents: report.assessment.ratedComponents,
          totalComponents: report.assessment.totalComponents,
          components: report.assessment.components.map((component) => ({
            id: component.id,
            label: component.label,
            score: component.score,
            rating: component.rating,
            weight: component.weight,
            missing: component.missing,
            explanation: component.explanation,
            evidence: component.evidence.map((entry) => ({ id: entry.id, label: entry.label, delta: entry.delta, status: entry.status, source: entry.source }))
          }))
        }
      : null,
    coverage: report.coverage,
    sections: report.sections.map((section) => ({
      id: section.id,
      title: section.title,
      status: section.status,
      note: section.note,
      fields: section.rows.map((row) => ({
        key: row.key,
        label: row.label,
        value: row.value,
        unit: row.unit,
        status: row.status,
        source: row.source,
        collectedAt: row.collectedAt,
        confidence: row.confidence,
        error: row.error,
        notes: row.notes,
        redacted: row.redacted
      }))
    })),
    manualResults: report.manualResults,
    manualCoverage: report.manualCoverage ?? null,
    privacy: report.privacy ?? null,
    issues: report.issues,
    providers: report.providerLog,
    limitations: {
      disclaimer: report.meta.toolDisclaimer,
      unverifiableWithoutHardware: [
        'Dead and stuck pixels, backlight bleed, colour uniformity and physical port function require human observation.',
        'Battery full-charge capacity and cycle count depend on firmware exposing them; absence is reported, not estimated.',
        'CPU temperature is unavailable on most systems without administrator rights and a firmware thermal zone.',
        'Benchmark figures are VERIDEX-specific units and are not comparable to other tools.'
      ],
      notACertification: 'This document records measurements and observations made at a point in time. It is not a warranty, a safety certificate, or a prediction of future failure.'
    }
  };

  return JSON.stringify(document, null, 2);
}
