/**
 * VERIDEX — Field envelope and section model.
 *
 * Every piece of collected data is wrapped in a FieldValue. A bare number is
 * never allowed to float through the system, because a bare number cannot say
 * where it came from, when, whether it was validated, or whether the absence of
 * a value means "not supported" or "provider crashed". The envelope makes the
 * honesty requirements structural instead of aspirational.
 */

import { Status, hasValue, toStatus, DATA_ABSENT_EXPECTED, DATA_BLOCKED, DATA_FAILED } from './status.js';

/**
 * How much trust the *source* of a value deserves, combined with whether the
 * value passed validation. This is explicitly NOT a statement about
 * measurement accuracy — see docs/ARCHITECTURE.md §Confidence.
 */
export const Confidence = Object.freeze({
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  NONE: 'NONE'
});

const CONFIDENCE_ORDER = Object.freeze({ NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3 });

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean} true when a is at least as trustworthy as b
 */
export function confidenceAtLeast(a, b) {
  return (CONFIDENCE_ORDER[a] ?? -1) >= (CONFIDENCE_ORDER[b] ?? -1);
}

/** Value kinds used by the UI renderer and by validators. */
export const ValueType = Object.freeze({
  STRING: 'string',
  NUMBER: 'number',
  BOOLEAN: 'boolean',
  ARRAY: 'array',
  OBJECT: 'object',
  NONE: 'none'
});

/** @param {unknown} value */
export function inferType(value) {
  if (value === null || value === undefined) return ValueType.NONE;
  if (Array.isArray(value)) return ValueType.ARRAY;
  if (typeof value === 'number') return Number.isFinite(value) ? ValueType.NUMBER : ValueType.NONE;
  if (typeof value === 'boolean') return ValueType.BOOLEAN;
  if (typeof value === 'object') return ValueType.OBJECT;
  return ValueType.STRING;
}

/**
 * @typedef {object} FieldValue
 * @property {unknown} value          Parsed value, or null when absent.
 * @property {import('./status.js').StatusName} status
 * @property {string|null} source     Provider id that produced the value.
 * @property {string} collectedAt     ISO-8601 UTC timestamp.
 * @property {string|null} unit       Unit label ('MHz', 'GB', '°C', ...).
 * @property {string} type            One of ValueType.
 * @property {boolean} permissionRequired
 * @property {string|null} error      Error detail for ERROR/UNKNOWN statuses.
 * @property {string} confidence      One of Confidence.
 * @property {string[]} notes         Free-form caveats shown to the user.
 * @property {string|null} raw        Untouched provider payload for provenance.
 */

/**
 * Core factory. Prefer the named helpers below; this exists so every helper
 * produces an identically shaped object.
 * @param {unknown} value
 * @param {object} options
 * @returns {FieldValue}
 */
export function field(value, options = {}) {
  const {
    status = inferType(value) === ValueType.NONE ? Status.UNAVAILABLE : Status.PASS,
    source = null,
    unit = null,
    type = null,
    permissionRequired = false,
    error = null,
    confidence = null,
    notes = [],
    raw = null,
    collectedAt = new Date().toISOString()
  } = options;

  const normalisedStatus = toStatus(status);
  const resolvedType = type ?? inferType(value);

  // Structural invariant: a status that claims data is present must actually
  // carry a value. Catching this here means no downstream renderer has to
  // defend against "PASS with null".
  if (hasValue(normalisedStatus) && normalisedStatus !== Status.PARTIALLY_AVAILABLE && inferType(value) === ValueType.NONE) {
    throw new TypeError(
      `Field invariant violated: status ${normalisedStatus} requires a value, received none. Use a non-data status instead.`
    );
  }

  return Object.freeze({
    value: inferType(value) === ValueType.NONE ? null : value,
    status: normalisedStatus,
    source,
    collectedAt,
    unit,
    type: resolvedType,
    permissionRequired: Boolean(permissionRequired),
    error,
    confidence: confidence ?? (hasValue(normalisedStatus) ? Confidence.MEDIUM : Confidence.NONE),
    notes: Object.freeze([...notes]),
    raw
  });
}

