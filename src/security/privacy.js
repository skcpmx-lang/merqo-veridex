/**
 * VERIDEX — Privacy policy and redaction.
 *
 * This module is the single owner of "what may leave the machine". Two things
 * follow from that ownership:
 *
 *  1. Redaction is applied to *data*, not to output formats. The report model
 *     runs `redactSections()` before a renderer is ever called, so a format added
 *     later cannot leak a serial number by forgetting to redact.
 *  2. Every policy decision maps to a real setting. `src/core/settings.js` declares
 *     `diagnostics.includeSensitiveInReport` and `diagnostics.persistHistory`
 *     with `appliesTo: 'src/security/privacy.js'`, and this file consumes both, so
 *     the toggle is not decorative.
 *
 * Nothing here performs network access or writes outside the application data
 * directory; `src/security/guard.js` enforces both.
 */

import { Status } from '../core/status.js';
import { SENSITIVE_KEYS } from '../core/sensitive.js';

/**
 * Field-name fragments that identify a person or a specific device.
 * Matching is done on a normalised (lowercase, alphanumeric-only) key, so
 * `serial_number`, `serialNumber` and `SerialNumber` all match `serialnumber`.
 */
export const PRIVACY_SENSITIVE = Object.freeze([
  'serialnumber',
  'serial',
  'boardserial',
  'biosserial',
  'macaddress',
  'ipaddress',
  'ipv4',
  'ipv6',
  'hostname',
  'computername',
  'registereduser',
  'username',
  'accountname',
  'deviceid',
  'machineguid',
  'windowsproductid',
  'productkey',
  'ssid'
]);

/**
 * Display categories for the redaction summary. Order matters: the first match
 * wins, so more specific names are listed before their generic parents.
 */
export const PRIVACY_CATEGORIES = Object.freeze([
  { id: 'network', label: 'Network addresses and names', keys: ['macaddress', 'ipaddress', 'ipv4', 'ipv6', 'hostname', 'computername', 'ssid'] },
  { id: 'serial', label: 'Serial numbers', keys: ['serialnumber', 'serial', 'boardserial', 'biosserial'] },
  { id: 'licence', label: 'Licence and product identifiers', keys: ['windowsproductid', 'productkey', 'deviceid', 'machineguid'] },
  { id: 'account', label: 'Account names', keys: ['registereduser', 'username', 'accountname'] }
]);

