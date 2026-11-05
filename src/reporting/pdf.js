/**
 * VERIDEX — PDF renderer.
 *
 * Built with PDFKit (MIT, no native dependencies) so the report is generated fully
 * offline with vector text — selectable, searchable and sharp at any zoom, unlike a
 * rasterised page.
 *
 * Layout rules that matter for a document a technician hands to a customer:
 *  - every page carries a header with the report ID and a footer with page numbers;
 *  - a section never splits so badly that a heading is orphaned at the bottom;
 *  - status is shown as text plus colour, so a greyscale printout keeps its meaning;
 *  - the disclaimer appears on the first page, not buried at the end.
 */

import PDFDocument from 'pdfkit';
import { formatValue } from './model.js';
import { statusLabel, statusTone } from '../core/status.js';

const PAGE = { size: 'A4', margin: 42 };
const COLOURS = {
  ink: '#10151c',
  inkSoft: '#4d5866',
  line: '#d8dee6',
  lineSoft: '#eef1f5',
  bgSoft: '#f7f9fb',
  accent: '#12456b',
  ok: '#1f9d6b',
  warn: '#c8891f',
  bad: '#c9403f',
  muted: '#7b8794'
};
const FONTS = { regular: 'Helvetica', bold: 'Helvetica-Bold', italic: 'Helvetica-Oblique' };

/**
 * @param {string} status
 */
function toneOf(status) {
  return COLOURS[statusTone(status)] ?? COLOURS.muted;
}

/**
 * Collect the PDF into a Buffer so the caller can hash it, write it, or attach it.
 * @param {object} report
 * @param {{certificate?: object|null, appVersion?: string}} [options]
 * @returns {Promise<Buffer>}
 */
