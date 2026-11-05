/**
 * VERIDEX — Conflict resolution and merge.
 *
 * When two providers disagree about the same physical fact, VERIDEX must not pick
 * one arbitrarily. The brief (MODULE 13) requires source priority, timestamp,
 * provider reliability and data consistency to decide — and requires the decision
 * to be visible afterwards.
 *
 * Order of decision:
 *   1. A validated value beats an unvalidated one.
 *   2. A firmware/authoritative tier beats a derived tier, which beats a heuristic.
 *   3. Between equal tiers, the fresher collection wins.
 *   4. Values that agree are marked corroborated and gain confidence.
 *   5. Anything still ambiguous keeps BOTH values in the field's notes and is
 *      reported as a conflict, so the user sees the disagreement instead of a
 *      tidy lie.
 */

import { Confidence, confidenceAtLeast } from '../core/field.js';
import { tierOf, SourceTier } from './confidence.js';

const TIER_RANK = Object.freeze({
  [SourceTier.FIRMWARE]: 4,
  [SourceTier.AUTHORITATIVE]: 3,
  [SourceTier.DERIVED]: 2,
  [SourceTier.HEURISTIC]: 1
});

/**
 * @typedef {object} Candidate
 * @property {string} providerId
 * @property {import('../core/field.js').FieldValue} field
 * @property {boolean} [validated]
 */

/**
 * @param {Candidate} candidate
 */
function rankOf(candidate) {
  const tier = tierOf(candidate.providerId);
  const validated = candidate.validated !== false ? 1 : 0;
  const stamp = Date.parse(candidate.field.collectedAt ?? '') || 0;
  return { validated, tier: TIER_RANK[tier] ?? 0, stamp, confidence: candidate.field.confidence };
}

/**
 * Compare two candidates; positive means `a` is preferred.
 * @param {Candidate} a
 * @param {Candidate} b
 */
export function preferred(a, b) {
  const ra = rankOf(a);
  const rb = rankOf(b);
  if (ra.validated !== rb.validated) return ra.validated - rb.validated;
  if (ra.tier !== rb.tier) return ra.tier - rb.tier;
  if (confidenceAtLeast(ra.confidence, rb.confidence) && !confidenceAtLeast(rb.confidence, ra.confidence)) return 1;
  if (!confidenceAtLeast(ra.confidence, rb.confidence) && confidenceAtLeast(rb.confidence, ra.confidence)) return -1;
  if (ra.stamp !== rb.stamp) return ra.stamp - rb.stamp;
  return 0;
}

/**
 * Loose equality for two provider readings of the same fact.
 * Numbers compare with a tolerance so "8192 MB" and "8.0 GB" (same normalised
 * value) do not register as a conflict, while a genuine mismatch does.
 * @param {unknown} a
 * @param {unknown} b
 */
export function agree(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  const na = typeof a === 'number' ? a : Number(a);
  const nb = typeof b === 'number' ? b : Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) {
    const scale = Math.max(Math.abs(na), Math.abs(nb), 1);
    return Math.abs(na - nb) / scale <= 0.02; // 2% tolerance absorbs unit rounding
  }
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/**
 * Resolve one field across candidates.
 *
 * @param {string} key
 * @param {Candidate[]} candidates
 * @returns {{field: import('../core/field.js').FieldValue, conflict: boolean, considered: Array<{providerId:string, value:unknown, status:string, tier:string}>}}
 */