/** Data present and usable. */
export function available(value, source, options = {}) {
  return field(value, { ...options, source, status: options.status ?? Status.PASS });
}

/** A value that is present but sits in a warning range. */
export function warning(value, source, options = {}) {
  return field(value, { ...options, source, status: Status.WARNING });
}

/**
 * Build a field from a raw value that has to be converted first, where the conversion can
 * fail to produce a number.
 *
 * `bytesToGiB(0)` returns `null`: "0 bytes" and "not reported" are different answers, and
 * a zero-size device is nonsense. But `available(null)` is a contradiction - a field that
 * claims a value while carrying none - so it throws, and on a real machine one 0-byte
 * device took down the whole memory task with an invariant violation. This helper makes
 * the conversion's absence an honest `unavailable` instead. It cannot be forgotten by
 * writing the two-step version, because there is only one step.
 *
 * @param {unknown} value        Raw value fed to the converter.
 * @param {(value: unknown) => number|null} convert
 * @param {string|null} source
 * @param {{unit?: string|null, notes?: string[], missing?: string, warningBelow?: number|null}} [options]
 * @returns {FieldValue}
 */
export function measured(value, convert, source, options = {}) {
  const { unit = null, notes = [], missing = 'Value not reported' } = options;
  const converted = convert(value);
  if (converted === null || converted === undefined || !Number.isFinite(Number(converted))) {
    return unavailable(missing, source, { notes, unit });
  }
  return available(converted, source, { unit, notes });
}

/** No provider on this device can supply the data. */
export function unavailable(reason, source = null, options = {}) {
  return field(null, {
    ...options,
    source,
    status: Status.UNAVAILABLE,
    error: options.error ?? reason ?? null,
    confidence: Confidence.NONE
  });
}

/** The platform does not support this capability at all. */
export function unsupported(reason, source = null, options = {}) {
  return field(null, {
    ...options,
    source,
    status: Status.UNSUPPORTED,
    error: options.error ?? reason ?? null,
    confidence: Confidence.NONE
  });
}

/** Legitimately not applicable to this device. */
export function notApplicable(reason, source = null, options = {}) {
  return field(null, {
    ...options,
    source,
    status: Status.NOT_APPLICABLE,
    error: options.error ?? reason ?? null,
    confidence: Confidence.NONE
  });
}

/** The data exists but needs elevation the process does not have. */
export function permissionRequired(reason, source = null, options = {}) {
  return field(null, {
    ...options,
    source,
    status: Status.PERMISSION_REQUIRED,
    permissionRequired: true,
    error: options.error ?? reason ?? null,
    confidence: Confidence.NONE
  });
}

/** A provider ran and failed. Always keeps the error detail. */
export function failed(error, source = null, options = {}) {
  const message = error instanceof Error ? error.message : String(error ?? 'Provider failed');
  return field(null, {
    ...options,
    source,
    status: Status.ERROR,
    error: message,
    confidence: Confidence.NONE
  });
}

/** A test that is applicable but has not been executed. */
export function untested(reason = 'Not run yet', options = {}) {
  return field(null, { ...options, status: Status.UNTESTED, error: null, confidence: Confidence.NONE, notes: [reason, ...(options.notes ?? [])] });
}

/** A provider responded but the payload could not be interpreted. */
export function unknownValue(reason, source = null, options = {}) {
  return field(null, { ...options, source, status: Status.UNKNOWN, error: reason ?? null, confidence: Confidence.NONE });
}

/**
 * A section is a labelled group of fields (one hardware module, one test group).
 * @typedef {object} Section
 * @property {string} id
 * @property {string} title
 * @property {Record<string, FieldValue>} fields
 * @property {import('./status.js').StatusName} status   Aggregate status.
 * @property {{ok:number, warning:number, missing:number, blocked:number, failed:number, total:number}} counts
 */