export async function renderPdf(report, options = {}) {
  const doc = new PDFDocument({
    size: PAGE.size,
    margin: PAGE.margin,
    bufferPages: true,
    info: {
      Title: `VERIDEX device inspection report ${report.meta.reportId}`,
      Author: `VERIDEX by ${report.meta.brand}`,
      Subject: 'Windows PC and laptop hardware inspection',
      Keywords: 'VERIDEX, MERQO, diagnostics, hardware inspection',
      Creator: `VERIDEX ${report.meta.appVersion}`
    }
  });

  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  const finished = new Promise((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const contentWidth = doc.page.width - PAGE.margin * 2;
  let pageIndex = 0;

  /**
   * Draw the running header and footer for the current page.
   *
   * The footer sits below the nominal bottom margin, and PDFKit adds a page
   * automatically whenever text is written past `maxY()`. Both decoration passes
   * therefore run with the bottom margin temporarily removed, and the cursor is
   * restored afterwards so body text continues where it left off.
   */
  const decorate = () => {
    pageIndex += 1;
    const savedY = doc.y;
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    doc.save();
    doc.font(FONTS.bold).fontSize(8).fillColor(COLOURS.accent);
    doc.text('VERIDEX', PAGE.margin, PAGE.margin - 18, { characterSpacing: 1.4, lineBreak: false });
    doc.font(FONTS.regular).fillColor(COLOURS.inkSoft);
    doc.text(`   device inspection report · ${report.meta.reportId}`, PAGE.margin, PAGE.margin - 18, { characterSpacing: 0, lineBreak: false, width: contentWidth, align: 'left' });

    doc.moveTo(PAGE.margin, PAGE.margin - 6).lineTo(PAGE.margin + contentWidth, PAGE.margin - 6).lineWidth(0.4).strokeColor(COLOURS.line).stroke();

    const footerY = doc.page.height - PAGE.margin + 14;
    doc.font(FONTS.regular).fontSize(7.5).fillColor(COLOURS.inkSoft);
    doc.text(`Generated ${report.meta.generatedAt.replace('T', ' ').slice(0, 19)} UTC · VERIDEX ${report.meta.appVersion} · ${report.meta.brand}`, PAGE.margin, footerY, { width: contentWidth - 70, lineBreak: false });
    doc.text(`Page ${pageIndex}`, PAGE.margin + contentWidth - 64, footerY, { width: 64, align: 'right', lineBreak: false });
    doc.restore();

    doc.page.margins.bottom = savedBottom;
    doc.y = savedY;
  };

  /** Start a new page when a block will not fit. */
  const ensureSpace = (needed) => {
    const remaining = doc.page.height - PAGE.margin - doc.y - 12;
    if (remaining < needed) {
      doc.addPage();
      decorate();
    }
  };

  decorate();

  // ── Masthead ────────────────────────────────────────────────────────────────
  doc.font(FONTS.bold).fontSize(28).fillColor(COLOURS.accent).text('VERIDEX', PAGE.margin, doc.y, { characterSpacing: 2.6, lineBreak: false });
  doc.font(FONTS.regular).fontSize(8).fillColor(COLOURS.inkSoft).text(`A PREMIUM PRODUCT BY ${report.meta.brand}`, PAGE.margin, doc.y + 2, { characterSpacing: 1.8 });

  const metaY = doc.y + 16;
  const metaRows = [
    ['Report ID', report.meta.reportId],
    ['Generated', `${report.meta.generatedAt.replace('T', ' ').slice(0, 19)} UTC`],
    ['Report type', report.meta.kind],
    ['Access mode', report.meta.mode],
    ['App version', report.meta.appVersion]
  ];
  doc.fontSize(8.5);
  metaRows.forEach(([label, value], index) => {
    const y = metaY + index * 11;
    doc.font(FONTS.regular).fillColor(COLOURS.inkSoft).text(label, PAGE.margin + contentWidth - 190, y, { width: 90, align: 'right', lineBreak: false });
    doc.font(FONTS.bold).fillColor(COLOURS.ink).text(String(value), PAGE.margin + contentWidth - 94, y, { width: 94, align: 'right', lineBreak: false });
  });

  doc.y = metaY + metaRows.length * 11 + 6;
  doc.moveTo(PAGE.margin, doc.y).lineTo(PAGE.margin + contentWidth, doc.y).lineWidth(1.6).strokeColor(COLOURS.accent).stroke();
  doc.y += 14;

  // ── Overall assessment ──────────────────────────────────────────────────────
  const assessment = report.assessment;
  if (assessment) {
    ensureSpace(120);
    heading(doc, 'Device health assessment', contentWidth);

    const boxTop = doc.y;
    const boxHeight = 86;
    doc.roundedRect(PAGE.margin, boxTop, contentWidth, boxHeight, 8).fillAndStroke(COLOURS.bgSoft, COLOURS.line);

    const scoreText = assessment.score === null ? 'Unrated' : String(assessment.score);
    doc.font(FONTS.bold).fontSize(assessment.score === null ? 18 : 34).fillColor(assessment.score === null ? COLOURS.muted : COLOURS.ink);
    doc.text(scoreText, PAGE.margin + 16, boxTop + 16, { width: 130, lineBreak: false });
    if (assessment.score !== null) {
      doc.font(FONTS.regular).fontSize(10).fillColor(COLOURS.inkSoft).text('/ 100', PAGE.margin + 16, boxTop + 54, { width: 130, lineBreak: false });
    }

    doc.font(FONTS.bold).fontSize(11).fillColor(COLOURS.ink).text(assessment.rating, PAGE.margin + 156, boxTop + 16, { width: contentWidth - 172 });
    doc.font(FONTS.regular).fontSize(8.5).fillColor(COLOURS.inkSoft).text(
      `${assessment.ratedComponents} of ${assessment.totalComponents} components could be assessed (${assessment.coveragePercent}% of the weighted assessment surface). Components without evidence are unrated, never counted as healthy.`,
      PAGE.margin + 156,
      boxTop + 32,
      { width: contentWidth - 172 }
    );
    doc.font(FONTS.italic).fontSize(7.5).fillColor(COLOURS.inkSoft).text(assessment.disclaimer, PAGE.margin + 156, boxTop + 62, { width: contentWidth - 172 });

    doc.y = boxTop + boxHeight + 14;

    // Component grid, three per row.
    const cardWidth = (contentWidth - 16) / 3;
    const cardHeight = 74;
    assessment.components.forEach((component, index) => {
      const column = index % 3;
      if (column === 0) ensureSpace(cardHeight + 8);
      const rowY = doc.y;
      const x = PAGE.margin + column * (cardWidth + 8);
      doc.roundedRect(x, rowY, cardWidth, cardHeight, 6).fillAndStroke(COLOURS.bgSoft, COLOURS.line);

      doc.font(FONTS.bold).fontSize(8.5).fillColor(COLOURS.ink).text(component.label, x + 9, rowY + 8, { width: cardWidth - 18, lineBreak: false });
      doc.font(FONTS.bold).fontSize(component.score === null ? 10 : 17).fillColor(component.score === null ? COLOURS.muted : COLOURS.ink);
      doc.text(component.score === null ? 'Unrated' : `${component.score}`, x + 9, rowY + 22, { width: cardWidth - 18, lineBreak: false });
      doc.font(FONTS.regular).fontSize(7.5).fillColor(toneOf(component.status)).text(component.rating.toUpperCase(), x + 9, rowY + 42, { width: cardWidth - 18, characterSpacing: 0.6, lineBreak: false });
      doc.font(FONTS.regular).fontSize(6.5).fillColor(COLOURS.inkSoft).text(
        component.missing.length > 0 ? `Not scored: ${component.missing[0]}` : component.evidence.length > 0 ? `${component.evidence.length} evidence item(s)` : '',
        x + 9,
        rowY + 54,
        { width: cardWidth - 18, height: 18, ellipsis: true }
      );

      if (column === 2 || index === assessment.components.length - 1) {
        doc.y = rowY + cardHeight + 8;
      }
    });
  }

  // ── Coverage ────────────────────────────────────────────────────────────────
  const coverage = report.coverage;
  ensureSpace(90);
  heading(doc, 'Test coverage', contentWidth);
  const cells = [
    ['Assessed', coverage.assessed],
    ['Passed', coverage.passed],
    ['Warnings', coverage.warned],
    ['Failed', coverage.failed],
    ['Untested', coverage.untested],
    ['Blocked', coverage.blocked],
    ['Unavailable', coverage.unsupported],
    ['Coverage', `${coverage.coveragePercent}%`]
  ];
  const cellWidth = (contentWidth - 7 * 6) / 8;
  const cellTop = doc.y;
  cells.forEach(([label, value], index) => {
    const x = PAGE.margin + index * (cellWidth + 6);
    doc.roundedRect(x, cellTop, cellWidth, 40, 5).fillAndStroke('#ffffff', COLOURS.lineSoft);
    doc.font(FONTS.bold).fontSize(13).fillColor(COLOURS.ink).text(String(value), x + 6, cellTop + 7, { width: cellWidth - 12, lineBreak: false });
    doc.font(FONTS.regular).fontSize(6).fillColor(COLOURS.inkSoft).text(label.toUpperCase(), x + 6, cellTop + 25, { width: cellWidth - 12, characterSpacing: 0.4, lineBreak: false });
  });
  doc.y = cellTop + 48;
  doc.font(FONTS.italic).fontSize(7).fillColor(COLOURS.inkSoft).text(coverage.note, PAGE.margin, doc.y, { width: contentWidth });
  doc.y += 12;

  // ── Sections ────────────────────────────────────────────────────────────────
  for (const section of report.sections) {
    ensureSpace(70);
    doc.y += 4;
    heading(doc, section.title, contentWidth);
    pill(doc, statusLabel(section.status), toneOf(section.status), PAGE.margin + contentWidth - 86, doc.y - 13);
    if (section.note) {
      doc.font(FONTS.italic).fontSize(7.5).fillColor(COLOURS.inkSoft).text(section.note, PAGE.margin, doc.y, { width: contentWidth });
      doc.y += 3;
    }

    const columns = [
      { key: 'label', width: contentWidth * 0.3 },
      { key: 'value', width: contentWidth * 0.36 },
      { key: 'status', width: contentWidth * 0.12 },
      { key: 'source', width: contentWidth * 0.22 }
    ];

    // Header row
    const headerY = doc.y + 2;
    let cursorX = PAGE.margin;
    doc.font(FONTS.bold).fontSize(6.5).fillColor(COLOURS.inkSoft);
    for (const column of columns) {
      doc.text(column.key.toUpperCase(), cursorX, headerY, { width: column.width - 4, characterSpacing: 0.5, lineBreak: false });
      cursorX += column.width;
    }
    doc.y = headerY + 11;
    doc.moveTo(PAGE.margin, doc.y).lineTo(PAGE.margin + contentWidth, doc.y).lineWidth(0.6).strokeColor(COLOURS.line).stroke();
    doc.y += 4;

    for (const row of section.rows) {
      const valueText = formatValue(row.value, row.unit) || '—';
      const detailText = [row.error, ...row.notes].filter(Boolean).join(' ');
      doc.font(FONTS.regular).fontSize(7.5);
      const valueHeight = doc.heightOfString(valueText, { width: columns[1].width - 6 }) + (detailText ? doc.heightOfString(detailText, { width: columns[1].width - 6 }) : 0);
      const labelHeight = doc.heightOfString(row.label, { width: columns[0].width - 6 });
      const rowHeight = Math.max(13, valueHeight + 4, labelHeight + 4);

      ensureSpace(rowHeight + 6);
      const rowY = doc.y;
      cursorX = PAGE.margin;

      doc.font(FONTS.bold).fontSize(7.5).fillColor(COLOURS.ink).text(row.label, cursorX + 2, rowY + 2, { width: columns[0].width - 8 });
      cursorX += columns[0].width;

      doc.font(FONTS.regular).fillColor(COLOURS.ink).text(valueText, cursorX + 2, rowY + 2, { width: columns[1].width - 8 });
      if (detailText) {
        doc.font(FONTS.regular).fontSize(6.5).fillColor(COLOURS.inkSoft).text(detailText, cursorX + 2, doc.y + 1, { width: columns[1].width - 8 });
      }
      cursorX += columns[1].width;

      pill(doc, statusLabel(row.status), toneOf(row.status), cursorX + 2, rowY + 3);
      cursorX += columns[2].width;

      doc.font(FONTS.regular).fontSize(6.5).fillColor(COLOURS.inkSoft).text(`${row.source ?? '—'}`, cursorX + 2, rowY + 3, { width: columns[3].width - 6 });

      doc.y = rowY + rowHeight;
      doc.moveTo(PAGE.margin, doc.y).lineTo(PAGE.margin + contentWidth, doc.y).lineWidth(0.4).strokeColor(COLOURS.lineSoft).stroke();
      doc.y += 1.5;
    }
  }

  // ── Manual results ──────────────────────────────────────────────────────────
  if (report.manualResults.length > 0) {
    ensureSpace(90);
    doc.y += 10;
    heading(doc, 'Manual inspection results', contentWidth);
    doc.font(FONTS.italic).fontSize(7.5).fillColor(COLOURS.inkSoft).text('Recorded by the person performing the inspection. Software cannot detect these defects; these are observations, not measurements.', PAGE.margin, doc.y, { width: contentWidth });
    doc.y += 8;

    for (const result of report.manualResults) {
      ensureSpace(28);
      const rowY = doc.y;
      doc.font(FONTS.bold).fontSize(7.5).fillColor(COLOURS.ink).text(result.title, PAGE.margin + 2, rowY, { width: contentWidth * 0.4 });
      pill(doc, statusLabel(result.status), toneOf(result.status), PAGE.margin + contentWidth * 0.52, rowY - 1);
      doc.font(FONTS.regular).fontSize(6.5).fillColor(COLOURS.inkSoft).text(result.observedAt, PAGE.margin + contentWidth - 110, rowY, { width: 110, align: 'right' });
      doc.y = rowY + 12;
      if (result.notes.length > 0) {
        doc.font(FONTS.regular).fontSize(6.5).fillColor(COLOURS.inkSoft).text(result.notes.join(' '), PAGE.margin + 2, doc.y, { width: contentWidth - 20 });
        doc.y += 2;
      }
    }
  }

  // ── Issues ──────────────────────────────────────────────────────────────────
  const hasIssues = report.issues.warnings.length + report.issues.errors.length + report.issues.conflicts.length > 0;
  if (hasIssues) {
    ensureSpace(80);
    doc.y += 10;
    heading(doc, 'Warnings, errors and conflicting readings', contentWidth);
    for (const [title, items, tone] of [
      ['Warnings', report.issues.warnings, COLOURS.warn],
      ['Errors', report.issues.errors, COLOURS.bad],
      ['Conflicting provider readings', report.issues.conflicts, COLOURS.warn]
    ]) {
      if (items.length === 0) continue;
      ensureSpace(24);
      doc.font(FONTS.bold).fontSize(8).fillColor(tone).text(title, PAGE.margin, doc.y, { width: contentWidth });
      doc.y += 11;
      for (const item of items) {
        ensureSpace(14);
        doc.font(FONTS.regular).fontSize(7.5).fillColor(COLOURS.ink).text(`•  ${item}`, PAGE.margin + 6, doc.y, { width: contentWidth - 12 });
        doc.y += 1;
      }
      doc.y += 4;
    }
  }

  // ── Provider log ────────────────────────────────────────────────────────────
  if (report.providerLog.length > 0) {
    ensureSpace(80);
    doc.y += 10;
    heading(doc, 'Data sources attempted', contentWidth);
    doc.font(FONTS.italic).fontSize(7).fillColor(COLOURS.inkSoft).text('Every mechanism VERIDEX used is listed with its outcome, so a missing value can be traced to the provider that could not supply it.', PAGE.margin, doc.y, { width: contentWidth });
    doc.y += 8;

    for (const entry of report.providerLog) {
      ensureSpace(16);
      const rowY = doc.y;
      doc.font(FONTS.regular).fontSize(6.8).fillColor(COLOURS.ink).text(entry.task, PAGE.margin + 2, rowY, { width: contentWidth * 0.2, lineBreak: false });
      doc.text(entry.provider, PAGE.margin + contentWidth * 0.22, rowY, { width: contentWidth * 0.4, lineBreak: false });
      doc.fillColor(entry.ok ? COLOURS.ok : COLOURS.muted).text(entry.ok ? 'succeeded' : 'no data', PAGE.margin + contentWidth * 0.63, rowY, { width: contentWidth * 0.12, lineBreak: false });
      if (entry.error) {
        doc.fillColor(COLOURS.inkSoft).fontSize(6.2).text(entry.error, PAGE.margin + contentWidth * 0.76, rowY, { width: contentWidth * 0.24, lineBreak: false, ellipsis: true });
      }
      doc.y = rowY + 10;
    }
  }

  // ── Certificate ─────────────────────────────────────────────────────────────
  if (options.certificate) {
    doc.addPage();
    decorate();
    renderCertificate(doc, report, options.certificate, contentWidth);
  }

  doc.end();
  return finished;
}

/**
 * Section heading.
 * @param {PDFKit.PDFDocument} doc
 * @param {string} text
 * @param {number} width
 */
function heading(doc, text, width) {
  doc.font(FONTS.bold).fontSize(11).fillColor(COLOURS.ink).text(text, PAGE.margin, doc.y, { width });
  doc.y += 4;
}

/**
 * Status pill with a text label, so colour is never the only carrier of meaning.
 * @param {PDFKit.PDFDocument} doc
 * @param {string} text
 * @param {string} colour
 * @param {number} x
 * @param {number} y
 */
function pill(doc, text, colour, x, y) {
  doc.font(FONTS.bold).fontSize(5.6);
  const label = text.toUpperCase();
  const width = doc.widthOfString(label) + 10;
  doc.roundedRect(x, y, width, 9, 4.5).lineWidth(0.5).strokeColor(colour).stroke();
  doc.fillColor(colour).text(label, x + 5, y + 2.2, { lineBreak: false, characterSpacing: 0.3 });
  doc.font(FONTS.regular);
  return width;
}

/**
 * The inspection certificate page.
 * @param {PDFKit.PDFDocument} doc
 * @param {object} report
 * @param {object} certificate
 * @param {number} contentWidth
 */
function renderCertificate(doc, report, certificate, contentWidth) {
  const top = doc.y + 20;
  doc.roundedRect(PAGE.margin, top, contentWidth, 300, 12).lineWidth(2).strokeColor(COLOURS.accent).stroke();
  doc.roundedRect(PAGE.margin + 5, top + 5, contentWidth - 10, 290, 10).lineWidth(0.5).strokeColor(COLOURS.line).stroke();

  doc.font(FONTS.bold).fontSize(9).fillColor(COLOURS.accent).text('CERTIFICATE OF DEVICE INSPECTION', PAGE.margin, top + 22, { width: contentWidth, align: 'center', characterSpacing: 2 });
  doc.font(FONTS.bold).fontSize(22).fillColor(COLOURS.ink).text('VERIDEX', PAGE.margin, top + 40, { width: contentWidth, align: 'center', characterSpacing: 4 });
  doc.font(FONTS.regular).fontSize(7).fillColor(COLOURS.inkSoft).text(`A PREMIUM PRODUCT BY ${report.meta.brand}`, PAGE.margin, top + 68, { width: contentWidth, align: 'center', characterSpacing: 1.6 });

  doc.moveTo(PAGE.margin + 40, top + 88).lineTo(PAGE.margin + contentWidth - 40, top + 88).lineWidth(0.5).strokeColor(COLOURS.line).stroke();

  const lines = [
    ['Device', certificate.deviceName ?? 'Not identified'],
    ['Inspection date', (certificate.inspectedAt ?? report.meta.generatedAt).replace('T', ' ').slice(0, 19) + ' UTC'],
    ['Overall assessment', certificate.overallText ?? report.assessment?.rating ?? 'Unrated'],
    ['Components assessed', `${report.assessment?.ratedComponents ?? 0} of ${report.assessment?.totalComponents ?? 0} (${report.assessment?.coveragePercent ?? 0}% coverage)`],
    ['Tests passed / failed', `${report.coverage.passed} / ${report.coverage.failed}`],
    ['Manual observations', String(report.manualResults.length)],
    ['Outstanding warnings', String(report.issues.warnings.length)],
    ['Untested items', String(report.coverage.untested)],
    ['Report ID', report.meta.reportId],
    ['Generated by', `VERIDEX ${report.meta.appVersion}`]
  ];

  lines.forEach(([label, value], index) => {
    const y = top + 100 + index * 15;
    doc.font(FONTS.regular).fontSize(8).fillColor(COLOURS.inkSoft).text(label, PAGE.margin + 40, y, { width: 120, lineBreak: false });
    doc.font(FONTS.bold).fontSize(8).fillColor(COLOURS.ink).text(String(value), PAGE.margin + 168, y, { width: contentWidth - 210, lineBreak: false });
  });

  doc.font(FONTS.italic).fontSize(6.5).fillColor(COLOURS.inkSoft).text(
    'This certificate records the tests VERIDEX performed and the observations recorded at the time of inspection. It is not a warranty, a safety certification, or a prediction of future failure. Items marked untested or unrated were not assessed.',
    PAGE.margin + 40,
    top + 256,
    { width: contentWidth - 80, align: 'center' }
  );
}