export function resolveField(key, candidates) {
  const usable = candidates.filter((candidate) => candidate.field && candidate.field.value !== null && candidate.field.value !== undefined);
  if (usable.length === 0) {
    // No provider produced a value: keep the most informative explanation. Prefer
    // PERMISSION_REQUIRED over ERROR over UNAVAILABLE, because it tells the user
    // what to do next.
    const priority = ['PERMISSION_REQUIRED', 'ERROR', 'UNKNOWN', 'UNSUPPORTED', 'NOT_APPLICABLE', 'UNTESTED', 'UNAVAILABLE'];
    const fallback = [...candidates].sort((a, b) => priority.indexOf(a.field.status) - priority.indexOf(b.field.status))[0];
    return {
      field: fallback?.field ?? null,
      conflict: false,
      considered: candidates.map((candidate) => ({
        providerId: candidate.providerId,
        value: candidate.field.value,
        status: candidate.field.status,
        tier: tierOf(candidate.providerId)
      }))
    };
  }

  const sorted = [...usable].sort((a, b) => -preferred(a, b));
  const winner = sorted[0];
  const corroborating = sorted.slice(1).filter((candidate) => agree(candidate.field.value, winner.field.value));
  const conflicting = sorted.slice(1).filter((candidate) => !agree(candidate.field.value, winner.field.value));

  const considered = candidates.map((candidate) => ({
    providerId: candidate.providerId,
    value: candidate.field.value,
    status: candidate.field.status,
    tier: tierOf(candidate.providerId)
  }));

  const notes = [...(winner.field.notes ?? [])];
  let confidence = winner.field.confidence;

  if (corroborating.length > 0) {
    confidence = Confidence.HIGH;
    const names = corroborating.map((candidate) => candidate.providerId).join(', ');
    notes.push(`Corroborated by an independent source (${names}).`);
  }

  if (conflicting.length > 0) {
    // A genuine disagreement. Report it and keep the losing values visible.
    for (const candidate of conflicting) {
      notes.push(
        `Conflicting reading: ${candidate.providerId} reported ${JSON.stringify(candidate.field.value)}${candidate.field.unit ? ` ${candidate.field.unit}` : ''} (not used; lower source priority).`
      );
    }
    confidence = Confidence.LOW;
  }

  const resolved = Object.freeze({
    ...winner.field,
    confidence,
    notes: Object.freeze(notes)
  });

  return { field: resolved, conflict: conflicting.length > 0, considered };
}

/**
 * Merge several partial snapshots of the same module into one section.
 * Later snapshots fill gaps but never overwrite a higher-priority value, which is
 * what lets a fallback provider "top up" a section instead of replacing it.
 *
 * @param {Record<string, import('../core/field.js').FieldValue>} base
 * @param {Record<string, import('../core/field.js').FieldValue>} addition
 * @returns {Record<string, import('../core/field.js').FieldValue>}
 */
export function mergeFields(base, addition) {
  const merged = { ...base };
  for (const [key, candidate] of Object.entries(addition)) {
    const existing = merged[key];
    if (!existing) {
      merged[key] = candidate;
      continue;
    }
    const existingHasValue = existing.value !== null && existing.value !== undefined;
    const candidateHasValue = candidate.value !== null && candidate.value !== undefined;

    if (!existingHasValue && candidateHasValue) {
      merged[key] = candidate;
      continue;
    }
    if (existingHasValue && candidateHasValue) {
      const { field: resolved } = resolveField(key, [
        { providerId: existing.source ?? 'unknown', field: existing },
        { providerId: candidate.source ?? 'unknown', field: candidate }
      ]);
      if (resolved) merged[key] = resolved;
      continue;
    }
    // Neither has a value: keep whichever status is more actionable.
    const priority = ['PERMISSION_REQUIRED', 'ERROR', 'UNKNOWN', 'PARTIALLY_AVAILABLE', 'UNSUPPORTED', 'NOT_APPLICABLE', 'UNTESTED', 'UNAVAILABLE'];
    if (priority.indexOf(candidate.status) < priority.indexOf(existing.status)) merged[key] = candidate;
  }
  return merged;
}

/**
 * Merge full sections without mutating inputs.
 * @param {import('../core/field.js').Section|null} base
 * @param {{id:string,title:string,fields:Record<string,import('../core/field.js').FieldValue>}} addition
 */
export function mergeSections(base, addition) {
  if (!base) {
    return { id: addition.id, title: addition.title, fields: { ...addition.fields } };
  }
  return {
    id: base.id,
    title: base.title || addition.title,
    fields: mergeFields(base.fields, addition.fields)
  };
}

/**
 * Summarise all conflicts found across a run, for the report's warnings block.
 * @param {Array<{key:string, conflict:boolean, considered:Array<{providerId:string,value:unknown}>}>} resolutions
 */
export function conflictReport(resolutions) {
  return resolutions
    .filter((resolution) => resolution.conflict)
    .map((resolution) => ({
      field: resolution.key,
      readings: resolution.considered.filter((candidate) => candidate.value !== null && candidate.value !== undefined)
    }));
}