/**
 * Build a section and aggregate its status from its fields.
 * Aggregation rules (documented in docs/ARCHITECTURE.md):
 *  - no fields              -> UNAVAILABLE
 *  - all fields carry data  -> PASS (downgraded to WARNING if any warning)
 *  - some fields carry data -> PARTIALLY_AVAILABLE
 *  - none carry data        -> UNAVAILABLE / PERMISSION_REQUIRED / ERROR by precedence
 * @param {string} id
 * @param {string} title
 * @param {Record<string, FieldValue>} fields
 * @returns {Section}
 */
export function section(id, title, fields) {
  const values = Object.values(fields);
  const counts = values.reduce(
    (acc, f) => {
      if (hasValue(f.status)) acc.ok += 1;
      if (f.status === Status.WARNING) acc.warning += 1;
      if (f.status === Status.PARTIALLY_AVAILABLE) acc.warning += 1;
      // The categories live in status.js, which also documents what each one means. They were
      // written out again here, so adding a status to the vocabulary silently left this
      // counting function behind: a new status would have counted as neither missing nor
      // blocked, and the section would have reported more evidence than it had.
      if (DATA_ABSENT_EXPECTED.includes(f.status)) acc.missing += 1;
      if (DATA_BLOCKED.includes(f.status)) acc.blocked += 1;
      if (DATA_FAILED.includes(f.status)) acc.failed += 1;
      return acc;
    },
    { ok: 0, warning: 0, missing: 0, blocked: 0, failed: 0, total: values.length }
  );

  // FAIL was in no counter, so a module whose only readings were failing (a worn battery, a
  // drive reporting a critical warning) summarised as UNAVAILABLE: the interface said "no data"
  // about the one thing it had measured. A failure is evidence, and a section that holds one has
  // to say so.
  let status;
  if (counts.total === 0) {
    status = Status.UNAVAILABLE;
  } else if (counts.ok === counts.total) {
    status = counts.warning > 0 ? Status.WARNING : Status.PASS;
  } else if (counts.failed > 0) {
    // Mixed with anything that did resolve, the honest label is WARNING: some of the module is
    // fine, one reading is not. Only a section where nothing but the failure resolved is FAIL.
    status = counts.ok > 0 || counts.warning > 0 || counts.missing > 0 || counts.blocked > 0 ? Status.WARNING : Status.FAIL;
  } else if (counts.ok > 0) {
    status = Status.PARTIALLY_AVAILABLE;
  } else if (values.every((f) => f.status === Status.PERMISSION_REQUIRED)) {
    status = Status.PERMISSION_REQUIRED;
  } else if (values.some((f) => f.status === Status.ERROR)) {
    status = Status.ERROR;
  } else if (values.some((f) => f.status === Status.UNKNOWN)) {
    status = Status.UNKNOWN;
  } else {
    status = Status.UNAVAILABLE;
  }

  return Object.freeze({ id, title, fields: Object.freeze({ ...fields }), status, counts: Object.freeze(counts) });
}

/**
 * Flatten sections into rows for reports, CSV and the UI table renderer.
 * @param {Section[]} sections
 * @returns {Array<{section:string, sectionTitle:string, key:string, value:unknown, unit:string|null, status:string, source:string|null, collectedAt:string, confidence:string, error:string|null, notes:string[]}>}
 */
export function sectionRows(sections) {
  const rows = [];
  for (const s of sections) {
    for (const [key, f] of Object.entries(s.fields)) {
      rows.push({
        section: s.id,
        sectionTitle: s.title,
        key,
        value: f.value,
        unit: f.unit,
        status: f.status,
        source: f.source,
        collectedAt: f.collectedAt,
        confidence: f.confidence,
        error: f.error,
        notes: [...f.notes]
      });
    }
  }
  return rows;
}

/** Count how many fields in a set of sections carry usable data. */
export function coverageOf(sections) {
  let total = 0;
  let present = 0;
  for (const s of sections) {
    for (const f of Object.values(s.fields)) {
      total += 1;
      if (hasValue(f.status)) present += 1;
    }
  }
  return { present, total, percent: total === 0 ? 0 : Math.round((present / total) * 1000) / 10 };
}
