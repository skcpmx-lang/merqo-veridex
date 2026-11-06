/**
 * VERIDEX — Time-series primitives for live monitoring (MODULE 09).
 *
 * A ring buffer with statistics. Two design choices:
 *  - It stores samples *with* their source, so a graph can annotate where each
 *    stretch of data came from if a provider drops out mid-session.
 *  - Gaps are represented by `null` samples rather than being interpolated. A line
 *    that bridges a missing reading would draw a value that never existed, which is
 *    the graphical equivalent of fabricating data.
 */

export class Series {
  /**
   * @param {{id:string, label:string, unit:string|null, capacity?:number}} options
   */
  constructor(options) {
    this.id = options.id;
    this.label = options.label;
    this.unit = options.unit ?? null;
    this.capacity = Math.max(2, options.capacity ?? 120);
    /** @type {Array<{t:string, v:number|null, source:string|null}>} */
    this.samples = [];
  }

  /**
   * Append a sample. A null value is recorded as a gap, not skipped, so the graph's
   * x-axis stays honest about time.
   * @param {number|null} value
   * @param {{at?:string, source?:string|null}} [meta]
   */
  push(value, meta = {}) {
    const numeric = typeof value === 'number' && Number.isFinite(value) ? value : null;
    this.samples.push({ t: meta.at ?? new Date().toISOString(), v: numeric, source: meta.source ?? null });
    if (this.samples.length > this.capacity) this.samples.splice(0, this.samples.length - this.capacity);
    return this;
  }

  /** Numeric samples only, in order. */
  values() {
    return this.samples.filter((sample) => sample.v !== null).map((sample) => sample.v);
  }

  /**
   * Statistics over the numeric samples in the buffer.
   * `samples` counts every slot including gaps, so a consumer can see data loss.
   */
  stats() {
    const values = this.values();
    if (values.length === 0) {
      return { current: null, min: null, max: null, average: null, samples: this.samples.length, gaps: this.samples.length };
    }
    const sum = values.reduce((total, value) => total + value, 0);
    return {
      current: values[values.length - 1],
      min: Math.min(...values),
      max: Math.max(...values),
      average: Math.round((sum / values.length) * 100) / 100,
      samples: this.samples.length,
      gaps: this.samples.length - values.length
    };
  }

  /** Data for a sparkline/detail graph, gaps preserved. */
  chart() {
    return this.samples.map((sample) => ({ t: sample.t, v: sample.v }));
  }

  /** Percentage of slots that carried a real reading. */
  availability() {
    if (this.samples.length === 0) return 0;
    return Math.round((this.values().length / this.samples.length) * 1000) / 10;
  }

  clear() {
    this.samples = [];
    return this;
  }
}

/**
 * A collection of series keyed by sensor id.
 */
export class SeriesSet {
  /**
   * @param {{capacity?:number}} [options]
   */
  constructor(options = {}) {
    this.capacity = options.capacity ?? 120;
    /** @type {Map<string, Series>} */
    this.map = new Map();
  }

  /**
   * Get or create a series.
   * @param {{id:string, label:string, unit?:string|null}} definition
   */
  ensure(definition) {
    let series = this.map.get(definition.id);
    if (!series) {
      series = new Series({ ...definition, capacity: this.capacity });
      this.map.set(definition.id, series);
    }
    return series;
  }

  /** @param {string} id */
  get(id) {
    return this.map.get(id) ?? null;
  }

  list() {
    return [...this.map.values()];
  }

  /** Snapshot of every series' statistics, for the dashboard and the report. */
  snapshot() {
    return this.list().map((series) => ({ id: series.id, label: series.label, unit: series.unit, ...series.stats(), availabilityPercent: series.availability() }));
  }

  clear() {
    for (const series of this.map.values()) series.clear();
    return this;
  }
}

/**
 * Format a duration in seconds as a compact human string.
 * @param {number} seconds
 */
export function formatDuration(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(value / 86400);
  const hours = Math.floor((value % 86400) / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}