/** @param {string} value */
function normalise(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Is this field name personal or device-identifying?
 * Both this module's list and the logger's list are consulted: a key removed from
 * one list must not silently become exportable.
 * @param {string} key
 */
export function isPrivateField(key) {
  const target = normalise(key);
  if (!target) return false;
  const hit = (list) => list.some((entry) => target.includes(normalise(entry)));
  if (hit(PRIVACY_SENSITIVE)) return true;
  // The logger list is broad (`user`, `token`); require a little specificity so a
  // key like "userFacingNote" does not get redacted as an account name.
  return SENSITIVE_KEYS.some((entry) => {
    const needle = normalise(entry);
    return needle.length >= 5 && target.includes(needle);
  });
}

/** @param {string} key  @returns {string} */
export function privacyCategory(key) {
  const target = normalise(key);
  const found = PRIVACY_CATEGORIES.find((category) => category.keys.some((entry) => target.includes(normalise(entry))));
  return found?.id ?? 'other';
}

export const REDACTION_PLACEHOLDER = '[redacted]';

/**
 * Redact one FieldValue. The replacement keeps the field, its status and its
 * source, and appends a note explaining why it is blank — a silently missing
 * value is indistinguishable from a collection failure, and the brief forbids
 * hiding that difference.
 *
 * @param {import('../core/field.js').FieldValue} value
 * @param {string} key
 * @param {boolean} includeSensitive
 */
export function redactField(value, key, includeSensitive) {
  if (!value) return value;
  if (includeSensitive || !isPrivateField(key)) return value;
  if (value.value === null || value.value === undefined) return value;
  const reason = 'Redacted because "Include serial numbers and addresses in reports" is off in Privacy settings.';
  return Object.freeze({
    ...value,
    value: REDACTION_PLACEHOLDER,
    notes: Object.freeze([...(value.notes ?? []), reason])
  });
}

/**
 * @typedef {object} PrivacyPolicy
 * @property {boolean} includeSensitive  Export serial numbers, MACs, account names.
 * @property {boolean} allowNetwork      Permit outbound requests (off by default).
 * @property {boolean} persistHistory    Keep completed runs on disk.
 * @property {boolean} includeManualResults
 * @property {number}  historyLimit
 * @property {string}  source            Where the policy came from, for the log.
 */

/**
 * Build a policy from a settings store or a plain values object.
 *
 * Defaults are the private ones. A missing or unreadable settings file therefore
 * degrades towards *less* disclosure, never more.
 *
 * @param {{get?:(key:string)=>unknown, all?:()=>Record<string,unknown>}|Record<string,unknown>} [settings]
 * @returns {PrivacyPolicy}
 */
export function buildPrivacyPolicy(settings = {}) {
  // Guarded because this runs on a null settings object more often than you would
  // like: a failed load, a first run, or a caller with no store at all.
  const isStore = (candidate) => Boolean(candidate) && typeof (/** @type {any} */ (candidate).get) === 'function';

  const read = (key, fallback) => {
    try {
      if (typeof (/** @type {any} */ (settings).get) === 'function') {
        const value = /** @type {any} */ (settings).get(key);
        return value === undefined ? fallback : value;
      }
      const value = /** @type {Record<string, unknown>} */ (settings)[key];
      return value === undefined ? fallback : value;
    } catch {
      return fallback;
    }
  };

  return Object.freeze({
    includeSensitive: read('diagnostics.includeSensitiveInReport', false) === true,
    allowNetwork: read('privacy.allowNetwork', false) === true,
    persistHistory: read('diagnostics.persistHistory', true) === true,
    includeManualResults: read('reports.includeManualResults', true) === true,
    historyLimit: Number(read('diagnostics.historyLimit', 50)) || 50,
    source: isStore(settings) ? 'settings store' : 'plain values'
  });
}

/**
 * Presets are shortcuts over the same real setting keys — applying one calls
 * `SettingsStore.set`, so the change is persisted and visible in the UI. No preset
 * enables network access; that flag is deliberately not part of any preset.
 */
export const PRIVACY_PRESETS = Object.freeze({
  private: {
    label: 'Private (recommended)',
    description: 'Serial numbers, addresses and account names are redacted from every export. History stays on this device.',
    values: {
      'diagnostics.includeSensitiveInReport': false,
      'diagnostics.persistHistory': true,
      'reports.includeManualResults': true
    }
  },
  minimalTrace: {
    label: 'Leave no trace',
    description: 'Everything Private does, plus no diagnostic history is written to disk at all.',
    values: {
      'diagnostics.includeSensitiveInReport': false,
      'diagnostics.persistHistory': false,
      'reports.includeManualResults': true
    }
  },
  workshop: {
    label: 'Workshop handover',
    description: 'Includes serial numbers and addresses so a workshop can match the report to a physical machine. Only use for a machine you own or are authorised to inspect.',
    values: {
      'diagnostics.includeSensitiveInReport': true,
      'diagnostics.persistHistory': true,
      'reports.includeManualResults': true
    }
  }
});

/**
 * Apply a preset through the settings store so persistence, validation and the
 * UI all see the same change.
 * @param {import('../core/settings.js').SettingsStore} store
 * @param {keyof typeof PRIVACY_PRESETS} presetId
 */
export async function applyPrivacyPreset(store, presetId) {
  const preset = PRIVACY_PRESETS[presetId];
  if (!preset) throw new Error(`Unknown privacy preset "${presetId}"`);
  const results = await store.setMany(preset.values);
  const failed = Object.entries(results).filter(([, result]) => !result.ok);
  return { ok: failed.length === 0, presetId, applied: results, failures: failed };
}

/**
 * Redact a field map (one section's fields).
 * @param {Record<string, import('../core/field.js').FieldValue>} fields
 * @param {PrivacyPolicy} policy
 */
export function redactFields(fields, policy) {
  /** @type {Record<string, import('../core/field.js').FieldValue>} */
  const out = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    out[key] = redactField(value, key, policy.includeSensitive);
  }
  return out;
}

/**
 * Redact a set of sections, preserving section identity and recomputing nothing —
 * status and counts belong to the caller's `section()` helper, and redaction does
 * not change a status (a redacted serial is still a known value; it is withheld,
 * not missing).
 *
 * @param {import('../core/field.js').Section[]} sections
 * @param {PrivacyPolicy} policy
 */
export function redactSections(sections, policy) {
  if (policy?.includeSensitive) return sections;
  return sections.map((entry) =>
    Object.freeze({
      ...entry,
      fields: Object.freeze(redactFields(entry.fields, policy))
    })
  );
}

/**
 * @typedef {object} RedactionSummary
 * @property {number} redactedFields
 * @property {Array<{category:string, label:string, count:number, keys:string[]}>} categories
 * @property {string} statement
 */

/**
 * Summarise what was withheld, so a reader knows the report is incomplete rather
 * than concluding the machine has no serial number.
 * @param {import('../core/field.js').Section[]} sections
 * @param {PrivacyPolicy} policy
 * @returns {RedactionSummary}
 */
