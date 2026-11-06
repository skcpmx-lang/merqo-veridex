/**
 * VERIDEX — crash marker and interrupted-run recovery (R-25-02).
 *
 * The requirement names the mechanism: "crash marker + journal replay". This is the marker half,
 * and the recovery is a *report*, not a resurrection:
 *
 *   - Before a scan, a stress run or a driver export begins, a small marker file is written with
 *     what started and when.
 *   - On a clean finish the marker is deleted. Its absence is the proof that the last run ended.
 *   - On the next start, a marker that is still there means the previous session died mid-run.
 *     The user is told which run it was and that it is recorded as interrupted — not completed,
 *     not failed, not silently missing.
 *
 * What this deliberately does **not** do is continue the work. An interrupted scan is not
 * resumable: its providers have no partial state worth trusting, and a resumed run would produce a
 * report whose provenance nobody could state. The history store already quarantines an unreadable
 * file rather than deleting it, which is the other half of "recover what was written".
 *
 * The marker is a JSON file with a fixed name in the application data directory. It is small,
 * rewritten atomically, and never contains diagnostic values — only kind, ids and timestamps.
 */

import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** The kinds of work whose interruption is worth reporting. */
export const MARKER_KINDS = Object.freeze(['scan', 'stress', 'export', 'report']);

/**
 * @typedef {object} CrashMarker
 * @property {string} kind
 * @property {string} startedAt
 * @property {string|null} [id]
 * @property {string|null} [detail]
 * @property {string} appVersion
 */

/**
 * Write the marker for work that is starting.
 *
 * Written to a sibling and renamed, because a marker torn in half by a power loss would be
 * unreadable at exactly the moment it matters.
 *
 * @param {string} file
 * @param {CrashMarker} marker
 */
export async function writeMarker(file, marker) {
  const payload = {
    kind: String(marker.kind ?? 'unknown'),
    startedAt: marker.startedAt ?? new Date().toISOString(),
    id: marker.id ?? null,
    detail: marker.detail ?? null,
    appVersion: String(marker.appVersion ?? 'unknown')
  };
  const temporary = `${file}.part`;
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
  return payload;
}

/**
 * Read the marker, if one exists.
 *
 * A corrupt marker is returned as `{ corrupt: true, error }` rather than null: "the file is
 * there but unreadable" is itself evidence that the session died badly.
 * @param {string} file
 */
export async function readMarker(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    return { corrupt: true, error: error instanceof Error ? error.message : String(error), file };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.kind !== 'string') {
      return { corrupt: true, error: 'the marker is not an object with a kind', file };
    }
    return { ...parsed, file };
  } catch (error) {
    return { corrupt: true, error: error instanceof Error ? error.message : String(error), file };
  }
}

/** Remove the marker after the work finished. A failure to delete is reported, never swallowed. */
export async function clearMarker(file) {
  try {
    await unlink(file);
    return { cleared: true, reason: null };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { cleared: true, reason: 'there was nothing to clear' };
    return { cleared: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Turn a marker into the sentence a user reads on the dashboard.
 * @param {Awaited<ReturnType<typeof readMarker>>} marker
 */
export function describeInterrupted(marker) {
  if (!marker) return null;
  if (marker.corrupt) {
    return {
      kind: 'unknown',
      title: 'The previous session ended unexpectedly',
      body: `A recovery marker was found but could not be read (${marker.error}). The run it recorded is not reported as completed. ${path.basename(marker.file ?? 'marker')} was left in place rather than deleted, so the file itself is the evidence.`,
      startedAt: null
    };
  }
  const started = marker.startedAt ? ` It started at ${marker.startedAt}.` : '';
  const map = {
    scan: 'a diagnostic scan',
    stress: 'a stress run',
    export: 'a driver export',
    report: 'a report build'
  };
  const what = map[marker.kind] ?? `a ${marker.kind} operation`;
  return {
    kind: marker.kind,
    title: 'The previous session ended during a run',
    body: `VERIDEX was ${marker.kind === 'scan' ? 'running' : 'in the middle of'} ${what} when the session ended without finishing it.${started} That run is recorded as interrupted — it is not reported as complete, and no partial result from it is presented as a result. Anything it had already written is kept.`,
    startedAt: marker.startedAt ?? null
  };
}

/** The marker path inside a data directory. */
export function markerPath(dataDir) {
  return path.join(dataDir, 'recovery.json');
}

/**
 * True when the marker is old enough that it cannot belong to a live process.
 * A second window starting while a scan runs would otherwise report a crash that never happened.
 * @param {{startedAt?: string|null}} marker
 * @param {number} nowMs
 * @param {number} staleAfterMs
 */
export function markerIsStale(marker, nowMs = Date.now(), staleAfterMs = 6 * 60 * 60 * 1000) {
  if (!marker?.startedAt) return false;
  const started = Date.parse(marker.startedAt);
  if (!Number.isFinite(started)) return false;
  return nowMs - started > staleAfterMs;
}
