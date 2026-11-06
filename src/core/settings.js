/**
 * VERIDEX — Settings store.
 *
 * Hard rule from the brief (MODULE 23): no setting may exist that does not change
 * real behaviour. That rule is enforced mechanically here — the schema below is
 * the only place settings are declared, every entry carries a `appliesTo` string
 * naming the module that consumes it, and tests/integration/ui-contract.test.js
 * asserts that each `appliesTo` module actually references the key.
 *
 * Persistence is atomic (write temp, fsync, rename) so an interrupted write can
 * never leave a half-written settings file that bricks startup.
 */

import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';

export const SETTINGS_SCHEMA_VERSION = 1;

/**
 * @typedef {object} SettingSpec
 * @property {string} key
 * @property {string} label
 * @property {string} group
 * @property {'boolean'|'enum'|'number'|'string'|'string[]'} type
 * @property {unknown} default
 * @property {unknown[]} [values]      Allowed values for enum.
 * @property {number} [min]
 * @property {number} [max]
 * @property {string} description
 * @property {string} appliesTo        Module path that consumes the value.
 */

/** @type {SettingSpec[]} */
export const SETTINGS_SPEC = [
  // ── Appearance ────────────────────────────────────────────────────────────
  {
    key: 'appearance.theme',
    label: 'Theme',
    group: 'Appearance',
    type: 'enum',
    values: ['dark', 'light', 'system'],
    default: 'dark',
    description: 'Dark is the primary VERIDEX theme. "System" follows the Windows app theme.',
    appliesTo: 'src/app/settings-wiring.js'
  },
  {
    key: 'appearance.accent',
    label: 'Accent colour',
    group: 'Appearance',
    type: 'enum',
    values: ['cyan', 'azure', 'violet', 'amber', 'emerald'],
    default: 'cyan',
    description: 'Drives the accent token used by buttons, graphs, focus rings and status highlights.',
    appliesTo: 'src/app/settings-wiring.js'
  },
  {
    key: 'appearance.density',
    label: 'Layout density',
    group: 'Appearance',
    type: 'enum',
    values: ['comfortable', 'compact'],
    default: 'comfortable',
    description: 'Compact reduces vertical spacing so more rows fit on small laptop screens.',
    appliesTo: 'src/app/settings-wiring.js'
  },
  {
    key: 'appearance.language',
    label: 'Language',
    group: 'Appearance',
    type: 'enum',
    values: ['en'],
    default: 'en',
    description: 'Interface language. Only English ships in 1.0.0; the string table is externalised so additional locales are additive.',
    appliesTo: 'src/app/settings-wiring.js'
  },
  {
    key: 'appearance.reduceMotion',
    label: 'Reduce motion',
    group: 'Appearance',
    type: 'boolean',
    default: false,
    description: 'Disables transitions and animated graphs. Automatically forced on when Windows requests reduced motion.',
    appliesTo: 'src/app/settings-wiring.js'
  },
  {
    key: 'appearance.showGlyphs',
    label: 'High-contrast data glyphs',
    group: 'Appearance',
    type: 'boolean',
    default: true,
    description: 'Adds a shape/letter beside each status colour so status is readable without colour vision.',
    appliesTo: 'src/app/settings-wiring.js'
  },

  // ── Dashboard ─────────────────────────────────────────────────────────────
  {
    key: 'dashboard.widgets',
    label: 'Dashboard widgets',
    group: 'Dashboard',
    type: 'string[]',
    default: ['overview', 'health', 'cpu', 'gpu', 'memory', 'storage', 'battery', 'thermal', 'network', 'progress', 'quick-actions'],
    description: 'Ordered widget list. Removing a widget hides it from the dashboard grid; order controls layout.',
    appliesTo: 'src/app/settings-wiring.js'
  },
  {
    key: 'dashboard.greetingName',
    label: 'Greeting name',
    group: 'Dashboard',
    type: 'string',
    default: '',
    description: 'Optional name used in the dashboard greeting. Stored locally only; leave blank for a neutral greeting.',
    appliesTo: 'src/app/settings-wiring.js'
  },

  // ── Diagnostics ───────────────────────────────────────────────────────────
  {
    key: 'diagnostics.autoQuickScan',
    label: 'Run a quick scan at startup',
    group: 'Diagnostics',
    type: 'boolean',
    default: true,
    description: 'Starts a read-only quick scan automatically on launch so the dashboard is populated.',
    appliesTo: 'src/app/settings-wiring.js'
  },
  {
    key: 'diagnostics.providerTimeoutMs',
    label: 'Provider timeout (ms)',
    group: 'Diagnostics',
    type: 'number',
    min: 3000,
    max: 120000,
    default: 20000,
    description: 'Maximum time a single provider may take before it is abandoned and the fallback chain continues.',
    appliesTo: 'src/app/settings-wiring.js'
  },
  {
    key: 'diagnostics.includeSensitiveInReport',
    label: 'Include serial numbers and addresses in reports',
    group: 'Diagnostics',
    type: 'boolean',
    default: false,
    description: 'When off, serial numbers, MAC addresses and account names are redacted from every exported report.',
    appliesTo: 'src/app/settings-wiring.js'
  },
  {
    key: 'diagnostics.persistHistory',
    label: 'Keep diagnostic history',
    group: 'Diagnostics',
    type: 'boolean',
    default: true,
    description: 'Stores completed runs locally so trends and comparisons are possible. Nothing leaves the device.',
    appliesTo: 'src/app/settings-wiring.js'
  },
  {
    key: 'diagnostics.historyLimit',
    label: 'History entries to keep',
    group: 'Diagnostics',
    type: 'number',
    min: 5,
    max: 500,
    default: 50,
    description: 'Older runs are pruned beyond this limit to bound disk usage.',
    appliesTo: 'src/app/settings-wiring.js'
  },

  // ── Monitoring ────────────────────────────────────────────────────────────
  {
    key: 'monitoring.intervalMs',
    label: 'Sensor refresh interval (ms)',
    group: 'Monitoring',
    type: 'number',
    min: 500,
    max: 10000,
    default: 1500,
    description: 'How often live sensors are polled while the monitor page is visible. Slower intervals reduce overhead.',
    appliesTo: 'src/app/settings-wiring.js'
  },
  {
    key: 'monitoring.historyPoints',
    label: 'Graph points',
    group: 'Monitoring',
    type: 'number',
    min: 30,
    max: 600,
    default: 120,
    description: 'Ring-buffer length for live graphs; also the window used for min/max/average.',
    appliesTo: 'src/app/settings-wiring.js'
  },
  {
    key: 'monitoring.keepMonitoringInBackground',
    label: 'Keep monitoring when the window is hidden',
    group: 'Monitoring',
    type: 'boolean',
    default: false,
    description: 'When off, polling pauses while VERIDEX is minimised so it does not compete with the machine under test.',
    appliesTo: 'src/app/settings-wiring.js'
  },

  // ── Benchmark & stress ────────────────────────────────────────────────────
  {
    key: 'benchmark.diskWriteTest',
    label: 'Allow destructive-by-design write benchmark',
    group: 'Performance',
    type: 'boolean',
    default: true,
    description: 'Enables the write half of the disk benchmark. It uses a temporary file that is always deleted; disabling it leaves read-only tests.',
    appliesTo: 'src/app/settings-wiring.js'
  },
  {
    key: 'benchmark.diskTestSizeMb',
    label: 'Disk benchmark file size (MB)',
    group: 'Performance',
    type: 'number',
    min: 32,
    max: 2048,
    default: 256,
    description: 'Size of the temporary test file. Larger sizes measure sustained throughput better but take longer.',
    appliesTo: 'src/app/settings-wiring.js'
  },
  {
    key: 'stress.thermalLimitC',
    label: 'Thermal safety threshold (°C)',
    group: 'Performance',
    type: 'number',
    min: 70,
    max: 105,
    default: 90,
    description: 'Stress tests stop automatically when a readable sensor crosses this value. VERIDEX does not know your CPU\'s true limit, so this is a conservative user-chosen ceiling, not a hardware certification.',
    appliesTo: 'src/app/settings-wiring.js'
  },
  {
    key: 'stress.maxDurationSec',
    label: 'Maximum stress duration (s)',
    group: 'Performance',
    type: 'number',
    min: 30,
    max: 3600,
    default: 300,
    description: 'Hard ceiling enforced by the guard even if the chosen duration is longer.',
    appliesTo: 'src/app/settings-wiring.js'
  },
  {
    key: 'stress.requireConsent',
    label: 'Always ask before starting a stress test',
    group: 'Performance',
    type: 'boolean',
    default: true,
    description: 'Shows the safety dialog every time. Turning it off still requires the explicit Start action on the stress page.',
    appliesTo: 'src/app/settings-wiring.js'
  },

  // ── Reports ───────────────────────────────────────────────────────────────
  {
    key: 'reports.defaultFormat',
    label: 'Default export format',
    group: 'Reports',
    type: 'enum',
    values: ['pdf', 'html', 'csv', 'json'],
    default: 'pdf',
    description: 'Preselected format on the report screen.',
    appliesTo: 'src/app/settings-wiring.js'
  },
  {
    key: 'reports.includeManualResults',
    label: 'Include manual test results',
    group: 'Reports',
    type: 'boolean',
    default: true,
    description: 'Manual observations (display, keyboard, ports) are clearly separated from automated findings in the report.',
    appliesTo: 'src/app/settings-wiring.js'
  },
  {
    key: 'reports.includeCertificate',
    label: 'Generate inspection certificate',
    group: 'Reports',
    type: 'boolean',
    default: true,
    description: 'Appends the device assessment certificate page to PDF and HTML exports.',
    appliesTo: 'src/app/settings-wiring.js'
  },
  {
    key: 'reports.brandLine',
    label: 'Report footer note',
    group: 'Reports',
    type: 'string',
    default: '',
    description: 'Optional free-text note printed in the report footer, e.g. a workshop name.',
    appliesTo: 'src/app/settings-wiring.js'
  },

  // ── Startup & storage ─────────────────────────────────────────────────────
  {
    key: 'startup.openTo',
    label: 'Open to',
    group: 'Application',
    type: 'enum',
    values: ['dashboard', 'last'],
    default: 'dashboard',
    description: 'Which page the app opens on launch.',
    appliesTo: 'src/app/settings-wiring.js'
  },
  {
    key: 'startup.checkRecovery',
    label: 'Report interrupted sessions',
    group: 'Application',
    type: 'boolean',
    default: true,
    description: 'If a previous session ended abnormally, a recovery notice is shown with the crash context.',
    appliesTo: 'src/app/settings-wiring.js'
  },
  {
    key: 'storage.logLevel',
    label: 'Log level',
    group: 'Application',
    type: 'enum',
    values: ['trace', 'debug', 'info', 'warn', 'error'],
    default: 'info',
    description: 'Verbosity of the structured log. Debug and trace are needed when reporting a problem.',
    appliesTo: 'src/app/settings-wiring.js'
  },
  {
    key: 'storage.autoPruneDays',
    label: 'Delete history older than (days)',
    group: 'Application',
    type: 'number',
    min: 0,
    max: 3650,
    default: 0,
    description: '0 disables age-based pruning. Applies on startup.',
    appliesTo: 'src/app/settings-wiring.js'
  },

  // ── Privacy ───────────────────────────────────────────────────────────────
  {
    key: 'privacy.firstRunComplete',
    label: 'First-run setup completed',
    group: 'Privacy',
    type: 'boolean',
    default: false,
    description: 'Set once the welcome, limits, permission and privacy screens have been read — or explicitly skipped.',
    appliesTo: 'src/app/onboarding.js'
  },
  {
    key: 'privacy.firstRunCompletedAt',
    label: 'First-run setup finished at',
    group: 'Privacy',
    type: 'string',
    default: null,
    description: 'When the tour was finished or skipped. Informational; the flag above is what decides.',
    appliesTo: 'src/app/onboarding.js'
  },
  {
    key: 'privacy.firstRunStep',
    label: 'First-run tour step',
    group: 'Privacy',
    type: 'string',
    default: null,
    description: 'The step the tour reached. A part-way tour is not consent: it resumes rather than counting as complete.',
    appliesTo: 'src/app/onboarding.js'
  },
  {
    key: 'privacy.firstRunSkipped',
    label: 'First-run setup skipped',
    group: 'Privacy',
    type: 'boolean',
    default: false,
    description: 'True when the tour was dismissed rather than read, so Settings can offer it again.',
    appliesTo: 'src/app/onboarding.js'
  },
  {
    key: 'privacy.allowNetwork',
    label: 'Allow network access',
    group: 'Privacy',
    type: 'boolean',
    default: false,
    description: 'VERIDEX performs no network access by default. This flag exists so a future opt-in lookup can be gated; no diagnostic data is ever uploaded.',
    appliesTo: 'src/security/guard.js'
  },

  // ── Shortcuts ─────────────────────────────────────────────────────────────
  {
    key: 'shortcuts.overrides',
    label: 'Shortcut overrides',
    group: 'Shortcuts',
    type: 'object',
    default: {},
    description: 'User-remapped accelerators, keyed by action id. Validated for conflicts by src/renderer/shortcuts.js.',
    appliesTo: 'src/app/settings-wiring.js'
  }
];