export function summariseRedactions(sections, policy) {
  /** @type {Map<string, {keys:Set<string>, count:number}>} */
  const byCategory = new Map();
  let total = 0;

  if (!policy?.includeSensitive) {
    for (const entry of sections ?? []) {
      // Accepts either a Section ({fields}) or a bare field map, because callers
      // hold one or the other depending on where in the pipeline they sit.
      const fields = entry?.fields ?? entry ?? {};
      for (const [key, value] of Object.entries(fields)) {
        if (!isPrivateField(key)) continue;
        if (value?.value === null || value?.value === undefined) continue;
        total += 1;
        const category = privacyCategory(key);
        const bucket = byCategory.get(category) ?? { keys: new Set(), count: 0 };
        bucket.keys.add(key);
        bucket.count += 1;
        byCategory.set(category, bucket);
      }
    }
  }

  return {
    redactedFields: total,
    categories: [...byCategory.entries()].map(([id, bucket]) => ({
      category: id,
      label: PRIVACY_CATEGORIES.find((category) => category.id === id)?.label ?? 'Other identifiers',
      count: bucket.count,
      keys: [...bucket.keys].sort()
    })),
    statement:
      total === 0
        ? policy?.includeSensitive
          ? 'Sensitive values are included in this export because the Privacy setting was turned on for this run.'
          : 'No device-identifying values were present in this report.'
        : `${total} device-identifying value(s) were withheld from this export by the Privacy setting. Fields are shown as "${REDACTION_PLACEHOLDER}" and keep their source and collection time.`
  };
}

/**
 * The guarantees advertised on the privacy screen, expressed as data so the UI
 * cannot drift from the implementation. `enforcedBy` names the module that makes
 * the claim true.
 */
export const PRIVACY_GUARANTEES = Object.freeze([
  {
    id: 'offline',
    title: 'No diagnostic data leaves this device',
    detail: 'VERIDEX performs no network access unless you enable it. The outbound guard blocks and logs any attempt made by application code.',
    enforcedBy: 'src/security/guard.js'
  },
  {
    id: 'redaction',
    title: 'Identifiers are redacted before export',
    detail: 'Serial numbers, MAC and IP addresses, hostnames and account names are replaced in every format before a renderer runs, unless you opt in.',
    enforcedBy: 'src/security/privacy.js'
  },
  {
    id: 'local-history',
    title: 'History is stored locally and only locally',
    detail: 'Completed runs are written to the application data folder. You can turn history off entirely, or cap how many runs are kept.',
    enforcedBy: 'src/history/store.js'
  },
  {
    id: 'read-only',
    title: 'Diagnostics are read-only',
    detail: 'No formatting, partitioning, driver removal, registry cleaning or security disabling is performed. Whatever needs to change a system is listed with a warning and requires explicit consent.',
    enforcedBy: 'src/security/guard.js'
  },
  {
    id: 'no-secrets',
    title: 'Secrets are never collected',
    detail: 'Product keys, tokens and passwords are stripped from logs and cannot be reported: the collector refuses these field names and the logger masks them.',
    enforcedBy: 'src/core/logger.js'
  }
]);

/**
 * Count how many fields in a section set are withheld under a policy — used by the
 * dashboard's privacy card.
 * @param {import('../core/field.js').Section[]} sections
 * @param {PrivacyPolicy} policy
 */
export function withheldCount(sections, policy) {
  return summariseRedactions(sections, policy).redactedFields;
}

/**
 * Export gate. Every export path calls this; it returns a verdict the UI shows
 * before writing a file, so the user is told what the file will contain.
 * @param {PrivacyPolicy} policy
 * @param {{format:string}} options
 */
export function exportVerdict(policy, options = {}) {
  const format = String(options.format ?? 'unknown').toLowerCase();
  const sensitive = policy.includeSensitive === true;
  return {
    format,
    includeSensitive: sensitive,
    warnings: sensitive
      ? [
          'This export will contain serial numbers, network addresses and account names. Treat the file as personal data.',
          'If you are inspecting a machine you do not own, turn the Privacy setting off before exporting.'
        ]
      : [],
    statement: sensitive
      ? 'Identifiers are included in this file.'
      : 'Identifiers are redacted in this file.'
  };
}

/**
 * Guard used by the collection layer to refuse a field that should never be
 * gathered at all (product keys, passwords, tokens). Refusing at collection time
 * is stronger than redacting at export time.
 * @param {string} key
 * @returns {{allowed:boolean, reason:string|null}}
 */
export function mayCollectField(key) {
  const target = normalise(key);
  const forbidden = ['productkey', 'licensekey', 'password', 'token', 'bitlockerkey', 'recoverykey', 'apikey', 'secret'];
  const hit = forbidden.find((entry) => target.includes(entry));
  return hit
    ? { allowed: false, reason: `Field "${key}" is in the never-collect list (${hit}); VERIDEX does not read secrets.` }
    : { allowed: true, reason: null };
}

/**
 * Apply `mayCollectField` to a field map, replacing refused keys with an
 * UNSUPPORTED placeholder that names the rule. The placeholder keeps the key
 * visible so the report shows *why* the value is absent.
 * @param {Record<string, import('../core/field.js').FieldValue>} fields
 */
export function enforceNeverCollect(fields) {
  /** @type {Record<string, import('../core/field.js').FieldValue>} */
  const out = {};
  for (const [key, value] of Object.entries(fields ?? {})) {
    const verdict = mayCollectField(key);
    out[key] = verdict.allowed
      ? value
      : Object.freeze({
          value: null,
          status: Status.UNSUPPORTED,
          source: null,
          unit: null,
          collectedAt: new Date().toISOString(),
          confidence: 'unknown',
          error: null,
          notes: Object.freeze([verdict.reason ?? 'Not collected by policy.'])
        });
  }
  return out;
}
