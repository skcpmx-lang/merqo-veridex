/**
 * VERIDEX — Diagnostic history.
 *
 * Stores completed runs so trends, comparisons and the certificate can reference
 * past evidence. Deliberately a JSON document store rather than SQLite: the data
 * volume is tiny (tens of runs), it needs no native module (which would complicate
 * packaging and the unsigned-build requirement), and it keeps the whole record
 * inspectable by the user.
 *
 * Writes are atomic. A corrupt history file is quarantined and recreated rather
 * than taking the app down — history is useful, not critical.
 */

import { readFile, writeFile, rename, mkdir, unlink, copyFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const HISTORY_SCHEMA_VERSION = 1;

/**
 * @typedef {object} HistoryEntry
 * @property {string} id
 * @property {string} kind        quick-scan | full-scan | benchmark | stress | manual | battery | storage | inspection
 * @property {string} startedAt
 * @property {string} finishedAt
 * @property {number} durationMs
 * @property {string} appVersion
 * @property {object} summary     Scores, coverage, headline findings.
 * @property {object} snapshot    Field-level snapshot used for comparisons.
 * @property {string[]} warnings
 * @property {string[]} errors
 */

/** @param {Date} [now] */
export function makeId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `VX-${stamp}-${rand}`;
}

export class HistoryStore {
  /**
   * @param {{file?: string|null, limit?: number, pruneDays?: number, logger?: import('../core/logger.js').Logger|null}} [options]
   */
  constructor(options = {}) {
    this.file = options.file ?? null;
    this.limit = options.limit ?? 50;
    this.pruneDays = options.pruneDays ?? 0;
    this.logger = options.logger ?? null;
    /** @type {HistoryEntry[]} */
    this.entries = [];
    this.corruptBackup = null;
  }

  async load() {
    if (!this.file) return this;
    try {
      const text = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(text);
      const entries = Array.isArray(parsed) ? parsed : parsed?.entries;
      if (!Array.isArray(entries)) throw new Error('history payload is not an array');
      const kept = entries.filter((entry) => entry && typeof entry.id === 'string');
      const dropped = entries.length - kept.length;
      this.entries = kept;
      if (dropped > 0) {
        // Entries without an id cannot be addressed, compared or deleted, so they are
        // not loaded — but the loss must be reported rather than disappearing.
        await this.logger?.warn('history entries without an id were skipped', {
          scope: 'history',
          dropped,
          kept: kept.length,
          note: 'An entry without an id cannot be shown, compared or removed.'
        });
      }
      await this.logger?.debug('history loaded', { scope: 'history', count: this.entries.length });
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (code !== 'ENOENT') {
        // Quarantine instead of deleting: the user may still want the file.
        try {
          this.corruptBackup = `${this.file}.corrupt-${Date.now()}`;
          await copyFile(this.file, this.corruptBackup);
        } catch {
          this.corruptBackup = null;
        }
        this.entries = [];
        await this.logger?.warn('history unreadable; quarantined and reset', {
          scope: 'history',
          error: error instanceof Error ? error.message : String(error),
          backup: this.corruptBackup
        });
      }
    }
    return this;
  }

  /**
   * Append an entry, applying retention rules.
   * @param {Omit<HistoryEntry,'id'> & {id?:string}} entry
   * @returns {Promise<HistoryEntry>}
   */
  async add(entry) {
    // The generated id is spread LAST on purpose. Written the other way round —
    // `{ id: entry.id ?? makeId(), ...entry }` — a caller passing `id: undefined`
    // (which scan.js did) overwrites the generated id with undefined, the entry is
    // saved without an id, and load() then discards it because it only keeps entries
    // with a string id. The result was history that silently never accumulated.
    /** @type {HistoryEntry} */
    const record = { ...entry, id: entry.id ?? makeId() };
    this.entries.unshift(record);
    this.#prune();
    await this.save();
    return record;
  }

  #prune() {
    if (this.pruneDays > 0) {
      const cutoff = Date.now() - this.pruneDays * 86_400_000;
      this.entries = this.entries.filter((entry) => {
        const stamp = Date.parse(entry.finishedAt ?? entry.startedAt ?? '');
        return Number.isNaN(stamp) ? true : stamp >= cutoff;
      });
    }
    if (this.entries.length > this.limit) this.entries = this.entries.slice(0, this.limit);
  }

  /** Newest first. */
  list(limit = 50) {
    return this.entries.slice(0, limit);
  }

  /** @param {string} id */
  get(id) {
    return this.entries.find((entry) => entry.id === id) ?? null;
  }

  /** The most recent entry, or the most recent of a given kind. */
  latest(kind = null) {
    if (!kind) return this.entries[0] ?? null;
    return this.entries.find((entry) => entry.kind === kind) ?? null;
  }

  /** The entry immediately before `id`, useful for "compare with previous". */
  previous(id) {
    const index = this.entries.findIndex((entry) => entry.id === id);
    if (index === -1) return null;
    return this.entries[index + 1] ?? null;
  }

  /** @param {string} id */
  async remove(id) {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.id !== id);
    if (this.entries.length !== before) await this.save();
    return before !== this.entries.length;
  }

  async clear() {
    this.entries = [];
    await this.save();
  }

  async save() {
    if (!this.file) return;
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp-${process.pid}`;
    try {
      await writeFile(temp, JSON.stringify({ version: HISTORY_SCHEMA_VERSION, savedAt: new Date().toISOString(), entries: this.entries }, null, 2), 'utf8');
      await rename(temp, this.file);
    } catch (error) {
      await unlink(temp).catch(() => {});
      await this.logger?.error('history save failed', {
        scope: 'history',
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /** Approximate on-disk size, shown in the privacy/data screen. */
  async sizeBytes() {
    if (!this.file) return 0;
    try {
      return (await stat(this.file)).size;
    } catch {
      return 0;
    }
  }
}