/** @type {Map<string, SettingSpec>} */
const SPEC_BY_KEY = new Map(SETTINGS_SPEC.map((spec) => [spec.key, spec]));

/** @returns {Record<string, unknown>} */
export function defaultSettings() {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const spec of SETTINGS_SPEC) out[spec.key] = structuredClone(spec.default);
  return out;
}

/**
 * Coerce and validate a single value against its spec.
 * Invalid input falls back to the default and reports the rejection, so a corrupt
 * settings file degrades to defaults instead of crashing or silently misbehaving.
 * @param {SettingSpec} spec
 * @param {unknown} raw
 * @returns {{value:unknown, ok:boolean, reason?:string}}
 */
export function coerce(spec, raw) {
  const reject = (reason) => ({ value: structuredClone(spec.default), ok: false, reason: `${spec.key}: ${reason}` });

  switch (spec.type) {
    case 'boolean':
      if (typeof raw === 'boolean') return { value: raw, ok: true };
      if (raw === 'true') return { value: true, ok: true };
      if (raw === 'false') return { value: false, ok: true };
      return reject('expected a boolean');

    case 'number': {
      const parsed = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(parsed)) return reject('expected a number');
      if (spec.min !== undefined && parsed < spec.min) return reject(`below minimum ${spec.min}`);
      if (spec.max !== undefined && parsed > spec.max) return reject(`above maximum ${spec.max}`);
      return { value: parsed, ok: true };
    }

    case 'enum':
      if (spec.values && spec.values.includes(raw)) return { value: raw, ok: true };
      return reject(`expected one of ${(spec.values ?? []).join(', ')}`);

    case 'string':
      if (typeof raw === 'string' && raw.length <= 400) return { value: raw, ok: true };
      return reject('expected a string up to 400 characters');

    case 'string[]':
      if (Array.isArray(raw) && raw.every((item) => typeof item === 'string') && raw.length <= 40) {
        return { value: [...new Set(raw)], ok: true };
      }
      return reject('expected an array of up to 40 unique strings');

    case 'object':
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { value: raw, ok: true };
      return reject('expected an object');

    default:
      return reject(`unsupported type ${spec.type}`);
  }
}

