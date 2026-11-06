/**
 * VERIDEX — Diagnostic status vocabulary.
 *
 * Every value and every test result in VERIDEX carries exactly one of these
 * statuses. The set is deliberately fine-grained: collapsing UNSUPPORTED,
 * UNAVAILABLE and PERMISSION_REQUIRED into a single "unknown" bucket is what
 * turns honest diagnostics into misleading ones, so they are kept distinct here
 * and rendered distinctly in the UI and in reports.
 *
 * Nothing in this module inspects hardware. It is pure vocabulary so that the
 * engine, the renderer and the report writers can never disagree on meaning.
 */

/** @typedef {'PASS'|'FAIL'|'WARNING'|'UNKNOWN'|'UNAVAILABLE'|'UNSUPPORTED'|'UNTESTED'|'PERMISSION_REQUIRED'|'ERROR'|'PARTIALLY_AVAILABLE'|'NOT_APPLICABLE'|'UNRATED'} StatusName */

/**
 * Canonical status names. Frozen so a typo becomes a startup error instead of a
 * silently rendered empty badge.
 */
export const Status = Object.freeze({
  /** Data was collected and validated, or a test was executed and met criteria. */
  PASS: 'PASS',
  /** A test ran and the measured/observed result is outside the expected range. */
  FAIL: 'FAIL',
  /** Data is present but sits in a range that warrants attention. */
  WARNING: 'WARNING',
  /** The provider returned something we could not interpret with confidence. */
  UNKNOWN: 'UNKNOWN',
  /** No provider on this device can expose this data. Not an error. */
  UNAVAILABLE: 'UNAVAILABLE',
  /** The platform/hardware does not support the concept at all. */
  UNSUPPORTED: 'UNSUPPORTED',
  /** A test exists and is applicable but the user has not run it yet. */
  UNTESTED: 'UNTESTED',
  /** The data exists but requires elevation the current process lacks. */
  PERMISSION_REQUIRED: 'PERMISSION_REQUIRED',
  /** A provider was expected to work and failed. Always carries an error note. */
  ERROR: 'ERROR',
  /** Some fields resolved, others did not. Partial truth, explicitly labelled. */
  PARTIALLY_AVAILABLE: 'PARTIALLY_AVAILABLE',
  /** Legitimately not applicable, e.g. cycle count on a device with no battery. */
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  /** Health/report scoring could not be computed from insufficient evidence. */
  UNRATED: 'UNRATED'
});

/** Presentation metadata. `tone` maps to a design-system colour token. */
export const STATUS_META = Object.freeze({
  PASS: { label: 'Pass', tone: 'ok', description: 'Collected and validated, or tested with a satisfactory result.' },
  FAIL: { label: 'Fail', tone: 'bad', description: 'Test executed and the result is outside the acceptable range.' },
  WARNING: { label: 'Warning', tone: 'warn', description: 'Value or observation warrants attention but is not a failure.' },
  UNKNOWN: { label: 'Unknown', tone: 'warn', description: 'A provider responded but the value could not be interpreted reliably.' },
  UNAVAILABLE: { label: 'Unavailable', tone: 'muted', description: 'No provider on this device exposes this data.' },
  UNSUPPORTED: { label: 'Unsupported', tone: 'muted', description: 'This platform or hardware does not support the capability.' },
  UNTESTED: { label: 'Untested', tone: 'muted', description: 'Applicable, but the test has not been run yet.' },
  PERMISSION_REQUIRED: { label: 'Permission required', tone: 'warn', description: 'The data exists but needs elevation the current process lacks.' },
  ERROR: { label: 'Error', tone: 'bad', description: 'A provider was expected to succeed and failed. See error detail.' },
  PARTIALLY_AVAILABLE: { label: 'Partially available', tone: 'warn', description: 'Some fields resolved; others did not. Missing fields are listed individually.' },
  NOT_APPLICABLE: { label: 'Not applicable', tone: 'muted', description: 'Legitimately not applicable to this device or configuration.' },
  UNRATED: { label: 'Unrated', tone: 'muted', description: 'Insufficient evidence to compute a score.' }
});

const ALL = Object.freeze(Object.keys(Status));

/** Every status name, in declaration order. Exported so tests can prove the categories are total. */
export const ALL_STATUSES = ALL;

/** @param {unknown} name */
export function isStatus(name) {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(Status, name);
}

/**
 * Assert-and-normalise a status name.
 * @param {unknown} name
 * @returns {StatusName}
 */
export function toStatus(name) {
  if (!isStatus(name)) {
    throw new TypeError(`Unknown VERIDEX status: ${String(name)}. Expected one of: ${ALL.join(', ')}`);
  }
  return /** @type {StatusName} */ (name);
}

/** Statuses that mean "we have a usable value". */
export const DATA_PRESENT = Object.freeze([Status.PASS, Status.WARNING, Status.PARTIALLY_AVAILABLE]);

/** Statuses that mean "no value, and that is not a bug". */
export const DATA_ABSENT_EXPECTED = Object.freeze([
  Status.UNAVAILABLE,
  Status.UNSUPPORTED,
  Status.NOT_APPLICABLE,
  Status.UNTESTED,
  // UNRATED belongs here rather than nowhere: it means "no usable evidence to weigh", which is
  // the same shape as the others. It was in none of the three categories, so a field carrying it
  // counted as neither present, missing nor blocked and disappeared from the section summary.
  Status.UNRATED
]);

/** Statuses that need the user (or an admin) to do something. */
export const DATA_BLOCKED = Object.freeze([Status.PERMISSION_REQUIRED, Status.ERROR, Status.UNKNOWN]);

/** Data that exists and whose value is bad news: a failing test or a value outside range. */
export const DATA_FAILED = Object.freeze([Status.FAIL]);

/** Terminal outcomes of an executed test, used by coverage maths. */
export const OUTCOME_STATUSES = Object.freeze([Status.PASS, Status.FAIL, Status.WARNING]);

/** @param {StatusName} status */
export function hasValue(status) {
  return DATA_PRESENT.includes(status);
}

/** @param {StatusName} status */
export function isOutcome(status) {
  return OUTCOME_STATUSES.includes(status);
}

/**
 * Sorting weight for report ordering: problems first, facts later.
 * @param {StatusName} status
 */
export function severityRank(status) {
  switch (status) {
    case Status.FAIL:
      return 0;
    case Status.ERROR:
      return 1;
    case Status.WARNING:
      return 2;
    case Status.PERMISSION_REQUIRED:
      return 3;
    case Status.PARTIALLY_AVAILABLE:
      return 4;
    case Status.UNKNOWN:
      return 5;
    case Status.UNRATED:
      return 6;
    case Status.UNTESTED:
      return 7;
    case Status.PASS:
      return 8;
    case Status.UNAVAILABLE:
      return 9;
    case Status.UNSUPPORTED:
      return 10;
    case Status.NOT_APPLICABLE:
      return 11;
    default:
      return 12;
  }
}

/** Design-token tone for a status, used by renderer badges and report cells. */
export function statusTone(status) {
  return STATUS_META[status]?.tone ?? 'muted';
}

/** Human label, falling back to the raw name for forward compatibility. */
export function statusLabel(status) {
  return STATUS_META[status]?.label ?? String(status);
}
