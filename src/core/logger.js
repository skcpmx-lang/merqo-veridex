/**
 * VERIDEX — Structured logging.
 *
 * Two requirements shape this module:
 *  - every provider failure, permission denial and detection error must be
 *    recoverable after the fact (PART 3 / MODULE 24);
 *  - sensitive identifiers must not leak into logs (PART 8).
 *
 * Logs are JSONL, levelled, rotated by size, and passed through a redactor that
 * knows which keys are sensitive. The logger never throws: a logging failure must
 * not take down a diagnostic run.
 */

import { appendFile, mkdir, rename, stat, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

export const Level = Object.freeze({ TRACE: 'trace', DEBUG: 'debug', INFO: 'info', WARN: 'warn', ERROR: 'error', FATAL: 'fatal' });

const LEVEL_WEIGHT = Object.freeze({ trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 });

/** Keys whose values are redacted wherever they appear in a log record. */
export const SENSITIVE_KEYS = Object.freeze([
  'serial',
  'serialnumber',
  'serial_number',
  'serialnumberid',
  'mac',
  'macaddress',
  'ip',
  'ipv4',
  'ipv6',
  'ipaddress',
  'hostname',
  'host',
  'username',
  'user',
  'account',
  'accountname',
  'ssid',
  'wifi',
  'computername',
  'deviceid',
  'machineguid',
  'windowsproductid',
  'productid',
  'productkey',
  'licensekey',
  'token',
  'password',
  'secret',
  'bitlockerkey',
  'recoverykey',
  // Command lines are never logged, and these keys are what a caller would use if it tried.
  // Refusing the key is weaker than refusing to pass one, but it is the last line: the
  // runner's logging path already records only the exit code.
  'commandline',
  'cmdline',
  'command',
  'args',
  'argv',
  'arguments'
]);

/**
 * @param {string} key
 * @returns {boolean}
 */
export function isSensitiveKey(key) {
  const normalised = String(key).toLowerCase().replace(/[^a-z0-9_]/g, '');
  return SENSITIVE_KEYS.some((sensitive) => normalised === sensitive.replace(/_/g, '') || normalised.endsWith(sensitive.replace(/_/g, '')));
}

/**
 * Mask identifiers that appear *inside* a string.
 *
 * Key-based redaction cannot help when a caller writes a value into the message itself -
 * `logger.info(`bios serial ${serial}`)` - and that happens. These are the shapes that can be
 * recognised without guessing: MAC addresses, IPv4 addresses, and the account name inside a
 * Windows user path. Values that carry no recognisable shape (a serial number, a token) cannot
 * be found this way, which is why the rule for callers is still "do not put values in messages".
 *
 * @param {string} text
 * @returns {string}
 */
export function maskIdentifiers(text) {
  return String(text)
    .replace(/\b([0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi, '••:••:••:••:••:••')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[ip]')
    .replace(/(\\{1,2}Users\\)([^\\/:*?"<>|]+)/gi, '$1[user]')
    .replace(/\bSERIAL[-_ ]?[A-Z0-9]{6,}\b/gi, '[serial]');
}

/**
 * Deep-redact a value for logging. Arrays and objects are walked; strings that
 * look like MAC addresses are masked regardless of key, because they turn up in
 * provider payloads under unexpected names.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function redact(value, depth = 0) {
  if (depth > 6) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    const masked = maskIdentifiers(value);
    return masked.length > 500 ? `${masked.slice(0, 500)}…[truncated]` : masked;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redact(item, depth + 1));

  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? '[redacted]' : redact(item, depth + 1);
  }
  return out;
}

export class Logger {
  /**
   * @param {{dir?: string|null, level?: string, maxBytes?: number, maxFiles?: number, console?: boolean, now?: () => Date}} [options]
   */
  constructor(options = {}) {
    this.dir = options.dir ?? null;
    this.level = options.level ?? Level.INFO;
    this.maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    this.maxFiles = options.maxFiles ?? 5;
    this.consoleEnabled = options.console ?? false;
    this.now = options.now ?? (() => new Date());
    this.sessionId = `S${this.now().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
    this.buffer = [];
    this.ready = this.#ensureDir();
    this.entries = 0;
    this.lastError = null;
  }

  async #ensureDir() {
    if (!this.dir) return;
    try {
      await mkdir(this.dir, { recursive: true });
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.dir = null;
    }
  }

  /** @param {string} level */
  setLevel(level) {
    if (!(level in LEVEL_WEIGHT)) throw new Error(`Unknown log level: ${level}`);
    this.level = level;
  }

  /**
   * @param {string} level
   * @param {string} message
   * @param {Record<string, unknown>} [context]
   */
  async log(level, message, context = {}) {
    if (!(level in LEVEL_WEIGHT)) level = Level.INFO;
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.level]) return null;

    const record = {
      ts: this.now().toISOString(),
      level,
      session: this.sessionId,
      scope: context.scope ?? 'app',
      msg: message,
      ...(Object.keys(context).length > 0 ? { ctx: redact(context) } : {})
    };
    const line = JSON.stringify(record);
    this.buffer.push(record);
    if (this.buffer.length > 500) this.buffer.shift();
    this.entries += 1;

    if (this.consoleEnabled) {
      const writer = level === Level.ERROR || level === Level.FATAL ? console.error : console.log;
      writer(`[${level}] ${record.scope}: ${message}`, Object.keys(context).length ? record.ctx : '');
    }

    await this.ready;
    if (!this.dir) return record;
    try {
      await this.#rotateIfNeeded();
      await appendFile(path.join(this.dir, 'veridex.log'), `${line}\n`, 'utf8');
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    return record;
  }

  async #rotateIfNeeded() {
    const file = path.join(this.dir, 'veridex.log');
    if (!existsSync(file)) return;
    const info = await stat(file);
    if (info.size < this.maxBytes) return;
    // Shift veridex.log.1 .. N, dropping the oldest.
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      const from = index === 1 ? file : path.join(this.dir, `veridex.log.${index - 1}`);
      const to = path.join(this.dir, `veridex.log.${index}`);
      if (existsSync(from)) {
        await rename(from, to).catch(() => {});
      }
    }
    const stale = path.join(this.dir, `veridex.log.${this.maxFiles}`);
    if (existsSync(stale)) await unlink(stale).catch(() => {});
  }

  trace(msg, ctx) { return this.log(Level.TRACE, msg, ctx); }
  debug(msg, ctx) { return this.log(Level.DEBUG, msg, ctx); }
  info(msg, ctx) { return this.log(Level.INFO, msg, ctx); }
  warn(msg, ctx) { return this.log(Level.WARN, msg, ctx); }
  error(msg, ctx) { return this.log(Level.ERROR, msg, ctx); }
  fatal(msg, ctx) { return this.log(Level.FATAL, msg, ctx); }

  /**
   * Record a provider attempt. Used by the fallback engine so every provider
   * success and failure is individually attributable.
   * @param {{provider:string, task:string, ok:boolean, durationMs?:number, error?:string|null, status?:string}} attempt
   */
  providerAttempt(attempt) {
    return this.log(attempt.ok ? Level.DEBUG : Level.WARN, `provider ${attempt.ok ? 'ok' : 'failed'}: ${attempt.provider}`, {
      scope: 'provider',
      ...attempt
    });
  }

  /** Recent in-memory records, for the in-app log viewer. */
  recent(limit = 200) {
    return this.buffer.slice(-limit);
  }

  /** Files currently on disk, newest first, for support bundles. */
  async files() {
    await this.ready;
    if (!this.dir) return [];
    try {
      const names = await readdir(this.dir);
      return names.filter((name) => name.startsWith('veridex.log')).sort().reverse().map((name) => path.join(this.dir, name));
    } catch {
      return [];
    }
  }
}

/** A logger that discards everything; used in tests and pure functions. */
export class NullLogger extends Logger {
  constructor() {
    super({ dir: null, console: false });
  }
  async log() {
    return null;
  }
}