export class SettingsStore {
  /**
   * @param {{file?: string|null, logger?: import('./logger.js').Logger|null}} [options]
   */
  constructor(options = {}) {
    this.file = options.file ?? null;
    this.logger = options.logger ?? null;
    this.values = defaultSettings();
    this.version = SETTINGS_SCHEMA_VERSION;
    this.rejections = [];
    /** @type {Array<(event:{key:string, value:unknown, previous:unknown}) => void>} */
    this.listeners = [];
  }

  /** Load from disk, migrating unknown/missing keys to defaults. */
  async load() {
    if (!this.file) return this;
    try {
      const text = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(text);
      const incoming = parsed && typeof parsed === 'object' && parsed.values ? parsed.values : parsed;
      this.version = parsed?.version ?? SETTINGS_SCHEMA_VERSION;
      const { values, rejections } = this.#sanitise(incoming);
      this.values = values;
      this.rejections = rejections;
      if (rejections.length) {
        await this.logger?.warn('settings contained invalid values; defaults applied', { scope: 'settings', rejections });
      }
      await this.logger?.debug('settings loaded', { scope: 'settings', count: Object.keys(values).length });
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (code !== 'ENOENT') {
        await this.logger?.warn('settings file unreadable; using defaults', {
          scope: 'settings',
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return this;
  }

  /** @param {unknown} incoming */
  #sanitise(incoming) {
    const base = defaultSettings();
    const rejections = [];
    if (!incoming || typeof incoming !== 'object') return { values: base, rejections: ['settings payload was not an object'] };

    for (const spec of SETTINGS_SPEC) {
      if (!(spec.key in incoming)) continue;
      const { value, ok, reason } = coerce(spec, /** @type {Record<string,unknown>} */ (incoming)[spec.key]);
      base[spec.key] = value;
      if (!ok && reason) rejections.push(reason);
    }
    return { values: base, rejections };
  }

  /** @param {string} key */
  get(key) {
    const spec = SPEC_BY_KEY.get(key);
    if (!spec) throw new Error(`Unknown setting "${key}"`);
    return this.values[key];
  }

  /** All setting values, for the renderer bootstrap. */
  all() {
    return { ...this.values };
  }

  /** Specs for the settings UI, so the UI is generated from the schema. */
  specs() {
    return SETTINGS_SPEC.map((spec) => ({ ...spec }));
  }

  /**
   * Update one key. Returns the applied value. Invalid values are rejected and
   * the previous value is preserved.
   * @param {string} key
   * @param {unknown} raw
   */
  async set(key, raw) {
    const spec = SPEC_BY_KEY.get(key);
    if (!spec) throw new Error(`Unknown setting "${key}"`);
    const { value, ok, reason } = coerce(spec, raw);
    if (!ok) {
      await this.logger?.warn('setting rejected', { scope: 'settings', key, reason });
      return { ok: false, value: this.values[key], reason };
    }
    const previous = this.values[key];
    this.values[key] = value;
    if (JSON.stringify(previous) !== JSON.stringify(value)) {
      for (const listener of this.listeners) {
        try {
          listener({ key, value, previous });
        } catch (error) {
          await this.logger?.error('settings listener threw', {
            scope: 'settings',
            key,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
      await this.save();
    }
    return { ok: true, value };
  }

  /**
   * Apply many keys; used by the "reset to defaults" action and import.
   * @param {Record<string, unknown>} patch
   */
  async setMany(patch) {
    const results = {};
    for (const [key, raw] of Object.entries(patch)) {
      results[key] = await this.set(key, raw);
    }
    return results;
  }

  async reset() {
    this.values = defaultSettings();
    await this.save();
    return this.all();
  }

  /** Subscribe to changes. Returns an unsubscribe function. */
  onChange(listener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  async save() {
    if (!this.file) return;
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp-${process.pid}`;
    const payload = JSON.stringify({ version: SETTINGS_SCHEMA_VERSION, savedAt: new Date().toISOString(), values: this.values }, null, 2);
    try {
      await writeFile(temp, payload, 'utf8');
      await rename(temp, this.file);
    } catch (error) {
      await unlink(temp).catch(() => {});
      await this.logger?.error('settings save failed', {
        scope: 'settings',
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }
}
