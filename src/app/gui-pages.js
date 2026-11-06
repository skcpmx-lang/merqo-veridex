/**
 * What the GUI harness expects to see on each page.
 *
 * Kept in its own module, with no Electron import, so that the same table can be checked
 * against the real renderer under jsdom on any platform. The harness that uses it only runs
 * on a Windows runner; a table nobody can validate from Linux is a table that rots.
 *
 * Each entry is the marker that page must render. It is deliberately loose - a page such as
 * Storage legitimately says "no storage was found" on a machine with none - and it is never
 * a substitute for reading the screenshot.
 *
 * @module
 */

/** @type {Readonly<Record<string, RegExp>>} */
export const PAGE_EXPECTATIONS = Object.freeze({
  dashboard: /Device health/i,
  hardware: /hardware|processor|cpu/i,
  battery: /battery|design capacity|no battery/i,
  storage: /storage|disk|nvme|no storage/i,
  network: /network|adapter|interface/i,
  windows: /windows|security|secure boot|bitlocker/i,
  reliability: /reliab|event/i,
  drivers: /driver|device/i,
  processes: /process|manual|inspection/i,
  manual: /manual|checklist|inspection/i,
  performance: /benchmark|performance|cpu/i,
  monitor: /monitor|sample|sensor|live/i,
  reports: /report|export|scan to export/i,
  history: /history|run|no runs/i,
  settings: /setting|theme|density/i,
  privacy: /privacy|guarantee|stored on this machine/i,
  logs: /activity log|the log is empty|reading the log/i,
  about: /veridex/i
});

/** Page ids in the order the navigation declares them. */
export const PAGE_ORDER = Object.freeze(Object.keys(PAGE_EXPECTATIONS));
