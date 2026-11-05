/**
 * VERIDEX — Report document model.
 *
 * One model, four renderers (PDF, HTML, CSV, JSON). Building the document once means
 * the formats can never disagree about what was found, which is the failure mode
 * that makes multi-format reporting dangerous: a CSV that says PASS while the PDF
 * says UNTESTED is worse than one format.
 *
 * The model also owns the privacy transform. Redaction happens here, before any
 * renderer sees the data, so a new renderer cannot accidentally leak a serial number.
 */

import { Status, severityRank, statusLabel } from '../core/status.js';
import { summariseRedactions, redactField, REDACTION_PLACEHOLDER } from '../security/privacy.js';

export const REPORT_SCHEMA_VERSION = '1.0';
export const REPORT_KIND = Object.freeze({
  FULL: 'full',
  QUICK: 'quick',
  INSPECTION: 'inspection',
  CERTIFICATE: 'certificate'
});

/**
 * Privacy policy lives in src/security/privacy.js, which is also the module the
 * settings schema points at. It is re-exported here so report code has a single
 * import site, while the *policy* still has exactly one owner.
 */
export { PRIVACY_SENSITIVE, PRIVACY_CATEGORIES, isPrivateField, redactField, REDACTION_PLACEHOLDER } from '../security/privacy.js';

/**
 * Report identity. The ID is derived from the run start time plus a short random
 * suffix so two reports generated in the same second cannot collide, and so the ID
 * is traceable to a moment without exposing anything about the machine.
 * @param {Date} [now]
 * @param {() => number} [rand]
 */
export function makeReportId(now = new Date(), rand = Math.random) {
  const iso = now.toISOString();
  const stamp = `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}-${iso.slice(20, 23)}`;
  const suffix = Math.floor(rand() * 0xffff).toString(16).toUpperCase().padStart(4, '0');
  return `VX-RPT-${stamp}-${suffix}`;
}

/**
 * @typedef {object} ReportMeta
 * @property {string} reportId
 * @property {string} generatedAt
 * @property {string} kind
 * @property {string} appVersion
 * @property {string} schemaVersion
 * @property {string} brand
 * @property {string} product
 * @property {string} founder
 * @property {string} contact
 * @property {string} platform
 * @property {string} mode           'standard' | 'elevated'
 * @property {boolean} includeSensitive
 * @property {string} toolDisclaimer
 */

/**
 * Build report metadata.
 * @param {object} input
 */
export function buildMeta(input = {}) {
  return {
    reportId: input.reportId ?? makeReportId(),
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    startedAt: input.startedAt ?? null,
    kind: input.kind ?? REPORT_KIND.FULL,
    appVersion: input.appVersion ?? '1.0.0',
    schemaVersion: REPORT_SCHEMA_VERSION,
    brand: 'MERQO',
    product: 'VERIDEX',
    founder: 'Shohan Khan',
    contact: 'merqoonline@gmail.com',
    platform: input.platform ?? 'win32',
    mode: input.mode ?? 'standard',
    includeSensitive: Boolean(input.includeSensitive),
    toolDisclaimer:
      'VERIDEX reports what it could measure and explicitly marks what it could not. Absence of a problem is not a guarantee of hardware health, and a low score is not a hardware certification. Manual observation is required for defects that software cannot detect.',
    ...(input.brandLine ? { brandLine: input.brandLine } : {})
  };
}

/**
 * @typedef {object} ReportSection
 * @property {string} id
 * @property {string} title
 * @property {string} status
 * @property {string} [note]
 * @property {Array<{key:string,label:string,value:unknown,unit:string|null,status:string,source:string|null,collectedAt:string,confidence:string,error:string|null,notes:string[],redacted:boolean}>} rows
 */

/**
 * Convert a field map into report rows, applying privacy and sorting problems first.
 * @param {Record<string, import('../core/field.js').FieldValue>} fields
 * @param {{includeSensitive:boolean}} options
 * @returns {ReportSection['rows']}
 */
export function fieldsToRows(fields, options = {}) {
  const includeSensitive = Boolean(options.includeSensitive);
  const rows = Object.entries(fields ?? {}).map(([key, original]) => {
    const field = redactField(original, key, includeSensitive);
    return {
      key,
      label: humaniseKey(key),
      value: field?.value ?? null,
      unit: field?.unit ?? null,
      status: field?.status ?? Status.UNKNOWN,
      source: field?.source ?? null,
      collectedAt: field?.collectedAt ?? null,
      confidence: field?.confidence ?? 'NONE',
      error: field?.error ?? null,
      notes: [...(field?.notes ?? [])],
      redacted: field?.value === REDACTION_PLACEHOLDER
    };
  });
  return rows.sort((a, b) => {
    const rank = severityRank(a.status) - severityRank(b.status);
    return rank !== 0 ? rank : a.key.localeCompare(b.key);
  });
}

/**
 * Turn a field key into a readable label.
 * `disk1.percentageUsed` → `Disk 1 · Percentage used`.
 * @param {string} key
 */
export function humaniseKey(key) {
  const ACRONYMS = {
    cpu: 'CPU',
    gpu: 'GPU',
    ram: 'RAM',
    ssd: 'SSD',
    hdd: 'HDD',
    nvme: 'NVMe',
    usb: 'USB',
    tpm: 'TPM',
    uac: 'UAC',
    bios: 'BIOS',
    oem: 'OEM',
    ip: 'IP',
    ipv4: 'IPv4',
    ipv6: 'IPv6',
    dns: 'DNS',
    iops: 'IOPS',
    pcie: 'PCIe',
    smbios: 'SMBIOS',
    hdr: 'HDR',
    dpi: 'DPI',
    wmi: 'WMI',
    mac: 'MAC',
    id: 'ID',
    l1: 'L1',
    l2: 'L2',
    l3: 'L3'
  };

  return String(key)
    // `disk1.percentageUsed` → segments ["disk1", "percentageUsed"]
    .split('.')
    .map((segment) =>
      segment
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/\s+/)
        .map((word) => {
          const lower = word.toLowerCase();
          if (ACRONYMS[lower]) return ACRONYMS[lower];
          // "disk1" → "Disk 1", but keep "L3"-style single-letter+digit tokens.
          const indexMatch = word.match(/^([a-z]+)(\d+)$/i);
          if (indexMatch) {
            const [, name, digits] = indexMatch;
            return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${digits}`;
          }
          return word.charAt(0).toUpperCase() + word.slice(1);
        })
        .join(' ')
    )
    .join(' · ');
}

/**
 * Section definitions and their display order in a report.
 */
export const SECTION_ORDER = Object.freeze([
  { id: 'system', title: 'Device identity' },
  { id: 'cpu', title: 'Processor' },
  { id: 'motherboard', title: 'Motherboard & firmware' },
  { id: 'memory', title: 'Memory' },
  { id: 'gpu', title: 'Graphics' },
  { id: 'display', title: 'Displays' },
  { id: 'storage', title: 'Storage devices' },
  { id: 'storageHealth', title: 'Storage health (SMART / NVMe)' },
  { id: 'battery', title: 'Battery & power' },
  { id: 'directx', title: 'DirectX runtime' },
  { id: 'audio', title: 'Audio devices' },
  { id: 'camera', title: 'Cameras' },
  { id: 'network', title: 'Network' },
  { id: 'ports', title: 'Ports & connectivity' },
  { id: 'drivers', title: 'Drivers & devices' },
  { id: 'windows', title: 'Windows' },
  { id: 'windowsInventory', title: 'Windows features & services' },
  { id: 'windowsHealth', title: 'Windows component health' },
  { id: 'security', title: 'Security posture' },
  { id: 'sensors', title: 'Sensors & monitoring' },
  { id: 'benchmark', title: 'Benchmarks' },
  { id: 'stress', title: 'Stress test' },
  { id: 'manual', title: 'Manual inspection results' }
]);

/**
 * Build the full report document.
 *
 * @param {object} input
 * @param {Record<string, Record<string, import('../core/field.js').FieldValue>>} input.modules
 * @param {import('../engine/health.js').OverallAssessment} [input.assessment]
 * @param {Array<{id:string, title:string, status:string, observedAt:string, notes:string[]}>} [input.manualResults]
 * @param {Array<{providerId:string, task:string, ok:boolean, error:string|null}>} [input.providerLog]
 * @param {{warnings:string[], errors:string[], conflicts:string[]}} [input.issues]
 * @param {object} [input.meta]
 * @param {object} [input.settings]
 */
export function buildReport(input = {}) {
  const meta = buildMeta(input.meta ?? {});
  const includeSensitive = meta.includeSensitive;
  const modules = input.modules ?? {};

  /** @type {ReportSection[]} */
  const sections = [];
  for (const definition of SECTION_ORDER) {
    const fields = modules[definition.id];
    if (!fields) continue;
    const aggregated = aggregateStatus(fields);
    sections.push({
      id: definition.id,
      title: definition.title,
      status: aggregated.status,
      rows: fieldsToRows(fields, { includeSensitive }),
      note: aggregated.note
    });
  }

  // Any module the runner produced that is not in the canonical order still gets
  // reported rather than silently dropped.
  for (const [id, fields] of Object.entries(modules)) {
    if (SECTION_ORDER.some((definition) => definition.id === id)) continue;
    const title = input.sectionTitles?.[id] ?? humaniseKey(id);
    sections.push({ id, title, status: aggregateStatus(fields).status, rows: fieldsToRows(fields, { includeSensitive }), note: aggregateStatus(fields).note });
  }

  const manualResults = (input.manualResults ?? []).map((result) => ({
    id: result.id,
    title: result.title,
    status: result.status,
    observedAt: result.observedAt,
    notes: result.notes ?? []
  }));

  const coverage = computeCoverage(sections, manualResults);

  const report = {
    meta,
    kind: meta.kind,
    sections,
    manualResults,
    assessment: input.assessment ?? null,
    coverage,
    issues: {
      warnings: [...(input.issues?.warnings ?? [])],
      errors: [...(input.issues?.errors ?? [])],
      conflicts: [...(input.issues?.conflicts ?? [])]
    },
    providerLog: (input.providerLog ?? []).map((entry) => ({
      provider: entry.providerId,
      task: entry.task,
      ok: Boolean(entry.ok),
      error: entry.error ?? null
    })),
    generatedWith: {
      includeSensitive,
      includeManualResults: input.settings?.includeManualResults !== false,
      includeCertificate: input.settings?.includeCertificate !== false
    }
  };

  if (report.generatedWith.includeManualResults === false) {
    report.manualResults = [];
    report.coverage = computeCoverage(sections, []);
  }

  // Redaction summary: the reader must be able to tell "withheld" from "absent".
  const privacyPolicy = {
    includeSensitive,
    allowNetwork: Boolean(input.privacy?.allowNetwork),
    persistHistory: input.privacy?.persistHistory !== false
  };
  // Summarised from the *source* module maps, not from the rendered rows: the
  // rows already carry the placeholder, so counting them would always report zero.
  report.privacy = {
    ...summariseRedactions(Object.values(modules), privacyPolicy),
    screenedSections: sections.length,
    guard: input.privacy?.guard ?? null
  };

  return report;
}

/**
 * Aggregate a field map into one status, using the same precedence as sections.
 * @param {Record<string, import('../core/field.js').FieldValue>} fields
 */
export function aggregateStatus(fields) {
  const values = Object.values(fields ?? {}).filter(Boolean);
  if (values.length === 0) return { status: Status.UNAVAILABLE, note: 'No data was collected for this section.' };

  const failing = values.filter((value) => value.status === Status.FAIL);
  if (failing.length > 0) return { status: Status.FAIL, note: `${failing.length} field(s) failed.` };

  const warnings = values.filter((value) => value.status === Status.WARNING);
  const present = values.filter((value) => value.status === Status.PASS || value.status === Status.WARNING || value.status === Status.PARTIALLY_AVAILABLE);

  if (present.length === values.length) {
    return warnings.length > 0
      ? { status: Status.WARNING, note: `${warnings.length} field(s) warrant attention.` }
      : { status: Status.PASS, note: null };
  }
  if (present.length > 0) return { status: Status.PARTIALLY_AVAILABLE, note: `${present.length} of ${values.length} fields reported.` };

  const errored = values.filter((value) => value.status === Status.ERROR);
  if (errored.length > 0) return { status: Status.ERROR, note: `${errored.length} field(s) could not be collected.` };
  const blocked = values.filter((value) => value.status === Status.PERMISSION_REQUIRED);
  if (blocked.length > 0) return { status: Status.PERMISSION_REQUIRED, note: 'Administrative rights are required for this section.' };
  return { status: Status.UNAVAILABLE, note: 'No provider on this device exposes this data.' };
}

/**
 * Coverage maths: which checks were applicable, which ran, and which were blocked.
 *
 * Coverage and health score are deliberately separate numbers; the brief requires
 * that distinction and so does the report.
 *
 * @param {ReportSection[]} sections
 * @param {Array<{status:string}>} manualResults
 */
export function computeCoverage(sections, manualResults = []) {
  let total = 0;
  let passed = 0;
  let failed = 0;
  let warned = 0;
  let untested = 0;
  let blocked = 0;
  let unsupported = 0;

  for (const section of sections) {
    for (const row of section.rows) {
      total += 1;
      switch (row.status) {
        case Status.PASS:
          passed += 1;
          break;
        case Status.FAIL:
          failed += 1;
          break;
        case Status.WARNING:
        case Status.PARTIALLY_AVAILABLE:
          warned += 1;
          break;
        case Status.UNTESTED:
          untested += 1;
          break;
        case Status.PERMISSION_REQUIRED:
        case Status.ERROR:
          blocked += 1;
          break;
        case Status.UNAVAILABLE:
        case Status.UNSUPPORTED:
        case Status.NOT_APPLICABLE:
          unsupported += 1;
          break;
        default:
          untested += 1;
      }
    }
  }

  for (const result of manualResults) {
    total += 1;
    if (result.status === Status.PASS) passed += 1;
    else if (result.status === Status.FAIL) failed += 1;
    else if (result.status === Status.WARNING) warned += 1;
    else if (result.status === Status.UNTESTED) untested += 1;
    else if (result.status === Status.UNSUPPORTED) unsupported += 1;
    else untested += 1;
  }

  const assessed = passed + failed + warned;
  return {
    totalFields: total,
    passed,
    failed,
    warned,
    untested,
    blocked,
    unsupported,
    assessed,
    coveragePercent: total === 0 ? 0 : Math.round((assessed / total) * 1000) / 10,
    note: 'Coverage counts fields that produced an assessment. Unavailable, unsupported, blocked and untested items are excluded from coverage rather than counted as passes.'
  };
}

/**
 * Flat rows for CSV and for any consumer that wants a table.
 * @param {object} report
 * @returns {Array<Record<string, unknown>>}
 */
export function flattenReport(report) {
  const rows = [];
  for (const section of report.sections) {
    for (const row of section.rows) {
      rows.push({
        section: section.title,
        sectionStatus: statusLabel(section.status),
        field: row.label,
        key: row.key,
        value: formatValue(row.value, row.unit),
        status: statusLabel(row.status),
        source: row.source ?? '',
        confidence: row.confidence,
        collectedAt: row.collectedAt ?? '',
        detail: row.error ?? '',
        notes: row.notes.join(' ')
      });
    }
  }
  for (const result of report.manualResults) {
    rows.push({
      section: 'Manual inspection',
      sectionStatus: statusLabel(result.status),
      field: result.title,
      key: result.id,
      value: statusLabel(result.status),
      status: statusLabel(result.status),
      source: 'manual observation',
      confidence: 'NONE',
      collectedAt: result.observedAt,
      detail: '',
      notes: result.notes.join(' ')
    });
  }
  return rows;
}

/**
 * Render a value for display, keeping unit and type distinct.
 * @param {unknown} value
 * @param {string|null} unit
 */
export function formatValue(value, unit = null) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    const rendered = value.map((entry) => (typeof entry === 'object' ? JSON.stringify(entry) : String(entry)));
    return rendered.join('; ');
  }
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return unit ? `${value} ${unit}` : String(value);
}
